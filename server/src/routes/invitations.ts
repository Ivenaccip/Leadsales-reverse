import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Queryable } from '../db/index.js';
import { hashPassword } from '../lib/auth.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { clientNet, lockSignups, newPasswordSchema, sessionResponse, startSession } from './auth.js';
import { ADMIN_ROLES, idParams, noContent, parse, RateLimiter, requireUser, requireWs, type WsAuth } from './helpers.js';

/**
 * Team invitations. Accounts are global (one per email) and nobody verifies emails, so a
 * workspace never attaches an account by email: it hands out a one-time link and only the
 * person who opens it (signed in with that email, or creating that account) joins.
 */

const INVITE_DAYS = 7;

interface InvitationRow {
  id: string;
  workspace_id: string;
  workspace_name: string;
  email: string;
  name: string | null;
  role: 'admin' | 'agent';
  expires_at: Date;
}

const tokenParams = z.object({ token: z.string().min(20).max(128).regex(/^[A-Za-z0-9_-]+$/) });

const invalid = () => new AppError(404, 'INVITATION_INVALID', 'Esta invitación no existe, ya se usó, se canceló o expiró. Pide una nueva.');

/** Creates a pending invitation (replacing any pending one for that email) and returns its link. */
export async function createInvitation(ctx: AppContext, a: WsAuth, input: { email: string; name?: string | null; role: 'admin' | 'agent' }) {
  const token = randomToken(32);
  const invitation = await ctx.db.tx(async (q) => {
    await q.query(
      `UPDATE invitations SET revoked_at = now() WHERE workspace_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [a.workspaceId, input.email],
    );
    const { rows } = await q.query<{ id: string; email: string; role: string; expires_at: Date }>(
      `INSERT INTO invitations (workspace_id, email, name, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7)) RETURNING id, email, role, expires_at`,
      [a.workspaceId, input.email, input.name ?? null, input.role, sha256Hex(token), a.user.id, INVITE_DAYS],
    );
    return rows[0];
  });
  return { invitation, invite_url: `${ctx.config.publicUrl}/invitacion/${token}` };
}

async function pendingInvitation(q: Queryable, token: string, forUpdate = false): Promise<InvitationRow> {
  const { rows } = await q.query<InvitationRow>(
    `SELECT i.id, i.workspace_id, w.name AS workspace_name, i.email, i.name, i.role, i.expires_at
     FROM invitations i JOIN workspaces w ON w.id = i.workspace_id
     WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
     ${forUpdate ? 'FOR UPDATE OF i' : ''}`,
    [sha256Hex(token)],
  );
  if (!rows[0]) throw invalid();
  return rows[0];
}

/** Uses up the invitation and adds (or reactivates) the membership; an owner is never demoted by it. */
async function joinWorkspace(q: Queryable, inv: InvitationRow, userId: string) {
  await q.query(`UPDATE invitations SET accepted_at = now(), accepted_by = $2 WHERE id = $1`, [inv.id, userId]);
  await q.query(
    `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET is_active = true,
       role = CASE WHEN memberships.role = 'owner' THEN 'owner' ELSE EXCLUDED.role END`,
    [inv.workspace_id, userId, inv.role],
  );
}

export async function invitationRoutes(app: FastifyInstance, ctx: AppContext) {
  const registerLimiter = new RateLimiter(10, 15 * 60 * 1000);

  app.get('/api/workspace/invitations', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { rows } = await ctx.db.query(
      `SELECT i.id, i.email, i.name, i.role, i.created_at, i.expires_at, u.name AS invited_by_name
       FROM invitations i LEFT JOIN users u ON u.id = i.invited_by
       WHERE i.workspace_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
       ORDER BY i.created_at DESC`,
      [a.workspaceId],
    );
    return { invitations: rows };
  });

  app.delete('/api/workspace/invitations/:id', async (req, reply) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(idParams, req.params);
    const { rows } = await ctx.db.query(
      `UPDATE invitations SET revoked_at = now() WHERE id = $1 AND workspace_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`,
      [id, a.workspaceId],
    );
    if (!rows[0]) throw notFound('Invitación');
    return noContent(reply);
  });

  app.get('/api/invitations/:token', async (req) => {
    const { token } = parse(tokenParams, req.params);
    const inv = await pendingInvitation(ctx.db, token);
    const exists = await ctx.db.query(`SELECT 1 FROM users WHERE email = $1`, [inv.email]);
    return { workspace_name: inv.workspace_name, email: inv.email, role: inv.role, expires_at: inv.expires_at, account_exists: !!exists.rows[0] };
  });

  app.post('/api/invitations/:token/accept', async (req) => {
    const user = await requireUser(ctx, req);
    const { token } = parse(tokenParams, req.params);
    const workspaceId = await ctx.db.tx(async (q) => {
      const inv = await pendingInvitation(q, token, true);
      if (inv.email.toLowerCase() !== user.email.toLowerCase()) {
        throw new AppError(403, 'INVITATION_EMAIL_MISMATCH', `Esta invitación es para ${inv.email}. Entra con esa cuenta para aceptarla.`);
      }
      await joinWorkspace(q, inv, user.id);
      return inv.workspace_id;
    });
    return { workspace_id: workspaceId };
  });

  // Creates the invited account (works even with ALLOW_SIGNUP=false) and signs it in.
  app.post('/api/invitations/:token/register', async (req, reply) => {
    registerLimiter.hit(clientNet(req.ip));
    const { token } = parse(tokenParams, req.params);
    const body = parse(z.object({ name: z.string().trim().min(2, 'Escribe tu nombre').max(120), password: newPasswordSchema }), req.body);
    await pendingInvitation(ctx.db, token); // fail fast before paying for bcrypt
    const hash = await hashPassword(body.password);
    const { userId, workspaceId } = await ctx.db.tx(async (q) => {
      await lockSignups(q);
      const inv = await pendingInvitation(q, token, true);
      const exists = await q.query(`SELECT 1 FROM users WHERE email = $1`, [inv.email]);
      if (exists.rows[0]) throw conflict('Ya existe una cuenta con ese correo: inicia sesión para aceptar la invitación', 'EMAIL_TAKEN');
      const u = await q.query<{ id: string }>(`INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id`, [
        inv.email,
        hash,
        body.name,
      ]);
      await joinWorkspace(q, inv, u.rows[0].id);
      return { userId: u.rows[0].id, workspaceId: inv.workspace_id };
    });
    await startSession(ctx, req, reply, userId);
    return { ...(await sessionResponse(ctx, userId)), workspace_id: workspaceId };
  });
}
