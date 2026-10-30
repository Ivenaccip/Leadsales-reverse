import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { verifyPassword, verifyToken } from '../lib/auth.js';
import { sha256Hex } from '../lib/crypto.js';
import { AppError, badRequest, forbidden, unauthorized } from '../lib/errors.js';
import type { Role } from '../types.js';

export const COOKIE = 'll_token';
/** Signed entries of the accounts that signed in from this browser (see knownDevice). */
export const DEVICE_COOKIE = 'll_device';

/**
 * A session lasts as long as its token (signed once, when its row is created): the row itself
 * stops counting then too, so nothing (a socket, a token re-signed elsewhere) outlives it.
 */
export const SESSION_DAYS = 30;
/** SQL condition: the session row `s` is younger than SESSION_DAYS. */
export const SESSION_FRESH = `s.created_at > now() - interval '${SESSION_DAYS} days'`;

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  is_superadmin: boolean;
}

export interface WsAuth {
  user: AuthUser;
  workspaceId: string;
  role: Role;
}

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    const where = first?.path?.length ? `${first.path.join('.')}: ` : '';
    throw badRequest(`Datos inválidos — ${where}${first?.message ?? 'revisa el formulario'}`, 'VALIDATION', r.error.issues);
  }
  return r.data;
}

function tokenFrom(req: FastifyRequest): string | null {
  const cookie = (req.cookies as Record<string, string | undefined>)?.[COOKIE];
  if (cookie) return cookie;
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ') && !h.slice(7).startsWith('ll_')) return h.slice(7);
  return null;
}

export interface AuthSession {
  user: AuthUser;
  /** Id of the `sessions` row behind the cookie (logout and password changes revoke it). */
  sid: string;
}

/**
 * The token must point to a live (not revoked) session of an existing user, opened with the
 * current password: a login that verified the old password while it was being changed gets a
 * session stamped with the old version, which never works.
 */
export async function requireSession(ctx: AppContext, req: FastifyRequest): Promise<AuthSession> {
  const token = tokenFrom(req);
  const payload = token ? verifyToken(ctx.config.jwtSecret, token) : null;
  if (!payload) throw unauthorized();
  const { rows } = await ctx.db.query<AuthUser & { stale: boolean }>(
    `SELECT u.id, u.email, u.name, u.is_superadmin, s.last_seen_at < now() - interval '5 minutes' AS stale
     FROM sessions s JOIN users u ON u.id = s.user_id AND u.password_version = s.password_version
     WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND ${SESSION_FRESH}`,
    [payload.sid, payload.uid],
  );
  if (!rows[0]) throw unauthorized();
  const { stale, ...user } = rows[0];
  if (stale) await ctx.db.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [payload.sid]);
  return { user, sid: payload.sid };
}

export async function requireUser(ctx: AppContext, req: FastifyRequest): Promise<AuthUser> {
  return (await requireSession(ctx, req)).user;
}

/** Authenticated user + the workspace selected with the X-Workspace-Id header. */
export async function requireWs(ctx: AppContext, req: FastifyRequest, roles?: Role[]): Promise<WsAuth> {
  const user = await requireUser(ctx, req);
  const workspaceId = String(req.headers['x-workspace-id'] ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw badRequest('Falta el encabezado X-Workspace-Id', 'NO_WORKSPACE');
  // The instance operator supports every workspace as owner: a membership row (which a tenant
  // could demote or deactivate) must never lower that.
  if (user.is_superadmin) {
    if (roles && !roles.includes('owner')) throw forbidden();
    return { user, workspaceId, role: 'owner' };
  }
  const { rows } = await ctx.db.query<{ role: Role; is_active: boolean; ws_active: boolean }>(
    `SELECT m.role, m.is_active, w.is_active AS ws_active FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.workspace_id = $1 AND m.user_id = $2`,
    [workspaceId, user.id],
  );
  const m = rows[0];
  if (!m) throw forbidden('No perteneces a este espacio de trabajo');
  if (!m.is_active) throw forbidden('Tu usuario está desactivado en este espacio de trabajo');
  if (!m.ws_active) throw forbidden('Este espacio de trabajo está suspendido');
  if (roles && !roles.includes(m.role)) throw forbidden();
  return { user, workspaceId, role: m.role };
}

export const ADMIN_ROLES: Role[] = ['owner', 'admin'];

/** True when this member is an agent limited to their own and unassigned conversations. */
export async function agentRestricted(ctx: AppContext, a: WsAuth): Promise<boolean> {
  if (a.role !== 'agent') return false;
  const { rows } = await ctx.db.query<{ v: string | null }>(`SELECT settings->>'agent_visibility' AS v FROM workspaces WHERE id = $1`, [a.workspaceId]);
  return rows[0]?.v === 'assigned';
}

export async function requireSuperadmin(ctx: AppContext, req: FastifyRequest): Promise<AuthUser> {
  return (await requireSuperadminSession(ctx, req)).user;
}

export async function requireSuperadminSession(ctx: AppContext, req: FastifyRequest): Promise<AuthSession> {
  const s = await requireSession(ctx, req);
  if (!s.user.is_superadmin) throw forbidden('Solo el administrador de la instancia puede hacer esto');
  return s;
}

// One budget per app instance (tests build several), shared by every route that asks for it.
const passwordLimiters = new WeakMap<AppContext, RateLimiter>();

/**
 * Step-up check: the caller's current password, for changes a stolen session must not make on
 * its own (its password, operator rights, other accounts' passwords). Limited per session: a stolen
 * session is no unlimited password oracle, and its guesses never use up the owner's budget.
 * Returns the account's password version (the one just verified).
 */
export async function verifyCurrentPassword(ctx: AppContext, s: AuthSession, password: string | undefined): Promise<number> {
  let limiter = passwordLimiters.get(ctx);
  if (!limiter) passwordLimiters.set(ctx, (limiter = new RateLimiter(10, 15 * 60 * 1000)));
  if (limiter.blocked(s.sid)) throw tooManyAttempts();
  const { rows } = await ctx.db.query<{ password_hash: string; password_version: number }>(
    `SELECT password_hash, password_version FROM users WHERE id = $1`,
    [s.user.id],
  );
  limiter.hit(s.sid);
  let ok = false;
  try {
    ok = !!password && !!rows[0] && (await verifyPassword(password, rows[0].password_hash));
  } catch (err) {
    limiter.undo(s.sid); // nothing was checked (e.g. the server is busy)
    throw err;
  }
  if (!ok) throw badRequest('La contraseña actual no es correcta', 'WRONG_PASSWORD');
  limiter.undo(s.sid);
  return rows[0].password_version;
}

/** Public API: "Authorization: Bearer ll_live_..." or "X-Api-Key". */
export async function requireApiKey(ctx: AppContext, req: FastifyRequest): Promise<{ workspaceId: string; keyId: string }> {
  const h = req.headers.authorization;
  const key = (h?.startsWith('Bearer ') ? h.slice(7) : String(req.headers['x-api-key'] ?? '')).trim();
  if (!key.startsWith('ll_')) throw new AppError(401, 'UNAUTHORIZED', 'Llave de API inválida');
  const { rows } = await ctx.db.query<{ id: string; workspace_id: string }>(
    `UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1 RETURNING id, workspace_id`,
    [sha256Hex(key)],
  );
  if (!rows[0]) throw new AppError(401, 'UNAUTHORIZED', 'Llave de API inválida');
  const ws = await ctx.db.query<{ is_active: boolean }>(`SELECT is_active FROM workspaces WHERE id = $1`, [rows[0].workspace_id]);
  if (!ws.rows[0]?.is_active) throw forbidden('Este espacio de trabajo está suspendido');
  return { workspaceId: rows[0].workspace_id, keyId: rows[0].id };
}

export const uuid = z.string().uuid('Identificador inválido');
export const idParams = z.object({ id: uuid });

export function noContent(reply: FastifyReply) {
  return reply.code(204).send();
}

export const tooManyAttempts = () => new AppError(429, 'TOO_MANY_REQUESTS', 'Demasiados intentos. Espera unos minutos.');

/**
 * In-memory fixed-window limiter for login/register brute force protection.
 * Keys are hashed (an attacker-chosen string never stays in memory) and the map is bounded:
 * when full it drops expired counters first and then the ones with the fewest attempts, so
 * flooding it with junk keys can neither exhaust memory nor reset a counter that is close to blocking.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; reset: number }>();
  constructor(
    private max: number,
    private windowMs: number,
    private maxKeys = 10_000,
  ) {}

  get size() {
    return this.hits.size;
  }

  private live(key: string, now: number) {
    const h = this.hits.get(key);
    if (h && h.reset <= now) {
      this.hits.delete(key);
      return undefined;
    }
    return h;
  }

  /** True when the key already used up its attempts (does not count one). */
  blocked(raw: string): boolean {
    const h = this.live(sha256Hex(raw), Date.now());
    return !!h && h.count >= this.max;
  }

  /** Counts one attempt, or throws 429 when the key is over its limit. */
  hit(raw: string) {
    const key = sha256Hex(raw);
    const now = Date.now();
    let h = this.live(key, now);
    if (!h) {
      this.makeRoom(now);
      h = { count: 0, reset: now + this.windowMs };
      this.hits.set(key, h);
    }
    if (h.count >= this.max) throw tooManyAttempts();
    h.count++;
  }

  /** Gives back an attempt counted with hit() (e.g. the password was right). */
  undo(raw: string) {
    const h = this.live(sha256Hex(raw), Date.now());
    if (h && h.count > 0) h.count--;
  }

  private makeRoom(now: number) {
    if (this.hits.size < this.maxKeys) return;
    // Every window has the same length, so insertion order is expiry order: expired ones come first.
    for (const [k, h] of this.hits) {
      if (h.reset > now) break;
      this.hits.delete(k);
    }
    if (this.hits.size < this.maxKeys) return;
    let victim: string | null = null;
    let fewest = Infinity;
    for (const [k, h] of this.hits) {
      if (h.count < fewest) {
        victim = k;
        fewest = h.count;
        if (fewest <= 1) break;
      }
    }
    if (victim) this.hits.delete(victim);
  }
}
