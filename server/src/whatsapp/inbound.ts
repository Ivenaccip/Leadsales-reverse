import type { AppContext } from '../context.js';
import type { Queryable } from '../db/index.js';
import type { Job } from '../jobs/queue.js';
import { AppError, notFound } from '../lib/errors.js';
import { digitsOnly, isValidPhone, normalizePhone, phoneVariants } from '../lib/phone.js';
import { createContact, getContact, type Contact } from '../services/contacts.js';
import { notifyCredits, reconcilePricing, refund } from '../services/credits.js';
import { dispatchWebhook, recordEvent } from '../services/events.js';
import { previewFor } from '../services/messages.js';
import type { ChannelRow, MessageRow } from '../types.js';
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
// template can be sent again; FLAGGED, LOCKED and UNLOCKED are notices that leave it sendable.
const TEMPLATE_STATUSES = new Set(['APPROVED', 'REJECTED', 'PENDING', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION', 'DELETED', 'ARCHIVED', 'LIMIT_EXCEEDED']);

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
  const meta = ts ? Number(ts) * 1_000_000 : NaN;
  return (Number.isFinite(meta) && Math.abs(receivedUs - meta) >= 60_000_000 ? meta : receivedUs) + seq;
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
async function chatTime(q: Queryable, contactId: string, us: number, waTs: number | null): Promise<string> {
  if (waTs == null) return isoMicros(us);
  const after = await edgeTime(q, 'max', 'wa_ts < $2', [contactId, waTs]);
  // Placed this way, every message of an earlier Meta second is stored before those of later ones.
  const before = await edgeTime(q, 'min', 'wa_ts > $2 AND created_at > $3', [contactId, waTs, after == null ? '-infinity' : isoMicros(after)]);
  if (before != null && us >= before) {
    const prev = await edgeTime(q, 'max', 'created_at < $2', [contactId, isoMicros(before)]);
    return isoMicros(prev == null ? before - SLOT_US : await between(q, contactId, prev, before, true));
  }
  if (after != null && us <= after) {
    const next = await edgeTime(q, 'min', 'created_at > $2', [contactId, isoMicros(after)]);
    return isoMicros(await between(q, contactId, after, next, false));
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
  let changes = 0;
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      // Also between changes: a payload can carry hundreds of them with one message each.
      if (changes++) await yieldToEventLoop();
      const value = change.value ?? {};
      try {
        switch (change.field) {
          case 'messages':
            await processMessagesChange(ctx, value, job, trust, receivedAt);
            break;
          case 'smb_message_echoes':
            await processEchoes(ctx, value, allowed, receivedAt);
            break;
          case 'message_template_status_update':
            await processTemplateStatus(ctx, entry.id, value, allowed);
            break;
          case 'message_template_components_update':
            await refreshTemplates(ctx, entry.id, value, allowed);
            break;
          case 'template_category_update':
            await processTemplateCategory(ctx, entry.id, value, allowed);
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

async function channelByPhoneNumberId(ctx: AppContext, phoneNumberId: string | undefined, allowed: string[] | null): Promise<ChannelRow | null> {
  if (!phoneNumberId) return null;
  const { rows } = await ctx.db.query<ChannelRow>(
    `SELECT * FROM channels WHERE phone_number_id = $1 AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))`,
    [phoneNumberId, allowed],
  );
  return rows[0] ?? null;
}

async function processMessagesChange(ctx: AppContext, value: any, job: Job | undefined, trust: Trust, receivedAt: () => Promise<number>) {
  const channel = await channelByPhoneNumberId(ctx, value.metadata?.phone_number_id, trust.allowed);
  if (!channel) {
    ctx.log.warn({ phoneNumberId: value.metadata?.phone_number_id }, 'webhook for unknown phone number id');
    return;
  }
  let failure: unknown = null;
  const messages: any[] = value.messages ?? [];
  for (let i = 0; i < messages.length; i++) {
    if (i) await yieldToEventLoop();
    const msg = messages[i];
    const profile = (value.contacts ?? []).find((c: any) => c.wa_id === msg.from) ?? value.contacts?.[0];
    try {
      await processInboundMessage(ctx, channel, msg, profile, await receivedAt(), i);
    } catch (err) {
      const e = keepTransient(ctx, err, { channel: channel.id, wamid: msg?.id });
      failure ??= e;
    }
  }
  let missing = false;
  const settles = billingTrusted(channel, trust);
  for (const st of value.statuses ?? []) {
    await yieldToEventLoop();
    try {
      const found = await processStatus(ctx, channel, st, settles);
      const recent = Date.now() / 1000 - Number(st.timestamp ?? 0) < 300;
      if (!found && recent && (job?.attempts ?? 99) < 3) missing = true;
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
 * Finds the contact behind a WhatsApp id. Meta's wa_id can differ from the number we stored
 * (Brazil's 9th digit, Argentina's 9...), and sends record the wa_id Meta answers with, so a
 * contact already holding this wa_id wins. Next comes a lead stored under another form of the
 * same number that no other WhatsApp id claimed yet (it then learns this wa_id); otherwise
 * match or create by phone. A wa_id is already international: the workspace country code
 * must never be added to it.
 */
async function contactForWaId(
  ctx: AppContext,
  channel: ChannelRow,
  waId: string,
  extra: { name?: string | null; source: string },
): Promise<Contact> {
  if (waId) {
    const phone = normalizePhone(`+${waId}`);
    const { rows } = await ctx.db.query<{ id: string }>(
      `SELECT id FROM contacts WHERE workspace_id = $1 AND wa_id = $2 ORDER BY (phone = $3) DESC, created_at ASC LIMIT 1`,
      [channel.workspace_id, waId, phone],
    );
    if (rows[0]) return getContact(ctx.db, channel.workspace_id, rows[0].id);
    const variants = phoneVariants(waId).filter((v) => v !== phone);
    if (variants.length) {
      const { rows: same } = await ctx.db.query<{ id: string }>(
        `SELECT id FROM contacts WHERE workspace_id = $1 AND phone = ANY($2::text[]) AND (wa_id IS NULL OR wa_id = phone)
           AND NOT EXISTS (SELECT 1 FROM contacts o WHERE o.workspace_id = $1 AND o.phone = $3)
         ORDER BY created_at ASC LIMIT 1`,
        [channel.workspace_id, variants, phone],
      );
      if (same[0]) return getContact(ctx.db, channel.workspace_id, same[0].id);
    }
  }
  const { contact } = await createContact(ctx, channel.workspace_id, {
    phone: `+${waId}`,
    waId,
    name: extra.name ?? null,
    source: extra.source,
    channelId: channel.id,
  });
  return contact;
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
  const parsed = parseInboundContent(msg);
  const isSystem = parsed.type === 'system';
  const optOut = optOutKeyword(parsed);
  // Someone asking to stop must not get an automatic answer; WhatsApp notices are not messages.
  const automate = parsed.type !== 'reaction' && !isSystem && !optOut;

  // A redelivery must not create or update contacts again (the number may have moved since).
  const stored = await storedMessage(ctx, channel.workspace_id, msg.id);
  if (stored) return finishDuplicate(ctx, stored, automate);

  const waId = digitsOnly(String(msg.from ?? ''));
  const profileName: string | null = profile?.profile?.name ?? null;
  const referral = msg.referral ?? null;
  const contact = await contactForWaId(ctx, channel, waId, { name: profileName, source: referral ? 'whatsapp_ad' : 'whatsapp' });

  const payload = referral ? { ...(parsed.payload ?? {}), referral } : parsed.payload;
  const waTs = metaSeconds(msg.timestamp);
  const preview = previewFor(parsed.type, parsed.body);

  let isNew = false;
  const inserted = await ctx.db.tx(async (q) => {
    await lockChannel(q, channel.id);
    // The contact row lock comes before the INSERT: messages of one chat handled at once are
    // placed (and counted as the lead's first) one after another. NO KEY UPDATE still lets the
    // INSERT below take its foreign-key share lock on this row.
    const prev = await q.query<{ opened: boolean }>(
      `SELECT last_message_at IS NULL AND source LIKE 'whatsapp%' AS opened FROM contacts WHERE id = $1 FOR NO KEY UPDATE`,
      [contact.id],
    );
    const createdAt = await chatTime(q, contact.id, messageTime(msg.timestamp, receivedUs, seq), waTs);
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
      await applySystemNotice(q, contact, waId, msg.system, createdAt, preview);
    } else {
      // A lead is new while the conversation it started over WhatsApp has no message yet (read
      // under the lock: of several first messages only one is the first, and a retry after the
      // contact was created but before this INSERT still counts as new).
      isNew = !!prev.rows[0]?.opened;
      // The preview follows the newest message: Meta may deliver an older one late. A message
      // older than a reply typed in the WhatsApp Business app was already seen on the phone.
      // A sandbox message never moves a contact off its real (Cloud API) number: replies would
      // stop reaching WhatsApp (the simulate route refuses this too; this guards every other path).
      await q.query(
        `UPDATE contacts SET last_message_at = GREATEST(COALESCE(last_message_at, $2), $2), last_inbound_at = GREATEST(COALESCE(last_inbound_at, $2), $2),
           last_message_preview = CASE WHEN last_message_at IS NULL OR $2 >= last_message_at THEN $3 ELSE last_message_preview END,
           unread_count = unread_count + CASE WHEN $4::int > 0 AND NOT EXISTS (
             SELECT 1 FROM messages e WHERE e.contact_id = $1 AND e.sent_by = 'phone' AND e.created_at > $2) THEN $4::int ELSE 0 END,
           wa_id = $5,
           channel_id = CASE WHEN $8 AND EXISTS (SELECT 1 FROM channels ch WHERE ch.id = contacts.channel_id AND ch.provider = 'cloud_api')
             THEN channel_id ELSE $6 END,
           name = COALESCE(name, $7), is_archived = false, updated_at = now()
         WHERE id = $1`,
        [contact.id, createdAt, preview, parsed.type === 'reaction' ? 0 : 1, waId, channel.id, profileName, channel.provider === 'sandbox'],
      );
    }
    if (optOut && !contact.opted_out) {
      await q.query(`UPDATE contacts SET opted_out = true WHERE id = $1`, [contact.id]);
      await recordEvent(q, { workspaceId: channel.workspace_id, contactId: contact.id, type: 'opted_out', data: { keyword: optOut } });
    }
    return m;
  });
  if (!inserted) {
    const raced = await storedMessage(ctx, channel.workspace_id, msg.id);
    return raced ? finishDuplicate(ctx, raced, automate) : null;
  }
  await inboundFollowups(ctx, inserted, { isNew, automate });
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
 * unless another contact already has it (the event then links both).
 */
async function applySystemNotice(q: Queryable, contact: Contact, waId: string, system: any, createdAt: string, preview: string) {
  await q.query(
    `UPDATE contacts SET last_message_at = GREATEST(COALESCE(last_message_at, $2), $2),
       last_message_preview = CASE WHEN last_message_at IS NULL OR $2 >= last_message_at THEN $3 ELSE last_message_preview END,
       updated_at = now()
     WHERE id = $1`,
    [contact.id, createdAt, preview],
  );
  // Meta's reference names the type customer_changed_number; its sample payload user_changed_number.
  if (system?.type !== 'customer_changed_number' && system?.type !== 'user_changed_number') return;
  const newWaId = digitsOnly(String(system.new_wa_id ?? system.wa_id ?? ''));
  const newPhone = normalizePhone(`+${newWaId}`);
  if (!newWaId || newWaId === waId || !isValidPhone(newPhone)) return;
  const other = await q.query<{ id: string }>(
    `SELECT id FROM contacts WHERE workspace_id = $1 AND id <> $2 AND (phone = $3 OR wa_id = $4) ORDER BY created_at LIMIT 1`,
    [contact.workspace_id, contact.id, newPhone, newWaId],
  );
  const otherId = other.rows[0]?.id ?? null;
  if (!otherId) await q.query(`UPDATE contacts SET phone = $2, wa_id = $3, updated_at = now() WHERE id = $1`, [contact.id, newPhone, newWaId]);
  await recordEvent(q, {
    workspaceId: contact.workspace_id,
    contactId: contact.id,
    type: 'number_changed',
    data: { old_wa_id: waId, new_wa_id: newWaId, old_phone: contact.phone, new_phone: newPhone, moved: !otherId, other_contact_id: otherId },
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
type StatusTarget = MessageRow & { phone: string; contact_wa_id: string | null };

async function statusTarget(ctx: AppContext, channel: ChannelRow, st: any): Promise<StatusTarget | null> {
  const select = `SELECT m.*, c.phone, c.wa_id AS contact_wa_id FROM messages m JOIN contacts c ON c.id = m.contact_id
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
 * lost. Same guard as sendMessage: never an id that another contact already holds.
 */
async function rememberRecipient(ctx: AppContext, msg: StatusTarget, recipientId: unknown) {
  const waId = digitsOnly(String(recipientId ?? ''));
  if (!/^\d{6,20}$/.test(waId) || waId === msg.phone || (msg.contact_wa_id && msg.contact_wa_id !== msg.phone)) return;
  await ctx.db
    .query(
      `UPDATE contacts SET wa_id = $2 WHERE id = $1 AND (wa_id IS NULL OR wa_id = phone)
         AND NOT EXISTS (SELECT 1 FROM contacts o WHERE o.workspace_id = $3 AND o.wa_id = $2 AND o.id <> $1)`,
      [msg.contact_id, waId, msg.workspace_id],
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

  let refunded = false;
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
    if (settles && st.pricing) await reconcilePricing(ctx, q, msg, msg.phone, st.pricing);
    else if (settles && status === 'failed') await reconcilePricing(ctx, q, msg, msg.phone, null);
    // Meta only bills delivered messages: a failure after a billable "sent" gives the charge back.
    if (settles && status === 'failed' && wasReconciled && msg.status !== 'delivered' && msg.status !== 'read' && Number(msg.cost) > 0) {
      await q.query(`UPDATE messages SET cost = 0 WHERE id = $1`, [msg.id]);
      await refund(q, msg.workspace_id, Number(msg.cost), {
        messageId: msg.id,
        broadcastId: msg.broadcast_id,
        prepaid: !!msg.charged_prepaid,
        description: 'Reembolso: mensaje no entregado',
      });
      refunded = true;
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
  if (refunded) notifyCredits(ctx, channel.workspace_id);
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
async function processEchoes(ctx: AppContext, value: any, allowed: string[] | null, receivedAt: () => Promise<number>) {
  const channel = await channelByPhoneNumberId(ctx, value.metadata?.phone_number_id, allowed);
  if (!channel) return;
  let failure: unknown = null;
  const echoes: any[] = value.message_echoes ?? [];
  for (let i = 0; i < echoes.length; i++) {
    if (i) await yieldToEventLoop();
    try {
      await processEcho(ctx, channel, echoes[i], await receivedAt(), i);
    } catch (err) {
      const e = keepTransient(ctx, err, { channel: channel.id, wamid: echoes[i]?.id });
      failure ??= e;
    }
  }
  if (failure) throw failure;
}

async function processEcho(ctx: AppContext, channel: ChannelRow, echo: any, receivedUs: number, seq: number) {
  const stored = await storedMessage(ctx, channel.workspace_id, echo.id);
  if (stored) {
    if (stored.followups_done === false) await echoFollowups(ctx, stored);
    return;
  }
  const waId = digitsOnly(String(echo.to ?? ''));
  const contact = await contactForWaId(ctx, channel, waId, { source: 'whatsapp' });
  const parsed = parseInboundContent(echo);
  const waTs = metaSeconds(echo.timestamp);
  const inserted = await ctx.db.tx(async (q) => {
    await lockChannel(q, channel.id);
    await q.query(`SELECT 1 FROM contacts WHERE id = $1 FOR NO KEY UPDATE`, [contact.id]);
    const createdAt = await chatTime(q, contact.id, messageTime(echo.timestamp, receivedUs, seq), waTs);
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
         ai_paused = true, updated_at = now()
       WHERE id = $1`,
      [contact.id, createdAt, previewFor(parsed.type, parsed.body)],
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

async function processTemplateStatus(ctx: AppContext, wabaId: string, value: any, allowed: string[] | null) {
  const event = String(value.event ?? '').toUpperCase();
  const status = event === 'REINSTATED' ? 'APPROVED' : TEMPLATE_STATUSES.has(event) ? event : null;
  if (!status) {
    ctx.log.debug({ event, template: value.message_template_name }, 'template event leaves the status unchanged');
    return;
  }
  const { rows } = await ctx.db.query<{ workspace_id: string; id: string }>(
    `UPDATE templates t SET status = $1, rejected_reason = NULLIF($2, 'NONE'), updated_at = now()
     FROM channels ch
     WHERE ch.id = t.channel_id AND ch.waba_id = $3
       AND (t.meta_id = $4 OR (t.name = $5 AND t.language = $6))
       AND ($7::uuid[] IS NULL OR ch.id = ANY($7::uuid[]))
     RETURNING t.workspace_id, t.id`,
    [
      status,
      value.reason ?? null,
      wabaId,
      String(value.message_template_id ?? ''),
      value.message_template_name ?? '',
      value.message_template_language ?? '',
      allowed,
    ],
  );
  for (const r of rows) ctx.realtime.emit(r.workspace_id, 'template:update', { id: r.id });
  // Fixing a rejected template (or editing an approved one) happens in WhatsApp Manager: it
  // keeps its id, name and language and comes back APPROVED with other content.
  if (status === 'APPROVED') await queueTemplateRefresh(ctx, rows);
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

async function processTemplateCategory(ctx: AppContext, wabaId: string, value: any, allowed: string[] | null) {
  const category = String(value.new_category ?? '').toLowerCase();
  if (!category) return;
  // Meta recategorizes each language version on its own (each has its own template id).
  await ctx.db.query(
    `UPDATE templates t SET category = $1, updated_at = now() FROM channels ch
     WHERE ch.id = t.channel_id AND ch.waba_id = $2 AND (t.meta_id = $3 OR (t.name = $4 AND t.language = $5))
       AND ($6::uuid[] IS NULL OR ch.id = ANY($6::uuid[]))`,
    [category, wabaId, String(value.message_template_id ?? ''), value.message_template_name ?? '', value.message_template_language ?? '', allowed],
  );
}
