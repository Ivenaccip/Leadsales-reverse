import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest } from '../lib/errors.js';
import { topup } from '../services/credits.js';
import { disableUnverifiedCloudChannels } from './channels.js';
import { parse, requireSuperadmin, uuid } from './helpers.js';

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
    if (body.billing_mode === 'prepaid') await disableUnverifiedCloudChannels(ctx, id);
    if (body.is_active === false) await ctx.realtime.evict(id);
    return { workspace: rows[0] };
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
         (SELECT count(*)::int FROM memberships m WHERE m.user_id = u.id) AS workspaces
       FROM users u ORDER BY u.created_at`,
    );
    return { users: rows };
  });

  app.patch('/api/admin/users/:id', async (req) => {
    const me = await requireSuperadmin(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ is_superadmin: z.boolean() }), req.body);
    if (id === me.id && !body.is_superadmin) throw badRequest('No puedes quitarte a ti mismo el rol de administrador');
    await ctx.db.query(`UPDATE users SET is_superadmin = $2 WHERE id = $1`, [id, body.is_superadmin]);
    // Open sockets joined foreign workspaces as superadmin: make them re-join with the new rights.
    if (!body.is_superadmin) await ctx.realtime.evictUser(id);
    return { ok: true };
  });
}
