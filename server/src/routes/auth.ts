import net from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Queryable } from '../db/index.js';
import { dummyPasswordHash, hashPassword, knownDevice, rememberDevice, signToken, verifyPassword } from '../lib/auth.js';
import { badRequest, conflict, forbidden, unauthorized } from '../lib/errors.js';
import { topup } from '../services/credits.js';
import { COOKIE, DEVICE_COOKIE, parse, RateLimiter, requireSession, requireUser, tooManyAttempts } from './helpers.js';

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

export async function workspacesOf(ctx: AppContext, userId: string) {
  const { rows } = await ctx.db.query(
    `SELECT w.id, w.name, m.role, w.billing_mode, w.is_active FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = $1 AND m.is_active ORDER BY w.created_at`,
    [userId],
  );
  return rows;
}

/** Serializes account creation so two "first" sign-ups cannot both become superadmin. */
export async function lockSignups(q: Queryable) {
  await q.query(`SELECT pg_advisory_xact_lock(724201)`);
}

async function hasUsers(q: Queryable): Promise<boolean> {
  const { rows } = await q.query<{ x: boolean }>(`SELECT EXISTS (SELECT 1 FROM users) AS x`);
  return rows[0].x;
}

/**
 * Opens a revocable session (one row per login) and sets its cookie. `passwordVersion` is the
 * version read together with the password that was just verified (or set): if the password
 * changed meanwhile, the session is born stale and never works.
 */
export async function startSession(ctx: AppContext, req: FastifyRequest, reply: FastifyReply, userId: string, passwordVersion: number) {
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO sessions (user_id, user_agent, ip, password_version) VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, String(req.headers['user-agent'] ?? '').slice(0, 300) || null, req.ip, passwordVersion],
  );
  // Old rows only serve to recognize addresses that signed in before (see the login limiter).
  await ctx.db.query(`DELETE FROM sessions WHERE user_id = $1 AND created_at < now() - interval '90 days'`, [userId]);
  reply.setCookie(COOKIE, signToken(ctx.config.jwtSecret, { uid: userId, sid: rows[0].id }), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.publicUrl.startsWith('https://'),
    maxAge: 30 * 24 * 3600,
  });
  rememberThisDevice(ctx, req, reply, userId, passwordVersion);
}

const DEVICE_COOKIE_PATH = '/api/auth';

/** This browser now counts as one the account signed in from (see the login limiter). */
function rememberThisDevice(ctx: AppContext, req: FastifyRequest, reply: FastifyReply, userId: string, passwordVersion: number) {
  // The browser sends the cookie only under its path. Elsewhere (e.g. registering through an
  // invitation) the entries of the other accounts in this browser are unknown here, and rewriting
  // the cookie would drop them: this account gets its entry at its next login instead.
  if (!req.url.startsWith(`${DEVICE_COOKIE_PATH}/`)) return;
  const current = (req.cookies as Record<string, string | undefined> | undefined)?.[DEVICE_COOKIE];
  reply.setCookie(DEVICE_COOKIE, rememberDevice(ctx.config.jwtSecret, current, userId, passwordVersion), {
    path: DEVICE_COOKIE_PATH,
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.publicUrl.startsWith('https://'),
    maxAge: 365 * 24 * 3600,
  });
}

export async function sessionResponse(ctx: AppContext, userId: string) {
  const user = await ctx.db.query(`SELECT id, email, name, is_superadmin FROM users WHERE id = $1`, [userId]);
  return { user: user.rows[0], workspaces: await workspacesOf(ctx, userId) };
}

/** Limits count per client network: one IPv6 /64 is one client (it can rotate inside it at will). */
export function clientNet(ip: string): string {
  if (!net.isIPv6(ip)) return ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = ip.includes('::') && tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export const emailSchema = z.string().trim().toLowerCase().max(254, 'Correo inválido').email('Correo inválido');
export const newPasswordSchema = z
  .string()
  .min(8, 'La contraseña debe tener al menos 8 caracteres')
  .max(200, 'La contraseña admite máximo 200 caracteres');

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Escribe tu nombre').max(120),
  email: emailSchema,
  password: newPasswordSchema,
  workspaceName: z.string().trim().min(2, 'Escribe el nombre de tu negocio').max(120),
  timezone: z.string().max(64).optional(),
  countryCode: z.string().regex(/^\d{1,4}$/).optional(),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().max(254, 'Correo inválido'),
  password: z.string().max(1024),
});

const WINDOW = 15 * 60 * 1000;
/** Stands in for an unknown account, so its checks cost the same as a real one's. */
const NO_USER = '00000000-0000-0000-0000-000000000000';

/** Whether the account signed in (sessions are kept 90 days) from this client network before. */
async function signedInFrom(ctx: AppContext, userId: string, client: string): Promise<boolean> {
  const { rows } = await ctx.db.query<{ ip: string }>(
    `SELECT ip FROM sessions WHERE user_id = $1 AND ip IS NOT NULL GROUP BY ip ORDER BY max(created_at) DESC LIMIT 1000`,
    [userId],
  );
  // By network, not exact address: IPv6 privacy extensions rotate the address inside the /64 daily.
  return rows.some((r) => clientNet(r.ip) === client);
}

/**
 * Counts an attempt in a bucket shared with others (a whole network, or an account from anywhere).
 * Once it is full, only a client exempt for this account goes on, uncounted. Returns whether it counted.
 */
async function take(limiter: RateLimiter, key: string, exempt: () => Promise<boolean>): Promise<boolean> {
  if (!limiter.blocked(key)) {
    limiter.hit(key);
    return true;
  }
  if (await exempt()) return false;
  throw tooManyAttempts();
}

export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  // Brute force protection. Only failed attempts count (a success gives its attempt back).
  // - per client network, whatever the email: bounds spraying and junk-key flooding
  const netLimiter = new RateLimiter(50, WINDOW);
  // - per client network + account: the one limit that always applies
  const pairLimiter = new RateLimiter(10, WINDOW);
  // - per account regardless of IP, so rotating addresses does not allow unlimited guesses.
  // A browser that signed in to the account before (device cookie), or a network that did, is
  // exempt from the two shared buckets, so neither someone behind the same NAT nor someone
  // elsewhere can lock the owner out, even when her address changes.
  const accountLimiter = new RateLimiter(30, WINDOW);
  // - per device cookie: a stolen one is no unlimited pass around the shared buckets
  const deviceLimiter = new RateLimiter(10, WINDOW);
  const registerLimiter = new RateLimiter(10, WINDOW);
  // - current-password checks, per session: a stolen session is no unlimited password oracle, and
  // its guesses cannot use up the owner's budget (changing the password is how she ends it)
  const passwordLimiter = new RateLimiter(10, WINDOW);
  void dummyPasswordHash();

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
    registerLimiter.hit(`reg:${clientNet(req.ip)}`);
    const body = parse(registerSchema, req.body);
    const closed = () => forbidden('El registro está cerrado en esta instancia. Pide una invitación.');
    // Cheap early answer; the decision that counts is taken again under the lock below.
    if (!ctx.config.allowSignup && (await hasUsers(ctx.db))) throw closed();
    const taken = () => conflict('Ya existe una cuenta con ese correo', 'EMAIL_TAKEN');
    // Answered before paying for bcrypt (the answer is the same either way).
    if ((await ctx.db.query(`SELECT 1 FROM users WHERE email = $1`, [body.email])).rows[0]) throw taken();
    const hash = await hashPassword(body.password);
    const created = await ctx.db.tx(async (q) => {
      await lockSignups(q);
      const first = !(await hasUsers(q));
      if (!first && !ctx.config.allowSignup) throw closed();
      const exists = await q.query(`SELECT 1 FROM users WHERE email = $1`, [body.email]);
      if (exists.rows[0]) throw taken();
      const u = await q.query<{ id: string; password_version: number }>(
        `INSERT INTO users (email, password_hash, name, is_superadmin) VALUES ($1, $2, $3, $4) RETURNING id, password_version`,
        [body.email, hash, body.name, first],
      );
      await createWorkspace(ctx, q, u.rows[0].id, body.workspaceName, { timezone: body.timezone, countryCode: body.countryCode });
      return u.rows[0];
    });
    await startSession(ctx, req, reply, created.id, created.password_version);
    return sessionResponse(ctx, created.id);
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = parse(loginSchema, req.body);
    const client = clientNet(req.ip);
    const { rows } = await ctx.db.query<{ id: string; password_hash: string; password_version: number }>(
      `SELECT id, password_hash, password_version FROM users WHERE email = $1`,
      [body.email],
    );
    const user = rows[0];
    // A browser that signed in to this account with its current password, wherever it connects from.
    const device = knownDevice(ctx.config.jwtSecret, (req.cookies as Record<string, string | undefined>)?.[DEVICE_COOKIE], user ?? null);
    const deviceOk = device !== null && !deviceLimiter.blocked(device);
    let known: Promise<boolean> | undefined;
    // Same query for an unknown email, so not even a 429 tells whether the account exists.
    const knownNet = () => (known ??= signedInFrom(ctx, user?.id ?? NO_USER, client).then((k) => k && !!user));
    const exempt = async () => deviceOk || (await knownNet());
    // The network bucket goes first so a blocked network cannot create new per-account keys.
    const netCounted = await take(netLimiter, client, exempt);
    const pair = `${client}\n${body.email}`;
    pairLimiter.hit(pair);
    const accountCounted = await take(accountLimiter, body.email, exempt);
    if (deviceOk) deviceLimiter.hit(device);
    const giveBack = () => {
      if (netCounted) netLimiter.undo(client);
      pairLimiter.undo(pair);
      if (accountCounted) accountLimiter.undo(body.email);
      if (deviceOk) deviceLimiter.undo(device);
    };
    let ok: boolean;
    try {
      // Always pay for one bcrypt comparison so the response time does not reveal whether the account exists.
      ok = await verifyPassword(body.password, user?.password_hash ?? (await dummyPasswordHash()));
    } catch (err) {
      giveBack(); // nothing was checked (e.g. the server is busy): the attempt does not count
      throw err;
    }
    if (!user || !ok) throw unauthorized('Correo o contraseña incorrectos');
    giveBack();
    await startSession(ctx, req, reply, user.id, user.password_version);
    return sessionResponse(ctx, user.id);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const s = await requireSession(ctx, req).catch(() => null);
    if (s) {
      await ctx.db.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [s.sid]);
      await ctx.realtime.endSessions({ sid: s.sid });
    }
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const user = await requireUser(ctx, req);
    return { user, workspaces: await workspacesOf(ctx, user.id) };
  });

  app.patch('/api/auth/me', async (req, reply) => {
    const { user, sid } = await requireSession(ctx, req);
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(120).optional(),
        password: newPasswordSchema.optional(),
        currentPassword: z.string().max(1024).optional(),
      }),
      req.body,
    );
    if (body.password) {
      if (passwordLimiter.blocked(sid)) throw tooManyAttempts();
      const { rows } = await ctx.db.query<{ password_hash: string; password_version: number }>(
        `SELECT password_hash, password_version FROM users WHERE id = $1`,
        [user.id],
      );
      passwordLimiter.hit(sid);
      let ok = false;
      try {
        ok = !!body.currentPassword && (await verifyPassword(body.currentPassword, rows[0].password_hash));
      } catch (err) {
        passwordLimiter.undo(sid);
        throw err;
      }
      if (!ok) throw badRequest('La contraseña actual no es correcta');
      passwordLimiter.undo(sid);
      const hash = await hashPassword(body.password);
      const version = await ctx.db.tx(async (q) => {
        // Only over the version whose password was just verified: of two concurrent changes, one wins.
        const r = await q.query<{ password_version: number }>(
          `UPDATE users SET password_hash = $2, password_version = password_version + 1 WHERE id = $1 AND password_version = $3 RETURNING password_version`,
          [user.id, hash, rows[0].password_version],
        );
        if (!r.rows[0]) return null;
        // A new password ends every other session (a stolen cookie stops working); this one stays.
        await q.query(`UPDATE sessions SET password_version = $2 WHERE id = $1`, [sid, r.rows[0].password_version]);
        await q.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [user.id, sid]);
        return r.rows[0].password_version;
      });
      if (version === null) throw conflict('La contraseña acaba de cambiar desde otra sesión. Vuelve a intentarlo.', 'PASSWORD_CHANGED');
      await ctx.realtime.endSessions({ userId: user.id, exceptSid: sid });
      rememberThisDevice(ctx, req, reply, user.id, version);
    }
    if (body.name) await ctx.db.query(`UPDATE users SET name = $2 WHERE id = $1`, [user.id, body.name]);
    const { rows } = await ctx.db.query(`SELECT id, email, name, is_superadmin FROM users WHERE id = $1`, [user.id]);
    return { user: rows[0] };
  });

  app.post('/api/workspaces', async (req) => {
    const user = await requireUser(ctx, req);
    if (!ctx.config.allowSignup && !user.is_superadmin) throw forbidden('Solo el administrador de la instancia puede crear espacios');
    const body = parse(
      z.object({ name: z.string().trim().min(2).max(120), timezone: z.string().max(64).optional(), countryCode: z.string().regex(/^\d{1,4}$/).optional() }),
      req.body,
    );
    const id = await ctx.db.tx((q) => createWorkspace(ctx, q, user.id, body.name, { timezone: body.timezone, countryCode: body.countryCode }));
    return { id, workspaces: await workspacesOf(ctx, user.id) };
  });
}
