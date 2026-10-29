import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { assertWhatsAppMedia, getMedia, mediaAbsPath, saveMedia } from '../services/media.js';
import { dayStart, localDay, overviewReport, workspaceTimezone } from '../services/reports.js';
import { ADMIN_ROLES, agentRestricted, parse, requireWs, uuid } from './helpers.js';

const INLINE_SAFE = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/3gpp',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/amr',
  'audio/opus',
]);

// Names some browsers give to types WhatsApp knows under its canonical name (sent to Meta as is).
const MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/x-aac': 'audio/aac',
};

const calendarDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Usa fechas AAAA-MM-DD')
  .refine((d) => {
    const t = Date.parse(`${d}T00:00:00Z`);
    return !Number.isNaN(t) && new Date(t).toISOString().startsWith(d);
  }, 'Fecha inválida');

/** Créditos, reportes y archivos. */
export async function miscRoutes(app: FastifyInstance, ctx: AppContext) {
  // ---- Credits ----
  app.get('/api/credits', async (req) => {
    const a = await requireWs(ctx, req);
    // "This month" is the calendar month of the workspace's time zone.
    const tz = await workspaceTimezone(ctx, a.workspaceId);
    const month = dayStart(`${localDay(tz).slice(0, 8)}01`, tz);
    const { rows } = await ctx.db.query<Record<string, unknown>>(
      `SELECT w.billing_mode, w.credit_balance::float AS balance,
         COALESCE((SELECT -sum(amount) FROM credit_ledger l WHERE l.workspace_id = w.id AND l.kind IN ('charge', 'refund')
           AND l.created_at >= $2), 0)::float AS spent_this_month,
         COALESCE((SELECT -sum(amount) FROM credit_ledger l WHERE l.workspace_id = w.id AND l.kind IN ('charge', 'refund')), 0)::float AS spent_total,
         COALESCE((SELECT count(*) FROM messages m WHERE m.workspace_id = w.id AND m.cost > 0 AND m.created_at >= $2), 0)::int AS billable_messages_this_month
       FROM workspaces w WHERE w.id = $1`,
      [a.workspaceId, month],
    );
    const byCategory = await ctx.db.query(
      `SELECT billing_category AS category, count(*)::int AS messages, COALESCE(sum(cost), 0)::float AS cost
       FROM messages WHERE workspace_id = $1 AND cost > 0 AND created_at >= $2
       GROUP BY billing_category ORDER BY cost DESC`,
      [a.workspaceId, month],
    );
    return { ...rows[0], by_category: byCategory.rows };
  });

  app.get('/api/credits/ledger', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const q = parse(z.object({ page: z.coerce.number().int().min(1).default(1) }), req.query);
    const { rows } = await ctx.db.query(
      `SELECT l.*, u.name AS created_by_name, c.name AS contact_name, c.phone AS contact_phone, b.name AS broadcast_name
       FROM credit_ledger l LEFT JOIN users u ON u.id = l.created_by
       LEFT JOIN messages m ON m.id = l.message_id LEFT JOIN contacts c ON c.id = m.contact_id
       LEFT JOIN broadcasts b ON b.id = l.broadcast_id
       WHERE l.workspace_id = $1 ORDER BY l.created_at DESC LIMIT 100 OFFSET $2`,
      [a.workspaceId, (q.page - 1) * 100],
    );
    return { entries: rows };
  });

  app.get('/api/credits/rates', async (req) => {
    await requireWs(ctx, req);
    const { rows } = await ctx.db.query(`SELECT market, category, price::float AS price, updated_at FROM rate_card ORDER BY market, category`);
    return { rates: rows };
  });

  // ---- Reports ----
  app.get('/api/reports/overview', async (req) => {
    const a = await requireWs(ctx, req);
    // Calendar days (both included) of the workspace's time zone.
    const q = parse(z.object({ from: calendarDay.optional(), to: calendarDay.optional() }), req.query);
    const tz = await workspaceTimezone(ctx, a.workspaceId);
    const to = q.to ?? localDay(tz);
    const dayMs = 24 * 3600 * 1000;
    const from = q.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * dayMs).toISOString().slice(0, 10);
    const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / dayMs + 1;
    if (span < 1) throw badRequest('Rango de fechas inválido');
    if (span > 400) throw badRequest('El rango máximo es de 400 días');
    return overviewReport(ctx, a.workspaceId, from, to, tz);
  });

  // ---- Media ----
  app.post('/api/media', async (req) => {
    const a = await requireWs(ctx, req);
    const file = await req.file({ limits: { fileSize: ctx.config.maxUploadMb * 1024 * 1024 } });
    if (!file) throw badRequest('Adjunta un archivo');
    const declared = file.mimetype.split(';')[0].trim().toLowerCase();
    const mime = MIME_ALIASES[declared] ?? declared;
    // Same allow-list and per-type limits as the Cloud API /media endpoint, so an accepted upload can be sent.
    assertWhatsAppMedia(mime, 0);
    const tooLarge = () => badRequest(`El archivo supera ${ctx.config.maxUploadMb} MB`, 'MEDIA_TOO_LARGE');
    // @fastify/multipart throws its own (English) error once the size limit is hit.
    const data = await file.toBuffer().catch((err) => {
      throw (err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE' ? tooLarge() : err;
    });
    if (file.file.truncated) throw tooLarge();
    assertWhatsAppMedia(mime, data.length, data, true);
    const saved = await saveMedia(ctx, a.workspaceId, data, mime, file.filename || null);
    return { media: { id: saved.id, mime: saved.mime, size: saved.size, filename: saved.filename } };
  });

  app.get('/api/media/:id', async (req, reply) => {
    const a = await requireWs(ctx, req).catch(async (err) => {
      // <img>/<audio> tags cannot send headers: accept ?ws= for the workspace id.
      const ws = (req.query as Record<string, string>).ws;
      if (!ws) throw err;
      req.headers['x-workspace-id'] = ws;
      return requireWs(ctx, req);
    });
    const { id } = parse(z.object({ id: uuid }), req.params);
    const file = await getMedia(ctx, a.workspaceId, id);
    if (await agentRestricted(ctx, a)) {
      // Files of conversations assigned to someone else stay hidden too.
      const { rows } = await ctx.db.query(
        `SELECT 1 FROM messages m JOIN contacts c ON c.id = m.contact_id
         WHERE m.media_file_id = $1 AND c.assigned_user_id IS NOT NULL AND c.assigned_user_id <> $2
           AND NOT EXISTS (SELECT 1 FROM messages m2 JOIN contacts c2 ON c2.id = m2.contact_id
                           WHERE m2.media_file_id = $1 AND (c2.assigned_user_id IS NULL OR c2.assigned_user_id = $2))
         LIMIT 1`,
        [id, a.user.id],
      );
      if (rows[0]) throw forbidden('Este archivo pertenece a una conversación asignada a otra persona');
    }
    const abs = mediaAbsPath(ctx, file);
    const stat = await fs.promises.stat(abs).catch(() => null);
    if (!stat?.isFile()) throw badRequest('El archivo ya no existe en el servidor');
    // Files may come from anyone on WhatsApp: only well-known media types are rendered
    // by the browser; everything else (SVG, HTML…) is downloaded, never executed.
    const inline = INLINE_SAFE.has(file.mime);
    reply.header('Content-Type', inline ? file.mime : 'application/octet-stream');
    reply.header('Cache-Control', 'private, max-age=86400');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; sandbox");
    const safeName = (file.filename ?? 'archivo').replace(/[^\w.\- ]+/g, '_');
    reply.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`);
    // Byte ranges: Safari and iOS only play <video>/<audio> from servers that answer them (206), and
    // every browser needs them to seek. A file never changes under its id, so If-Range always holds.
    reply.header('Accept-Ranges', 'bytes');
    const range = byteRange(req.headers.range, stat.size);
    if (range === 'unsatisfiable') {
      reply.header('Content-Range', `bytes */${stat.size}`);
      return reply.code(416).send();
    }
    if (range) {
      reply.code(206);
      reply.header('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
      reply.header('Content-Length', range.end - range.start + 1);
      return reply.send(fs.createReadStream(abs, range));
    }
    reply.header('Content-Length', stat.size);
    return reply.send(fs.createReadStream(abs));
  });
}

/**
 * A single "bytes=" range of a file of `size` bytes (RFC 9110 14.1.2): first-last, first- or -suffix.
 * null = serve the whole file (no header, an unknown unit, several ranges or a malformed one).
 */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (m[2] && Number(m[2]) < start) return null;
  }
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}
