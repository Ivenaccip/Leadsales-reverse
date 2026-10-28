import type { AppContext } from '../context.js';
import type { Queryable } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { marketFromPhone } from '../lib/phone.js';
import type { MessageRow } from '../types.js';

export type PriceCategory = 'marketing' | 'utility' | 'authentication' | 'service';

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
  return exact ? Number(exact.price) : 0;
}

interface LedgerOpts {
  description?: string;
  messageId?: string | null;
  broadcastId?: string | null;
  userId?: string | null;
}

/**
 * Debits credits. In prepaid mode it fails when the balance is not enough
 * (unless force: the message was already delivered and Meta billed it).
 * In meta_direct mode Meta bills the business directly: we only record the spend.
 */
export async function charge(q: Queryable, workspaceId: string, amount: number, opts: LedgerOpts & { force?: boolean } = {}) {
  if (amount <= 0) return;
  const { rows } = await q.query<{ credit_balance: number; billing_mode: string }>(
    `UPDATE workspaces SET credit_balance = CASE WHEN billing_mode = 'prepaid' THEN credit_balance - $2 ELSE credit_balance END
     WHERE id = $1 AND (billing_mode <> 'prepaid' OR credit_balance >= $2 OR $3)
     RETURNING credit_balance, billing_mode`,
    [workspaceId, amount, !!opts.force],
  );
  if (!rows[0]) {
    throw new AppError(402, 'INSUFFICIENT_CREDITS', 'No tienes créditos suficientes para enviar este mensaje. Recarga tu saldo.');
  }
  await insertLedger(q, workspaceId, -amount, rows[0].credit_balance, 'charge', opts);
}

export async function refund(q: Queryable, workspaceId: string, amount: number, opts: LedgerOpts = {}) {
  if (amount <= 0) return;
  const { rows } = await q.query<{ credit_balance: number }>(
    `UPDATE workspaces SET credit_balance = CASE WHEN billing_mode = 'prepaid' THEN credit_balance + $2 ELSE credit_balance END
     WHERE id = $1 RETURNING credit_balance`,
    [workspaceId, amount],
  );
  await insertLedger(q, workspaceId, amount, rows[0]?.credit_balance ?? 0, 'refund', opts);
}

export async function topup(q: Queryable, workspaceId: string, amount: number, opts: LedgerOpts = {}) {
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

export interface MetaPricing {
  billable?: boolean;
  category?: string;
  pricing_model?: string;
  type?: string;
}

/**
 * Adjusts what we charged at send time to what Meta actually bills, using the
 * pricing object Meta includes in status webhooks. Runs once per message.
 * Without pricing (failed message) the estimated charge is refunded.
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
  const diff = Math.round((actual - Number(msg.cost)) * 10000) / 10000;
  const opts = { messageId: msg.id, broadcastId: msg.broadcast_id };
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
  if (diff !== 0) ctx.realtime.emit(msg.workspace_id, 'credits:update', { delta: -diff });
}
