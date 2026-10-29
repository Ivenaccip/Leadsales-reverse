import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest } from '../lib/errors.js';
import {
  broadcastStats,
  CHANNEL_GONE,
  checkBroadcastParams,
  estimateAudience,
  getBroadcast,
  launchBroadcast,
  type BroadcastRow,
} from '../services/broadcasts.js';
import { abandonAutoRetry } from '../services/messages.js';
import { findTemplate } from '../services/templates.js';
import { getChannel } from '../whatsapp/provider.js';
import { ADMIN_ROLES, noContent, parse, requireWs, uuid } from './helpers.js';

// "Creados desde/hasta": calendar days of the workspace's time zone (see audienceWhere).
const calendarDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Usa fechas AAAA-MM-DD')
  .refine((d) => {
    const t = Date.parse(`${d}T00:00:00Z`);
    return !Number.isNaN(t) && new Date(t).toISOString().startsWith(d);
  }, 'Fecha inválida');

const audienceSchema = z.object({
  funnel_id: uuid.nullable().optional(),
  stage_ids: z.array(uuid).optional(),
  tag_ids: z.array(uuid).optional(),
  exclude_tag_ids: z.array(uuid).optional(),
  assigned_user_id: uuid.nullable().optional(),
  created_from: calendarDay.nullable().optional(),
  created_to: calendarDay.nullable().optional(),
  contact_ids: z.array(uuid).max(50_000).optional(),
});

const paramsSchema = z.object({
  header: z
    .union([
      z.object({ type: z.literal('text'), value: z.string().min(1).max(200) }),
      z.object({ type: z.enum(['image', 'video', 'document']), link: z.string().url(), filename: z.string().optional() }),
      z.object({
        type: z.literal('location'),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        name: z.string().trim().max(1000).optional(),
        address: z.string().trim().max(1000).optional(),
      }),
    ])
    .optional(),
  body: z.array(z.string().min(1).max(1024)).max(30).optional(),
  bodyNamed: z
    .record(z.string().min(1).max(100), z.string().min(1).max(1024))
    .refine((r) => Object.keys(r).length <= 30, 'Una plantilla admite como máximo 30 variables')
    .optional(),
  buttons: z
    .array(z.object({ index: z.number().int().min(0).max(9), value: z.string().min(1).max(200), sub_type: z.enum(['url', 'copy_code']).optional() }))
    .max(10)
    .optional(),
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  channel_id: uuid.optional(),
  template_name: z.string().min(1),
  template_language: z.string().min(2),
  params: paramsSchema.default({}),
  audience: audienceSchema.default({}),
  scheduled_at: z.string().datetime({ offset: true }).nullable().optional(),
});

// .partial() keeps .default({}): a PATCH that omits params/audience would reset them to {}
// (an empty audience means every contact).
const patchSchema = createSchema.extend({ params: paramsSchema.optional(), audience: audienceSchema.optional() }).partial();

async function withStats(ctx: AppContext, b: BroadcastRow) {
  return { ...b, stats: await broadcastStats(ctx.db, b.id) };
}

export async function broadcastRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/broadcasts', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { rows } = await ctx.db.query<BroadcastRow>(
      `SELECT * FROM broadcasts WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [a.workspaceId],
    );
    return { broadcasts: await Promise.all(rows.map((b) => withStats(ctx, b))) };
  });

  app.post('/api/broadcasts/estimate', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const body = parse(
      z.object({ channel_id: uuid.optional(), template_name: z.string().min(1), template_language: z.string().min(2), audience: audienceSchema.default({}) }),
      req.body,
    );
    const channel = await getChannel(ctx.db, a.workspaceId, body.channel_id);
    const tpl = await findTemplate(ctx.db, channel.id, body.template_name, body.template_language);
    return { estimate: await estimateAudience(ctx, a.workspaceId, body.audience, tpl?.category ?? 'marketing') };
  });

  app.post('/api/broadcasts', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const body = parse(createSchema, req.body);
    const channel = await getChannel(ctx.db, a.workspaceId, body.channel_id);
    const tpl = await findTemplate(ctx.db, channel.id, body.template_name, body.template_language);
    if (!tpl) throw badRequest('Esa plantilla no existe en el canal elegido');
    checkBroadcastParams(tpl.components, body.params);
    // Drafts show this estimate in the list and detail; launch recomputes it before charging.
    const est = await estimateAudience(ctx, a.workspaceId, body.audience, tpl.category);
    const { rows } = await ctx.db.query<BroadcastRow>(
      `INSERT INTO broadcasts (workspace_id, channel_id, name, template_name, template_language, template_category, params, audience, scheduled_at,
         created_by, total_recipients, estimated_cost)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [
        a.workspaceId,
        channel.id,
        body.name,
        body.template_name,
        body.template_language,
        tpl.category,
        JSON.stringify(body.params),
        JSON.stringify(body.audience),
        body.scheduled_at ?? null,
        a.user.id,
        est.recipients,
        est.cost,
      ],
    );
    return { broadcast: await withStats(ctx, rows[0]) };
  });

  app.get('/api/broadcasts/:id', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    return { broadcast: await withStats(ctx, await getBroadcast(ctx.db, a.workspaceId, id)) };
  });

  app.patch('/api/broadcasts/:id', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(patchSchema, req.body);
    const b = await getBroadcast(ctx.db, a.workspaceId, id);
    // A paused broadcast can be fixed and resumed (e.g. a template sync added a variable and it paused
    // with TEMPLATE_PARAMS_MISSING). Its recipients were chosen at launch, so its audience is fixed.
    if (b.status !== 'draft' && b.status !== 'paused') throw badRequest('Solo puedes editar difusiones en borrador o en pausa');
    if (b.status !== 'draft' && body.audience) {
      throw badRequest('La audiencia de una difusión ya lanzada no se puede cambiar', 'AUDIENCE_LOCKED');
    }
    // Its number was deleted: another one is chosen on purpose, never the workspace's default.
    if (!b.channel_id && !body.channel_id) throw badRequest(CHANNEL_GONE, 'NO_CHANNEL');
    // Resolve the channel inside this workspace (a foreign or unknown id is a 400, never stored)
    // and check the template exists there, like POST does.
    const channel = await getChannel(ctx.db, a.workspaceId, body.channel_id ?? b.channel_id);
    const tpl = await findTemplate(ctx.db, channel.id, body.template_name ?? b.template_name, body.template_language ?? b.template_language);
    if (!tpl) throw badRequest('Esa plantilla no existe en el canal elegido');
    // The stored params must fit a newly chosen template (or channel) too; a rename alone checks nothing.
    if (body.template_name || body.template_language || body.channel_id || body.params) checkBroadcastParams(tpl.components, body.params ?? b.params);
    // Only a draft's audience is still an estimate; a launched broadcast keeps its recipients and totals.
    const est = b.status === 'draft' ? await estimateAudience(ctx, a.workspaceId, body.audience ?? b.audience, tpl.category) : null;
    const { rows } = await ctx.db.query<BroadcastRow>(
      `UPDATE broadcasts SET name = COALESCE($2, name), template_name = COALESCE($3, template_name), template_language = COALESCE($4, template_language),
         params = COALESCE($5, params), audience = COALESCE($6, audience), scheduled_at = CASE WHEN $7 THEN $8::timestamptz ELSE scheduled_at END,
         channel_id = $9, template_category = $10, total_recipients = COALESCE($11, total_recipients), estimated_cost = COALESCE($12, estimated_cost)
       WHERE id = $1 AND status = $13 RETURNING *`,
      [
        id,
        body.name ?? null,
        body.template_name ?? null,
        body.template_language ?? null,
        body.params ? JSON.stringify(body.params) : null,
        body.audience ? JSON.stringify(body.audience) : null,
        body.scheduled_at !== undefined,
        body.scheduled_at ?? null,
        channel.id,
        tpl.category,
        est?.recipients ?? null,
        est?.cost ?? null,
        b.status,
      ],
    );
    if (!rows[0]) throw badRequest('La difusión cambió de estado mientras la editabas. Recarga la página.', 'BROADCAST_CHANGED');
    return { broadcast: await withStats(ctx, rows[0]) };
  });

  app.post('/api/broadcasts/:id/launch', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    return { broadcast: await withStats(ctx, await launchBroadcast(ctx, a.workspaceId, id)) };
  });

  app.post('/api/broadcasts/:id/pause', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    await ctx.db.query(`UPDATE broadcasts SET status = 'paused' WHERE id = $1 AND workspace_id = $2 AND status IN ('running', 'scheduled')`, [
      id,
      a.workspaceId,
    ]);
    return { broadcast: await withStats(ctx, await getBroadcast(ctx.db, a.workspaceId, id)) };
  });

  app.post('/api/broadcasts/:id/cancel', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    await getBroadcast(ctx.db, a.workspaceId, id);
    await ctx.db.tx(async (q) => {
      const r = await q.query(
        `UPDATE broadcasts SET status = 'cancelled', finished_at = now() WHERE id = $1 AND workspace_id = $2 AND status IN ('draft', 'running', 'scheduled', 'paused')
         RETURNING id`,
        [id, a.workspaceId],
      );
      if (r.rows[0]) await q.query(`UPDATE broadcast_recipients SET status = 'skipped' WHERE broadcast_id = $1 AND status = 'queued'`, [id]);
    });
    // Messages that were waiting for an automatic retry (throttle, network) will not get it now.
    await abandonAutoRetry(ctx, { broadcastId: id });
    return { broadcast: await withStats(ctx, await getBroadcast(ctx.db, a.workspaceId, id)) };
  });

  app.get('/api/broadcasts/:id/recipients', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const q = parse(z.object({ page: z.coerce.number().int().min(1).default(1), status: z.string().optional() }), req.query);
    await getBroadcast(ctx.db, a.workspaceId, id);
    const { rows } = await ctx.db.query(
      `SELECT br.*, c.name, c.phone, m.status AS message_status, m.error AS message_error, m.cost
       FROM broadcast_recipients br JOIN contacts c ON c.id = br.contact_id LEFT JOIN messages m ON m.id = br.message_id
       WHERE br.broadcast_id = $1 AND ($2::text IS NULL OR br.status = $2 OR m.status = $2)
       ORDER BY br.processed_at DESC NULLS LAST, c.name LIMIT 100 OFFSET $3`,
      [id, q.status ?? null, (q.page - 1) * 100],
    );
    return { recipients: rows };
  });

  app.delete('/api/broadcasts/:id', async (req, reply) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = await getBroadcast(ctx.db, a.workspaceId, id);
    if (['running', 'scheduled'].includes(b.status)) throw badRequest('Pausa o cancela la difusión antes de eliminarla');
    // Its messages stay in the chats: those waiting for an automatic retry will not get it now.
    await abandonAutoRetry(ctx, { broadcastId: id });
    await ctx.db.query(`DELETE FROM broadcasts WHERE id = $1`, [id]);
    return noContent(reply);
  });
}
