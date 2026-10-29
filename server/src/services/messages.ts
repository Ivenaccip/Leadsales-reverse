import type { AppContext } from '../context.js';
import type { Queryable } from '../db/index.js';
import { AppError, badRequest } from '../lib/errors.js';
import type { MessageRow, WorkspaceRow } from '../types.js';
import { getChannel, providerFor } from '../whatsapp/provider.js';
import { explainMetaError, MetaApiError, type TemplateParams, type WaMessage } from '../whatsapp/types.js';
import { getContact } from './contacts.js';
import { charge, getRate, normalizeCategory, notifyCredits, refund } from './credits.js';
import { dispatchWebhook } from './events.js';
import { ensureUploaded, getMedia, waTypeForMime } from './media.js';
import { buildTemplateComponents, findTemplate, renderTemplateText } from './templates.js';

export type SendContent =
  | { type: 'text'; text: string }
  | { type: 'media'; mediaFileId: string; caption?: string }
  | { type: 'template'; name: string; language: string; params?: TemplateParams }
  | { type: 'interactive'; interactive: Record<string, unknown>; text: string };

export type SentBy = 'user' | 'bot' | 'ai' | 'broadcast' | 'api' | 'system' | 'scheduled';

export interface SendOptions {
  workspaceId: string;
  contactId: string;
  content: SendContent;
  sentBy: SentBy;
  userId?: string | null;
  broadcastId?: string | null;
  replyToWamid?: string | null;
  channelId?: string | null;
  /** Runs inside the transaction that stores (and charges) the message, e.g. to link it to a scheduled row atomically. */
  onCreated?: (q: Queryable, msg: MessageRow) => Promise<void>;
}

// Connection errors raised before the request reaches Meta: the message was certainly not sent.
const NOT_SENT_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Whether a send error proves WhatsApp did not take the message: Meta answered with an
 * error below 500, or the connection failed before the request went out. A 5xx, a reset or a timeout
 * after sending is ambiguous: Meta may have accepted (and billed) the message.
 */
export function isDefinitiveSendFailure(err: unknown): boolean {
  if (err instanceof MetaApiError) return err.httpStatus < 500;
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.cause?.code ?? e?.code;
  return typeof code === 'string' && NOT_SENT_CODES.has(code);
}

const WINDOW_MS = 24 * 3600 * 1000;

export function isWindowOpen(lastInboundAt: Date | string | null): boolean {
  return !!lastInboundAt && Date.now() - new Date(lastInboundAt).getTime() < WINDOW_MS;
}

const TYPE_LABEL: Record<string, string> = {
  image: '📷 Imagen',
  video: '🎬 Video',
  audio: '🎤 Audio',
  document: '📄 Documento',
  sticker: '💟 Sticker',
  location: '📍 Ubicación',
  contacts: '👤 Contacto',
  template: '📋 Plantilla',
  reaction: 'Reacción',
  order: '🛒 Pedido',
};

export function previewFor(type: string, body: string | null | undefined): string {
  const text = (body ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 120);
  return TYPE_LABEL[type] ?? 'Mensaje';
}

export async function getMessage(ctx: AppContext, workspaceId: string, id: string): Promise<MessageRow> {
  const { rows } = await ctx.db.query<MessageRow>(`SELECT * FROM messages WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]);
  if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'Mensaje no encontrado');
  return rows[0];
}

/**
 * Sends a WhatsApp message to a contact. Validation problems (window closed,
 * no credits, no channel) throw. Meta API failures are stored on the message
 * (status = failed) and the returned row carries the error, so the chat shows it.
 * When Meta's answer is lost (network error, timeout, 5xx) the status is 'unknown':
 * the charge is kept and nothing is resent automatically.
 */
export async function sendMessage(ctx: AppContext, o: SendOptions): Promise<MessageRow> {
  const ws = await ctx.db.query<{ is_active: boolean; billing_mode: string }>(`SELECT is_active, billing_mode FROM workspaces WHERE id = $1`, [
    o.workspaceId,
  ]);
  if (!ws.rows[0]?.is_active) throw new AppError(403, 'WORKSPACE_SUSPENDED', 'Este espacio de trabajo está suspendido');
  // Who pays is fixed at send time (messages.charged_prepaid): refunds and Meta adjustments
  // follow it, so a later billing_mode switch can neither create nor lose credits.
  const prepaid = ws.rows[0].billing_mode === 'prepaid';
  const contact = await getContact(ctx.db, o.workspaceId, o.contactId);
  const channel = await getChannel(ctx.db, o.workspaceId, o.channelId ?? contact.channel_id);
  const provider = providerFor(ctx, channel);
  const c = o.content;

  if (c.type !== 'template' && !isWindowOpen(contact.last_inbound_at)) {
    throw new AppError(
      400,
      'WINDOW_CLOSED',
      'Pasaron más de 24 horas desde el último mensaje del cliente. WhatsApp solo permite escribirle con una plantilla aprobada.',
    );
  }

  let wa: WaMessage;
  let type: string;
  let body: string | null = null;
  let mediaFileId: string | null = null;
  let payload: Record<string, unknown> | null = null;
  let category: string | null = null;

  switch (c.type) {
    case 'text': {
      if (!c.text.trim()) throw badRequest('El mensaje está vacío');
      type = 'text';
      body = c.text;
      wa = { type: 'text', text: { body: c.text, preview_url: /https?:\/\//.test(c.text) } };
      break;
    }
    case 'media': {
      const file = await getMedia(ctx, o.workspaceId, c.mediaFileId);
      type = waTypeForMime(file.mime);
      body = c.caption?.trim() || null;
      // WhatsApp drops text on audio and stickers: refuse instead of losing it silently.
      if (body && (type === 'audio' || type === 'sticker')) {
        throw badRequest('Los audios y stickers no admiten texto: envíalo como un mensaje aparte.', 'CAPTION_NOT_SUPPORTED');
      }
      mediaFileId = file.id;
      const id = await ensureUploaded(ctx, file, channel, provider);
      const obj: Record<string, unknown> = { id };
      if (body) obj.caption = body;
      if (type === 'document') obj.filename = file.filename ?? 'archivo';
      wa = { type, [type]: obj };
      break;
    }
    case 'template': {
      const tpl = await findTemplate(ctx.db, channel.id, c.name, c.language);
      if (tpl && tpl.status !== 'APPROVED') {
        throw badRequest(`La plantilla "${c.name}" no está aprobada por Meta (estado: ${tpl.status})`, 'TEMPLATE_NOT_APPROVED');
      }
      const components = buildTemplateComponents(c.params, tpl?.parameter_format === 'NAMED', tpl?.components ?? []);
      type = 'template';
      body = tpl ? renderTemplateText(tpl.components, c.params) : `[Plantilla ${c.name}]`;
      category = normalizeCategory(tpl?.category) ?? 'marketing';
      payload = { name: c.name, language: c.language, params: c.params ?? {}, category };
      wa = { type: 'template', template: { name: c.name, language: { code: c.language }, ...(components.length ? { components } : {}) } };
      break;
    }
    case 'interactive': {
      type = 'interactive';
      body = c.text;
      payload = { interactive: c.interactive };
      wa = { type: 'interactive', interactive: c.interactive };
      break;
    }
  }

  const cost = category && category !== 'service' ? await getRate(ctx.db, contact.phone, category as any) : 0;
  const humanTakeover = o.sentBy === 'user';

  const msg = await ctx.db.tx(async (q) => {
    const { rows } = await q.query<MessageRow>(
      `INSERT INTO messages (workspace_id, contact_id, channel_id, direction, type, body, media_file_id, payload,
         reply_to_wamid, status, sent_by, user_id, broadcast_id, billing_category, cost, charged_prepaid)
       VALUES ($1, $2, $3, 'out', $4, $5, $6, $7, $8, 'pending', $9, $10, $11, $12, $13, $14) RETURNING *`,
      [
        o.workspaceId,
        contact.id,
        channel.id,
        type,
        body,
        mediaFileId,
        payload ? JSON.stringify(payload) : null,
        o.replyToWamid ?? null,
        o.sentBy,
        o.userId ?? null,
        o.broadcastId ?? null,
        category,
        cost,
        prepaid,
      ],
    );
    const m = rows[0];
    if (cost > 0) {
      await charge(q, o.workspaceId, cost, {
        messageId: m.id,
        broadcastId: o.broadcastId,
        userId: o.userId,
        prepaid,
        description: `Plantilla ${category} a +${contact.phone}`,
      });
    }
    await q.query(
      `UPDATE contacts SET last_message_at = now(), last_message_preview = $2, updated_at = now(),
         unread_count = CASE WHEN $3 THEN 0 ELSE unread_count END,
         bot_state = CASE WHEN $3 AND bot_state IS NOT NULL THEN jsonb_set(bot_state, '{done}', 'true') ELSE bot_state END,
         ai_paused = CASE WHEN $3 THEN true ELSE ai_paused END,
         channel_id = COALESCE(channel_id, $4)
       WHERE id = $1`,
      [contact.id, previewFor(type, body), humanTakeover, channel.id],
    );
    if (o.onCreated) await o.onCreated(q, m);
    return m;
  });
  ctx.realtime.emit(o.workspaceId, 'message:new', msg);
  if (cost > 0) notifyCredits(ctx, o.workspaceId);

  // Meta echoes biz_opaque_callback_data in status webhooks: if the answer to a billable send
  // is lost, its statuses can still be matched to this row and reconciled.
  if (wa.type === 'template') wa = { ...wa, biz_opaque_callback_data: msg.id };

  // Only Meta's answer decides success or failure: errors after a successful send
  // (DB, webhooks) must never mark a delivered message as failed and refund it.
  let sent: { wamid: string; waId?: string | null } | null = null;
  let sendError: any = null;
  try {
    sent = await provider.send(contact.wa_id ?? contact.phone, wa, o.replyToWamid ?? undefined);
  } catch (err) {
    sendError = err;
  }

  let final: MessageRow;
  if (sent?.wamid) {
    const { rows } = await ctx.db.query<MessageRow>(
      `UPDATE messages SET wamid = $2, status = CASE WHEN status IN ('pending', 'unknown') THEN 'sent' ELSE status END, status_updated_at = now()
       WHERE id = $1 RETURNING *`,
      [msg.id, sent.wamid],
    );
    final = rows[0];
    // Replies come from the WhatsApp id Meta resolved, which can differ from the typed number
    // (Brazil's 9th digit, Argentina's 9): remember it so inbound matching finds this contact.
    // A wa_id equal to the phone adds nothing (inbound also matches by phone), so it neither
    // costs a write nor blocks the id Meta resolves later from replacing it.
    if (sent.waId && sent.waId !== contact.phone && (!contact.wa_id || contact.wa_id === contact.phone)) {
      await ctx.db
        .query(
          `UPDATE contacts SET wa_id = $2 WHERE id = $1 AND (wa_id IS NULL OR wa_id = phone)
             AND NOT EXISTS (SELECT 1 FROM contacts o WHERE o.workspace_id = $3 AND o.wa_id = $2 AND o.id <> $1)`,
          [contact.id, sent.waId, o.workspaceId],
        )
        .catch((err) => ctx.log.warn({ err: (err as Error).message, contactId: contact.id }, 'storing wa_id failed'));
    }
    await dispatchWebhook(ctx, o.workspaceId, 'message.sent', { ...final, contact_phone: contact.phone }).catch((err) =>
      ctx.log.warn({ err: (err as Error).message }, 'message.sent webhook dispatch failed'),
    );
  } else if (provider.kind === 'cloud_api' && !isDefinitiveSendFailure(sendError)) {
    // Network failure, timeout or 5xx after the request went out: Meta may have delivered and
    // billed it. Keep the charge, never retry automatically (that could duplicate it), and let
    // the status webhooks (matched through biz_opaque_callback_data) settle it if it went out.
    ctx.log.warn({ err: sendError?.message, contactId: contact.id, messageId: msg.id }, 'send outcome unknown');
    const error = {
      code: sendError instanceof MetaApiError ? sendError.code : null,
      title: sendError?.message ?? 'Error',
      message: 'No pudimos confirmar si WhatsApp recibió el mensaje (falla de red o de Meta). Revisa en unos minutos antes de reenviarlo: podría llegar duplicado.',
    };
    // Only while still in flight: a status webhook matched through the callback data may already
    // have settled the row (sent, delivered, failed), and that answer must not be overwritten.
    const { rows } = await ctx.db.query<MessageRow>(
      `UPDATE messages SET status = 'unknown', error = $2, status_updated_at = now() WHERE id = $1 AND status = 'pending' RETURNING *`,
      [msg.id, JSON.stringify(error)],
    );
    final = rows[0] ?? (await ctx.db.query<MessageRow>(`SELECT * FROM messages WHERE id = $1`, [msg.id])).rows[0];
  } else {
    const code = sendError instanceof MetaApiError ? sendError.code : null;
    const error = {
      code,
      title: sendError?.message ?? 'Error',
      message: explainMetaError(code, sendError?.message ?? 'No se pudo enviar el mensaje'),
    };
    ctx.log.warn({ err: sendError?.message, code, contactId: contact.id }, 'send failed');
    final = await ctx.db.tx(async (q) => {
      const { rows } = await q.query<MessageRow>(
        `UPDATE messages SET status = 'failed', error = $2, cost = 0, pricing_reconciled = true, status_updated_at = now()
         WHERE id = $1 RETURNING *`,
        [msg.id, JSON.stringify(error)],
      );
      if (cost > 0) {
        await refund(q, o.workspaceId, cost, { messageId: msg.id, broadcastId: o.broadcastId, prepaid, description: 'Reembolso: envío rechazado por Meta' });
      }
      return rows[0];
    });
    if (cost > 0) notifyCredits(ctx, o.workspaceId);
  }
  ctx.realtime.emit(o.workspaceId, 'message:update', final);
  return final;
}

/** Internal note: visible to the team only, never sent to WhatsApp. */
export async function addNote(ctx: AppContext, workspaceId: string, contactId: string, userId: string, text: string): Promise<MessageRow> {
  await getContact(ctx.db, workspaceId, contactId);
  if (!text.trim()) throw badRequest('La nota está vacía');
  const { rows } = await ctx.db.query<MessageRow>(
    `INSERT INTO messages (workspace_id, contact_id, direction, type, body, status, sent_by, user_id)
     VALUES ($1, $2, 'internal', 'note', $3, 'note', 'user', $4) RETURNING *`,
    [workspaceId, contactId, text, userId],
  );
  ctx.realtime.emit(workspaceId, 'message:new', rows[0]);
  return rows[0];
}

export async function getWorkspace(ctx: AppContext, workspaceId: string): Promise<WorkspaceRow> {
  const { rows } = await ctx.db.query<WorkspaceRow>(`SELECT * FROM workspaces WHERE id = $1`, [workspaceId]);
  if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'Espacio de trabajo no encontrado');
  return rows[0];
}
