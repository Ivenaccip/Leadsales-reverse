import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { parse as parseCsvStream } from 'csv-parse';
import { stringify } from 'csv-stringify/sync';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { AppError, badRequest, conflict } from '../lib/errors.js';
import { renderPlaceholders, renderTemplateParams } from '../services/broadcasts.js';
import {
  CONTACT_COLUMNS,
  createContact,
  CUSTOM_FIELD_KEY_MAX,
  customFieldsError,
  customFieldsSchema,
  getContact,
  updateContact,
} from '../services/contacts.js';
import { waTypeForMime } from '../services/media.js';
import { addNote, isWindowOpen, MAX_MEDIA_FILENAME, MAX_MEDIA_LINK, sendingChannelId, sendMessage, type SendContent } from '../services/messages.js';
import { cancelScheduled, scheduleMessage } from '../services/scheduled.js';
import { checkTemplateParams, findTemplate } from '../services/templates.js';
import type { MessageRow } from '../types.js';
import { getChannel, providerFor } from '../whatsapp/provider.js';
import type { TemplateParams } from '../whatsapp/types.js';
import { createTagsByName, MAX_TAGS_PER_CONTACT, MAX_TAGS_PER_WORKSPACE, TAG_NAME_MAX, TAG_SEPARATORS, tagLimitReached } from './crm.js';
import { ADMIN_ROLES, agentRestricted, noContent, parse, requireWs, uuid, type WsAuth } from './helpers.js';

const boolish = z
  .enum(['1', '0', 'true', 'false'])
  .transform((v) => v === '1' || v === 'true')
  .optional();

const listSchema = z.object({
  search: z.string().trim().max(100).optional(),
  funnel_id: uuid.optional(),
  stage_id: uuid.optional(),
  tag_id: uuid.optional(),
  inbox: z.enum(['all', 'mine', 'unassigned']).optional(),
  assigned_user_id: uuid.optional(),
  unread: boolish,
  archived: boolish,
  has_messages: boolish,
  opted_out: boolish,
  sort: z.enum(['recent', 'created', 'name', 'value']).default('recent'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  // sort=recent only: the next_cursor of the previous page (see GET /api/contacts).
  cursor: z.string().max(200).optional(),
});
type ListFilters = z.infer<typeof listSchema>;

const visibilityFilter = agentRestricted;

function buildWhere(a: WsAuth, f: Partial<ListFilters>, restrictToMine: boolean) {
  const params: unknown[] = [a.workspaceId];
  const conds = ['c.workspace_id = $1'];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (f.search) {
    const digits = f.search.replace(/\D/g, '');
    const like = p(`%${f.search}%`);
    conds.push(
      `(c.name ILIKE ${like} OR c.email ILIKE ${like} OR c.company ILIKE ${like}${digits.length >= 3 ? ` OR c.phone LIKE ${p(`%${digits}%`)}` : ''})`,
    );
  }
  if (f.funnel_id) conds.push(`c.funnel_id = ${p(f.funnel_id)}`);
  if (f.stage_id) conds.push(`c.stage_id = ${p(f.stage_id)}`);
  if (f.tag_id) conds.push(`EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_id = c.id AND ct.tag_id = ${p(f.tag_id)})`);
  if (f.inbox === 'mine') conds.push(`c.assigned_user_id = ${p(a.user.id)}`);
  if (f.inbox === 'unassigned') conds.push('c.assigned_user_id IS NULL');
  if (f.assigned_user_id) conds.push(`c.assigned_user_id = ${p(f.assigned_user_id)}`);
  if (f.unread) conds.push('c.unread_count > 0');
  conds.push(f.archived ? 'c.is_archived' : 'NOT c.is_archived');
  if (f.has_messages) conds.push('c.last_message_at IS NOT NULL');
  if (f.opted_out !== undefined) conds.push(f.opted_out ? 'c.opted_out' : 'NOT c.opted_out');
  if (restrictToMine) conds.push(`(c.assigned_user_id = ${p(a.user.id)} OR c.assigned_user_id IS NULL)`);
  return { where: conds.join(' AND '), params };
}

const ORDER: Record<string, string> = {
  // id breaks ties so a page boundary (keyset cursor) is exact.
  recent: 'c.last_message_at DESC NULLS LAST, c.created_at DESC, c.id DESC',
  created: 'c.created_at DESC',
  name: 'c.name ASC NULLS LAST',
  value: 'c.deal_value DESC',
};

/**
 * Keyset of the recency order: the last row's (last_message_at, created_at, id), timestamps at full
 * microsecond precision (rows of one webhook are microseconds apart). Opaque to clients.
 */
const recentKey = z.tuple([z.string().datetime().nullable(), z.string().datetime(), z.string().uuid()]);
const KEY_COLUMNS = `to_char(c.last_message_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS _k_lm,
  to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS _k_ca`;

function encodeCursor(row: { _k_lm: string | null; _k_ca: string; id: string }): string {
  return Buffer.from(JSON.stringify([row._k_lm, row._k_ca, row.id])).toString('base64url');
}

function decodeCursor(cursor: string): z.infer<typeof recentKey> {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    raw = null;
  }
  const r = recentKey.safeParse(raw);
  if (!r.success) throw badRequest('Cursor inválido: vuelve a cargar la lista', 'INVALID_CURSOR');
  return r.data;
}

/** Rows after the cursor in the recency order (last_message_at DESC NULLS LAST, created_at DESC, id DESC). */
function afterCursor(key: z.infer<typeof recentKey>, p: (v: unknown) => string): string {
  const [lm, ca, id] = key;
  const tie = `(c.created_at, c.id) < (${p(ca)}::timestamptz, ${p(id)}::uuid)`;
  if (lm === null) return `(c.last_message_at IS NULL AND ${tie})`;
  const at = p(lm);
  return `(c.last_message_at < ${at}::timestamptz OR c.last_message_at IS NULL OR (c.last_message_at = ${at}::timestamptz AND ${tie}))`;
}

const templateParamsSchema = z.object({
  header: z
    .union([
      z.object({ type: z.literal('text'), text: z.string().min(1).max(60) }),
      z.object({
        type: z.enum(['image', 'video', 'document']),
        link: z
          .string()
          .trim()
          .max(MAX_MEDIA_LINK)
          .url()
          .refine((u) => /^https?:\/\//i.test(u), 'El enlace debe empezar con https://'),
        filename: z.string().trim().max(MAX_MEDIA_FILENAME).optional(),
      }),
      z.object({
        type: z.literal('location'),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        name: z.string().trim().max(1000).optional(),
        address: z.string().trim().max(1000).optional(),
      }),
    ])
    .optional(),
  body: z.array(z.string().max(1024)).max(30).optional(),
  // Every value is rendered for the contact: the number of keys is bounded like body's.
  bodyNamed: z
    .record(z.string().max(100), z.string().max(1024))
    .refine((o) => Object.keys(o).length <= 30, 'Máximo 30 variables')
    .optional(),
  buttons: z
    .array(z.object({ index: z.number().int().min(0).max(9), text: z.string().min(1).max(200), sub_type: z.enum(['url', 'copy_code']).optional() }))
    .max(10)
    .optional(),
});

/** WhatsApp's limit for image, video and document captions. */
const MAX_CAPTION = 1024;

const sendSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1).max(4096), reply_to_wamid: z.string().optional() }),
  z.object({ type: z.literal('media'), media_file_id: uuid, caption: z.string().max(MAX_CAPTION).optional() }),
  z.object({ type: z.literal('template'), name: z.string().min(1).max(512), language: z.string().min(2).max(20), params: templateParamsSchema.optional() }),
  z.object({ type: z.literal('quick_reply'), quick_reply_id: uuid }),
]);

const HEADER_ALIASES: Record<string, string> = {
  telefono: 'phone', phone: 'phone', celular: 'phone', whatsapp: 'phone', numero: 'phone', movil: 'phone', tel: 'phone',
  nombre: 'name', name: 'name', 'nombre completo': 'name',
  correo: 'email', email: 'email', 'correo electronico': 'email', mail: 'email',
  empresa: 'company', company: 'company', negocio: 'company',
  etiquetas: 'tags', tags: 'tags', etiqueta: 'tags',
  valor: 'deal_value', monto: 'deal_value', deal_value: 'deal_value', 'valor de venta': 'deal_value',
};
const normHeader = (h: string) => h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/**
 * Neutralizes spreadsheet formulas (cells starting with = + - @, tab or CR; names, tags and API
 * fields are user-controlled). Excel splits a .csv on the system list separator (';' in es-ES,
 * es-AR, es-CO, es-CL, pt-BR) without honouring quotes that do not open the field, and other apps
 * guess the separator: so every segment that could become a cell after a ; , tab or line break is
 * neutralized too, not only the start of the value.
 */
export function csvCell(v: unknown): string {
  const t = v == null ? '' : String(v);
  // The spaces before a formula exclude the separators themselves: each match then stops at the
  // next separator (linear), and a separator in that run starts its own match anyway.
  const safe = t.replace(/(^|[;,\t\r\n])((?:[^\S\t\r\n]|")*)(?=[=+\-@])/g, "$1$2'");
  return /^[\t\r]/.test(safe) ? `'${safe}` : safe;
}

/** Undoes csvCell, every ' it added (not only the first), so an exported file imports back as it was. */
export function uncsvCell(v: string): string {
  return v.replace(/^'(?=[\t\r])/, '').replace(/(^|[;,\t\r\n])((?:[^\S\t\r\n]|")*)'(?=[=+\-@])/g, '$1$2');
}

interface LegacyTagNode {
  /** Lowercase separator + segment → the node for names that go on after it. */
  next: Map<string, LegacyTagNode>;
  /** Lowercase separator + last segment → the tag's name. */
  ends: Map<string, string>;
}

/** Tags created before ; , and | were barred from names, by their lowercase first segment. */
export type LegacyTags = Map<string, LegacyTagNode>;

/**
 * Indexes the tags whose names contain ; , or | once per import, segment by segment, so splitting
 * a cell costs about its own length however many tags the workspace has.
 */
export function legacyTagIndex(names: Iterable<string>): LegacyTags {
  const index: LegacyTags = new Map();
  const node = (m: Map<string, LegacyTagNode>, key: string) => {
    let n = m.get(key);
    if (!n) m.set(key, (n = { next: new Map(), ends: new Map() }));
    return n;
  };
  for (const name of names) {
    if (name.length > 200 || !TAG_SEPARATORS.test(name)) continue;
    // [segment, separator, segment, …, separator, segment]
    const parts = name.trim().toLowerCase().split(/([;,|])/);
    let at = node(index, parts[0]);
    for (let k = 1; k < parts.length - 2; k += 2) at = node(at.next, parts[k] + parts[k + 1]);
    const last = parts[parts.length - 2] + parts[parts.length - 1];
    if (!at.ends.has(last)) at.ends.set(last, name);
  }
  return index;
}

/**
 * Tag names of an imported cell, split on ; , or |. Tags created before names were barred from
 * containing those characters still match whole (the longest one at each position), so their
 * export imports back.
 */
export function splitTagCell(cell: string, legacy: LegacyTags = new Map()): string[] {
  const parts = cell.split(/([;,|])/);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    let at = legacy.size ? legacy.get(parts[i].trimStart().toLowerCase()) : undefined;
    let match: string | undefined;
    let end = i;
    // A legacy name has at most 200 characters, so a longer segment ends the walk.
    for (let j = i + 2; at && j < parts.length && parts[j].length <= 200; j += 2) {
      const seg = parts[j].toLowerCase();
      const name = at.ends.get(parts[j - 1] + seg.trimEnd());
      if (name) [match, end] = [name, j];
      at = at.next.get(parts[j - 1] + seg);
    }
    if (match) {
      out.push(match);
      i = end;
    } else if (parts[i].trim()) {
      out.push(parts[i].trim());
    }
  }
  return out;
}

/** Columns of the export (also what marks a file as ours on import, see EXPORT_COLUMNS). */
const EXPORT_HEADER = ['telefono', 'nombre', 'correo', 'empresa', 'embudo', 'etapa', 'asignado_a', 'etiquetas', 'valor', 'origen', 'creado', 'ultimo_mensaje', 'campos'];
/** Contacts read per query by the export, and characters sent per chunk. */
const EXPORT_PAGE = 500;
const EXPORT_CHUNK = 64 * 1024;

function exportRow(r: Record<string, any>): Record<string, unknown> {
  return {
    // Also neutralized: a reader splitting on another separator can glue the next value onto it.
    telefono: csvCell(`+${r.phone}`),
    nombre: csvCell(r.name),
    correo: csvCell(r.email),
    empresa: csvCell(r.company),
    embudo: csvCell(r.funnel),
    etapa: csvCell(r.stage),
    asignado_a: csvCell(r.assigned_to),
    etiquetas: csvCell(r.tags),
    valor: r.deal_value,
    origen: csvCell(r.source),
    creado: new Date(r.created_at).toISOString(),
    ultimo_mensaje: r.last_message_at ? new Date(r.last_message_at).toISOString() : '',
    // Every cell is quoted, so a ';' or ',' inside a value never splits it in a standard reader.
    campos: csvCell(JSON.stringify(r.custom_fields ?? {})),
  };
}

/**
 * One page of the export, after the phone parameter `afterParam` holds, if any. Pages follow the
 * (workspace_id, phone) unique index every workspace already has: each one starts where the last
 * one ended, instead of sorting what is left of the workspace again for every page.
 */
export function exportPageSql(where: string, afterParam: string | null): string {
  return `SELECT c.phone, c.name, c.email, c.company, c.deal_value, c.source, c.created_at, c.last_message_at, c.custom_fields,
      f.name AS funnel, s.name AS stage, u.name AS assigned_to,
      (SELECT string_agg(t.name, ';') FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = c.id) AS tags
    FROM contacts c LEFT JOIN funnels f ON f.id = c.funnel_id LEFT JOIN stages s ON s.id = c.stage_id LEFT JOIN users u ON u.id = c.assigned_user_id
    WHERE ${where}${afterParam ? ` AND c.phone > ${afterParam}` : ''}
    ORDER BY c.phone LIMIT ${EXPORT_PAGE}`;
}

/** One spelling per tag (the first one): names are matched without case. */
function uniqueTagNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((n) => {
    const k = n.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** A letter lost by reading a non-UTF-8 file as UTF-8 leaves U+FFFD next to the rest of its word. */
const LOST_LETTER = /\p{L}\uFFFD|\uFFFD\p{L}/u;

function notUtf8(detail = '') {
  return badRequest(
    `${detail}El archivo no está guardado en UTF-8 y se perderían los acentos (por ejemplo, en "Teléfono" o en los nombres). En Excel, usa Guardar como → "CSV UTF-8 (delimitado por comas)" e impórtalo de nuevo.`,
    'CSV_NOT_UTF8',
  );
}

/**
 * A prepaid charge Meta can still settle: the refund of a message that fails after a billable
 * "sent", or the pricing adjustment of its first priced status. Settling needs the message row,
 * which deleting the contact removes (ON DELETE CASCADE). Meta gives up on a message in 30 days.
 */
const UNSETTLED_CHARGE = `EXISTS (SELECT 1 FROM messages m WHERE m.contact_id = c.id AND m.direction = 'out' AND m.charged_prepaid
  AND m.cost > 0 AND m.created_at > now() - interval '30 days'
  AND (NOT m.pricing_reconciled OR m.status NOT IN ('delivered', 'read', 'failed')))`;

/** Where the header line starts: the parser skips the blank lines before it (skip_empty_lines). */
function headerStart(text: string): number {
  // Linear scans: a regex over millions of blank lines would backtrack until the stack overflows.
  const first = text.search(/\S/);
  if (first < 0) return text.length;
  return Math.max(text.lastIndexOf('\n', first), text.lastIndexOf('\r', first)) + 1;
}

/** The header line (the first one that is not blank). */
function headerLine(text: string): string {
  const start = headerStart(text);
  const end = text.slice(start).search(/[\r\n]|$/);
  return text.slice(start, start + end);
}

/**
 * Delimiter of a CSV from its header line (Excel saves ';' or tab in locales with a decimal comma)
 * and how many columns that line has. The scan stops once some separator passes `maxColumns`: the
 * line then has more columns than that whichever separator wins.
 */
export function csvHeaderShape(text: string, maxColumns = Infinity): { delimiter: string; columns: number } {
  let inQuotes = false;
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  for (let i = headerStart(text); i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === '\n' || ch === '\r')) break;
    else if (!inQuotes && ch in counts && ++counts[ch] >= maxColumns) break;
  }
  const delimiter = [';', '\t'].reduce((best, d) => (counts[d] > counts[best] ? d : best), ',');
  return { delimiter, columns: counts[delimiter] + 1 };
}

export function detectCsvDelimiter(text: string): string {
  return csvHeaderShape(text).delimiter;
}

/** Every column of an import becomes a custom field (and work for each row): real files have far fewer. */
export const MAX_IMPORT_COLUMNS = 200;
export const MAX_IMPORT_ROWS = 20_000;
/** Column names become custom-field keys of every row: same limit as those keys. */
export const MAX_IMPORT_HEADER = CUSTOM_FIELD_KEY_MAX;
/**
 * Characters one row (the header too) may hold before parsing stops: a valid row (200 columns of
 * at most 1,000 characters, or our export's custom fields) is far smaller.
 */
export const MAX_IMPORT_RECORD = 256 * 1024;
/** Bytes parsed between yields to the event loop, so other requests, webhooks and jobs keep running. */
const CSV_CHUNK = 64 * 1024;
/** Time an import may hold the event loop before yielding (the loop over rows, the checks). */
const IMPORT_SLICE_MS = 10;

const yieldToEventLoop = () => new Promise<void>((r) => setImmediate(r));

/** Yields once this many milliseconds passed since the last yield (call it inside long loops). */
function yielder(sliceMs = IMPORT_SLICE_MS) {
  let since = performance.now();
  return async () => {
    if (performance.now() - since < sliceMs) return;
    await yieldToEventLoop();
    since = performance.now();
  };
}

/**
 * Parses a CSV (header row → objects) in chunks, yielding between them: a 10 MB file must not
 * freeze every tenant for seconds. Stops as soon as it holds more than `maxRows` rows, or at a
 * header of more than `maxColumns`.
 */
async function parseCsvYielding(
  text: string,
  delimiter: string,
  limits: { maxRows: number; maxColumns: number },
): Promise<{ header: string[]; records: Record<string, string>[] }> {
  const { maxRows } = limits;
  let header: string[] = [];
  const parser = parseCsvStream({
    // The header the parser actually uses (csvHeaderShape only looked ahead): each of its columns
    // is a key of every row, walked for every row.
    columns: (h: string[]) => {
      if (h.length > limits.maxColumns) throw tooManyColumns();
      const long = h.find((name) => name.length > MAX_IMPORT_HEADER);
      if (long !== undefined) throw headerTooLong(long);
      return (header = h);
    },
    delimiter,
    max_record_size: MAX_IMPORT_RECORD,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    bom: true,
  });
  const records: Record<string, string>[] = [];
  parser.on('data', (r: Record<string, string>) => records.push(r));
  const done = finished(parser);
  done.catch(() => {}); // awaited below; a parse error also rejects the pending write
  const buf = Buffer.from(text, 'utf8');
  try {
    for (let at = 0; at < buf.length; at += CSV_CHUNK) {
      await new Promise<void>((resolve, reject) => parser.write(buf.subarray(at, at + CSV_CHUNK), (err) => (err ? reject(err) : resolve())));
      if (records.length > maxRows) break;
      await yieldToEventLoop();
    }
    if (records.length > maxRows) {
      parser.destroy();
      throw tooManyRows();
    }
    parser.end();
    await done;
  } catch (err) {
    if (err instanceof AppError) throw err;
    if ((err as { code?: string }).code === 'CSV_MAX_RECORD_SIZE') {
      const line = (err as { lines?: number }).lines;
      throw badRequest(
        `${line ? `La línea ${line}` : 'Una fila'} del archivo supera ${MAX_IMPORT_RECORD / 1024} KB: revisa que sus comillas estén cerradas.`,
        'CSV_RECORD_TOO_LARGE',
      );
    }
    throw badRequest(`No se pudo leer el CSV: ${(err as Error).message}`);
  }
  // The last row only comes out when the parser ends.
  if (records.length > maxRows) throw tooManyRows();
  return { header, records };
}

const tooManyRows = () => badRequest(`Máximo ${MAX_IMPORT_ROWS.toLocaleString('en-US')} filas por importación`);
const tooManyColumns = () => badRequest(`El archivo tiene demasiadas columnas (máximo ${MAX_IMPORT_COLUMNS})`, 'CSV_TOO_MANY_COLUMNS');
const headerTooLong = (name: string) =>
  badRequest(`El nombre de columna "${name.slice(0, 40)}…" supera ${MAX_IMPORT_HEADER} caracteres`, 'CSV_HEADER_TOO_LONG');

/**
 * Columns of our own export that are not contact fields: `campos` holds the custom fields (JSON),
 * `embudo`/`etapa` the placement (matched by name), the rest is read-only history. A file is ours
 * only with all of them: other files can have a "Campos" or "Origen" column of their own.
 */
const EXPORT_COLUMNS = new Set(['campos', 'embudo', 'etapa', 'asignado_a', 'origen', 'creado', 'ultimo_mensaje']);

/** The custom fields our export wrote in `campos` (a JSON object), or null when it is not one. */
function exportedFields(cell: string | undefined): Record<string, unknown> | null {
  if (!cell) return null;
  try {
    const v = JSON.parse(cell);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** Amount typed as 1500, 1,500.50, 1.500,50, 150.000 or 1500,5 (decimal comma), ignoring currency signs. */
export function parseAmount(raw: string): number {
  let s = String(raw).replace(/[^\d.,-]/g, '');
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastComma > lastDot) {
    // A comma followed by exactly 3 digits and no dot is a thousands separator (1,500).
    s = lastDot < 0 && /,\d{3}$/.test(s) ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.').replace(/,/g, '');
  } else if (lastComma < 0 && /^-?[1-9]\d{0,2}(\.\d{3})+$/.test(s)) {
    // Dot-grouped thousands (es-CO, es-AR, es-CL, es-ES: "$ 150.000"), also with a single group:
    // deal values are stored with 2 decimals, so "150.000" is never meant as 150 with 3 decimals.
    s = s.replace(/\./g, '');
  } else if ((s.match(/\./g) ?? []).length > 1) {
    s = s.replace(/[.,]/g, ''); // 1.500.000
  } else {
    s = s.replace(/,/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function contactRoutes(app: FastifyInstance, ctx: AppContext) {
  async function ensureVisible(a: WsAuth, contactId: string) {
    const contact = await getContact(ctx.db, a.workspaceId, contactId);
    if ((await visibilityFilter(ctx, a)) && contact.assigned_user_id && contact.assigned_user_id !== a.user.id) {
      throw badRequest('Este contacto está asignado a otra persona', 'NOT_ASSIGNED_TO_YOU');
    }
    return contact;
  }

  // With sort=recent (the inbox) pages can also be read by keyset: `cursor` = the previous page's
  // next_cursor. Conversations that move to the top or leave the filter meanwhile then never shift
  // the next page (OFFSET would skip or repeat rows); `page` keeps working for the other sorts.
  app.get('/api/contacts', async (req) => {
    const a = await requireWs(ctx, req);
    const f = parse(listSchema, req.query);
    if (f.cursor && f.sort !== 'recent') throw badRequest('El cursor solo sirve con sort=recent', 'INVALID_CURSOR');
    const key = f.cursor ? decodeCursor(f.cursor) : null;
    const { where, params } = buildWhere(a, f, await visibilityFilter(ctx, a));
    const total = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM contacts c WHERE ${where}`, params);
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const recent = f.sort === 'recent';
    const { rows } = await ctx.db.query<{ id: string; _k_lm: string | null; _k_ca: string }>(
      `SELECT ${CONTACT_COLUMNS}${recent ? `, ${KEY_COLUMNS}` : ''} FROM contacts c
       WHERE ${where}${key ? ` AND ${afterCursor(key, p)}` : ''}
       ORDER BY ${ORDER[f.sort]} LIMIT ${f.limit + (recent ? 1 : 0)} OFFSET ${key ? 0 : (f.page - 1) * f.limit}`,
      params,
    );
    const more = recent && rows.length > f.limit;
    const items = rows.slice(0, f.limit);
    const next = more ? encodeCursor(items[items.length - 1]) : null;
    const out = recent ? items.map(({ _k_lm, _k_ca, ...c }) => c) : items;
    return { items: out, total: total.rows[0].n, page: f.page, limit: f.limit, next_cursor: next };
  });

  app.get('/api/contacts/counts', async (req) => {
    const a = await requireWs(ctx, req);
    const restricted = await visibilityFilter(ctx, a);
    const vis = restricted ? `AND (assigned_user_id = $2 OR assigned_user_id IS NULL)` : '';
    const { rows } = await ctx.db.query<Record<string, number>>(
      `SELECT count(*) FILTER (WHERE last_message_at IS NOT NULL)::int AS all,
         count(*) FILTER (WHERE last_message_at IS NOT NULL AND assigned_user_id = $2)::int AS mine,
         count(*) FILTER (WHERE last_message_at IS NOT NULL AND assigned_user_id IS NULL)::int AS unassigned,
         count(*) FILTER (WHERE unread_count > 0)::int AS unread
       FROM contacts WHERE workspace_id = $1 AND NOT is_archived ${vis}`,
      [a.workspaceId, a.user.id],
    );
    return rows[0];
  });

  app.post('/api/contacts', async (req) => {
    const a = await requireWs(ctx, req);
    const body = parse(
      z.object({
        phone: z.string().min(6),
        name: z.string().trim().max(120).optional(),
        email: z.string().trim().email('Correo inválido').optional().or(z.literal('')),
        company: z.string().trim().max(120).optional(),
        funnel_id: uuid.optional(),
        stage_id: uuid.optional(),
        assigned_user_id: uuid.optional(),
        deal_value: z.number().min(0).optional(),
        custom_fields: customFieldsSchema.optional(),
        tag_ids: z.array(uuid).optional(),
      }),
      req.body,
    );
    const { contact, created } = await createContact(
      ctx,
      a.workspaceId,
      {
        phone: body.phone,
        name: body.name,
        email: body.email || null,
        company: body.company,
        funnelId: body.funnel_id,
        stageId: body.stage_id,
        assignedUserId: body.assigned_user_id,
        dealValue: body.deal_value,
        customFields: body.custom_fields,
        tagIds: body.tag_ids,
        source: 'manual',
      },
      { userId: a.user.id },
    );
    // The phone already exists: a restricted agent gets neither the row nor an assignment change
    // when that conversation belongs to someone else (same rule as GET /api/contacts/:id).
    if (!created && contact.assigned_user_id && contact.assigned_user_id !== a.user.id && (await visibilityFilter(ctx, a))) {
      throw conflict('Ya existe un contacto con ese teléfono y no tienes acceso a él.', 'CONTACT_EXISTS');
    }
    return { contact, created };
  });

  app.get('/api/contacts/export.csv', async (req, reply) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const f = parse(listSchema.partial(), req.query);
    const { where, params } = buildWhere(a, { ...f, archived: f.archived }, false);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="contactos-${new Date().toISOString().slice(0, 10)}.csv"`);
    // Streamed page by page: a large workspace's file is never built (nor held) whole, and the event
    // loop every tenant shares is given back between pages and rows.
    return reply.send(Readable.from(exportCsv(where, params)));
  });

  async function* exportCsv(where: string, params: unknown[]): AsyncGenerator<string> {
    yield '\ufeff' + stringify([], { header: true, quoted: true, columns: EXPORT_HEADER });
    const pause = yielder();
    let after: string | null = null;
    for (;;) {
      const p = after === null ? params : [...params, after];
      const { rows }: { rows: Record<string, any>[] } = await ctx.db.query(exportPageSql(where, after === null ? null : `$${p.length}`), p);
      let chunk = '';
      for (const r of rows) {
        chunk += stringify([exportRow(r)], { quoted: true, columns: EXPORT_HEADER });
        if (chunk.length >= EXPORT_CHUNK) {
          yield chunk;
          chunk = '';
        }
        await pause();
      }
      if (chunk) yield chunk;
      if (rows.length < EXPORT_PAGE) return;
      after = rows[rows.length - 1].phone as string;
      await yieldToEventLoop();
    }
  }

  app.post('/api/contacts/import', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const body = parse(
      z.object({
        csv: z.string().min(1).max(10_000_000),
        funnel_id: uuid.optional(),
        stage_id: uuid.optional(),
        tag_ids: z.array(uuid).optional(),
        // How the caller turned the file into text: true when it had to replace bytes that were not
        // UTF-8 (each became U+FFFD), false when nothing was lost. Unknown when absent.
        lossy: z.boolean().optional(),
      }),
      req.body,
    );
    const text = body.csv.replace(/^﻿/, '');
    // U+FFFD where bytes were not UTF-8 (Excel's plain "CSV" is ANSI/cp1252 in Spanish locales):
    // the accents are already lost, so headers like "Teléfono" would not match and names would be
    // stored garbled. It can also be real data (a customer's WhatsApp name, kept by our own export),
    // so when the caller does not say how it decoded the file, only a U+FFFD in the header line or
    // standing for a letter (checked below) is refused.
    if (body.lossy === true ? text.includes('\ufffd') : body.lossy === undefined && headerLine(text).includes('\ufffd')) throw notUtf8();
    // Bounded before parsing: a header of a million columns costs seconds and stores nothing useful.
    const shape = csvHeaderShape(text, MAX_IMPORT_COLUMNS);
    if (shape.columns > MAX_IMPORT_COLUMNS) throw tooManyColumns();
    const { header: columns, records } = await parseCsvYielding(text, shape.delimiter, { maxRows: MAX_IMPORT_ROWS, maxColumns: MAX_IMPORT_COLUMNS });
    const pause = yielder();
    if (body.lossy === undefined) {
      for (const [i, rec] of records.entries()) {
        await pause();
        const bad = Object.values(rec).find((v) => typeof v === 'string' && LOST_LETTER.test(v));
        if (bad) {
          const at = bad.indexOf('\ufffd');
          throw notUtf8(`La fila ${i + 2} tiene letras que no se pudieron leer ("${bad.slice(Math.max(0, at - 20), at + 20)}"). `);
        }
      }
    }
    // Headers are resolved once per file, not once per cell.
    const headers = new Map<string, { target: string | undefined; name: string; norm: string }>();
    const header = (k: string) => {
      let h = headers.get(k);
      if (!h) headers.set(k, (h = { target: HEADER_ALIASES[normHeader(k)], name: k.trim(), norm: normHeader(k) }));
      return h;
    };
    // Our own export: its custom fields come back as fields, its placement by name, and its other
    // columns are not stored as fields.
    const norms = new Set(columns.map((k) => header(k).norm));
    const ourExport = [...EXPORT_COLUMNS].every((c) => norms.has(c));
    const camposKey = ourExport ? columns.find((k) => header(k).norm === 'campos') : undefined;
    const placement = new Map<string, { funnelId: string; stageId: string | null }>();
    if (ourExport && !body.funnel_id && !body.stage_id) {
      const st = await ctx.db.query<{ funnel_id: string; funnel: string; stage_id: string; stage: string }>(
        `SELECT f.id AS funnel_id, f.name AS funnel, s.id AS stage_id, s.name AS stage FROM funnels f JOIN stages s ON s.funnel_id = f.id
         WHERE f.workspace_id = $1 ORDER BY f.position, s.position`,
        [a.workspaceId],
      );
      for (const r of st.rows) {
        const f = r.funnel.trim().toLowerCase();
        if (!placement.has(f)) placement.set(f, { funnelId: r.funnel_id, stageId: null });
        const k = `${f}\n${r.stage.trim().toLowerCase()}`;
        if (!placement.has(k)) placement.set(k, { funnelId: r.funnel_id, stageId: r.stage_id });
      }
    }
    const tagsRes = await ctx.db.query<{ id: string; name: string }>(`SELECT id, name FROM tags WHERE workspace_id = $1`, [a.workspaceId]);
    const tagByName = new Map(tagsRes.rows.map((t) => [t.name.toLowerCase(), t.id]));
    const legacyTags = legacyTagIndex(tagsRes.rows.map((t) => t.name));
    // Tags this import may still create (the database checks again: this only spares its query to
    // the rows that cannot fit, every row once the workspace is full).
    let tagRoom = MAX_TAGS_PER_WORKSPACE - tagsRes.rows.length;
    let created = 0;
    let existing = 0;
    const errors: { row: number; error: string }[] = [];
    for (const [i, rec] of records.entries()) {
      await pause();
      const mapped: Record<string, string> = {};
      const exported: Record<string, string> = {};
      let custom: Record<string, unknown> = {};
      // A row whose `campos` is not the JSON our export wrote (edited by hand) keeps every column.
      const fields = camposKey !== undefined ? exportedFields(uncsvCell(rec[camposKey] ?? '')) : null;
      for (const [k, raw] of Object.entries(rec)) {
        const v = typeof raw === 'string' ? uncsvCell(raw) : raw;
        const h = header(k);
        if (h.target) mapped[h.target] = v;
        else if (fields && EXPORT_COLUMNS.has(h.norm)) exported[h.norm] = v;
        else if (v && h.name) custom[h.name] = v; // a column with no name has no field to go to
      }
      if (fields) custom = { ...fields, ...custom };
      const funnelName = exported.embudo?.trim().toLowerCase();
      const place = funnelName ? (placement.get(`${funnelName}\n${exported.etapa?.trim().toLowerCase() ?? ''}`) ?? placement.get(funnelName)) : undefined;
      if (!mapped.phone) {
        errors.push({ row: i + 2, error: 'Falta el teléfono' });
        continue;
      }
      // Same limits as creating a contact or a tag by hand.
      const tooLong =
        (mapped.name?.trim().length ?? 0) > 120
          ? 'El nombre admite máximo 120 caracteres'
          : (mapped.company?.trim().length ?? 0) > 120
            ? 'La empresa admite máximo 120 caracteres'
            : null;
      const names = uniqueTagNames(splitTagCell(mapped.tags ?? '', legacyTags));
      const longTag = names.find((n) => n.length > TAG_NAME_MAX && !tagByName.has(n.toLowerCase()));
      // Same cap as the public API: each tag is work (and rows) for this one request.
      const tooManyTags = names.length > MAX_TAGS_PER_CONTACT ? `Máximo ${MAX_TAGS_PER_CONTACT} etiquetas por contacto` : null;
      const badFields = customFieldsError(custom);
      if (tooLong || tooManyTags || longTag || badFields) {
        errors.push({ row: i + 2, error: tooLong ?? tooManyTags ?? badFields ?? `La etiqueta "${longTag!.slice(0, 40)}…" supera ${TAG_NAME_MAX} caracteres` });
        continue;
      }
      const missing = names.filter((n) => !tagByName.has(n.toLowerCase()));
      if (missing.length) {
        if (missing.length > tagRoom) {
          errors.push({ row: i + 2, error: tagLimitReached().message });
          continue;
        }
        try {
          for (const [name, id] of await createTagsByName(ctx.db, a.workspaceId, missing)) tagByName.set(name.toLowerCase(), id);
          tagRoom -= missing.length;
        } catch (err) {
          if (!(err instanceof AppError && err.code === 'TAG_LIMIT_REACHED')) throw err;
          tagRoom = Math.min(tagRoom, missing.length - 1); // others created tags meanwhile
          errors.push({ row: i + 2, error: err.message });
          continue;
        }
      }
      const tagIds = [...(body.tag_ids ?? []), ...names.map((n) => tagByName.get(n.toLowerCase())!)];
      try {
        const r = await createContact(
          ctx,
          a.workspaceId,
          {
            phone: mapped.phone,
            name: mapped.name,
            email: mapped.email && mapped.email.includes('@') && mapped.email.length <= 254 ? mapped.email : null,
            company: mapped.company,
            dealValue: mapped.deal_value ? parseAmount(mapped.deal_value) : 0,
            customFields: custom,
            funnelId: body.funnel_id ?? place?.funnelId,
            stageId: body.stage_id ?? place?.stageId ?? undefined,
            tagIds,
            source: 'import',
          },
          { userId: a.user.id },
        );
        if (r.created) created++;
        else {
          existing++;
          if (tagIds.length) await updateContact(ctx, a.workspaceId, r.contact.id, { addTagIds: tagIds });
        }
      } catch (err) {
        errors.push({ row: i + 2, error: (err as Error).message });
      }
    }
    return { total: records.length, created, existing, errors: errors.slice(0, 200), error_count: errors.length };
  });

  app.post('/api/contacts/bulk', async (req) => {
    const a = await requireWs(ctx, req);
    const body = parse(
      z.object({
        ids: z.array(uuid).min(1).max(5000),
        action: z.enum(['add_tags', 'remove_tags', 'move_stage', 'assign', 'archive', 'unarchive', 'opt_out', 'delete']),
        tag_ids: z.array(uuid).optional(),
        stage_id: uuid.optional(),
        user_id: uuid.nullable().optional(),
      }),
      req.body,
    );
    if (['delete', 'opt_out'].includes(body.action) && a.role === 'agent') throw badRequest('Solo administradores pueden hacer esta acción');
    if (await visibilityFilter(ctx, a)) {
      const visible = await ctx.db.query<{ id: string }>(
        `SELECT id FROM contacts WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND (assigned_user_id = $3 OR assigned_user_id IS NULL)`,
        [a.workspaceId, body.ids, a.user.id],
      );
      body.ids = visible.rows.map((r) => r.id);
    }
    if (body.action === 'delete') {
      // Contacts with a charge Meta can still settle are archived instead (see UNSETTLED_CHARGE).
      const r = await ctx.db.tx(async (q) => {
        // Locked first: a send in progress (it locks its contact) commits before the check reads.
        await q.query(`SELECT id FROM contacts WHERE workspace_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`, [a.workspaceId, body.ids]);
        const kept = await q.query<{ id: string; assigned_user_id: string | null }>(
          `UPDATE contacts c SET is_archived = true, updated_at = now() WHERE c.workspace_id = $1 AND c.id = ANY($2::uuid[]) AND ${UNSETTLED_CHARGE}
           RETURNING c.id, c.assigned_user_id`,
          [a.workspaceId, body.ids],
        );
        const deleted = await q.query<{ id: string; assigned_user_id: string | null }>(
          `DELETE FROM contacts c WHERE c.workspace_id = $1 AND c.id = ANY($2::uuid[]) AND NOT ${UNSETTLED_CHARGE} RETURNING c.id, c.assigned_user_id`,
          [a.workspaceId, body.ids],
        );
        return { kept: kept.rows, deleted: deleted.rows };
      });
      // Restricted agents only hear about the conversations they could see.
      ctx.realtime.emitContactsBulk(a.workspaceId, 'delete', r.deleted);
      ctx.realtime.emitContactsBulk(a.workspaceId, 'archive', r.kept);
      return { updated: r.deleted.length, archived: r.kept.length };
    }
    let updated = 0;
    for (const id of body.ids) {
      const patch: Parameters<typeof updateContact>[3] = {};
      if (body.action === 'add_tags') patch.addTagIds = body.tag_ids ?? [];
      if (body.action === 'remove_tags') patch.removeTagIds = body.tag_ids ?? [];
      if (body.action === 'move_stage') {
        if (!body.stage_id) throw badRequest('Elige la etapa destino');
        patch.stageId = body.stage_id;
      }
      if (body.action === 'assign') patch.assignedUserId = body.user_id ?? null;
      if (body.action === 'archive') patch.isArchived = true;
      if (body.action === 'unarchive') patch.isArchived = false;
      if (body.action === 'opt_out') patch.optedOut = true;
      try {
        await updateContact(ctx, a.workspaceId, id, patch, { userId: a.user.id });
        updated++;
      } catch {
        // contact deleted meanwhile or not in workspace: skip
      }
    }
    return { updated };
  });

  app.get('/api/contacts/:id', async (req) => {
    const a = await requireWs(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const contact = await ensureVisible(a, id);
    const events = await ctx.db.query(
      `SELECT e.*, u.name AS user_name FROM contact_events e LEFT JOIN users u ON u.id = e.user_id
       WHERE e.contact_id = $1 ORDER BY e.created_at DESC LIMIT 100`,
      [id],
    );
    // Failed sends stay listed (with their error) for a week so the panel can show and dismiss them;
    // one being sent stays listed until it is done (cancelling it answers 409 SCHEDULED_SENDING).
    const scheduled = await ctx.db.query(
      `SELECT * FROM scheduled_messages WHERE contact_id = $1
         AND (status IN ('pending', 'sending') OR (status = 'failed' AND send_at > now() - interval '7 days'))
       ORDER BY send_at`,
      [id],
    );
    return { contact, events: events.rows, scheduled: scheduled.rows, window_open: isWindowOpen(contact.last_inbound_at) };
  });

  app.patch('/api/contacts/:id', async (req) => {
    const a = await requireWs(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    await ensureVisible(a, id);
    const body = parse(
      z.object({
        name: z.string().trim().max(120).nullable().optional(),
        email: z.string().trim().email('Correo inválido').nullable().optional().or(z.literal('')),
        company: z.string().trim().max(120).nullable().optional(),
        deal_value: z.number().min(0).optional(),
        custom_fields: customFieldsSchema.optional(),
        funnel_id: uuid.optional(),
        stage_id: uuid.optional(),
        assigned_user_id: uuid.nullable().optional(),
        ai_paused: z.boolean().optional(),
        is_archived: z.boolean().optional(),
        opted_out: z.boolean().optional(),
        tag_ids: z.array(uuid).optional(),
        add_tag_ids: z.array(uuid).optional(),
        remove_tag_ids: z.array(uuid).optional(),
        reset_bot: z.boolean().optional(),
      }),
      req.body,
    );
    if (body.reset_bot) await ctx.db.query(`UPDATE contacts SET bot_state = NULL WHERE id = $1`, [id]);
    const contact = await updateContact(
      ctx,
      a.workspaceId,
      id,
      {
        name: body.name,
        email: body.email === '' ? null : body.email,
        company: body.company,
        dealValue: body.deal_value,
        customFields: body.custom_fields,
        funnelId: body.funnel_id,
        stageId: body.stage_id,
        assignedUserId: body.assigned_user_id,
        aiPaused: body.ai_paused,
        isArchived: body.is_archived,
        optedOut: body.opted_out,
        tagIds: body.tag_ids,
        addTagIds: body.add_tag_ids,
        removeTagIds: body.remove_tag_ids,
      },
      { userId: a.user.id },
    );
    return { contact };
  });

  app.delete('/api/contacts/:id', async (req, reply) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const gone = await ctx.db.tx(async (q) => {
      await q.query(`SELECT id FROM contacts WHERE id = $1 AND workspace_id = $2 FOR UPDATE`, [id, a.workspaceId]);
      const pending = await q.query(`SELECT 1 FROM contacts c WHERE c.id = $1 AND c.workspace_id = $2 AND ${UNSETTLED_CHARGE}`, [id, a.workspaceId]);
      if (pending.rows[0]) {
        throw new AppError(
          409,
          'CONTACT_BILLING_PENDING',
          'Este contacto tiene mensajes cobrados que Meta todavía no confirma como entregados. Si lo borras ahora, ya no se podría reembolsar uno que no se entregue: archívalo y bórralo cuando se confirmen (a más tardar en 30 días).',
        );
      }
      const del = await q.query<{ id: string; assigned_user_id: string | null }>(
        `DELETE FROM contacts WHERE id = $1 AND workspace_id = $2 RETURNING id, assigned_user_id`,
        [id, a.workspaceId],
      );
      return del.rows;
    });
    ctx.realtime.emitContactsBulk(a.workspaceId, 'delete', gone);
    return noContent(reply);
  });

  // ---- Conversation ----
  app.get('/api/contacts/:id/messages', async (req) => {
    const a = await requireWs(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const q = parse(
      z.object({
        // The oldest message already shown: a keyset at full precision. Messages of one webhook are
        // microseconds apart (and late ones can tie), which a JSON timestamp (`before`) cannot tell apart.
        before_id: uuid.optional(),
        before: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(60),
      }),
      req.query,
    );
    await ensureVisible(a, id);
    const cursor = q.before_id
      ? 'AND (m.created_at, m.id) < (SELECT b.created_at, b.id FROM messages b WHERE b.id = $3 AND b.contact_id = $1 AND b.workspace_id = $2)'
      : q.before
        ? 'AND m.created_at < $3'
        : '';
    const { rows } = await ctx.db.query<MessageRow>(
      `SELECT m.*, mf.mime AS file_mime, mf.filename AS file_name, mf.size AS file_size, u.name AS user_name
       FROM messages m LEFT JOIN media_files mf ON mf.id = m.media_file_id LEFT JOIN users u ON u.id = m.user_id
       WHERE m.contact_id = $1 AND m.workspace_id = $2 ${cursor}
       ORDER BY m.created_at DESC, m.id DESC LIMIT ${q.limit}`,
      cursor ? [id, a.workspaceId, q.before_id ?? q.before] : [id, a.workspaceId],
    );
    return { messages: rows.reverse(), has_more: rows.length === q.limit };
  });

  app.post('/api/contacts/:id/messages', async (req) => {
    const a = await requireWs(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const contact = await ensureVisible(a, id);
    const body = parse(sendSchema, req.body);
    const send = (content: SendContent, replyTo?: string) =>
      sendMessage(ctx, { workspaceId: a.workspaceId, contactId: id, content, sentBy: 'user', userId: a.user.id, replyToWamid: replyTo });
    if (body.type === 'quick_reply') {
      const qr = await ctx.db.query<{ body: string; media_file_id: string | null; media_mime: string | null }>(
        `SELECT q.body, q.media_file_id, mf.mime AS media_mime FROM quick_replies q
         LEFT JOIN media_files mf ON mf.id = q.media_file_id AND mf.workspace_id = q.workspace_id
         WHERE q.id = $1 AND q.workspace_id = $2`,
        [body.quick_reply_id, a.workspaceId],
      );
      if (!qr.rows[0]) throw badRequest('Respuesta rápida no encontrada');
      const { media_file_id: mediaFileId, media_mime: mime } = qr.rows[0];
      const text = renderPlaceholders(qr.rows[0].body, contact, false);
      if (!mediaFileId) return { message: await send({ type: 'text', text }) };
      // WhatsApp only carries a caption (up to 1024 characters) on images, videos and documents:
      // otherwise the file goes first and the text follows as its own message, so it is never lost.
      const kind = waTypeForMime(mime ?? '');
      const asCaption = kind !== 'audio' && kind !== 'sticker' && text.length <= MAX_CAPTION;
      const messages = [await send({ type: 'media', mediaFileId, ...(asCaption ? { caption: text } : {}) })];
      if (!asCaption && text.trim()) messages.push(await send({ type: 'text', text }));
      return { message: messages[0], messages };
    }
    if (body.type === 'text') return { message: await send({ type: 'text', text: body.text }, body.reply_to_wamid) };
    if (body.type === 'media') return { message: await send({ type: 'media', mediaFileId: body.media_file_id, caption: body.caption }) };
    return {
      message: await send({ type: 'template', name: body.name, language: body.language, params: renderTemplateParams(body.params, contact) }),
    };
  });

  app.post('/api/contacts/:id/notes', async (req) => {
    const a = await requireWs(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    await ensureVisible(a, id);
    const body = parse(z.object({ text: z.string().trim().min(1).max(4000) }), req.body);
    return { message: await addNote(ctx, a.workspaceId, id, a.user.id, body.text) };
  });

  app.post('/api/contacts/:id/read', async (req) => {
    const a = await requireWs(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const contact = await ensureVisible(a, id);
    if (contact.unread_count > 0) {
      await ctx.db.query(`UPDATE contacts SET unread_count = 0 WHERE id = $1`, [id]);
      const last = await ctx.db.query<{ wamid: string; channel_id: string }>(
        `SELECT wamid, channel_id FROM messages WHERE contact_id = $1 AND direction = 'in' AND wamid IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
        [id],
      );
      if (last.rows[0]) {
        try {
          const ch = await getChannel(ctx.db, a.workspaceId, last.rows[0].channel_id);
          await providerFor(ctx, ch).markRead(last.rows[0].wamid);
        } catch (err) {
          ctx.log.debug({ err: (err as Error).message }, 'markRead failed');
        }
      }
      ctx.realtime.emit(a.workspaceId, 'contact:update', await getContact(ctx.db, a.workspaceId, id));
    }
    return { ok: true };
  });

  // ---- Scheduled messages ----
  app.get('/api/scheduled', async (req) => {
    const a = await requireWs(ctx, req);
    const restricted = await visibilityFilter(ctx, a);
    const { rows } = await ctx.db.query(
      `SELECT s.*, c.name AS contact_name, c.phone AS contact_phone, u.name AS created_by_name FROM scheduled_messages s
       JOIN contacts c ON c.id = s.contact_id LEFT JOIN users u ON u.id = s.created_by
       WHERE s.workspace_id = $1 AND (s.status = 'pending' OR s.send_at > now() - interval '7 days')
         AND (NOT $2 OR c.assigned_user_id IS NULL OR c.assigned_user_id = $3)
       ORDER BY s.send_at`,
      [a.workspaceId, restricted, a.user.id],
    );
    return { scheduled: rows };
  });

  app.post('/api/contacts/:id/scheduled', async (req) => {
    const a = await requireWs(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const contact = await ensureVisible(a, id);
    const body = parse(
      z.object({
        send_at: z.string().datetime({ offset: true }),
        content: z.discriminatedUnion('type', [
          z.object({ type: z.literal('text'), text: z.string().min(1).max(4096) }),
          z.object({ type: z.literal('template'), name: z.string().min(1).max(512), language: z.string().min(2).max(20), params: templateParamsSchema.optional() }),
        ]),
      }),
      req.body,
    );
    if (body.content.type === 'template') {
      // Refuse now what would only fail at send time (missing variables, location, coupon…).
      // Checked as the send renders them: a placeholder such as {campo.cupon} is not the coupon itself.
      // Against the number the send will use: an unbound contact may be answered from another one.
      const sending = await sendingChannelId(ctx.db, a.workspaceId, contact).catch(() => null);
      const channel = await getChannel(ctx.db, a.workspaceId, sending).catch(() => null);
      const tpl = channel ? await findTemplate(ctx.db, channel.id, body.content.name, body.content.language) : null;
      if (tpl) checkTemplateParams(tpl.components, renderTemplateParams(body.content.params as TemplateParams | undefined, contact));
    }
    const s = await scheduleMessage(ctx, a.workspaceId, id, a.user.id, body.content as SendContent, new Date(body.send_at));
    return { scheduled: s };
  });

  app.delete('/api/scheduled/:id', async (req, reply) => {
    const a = await requireWs(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const s = await ctx.db.query<{ contact_id: string }>(`SELECT contact_id FROM scheduled_messages WHERE id = $1 AND workspace_id = $2`, [
      id,
      a.workspaceId,
    ]);
    if (s.rows[0]) await ensureVisible(a, s.rows[0].contact_id);
    await cancelScheduled(ctx, a.workspaceId, id);
    return noContent(reply);
  });

  // ---- Kanban board ----
  app.get('/api/funnels/:id/board', async (req: FastifyRequest) => {
    const a = await requireWs(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const f = parse(listSchema.pick({ search: true, tag_id: true, assigned_user_id: true, inbox: true }), req.query);
    const stages = await ctx.db.query<{ id: string }>(`SELECT * FROM stages WHERE funnel_id = $1 AND workspace_id = $2 ORDER BY position`, [
      id,
      a.workspaceId,
    ]);
    const { where, params } = buildWhere(a, { ...f, funnel_id: id }, await visibilityFilter(ctx, a));
    const totals = await ctx.db.query<{ stage_id: string; count: number; value: number }>(
      `SELECT c.stage_id, count(*)::int AS count, COALESCE(sum(c.deal_value), 0)::float AS value FROM contacts c WHERE ${where} GROUP BY c.stage_id`,
      params,
    );
    const { rows } = await ctx.db.query<any>(
      `SELECT * FROM (
         SELECT ${CONTACT_COLUMNS}, row_number() OVER (PARTITION BY c.stage_id ORDER BY c.stage_changed_at DESC NULLS LAST, c.created_at DESC) AS rn
         FROM contacts c WHERE ${where}
       ) x WHERE x.rn <= 100`,
      params,
    );
    return {
      stages: stages.rows.map((s) => {
        const t = totals.rows.find((r) => r.stage_id === s.id);
        return { ...s, count: t?.count ?? 0, value: t?.value ?? 0, contacts: rows.filter((c) => c.stage_id === s.id) };
      }),
    };
  });
}
