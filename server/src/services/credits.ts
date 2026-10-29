import type { AppContext } from '../context.js';
import type { Queryable } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { marketFromPhone } from '../lib/phone.js';
import type { MessageRow } from '../types.js';

export type PriceCategory = 'marketing' | 'utility' | 'authentication' | 'service';

/**
 * Money columns hold 6 decimals. Every amount is rounded here, once, before it is
 * stored or used, so the database never rounds a charge and its refund differently.
 */
export function roundMoney(n: number): number {
  return Math.round(Number(n) * 1e6) / 1e6;
}

/** Maps Meta pricing categories (webhooks / templates) to our rate card categories. */
export function normalizeCategory(raw: string | null | undefined): PriceCategory | null {
  const c = (raw ?? '').toLowerCase();
  if (c.startsWith('marketing')) return 'marketing';
  if (c.startsWith('utility')) return 'utility';
  if (c.startsWith('authentication')) return 'authentication';
  if (c === 'service' || c === 'user_initiated' || c === 'business_initiated') return 'service';
  return null; // referral_conversion and others are free
}

export async function getRate(q: Queryable, phone: string, category: PriceCategory): Promise<number> {
  const market = marketFromPhone(phone);
  const { rows } = await q.query<{ market: string; price: number }>(
    `SELECT market, price FROM rate_card WHERE category = $1 AND market IN ($2, 'OTHER')`,
    [category, market],
  );
  const exact = rows.find((r) => r.market === market) ?? rows.find((r) => r.market === 'OTHER');
  return exact ? roundMoney(exact.price) : 0;
}

interface LedgerOpts {
  description?: string;
  messageId?: string | null;
  broadcastId?: string | null;
  userId?: string | null;
}

interface WalletOpts {
  /**
   * Whether the prepaid wallet pays: pass the mode the message was sent under
   * (messages.charged_prepaid), never the workspace's current mode, so switching
   * billing_mode cannot create or lose credits. Omitted: the current mode.
   */
  prepaid?: boolean;
}

/**
 * Debits credits. When the wallet pays it fails if the balance is not enough
 * (unless force: the message was already delivered and Meta billed it).
 * In meta_direct mode Meta bills the business directly: we only record the spend.
 * Returns whether the prepaid balance was debited.
 */
export async function charge(
  q: Queryable,
  workspaceId: string,
  amount: number,
  opts: LedgerOpts & WalletOpts & { force?: boolean } = {},
): Promise<boolean> {
  amount = roundMoney(amount);
  if (amount <= 0) return false;
  const { rows } = await q.query<{ credit_balance: number; prepaid: boolean }>(
    `UPDATE workspaces SET credit_balance = CASE WHEN COALESCE($4::boolean, billing_mode = 'prepaid') THEN credit_balance - $2 ELSE credit_balance END
     WHERE id = $1 AND (NOT COALESCE($4::boolean, billing_mode = 'prepaid') OR credit_balance >= $2 OR $3)
     RETURNING credit_balance, COALESCE($4::boolean, billing_mode = 'prepaid') AS prepaid`,
    [workspaceId, amount, !!opts.force, opts.prepaid ?? null],
  );
  if (!rows[0]) {
    throw new AppError(402, 'INSUFFICIENT_CREDITS', 'No tienes créditos suficientes para enviar este mensaje. Recarga tu saldo.');
  }
  await insertLedger(q, workspaceId, -amount, rows[0].credit_balance, 'charge', opts);
  return rows[0].prepaid;
}

export async function refund(q: Queryable, workspaceId: string, amount: number, opts: LedgerOpts & WalletOpts = {}) {
  amount = roundMoney(amount);
  if (amount <= 0) return;
  const { rows } = await q.query<{ credit_balance: number }>(
    `UPDATE workspaces SET credit_balance = CASE WHEN COALESCE($3::boolean, billing_mode = 'prepaid') THEN credit_balance + $2 ELSE credit_balance END
     WHERE id = $1 RETURNING credit_balance`,
    [workspaceId, amount, opts.prepaid ?? null],
  );
  await insertLedger(q, workspaceId, amount, rows[0]?.credit_balance ?? 0, 'refund', opts);
}

export async function topup(q: Queryable, workspaceId: string, amount: number, opts: LedgerOpts = {}) {
  amount = roundMoney(amount);
  const { rows } = await q.query<{ credit_balance: number }>(
    `UPDATE workspaces SET credit_balance = credit_balance + $2 WHERE id = $1 RETURNING credit_balance`,
    [workspaceId, amount],
  );
  if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'Espacio de trabajo no encontrado');
  await insertLedger(q, workspaceId, amount, rows[0].credit_balance, amount >= 0 ? 'topup' : 'adjustment', opts);
  return rows[0].credit_balance;
}

async function insertLedger(q: Queryable, workspaceId: string, amount: number, balanceAfter: number, kind: string, o: LedgerOpts) {
  await q.query(
    `INSERT INTO credit_ledger (workspace_id, amount, balance_after, kind, description, message_id, broadcast_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [workspaceId, amount, balanceAfter, kind, o.description ?? null, o.messageId ?? null, o.broadcastId ?? null, o.userId ?? null],
  );
}

const creditsNotify = new Map<string, { last: number; timer: NodeJS.Timeout | null }>();
const CREDITS_NOTIFY_MS = 2000;

/**
 * Tells the workspace's clients that the balance or spend changed (the sidebar refetches).
 * Throttled per workspace so a broadcast does not trigger one refetch per message; a
 * trailing event always follows the last change.
 */
export function notifyCredits(ctx: AppContext, workspaceId: string): void {
  const now = Date.now();
  const st = creditsNotify.get(workspaceId) ?? { last: 0, timer: null };
  creditsNotify.set(workspaceId, st);
  if (now - st.last >= CREDITS_NOTIFY_MS) {
    st.last = now;
    ctx.realtime.emit(workspaceId, 'credits:update', {});
    return;
  }
  if (st.timer) return;
  st.timer = setTimeout(() => {
    st.timer = null;
    st.last = Date.now();
    ctx.realtime.emit(workspaceId, 'credits:update', {});
  }, CREDITS_NOTIFY_MS - (now - st.last));
  st.timer.unref?.();
  if (creditsNotify.size > 5000) {
    for (const [k, v] of creditsNotify) if (!v.timer) creditsNotify.delete(k);
  }
}

export interface MetaPricing {
  billable?: boolean;
  category?: string;
  pricing_model?: string;
  type?: string;
}

/**
 * Adjusts what we charged at send time to what Meta actually bills, using the
 * pricing object Meta includes in status webhooks. Runs once per message.
 * Without pricing (failed message) the estimated charge is refunded. The wallet is
 * touched only for messages it paid for (charged_prepaid), whatever the current mode.
 */
export async function reconcilePricing(
  ctx: AppContext,
  q: Queryable,
  msg: MessageRow,
  phone: string,
  pricing: MetaPricing | null,
): Promise<void> {
  if (msg.pricing_reconciled) return;
  let actual = 0;
  let category = msg.billing_category;
  if (pricing) {
    const c = normalizeCategory(pricing.category);
    category = c ?? pricing.category ?? category;
    actual = pricing.billable && c ? await getRate(q, phone, c) : 0;
  }
  const diff = roundMoney(actual - Number(msg.cost));
  const opts = { messageId: msg.id, broadcastId: msg.broadcast_id, prepaid: !!msg.charged_prepaid };
  if (diff > 0) {
    await charge(q, msg.workspace_id, diff, { ...opts, force: true, description: `Ajuste Meta (${category})` });
  } else if (diff < 0) {
    await refund(q, msg.workspace_id, -diff, {
      ...opts,
      description: pricing ? `Ajuste Meta: ${pricing.billable ? category : 'no cobrable'}` : 'Reembolso: mensaje no entregado',
    });
  }
  await q.query(`UPDATE messages SET cost = $2, billing_category = $3, pricing_reconciled = true WHERE id = $1`, [
    msg.id,
    actual,
    category,
  ]);
  if (diff !== 0) notifyCredits(ctx, msg.workspace_id);
}
