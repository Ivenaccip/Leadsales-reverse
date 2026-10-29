import type { AppContext } from '../context.js';
import type { Queryable } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import type { ChannelRow } from '../types.js';
import { providerFor } from '../whatsapp/provider.js';
import type { CreateTemplateInput, TemplateParams } from '../whatsapp/types.js';

export interface TemplateRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  meta_id: string | null;
  name: string;
  language: string;
  category: string;
  status: string;
  components: any[];
  parameter_format: string | null;
  rejected_reason: string | null;
  updated_at: Date;
}

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*|\d+)\s*\}\}/g;

export function variablesIn(text: string | undefined | null): string[] {
  if (!text) return [];
  // A Set keeps this linear: stored templates are parsed again on every listing and send.
  return [...new Set(Array.from(text.matchAll(VAR_RE), (m) => m[1]))];
}

/**
 * Variables in the order their values are given: Meta fills positional parameters by number
 * (parameters[0] is {{1}}) wherever {{1}} sits in the text, so numbered ones go by number; named
 * ones are matched by name and keep their order of appearance.
 */
export function orderedVariables(text: string | undefined | null): string[] {
  const vars = variablesIn(text);
  return vars.length && vars.every((v) => /^\d+$/.test(v)) ? vars.sort((a, b) => Number(a) - Number(b)) : vars;
}

export type TemplateHeaderInput =
  | { type: 'text'; variables: string[] }
  | { type: 'image' | 'video' | 'document' | 'location'; variables: string[] };

export interface TemplateInputs {
  header: TemplateHeaderInput | null;
  body: string[];
  /** Buttons that need a value at send time: URL buttons with a variable and COPY_CODE (coupon) buttons. */
  buttons: { index: number; type: string; text: string; variables: string[] }[];
  /** Why LeadLibre cannot send this template (Spanish, shown to the user), or null. */
  unsupported: string | null;
}

/** Authentication (one-time password) button, as we create it or as Meta lists it (a URL to whatsapp.com/otp). */
function isOtpButton(b: any): boolean {
  return b?.type === 'OTP' || (b?.type === 'URL' && /^https:\/\/(www\.)?whatsapp\.com\/otp\//.test(String(b.url ?? '')));
}

function unsupportedReason(components: any[], header: any, buttons: any[]): string | null {
  const why = (what: string) => `Esta plantilla usa ${what}, que LeadLibre todavía no puede enviar. Elige otra plantilla.`;
  if (components.some((c) => c.type === 'CAROUSEL')) return why('un carrusel de tarjetas');
  if (components.some((c) => c.type === 'LIMITED_TIME_OFFER' && c.limited_time_offer?.has_expiration)) return why('una oferta con vencimiento');
  if (header?.format === 'PRODUCT') return why('un producto del catálogo en el encabezado');
  if (buttons.some((b: any) => b.type === 'MPM' || b.type === 'SPM')) return why('un botón de catálogo de productos');
  return null;
}

/** Describes the inputs a template needs (used by the UI and to validate sends). */
export function templateSchema(components: any[]): TemplateInputs {
  const header = components.find((c) => c.type === 'HEADER');
  const body = components.find((c) => c.type === 'BODY');
  const buttons: any[] = components.find((c) => c.type === 'BUTTONS')?.buttons ?? [];
  // An authentication body is preset by Meta: its only variable is the code (as we store it after
  // creating one, before a sync brings Meta's text, it has no text at all).
  const otp = buttons.some(isOtpButton);
  const bodyVars = orderedVariables(body?.text);
  return {
    header: header
      ? header.format === 'TEXT' || !header.format
        ? { type: 'text' as const, variables: orderedVariables(header.text) }
        : { type: String(header.format).toLowerCase() as 'image' | 'video' | 'document' | 'location', variables: [] }
      : null,
    body: otp && !bodyVars.length ? ['1'] : bodyVars,
    buttons: buttons
      .map((b: any, index: number) => {
        if (isOtpButton(b)) return null; // filled with the code from the body
        if (b.type === 'COPY_CODE') return { index, type: b.type, text: b.text ?? 'Copiar código', variables: ['coupon_code'] };
        return { index, type: b.type, text: b.text, variables: b.type === 'URL' ? variablesIn(b.url) : [] };
      })
      .filter((b): b is TemplateInputs['buttons'][number] => !!b && b.variables.length > 0),
    unsupported: unsupportedReason(components, header, buttons),
  };
}

const MEDIA_NAME: Record<string, string> = { image: 'una imagen', video: 'un video', document: 'un documento' };
const COUPON_MAX = 15;

/**
 * Refuses a send that Meta would reject for a missing parameter: the template's stored components
 * say what it needs (header media or location, variables, URL and coupon buttons). Spanish errors.
 */
export function checkTemplateParams(components: any[], params: TemplateParams | undefined): void {
  if (!components.length) return; // unknown template: Meta decides
  const schema = templateSchema(components);
  if (schema.unsupported) throw badRequest(schema.unsupported, 'TEMPLATE_UNSUPPORTED');
  const p = params ?? {};
  const missing = (what: string) => badRequest(`Falta ${what} para enviar esta plantilla.`, 'TEMPLATE_PARAMS_MISSING');
  const h = schema.header;
  if (h?.type === 'text' && h.variables.length && !(p.header?.type === 'text' && p.header.text.trim())) {
    throw missing('el valor de la variable del encabezado');
  }
  if (h && (h.type === 'image' || h.type === 'video' || h.type === 'document')) {
    if (p.header?.type !== h.type || !(p.header.link?.trim() || p.header.mediaId)) throw missing(`${MEDIA_NAME[h.type]} para el encabezado (enlace https)`);
  }
  if (h?.type === 'location') {
    const loc = p.header?.type === 'location' ? p.header : null;
    if (!loc || !Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude) || Math.abs(loc.latitude) > 90 || Math.abs(loc.longitude) > 180) {
      throw missing('la ubicación del encabezado (latitud y longitud)');
    }
  }
  const named = p.bodyNamed && Object.keys(p.bodyNamed).length ? p.bodyNamed : null;
  for (const [i, v] of schema.body.entries()) {
    const value = named ? named[v] : p.body?.[i];
    if (!value?.trim()) throw missing(`el valor de la variable {{${v}}} del mensaje`);
  }
  for (const b of schema.buttons) {
    const value = p.buttons?.find((x) => x.index === b.index)?.text?.trim();
    if (b.type === 'COPY_CODE') {
      if (!value) throw missing(`el código de cupón del botón "${b.text}"`);
      if (value.length > COUPON_MAX) throw badRequest(`El código de cupón admite máximo ${COUPON_MAX} caracteres.`, 'TEMPLATE_PARAMS_INVALID');
    } else if (!value) {
      throw missing(`el valor del botón "${b.text}"`);
    }
  }
}

/**
 * Converts our TemplateParams into Meta "components" for the send API. With the template's stored
 * components, the params are checked first (checkTemplateParams) and each button gets the kind of
 * parameter its type needs.
 */
export function buildTemplateComponents(params: TemplateParams | undefined, named: boolean, components: any[] = []): any[] {
  checkTemplateParams(components, params);
  const buttons: any[] = components.find((c) => c.type === 'BUTTONS')?.buttons ?? [];
  const otpIndexes = buttons.flatMap((b, i) => (isOtpButton(b) ? [i] : []));
  if (!params && !otpIndexes.length) return [];
  const p = params ?? {};
  const out: any[] = [];
  const schema = templateSchema(components);
  const textParam = (text: string, name?: string) => (named && name ? { type: 'text', parameter_name: name, text } : { type: 'text', text });

  if (p.header) {
    if (p.header.type === 'text') {
      out.push({ type: 'header', parameters: [textParam(p.header.text, schema.header?.variables[0])] });
    } else if (p.header.type === 'location') {
      const { latitude, longitude, name, address } = p.header;
      out.push({ type: 'header', parameters: [{ type: 'location', location: { latitude, longitude, name, address } }] });
    } else {
      const media: Record<string, string> = p.header.mediaId ? { id: p.header.mediaId } : { link: p.header.link ?? '' };
      if (p.header.type === 'document' && p.header.filename) media.filename = p.header.filename;
      out.push({ type: 'header', parameters: [{ type: p.header.type, [p.header.type]: media }] });
    }
  }
  const bodyNamed = p.bodyNamed && Object.keys(p.bodyNamed).length ? p.bodyNamed : null;
  if (bodyNamed) {
    out.push({
      type: 'body',
      parameters: Object.entries(bodyNamed).map(([k, v]) => ({ type: 'text', parameter_name: k, text: v })),
    });
  } else if (p.body?.length) {
    out.push({ type: 'body', parameters: p.body.map((t, i) => textParam(t, schema.body[i])) });
  }
  const given = new Map((p.buttons ?? []).map((b) => [b.index, b]));
  const indexes = [...new Set([...given.keys(), ...otpIndexes])].sort((x, y) => x - y);
  for (const index of indexes) {
    const def = buttons[index];
    const b = given.get(index);
    if (def && isOtpButton(def)) {
      // Meta expects the one-time code twice: as the body variable and as this button's parameter.
      const code = b?.text ?? (bodyNamed ? Object.values(bodyNamed)[0] : p.body?.[0]);
      if (code) out.push({ type: 'button', sub_type: 'url', index: String(index), parameters: [{ type: 'text', text: code }] });
    } else if (!b) {
      continue;
    } else if (def?.type === 'COPY_CODE' || (!def && b.sub_type === 'copy_code')) {
      out.push({ type: 'button', sub_type: 'copy_code', index: String(index), parameters: [{ type: 'coupon_code', coupon_code: b.text }] });
    } else if (!def || (def.type === 'URL' && variablesIn(def.url).length)) {
      out.push({ type: 'button', sub_type: 'url', index: String(index), parameters: [{ type: 'text', text: b.text }] });
    }
    // Other buttons (quick replies, phone numbers) take no parameter: a value sent for them is ignored.
  }
  return out;
}

function fill(text: string, values: string[] | Record<string, string> | undefined): string {
  let i = 0;
  return text.replace(VAR_RE, (whole, key) => {
    if (!values) return whole;
    if (Array.isArray(values)) {
      const idx = /^\d+$/.test(key) ? Number(key) - 1 : i;
      i++;
      return values[idx] ?? whole;
    }
    return values[key] ?? whole;
  });
}

/** Text shown in the chat for a sent template (header, body, footer and buttons). */
export function renderTemplateText(components: any[], params: TemplateParams | undefined): string {
  const parts: string[] = [];
  const header = components.find((c) => c.type === 'HEADER');
  if (header?.text) {
    const hv = params?.header?.type === 'text' ? [params.header.text] : undefined;
    parts.push(`*${fill(header.text, hv)}*`);
  }
  const body = components.find((c) => c.type === 'BODY');
  if (body?.text) parts.push(fill(body.text, params?.bodyNamed && Object.keys(params.bodyNamed).length ? params.bodyNamed : params?.body));
  else if (body && 'add_security_recommendation' in body) {
    // Authentication template as we created it: Meta writes the text in the template's language.
    const code = params?.body?.[0] ?? '{{1}}';
    parts.push(`*${code}* es tu código de verificación.${body.add_security_recommendation ? ' Por tu seguridad, no lo compartas.' : ''}`);
  }
  const footer = components.find((c) => c.type === 'FOOTER');
  if (footer?.text) parts.push(`_${footer.text}_`);
  else if (footer?.code_expiration_minutes) parts.push(`_Este código caduca en ${footer.code_expiration_minutes} minutos._`);
  const buttons = components.find((c) => c.type === 'BUTTONS')?.buttons ?? [];
  if (buttons.length) parts.push(buttons.map((b: any) => `[${b.text ?? 'Copiar código'}]`).join(' '));
  return parts.join('\n\n');
}

export async function findTemplate(q: Queryable, channelId: string, name: string, language: string): Promise<TemplateRow | null> {
  const { rows } = await q.query<TemplateRow>(`SELECT * FROM templates WHERE channel_id = $1 AND name = $2 AND language = $3`, [
    channelId,
    name,
    language,
  ]);
  return rows[0] ?? null;
}

export async function upsertTemplate(
  q: Queryable,
  channel: ChannelRow,
  t: { meta_id: string | null; name: string; language: string; category: string; status: string; components: any[]; parameter_format?: string | null; rejected_reason?: string | null },
) {
  const { rows } = await q.query<TemplateRow>(
    `INSERT INTO templates (workspace_id, channel_id, meta_id, name, language, category, status, components, parameter_format, rejected_reason, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (channel_id, name, language) DO UPDATE SET meta_id = EXCLUDED.meta_id, category = EXCLUDED.category,
       status = EXCLUDED.status, components = EXCLUDED.components, parameter_format = EXCLUDED.parameter_format,
       rejected_reason = EXCLUDED.rejected_reason, updated_at = now()
     RETURNING *`,
    [
      channel.workspace_id,
      channel.id,
      t.meta_id,
      t.name,
      t.language,
      t.category.toLowerCase(),
      t.status.toUpperCase(),
      JSON.stringify(t.components ?? []),
      t.parameter_format ?? null,
      t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null,
    ],
  );
  return rows[0];
}

export async function syncTemplates(ctx: AppContext, channel: ChannelRow): Promise<number> {
  const remote = await providerFor(ctx, channel).listTemplates();
  await ctx.db.tx(async (q) => {
    // Channel first, as DELETE /api/channels locks it before cascading to its templates: an insert's
    // foreign-key check after an upsert locked an existing template would deadlock with that delete.
    const live = await q.query(`SELECT 1 FROM channels WHERE id = $1 FOR KEY SHARE`, [channel.id]);
    if (!live.rows[0]) throw notFound('Canal');
    for (const t of remote) {
      await upsertTemplate(q, channel, { ...t, meta_id: t.id });
    }
    // What was just read is Meta's current state: the next status or category event applies,
    // whatever time earlier events left (a business that signed its own webhooks could date them
    // ahead and pin a category Meta changes later).
    await q.query(
      `UPDATE templates SET status_event_at = NULL, category_event_at = NULL
       WHERE channel_id = $1 AND (status_event_at IS NOT NULL OR category_event_at IS NOT NULL)`,
      [channel.id],
    );
    if (channel.provider === 'cloud_api') {
      const keep = remote.map((t) => `${t.name}|${t.language}`);
      await q.query(`DELETE FROM templates WHERE channel_id = $1 AND NOT ((name || '|' || language) = ANY($2::text[]))`, [channel.id, keep]);
    }
  });
  return remote.length;
}

export async function createTemplate(ctx: AppContext, channel: ChannelRow, input: CreateTemplateInput): Promise<TemplateRow> {
  const r = await providerFor(ctx, channel).createTemplate(input);
  return upsertTemplate(ctx.db, channel, {
    meta_id: r.id,
    name: input.name,
    language: input.language,
    category: r.category ?? input.category,
    status: r.status ?? 'PENDING',
    components: input.components,
    parameter_format: input.parameter_format ?? null,
  });
}
