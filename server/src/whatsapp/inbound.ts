import type { AppContext } from '../context.js';
import type { Job } from '../jobs/queue.js';
import { normalizePhone } from '../lib/phone.js';
import { createContact, getContact } from '../services/contacts.js';
import { reconcilePricing } from '../services/credits.js';
import { dispatchWebhook, recordEvent } from '../services/events.js';
import { previewFor } from '../services/messages.js';
import type { ChannelRow, MessageRow } from '../types.js';
import { explainMetaError } from './types.js';

const STATUS_RANK: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3 };
const OPT_OUT_WORDS = new Set(['baja', 'stop', 'alto', 'cancelar suscripcion', 'cancelar suscripción', 'unsubscribe']);

class RetryLater extends Error {}

/**
 * Meta timestamps have 1-second resolution. For fresh events we keep the receipt
 * time (keeps chat order exact); late deliveries keep Meta's original time.
 */
function messageTime(ts: string | undefined): Date {
  const now = Date.now();
  const meta = ts ? Number(ts) * 1000 : now;
  return Math.abs(now - meta) < 60_000 ? new Date(now) : new Date(meta);
}

/** Entry point for every payload Meta posts to /webhooks/whatsapp (run from the job queue). */
export async function processWebhook(ctx: AppContext, body: any, job?: Job): Promise<void> {
  if (body?.object !== 'whatsapp_business_account') return;
  let retry = false;
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      try {
        switch (change.field) {
          case 'messages':
            await processMessagesChange(ctx, value, job);
            break;
          case 'smb_message_echoes':
            await processEchoes(ctx, value);
            break;
          case 'message_template_status_update':
            await processTemplateStatus(ctx, entry.id, value);
            break;
          case 'template_category_update':
            await processTemplateCategory(ctx, entry.id, value);
            break;
          default:
            ctx.log.debug({ field: change.field }, 'webhook field ignored');
        }
      } catch (err) {
        if (err instanceof RetryLater) retry = true;
        else throw err;
      }
    }
  }
  if (retry) throw new Error('Estados de mensajes aún no registrados; se reintentará');
}

async function channelByPhoneNumberId(ctx: AppContext, phoneNumberId: string | undefined): Promise<ChannelRow | null> {
  if (!phoneNumberId) return null;
  const { rows } = await ctx.db.query<ChannelRow>(`SELECT * FROM channels WHERE phone_number_id = $1`, [phoneNumberId]);
  return rows[0] ?? null;
}

async function processMessagesChange(ctx: AppContext, value: any, job?: Job) {
  const channel = await channelByPhoneNumberId(ctx, value.metadata?.phone_number_id);
  if (!channel) {
    ctx.log.warn({ phoneNumberId: value.metadata?.phone_number_id }, 'webhook for unknown phone number id');
    return;
  }
  for (const msg of value.messages ?? []) {
    const profile = (value.contacts ?? []).find((c: any) => c.wa_id === msg.from) ?? value.contacts?.[0];
    await processInboundMessage(ctx, channel, msg, profile);
  }
  let missing = false;
  for (const st of value.statuses ?? []) {
    const found = await processStatus(ctx, channel, st);
    const recent = Date.now() / 1000 - Number(st.timestamp ?? 0) < 300;
    if (!found && recent && (job?.attempts ?? 99) < 3) missing = true;
  }
  for (const err of value.errors ?? []) {
    ctx.log.warn({ channel: channel.id, err }, 'whatsapp webhook error');
  }
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
      return {
        ...base,
        body: m.caption ?? null,
        media: { wa_media_id: m.id, mime: m.mime_type, sha256: m.sha256, filename: m.filename ?? null, voice: m.voice ?? false },
      };
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

export async function processInboundMessage(ctx: AppContext, channel: ChannelRow, msg: any, profile?: any): Promise<MessageRow | null> {
  const ws = await ctx.db.query<{ default_country_code: string }>(`SELECT default_country_code FROM workspaces WHERE id = $1`, [
    channel.workspace_id,
  ]);
  const waId: string = String(msg.from);
  const phone = normalizePhone(waId, ws.rows[0]?.default_country_code);
  const profileName: string | null = profile?.profile?.name ?? null;
  const referral = msg.referral ?? null;

  const { contact, created } = await createContact(ctx, channel.workspace_id, {
    phone,
    waId,
    name: profileName,
    source: referral ? 'whatsapp_ad' : 'whatsapp',
    channelId: channel.id,
  });

  const parsed = parseInboundContent(msg);
  const payload = referral ? { ...(parsed.payload ?? {}), referral } : parsed.payload;
  const createdAt = messageTime(msg.timestamp);
  const isReaction = parsed.type === 'reaction';

  const inserted = await ctx.db.tx(async (q) => {
    const { rows } = await q.query<MessageRow>(
      `INSERT INTO messages (workspace_id, contact_id, channel_id, direction, type, body, media, payload, wamid,
         reply_to_wamid, status, sent_by, created_at)
       VALUES ($1, $2, $3, 'in', $4, $5, $6, $7, $8, $9, 'received', 'contact', $10)
       ON CONFLICT (wamid) DO NOTHING RETURNING *`,
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
      ],
    );
    const m = rows[0];
    if (!m) return null; // duplicate delivery
    await q.query(
      `UPDATE contacts SET last_message_at = GREATEST(COALESCE(last_message_at, $2), $2), last_inbound_at = GREATEST(COALESCE(last_inbound_at, $2), $2),
         last_message_preview = $3, unread_count = unread_count + $4, wa_id = $5, channel_id = $6,
         name = COALESCE(name, $7), is_archived = false, updated_at = now()
       WHERE id = $1`,
      [contact.id, createdAt, previewFor(parsed.type, parsed.body), isReaction ? 0 : 1, waId, channel.id, profileName],
    );
    const word = (parsed.body ?? '').trim().toLowerCase();
    if (parsed.type === 'text' && OPT_OUT_WORDS.has(word) && !contact.opted_out) {
      await q.query(`UPDATE contacts SET opted_out = true WHERE id = $1`, [contact.id]);
      await recordEvent(q, { workspaceId: channel.workspace_id, contactId: contact.id, type: 'opted_out', data: { keyword: word } });
    }
    return m;
  });
  if (!inserted) return null;

  if (parsed.media?.wa_media_id) {
    await ctx.queue.enqueue('media.download', { messageId: inserted.id }, { maxAttempts: 4 });
  }
  const fresh = await getContact(ctx.db, channel.workspace_id, contact.id);
  ctx.realtime.emit(channel.workspace_id, 'message:new', inserted);
  ctx.realtime.emit(channel.workspace_id, 'contact:update', fresh);
  await dispatchWebhook(ctx, channel.workspace_id, 'message.received', { ...inserted, contact: fresh });
  if (!isReaction) {
    await ctx.queue.enqueue('automation.inbound', { workspaceId: channel.workspace_id, contactId: contact.id, messageId: inserted.id, isNew: created });
  }
  return inserted;
}

/** Returns false when the message is unknown (not sent by LeadLibre, or not stored yet). */
export async function processStatus(ctx: AppContext, channel: ChannelRow, st: any): Promise<boolean> {
  const { rows } = await ctx.db.query<MessageRow & { phone: string }>(
    `SELECT m.*, c.phone FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE m.wamid = $1 AND m.workspace_id = $2`,
    [st.id, channel.workspace_id],
  );
  const msg = rows[0];
  if (!msg) return false;
  const status: string = st.status;
  if (!['sent', 'delivered', 'read', 'failed'].includes(status)) return true;

  const updated = await ctx.db.tx(async (q) => {
    // Lock the row: Meta can deliver several statuses of one message at the same time.
    const locked = await q.query<MessageRow>(`SELECT * FROM messages WHERE id = $1 FOR UPDATE`, [msg.id]);
    Object.assign(msg, locked.rows[0]);
    if (st.pricing) await reconcilePricing(ctx, q, msg, msg.phone, st.pricing);
    else if (status === 'failed') await reconcilePricing(ctx, q, msg, msg.phone, null);

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
    if (!canUpgrade) return null;
    const r = await q.query<MessageRow>(
      `UPDATE messages SET status = $2, error = COALESCE($3, error), status_updated_at = now() WHERE id = $1 RETURNING *`,
      [msg.id, status, error ? JSON.stringify(error) : null],
    );
    if (msg.broadcast_id) {
      await q.query(
        `UPDATE broadcast_recipients SET status = CASE WHEN $2 = 'failed' THEN 'failed' ELSE 'sent' END,
           error = COALESCE($3, error) WHERE message_id = $1`,
        [msg.id, status, status === 'failed' ? (error as any)?.message ?? null : null],
      );
    }
    return r.rows[0];
  });
  if (updated) {
    ctx.realtime.emit(channel.workspace_id, 'message:update', updated);
    await dispatchWebhook(ctx, channel.workspace_id, 'message.status', {
      id: updated.id,
      wamid: updated.wamid,
      contact_id: updated.contact_id,
      status: updated.status,
      error: updated.error,
    });
  }
  return true;
}

/** Coexistence: messages the business sent from the WhatsApp Business app on the phone. */
async function processEchoes(ctx: AppContext, value: any) {
  const channel = await channelByPhoneNumberId(ctx, value.metadata?.phone_number_id);
  if (!channel) return;
  for (const echo of value.message_echoes ?? []) {
    const ws = await ctx.db.query<{ default_country_code: string }>(`SELECT default_country_code FROM workspaces WHERE id = $1`, [
      channel.workspace_id,
    ]);
    const phone = normalizePhone(String(echo.to), ws.rows[0]?.default_country_code);
    const { contact } = await createContact(ctx, channel.workspace_id, { phone, waId: String(echo.to), channelId: channel.id, source: 'whatsapp' });
    const parsed = parseInboundContent(echo);
    const createdAt = messageTime(echo.timestamp);
    const { rows } = await ctx.db.query<MessageRow>(
      `INSERT INTO messages (workspace_id, contact_id, channel_id, direction, type, body, media, payload, wamid, status, sent_by, created_at)
       VALUES ($1, $2, $3, 'out', $4, $5, $6, $7, $8, 'sent', 'phone', $9)
       ON CONFLICT (wamid) DO NOTHING RETURNING *`,
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
      ],
    );
    if (!rows[0]) continue;
    await ctx.db.query(`UPDATE contacts SET last_message_at = GREATEST(COALESCE(last_message_at, $2), $2), last_message_preview = $3 WHERE id = $1`, [
      contact.id,
      createdAt,
      previewFor(parsed.type, parsed.body),
    ]);
    if (parsed.media?.wa_media_id) await ctx.queue.enqueue('media.download', { messageId: rows[0].id }, { maxAttempts: 4 });
    ctx.realtime.emit(channel.workspace_id, 'message:new', rows[0]);
  }
}

async function processTemplateStatus(ctx: AppContext, wabaId: string, value: any) {
  const { rows } = await ctx.db.query<{ workspace_id: string; id: string }>(
    `UPDATE templates t SET status = $1, rejected_reason = NULLIF($2, 'NONE'), updated_at = now()
     FROM channels ch
     WHERE ch.id = t.channel_id AND ch.waba_id = $3
       AND (t.meta_id = $4 OR (t.name = $5 AND t.language = $6))
     RETURNING t.workspace_id, t.id`,
    [
      String(value.event ?? '').toUpperCase(),
      value.reason ?? null,
      wabaId,
      String(value.message_template_id ?? ''),
      value.message_template_name ?? '',
      value.message_template_language ?? '',
    ],
  );
  for (const r of rows) ctx.realtime.emit(r.workspace_id, 'template:update', { id: r.id });
}

async function processTemplateCategory(ctx: AppContext, wabaId: string, value: any) {
  const category = String(value.new_category ?? '').toLowerCase();
  if (!category) return;
  await ctx.db.query(
    `UPDATE templates t SET category = $1, updated_at = now() FROM channels ch
     WHERE ch.id = t.channel_id AND ch.waba_id = $2 AND (t.meta_id = $3 OR t.name = $4)`,
    [category, wabaId, String(value.message_template_id ?? ''), value.message_template_name ?? ''],
  );
}
