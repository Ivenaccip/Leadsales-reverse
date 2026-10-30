import type { AppContext } from '../context.js';
import type { Queryable } from '../db/index.js';
import type { Job } from '../jobs/queue.js';
import { AppError, notFound } from '../lib/errors.js';
import { deliveryNumber, digitsOnly, isValidPhone, lineForms, normalizePhone, phoneVariants } from '../lib/phone.js';
import { matchOption, resolveMenu, settingsWithDefaults } from '../services/automation.js';
import { createContact, getContact, type Contact } from '../services/contacts.js';
import { charge, notifyCredits, reconcilePricing, refund, roundMoney } from '../services/credits.js';
import { dispatchWebhook, recordEvent } from '../services/events.js';
import { previewFor } from '../services/messages.js';
import type { BotState, ChannelRow, MessageRow, WorkspaceSettings } from '../types.js';
import { explainMetaError } from './types.js';

const STATUS_RANK: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3 };
// Phrases that only ever mean "stop sending me this" (Meta's marketing opt-out button included).
const OPT_OUT_PHRASES = new Set([
  'stop',
  'cancelar suscripcion',
  'cancelar suscripción',
  'unsubscribe',
  'stop promotions',
  'detener promociones',
  'darme de baja',
  'darse de baja',
]);
// Typed alone, "baja" and "alto" are the classic Spanish opt-out keywords; as a button the
// business wrote they are usually an answer ("Alto / Medio / Bajo", "Alta / Baja").
const OPT_OUT_WORDS = new Set([...OPT_OUT_PHRASES, 'baja', 'alto']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// message_template_status_update events that are real template statuses. REINSTATED means the
// template can be sent again; FLAGGED, LOCKED and UNLOCKED are notices that leave it sendable;
// UNARCHIVED restores the status it had before it was archived (see restoreTemplates).
const TEMPLATE_STATUSES = new Set(['APPROVED', 'REJECTED', 'PENDING', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION', 'DELETED', 'ARCHIVED', 'LIMIT_EXCEEDED']);
// The only template categories Meta has: anything else in a category update is not Meta's (a
// 'service' template would be sent for free).
const TEMPLATE_CATEGORIES = new Set(['marketing', 'utility', 'authentication']);
// How long after a number change what still comes from the old number belongs to the contact that
// moved: Meta retries a webhook for up to 7 days, and a number given up is reassigned much later.
const MOVED_NUMBER_DAYS = 30;
// How far ahead of our clock Meta's may run: a time further ahead in a payload is not Meta's.
const META_CLOCK_SKEW_S = 300;
// The ledger description of the charge given back for a message Meta did not deliver (also written
// by reconcilePricing): a delivery reported after it takes exactly these back.
const UNDELIVERED_REFUND = 'Reembolso: mensaje no entregado';

class RetryLater extends Error {}

/**
 * Bad data in one event (e.g. an invalid phone) is logged and skipped: retrying would never
 * fix it and would hold back the rest of the batch. Anything else is returned to retry the job.
 */
function keepTransient(ctx: AppContext, err: unknown, what: Record<string, unknown>): unknown {
  if (err instanceof AppError && err.status >= 400 && err.status < 500) {
    ctx.log.warn({ ...what, code: err.code, err: err.message }, 'webhook event skipped');
    return null;
  }
  return err;
}

// Times are handled in microseconds since the epoch (Postgres' precision): webhooks that reach
// us within the same millisecond must still keep their order.
function isoMicros(value: number): string {
  const us = Math.round(value);
  const ms = Math.floor(us / 1000);
  return new Date(ms).toISOString().replace('Z', `${String(us - ms * 1000).padStart(3, '0')}Z`);
}

/**
 * Meta timestamps have 1-second resolution and the jobs of one batch run concurrently, so
 * chat order comes from when the webhook reached us plus the position inside the payload.
 * Late deliveries keep Meta's original time.
 */
function messageTime(ts: string | undefined, receivedUs: number, seq: number): number {
  return (lateDelivery(ts, receivedUs) ? Number(ts) * 1_000_000 : receivedUs) + seq;
}

/** A delivery 60 s or more away from Meta's time: the message is stored at Meta's time. */
function lateDelivery(ts: string | undefined, receivedUs: number): boolean {
  const meta = ts ? Number(ts) * 1_000_000 : NaN;
  return Number.isFinite(meta) && Math.abs(receivedUs - meta) >= 60_000_000;
}

/** Meta's timestamp (whole seconds) of an inbound message or echo, stored as messages.wa_ts. */
function metaSeconds(ts: unknown): number | null {
  const n = Number(ts);
  return ts != null && ts !== '' && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** How far from its stored neighbour a message placed by Meta time goes, when there is room. */
const SLOT_US = 1000;

/** The time (µs) of a chat's first or last message matching `where` ($1 is the contact). */
async function edgeTime(q: Queryable, agg: 'min' | 'max', where: string, params: unknown[]): Promise<number | null> {
  const { rows } = await q.query<{ us: number | null }>(
    `SELECT (extract(epoch FROM ${agg}(created_at)) * 1000000)::bigint AS us FROM messages WHERE contact_id = $1 AND ${where}`,
    params,
  );
  return rows[0]?.us == null ? null : Number(rows[0].us);
}

/**
 * Chat order follows Meta's timestamps; receipt order only breaks ties within one Meta second.
 * A message Meta stamped earlier than a stored one (delivered out of order or retried, even
 * seconds late) goes right before it, one stamped later right after it, each on a microsecond
 * of its own so the order never falls to the id tie-break. Call under the contact row lock so
 * messages of one chat handled at once see each other.
 */
async function chatTime(q: Queryable, contactId: string, us: number, waTs: number | null, late: boolean): Promise<string> {
  if (waTs == null) return isoMicros(us);
  const after = await edgeTime(q, 'max', 'wa_ts < $2', [contactId, waTs]);
  // Placed this way, every message of an earlier Meta second is stored before those of later ones.
  const before = await edgeTime(q, 'min', 'wa_ts > $2 AND created_at > $3', [contactId, waTs, after == null ? '-infinity' : isoMicros(after)]);
  if (before != null && us >= before) {
    const prev = await edgeTime(q, 'max', 'created_at < $2', [contactId, isoMicros(before)]);
    return isoMicros(prev == null ? before - SLOT_US : await between(q, contactId, prev, before, true));
  }
  // Stored at Meta's time, a late message has no receipt time of its own to keep its place within
  // that second: it goes after the messages of the second that reached us before it (two late ones
  // of one second would otherwise tie on the same microsecond).
  const same = late
    ? await edgeTime(q, 'max', 'wa_ts = $2 AND created_at < $3', [contactId, waTs, before == null ? 'infinity' : isoMicros(before)])
    : null;
  const floor = same != null && (after == null || same > after) ? same : after;
  if (floor != null && us <= floor) {
    const next = await edgeTime(q, 'min', 'created_at > $2', [contactId, isoMicros(floor)]);
    return isoMicros(await between(q, contactId, floor, next, false));
  }
  return isoMicros(us);
}

/** A free microsecond strictly between two adjacent stored messages of a chat (`next` null: none after). */
async function between(q: Queryable, contactId: string, prev: number, next: number | null, nearNext: boolean): Promise<number> {
  if (next == null) return prev + SLOT_US;
  const gap = next - prev;
  if (gap > SLOT_US) return nearNext ? next - SLOT_US : prev + SLOT_US;
  if (gap >= 2) return prev + Math.floor(gap / 2);
  // None free (the messages of one payload are 1 µs apart): `prev` and the messages packed right
  // below it move 1 µs earlier, into the free microsecond below them, keeping their order.
  await q.query(
    `WITH packed AS (
       SELECT us, row_number() OVER (ORDER BY us DESC) - 1 AS n FROM (
         SELECT DISTINCT (extract(epoch FROM created_at) * 1000000)::bigint AS us FROM messages
         WHERE contact_id = $1 AND created_at <= $2 AND created_at > $2::timestamptz - interval '1 second') d)
     UPDATE messages SET created_at = created_at - interval '1 microsecond'
     WHERE contact_id = $1 AND created_at <= $2 AND created_at > $2::timestamptz - interval '1 second'
       AND (extract(epoch FROM created_at) * 1000000)::bigint >= (SELECT min(us) FROM packed WHERE us = $3::bigint - n)`,
    [contactId, isoMicros(prev), prev],
  );
  return prev;
}

// On PGlite every query resolves without I/O: a webhook with hundreds of messages or statuses would
// otherwise keep HTTP, Socket.IO and timers waiting until all of them are stored.
const yieldToEventLoop = () => new Promise<void>((r) => setImmediate(r));

/**
 * The channel row is locked before the contact row, in the order DELETE /api/channels takes them
 * (the channel, then its contacts through ON DELETE SET NULL): the other way round the two
 * deadlock, since the message INSERT's foreign-key check needs the channel row.
 */
async function lockChannel(q: Queryable, channelId: string) {
  const { rows } = await q.query(`SELECT 1 FROM channels WHERE id = $1 FOR KEY SHARE`, [channelId]);
  if (!rows[0]) throw notFound('Canal'); // deleted while this webhook was being handled
}

/** When the webhook reached the route: the creation time of its job (retries keep it). */
async function receiptTime(ctx: AppContext, job?: Job): Promise<number> {
  if (job?.id != null) {
    const { rows } = await ctx.db.query<{ us: number }>(`SELECT (extract(epoch FROM created_at) * 1000000)::bigint AS us FROM jobs WHERE id = $1`, [
      job.id,
    ]);
    if (rows[0]) return Number(rows[0].us);
  }
  return Date.now() * 1000;
}

/**
 * Which channels' payloads may move prepaid money: those signed with the operator's secret
 * (global META_APP_SECRET or an operator-verified channel). Internal (sandbox) events are trusted.
 */
type Trust = { allowed: string[] | null; trusted: string[] | null | undefined };

function billingTrusted(channel: ChannelRow, t: Trust): boolean {
  if (t.allowed === null || t.trusted === null) return true;
  // Queued before the route computed the list: trust what only the operator could have signed.
  if (t.trusted === undefined) return channel.operator_verified === true;
  return t.trusted.includes(channel.id);
}

/**
 * Entry point for every payload Meta posts to /webhooks/whatsapp (run from the job queue).
 * `allowed` lists the channels whose app secret signed the payload; null = internal (sandbox) events.
 * `trusted` lists those signed with a secret the tenant cannot know (see billingTrusted).
 */
export async function processWebhook(
  ctx: AppContext,
  body: any,
  job?: Job,
  allowed: string[] | null = null,
  trusted?: string[] | null,
): Promise<void> {
  if (body?.object !== 'whatsapp_business_account') return;
  let retry = false;
  let failure: unknown = null;
  let receipt: Promise<number> | null = null;
  const receivedAt = () => (receipt ??= receiptTime(ctx, job));
  const trust: Trust = { allowed, trusted };
  // Positions count across the whole payload: messages of different changes or entries (one
  // customer's burst, a phone reply) reach us together and must not share a time.
  let position = 0;
  const nextSeq = () => position++;
  let changes = 0;
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      // Also between changes: a payload can carry hundreds of them with one message each.
      if (changes++) await yieldToEventLoop();
      const value = change.value ?? {};
      try {
        switch (change.field) {
          case 'messages':
            await processMessagesChange(ctx, value, job, trust, receivedAt, nextSeq);
            break;
          case 'smb_message_echoes':
            await processEchoes(ctx, value, allowed, receivedAt, nextSeq);
            break;
          case 'message_template_status_update':
            await processTemplateStatus(ctx, entry.id, value, allowed, entryTime(entry.time));
            break;
          case 'message_template_components_update':
            await refreshTemplates(ctx, entry.id, value, allowed);
            break;
          case 'template_category_update':
            await processTemplateCategory(ctx, entry.id, value, allowed, entryTime(entry.time));
            break;
          default:
            ctx.log.debug({ field: change.field }, 'webhook field ignored');
        }
      } catch (err) {
        if (err instanceof RetryLater) {
          retry = true;
        } else {
          const e = keepTransient(ctx, err, { field: change.field });
          failure ??= e;
        }
      }
    }
  }
  // Every event handler is idempotent: a retry only finishes what failed.
  if (failure) throw failure;
  if (retry) throw new Error('Estados de mensajes aún no registrados; se reintentará');
}

/**
 * When Meta raised the notification (entry.time: seconds, milliseconds tolerated), as an instant.
 * Template events are applied in this order: a retried or redelivered older one comes after newer ones.
 * Meta's clock may run a little ahead of ours, never minutes: a later time is not Meta's (a payload
 * signed with an App Secret the business knew) and, stored, would freeze the template against every
 * genuine event after it. Such an event counts as undated.
 */
function entryTime(t: unknown): string | null {
  const n = Number(t);
  if (t == null || t === '' || !Number.isFinite(n) || n <= 0) return null;
  const ms = n >= 1e11 ? n : n * 1000;
  return ms > Date.now() + META_CLOCK_SKEW_S * 1000 ? null : new Date(ms).toISOString();
}

async function channelByPhoneNumberId(ctx: AppContext, phoneNumberId: string | undefined, allowed: string[] | null): Promise<ChannelRow | null> {
  if (!phoneNumberId) return null;
  const { rows } = await ctx.db.query<ChannelRow>(
    `SELECT * FROM channels WHERE phone_number_id = $1 AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))`,
    [phoneNumberId, allowed],
  );
  return rows[0] ?? null;
}

async function processMessagesChange(
  ctx: AppContext,
  value: any,
  job: Job | undefined,
  trust: Trust,
  receivedAt: () => Promise<number>,
  nextSeq: () => number,
) {
  const channel = await channelByPhoneNumberId(ctx, value.metadata?.phone_number_id, trust.allowed);
  if (!channel) {
    ctx.log.warn({ phoneNumberId: value.metadata?.phone_number_id }, 'webhook for unknown phone number id');
    return;
  }
  let failure: unknown = null;
  let missing = false;
  const recent = (ts: unknown) => Date.now() / 1000 - Number(ts ?? 0) < 300;
  const messages: any[] = value.messages ?? [];
  for (let i = 0; i < messages.length; i++) {
    if (i) await yieldToEventLoop();
    const msg = messages[i];
    const profile = (value.contacts ?? []).find((c: any) => c.wa_id === msg.from) ?? value.contacts?.[0];
    try {
      if (isMessageChange(msg)) {
        // The original may be in a payload Meta delivers right after this one.
        const found = await applyMessageChange(ctx, channel, msg, 'in');
        if (!found && recent(msg.timestamp) && (job?.attempts ?? 99) < 3) missing = true;
        continue;
      }
      await processInboundMessage(ctx, channel, msg, profile, await receivedAt(), nextSeq());
    } catch (err) {
      const e = keepTransient(ctx, err, { channel: channel.id, wamid: msg?.id });
      failure ??= e;
    }
  }
  const settles = billingTrusted(channel, trust);
  for (const st of value.statuses ?? []) {
    await yieldToEventLoop();
    try {
      const found = await processStatus(ctx, channel, st, settles);
      if (!found && recent(st.timestamp) && (job?.attempts ?? 99) < 3) missing = true;
    } catch (err) {
      const e = keepTransient(ctx, err, { channel: channel.id, wamid: st?.id });
      failure ??= e;
    }
  }
  for (const err of value.errors ?? []) {
    ctx.log.warn({ channel: channel.id, err }, 'whatsapp webhook error');
  }
  if (failure) throw failure;
  if (missing) throw new RetryLater();
}

interface ParsedContent {
  type: string;
  body: string | null;
  media: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
}

export function parseInboundContent(msg: any): ParsedContent {
  const t: string = msg.type ?? 'unknown';
  const base: ParsedContent = { type: t, body: null, media: null, payload: null };
  switch (t) {
    case 'text':
      return { ...base, body: msg.text?.body ?? '' };
    case 'image':
    case 'video':
    case 'audio':
    case 'document':
    case 'sticker': {
      const m = msg[t] ?? {};
      const media: Record<string, unknown> = { wa_media_id: m.id, mime: m.mime_type, sha256: m.sha256, filename: m.filename ?? null, voice: m.voice ?? false };
      // Nothing to download: say so instead of leaving the chat waiting for the file.
      if (!m.id) media.download_error = 'WhatsApp no incluyó el archivo en el mensaje';
      return { ...base, body: m.caption ?? null, media };
    }
    case 'location': {
      const l = msg.location ?? {};
      return { ...base, body: [l.name, l.address].filter(Boolean).join(' — ') || null, payload: l };
    }
    case 'contacts': {
      const names = (msg.contacts ?? []).map((c: any) => c.name?.formatted_name).filter(Boolean);
      return { ...base, body: names.length ? `👤 ${names.join(', ')}` : null, payload: { contacts: msg.contacts } };
    }
    case 'interactive': {
      const i = msg.interactive ?? {};
      const reply = i.button_reply ?? i.list_reply;
      const body = reply?.title ?? (i.nfm_reply ? 'Formulario enviado' : null);
      return { ...base, body, payload: { interactive: i, reply_id: reply?.id ?? null } };
    }
    case 'button':
      return { ...base, body: msg.button?.text ?? null, payload: { button: msg.button, reply_id: msg.button?.payload ?? null } };
    case 'reaction':
      return { ...base, body: msg.reaction?.emoji || '(reacción eliminada)', payload: msg.reaction };
    case 'order':
      return { ...base, body: msg.order?.text ?? '🛒 Pedido', payload: msg.order };
    case 'system':
      return { ...base, body: msg.system?.body ?? null, payload: msg.system };
    default:
      return {
        ...base,
        type: 'unsupported',
        body: '[Tipo de mensaje no soportado por la API de WhatsApp]',
        payload: { original_type: t, errors: msg.errors ?? null },
      };
  }
}

/**
 * The opt-out keyword in a typed reply, a template quick-reply button or an interactive reply.
 * A button or list option is a choice the business wrote: only an explicit opt-out phrase
 * counts there, never the everyday words "baja" or "alto" (a survey answer is not an unsubscribe).
 */
export function optOutKeyword(parsed: ParsedContent): string | null {
  const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
  if (parsed.type === 'text') {
    // Typed as the answer to the bot's menu (see menuOptionTyped): a choice, like a tap on it.
    if (parsed.payload?.menu_option != null) return null;
    const word = norm(parsed.body);
    return OPT_OUT_WORDS.has(word) ? word : null;
  }
  if (parsed.type !== 'button' && parsed.type !== 'interactive') return null;
  // A tap on the bot's own menu ("menu:1", "menu:home") picks an option the business wrote.
  if (parsed.type === 'interactive' && norm(parsed.payload?.reply_id).startsWith('menu:')) return null;
  for (const candidate of [parsed.payload?.reply_id, parsed.body]) {
    const word = norm(candidate);
    if (OPT_OUT_PHRASES.has(word)) return word;
  }
  return null;
}

/**
 * The key of the option a typed text picks in the menu the bot is waiting on ("1. Alta / 2. Baja"):
 * in a text menu typing the label is the only way to choose it, so it is an answer, not an opt-out.
 * Only while the bot runs and has sent its menu (bot_state, not done): the menu bot answers it then.
 */
async function menuOptionTyped(q: Queryable, workspaceId: string, botState: BotState | null, text: string | null): Promise<string | null> {
  if (!botState || botState.done || !text?.trim()) return null;
  const { rows } = await q.query<{ settings: WorkspaceSettings | null }>(`SELECT settings FROM workspaces WHERE id = $1`, [workspaceId]);
  const settings = settingsWithDefaults(rows[0]?.settings);
  const menu = settings.bot?.menu;
  if (settings.automation_mode !== 'menu' || !menu?.options?.length) return null;
  return matchOption(resolveMenu(menu, botState.path ?? []), text)?.key ?? null;
}

/** Whether a stored customer message gets an automatic answer: not a reaction, a WhatsApp notice or a request to stop. */
function answerable(m: Pick<MessageRow, 'type' | 'body' | 'payload'>): boolean {
  return m.type !== 'reaction' && m.type !== 'system' && !optOutKeyword({ type: m.type, body: m.body, media: null, payload: m.payload ?? null });
}

/** Whether `waId` is still the number of the message's contact (not one the customer has since left). */
async function fromContactNumber(ctx: AppContext, contactId: string, waId: string): Promise<boolean> {
  const { rows } = await ctx.db.query<{ phone: string; wa_id: string | null }>(`SELECT phone, wa_id FROM contacts WHERE id = $1`, [contactId]);
  const c = rows[0];
  return !!c && !!waId && (c.wa_id === waId || lineForms(waId).includes(c.phone));
}

/**
 * A customer editing or deleting a message (messages of type 'edit' and 'revoke', sent for numbers
 * also used in the WhatsApp Business app; older payloads report an edit as 'unsupported', without
 * its content). Neither is a new message: nothing is stored, counted as unread or answered.
 */
function isMessageChange(msg: any): boolean {
  return msg?.type === 'edit' || msg?.type === 'revoke' || (msg?.type === 'unsupported' && msg?.unsupported?.type === 'edit');
}

/**
 * Applies an edit or a deletion to the message it is about: an edit replaces the text (the earlier
 * versions are kept in payload.edits), a deletion marks it (payload.deleted_at). `direction`: 'in'
 * for the customer's messages, 'out' for the business app's echoes. False when that message is not
 * stored (yet).
 */
async function applyMessageChange(ctx: AppContext, channel: ChannelRow, msg: any, direction: 'in' | 'out'): Promise<boolean> {
  const change = msg[msg.type] ?? {};
  const originalId = change.original_message_id ?? msg.context?.id;
  if (msg.type === 'unsupported' || !originalId) {
    ctx.log.debug({ channel: channel.id, wamid: msg.id, type: msg.type }, 'message change without content ignored');
    return true;
  }
  const waId = digitsOnly(String((direction === 'in' ? msg.from : msg.to) ?? ''));
  const ts = metaSeconds(msg.timestamp) ?? Math.floor(Date.now() / 1000);
  const at = new Date(ts * 1000).toISOString();
  const result = await ctx.db.tx(async (q) => {
    const { rows } = await q.query<MessageRow & { phone: string; contact_wa_id: string | null }>(
      `SELECT m.*, c.phone, c.wa_id AS contact_wa_id FROM messages m JOIN contacts c ON c.id = m.contact_id
       WHERE m.workspace_id = $1 AND m.wamid = $2 AND m.direction = $3 FOR UPDATE OF m`,
      [channel.workspace_id, String(originalId), direction],
    );
    const m = rows[0];
    if (!m) return undefined;
    // Only that chat's own messages: an id from another conversation changes nothing.
    if (m.contact_wa_id !== waId && !lineForms(waId).includes(m.phone)) return null;
    const payload: Record<string, unknown> = { ...(m.payload ?? {}) };
    let body = m.body;
    let preview: string;
    if (msg.type === 'revoke') {
      if (payload.deleted_at) return null;
      payload.deleted_at = at;
      preview = 'Mensaje eliminado';
    } else {
      const edited = parseInboundContent(change.message ?? {});
      // An edit changes a text or a caption, never the kind of message: content of another type (one
      // this parser does not know reads as a placeholder) leaves it as it is. Edits apply in Meta's
      // order: one delivered late never undoes a newer one.
      if (edited.type !== m.type || edited.body == null || edited.body === m.body || ts < Number(payload.edited_ts ?? 0)) return null;
      const edits = Array.isArray(payload.edits) ? payload.edits : [];
      payload.edits = [...edits, { body: m.body, until: at }].slice(-20);
      payload.edited_at = at;
      payload.edited_ts = ts;
      body = edited.body;
      preview = previewFor(m.type, body);
    }
    const upd = await q.query<MessageRow>(`UPDATE messages SET body = $2, payload = $3 WHERE id = $1 RETURNING *`, [m.id, body, JSON.stringify(payload)]);
    // The conversation's preview, when this is its latest message.
    const c = await q.query(
      `UPDATE contacts SET last_message_preview = $2, updated_at = now()
       WHERE id = $1 AND last_message_at = (SELECT created_at FROM messages WHERE id = $3) RETURNING id`,
      [m.contact_id, preview, m.id],
    );
    return { row: upd.rows[0], previewed: !!c.rows[0] };
  });
  if (result === undefined) {
    ctx.log.debug({ channel: channel.id, wamid: msg.id, original: originalId }, 'message change for a message not stored');
    return false;
  }
  if (result) {
    ctx.realtime.emit(channel.workspace_id, 'message:update', publicRow(result.row));
    if (result.previewed) ctx.realtime.emit(channel.workspace_id, 'contact:update', await getContact(ctx.db, channel.workspace_id, result.row.contact_id));
  }
  return true;
}

/**
 * Finds the contact behind a WhatsApp id. Meta's wa_id can differ from the number we stored
 * (Brazil's 9th digit, Argentina's 9...), and sends record the wa_id Meta answers with, so a
 * contact already holding this wa_id wins. Next comes a lead stored under another form of the
 * same number that no other WhatsApp id claimed yet (it then learns this wa_id), then a contact
 * that moved off this number when the customer changed it (`moved`); otherwise match or create
 * by phone. A wa_id is already international: the workspace country code must never be added to it.
 * `sentAt` is Meta's time (seconds) of the message or echo; null for a WhatsApp notice.
 */
async function contactForWaId(
  ctx: AppContext,
  channel: ChannelRow,
  waId: string,
  sentAt: number | null,
  extra: { name?: string | null; source: string },
): Promise<{ contact: Contact; moved: boolean }> {
  if (waId) {
    const phone = normalizePhone(`+${waId}`);
    const { rows } = await ctx.db.query<{ id: string }>(
      `SELECT id FROM contacts WHERE workspace_id = $1 AND wa_id = $2 ORDER BY (phone = $3) DESC, created_at ASC LIMIT 1`,
      [channel.workspace_id, waId, phone],
    );
    if (rows[0]) return { contact: await getContact(ctx.db, channel.workspace_id, rows[0].id), moved: false };
    const variants = phoneVariants(waId).filter((v) => v !== phone);
    if (variants.length) {
      const { rows: same } = await ctx.db.query<{ id: string }>(
        `SELECT id FROM contacts WHERE workspace_id = $1 AND phone = ANY($2::text[]) AND (wa_id IS NULL OR wa_id = phone)
           AND NOT EXISTS (SELECT 1 FROM contacts o WHERE o.workspace_id = $1 AND o.phone = $3)
         ORDER BY created_at ASC LIMIT 1`,
        [channel.workspace_id, variants, phone],
      );
      if (same[0]) return { contact: await getContact(ctx.db, channel.workspace_id, same[0].id), moved: false };
    }
    // The customer changed number: a message sent from the old one before the change and delivered
    // late, a reply typed in its old chat on the phone before it, the notice again through another
    // of the business's numbers. They belong to the contact that moved, not to a new lead. What is
    // stamped after the change comes from, or goes to, whoever holds the old number now: a new lead.
    // (changed_at: Meta's time of the change; events recorded before it was kept have their own time.)
    const { rows: moved } = await ctx.db.query<{ contact_id: string }>(
      `SELECT e.contact_id FROM contact_events e
       WHERE e.workspace_id = $1 AND e.type = 'number_changed' AND e.created_at > now() - interval '${MOVED_NUMBER_DAYS} days'
         AND (e.data->>'old_wa_id' = $2 OR e.data->>'old_phone' = $3) AND e.data->>'moved' = 'true'
         AND ($4::bigint IS NULL OR $4::bigint <= COALESCE((e.data->>'changed_at')::bigint, extract(epoch FROM e.created_at)::bigint))
         AND NOT EXISTS (SELECT 1 FROM contacts o WHERE o.workspace_id = $1 AND o.phone = $3)
       ORDER BY e.created_at DESC LIMIT 1`,
      [channel.workspace_id, waId, phone, sentAt],
    );
    if (moved[0]) return { contact: await getContact(ctx.db, channel.workspace_id, moved[0].contact_id), moved: true };
  }
  const { contact } = await createContact(ctx, channel.workspace_id, {
    phone: `+${waId}`,
    waId,
    name: extra.name ?? null,
    source: extra.source,
    channelId: channel.id,
  });
  return { contact, moved: false };
}

/** The message already stored for a WhatsApp id (a redelivery by Meta, or a retried job). */
async function storedMessage(ctx: AppContext, workspaceId: string, wamid: unknown): Promise<MessageRow | null> {
  if (!wamid) return null;
  const { rows } = await ctx.db.query<MessageRow>(`SELECT * FROM messages WHERE workspace_id = $1 AND wamid = $2`, [workspaceId, String(wamid)]);
  return rows[0] ?? null;
}

/** Marks the follow-ups as done; false when another attempt already did (it queued the jobs). */
async function claimFollowups(q: Queryable, messageId: string): Promise<boolean> {
  const { rows } = await q.query(`UPDATE messages SET followups_done = true WHERE id = $1 AND NOT followups_done RETURNING id`, [messageId]);
  return !!rows[0];
}

function publicRow(m: MessageRow): MessageRow {
  const row = { ...m };
  delete row.followups_done;
  return row;
}

export async function processInboundMessage(
  ctx: AppContext,
  channel: ChannelRow,
  msg: any,
  profile?: any,
  receivedUs: number = Date.now() * 1000,
  seq = 0,
): Promise<MessageRow | null> {
  if (isMessageChange(msg)) {
    await applyMessageChange(ctx, channel, msg, 'in');
    return null;
  }
  const parsed = parseInboundContent(msg);
  const isSystem = parsed.type === 'system';
  const waId = digitsOnly(String(msg.from ?? ''));

  // A redelivery must not create or update contacts again (the number may have moved since). What it
  // still has to do is decided as on the first attempt: by the message as stored, and only while it
  // came from the number its contact has now.
  const stored = await storedMessage(ctx, channel.workspace_id, msg.id);
  if (stored) {
    if (stored.followups_done !== false) return null;
    return finishDuplicate(ctx, stored, answerable(stored) && (await fromContactNumber(ctx, stored.contact_id, waId)));
  }

  const profileName: string | null = profile?.profile?.name ?? null;
  const referral = msg.referral ?? null;
  const waTs = metaSeconds(msg.timestamp);
  const receivedS = Math.floor(receivedUs / 1_000_000);
  const { contact, moved } = await contactForWaId(ctx, channel, waId, isSystem ? null : (waTs ?? receivedS), {
    name: profileName,
    source: referral ? 'whatsapp_ad' : 'whatsapp',
  });
  const basePayload = referral ? { ...(parsed.payload ?? {}), referral } : parsed.payload;
  const preview = previewFor(parsed.type, parsed.body);

  let isNew = false;
  let optOut: string | null = null;
  const inserted = await ctx.db.tx(async (q) => {
    await lockChannel(q, channel.id);
    // The contact row lock comes before the INSERT: messages of one chat handled at once are
    // placed (and counted as the lead's first) one after another. NO KEY UPDATE still lets the
    // INSERT below take its foreign-key share lock on this row.
    const prev = await q.query<{ opened: boolean; bot_state: BotState | null }>(
      `SELECT last_message_at IS NULL AND source LIKE 'whatsapp%' AS opened, bot_state FROM contacts WHERE id = $1 FOR NO KEY UPDATE`,
      [contact.id],
    );
    // "Baja" typed to a menu offering it picks that option: stored as the answer, no reader of the
    // message takes it for an opt-out (optOutKeyword), and the bot handles it.
    const keyword = optOutKeyword(parsed);
    const option = keyword && parsed.type === 'text' ? await menuOptionTyped(q, channel.workspace_id, prev.rows[0]?.bot_state ?? null, parsed.body) : null;
    optOut = option ? null : keyword;
    const payload = option ? { ...(basePayload ?? {}), menu_option: option } : basePayload;
    const createdAt = await chatTime(q, contact.id, messageTime(msg.timestamp, receivedUs, seq), waTs, lateDelivery(msg.timestamp, receivedUs));
    const { rows } = await q.query<MessageRow>(
      `INSERT INTO messages (workspace_id, contact_id, channel_id, direction, type, body, media, payload, wamid,
         reply_to_wamid, status, sent_by, created_at, followups_done, wa_ts)
       VALUES ($1, $2, $3, 'in', $4, $5, $6, $7, $8, $9, 'received', 'contact', $10, false, $11)
       ON CONFLICT (workspace_id, wamid) DO NOTHING RETURNING *`,
      [
        channel.workspace_id,
        contact.id,
        channel.id,
        parsed.type,
        parsed.body,
        parsed.media ? JSON.stringify(parsed.media) : null,
        payload ? JSON.stringify(payload) : null,
        msg.id,
        msg.context?.id ?? null,
        createdAt,
        waTs,
      ],
    );
    const m = rows[0];
    if (!m) return null; // duplicate delivery
    if (isSystem) {
      // The change happened at Meta's time of the notice (one far ahead of our clock is not Meta's).
      const changedAt = Math.min(waTs ?? receivedS, receivedS + META_CLOCK_SKEW_S);
      await applySystemNotice(q, contact, channel.id, waId, msg.system, createdAt, preview, changedAt);
    } else {
      // A lead is new while the conversation it started over WhatsApp has no message yet (read
      // under the lock: of several first messages only one is the first, and a retry after the
      // contact was created but before this INSERT still counts as new).
      isNew = !!prev.rows[0]?.opened;
      // The preview follows the newest message: Meta may deliver an older one late. A message
      // older than a reply typed in the WhatsApp Business app was already seen on the phone.
      // A sandbox message never moves a contact off its real (Cloud API) number: replies would
      // stop reaching WhatsApp (the simulate route refuses this too; this guards every other path).
      // The wa_id is only learned for the number the contact has now (read under the lock): a message
      // from a number the customer left, however late, never points the replies back at it.
      // Replies leave from the business number of the newest message: an older one delivered late to
      // another of the business's numbers does not move the conversation back to it (values on the
      // right are the row's before this UPDATE).
      await q.query(
        `UPDATE contacts SET last_message_at = GREATEST(COALESCE(last_message_at, $2), $2), last_inbound_at = GREATEST(COALESCE(last_inbound_at, $2), $2),
           last_message_preview = CASE WHEN last_message_at IS NULL OR $2 >= last_message_at THEN $3 ELSE last_message_preview END,
           unread_count = unread_count + CASE WHEN $4::int > 0 AND NOT EXISTS (
             SELECT 1 FROM messages e WHERE e.contact_id = $1 AND e.sent_by = 'phone' AND e.created_at > $2) THEN $4::int ELSE 0 END,
           wa_id = CASE WHEN phone = ANY($9::text[]) THEN $5 ELSE wa_id END,
           channel_id = CASE WHEN $8 AND EXISTS (SELECT 1 FROM channels ch WHERE ch.id = contacts.channel_id AND ch.provider = 'cloud_api')
             THEN channel_id WHEN channel_id IS NOT NULL AND last_inbound_at IS NOT NULL AND $2 < last_inbound_at THEN channel_id ELSE $6 END,
           name = COALESCE(name, $7), is_archived = false, updated_at = now()
         WHERE id = $1`,
        [contact.id, createdAt, preview, parsed.type === 'reaction' ? 0 : 1, waId, channel.id, profileName, channel.provider === 'sandbox', lineForms(waId)],
      );
    }
    if (optOut && !contact.opted_out) {
      await q.query(`UPDATE contacts SET opted_out = true WHERE id = $1`, [contact.id]);
      await recordEvent(q, { workspaceId: channel.workspace_id, contactId: contact.id, type: 'opted_out', data: { keyword: optOut } });
    }
    return m;
  });
  // Someone asking to stop must not get an automatic answer; WhatsApp notices are not messages; one
  // sent from the number the customer has since left is kept in the chat, but too old to answer.
  if (!inserted) {
    const raced = await storedMessage(ctx, channel.workspace_id, msg.id);
    return raced ? finishDuplicate(ctx, raced, answerable(raced) && !moved) : null;
  }
  await inboundFollowups(ctx, inserted, { isNew, automate: parsed.type !== 'reaction' && !isSystem && !optOut && !moved });
  return publicRow(inserted);
}

/** A redelivered message: only finish the follow-up work its first attempt left undone. */
async function finishDuplicate(ctx: AppContext, m: MessageRow, automate: boolean): Promise<null> {
  if (m.followups_done === false) await inboundFollowups(ctx, m, { isNew: await startedConversation(ctx, m), automate });
  return null;
}

/**
 * WhatsApp system notices are not written by the customer: they neither open the 24h window
 * nor count as unread. When the customer changed number the contact moves to the new one,
 * unless another contact already has it (the event then links both). `changedAt`: Meta's time of
 * the change (seconds), which tells what still came from the customer on the old number.
 */
async function applySystemNotice(
  q: Queryable,
  contact: Contact,
  channelId: string,
  waId: string,
  system: any,
  createdAt: string,
  preview: string,
  changedAt: number,
) {
  // A contact on no number (its number deleted) is answered from the one this notice came through.
  await q.query(
    `UPDATE contacts SET last_message_at = GREATEST(COALESCE(last_message_at, $2), $2),
       last_message_preview = CASE WHEN last_message_at IS NULL OR $2 >= last_message_at THEN $3 ELSE last_message_preview END,
       channel_id = COALESCE(channel_id, $4), updated_at = now()
     WHERE id = $1`,
    [contact.id, createdAt, preview, channelId],
  );
  // Meta's reference names the type customer_changed_number; its sample payload user_changed_number.
  if (system?.type !== 'customer_changed_number' && system?.type !== 'user_changed_number') return;
  const newWaId = digitsOnly(String(system.new_wa_id ?? system.wa_id ?? ''));
  const newPhone = normalizePhone(`+${newWaId}`);
  if (!newWaId || newWaId === waId || !isValidPhone(newPhone)) return;
  // Read under the contact lock the caller holds: the same change notified at once through two of
  // the business's numbers is applied once. Only a contact still on the number the notice is about
  // moves: the change notified again, or late after a later one, leaves it where it is now.
  const { rows: fresh } = await q.query<{ phone: string; wa_id: string | null }>(`SELECT phone, wa_id FROM contacts WHERE id = $1`, [contact.id]);
  const cur = fresh[0];
  if (!cur || (cur.wa_id !== waId && !lineForms(waId).includes(cur.phone))) return;
  // The new number may already be in the CRM in another of its forms (Brazil's 9th digit, Argentina's
  // 9 or 15), saved by hand or imported: that contact is the line, as contactForWaId would match it.
  const other = await q.query<{ id: string }>(
    `SELECT id FROM contacts WHERE workspace_id = $1 AND id <> $2
       AND (phone = $3 OR wa_id = $4 OR (phone = ANY($5::text[]) AND (wa_id IS NULL OR wa_id = phone)))
     ORDER BY (wa_id = $4) IS TRUE DESC, (phone = $3) DESC, created_at LIMIT 1`,
    [contact.workspace_id, contact.id, newPhone, newWaId, phoneVariants(newWaId).filter((v) => v !== newPhone)],
  );
  const otherId = other.rows[0]?.id ?? null;
  if (!otherId) await q.query(`UPDATE contacts SET phone = $2, wa_id = $3, updated_at = now() WHERE id = $1`, [contact.id, newPhone, newWaId]);
  await recordEvent(q, {
    workspaceId: contact.workspace_id,
    contactId: contact.id,
    type: 'number_changed',
    data: {
      old_wa_id: waId,
      new_wa_id: newWaId,
      old_phone: cur.phone,
      new_phone: newPhone,
      moved: !otherId,
      other_contact_id: otherId,
      changed_at: changedAt,
    },
  });
}

/** On a redo the first attempt's view is gone: the lead counts as new when this message opened its conversation. */
async function startedConversation(ctx: AppContext, m: MessageRow): Promise<boolean> {
  const { rows } = await ctx.db.query(
    `SELECT 1 FROM contacts c WHERE c.id = $1 AND c.source LIKE 'whatsapp%'
       AND NOT EXISTS (SELECT 1 FROM messages o WHERE o.contact_id = c.id AND o.id <> $2 AND o.direction <> 'internal'
         AND o.created_at <= (SELECT created_at FROM messages WHERE id = $2))`,
    [m.contact_id, m.id],
  );
  return !!rows[0];
}

/**
 * Everything that follows a stored inbound message. Its jobs (media, automation, outgoing
 * webhooks) are queued in the transaction that sets followups_done, so a retried webhook
 * finishes exactly what is missing and two deliveries of one message never do it twice.
 */
async function inboundFollowups(ctx: AppContext, m: MessageRow, o: { isNew: boolean; automate: boolean }) {
  const ws = m.workspace_id;
  const row = publicRow(m);
  const fresh = await ctx.db.tx(async (q) => {
    if (!(await claimFollowups(q, m.id))) return null;
    if (m.media?.wa_media_id) await ctx.queue.enqueue('media.download', { messageId: m.id }, { workspaceId: ws }, q);
    if (o.automate) {
      await ctx.queue.enqueue('automation.inbound', { workspaceId: ws, contactId: m.contact_id, messageId: m.id, isNew: o.isNew }, {}, q);
    }
    const contact = await getContact(q, ws, m.contact_id);
    // In this transaction: a retry neither loses nor repeats the deliveries.
    await dispatchWebhook(ctx, ws, 'message.received', { ...row, contact }, q);
    return contact;
  });
  if (!fresh) return;
  ctx.queue.notify();
  ctx.realtime.emit(ws, 'message:new', row);
  ctx.realtime.emit(ws, 'contact:update', fresh);
}

// Delivery/read statuses of a campaign arrive by the thousands: refresh viewers at most every
// 2 s. A trailing event always follows the last change (a finished campaign's page no longer
// polls, so these events are its only refresh).
const BROADCAST_NOTIFY_MS = 2000;
const broadcastNotify = new Map<string, { last: number; timer: NodeJS.Timeout | null }>();
function notifyBroadcastProgress(ctx: AppContext, workspaceId: string, broadcastId: string) {
  const now = Date.now();
  const st = broadcastNotify.get(broadcastId) ?? { last: 0, timer: null };
  broadcastNotify.set(broadcastId, st);
  const emit = () => ctx.realtime.emit(workspaceId, 'broadcast:update', { id: broadcastId });
  if (now - st.last >= BROADCAST_NOTIFY_MS) {
    st.last = now;
    emit();
  } else if (!st.timer) {
    st.timer = setTimeout(() => {
      st.timer = null;
      st.last = Date.now();
      emit();
    }, BROADCAST_NOTIFY_MS - (now - st.last));
    st.timer.unref?.();
  }
  if (broadcastNotify.size > 1000) {
    for (const [k, v] of broadcastNotify) if (!v.timer && now - v.last >= BROADCAST_NOTIFY_MS) broadcastNotify.delete(k);
  }
}

/**
 * The outgoing message a status is about. Only messages of the channel whose app secret signed
 * the payload: a channel the tenant controls must never change (or refund) messages sent
 * through another channel. Messages whose channel was deleted (channel_id set to NULL, e.g. a
 * number disconnected and connected again) still get their late statuses; whether a status may
 * move prepaid money is decided apart (billingTrusted), so an orphan is no way into the wallet.
 */
type StatusTarget = MessageRow & { phone: string; contact_wa_id: string | null; default_country_code: string | null };

async function statusTarget(ctx: AppContext, channel: ChannelRow, st: any): Promise<StatusTarget | null> {
  const select = `SELECT m.*, c.phone, c.wa_id AS contact_wa_id,
       (SELECT w.default_country_code FROM workspaces w WHERE w.id = m.workspace_id) AS default_country_code
     FROM messages m JOIN contacts c ON c.id = m.contact_id
     WHERE m.workspace_id = $2 AND (m.channel_id = $3 OR m.channel_id IS NULL) AND m.direction = 'out'`;
  const { rows } = await ctx.db.query<StatusTarget>(`${select} AND m.wamid = $1`, [st.id ?? null, channel.workspace_id, channel.id]);
  if (rows[0]) return rows[0];
  // A send whose answer from Meta was lost has no wamid: Meta echoes the message id that
  // sendMessage put in biz_opaque_callback_data, so its statuses still settle it.
  const cb = st.biz_opaque_callback_data;
  if (!st.id || typeof cb !== 'string' || !UUID_RE.test(cb)) return null;
  const lost = await ctx.db.query<StatusTarget>(`${select} AND m.id = $1 AND m.wamid IS NULL`, [cb, channel.workspace_id, channel.id]);
  return lost.rows[0] ?? null;
}

/**
 * A status names the WhatsApp id Meta delivered to (Brazil's 9th digit, Argentina's 9): remember
 * it as a send's answer does, so replies from it land on this contact even when that answer was
 * lost. Same guard as sendMessage: never an id that another contact already holds. Only another
 * form of the number the contact has now: a late status of a message sent before the customer
 * changed number names the old one, and a status signed with a secret the business knew could
 * name any number (sends go to, and are priced by, the wa_id).
 */
async function rememberRecipient(ctx: AppContext, msg: StatusTarget, recipientId: unknown) {
  const waId = digitsOnly(String(recipientId ?? ''));
  if (!/^\d{6,20}$/.test(waId) || waId === msg.phone || (msg.contact_wa_id && msg.contact_wa_id !== msg.phone)) return;
  const forms = lineForms(waId);
  if (!forms.includes(msg.phone)) return;
  await ctx.db
    .query(
      `UPDATE contacts SET wa_id = $2 WHERE id = $1 AND phone = ANY($4::text[]) AND (wa_id IS NULL OR wa_id = phone)
         AND NOT EXISTS (SELECT 1 FROM contacts o WHERE o.workspace_id = $3 AND o.wa_id = $2 AND o.id <> $1)`,
      [msg.contact_id, waId, msg.workspace_id, forms],
    )
    .catch((err) => ctx.log.warn({ err: (err as Error).message, contactId: msg.contact_id }, 'storing wa_id from status failed'));
}

/**
 * Returns false when the message is unknown (not sent by LeadLibre, or not stored yet).
 * `billingTrusted` false: the payload was signed with a secret the tenant may know, so it may
 * update the status of a message the prepaid wallet paid for, but never reconcile or refund it.
 */
export async function processStatus(ctx: AppContext, channel: ChannelRow, st: any, billingTrusted = true): Promise<boolean> {
  const msg = await statusTarget(ctx, channel, st);
  if (!msg) return false;
  const status: string = st.status;
  if (!['sent', 'delivered', 'read', 'failed'].includes(status)) return true;

  let walletMoved = false;
  const result = await ctx.db.tx(async (q) => {
    // Lock the row: Meta can deliver several statuses of one message at the same time.
    const locked = await q.query<MessageRow>(`SELECT * FROM messages WHERE id = $1 FOR UPDATE`, [msg.id]);
    Object.assign(msg, locked.rows[0]);
    if (msg.wamid !== st.id) {
      // Matched through the callback data: the status tells us the wamid the send never got.
      const claimed = await q.query(
        `UPDATE messages SET wamid = $2 WHERE id = $1 AND wamid IS NULL
           AND NOT EXISTS (SELECT 1 FROM messages o WHERE o.workspace_id = $3 AND o.wamid = $2) RETURNING id`,
        [msg.id, st.id, msg.workspace_id],
      );
      if (!claimed.rows[0]) return null;
      msg.wamid = st.id;
    }
    const wasReconciled = msg.pricing_reconciled;
    const settles = billingTrusted || !msg.charged_prepaid;
    // Priced by the number the message went to, as the send was: the one Meta names when the status is its word.
    const recipient = digitsOnly(String(st.recipient_id ?? ''));
    const billedTo = billingTrusted && isValidPhone(recipient) ? recipient : deliveryNumber(msg.phone, msg.contact_wa_id, msg.default_country_code);
    // Meta only bills delivered messages. Two facts the status shown cannot keep are kept in the
    // payload: that it was delivered ('failed' replaces 'delivered', and a delivery processed after
    // the failure is not shown), and that a failure whose word settles billing was handled. That first
    // one decides whether the charge goes back; an untrusted copy before it only shows the failure,
    // and a repeat (redelivered, or run again by a retried job) decides nothing again.
    const facts = (msg.payload ?? {}) as { delivered?: boolean; failure_settled?: boolean };
    const isDelivery = status === 'delivered' || status === 'read';
    const delivered = !!facts.delivered || msg.status === 'delivered' || msg.status === 'read';
    const settlesFailure = settles && status === 'failed' && !facts.failure_settled;
    const undelivered = settlesFailure && !delivered;
    if (settles && st.pricing) await reconcilePricing(ctx, q, msg, billedTo, st.pricing);
    else if (undelivered) await reconcilePricing(ctx, q, msg, billedTo, null);
    // A failure after a billable "sent" gives the charge back.
    if (undelivered && wasReconciled && Number(msg.cost) > 0) {
      await q.query(`UPDATE messages SET cost = 0 WHERE id = $1`, [msg.id]);
      await refund(q, msg.workspace_id, Number(msg.cost), {
        messageId: msg.id,
        broadcastId: msg.broadcast_id,
        prepaid: !!msg.charged_prepaid,
        description: UNDELIVERED_REFUND,
      });
      walletMoved = true;
    }
    // Delivered after all: its failure was processed first (statuses of one message may be handled out
    // of order) and gave the charge back. Meta billed the delivery, so that refund is taken back, once.
    const billed = isDelivery && st.pricing?.billable !== false;
    if (settles && billed && msg.status === 'failed' && wasReconciled && Number(msg.cost) === 0) {
      const given = await q.query<{ amount: string | number }>(
        `SELECT COALESCE(sum(amount), 0) AS amount FROM credit_ledger WHERE message_id = $1 AND kind = 'refund' AND description = $2`,
        [msg.id, UNDELIVERED_REFUND],
      );
      const back = roundMoney(Number(given.rows[0]?.amount ?? 0));
      if (back > 0) {
        await q.query(`UPDATE messages SET cost = $2 WHERE id = $1`, [msg.id, back]);
        await charge(q, msg.workspace_id, back, {
          messageId: msg.id,
          broadcastId: msg.broadcast_id,
          prepaid: !!msg.charged_prepaid,
          force: true,
          description: 'Cargo: mensaje entregado después de reportarse como fallido',
        });
        walletMoved = true;
      }
    }
    const learned: Record<string, true> = {};
    if (!facts.delivered && (delivered || isDelivery) && (status === 'failed' || msg.status === 'failed')) learned.delivered = true;
    if (settlesFailure) learned.failure_settled = true;
    if (Object.keys(learned).length) {
      await q.query(`UPDATE messages SET payload = COALESCE(payload, '{}'::jsonb) || $2::jsonb WHERE id = $1`, [msg.id, JSON.stringify(learned)]);
    }

    let error: unknown = null;
    if (status === 'failed') {
      const e = st.errors?.[0] ?? {};
      error = {
        code: e.code ?? null,
        title: e.title ?? e.message ?? 'Error',
        message: explainMetaError(e.code, e.error_data?.details ?? e.message ?? e.title ?? 'Mensaje no entregado'),
      };
    }
    if (status === 'failed' && msg.status === 'failed') {
      // The same failure again (Meta redelivers, a retried job runs every status of its payload): it was
      // already stored and reported. A different explanation (e.g. Meta's own, for a send we had given
      // up on) replaces ours, without telling integrations about one failure twice.
      const r = await q.query<MessageRow>(`UPDATE messages SET error = $2 WHERE id = $1 AND error IS DISTINCT FROM $2::jsonb RETURNING *`, [
        msg.id,
        JSON.stringify(error),
      ]);
      if (!r.rows[0]) return { row: msg as MessageRow, changed: false };
      if (msg.broadcast_id) {
        await q.query(`UPDATE broadcast_recipients SET error = $2 WHERE message_id = $1`, [msg.id, (error as any).message]);
      }
      return { row: r.rows[0], changed: true };
    }
    const canUpgrade =
      status === 'failed' ? msg.status !== 'read' : (STATUS_RANK[status] ?? 0) > (STATUS_RANK[msg.status] ?? -1) && msg.status !== 'failed';
    if (!canUpgrade) return { row: msg as MessageRow, changed: false };
    // A confirmed send drops the "could not confirm" error of a lost answer.
    const r = await q.query<MessageRow>(
      `UPDATE messages SET status = $2, error = CASE WHEN $3::jsonb IS NOT NULL THEN $3::jsonb WHEN status = 'unknown' THEN NULL ELSE error END,
         status_updated_at = now() WHERE id = $1 RETURNING *`,
      [msg.id, status, error ? JSON.stringify(error) : null],
    );
    const row = r.rows[0];
    if (msg.broadcast_id) {
      await q.query(
        `UPDATE broadcast_recipients SET status = CASE WHEN $2 = 'failed' THEN 'failed' ELSE 'sent' END,
           error = COALESCE($3, error) WHERE message_id = $1`,
        [msg.id, status, status === 'failed' ? (error as any)?.message ?? null : null],
      );
    }
    // Queued with the status itself: a retry after a failure here stores and reports it again.
    await dispatchWebhook(
      ctx,
      channel.workspace_id,
      'message.status',
      { id: row.id, wamid: row.wamid, contact_id: row.contact_id, status: row.status, error: row.error },
      q,
    );
    return { row, changed: true };
  });
  if (walletMoved) notifyCredits(ctx, channel.workspace_id);
  // The send already has another wamid: this status is not about it.
  if (!result) return true;
  await rememberRecipient(ctx, msg, st.recipient_id);
  const { row, changed } = result;
  if (changed) {
    ctx.queue.notify();
    ctx.realtime.emit(channel.workspace_id, 'message:update', publicRow(row));
    if (row.broadcast_id) notifyBroadcastProgress(ctx, channel.workspace_id, row.broadcast_id);
  }
  return true;
}

/** Coexistence: messages the business sent from the WhatsApp Business app on the phone. */
async function processEchoes(ctx: AppContext, value: any, allowed: string[] | null, receivedAt: () => Promise<number>, nextSeq: () => number) {
  const channel = await channelByPhoneNumberId(ctx, value.metadata?.phone_number_id, allowed);
  if (!channel) return;
  let failure: unknown = null;
  const echoes: any[] = value.message_echoes ?? [];
  for (let i = 0; i < echoes.length; i++) {
    if (i) await yieldToEventLoop();
    try {
      await processEcho(ctx, channel, echoes[i], await receivedAt(), nextSeq());
    } catch (err) {
      const e = keepTransient(ctx, err, { channel: channel.id, wamid: echoes[i]?.id });
      failure ??= e;
    }
  }
  if (failure) throw failure;
}

async function processEcho(ctx: AppContext, channel: ChannelRow, echo: any, receivedUs: number, seq: number) {
  if (isMessageChange(echo)) {
    await applyMessageChange(ctx, channel, echo, 'out');
    return;
  }
  const stored = await storedMessage(ctx, channel.workspace_id, echo.id);
  if (stored) {
    if (stored.followups_done === false) await echoFollowups(ctx, stored);
    return;
  }
  const waId = digitsOnly(String(echo.to ?? ''));
  const waTs = metaSeconds(echo.timestamp);
  const { contact } = await contactForWaId(ctx, channel, waId, waTs ?? Math.floor(receivedUs / 1_000_000), { source: 'whatsapp' });
  const parsed = parseInboundContent(echo);
  const inserted = await ctx.db.tx(async (q) => {
    await lockChannel(q, channel.id);
    await q.query(`SELECT 1 FROM contacts WHERE id = $1 FOR NO KEY UPDATE`, [contact.id]);
    const createdAt = await chatTime(q, contact.id, messageTime(echo.timestamp, receivedUs, seq), waTs, lateDelivery(echo.timestamp, receivedUs));
    const { rows } = await q.query<MessageRow>(
      `INSERT INTO messages (workspace_id, contact_id, channel_id, direction, type, body, media, payload, wamid, status, sent_by, created_at, followups_done, wa_ts)
       VALUES ($1, $2, $3, 'out', $4, $5, $6, $7, $8, 'sent', 'phone', $9, false, $10)
       ON CONFLICT (workspace_id, wamid) DO NOTHING RETURNING *`,
      [
        channel.workspace_id,
        contact.id,
        channel.id,
        parsed.type,
        parsed.body,
        parsed.media ? JSON.stringify(parsed.media) : null,
        parsed.payload ? JSON.stringify(parsed.payload) : null,
        echo.id,
        createdAt,
        waTs,
      ],
    );
    const m = rows[0];
    if (!m) return null;
    // A reply typed in the WhatsApp Business app is a human taking over, exactly like a reply
    // from the inbox (services/messages.ts): the bot and the AI agent stop talking over it. The
    // bot is marked done even when it never started, or the customer's answer would start it.
    // A late echo does not mark newer customer messages as read.
    await q.query(
      `UPDATE contacts SET last_message_at = GREATEST(COALESCE(last_message_at, $2), $2),
         last_message_preview = CASE WHEN last_message_at IS NULL OR $2 >= last_message_at THEN $3 ELSE last_message_preview END,
         unread_count = CASE WHEN last_inbound_at IS NULL OR $2 >= last_inbound_at THEN 0 ELSE unread_count END,
         bot_state = jsonb_set(COALESCE(bot_state, '{"path":[]}'::jsonb), '{done}', 'true'),
         ai_paused = true, channel_id = COALESCE(channel_id, $4), updated_at = now()
       WHERE id = $1`,
      [contact.id, createdAt, previewFor(parsed.type, parsed.body), channel.id],
    );
    return m;
  });
  const m = inserted ?? (await storedMessage(ctx, channel.workspace_id, echo.id));
  if (m && m.followups_done === false) await echoFollowups(ctx, m);
}

async function echoFollowups(ctx: AppContext, m: MessageRow) {
  const claimed = await ctx.db.tx(async (q) => {
    if (!(await claimFollowups(q, m.id))) return false;
    if (m.media?.wa_media_id) await ctx.queue.enqueue('media.download', { messageId: m.id }, { workspaceId: m.workspace_id }, q);
    return true;
  });
  if (!claimed) return;
  ctx.queue.notify();
  ctx.realtime.emit(m.workspace_id, 'message:new', publicRow(m));
  ctx.realtime.emit(m.workspace_id, 'contact:update', await getContact(ctx.db, m.workspace_id, m.contact_id));
}

/**
 * `at` is when Meta raised the event: one older than the last applied (a redelivery after an outage,
 * a job retried for another change of its payload) is stale and changes nothing.
 */
async function processTemplateStatus(ctx: AppContext, wabaId: string, value: any, allowed: string[] | null, at: string | null) {
  const event = String(value.event ?? '').toUpperCase();
  if (event === 'UNARCHIVED') return restoreTemplates(ctx, wabaId, value, allowed, at);
  const status = event === 'REINSTATED' ? 'APPROVED' : TEMPLATE_STATUSES.has(event) ? event : null;
  if (!status) {
    ctx.log.debug({ event, template: value.message_template_name }, 'template event leaves the status unchanged');
    return;
  }
  const { rows } = await ctx.db.query<{ workspace_id: string; id: string }>(
    `UPDATE templates t SET status = $1, rejected_reason = NULLIF($2, 'NONE'), status_event_at = COALESCE($8::timestamptz, t.status_event_at), updated_at = now()
     FROM channels ch
     WHERE ch.id = t.channel_id AND ch.waba_id = $3
       AND (t.meta_id = $4 OR (t.name = $5 AND t.language = $6))
       AND ($7::uuid[] IS NULL OR ch.id = ANY($7::uuid[]))
       AND ($8::timestamptz IS NULL OR t.status_event_at IS NULL OR t.status_event_at <= $8::timestamptz)
     RETURNING t.workspace_id, t.id`,
    [
      status,
      value.reason ?? null,
      wabaId,
      String(value.message_template_id ?? ''),
      value.message_template_name ?? '',
      value.message_template_language ?? '',
      allowed,
      at,
    ],
  );
  for (const r of rows) ctx.realtime.emit(r.workspace_id, 'template:update', { id: r.id });
  // Fixing a rejected template (or editing an approved one) happens in WhatsApp Manager: it
  // keeps its id, name and language and comes back APPROVED with other content.
  if (status === 'APPROVED') await queueTemplateRefresh(ctx, rows);
}

/**
 * UNARCHIVED: Meta restored an archived template to the status it had before (not always APPROVED).
 * The event is dated like a status, so an older ARCHIVED delivered after it changes nothing; the
 * template.refresh job then adopts the status Meta has for it.
 */
async function restoreTemplates(ctx: AppContext, wabaId: string, value: any, allowed: string[] | null, at: string | null) {
  const { rows } = await ctx.db.query<{ workspace_id: string; id: string }>(
    `UPDATE templates t SET status_event_at = COALESCE($6::timestamptz, t.status_event_at), updated_at = now()
     FROM channels ch
     WHERE ch.id = t.channel_id AND ch.waba_id = $1 AND (t.meta_id = $2 OR (t.name = $3 AND t.language = $4))
       AND ($5::uuid[] IS NULL OR ch.id = ANY($5::uuid[]))
       AND ($6::timestamptz IS NULL OR t.status_event_at IS NULL OR t.status_event_at <= $6::timestamptz)
     RETURNING t.workspace_id, t.id`,
    [wabaId, String(value.message_template_id ?? ''), value.message_template_name ?? '', value.message_template_language ?? '', allowed, at],
  );
  for (const r of rows) {
    // Its own key: a components refresh already queued keeps the stored status.
    await ctx.queue.enqueue(
      'template.refresh',
      { workspaceId: r.workspace_id, templateId: r.id, restore: true },
      { dedupeKey: `template.restore:${r.id}`, maxAttempts: 8 },
    );
  }
}

/** Meta changed a template's content (message_template_components_update). */
async function refreshTemplates(ctx: AppContext, wabaId: string, value: any, allowed: string[] | null) {
  const { rows } = await ctx.db.query<{ workspace_id: string; id: string }>(
    `SELECT t.workspace_id, t.id FROM templates t JOIN channels ch ON ch.id = t.channel_id
     WHERE ch.waba_id = $1 AND (t.meta_id = $2 OR (t.name = $3 AND t.language = $4))
       AND ($5::uuid[] IS NULL OR ch.id = ANY($5::uuid[]))`,
    [wabaId, String(value.message_template_id ?? ''), value.message_template_name ?? '', value.message_template_language ?? '', allowed],
  );
  await queueTemplateRefresh(ctx, rows);
}

/** The webhook carries no components: the template.refresh job reads them from Meta. */
async function queueTemplateRefresh(ctx: AppContext, rows: { workspace_id: string; id: string }[]) {
  for (const r of rows) {
    await ctx.queue.enqueue('template.refresh', { workspaceId: r.workspace_id, templateId: r.id }, { dedupeKey: `template.refresh:${r.id}` });
  }
}

async function processTemplateCategory(ctx: AppContext, wabaId: string, value: any, allowed: string[] | null, at: string | null) {
  const category = String(value.new_category ?? '').toLowerCase();
  if (!TEMPLATE_CATEGORIES.has(category)) {
    ctx.log.warn({ category: value.new_category, template: value.message_template_name }, 'template category update ignored');
    return;
  }
  // Meta recategorizes each language version on its own (each has its own template id). Applied in
  // event order, as statuses are.
  await ctx.db.query(
    `UPDATE templates t SET category = $1, category_event_at = COALESCE($7::timestamptz, t.category_event_at), updated_at = now() FROM channels ch
     WHERE ch.id = t.channel_id AND ch.waba_id = $2 AND (t.meta_id = $3 OR (t.name = $4 AND t.language = $5))
       AND ($6::uuid[] IS NULL OR ch.id = ANY($6::uuid[]))
       AND ($7::timestamptz IS NULL OR t.category_event_at IS NULL OR t.category_event_at <= $7::timestamptz)`,
    [category, wabaId, String(value.message_template_id ?? ''), value.message_template_name ?? '', value.message_template_language ?? '', allowed, at],
  );
}
