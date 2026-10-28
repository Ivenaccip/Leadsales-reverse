import type { AppContext } from '../context.js';
import type { Queryable } from '../db/index.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { marketFromPhone } from '../lib/phone.js';
import type { ContactRow } from '../types.js';
import { getChannel } from '../whatsapp/provider.js';
import type { TemplateParams } from '../whatsapp/types.js';
import { normalizeCategory } from './credits.js';
import { dispatchWebhook } from './events.js';
import { sendMessage } from './messages.js';
import { findTemplate } from './templates.js';

export interface Audience {
  funnel_id?: string | null;
  stage_ids?: string[];
  tag_ids?: string[];
  exclude_tag_ids?: string[];
  assigned_user_id?: string | null;
  created_from?: string | null;
  created_to?: string | null;
  contact_ids?: string[];
}

/** Values may contain placeholders: {nombre} {primer_nombre} {telefono} {correo} {empresa} {campo.clave} and a default: {primer_nombre|amigo}. */
export interface BroadcastParams {
  header?: { type: 'text'; value: string } | { type: 'image' | 'video' | 'document'; link: string; filename?: string };
  body?: string[];
  bodyNamed?: Record<string, string>;
  buttons?: { index: number; value: string }[];
}

export interface BroadcastRow {
  id: string;
  workspace_id: string;
  channel_id: string | null;
  name: string;
  template_name: string;
  template_language: string;
  template_category: string;
  params: BroadcastParams;
  audience: Audience;
  status: string;
  scheduled_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  last_error: string | null;
  total_recipients: number;
  estimated_cost: number;
  created_by: string | null;
  created_at: Date;
}

const KNOWN_KEYS = new Set(['nombre', 'primer_nombre', 'telefono', 'correo', 'empresa']);
const PLACEHOLDER = /\{([a-z_]+(?:\.[A-Za-z0-9_]+)?)(?:\|([^}]*))?\}/g;

export function renderPlaceholders(
  template: string,
  c: Pick<ContactRow, 'name' | 'phone' | 'email' | 'company' | 'custom_fields'>,
  singleLine = true,
): string {
  const out = template.replace(PLACEHOLDER, (match, key: string, def?: string) => {
    if (!KNOWN_KEYS.has(key) && !key.startsWith('campo.')) return match;
    let v = '';
    if (key === 'nombre') v = c.name ?? '';
    else if (key === 'primer_nombre') v = (c.name ?? '').trim().split(/\s+/)[0] ?? '';
    else if (key === 'telefono') v = `+${c.phone}`;
    else if (key === 'correo') v = c.email ?? '';
    else if (key === 'empresa') v = c.company ?? '';
    else if (key.startsWith('campo.')) v = String((c.custom_fields ?? {})[key.slice(6)] ?? '');
    v = v.trim();
    return v || (def ?? (key.includes('nombre') ? 'cliente' : '-'));
  });
  if (!singleLine) return out;
  // Meta rejects empty template parameters and parameters with newlines/tabs or 4+ spaces.
  return out.replace(/[\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim() || '-';
}

export function resolveParams(p: BroadcastParams, c: ContactRow): TemplateParams {
  const out: TemplateParams = {};
  if (p.header) {
    out.header = p.header.type === 'text' ? { type: 'text', text: renderPlaceholders(p.header.value, c) } : { ...p.header };
  }
  if (p.bodyNamed && Object.keys(p.bodyNamed).length) {
    out.bodyNamed = Object.fromEntries(Object.entries(p.bodyNamed).map(([k, v]) => [k, renderPlaceholders(v, c)]));
  } else if (p.body?.length) {
    out.body = p.body.map((v) => renderPlaceholders(v, c));
  }
  if (p.buttons?.length) out.buttons = p.buttons.map((b) => ({ index: b.index, text: renderPlaceholders(b.value, c) }));
  return out;
}

/** WHERE clause for an audience; returns SQL using parameters starting at $2 ($1 = workspace id). */
export function audienceWhere(a: Audience): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const conds = ['c.workspace_id = $1', 'NOT c.opted_out'];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length + 1}`;
  };
  if (a.contact_ids?.length) conds.push(`c.id = ANY(${p(a.contact_ids)}::uuid[])`);
  if (a.funnel_id) conds.push(`c.funnel_id = ${p(a.funnel_id)}::uuid`);
  if (a.stage_ids?.length) conds.push(`c.stage_id = ANY(${p(a.stage_ids)}::uuid[])`);
  if (a.tag_ids?.length) conds.push(`EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_id = c.id AND ct.tag_id = ANY(${p(a.tag_ids)}::uuid[]))`);
  if (a.exclude_tag_ids?.length) {
    conds.push(`NOT EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_id = c.id AND ct.tag_id = ANY(${p(a.exclude_tag_ids)}::uuid[]))`);
  }
  if (a.assigned_user_id) conds.push(`c.assigned_user_id = ${p(a.assigned_user_id)}::uuid`);
  if (a.created_from) conds.push(`c.created_at >= ${p(a.created_from)}::timestamptz`);
  if (a.created_to) conds.push(`c.created_at < (${p(a.created_to)}::date + 1)`);
  return { sql: conds.join(' AND '), params };
}

export async function getBroadcast(q: Queryable, workspaceId: string, id: string): Promise<BroadcastRow> {
  const { rows } = await q.query<BroadcastRow>(`SELECT * FROM broadcasts WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]);
  if (!rows[0]) throw notFound('Difusión');
  return rows[0];
}

export interface Estimate {
  recipients: number;
  category: string;
  cost: number;
  by_market: { market: string; count: number; unit_price: number; cost: number }[];
  billing_mode: string;
  balance: number;
  sufficient: boolean;
}

export async function estimateAudience(
  ctx: AppContext,
  workspaceId: string,
  audience: Audience,
  templateCategory: string,
): Promise<Estimate> {
  const category = normalizeCategory(templateCategory) ?? 'marketing';
  const where = audienceWhere(audience);
  const { rows } = await ctx.db.query<{ phone: string }>(`SELECT c.phone FROM contacts c WHERE ${where.sql}`, [workspaceId, ...where.params]);
  const counts = new Map<string, number>();
  for (const r of rows) {
    const m = marketFromPhone(r.phone);
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  const prices = await ctx.db.query<{ market: string; price: number }>(`SELECT market, price FROM rate_card WHERE category = $1`, [category]);
  const priceOf = (m: string) => Number(prices.rows.find((r) => r.market === m)?.price ?? prices.rows.find((r) => r.market === 'OTHER')?.price ?? 0);
  const by_market = [...counts.entries()]
    .map(([market, count]) => ({ market, count, unit_price: priceOf(market), cost: Math.round(priceOf(market) * count * 10000) / 10000 }))
    .sort((a, b) => b.count - a.count);
  const cost = Math.round(by_market.reduce((s, m) => s + m.cost, 0) * 10000) / 10000;
  const ws = await ctx.db.query<{ billing_mode: string; credit_balance: number }>(`SELECT billing_mode, credit_balance FROM workspaces WHERE id = $1`, [
    workspaceId,
  ]);
  const { billing_mode, credit_balance } = ws.rows[0];
  return {
    recipients: rows.length,
    category,
    cost,
    by_market,
    billing_mode,
    balance: Number(credit_balance),
    sufficient: billing_mode !== 'prepaid' || Number(credit_balance) >= cost,
  };
}

export async function launchBroadcast(ctx: AppContext, workspaceId: string, id: string): Promise<BroadcastRow> {
  const b = await getBroadcast(ctx.db, workspaceId, id);
  if (!['draft', 'paused', 'scheduled'].includes(b.status)) throw badRequest(`La difusión ya está en estado "${b.status}"`);
  const channel = await getChannel(ctx.db, workspaceId, b.channel_id);
  const tpl = await findTemplate(ctx.db, channel.id, b.template_name, b.template_language);
  if (!tpl) throw badRequest('La plantilla no existe en este canal. Sincroniza las plantillas.', 'TEMPLATE_NOT_FOUND');
  if (tpl.status !== 'APPROVED') throw badRequest(`La plantilla no está aprobada (estado: ${tpl.status})`, 'TEMPLATE_NOT_APPROVED');

  let est: Estimate | null = null;
  if (b.status === 'draft') {
    est = await estimateAudience(ctx, workspaceId, b.audience, tpl.category);
    if (!est.recipients) throw badRequest('La audiencia no tiene contactos (o todos se dieron de baja)', 'EMPTY_AUDIENCE');
    if (!est.sufficient) {
      throw new AppError(402, 'INSUFFICIENT_CREDITS', `Necesitas ${est.cost.toFixed(4)} créditos y tienes ${est.balance.toFixed(4)}. Recarga tu saldo.`);
    }
  }
  const future = b.scheduled_at && new Date(b.scheduled_at).getTime() > Date.now() + 5000;

  // Lock the row so two launches (double click, pause/resume) cannot both start it.
  const launched = await ctx.db.tx(async (q) => {
    const cur = await q.query<{ status: string }>(`SELECT status FROM broadcasts WHERE id = $1 AND workspace_id = $2 FOR UPDATE`, [id, workspaceId]);
    if (cur.rows[0]?.status !== b.status) return false;
    if (b.status === 'draft' && est) {
      const where = audienceWhere(b.audience);
      await q.query(
        `INSERT INTO broadcast_recipients (broadcast_id, contact_id)
         SELECT $${where.params.length + 2}::uuid, c.id FROM contacts c WHERE ${where.sql} ON CONFLICT DO NOTHING`,
        [workspaceId, ...where.params, b.id],
      );
      await q.query(
        `UPDATE broadcasts SET total_recipients = $2, estimated_cost = $3, template_category = $4, channel_id = $5 WHERE id = $1`,
        [b.id, est.recipients, est.cost, tpl.category, channel.id],
      );
    }
    await q.query(
      `UPDATE broadcasts SET status = $2, last_error = NULL, started_at = CASE WHEN $2 = 'running' THEN COALESCE(started_at, now()) ELSE started_at END WHERE id = $1`,
      [b.id, future ? 'scheduled' : 'running'],
    );
    await ctx.queue.enqueue(
      'broadcast.process',
      { broadcastId: b.id },
      { dedupeKey: `broadcast:${b.id}`, ...(future ? { runAt: new Date(b.scheduled_at!) } : {}) },
      q,
    );
    return true;
  });
  if (!launched) throw badRequest('La difusión cambió de estado mientras la lanzabas. Recarga la página.', 'BROADCAST_CHANGED');
  const updated = await getBroadcast(ctx.db, workspaceId, id);
  ctx.realtime.emit(workspaceId, 'broadcast:update', updated);
  return updated;
}

const BATCH = 20;

async function pauseBroadcast(ctx: AppContext, b: BroadcastRow, reason: string) {
  await ctx.db.query(`UPDATE broadcasts SET status = 'paused', last_error = $2 WHERE id = $1 AND status = 'running'`, [b.id, reason]);
  ctx.realtime.emit(b.workspace_id, 'broadcast:update', await getBroadcast(ctx.db, b.workspace_id, b.id));
}

/**
 * Job "broadcast.process": atomically claims a batch of recipients (so concurrent runs
 * never message anyone twice), sends respecting the rate limit, then re-queues itself.
 */
export async function processBroadcast(ctx: AppContext, p: { broadcastId: string }): Promise<void> {
  const { rows } = await ctx.db.query<BroadcastRow & { ws_active: boolean }>(
    `SELECT b.*, w.is_active AS ws_active FROM broadcasts b JOIN workspaces w ON w.id = b.workspace_id WHERE b.id = $1`,
    [p.broadcastId],
  );
  const b = rows[0];
  if (!b) return;
  if (b.status === 'scheduled') {
    const started = await ctx.db.query(
      `UPDATE broadcasts SET status = 'running', started_at = COALESCE(started_at, now()) WHERE id = $1 AND status = 'scheduled' RETURNING id`,
      [b.id],
    );
    if (!started.rows[0]) return;
    b.status = 'running';
  }
  if (b.status !== 'running') return;
  if (!b.ws_active) return pauseBroadcast(ctx, b, 'El espacio de trabajo está suspendido');

  const claimed = await ctx.db.query<{ id: string; contact_id: string }>(
    `UPDATE broadcast_recipients SET status = 'sending', claimed_at = now()
     WHERE id IN (
       SELECT id FROM broadcast_recipients
       WHERE broadcast_id = $1
         AND (status = 'queued' OR (status = 'sending' AND message_id IS NULL AND claimed_at < now() - interval '10 minutes'))
       ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)
     RETURNING id, contact_id`,
    [b.id, BATCH],
  );
  const pending = new Set(claimed.rows.map((r) => r.id));
  const release = async () => {
    if (!pending.size) return;
    const st = await ctx.db.query<{ status: string }>(`SELECT status FROM broadcasts WHERE id = $1`, [b.id]);
    await ctx.db.query(
      `UPDATE broadcast_recipients SET status = $2, claimed_at = NULL WHERE id = ANY($1::uuid[]) AND status = 'sending'`,
      [[...pending], st.rows[0]?.status === 'cancelled' ? 'skipped' : 'queued'],
    );
  };
  const finish = (rid: string, status: string, messageId: string | null, error: string | null) => {
    pending.delete(rid);
    return ctx.db.query(`UPDATE broadcast_recipients SET status = $2, message_id = $3, error = $4, processed_at = now() WHERE id = $1`, [
      rid,
      status,
      messageId,
      error,
    ]);
  };

  const gapMs = Math.ceil(1000 / ctx.config.broadcastRatePerSecond);
  for (const r of claimed.rows) {
    const current = await ctx.db.query<{ status: string }>(`SELECT status FROM broadcasts WHERE id = $1`, [b.id]);
    if (current.rows[0]?.status !== 'running') {
      await release(); // paused or cancelled meanwhile
      return;
    }
    // A previous run may have sent this one and died before recording it: never send twice.
    const already = await ctx.db.query<{ id: string; status: string }>(
      `SELECT id, status FROM messages WHERE broadcast_id = $1 AND contact_id = $2 LIMIT 1`,
      [b.id, r.contact_id],
    );
    if (already.rows[0]) {
      await finish(r.id, already.rows[0].status === 'failed' ? 'failed' : 'sent', already.rows[0].id, null);
      continue;
    }
    const started = Date.now();
    const c = await ctx.db.query<ContactRow>(`SELECT * FROM contacts WHERE id = $1`, [r.contact_id]);
    const contact = c.rows[0];
    if (!contact || contact.opted_out) {
      await finish(r.id, 'skipped', null, null);
      continue;
    }
    try {
      const msg = await sendMessage(ctx, {
        workspaceId: b.workspace_id,
        contactId: contact.id,
        channelId: b.channel_id,
        sentBy: 'broadcast',
        userId: b.created_by,
        broadcastId: b.id,
        content: { type: 'template', name: b.template_name, language: b.template_language, params: resolveParams(b.params ?? {}, contact) },
      });
      await finish(r.id, msg.status === 'failed' ? 'failed' : 'sent', msg.id, msg.error?.message ?? null);
    } catch (err: any) {
      if (err instanceof AppError && ['INSUFFICIENT_CREDITS', 'NO_CHANNEL', 'TEMPLATE_NOT_APPROVED', 'WORKSPACE_SUSPENDED'].includes(err.code)) {
        await pauseBroadcast(ctx, b, err.message);
        await release();
        return;
      }
      await finish(r.id, 'failed', null, String(err?.message ?? err).slice(0, 500));
    }
    const wait = gapMs - (Date.now() - started);
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
  }

  const left = await ctx.db.query<{ queued: number; sending: number }>(
    `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued, count(*) FILTER (WHERE status = 'sending')::int AS sending
     FROM broadcast_recipients WHERE broadcast_id = $1`,
    [b.id],
  );
  const { queued, sending } = left.rows[0];
  if (queued > 0) {
    await ctx.queue.enqueue('broadcast.process', { broadcastId: b.id }, { dedupeKey: `broadcast:${b.id}` });
  } else if (sending > 0) {
    // Another run is still sending, or one died mid-batch: check again once its claim expires.
    await ctx.queue.enqueue('broadcast.process', { broadcastId: b.id }, { delayMs: 11 * 60 * 1000, dedupeKey: `broadcast-watchdog:${b.id}` });
  } else {
    const done = await ctx.db.query(`UPDATE broadcasts SET status = 'completed', finished_at = now() WHERE id = $1 AND status = 'running' RETURNING id`, [b.id]);
    if (done.rows[0]) {
      const finished = await getBroadcast(ctx.db, b.workspace_id, b.id);
      await dispatchWebhook(ctx, b.workspace_id, 'broadcast.completed', { ...finished, stats: await broadcastStats(ctx.db, b.id) });
    }
  }
  ctx.realtime.emit(b.workspace_id, 'broadcast:update', await getBroadcast(ctx.db, b.workspace_id, b.id));
}

export async function broadcastStats(q: Queryable, broadcastId: string) {
  const { rows } = await q.query<Record<string, number>>(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE br.status IN ('queued', 'sending'))::int AS queued,
       count(*) FILTER (WHERE br.status = 'skipped')::int AS skipped,
       count(*) FILTER (WHERE br.status = 'failed' OR m.status = 'failed')::int AS failed,
       count(*) FILTER (WHERE m.status IN ('sent', 'delivered', 'read'))::int AS sent,
       count(*) FILTER (WHERE m.status IN ('delivered', 'read'))::int AS delivered,
       count(*) FILTER (WHERE m.status = 'read')::int AS read,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM messages r WHERE r.contact_id = br.contact_id AND r.direction = 'in' AND r.created_at > m.created_at
       ))::int AS replied,
       COALESCE(sum(m.cost), 0)::float AS cost
     FROM broadcast_recipients br LEFT JOIN messages m ON m.id = br.message_id
     WHERE br.broadcast_id = $1`,
    [broadcastId],
  );
  return rows[0];
}
