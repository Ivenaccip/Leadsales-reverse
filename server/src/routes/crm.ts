import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../lib/errors.js';
import { ADMIN_ROLES, noContent, parse, requireWs, uuid } from './helpers.js';

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color inválido (usa #RRGGBB)');
const stageInput = z.object({ name: z.string().trim().min(1).max(60), color: color.optional(), kind: z.enum(['open', 'won', 'lost']).optional() });

async function ownFunnel(ctx: AppContext, workspaceId: string, id: string) {
  const { rows } = await ctx.db.query(`SELECT * FROM funnels WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]);
  if (!rows[0]) throw notFound('Embudo');
  return rows[0];
}

export async function listFunnels(ctx: AppContext, workspaceId: string) {
  const { rows } = await ctx.db.query(
    `SELECT f.*, COALESCE((SELECT json_agg(s ORDER BY s.position) FROM (
        SELECT st.*, (SELECT count(*)::int FROM contacts c WHERE c.stage_id = st.id AND NOT c.is_archived) AS contact_count
        FROM stages st WHERE st.funnel_id = f.id) s), '[]'::json) AS stages
     FROM funnels f WHERE f.workspace_id = $1 ORDER BY f.position, f.created_at`,
    [workspaceId],
  );
  return rows;
}

/** Embudos, etapas, etiquetas y respuestas rápidas. */
export async function crmRoutes(app: FastifyInstance, ctx: AppContext) {
  // ---- Funnels ----
  app.get('/api/funnels', async (req) => {
    const a = await requireWs(ctx, req);
    return { funnels: await listFunnels(ctx, a.workspaceId) };
  });

  app.post('/api/funnels', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(60),
        stages: z.array(stageInput).max(30).optional(),
        auto_assign: z.boolean().optional(),
        assignee_ids: z.array(uuid).optional(),
      }),
      req.body,
    );
    const stages = body.stages?.length
      ? body.stages
      : [
          { name: 'Nuevo', color: '#3b82f6', kind: 'open' as const },
          { name: 'En proceso', color: '#f59e0b', kind: 'open' as const },
          { name: 'Ganado', color: '#22c55e', kind: 'won' as const },
          { name: 'Perdido', color: '#ef4444', kind: 'lost' as const },
        ];
    const id = await ctx.db.tx(async (q) => {
      const pos = await q.query<{ p: number }>(`SELECT COALESCE(max(position), -1)::int + 1 AS p FROM funnels WHERE workspace_id = $1`, [a.workspaceId]);
      const f = await q.query<{ id: string }>(
        `INSERT INTO funnels (workspace_id, name, position, auto_assign, assignee_ids) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [a.workspaceId, body.name, pos.rows[0].p, body.auto_assign ?? false, body.assignee_ids ?? []],
      );
      for (const [i, s] of stages.entries()) {
        await q.query(`INSERT INTO stages (workspace_id, funnel_id, name, color, kind, position) VALUES ($1, $2, $3, $4, $5, $6)`, [
          a.workspaceId,
          f.rows[0].id,
          s.name,
          s.color ?? '#64748b',
          s.kind ?? 'open',
          i,
        ]);
      }
      return f.rows[0].id;
    });
    return { id, funnels: await listFunnels(ctx, a.workspaceId) };
  });

  app.patch('/api/funnels/:id', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(60).optional(),
        auto_assign: z.boolean().optional(),
        assignee_ids: z.array(uuid).optional(),
        is_default: z.literal(true).optional(),
        position: z.number().int().min(0).optional(),
      }),
      req.body,
    );
    await ownFunnel(ctx, a.workspaceId, id);
    if (body.is_default) await ctx.db.query(`UPDATE funnels SET is_default = false WHERE workspace_id = $1`, [a.workspaceId]);
    await ctx.db.query(
      `UPDATE funnels SET name = COALESCE($2, name), auto_assign = COALESCE($3, auto_assign), assignee_ids = COALESCE($4, assignee_ids),
         is_default = COALESCE($5, is_default), position = COALESCE($6, position) WHERE id = $1`,
      [id, body.name ?? null, body.auto_assign ?? null, body.assignee_ids ?? null, body.is_default ?? null, body.position ?? null],
    );
    return { funnels: await listFunnels(ctx, a.workspaceId) };
  });

  app.delete('/api/funnels/:id', async (req, reply) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const funnel = await ownFunnel(ctx, a.workspaceId, id);
    const other = await ctx.db.query<{ id: string }>(
      `SELECT f.id FROM funnels f WHERE f.workspace_id = $1 AND f.id <> $2 ORDER BY f.is_default DESC, f.position LIMIT 1`,
      [a.workspaceId, id],
    );
    if (!other.rows[0]) throw badRequest('No puedes eliminar el único embudo');
    await ctx.db.tx(async (q) => {
      const target = await q.query<{ id: string }>(`SELECT id FROM stages WHERE funnel_id = $1 ORDER BY position LIMIT 1`, [other.rows[0].id]);
      await q.query(`UPDATE contacts SET funnel_id = $2, stage_id = $3 WHERE funnel_id = $1`, [id, other.rows[0].id, target.rows[0]?.id ?? null]);
      await q.query(`DELETE FROM funnels WHERE id = $1`, [id]);
      if (funnel.is_default) await q.query(`UPDATE funnels SET is_default = true WHERE id = $1`, [other.rows[0].id]);
    });
    return noContent(reply);
  });

  app.post('/api/funnels/:id/stages', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(stageInput, req.body);
    await ownFunnel(ctx, a.workspaceId, id);
    const { rows } = await ctx.db.query(
      `INSERT INTO stages (workspace_id, funnel_id, name, color, kind, position)
       VALUES ($1, $2, $3, $4, $5, (SELECT COALESCE(max(position), -1) + 1 FROM stages WHERE funnel_id = $2)) RETURNING *`,
      [a.workspaceId, id, body.name, body.color ?? '#64748b', body.kind ?? 'open'],
    );
    return { stage: rows[0] };
  });

  app.put('/api/funnels/:id/stages/order', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ stage_ids: z.array(uuid).min(1) }), req.body);
    await ownFunnel(ctx, a.workspaceId, id);
    await ctx.db.tx(async (q) => {
      for (const [i, sid] of body.stage_ids.entries()) {
        await q.query(`UPDATE stages SET position = $3 WHERE id = $1 AND funnel_id = $2`, [sid, id, i]);
      }
    });
    return { funnels: await listFunnels(ctx, a.workspaceId) };
  });

  app.patch('/api/stages/:id', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(stageInput.partial(), req.body);
    const { rows } = await ctx.db.query(
      `UPDATE stages SET name = COALESCE($3, name), color = COALESCE($4, color), kind = COALESCE($5, kind)
       WHERE id = $1 AND workspace_id = $2 RETURNING *`,
      [id, a.workspaceId, body.name ?? null, body.color ?? null, body.kind ?? null],
    );
    if (!rows[0]) throw notFound('Etapa');
    return { stage: rows[0] };
  });

  app.delete('/api/stages/:id', async (req, reply) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const st = await ctx.db.query<{ funnel_id: string }>(`SELECT funnel_id FROM stages WHERE id = $1 AND workspace_id = $2`, [id, a.workspaceId]);
    if (!st.rows[0]) throw notFound('Etapa');
    const other = await ctx.db.query<{ id: string }>(`SELECT id FROM stages WHERE funnel_id = $1 AND id <> $2 ORDER BY position LIMIT 1`, [
      st.rows[0].funnel_id,
      id,
    ]);
    if (!other.rows[0]) throw badRequest('Un embudo necesita al menos una etapa');
    await ctx.db.tx(async (q) => {
      await q.query(`UPDATE contacts SET stage_id = $2 WHERE stage_id = $1`, [id, other.rows[0].id]);
      await q.query(`DELETE FROM stages WHERE id = $1`, [id]);
    });
    return noContent(reply);
  });

  // ---- Tags ----
  app.get('/api/tags', async (req) => {
    const a = await requireWs(ctx, req);
    const { rows } = await ctx.db.query(
      `SELECT t.*, (SELECT count(*)::int FROM contact_tags ct WHERE ct.tag_id = t.id) AS contact_count
       FROM tags t WHERE t.workspace_id = $1 ORDER BY t.name`,
      [a.workspaceId],
    );
    return { tags: rows };
  });

  app.post('/api/tags', async (req) => {
    const a = await requireWs(ctx, req);
    const body = parse(z.object({ name: z.string().trim().min(1).max(40), color: color.optional() }), req.body);
    const { rows } = await ctx.db.query(
      `INSERT INTO tags (workspace_id, name, color) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, name) DO UPDATE SET color = COALESCE($4, tags.color) RETURNING *`,
      [a.workspaceId, body.name, body.color ?? '#0ea5e9', body.color ?? null],
    );
    return { tag: rows[0] };
  });

  app.patch('/api/tags/:id', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ name: z.string().trim().min(1).max(40).optional(), color: color.optional() }), req.body);
    const { rows } = await ctx.db.query(
      `UPDATE tags SET name = COALESCE($3, name), color = COALESCE($4, color) WHERE id = $1 AND workspace_id = $2 RETURNING *`,
      [id, a.workspaceId, body.name ?? null, body.color ?? null],
    );
    if (!rows[0]) throw notFound('Etiqueta');
    return { tag: rows[0] };
  });

  app.delete('/api/tags/:id', async (req, reply) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    await ctx.db.query(`DELETE FROM tags WHERE id = $1 AND workspace_id = $2`, [id, a.workspaceId]);
    return noContent(reply);
  });

  // ---- Quick replies ----
  const qrSchema = z.object({
    shortcut: z
      .string()
      .trim()
      .min(1)
      .max(30)
      .regex(/^[a-z0-9_-]+$/i, 'El atajo solo admite letras, números, - y _'),
    title: z.string().trim().max(80).nullable().optional(),
    body: z.string().trim().min(1).max(4096),
    media_file_id: uuid.nullable().optional(),
  });

  app.get('/api/quick-replies', async (req) => {
    const a = await requireWs(ctx, req);
    const { rows } = await ctx.db.query(
      `SELECT q.*, mf.mime AS media_mime, mf.filename AS media_filename FROM quick_replies q
       LEFT JOIN media_files mf ON mf.id = q.media_file_id AND mf.workspace_id = q.workspace_id WHERE q.workspace_id = $1 ORDER BY q.shortcut`,
      [a.workspaceId],
    );
    return { quick_replies: rows };
  });

  async function assertOwnMedia(workspaceId: string, mediaId: string | null | undefined) {
    if (!mediaId) return;
    const { rows } = await ctx.db.query(`SELECT 1 FROM media_files WHERE id = $1 AND workspace_id = $2`, [mediaId, workspaceId]);
    if (!rows[0]) throw notFound('Archivo');
  }

  app.post('/api/quick-replies', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const body = parse(qrSchema, req.body);
    await assertOwnMedia(a.workspaceId, body.media_file_id);
    const { rows } = await ctx.db.query(
      `INSERT INTO quick_replies (workspace_id, shortcut, title, body, media_file_id) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, shortcut) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, media_file_id = EXCLUDED.media_file_id
       RETURNING *`,
      [a.workspaceId, body.shortcut.toLowerCase(), body.title ?? null, body.body, body.media_file_id ?? null],
    );
    return { quick_reply: rows[0] };
  });

  app.patch('/api/quick-replies/:id', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(qrSchema.partial(), req.body);
    await assertOwnMedia(a.workspaceId, body.media_file_id);
    const { rows } = await ctx.db.query(
      `UPDATE quick_replies SET shortcut = COALESCE($3, shortcut), title = COALESCE($4, title), body = COALESCE($5, body),
         media_file_id = CASE WHEN $6 THEN $7::uuid ELSE media_file_id END
       WHERE id = $1 AND workspace_id = $2 RETURNING *`,
      [id, a.workspaceId, body.shortcut?.toLowerCase() ?? null, body.title ?? null, body.body ?? null, body.media_file_id !== undefined, body.media_file_id ?? null],
    );
    if (!rows[0]) throw notFound('Respuesta rápida');
    return { quick_reply: rows[0] };
  });

  app.delete('/api/quick-replies/:id', async (req, reply) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    await ctx.db.query(`DELETE FROM quick_replies WHERE id = $1 AND workspace_id = $2`, [id, a.workspaceId]);
    return noContent(reply);
  });
}
