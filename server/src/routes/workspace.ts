import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Queryable } from '../db/index.js';
import { hashPassword } from '../lib/auth.js';
import { encrypt } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { AI_MODELS, DEFAULT_AI_SETTINGS } from '../services/ai-agent.js';
import { settingsWithDefaults } from '../services/automation.js';
import { getWorkspace } from '../services/messages.js';
import type { BotMenu, WorkspaceRow, WorkspaceSettings } from '../types.js';
import { emailSchema, lockSignups, newPasswordSchema } from './auth.js';
import { ADMIN_ROLES, noContent, parse, requireWs, uuid, type WsAuth } from './helpers.js';
import { createInvitation, revokePendingInvitations } from './invitations.js';

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
// Typed answers and the saved bot state find an option by its key: of two options with the same
// key in one menu, the second could never be reached.
const menuSchema: z.ZodType<any> = z
  .object({
    prompt: z.string().trim().min(1).max(1024),
    options: z.array(optionSchema).min(1).max(10),
  })
  .superRefine((menu, issues) => {
    const seen = new Set<string>();
    menu.options?.forEach((o: { key: string }, i: number) => {
      if (typeof o?.key !== 'string') return;
      if (seen.has(o.key)) {
        issues.addIssue({ code: 'custom', path: ['options', i, 'key'], message: `La clave "${o.key}" está repetida en este menú: cada opción necesita una distinta` });
      }
      seen.add(o.key);
    });
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

  // Adds a teammate. Accounts are global and emails unverified, so an existing account is never
  // attached and a workspace admin never sets someone's password: everyone gets an invitation link.
  // Only the instance operator may still create a brand-new account directly with a password.
  app.post('/api/workspace/members', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const body = parse(
      z.object({
        email: emailSchema,
        name: z.string().trim().min(2, 'Escribe el nombre').max(120).optional(),
        password: newPasswordSchema.optional(),
        role: z.enum(['admin', 'agent']).default('agent'),
      }),
      req.body,
    );
    const member = await ctx.db.query<{ is_active: boolean }>(
      `SELECT m.is_active FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND u.email = $2`,
      [a.workspaceId, body.email],
    );
    if (member.rows[0]) {
      throw conflict(member.rows[0].is_active ? 'Ese usuario ya es parte del equipo' : 'Ese usuario ya es parte del equipo, pero está desactivado: reactívalo desde la lista');
    }
    if (a.user.is_superadmin && body.password) {
      const hash = await hashPassword(body.password);
      const userId = await ctx.db.tx(async (q) => {
        await lockSignups(q);
        if ((await q.query(`SELECT 1 FROM users WHERE email = $1`, [body.email])).rows[0]) return null;
        const u = await q.query<{ id: string }>(`INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id`, [
          body.email,
          hash,
          body.name ?? body.email.split('@')[0],
        ]);
        await q.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)`, [a.workspaceId, u.rows[0].id, body.role]);
        // An earlier link for this email would later override what the admins decide for this member.
        await revokePendingInvitations(q, a.workspaceId, { email: body.email });
        return u.rows[0].id;
      });
      if (userId) return { id: userId, existing_user: false };
    }
    return createInvitation(ctx, a, { email: body.email, name: body.name, role: body.role });
  });

  app.patch('/api/workspace/members/:id', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(
      z.object({ role: z.enum(['owner', 'admin', 'agent']).optional(), is_active: z.boolean().optional(), receives_leads: z.boolean().optional() }),
      req.body,
    );
    await memberOf(ctx, a, id);
    await ctx.db.tx(async (q) => {
      const target = await lockOwnersAnd(q, a.workspaceId, id);
      if ((body.role === 'owner' || target.role === 'owner') && a.role !== 'owner') {
        throw badRequest('Solo un propietario puede cambiar a otro propietario');
      }
      if ((body.role && body.role !== 'owner') || body.is_active === false) await keepAnActiveOwner(q, a.workspaceId, id, target);
      await q.query(
        `UPDATE memberships SET role = COALESCE($3, role), is_active = COALESCE($4, is_active), receives_leads = COALESCE($5, receives_leads)
         WHERE workspace_id = $1 AND user_id = $2`,
        [a.workspaceId, id, body.role ?? null, body.is_active ?? null, body.receives_leads ?? null],
      );
      // A pending link from before must not give back a role or access that was just taken away.
      if (body.role || body.is_active === false) await revokePendingInvitations(q, a.workspaceId, { userId: id });
    });
    if (body.role || body.is_active !== undefined) await ctx.realtime.evict(a.workspaceId, id);
    if (body.is_active === false) await endSessionsWithoutWorkspace(ctx, id);
    return { ok: true };
  });

  app.delete('/api/workspace/members/:id', async (req, reply) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    await memberOf(ctx, a, id);
    await ctx.db.tx(async (q) => {
      const target = await lockOwnersAnd(q, a.workspaceId, id);
      if (target.role === 'owner') {
        if (a.role !== 'owner') throw badRequest('Solo un propietario puede quitar a otro propietario');
        await keepAnActiveOwner(q, a.workspaceId, id, target);
      }
      await q.query(`UPDATE contacts SET assigned_user_id = NULL WHERE workspace_id = $1 AND assigned_user_id = $2`, [a.workspaceId, id]);
      await q.query(`DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2`, [a.workspaceId, id]);
      await revokePendingInvitations(q, a.workspaceId, { userId: id });
    });
    await ctx.realtime.evict(a.workspaceId, id);
    await endSessionsWithoutWorkspace(ctx, id);
    return noContent(reply);
  });
}

/** A member of the caller's workspace; the instance operator's membership is only theirs to change. */
async function memberOf(ctx: AppContext, a: WsAuth, userId: string) {
  const { rows } = await ctx.db.query<{ role: string; is_superadmin: boolean }>(
    `SELECT m.role, u.is_superadmin FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND m.user_id = $2`,
    [a.workspaceId, userId],
  );
  if (!rows[0]) throw notFound('Miembro');
  if (rows[0].is_superadmin && !a.user.is_superadmin) throw forbidden('Solo el administrador de la instancia puede cambiar su propio acceso');
  return rows[0];
}

/**
 * Locks the workspace's owner memberships (then the target's): two owners demoting or removing
 * each other at the same moment are checked one after the other, so they cannot both pass.
 */
async function lockOwnersAnd(q: Queryable, workspaceId: string, userId: string) {
  await q.query(`SELECT user_id FROM memberships WHERE workspace_id = $1 AND role = 'owner' ORDER BY user_id FOR UPDATE`, [workspaceId]);
  const { rows } = await q.query<{ role: string; is_active: boolean }>(
    `SELECT role, is_active FROM memberships WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE`,
    [workspaceId, userId],
  );
  if (!rows[0]) throw notFound('Miembro');
  return rows[0];
}

/** Demoting, deactivating or removing an active owner needs another active owner to remain. */
async function keepAnActiveOwner(q: Queryable, workspaceId: string, userId: string, target: { role: string; is_active: boolean }) {
  if (target.role !== 'owner' || !target.is_active) return;
  const { rows } = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM memberships WHERE workspace_id = $1 AND role = 'owner' AND is_active AND user_id <> $2`,
    [workspaceId, userId],
  );
  if (rows[0].n === 0) throw badRequest('Debe quedar al menos un propietario activo');
}

/**
 * Someone deactivated or removed from their last workspace has no reason to stay signed in:
 * their sessions end and their open tabs are sent to the login ('session:revoked').
 * Members of other workspaces keep their session (one tenant cannot log them out elsewhere).
 */
async function endSessionsWithoutWorkspace(ctx: AppContext, userId: string) {
  const { rows } = await ctx.db.query<{ is_superadmin: boolean; has_workspace: boolean }>(
    `SELECT u.is_superadmin, EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.is_active) AS has_workspace
     FROM users u WHERE u.id = $1`,
    [userId],
  );
  if (!rows[0] || rows[0].is_superadmin || rows[0].has_workspace) return;
  await ctx.db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  await ctx.realtime.endSessions({ userId });
}
