import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest } from '../lib/errors.js';
import { getMedia, mediaAbsPath, saveMedia } from '../services/media.js';
import { overviewReport } from '../services/reports.js';
import { parse, requireWs, uuid } from './helpers.js';

const ALLOWED_MIME = /^(image\/(jpeg|png|webp)|video\/(mp4|3gpp)|audio\/(ogg|mpeg|mp4|aac|amr|opus)|application\/(pdf|msword|vnd\.[\w.-]+|zip)|text\/(plain|csv))$/;

/** Créditos, reportes y archivos. */
export async function miscRoutes(app: FastifyInstance, ctx: AppContext) {
  // ---- Credits ----
  app.get('/api/credits', async (req) => {
    const a = await requireWs(ctx, req);
    const { rows } = await ctx.db.query<Record<string, unknown>>(
      `SELECT w.billing_mode, w.credit_balance::float AS balance,
         COALESCE((SELECT -sum(amount) FROM credit_ledger l WHERE l.workspace_id = w.id AND l.kind IN ('charge', 'refund')
           AND l.created_at >= date_trunc('month', now())), 0)::float AS spent_this_month,
         COALESCE((SELECT -sum(amount) FROM credit_ledger l WHERE l.workspace_id = w.id AND l.kind IN ('charge', 'refund')), 0)::float AS spent_total,
         COALESCE((SELECT count(*) FROM messages m WHERE m.workspace_id = w.id AND m.cost > 0 AND m.created_at >= date_trunc('month', now())), 0)::int AS billable_messages_this_month
       FROM workspaces w WHERE w.id = $1`,
      [a.workspaceId],
    );
    const byCategory = await ctx.db.query(
      `SELECT billing_category AS category, count(*)::int AS messages, COALESCE(sum(cost), 0)::float AS cost
       FROM messages WHERE workspace_id = $1 AND cost > 0 AND created_at >= date_trunc('month', now())
       GROUP BY billing_category ORDER BY cost DESC`,
      [a.workspaceId],
    );
    return { ...rows[0], by_category: byCategory.rows };
  });

  app.get('/api/credits/ledger', async (req) => {
    const a = await requireWs(ctx, req);
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
    const q = parse(z.object({ from: z.string().optional(), to: z.string().optional() }), req.query);
    const to = q.to ? new Date(new Date(q.to).getTime() + 24 * 3600 * 1000) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 24 * 3600 * 1000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw badRequest('Rango de fechas inválido');
    if (to.getTime() - from.getTime() > 400 * 24 * 3600 * 1000) throw badRequest('El rango máximo es de 400 días');
    return overviewReport(ctx, a.workspaceId, from, to);
  });

  // ---- Media ----
  app.post('/api/media', async (req) => {
    const a = await requireWs(ctx, req);
    const file = await req.file({ limits: { fileSize: ctx.config.maxUploadMb * 1024 * 1024 } });
    if (!file) throw badRequest('Adjunta un archivo');
    const mime = file.mimetype.split(';')[0].trim();
    if (!ALLOWED_MIME.test(mime)) throw badRequest(`Tipo de archivo no soportado por WhatsApp: ${mime}`);
    const data = await file.toBuffer();
    if (file.file.truncated) throw badRequest(`El archivo supera ${ctx.config.maxUploadMb} MB`);
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
    const abs = mediaAbsPath(ctx, file);
    if (!fs.existsSync(abs)) throw badRequest('El archivo ya no existe en el servidor');
    reply.header('Content-Type', file.mime);
    reply.header('Cache-Control', 'private, max-age=86400');
    reply.header('X-Content-Type-Options', 'nosniff');
    const safeName = (file.filename ?? 'archivo').replace(/[^\w.\- ]+/g, '_');
    const inline = /^(image|video|audio)\//.test(file.mime) || file.mime === 'application/pdf';
    reply.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`);
    return reply.send(fs.createReadStream(abs));
  });
}
