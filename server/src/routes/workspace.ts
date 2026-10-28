import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { hashPassword } from '../lib/auth.js';
import { encrypt } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { AI_MODELS, DEFAULT_AI_SETTINGS } from '../services/ai-agent.js';
import { settingsWithDefaults } from '../services/automation.js';
import { getWorkspace } from '../services/messages.js';
import type { BotMenu, WorkspaceRow, WorkspaceSettings } from '../types.js';
import { ADMIN_ROLES, noContent, parse, requireWs, uuid } from './helpers.js';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Usa formato HH:MM');

const optionSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    key: z.string().trim().min(1).max(10),
    label: z.string().trim().min(1).max(72),
    reply: z.string().max(4000).optional(),
    stage_id: uuid.nullable().optional(),
    tag_ids: z.array(uuid).optional(),
    assign_user_id: uuid.nullable().optional(),
    handoff: z.boolean().optional(),
    submenu: menuSchema.nullable().optional(),
  }),
);
const menuSchema: z.ZodType<any> = z.object({
  prompt: z.string().trim().min(1).max(1024),
  options: z.array(optionSchema).min(1).max(10),
});

function menuDepth(m: BotMenu | null | undefined): number {
  if (!m?.options?.length) return 0;
  return 1 + Math.max(0, ...m.options.map((o) => menuDepth(o.submenu)));
}

const settingsSchema = z.object({
  automation_mode: z.enum(['off', 'menu', 'ai']).optional(),
  agent_visibility: z.enum(['all', 'assigned']).optional(),
  welcome: z.object({ enabled: z.boolean(), text: z.string().max(4000) }).optional(),
  away: z
    .object({
      enabled: z.boolean(),
      text: z.string().max(4000),
      hours: z.record(z.string().regex(/^[0-6]$/), z.array(z.tuple([hhmm, hhmm]))),
    })
    .optional(),
  bot: z
    .object({
      menu: menuSchema,
      fallback: z.string().max(1000),
      handoff_message: z.string().max(1000),
      interactive: z.boolean(),
      only_unassigned: z.boolean(),
    })
    .optional(),
  ai: z
    .object({
      model: z.string().min(3),
      api_key: z.string().trim().nullable().optional(),
      instructions: z.string().max(10_000),
      knowledge: z.string().max(100_000),
      handoff_message: z.string().max(1000),
      only_unassigned: z.boolean(),
      max_replies: z.number().int().min(1).max(500),
    })
    .optional(),
});

export function publicSettings(ws: WorkspaceRow) {
  const s = settingsWithDefaults(ws.settings);
  const { api_key_enc, ...ai } = { ...DEFAULT_AI_SETTINGS, ...(s.ai ?? {}) } as any;
  return { ...s, ai: { ...ai, has_api_key: !!api_key_enc } };
}

function publicWorkspace(ws: WorkspaceRow) {
  return { ...ws, settings: publicSettings(ws) };
}

export async function workspaceRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/workspace', async (req) => {
    const a = await requireWs(ctx, req);
    const ws = await getWorkspace(ctx, a.workspaceId);
    return { workspace: publicWorkspace(ws), role: a.role, ai_models: AI_MODELS };
  });

  app.patch('/api/workspace', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const body = parse(
      z.object({
        name: z.string().trim().min(2).optional(),
        timezone: z.string().refine((tz) => {
          try {
            new Intl.DateTimeFormat('en-US', { timeZone: tz });
            return true;
          } catch {
            return false;
          }
        }, 'Zona horaria inválida').optional(),
        default_country_code: z.string().regex(/^\d{1,4}$/).optional(),
      }),
      req.body,
    );
    await ctx.db.query(
      `UPDATE workspaces SET name = COALESCE($2, name), timezone = COALESCE($3, timezone), default_country_code = COALESCE($4, default_country_code) WHERE id = $1`,
      [a.workspaceId, body.name ?? null, body.timezone ?? null, body.default_country_code ?? null],
    );
    return { workspace: publicWorkspace(await getWorkspace(ctx, a.workspaceId)) };
  });

  app.put('/api/workspace/settings', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const body = parse(settingsSchema, req.body);
    if (body.bot && menuDepth(body.bot.menu) > 3) throw badRequest('El menú del bot admite máximo 3 niveles');
    const ws = await getWorkspace(ctx, a.workspaceId);
    const next: WorkspaceSettings = { ...(ws.settings ?? {}) };
    if (body.automation_mode) next.automation_mode = body.automation_mode;
    if (body.agent_visibility) next.agent_visibility = body.agent_visibility;
    if (body.welcome) next.welcome = body.welcome;
    if (body.away) next.away = body.away as any;
    if (body.bot) next.bot = body.bot;
    if (body.ai) {
      const { api_key, ...rest } = body.ai;
      let api_key_enc = ws.settings?.ai?.api_key_enc ?? null;
      if (api_key === null || api_key === '') api_key_enc = null;
      else if (api_key) api_key_enc = encrypt(ctx.config.encryptionKey, api_key);
      next.ai = { ...rest, api_key_enc };
    }
    if (next.automation_mode === 'ai' && !next.ai?.api_key_enc && !ctx.config.anthropicApiKey) {
      throw badRequest('Para activar el agente IA agrega tu llave de API de Claude (Anthropic)', 'AI_KEY_REQUIRED');
    }
    await ctx.db.query(`UPDATE workspaces SET settings = $2 WHERE id = $1`, [a.workspaceId, JSON.stringify(next)]);
    if (body.agent_visibility && body.agent_visibility !== ws.settings?.agent_visibility) await ctx.realtime.evict(a.workspaceId);
    return { workspace: publicWorkspace(await getWorkspace(ctx, a.workspaceId)) };
  });

  app.get('/api/workspace/members', async (req) => {
    const a = await requireWs(ctx, req);
    const { rows } = await ctx.db.query(
      `SELECT u.id, u.email, u.name, m.role, m.is_active, m.receives_leads, m.last_assigned_at, m.created_at
       FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY m.created_at`,
      [a.workspaceId],
    );
    return { members: rows };
  });

  app.post('/api/workspace/members', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const body = parse(
      z.object({
        email: z.string().trim().toLowerCase().email('Correo inválido'),
        name: z.string().trim().min(2, 'Escribe el nombre'),
        password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres').optional(),
        role: z.enum(['admin', 'agent']).default('agent'),
      }),
      req.body,
    );
    const existing = await ctx.db.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [body.email]);
    let userId = existing.rows[0]?.id;
    if (!userId) {
      if (!body.password) throw badRequest('Define una contraseña inicial para el nuevo usuario');
      const u = await ctx.db.query<{ id: string }>(`INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id`, [
        body.email,
        await hashPassword(body.password),
        body.name,
      ]);
      userId = u.rows[0].id;
    }
    const ins = await ctx.db.query(
      `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING user_id`,
      [a.workspaceId, userId, body.role],
    );
    if (!ins.rows[0]) throw conflict('Ese usuario ya es parte del equipo');
    return { id: userId, existing_user: !!existing.rows[0] };
  });

  app.patch('/api/workspace/members/:id', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(
      z.object({ role: z.enum(['owner', 'admin', 'agent']).optional(), is_active: z.boolean().optional(), receives_leads: z.boolean().optional() }),
      req.body,
    );
    const target = await ctx.db.query<{ role: string }>(`SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2`, [a.workspaceId, id]);
    if (!target.rows[0]) throw notFound('Miembro');
    if ((body.role === 'owner' || target.rows[0].role === 'owner') && a.role !== 'owner') {
      throw badRequest('Solo un propietario puede cambiar a otro propietario');
    }
    if (target.rows[0].role === 'owner' && (body.role && body.role !== 'owner' || body.is_active === false)) {
      const owners = await ctx.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM memberships WHERE workspace_id = $1 AND role = 'owner' AND is_active`,
        [a.workspaceId],
      );
      if (owners.rows[0].n <= 1) throw badRequest('Debe quedar al menos un propietario activo');
    }
    await ctx.db.query(
      `UPDATE memberships SET role = COALESCE($3, role), is_active = COALESCE($4, is_active), receives_leads = COALESCE($5, receives_leads)
       WHERE workspace_id = $1 AND user_id = $2`,
      [a.workspaceId, id, body.role ?? null, body.is_active ?? null, body.receives_leads ?? null],
    );
    if (body.role || body.is_active !== undefined) await ctx.realtime.evict(a.workspaceId, id);
    return { ok: true };
  });

  app.delete('/api/workspace/members/:id', async (req, reply) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const target = await ctx.db.query<{ role: string }>(`SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2`, [a.workspaceId, id]);
    if (!target.rows[0]) throw notFound('Miembro');
    if (target.rows[0].role === 'owner') {
      if (a.role !== 'owner') throw badRequest('Solo un propietario puede quitar a otro propietario');
      const owners = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM memberships WHERE workspace_id = $1 AND role = 'owner'`, [
        a.workspaceId,
      ]);
      if (owners.rows[0].n <= 1) throw badRequest('Debe quedar al menos un propietario');
    }
    await ctx.db.query(`UPDATE contacts SET assigned_user_id = NULL WHERE workspace_id = $1 AND assigned_user_id = $2`, [a.workspaceId, id]);
    await ctx.db.query(`DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2`, [a.workspaceId, id]);
    await ctx.realtime.evict(a.workspaceId, id);
    return noContent(reply);
  });
}
