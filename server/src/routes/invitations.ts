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
 * Whoever holds the link can create the account, the inviting admin included: an account that
 * someone else created for your email is recovered by the instance operator (docs/04).
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

/** Revokes the workspace's pending invitations for an email (or for a user's email). */
export async function revokePendingInvitations(q: Queryable, workspaceId: string, who: { email: string } | { userId: string }) {
  await q.query(
    `UPDATE invitations SET revoked_at = now()
     WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
       AND email = ${'email' in who ? '$2' : '(SELECT email FROM users WHERE id = $2)'}`,
    [workspaceId, 'email' in who ? who.email : who.userId],
  );
}

/** Creates a pending invitation (replacing any pending one for that email) and returns its link. */
export async function createInvitation(ctx: AppContext, a: WsAuth, input: { email: string; name?: string | null; role: 'admin' | 'agent' }) {
  const token = randomToken(32);
  const invitation = await ctx.db.tx(async (q) => {
    // Two invitations created at once must not both stay pending.
    await q.query(`SELECT pg_advisory_xact_lock(724202, hashtext($1))`, [`${a.workspaceId}|${input.email}`]);
    await revokePendingInvitations(q, a.workspaceId, { email: input.email });
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

/**
 * Uses up the invitation (and any other pending one for that email here) and adds the membership.
 * An existing membership is never changed: reactivating or promoting someone is an explicit admin
 * action that an old link must not undo.
 */
async function joinWorkspace(q: Queryable, inv: InvitationRow, userId: string) {
  const member = await q.query<{ is_active: boolean }>(`SELECT is_active FROM memberships WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE`, [
    inv.workspace_id,
    userId,
  ]);
  if (member.rows[0] && !member.rows[0].is_active) {
    throw new AppError(409, 'MEMBER_DEACTIVATED', 'Tu usuario está desactivado en este espacio de trabajo. Pide a un administrador que lo reactive.');
  }
  await q.query(`UPDATE invitations SET accepted_at = now(), accepted_by = $2 WHERE id = $1`, [inv.id, userId]);
  await revokePendingInvitations(q, inv.workspace_id, { email: inv.email });
  if (!member.rows[0]) {
    await q.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, user_id) DO NOTHING`, [
      inv.workspace_id,
      userId,
      inv.role,
    ]);
  }
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

  // Public preview. It does not say whether the email has an account: the inviting admin holds the
  // link and could ask it about any email.
  app.get('/api/invitations/:token', async (req) => {
    const { token } = parse(tokenParams, req.params);
    const inv = await pendingInvitation(ctx.db, token);
    return { workspace_name: inv.workspace_name, email: inv.email, role: inv.role, expires_at: inv.expires_at };
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
    // The account's other open tabs learn about the new workspace too.
    ctx.realtime.refreshUsers([user.id], workspaceId);
    return { workspace_id: workspaceId };
  });

  // Creates the invited account (works even with ALLOW_SIGNUP=false) and signs it in.
  app.post('/api/invitations/:token/register', async (req, reply) => {
    registerLimiter.hit(clientNet(req.ip));
    const { token } = parse(tokenParams, req.params);
    const body = parse(z.object({ name: z.string().trim().min(2, 'Escribe tu nombre').max(120), password: newPasswordSchema }), req.body);
    await pendingInvitation(ctx.db, token); // fail fast before paying for bcrypt
    const hash = await hashPassword(body.password);
    const { userId, version, workspaceId } = await ctx.db.tx(async (q) => {
      await lockSignups(q);
      const inv = await pendingInvitation(q, token, true);
      const exists = await q.query(`SELECT 1 FROM users WHERE email = $1`, [inv.email]);
      if (exists.rows[0]) {
        throw conflict(
          'Ya existe una cuenta con ese correo: inicia sesión para aceptar la invitación. Si tú no la creaste, pide al administrador de la instancia que la restablezca.',
          'EMAIL_TAKEN',
        );
      }
      const u = await q.query<{ id: string; password_version: number }>(
        `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, password_version`,
        [inv.email, hash, body.name],
      );
      await joinWorkspace(q, inv, u.rows[0].id);
      return { userId: u.rows[0].id, version: u.rows[0].password_version, workspaceId: inv.workspace_id };
    });
    await startSession(ctx, req, reply, userId, version);
    return { ...(await sessionResponse(ctx, userId)), workspace_id: workspaceId };
  });
}
