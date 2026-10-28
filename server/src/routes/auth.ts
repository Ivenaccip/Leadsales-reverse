import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Queryable } from '../db/index.js';
import { hashPassword, signToken, verifyPassword } from '../lib/auth.js';
import { badRequest, conflict, forbidden, unauthorized } from '../lib/errors.js';
import { topup } from '../services/credits.js';
import { COOKIE, parse, RateLimiter, requireUser } from './helpers.js';

export const DEFAULT_STAGES = [
  { name: 'Nuevo', color: '#3b82f6', kind: 'open' },
  { name: 'Contactado', color: '#8b5cf6', kind: 'open' },
  { name: 'Interesado', color: '#f59e0b', kind: 'open' },
  { name: 'Cotización enviada', color: '#06b6d4', kind: 'open' },
  { name: 'Ganado', color: '#22c55e', kind: 'won' },
  { name: 'Perdido', color: '#ef4444', kind: 'lost' },
];

const DEFAULT_TAGS = [
  { name: 'Prospecto caliente', color: '#ef4444' },
  { name: 'Cliente', color: '#22c55e' },
  { name: 'Seguimiento', color: '#f59e0b' },
];

export async function createWorkspace(
  ctx: AppContext,
  q: Queryable,
  ownerId: string,
  name: string,
  opts: { timezone?: string; countryCode?: string } = {},
): Promise<string> {
  const ws = await q.query<{ id: string }>(
    `INSERT INTO workspaces (name, billing_mode, timezone, default_country_code) VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, ctx.config.defaultBillingMode, opts.timezone ?? 'America/Mexico_City', opts.countryCode ?? '52'],
  );
  const id = ws.rows[0].id;
  await q.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, ownerId]);
  const f = await q.query<{ id: string }>(
    `INSERT INTO funnels (workspace_id, name, position, is_default) VALUES ($1, 'Ventas', 0, true) RETURNING id`,
    [id],
  );
  for (const [i, s] of DEFAULT_STAGES.entries()) {
    await q.query(`INSERT INTO stages (workspace_id, funnel_id, name, color, kind, position) VALUES ($1, $2, $3, $4, $5, $6)`, [
      id,
      f.rows[0].id,
      s.name,
      s.color,
      s.kind,
      i,
    ]);
  }
  for (const t of DEFAULT_TAGS) {
    await q.query(`INSERT INTO tags (workspace_id, name, color) VALUES ($1, $2, $3)`, [id, t.name, t.color]);
  }
  if (ctx.config.signupCredits > 0) {
    await topup(q, id, ctx.config.signupCredits, { description: 'Créditos de bienvenida' });
  }
  return id;
}

async function workspacesOf(ctx: AppContext, userId: string) {
  const { rows } = await ctx.db.query(
    `SELECT w.id, w.name, m.role, w.billing_mode, w.is_active FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = $1 AND m.is_active ORDER BY w.created_at`,
    [userId],
  );
  return rows;
}

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Escribe tu nombre'),
  email: z.string().trim().toLowerCase().email('Correo inválido'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
  workspaceName: z.string().trim().min(2, 'Escribe el nombre de tu negocio'),
  timezone: z.string().optional(),
  countryCode: z.string().regex(/^\d{1,4}$/).optional(),
});

export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const loginLimiter = new RateLimiter(10, 15 * 60 * 1000);
  const cookieOpts = {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: ctx.config.publicUrl.startsWith('https://'),
    maxAge: 30 * 24 * 3600,
  };

  app.get('/api/instance', async () => {
    const { rows } = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
    return {
      name: 'LeadLibre',
      version: '1.0.0',
      allowSignup: ctx.config.allowSignup || rows[0].n === 0,
      hasUsers: rows[0].n > 0,
      publicUrl: ctx.config.publicUrl,
      webhookUrl: `${ctx.config.publicUrl}/webhooks/whatsapp`,
      defaultBillingMode: ctx.config.defaultBillingMode,
    };
  });

  app.post('/api/auth/register', async (req, reply) => {
    loginLimiter.check(`reg:${req.ip}`);
    const body = parse(registerSchema, req.body);
    const count = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
    const first = count.rows[0].n === 0;
    if (!first && !ctx.config.allowSignup) throw forbidden('El registro está cerrado en esta instancia. Pide una invitación.');
    const exists = await ctx.db.query(`SELECT 1 FROM users WHERE email = $1`, [body.email]);
    if (exists.rows[0]) throw conflict('Ya existe una cuenta con ese correo', 'EMAIL_TAKEN');
    const hash = await hashPassword(body.password);
    const userId = await ctx.db.tx(async (q) => {
      const u = await q.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, name, is_superadmin) VALUES ($1, $2, $3, $4) RETURNING id`,
        [body.email, hash, body.name, first],
      );
      await createWorkspace(ctx, q, u.rows[0].id, body.workspaceName, { timezone: body.timezone, countryCode: body.countryCode });
      return u.rows[0].id;
    });
    reply.setCookie(COOKIE, signToken(ctx.config.jwtSecret, { uid: userId }), cookieOpts);
    const user = await ctx.db.query(`SELECT id, email, name, is_superadmin FROM users WHERE id = $1`, [userId]);
    return { user: user.rows[0], workspaces: await workspacesOf(ctx, userId) };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = parse(z.object({ email: z.string().trim().toLowerCase(), password: z.string() }), req.body);
    loginLimiter.check(`login:${req.ip}:${body.email}`);
    const { rows } = await ctx.db.query<{ id: string; password_hash: string }>(`SELECT id, password_hash FROM users WHERE email = $1`, [
      body.email,
    ]);
    if (!rows[0] || !(await verifyPassword(body.password, rows[0].password_hash))) {
      throw unauthorized('Correo o contraseña incorrectos');
    }
    reply.setCookie(COOKIE, signToken(ctx.config.jwtSecret, { uid: rows[0].id }), cookieOpts);
    const user = await ctx.db.query(`SELECT id, email, name, is_superadmin FROM users WHERE id = $1`, [rows[0].id]);
    return { user: user.rows[0], workspaces: await workspacesOf(ctx, rows[0].id) };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const user = await requireUser(ctx, req);
    return { user, workspaces: await workspacesOf(ctx, user.id) };
  });

  app.patch('/api/auth/me', async (req) => {
    const user = await requireUser(ctx, req);
    const body = parse(
      z.object({
        name: z.string().trim().min(2).optional(),
        password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres').optional(),
        currentPassword: z.string().optional(),
      }),
      req.body,
    );
    if (body.password) {
      const { rows } = await ctx.db.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [user.id]);
      if (!body.currentPassword || !(await verifyPassword(body.currentPassword, rows[0].password_hash))) {
        throw badRequest('La contraseña actual no es correcta');
      }
      await ctx.db.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [user.id, await hashPassword(body.password)]);
    }
    if (body.name) await ctx.db.query(`UPDATE users SET name = $2 WHERE id = $1`, [user.id, body.name]);
    const { rows } = await ctx.db.query(`SELECT id, email, name, is_superadmin FROM users WHERE id = $1`, [user.id]);
    return { user: rows[0] };
  });

  app.post('/api/workspaces', async (req) => {
    const user = await requireUser(ctx, req);
    if (!ctx.config.allowSignup && !user.is_superadmin) throw forbidden('Solo el administrador de la instancia puede crear espacios');
    const body = parse(
      z.object({ name: z.string().trim().min(2), timezone: z.string().optional(), countryCode: z.string().regex(/^\d{1,4}$/).optional() }),
      req.body,
    );
    const id = await ctx.db.tx((q) => createWorkspace(ctx, q, user.id, body.name, { timezone: body.timezone, countryCode: body.countryCode }));
    return { id, workspaces: await workspacesOf(ctx, user.id) };
  });
}
