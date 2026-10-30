import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Queryable } from '../db/index.js';
import { hashPassword } from '../lib/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { topup } from '../services/credits.js';
import { newPasswordSchema } from './auth.js';
import type { ChannelRow } from '../types.js';
import { disableUnverifiedCloudChannels, enableAfterPrepaid, resyncTemplates } from './channels.js';
import { noContent, parse, requireSuperadmin, requireSuperadminSession, uuid, verifyCurrentPassword } from './helpers.js';

const MARKETS = ['MX', 'CO', 'BR', 'AR', 'CL', 'PE', 'ES', 'NA', 'LATAM', 'OTHER'];

/** Panel of the instance operator (the community admin): workspaces, credits and Meta rates. */
export async function adminRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/admin/overview', async (req) => {
    await requireSuperadmin(ctx, req);
    const { rows } = await ctx.db.query(
      `SELECT (SELECT count(*)::int FROM workspaces) AS workspaces, (SELECT count(*)::int FROM users) AS users,
         (SELECT count(*)::int FROM channels WHERE provider = 'cloud_api') AS channels,
         (SELECT count(*)::int FROM messages WHERE created_at >= date_trunc('month', now())) AS messages_this_month,
         (SELECT COALESCE(-sum(amount), 0)::float FROM credit_ledger WHERE kind IN ('charge', 'refund') AND created_at >= date_trunc('month', now())) AS spend_this_month,
         (SELECT count(*)::int FROM jobs WHERE status = 'failed' AND finished_at > now() - interval '1 day') AS failed_jobs_24h,
         (SELECT count(*)::int FROM jobs WHERE status = 'queued' AND run_at < now() - interval '5 minutes') AS delayed_jobs`,
    );
    return rows[0];
  });

  app.get('/api/admin/workspaces', async (req) => {
    await requireSuperadmin(ctx, req);
    const { rows } = await ctx.db.query(
      `SELECT w.id, w.name, w.billing_mode, w.credit_balance::float AS credit_balance, w.is_active, w.created_at,
         (SELECT count(*)::int FROM memberships m WHERE m.workspace_id = w.id) AS members,
         (SELECT count(*)::int FROM contacts c WHERE c.workspace_id = w.id) AS contacts,
         (SELECT count(*)::int FROM channels ch WHERE ch.workspace_id = w.id) AS channels,
         (SELECT COALESCE(-sum(amount), 0)::float FROM credit_ledger l WHERE l.workspace_id = w.id AND l.kind IN ('charge', 'refund')
            AND l.created_at >= date_trunc('month', now())) AS spend_this_month,
         (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = w.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1) AS owner_email
       FROM workspaces w ORDER BY w.created_at DESC`,
    );
    return { workspaces: rows };
  });

  app.patch('/api/admin/workspaces/:id', async (req) => {
    await requireSuperadmin(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ billing_mode: z.enum(['meta_direct', 'prepaid']).optional(), is_active: z.boolean().optional() }), req.body);
    const { rows } = await ctx.db.query(
      `UPDATE workspaces SET billing_mode = COALESCE($2, billing_mode), is_active = COALESCE($3, is_active) WHERE id = $1
       RETURNING id, name, billing_mode, is_active, credit_balance::float AS credit_balance`,
      [id, body.billing_mode ?? null, body.is_active ?? null],
    );
    if (!rows[0]) throw badRequest('Espacio no encontrado');
    const warnings: string[] = [];
    if (body.billing_mode === 'prepaid') {
      await disableUnverifiedCloudChannels(ctx, id);
      // The numbers still on now price from their template categories: read them from Meta again.
      const verified = await ctx.db.query<ChannelRow>(
        `SELECT * FROM channels WHERE workspace_id = $1 AND provider = 'cloud_api' AND operator_verified AND status <> 'disabled'`,
        [id],
      );
      warnings.push(...(await resyncTemplates(ctx, verified.rows)));
    }
    if (body.billing_mode === 'meta_direct') await enableAfterPrepaid(ctx, id);
    // Every member's tabs reload the workspace (suspended or back, billing mode), wherever they are.
    const members = await ctx.db.query<{ user_id: string }>(`SELECT user_id FROM memberships WHERE workspace_id = $1`, [id]);
    const memberIds = members.rows.map((m) => m.user_id);
    if (body.is_active === false) await ctx.realtime.evict(id, undefined, memberIds);
    else ctx.realtime.refreshUsers(memberIds, id);
    return { workspace: rows[0], warnings };
  });

  app.post('/api/admin/workspaces/:id/credits', async (req) => {
    const admin = await requireSuperadmin(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(
      z.object({ amount: z.number().refine((n) => n !== 0 && Math.abs(n) <= 1_000_000, 'Monto inválido'), description: z.string().max(200).optional() }),
      req.body,
    );
    const balance = await ctx.db.tx((q) =>
      topup(q, id, body.amount, { userId: admin.id, description: body.description ?? (body.amount > 0 ? 'Recarga de créditos' : 'Ajuste de créditos') }),
    );
    ctx.realtime.emit(id, 'credits:update', { balance });
    return { balance };
  });

  app.get('/api/admin/rates', async (req) => {
    await requireSuperadmin(ctx, req);
    const { rows } = await ctx.db.query(`SELECT market, category, price::float AS price, updated_at FROM rate_card ORDER BY market, category`);
    return { rates: rows, markets: MARKETS };
  });

  app.put('/api/admin/rates', async (req) => {
    await requireSuperadmin(ctx, req);
    const body = parse(
      z.object({
        rates: z
          .array(
            z.object({
              market: z.enum(MARKETS as [string, ...string[]]),
              category: z.enum(['marketing', 'utility', 'authentication', 'service']),
              price: z.number().min(0).max(10),
            }),
          )
          .min(1),
      }),
      req.body,
    );
    await ctx.db.tx(async (q) => {
      for (const r of body.rates) {
        await q.query(
          `INSERT INTO rate_card (market, category, price, updated_at) VALUES ($1, $2, $3, now())
           ON CONFLICT (market, category) DO UPDATE SET price = EXCLUDED.price, updated_at = now()`,
          [r.market, r.category, r.price],
        );
      }
    });
    return { ok: true };
  });

  app.get('/api/admin/users', async (req) => {
    await requireSuperadmin(ctx, req);
    const { rows } = await ctx.db.query(
      `SELECT u.id, u.email, u.name, u.is_superadmin, u.created_at,
         (SELECT count(*)::int FROM memberships m WHERE m.user_id = u.id) AS workspaces,
         (SELECT string_agg(w.name, ', ' ORDER BY w.name) FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = u.id) AS workspace_names
       FROM users u ORDER BY u.created_at`,
    );
    return { users: rows };
  });

  // Operator rights and other accounts' passwords need the operator's current password: a stolen
  // operator session must not demote an operator (and then reset its password), nor promote an
  // account of its own into a lasting backdoor.
  app.patch('/api/admin/users/:id', async (req) => {
    const s = await requireSuperadminSession(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ is_superadmin: z.boolean(), currentPassword: z.string().max(1024).optional() }), req.body);
    if (id === s.user.id && !body.is_superadmin) throw badRequest('No puedes quitarte a ti mismo el rol de administrador');
    await accountOf(ctx, id);
    await verifyCurrentPassword(ctx, s, body.currentPassword);
    await ctx.db.tx(async (q) => {
      await lockOperators(q, s.user.id);
      // Two operators demoting each other at once: the second one is no operator any more here.
      if (!body.is_superadmin) {
        const others = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE is_superadmin AND id <> $1`, [id]);
        if (!others.rows[0].n) throw badRequest('La instancia debe conservar al menos un administrador', 'LAST_OPERATOR');
      }
      const r = await q.query(`UPDATE users SET is_superadmin = $2 WHERE id = $1 RETURNING id`, [id, body.is_superadmin]);
      if (!r.rows[0]) throw notFound('Usuario');
    });
    // Open sockets joined foreign workspaces as superadmin: make them re-join with the new rights.
    // A promotion reaches every tab too (the Administración menu, foreign workspaces).
    if (!body.is_superadmin) await ctx.realtime.evictUser(id);
    else ctx.realtime.refreshUsers([id]);
    return { ok: true };
  });

  // Account recovery. Emails are not verified, so whoever holds an invitation link (the inviting
  // admin too) can create the account for that email; the real person asks the operator, who
  // checks the account's workspaces and sets a temporary password or deletes it.
  app.post('/api/admin/users/:id/password', async (req) => {
    const s = await requireSuperadminSession(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ password: newPasswordSchema, currentPassword: z.string().max(1024).optional() }), req.body);
    const target = await accountOf(ctx, id);
    // Operators change their own password from their profile, with the current one.
    if (id === s.user.id || target.is_superadmin) throw badRequest('La contraseña de un administrador de la instancia solo la cambia su dueño, desde su perfil');
    await verifyCurrentPassword(ctx, s, body.currentPassword);
    const hash = await hashPassword(body.password);
    await ctx.db.tx(async (q) => {
      // Both checks again, now that nothing can change them: the caller may have been demoted, or
      // the target promoted, while the password was being verified.
      await lockOperators(q, s.user.id);
      const r = await q.query(
        `UPDATE users SET password_hash = $2, password_version = password_version + 1 WHERE id = $1 AND NOT is_superadmin RETURNING id`,
        [id, hash],
      );
      if (!r.rows[0]) throw badRequest('La contraseña de un administrador de la instancia solo la cambia su dueño, desde su perfil');
      await q.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
    });
    await ctx.realtime.endSessions({ userId: id });
    return { ok: true };
  });

  app.delete('/api/admin/users/:id', async (req, reply) => {
    const me = await requireSuperadmin(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const target = await accountOf(ctx, id);
    if (id === me.id) throw badRequest('No puedes borrar tu propia cuenta');
    if (target.is_superadmin) throw badRequest('Quítale primero el rol de administrador de la instancia');
    // Only an account outside every workspace: nobody loses a teammate (or a last owner) by accident.
    const { rows } = await ctx.db.query(
      `DELETE FROM users u WHERE u.id = $1 AND NOT u.is_superadmin AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id) RETURNING id`,
      [id],
    );
    if (!rows[0]) throw conflict('Esta cuenta es miembro de algún espacio de trabajo: quítala de sus espacios antes de borrarla', 'USER_HAS_WORKSPACES');
    await ctx.realtime.endSessions({ userId: id });
    return noContent(reply);
  });
}

/**
 * Locks every operator row (in one order) and checks that the caller still is one. Changes to
 * operator rights then run one at a time: what a request checked before its password step-up
 * (bcrypt takes a while) may no longer hold.
 */
async function lockOperators(q: Queryable, callerId: string) {
  const { rows } = await q.query<{ id: string }>(`SELECT id FROM users WHERE is_superadmin ORDER BY id FOR UPDATE`);
  if (!rows.some((r) => r.id === callerId)) throw forbidden('Solo el administrador de la instancia puede hacer esto');
}

async function accountOf(ctx: AppContext, id: string) {
  const { rows } = await ctx.db.query<{ is_superadmin: boolean }>(`SELECT is_superadmin FROM users WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound('Usuario');
  return rows[0];
}
