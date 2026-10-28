import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { verifyToken } from '../lib/auth.js';
import { sha256Hex } from '../lib/crypto.js';
import { AppError, badRequest, forbidden, unauthorized } from '../lib/errors.js';
import type { Role } from '../types.js';

export const COOKIE = 'll_token';

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

export async function requireUser(ctx: AppContext, req: FastifyRequest): Promise<AuthUser> {
  const token = tokenFrom(req);
  const payload = token ? verifyToken(ctx.config.jwtSecret, token) : null;
  if (!payload) throw unauthorized();
  const { rows } = await ctx.db.query<AuthUser>(`SELECT id, email, name, is_superadmin FROM users WHERE id = $1`, [payload.uid]);
  if (!rows[0]) throw unauthorized();
  return rows[0];
}

/** Authenticated user + the workspace selected with the X-Workspace-Id header. */
export async function requireWs(ctx: AppContext, req: FastifyRequest, roles?: Role[]): Promise<WsAuth> {
  const user = await requireUser(ctx, req);
  const workspaceId = String(req.headers['x-workspace-id'] ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw badRequest('Falta el encabezado X-Workspace-Id', 'NO_WORKSPACE');
  const { rows } = await ctx.db.query<{ role: Role; is_active: boolean; ws_active: boolean }>(
    `SELECT m.role, m.is_active, w.is_active AS ws_active FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.workspace_id = $1 AND m.user_id = $2`,
    [workspaceId, user.id],
  );
  const m = rows[0];
  if (!m && !user.is_superadmin) throw forbidden('No perteneces a este espacio de trabajo');
  if (m && !m.is_active) throw forbidden('Tu usuario está desactivado en este espacio de trabajo');
  if (m && !m.ws_active && !user.is_superadmin) throw forbidden('Este espacio de trabajo está suspendido');
  const role: Role = m?.role ?? 'owner'; // superadmins can support any workspace
  if (roles && !roles.includes(role)) throw forbidden();
  return { user, workspaceId, role };
}

export const ADMIN_ROLES: Role[] = ['owner', 'admin'];

export async function requireSuperadmin(ctx: AppContext, req: FastifyRequest): Promise<AuthUser> {
  const user = await requireUser(ctx, req);
  if (!user.is_superadmin) throw forbidden('Solo el administrador de la instancia puede hacer esto');
  return user;
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
  return { workspaceId: rows[0].workspace_id, keyId: rows[0].id };
}

export const uuid = z.string().uuid('Identificador inválido');
export const idParams = z.object({ id: uuid });

export function noContent(reply: FastifyReply) {
  return reply.code(204).send();
}

/** Tiny in-memory limiter for login/register brute force protection. */
export class RateLimiter {
  private hits = new Map<string, { count: number; reset: number }>();
  constructor(private max: number, private windowMs: number) {}
  check(key: string) {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.reset < now) {
      this.hits.set(key, { count: 1, reset: now + this.windowMs });
      if (this.hits.size > 10_000) this.hits.clear();
      return;
    }
    h.count++;
    if (h.count > this.max) throw new AppError(429, 'TOO_MANY_REQUESTS', 'Demasiados intentos. Espera unos minutos.');
  }
}
