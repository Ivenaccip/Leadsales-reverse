import type { AppContext } from '../context.js';
import type { Queryable } from '../db/index.js';
import { AppError, badRequest } from '../lib/errors.js';
import { countryFromPhone, deliveryNumber } from '../lib/phone.js';
import type { MessageRow, WorkspaceRow } from '../types.js';
import { getChannel, providerFor } from '../whatsapp/provider.js';
import { explainMetaError, isMetaThrottle, MetaApiError, type TemplateParams, type WaMessage } from '../whatsapp/types.js';
import { getContact } from './contacts.js';
import { charge, getRate, notifyCredits, refund, templatePriceCategory, type PriceCategory } from './credits.js';
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
  /**
   * Runs inside the transaction that stores (and charges) the message, after the channel and contact
   * rows are locked and before anything is inserted or charged. A throw cancels the send (nothing stored,
   * nothing charged) and propagates: throw AppError(409, 'SEND_SKIPPED', …) to skip quietly.
   */
  precondition?: (q: Queryable) => Promise<void>;
  /** Runs inside the transaction that stores (and charges) the message, e.g. to link it to a scheduled row atomically. */
  onCreated?: (q: Queryable, msg: MessageRow) => Promise<void>;
  /**
   * The caller retries by itself a send that never reached Meta or that Meta throttled (broadcasts,
   * scheduled sends): the failed message says so (error.auto_retry) instead of asking the team to
   * resend it, which would duplicate it. A caller that then gives up calls abandonAutoRetry.
   */
  autoRetry?: boolean;
  /**
   * A failed message of an earlier attempt of this same send that never went out (wamid NULL): it is
   * sent again as that row, so the chat keeps one bubble. A new row is stored if it is gone or settled.
   */
  retryOf?: string | null;
}

/** Longest text body WhatsApp accepts: longer texts must be split by the caller. */
export const MAX_TEXT_LENGTH = 4096;

/** A send that failed before reaching Meta (network, DNS, TLS): nothing went out, so trying again is safe. */
export function isNetworkFailure(msg: Pick<MessageRow, 'status' | 'error'>): boolean {
  return msg.status === 'failed' && msg.error?.network === true;
}

/** A failed send whose caller said it would retry it by itself (SendOptions.autoRetry). */
export function isAwaitingRetry(msg: Pick<MessageRow, 'status' | 'error' | 'wamid'>): boolean {
  return msg.status === 'failed' && !msg.wamid && msg.error?.auto_retry === true;
}

const NETWORK_FAILED = 'No se pudo conectar con WhatsApp (falla de red del servidor), así que el mensaje no se envió. Intenta de nuevo en unos minutos.';
const RETRY_NOTE = 'Se reintentará automáticamente: no lo reenvíes a mano o podría llegar duplicado.';

/** What a failed send that will not be retried automatically tells the team. */
export function manualRetryText(error: MessageRow['error']): string {
  return error?.network ? NETWORK_FAILED : explainMetaError(error?.code ?? null, error?.title ?? '');
}

/**
 * Sends a caller said it would retry (autoRetry) that it will not retry after all: the broadcast was
 * cancelled or deleted, the recipient skipped, the scheduled send cancelled or ended for another
 * reason. Their bubbles stop promising a retry and ask the team to resend them if still needed.
 */
export async function abandonAutoRetry(ctx: AppContext, where: { messageId: string } | { broadcastId: string; contactId?: string }): Promise<void> {
  const awaiting = `status = 'failed' AND wamid IS NULL AND error->>'auto_retry' = 'true'`;
  const { rows } =
    'messageId' in where
      ? await ctx.db.query<MessageRow>(`SELECT * FROM messages WHERE id = $1 AND ${awaiting}`, [where.messageId])
      : await ctx.db.query<MessageRow>(`SELECT * FROM messages WHERE broadcast_id = $1 AND ($2::uuid IS NULL OR contact_id = $2) AND ${awaiting}`, [
          where.broadcastId,
          where.contactId ?? null,
        ]);
  for (const m of rows) {
    const error = { ...m.error, auto_retry: undefined, message: manualRetryText(m.error) };
    // Re-checked by the update: a retry may have taken the row back meanwhile.
    const upd = await ctx.db.query<MessageRow>(`UPDATE messages SET error = $2 WHERE id = $1 AND ${awaiting} RETURNING *`, [m.id, JSON.stringify(error)]);
    if (upd.rows[0]) ctx.realtime.emit(m.workspace_id, 'message:update', upd.rows[0]);
  }
}

/** Meta's own explanation of a send error: its message plus error_data.details when that adds something. */
function metaDetail(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const msg = err.message.trim();
  const extra = err instanceof MetaApiError ? (err.details as { details?: unknown } | undefined)?.details : undefined;
  if (typeof extra !== 'string' || !extra.trim() || msg.includes(extra.trim())) return msg || null;
  return msg ? `${msg}: ${extra.trim()}` : extra.trim();
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
 * Sends a WhatsApp message to a contact. Validation problems (window closed, text
 * over MAX_TEXT_LENGTH, no credits, no channel) throw. Meta API failures are stored on the
 * message (status = failed) and the returned row carries the error, so the chat shows it.
 * When Meta's answer is lost (network error, timeout, 5xx) the status is 'unknown':
 * the charge is kept and nothing is resent automatically (settleStaleSends ends it).
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
  // The number this message goes to, and is priced by (Meta bills the market of the number it delivers to).
  const to = deliveryNumber(contact.phone, contact.wa_id);

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
  let category: PriceCategory | null = null;

  switch (c.type) {
    case 'text': {
      if (!c.text.trim()) throw badRequest('El mensaje está vacío');
      if (c.text.length > MAX_TEXT_LENGTH) {
        throw badRequest(
          `El mensaje tiene ${c.text.length} caracteres y WhatsApp acepta como máximo ${MAX_TEXT_LENGTH}. Divídelo en varios mensajes.`,
          'TEXT_TOO_LONG',
        );
      }
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
      category = templatePriceCategory(tpl?.category);
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

  const cost = category ? await getRate(ctx.db, to, category) : 0;
  const humanTakeover = o.sentBy === 'user';
  let reused = false;

  const msg = await ctx.db.tx(async (q) => {
    // The channel row comes first, in the order DELETE /api/channels takes them (the channel, then
    // its contacts and messages through ON DELETE SET NULL): locking the contact first, the message
    // INSERT's foreign-key check on the channel would deadlock with that delete on PostgreSQL.
    const live = await q.query(`SELECT 1 FROM channels WHERE id = $1 FOR KEY SHARE`, [channel.id]);
    if (!live.rows[0]) throw new AppError(400, 'NO_CHANNEL', 'El número de WhatsApp se desconectó mientras se enviaba el mensaje. Revisa Ajustes → Canales.');
    // Sends to one contact are serialized (contact before the wallet), so a precondition
    // sees state that no other send, echo or human takeover can change before this one commits.
    await q.query(`SELECT id FROM contacts WHERE id = $1 FOR NO KEY UPDATE`, [contact.id]);
    if (o.precondition) await o.precondition(q);
    const values = [
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
    ];
    // A retry takes over the row of its failed attempt (nothing of it went out, its charge was
    // refunded): one bubble per message however many attempts it takes. created_at moves to this
    // attempt, so the chat shows it when it really goes out and settleStaleSends counts from it.
    const reuse = o.retryOf
      ? await q.query<MessageRow>(
          `UPDATE messages SET channel_id = $3, type = $4, body = $5, media_file_id = $6, payload = $7, reply_to_wamid = $8, status = 'pending',
             error = NULL, sent_by = $9, user_id = $10, billing_category = $12, cost = $13, charged_prepaid = $14, pricing_reconciled = false,
             created_at = now(), status_updated_at = NULL
           WHERE id = $15 AND workspace_id = $1 AND contact_id = $2 AND direction = 'out' AND status = 'failed' AND wamid IS NULL
             AND broadcast_id IS NOT DISTINCT FROM $11::uuid
           RETURNING *`,
          [...values, o.retryOf],
        )
      : null;
    reused = !!reuse?.rows[0];
    const m =
      reuse?.rows[0] ??
      (
        await q.query<MessageRow>(
          `INSERT INTO messages (workspace_id, contact_id, channel_id, direction, type, body, media_file_id, payload,
             reply_to_wamid, status, sent_by, user_id, broadcast_id, billing_category, cost, charged_prepaid)
           VALUES ($1, $2, $3, 'out', $4, $5, $6, $7, $8, 'pending', $9, $10, $11, $12, $13, $14) RETURNING *`,
          values,
        )
      ).rows[0];
    if (cost > 0) {
      await charge(q, o.workspaceId, cost, {
        messageId: m.id,
        broadcastId: o.broadcastId,
        userId: o.userId,
        prepaid,
        description: `Plantilla ${category} a +${to}`,
      });
    }
    // A human reply hands the chat to the team: the menu bot ends even if it never started (else it
    // would greet the customer's answer with its menu) and the AI agent pauses. 'menú' restarts the bot.
    // A retry leaves the conversation where its failed attempt put it until it actually goes out.
    await q.query(
      `UPDATE contacts SET last_message_at = CASE WHEN $5 THEN last_message_at ELSE now() END,
         last_message_preview = CASE WHEN $5 THEN last_message_preview ELSE $2 END, updated_at = now(),
         unread_count = CASE WHEN $3 THEN 0 ELSE unread_count END,
         bot_state = CASE WHEN $3 THEN jsonb_set(COALESCE(bot_state, '{"path":[]}'::jsonb), '{done}', 'true') ELSE bot_state END,
         ai_paused = CASE WHEN $3 THEN true ELSE ai_paused END,
         channel_id = COALESCE(channel_id, $4)
       WHERE id = $1`,
      [contact.id, previewFor(type, body), humanTakeover, channel.id, reused],
    );
    if (o.onCreated) await o.onCreated(q, m);
    return m;
  });
  ctx.realtime.emit(o.workspaceId, reused ? 'message:update' : 'message:new', msg);
  if (cost > 0) notifyCredits(ctx, o.workspaceId);

  // Meta echoes biz_opaque_callback_data in the status webhooks of every message type: if the answer
  // to a send is lost, its statuses can still be matched to this row and settle it (and its charge).
  wa = { ...wa, biz_opaque_callback_data: msg.id };

  // Only Meta's answer decides success or failure: errors after a successful send
  // (DB, webhooks) must never mark a delivered message as failed and refund it.
  let sent: { wamid: string; waId?: string | null } | null = null;
  let sendError: any = null;
  try {
    sent = await provider.send(to, wa, o.replyToWamid ?? undefined);
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
    if (reused) {
      // Now that the retry went out it is the conversation's latest message, unless a newer one came meanwhile.
      await ctx.db.query(
        `UPDATE contacts SET last_message_preview = CASE WHEN last_message_at IS NULL OR last_message_at <= $2 THEN $3 ELSE last_message_preview END,
           last_message_at = GREATEST(last_message_at, $2), updated_at = now()
         WHERE id = $1`,
        [contact.id, final.created_at, previewFor(type, body)],
      );
    }
    // Replies come from the WhatsApp id Meta resolved, which can differ from the typed number
    // (Brazil's 9th digit, Argentina's 9): remember it so inbound matching finds this contact.
    // A wa_id equal to the phone adds nothing (inbound also matches by phone), so it neither
    // costs a write nor blocks the id Meta resolves later from replacing it. Never one in another
    // country (see deliveryNumber), nor once the contact moved to another number meanwhile.
    if (
      sent.waId &&
      sent.waId !== contact.phone &&
      (!contact.wa_id || contact.wa_id === contact.phone) &&
      countryFromPhone(sent.waId) === countryFromPhone(contact.phone)
    ) {
      await ctx.db
        .query(
          `UPDATE contacts SET wa_id = $2 WHERE id = $1 AND phone = $4 AND (wa_id IS NULL OR wa_id = phone)
             AND NOT EXISTS (SELECT 1 FROM contacts o WHERE o.workspace_id = $3 AND o.wa_id = $2 AND o.id <> $1)`,
          [contact.id, sent.waId, o.workspaceId, contact.phone],
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
    // Nothing reached Meta: callers that send on their own (broadcasts, scheduled) retry these later.
    const network = !(sendError instanceof MetaApiError) && isDefinitiveSendFailure(sendError);
    const cause = (sendError as { cause?: { code?: unknown } } | null)?.cause?.code;
    // When the caller retries it by itself, the bubble says so: a resend by hand would duplicate it.
    const autoRetry = !!o.autoRetry && (network || isMetaThrottle(code));
    const error: NonNullable<MessageRow['error']> = network
      ? {
          code: null,
          network: true,
          title: `${sendError?.message ?? 'Error de red'}${typeof cause === 'string' ? ` (${cause})` : ''}`,
          message: autoRetry
            ? `No se pudo conectar con WhatsApp (falla de red del servidor), así que el mensaje todavía no se envió. ${RETRY_NOTE}`
            : NETWORK_FAILED,
        }
      : {
          code,
          title: sendError?.message ?? 'Error',
          message: autoRetry
            ? `Meta limitó la velocidad de envío de este número, así que el mensaje todavía no se envió. ${RETRY_NOTE}`
            : explainMetaError(code, metaDetail(sendError) ?? 'No se pudo enviar el mensaje'),
        };
    if (autoRetry) error.auto_retry = true;
    ctx.log.warn({ err: sendError?.message, code, contactId: contact.id }, 'send failed');
    final = await ctx.db.tx(async (q) => {
      const { rows } = await q.query<MessageRow>(
        `UPDATE messages SET status = 'failed', error = $2, cost = 0, pricing_reconciled = true, status_updated_at = now()
         WHERE id = $1 RETURNING *`,
        [msg.id, JSON.stringify(error)],
      );
      if (cost > 0) {
        await refund(q, o.workspaceId, cost, {
          messageId: msg.id,
          broadcastId: o.broadcastId,
          prepaid,
          description: network ? 'Reembolso: el envío no llegó a Meta' : 'Reembolso: envío rechazado por Meta',
        });
      }
      return rows[0];
    });
    if (cost > 0) notifyCredits(ctx, o.workspaceId);
  }
  ctx.realtime.emit(o.workspaceId, 'message:update', final);
  return final;
}

const UNSETTLED = `direction = 'out' AND status IN ('unknown', 'pending') AND wamid IS NULL AND created_at < now() - interval '7 days'`;

/**
 * Settles sends whose outcome never became known: 'unknown' (Meta's answer was lost) or 'pending'
 * (the process died mid-send) with no wamid. Meta retries status webhooks for up to 7 days and every
 * send carries its id as callback data, so one still unmatched after that never reached Meta: it is
 * marked failed and its charge refunded. A late status can still claim the row but never charges it
 * again (it is reconciled). Run periodically by the worker; rows are re-checked under a lock.
 */
export async function settleStaleSends(ctx: AppContext): Promise<number> {
  const { rows: stale } = await ctx.db.query<{ id: string }>(`SELECT id FROM messages WHERE ${UNSETTLED} ORDER BY created_at LIMIT 500`);
  let settled = 0;
  for (const { id } of stale) {
    const done = await ctx.db.tx(async (q) => {
      const { rows } = await q.query<MessageRow>(`SELECT * FROM messages WHERE id = $1 AND ${UNSETTLED} FOR UPDATE SKIP LOCKED`, [id]);
      const m = rows[0];
      if (!m) return null;
      const refundable = m.pricing_reconciled ? 0 : Number(m.cost);
      const error = {
        code: null,
        title: 'Sin confirmación de Meta',
        message: 'WhatsApp nunca confirmó este envío, así que se da por no enviado y, si tenía costo, se reembolsó. Reenvíalo si todavía hace falta.',
      };
      const updated = await q.query<MessageRow>(
        `UPDATE messages SET status = 'failed', error = $2, cost = CASE WHEN pricing_reconciled THEN cost ELSE 0 END,
           pricing_reconciled = true, status_updated_at = now()
         WHERE id = $1 RETURNING *`,
        [m.id, JSON.stringify(error)],
      );
      if (refundable > 0) {
        await refund(q, m.workspace_id, refundable, {
          messageId: m.id,
          broadcastId: m.broadcast_id,
          prepaid: !!m.charged_prepaid,
          description: 'Reembolso: WhatsApp nunca confirmó el envío',
        });
      }
      if (m.broadcast_id) {
        await q.query(`UPDATE broadcast_recipients SET status = 'failed', error = $2 WHERE message_id = $1`, [m.id, error.message]);
      }
      return { row: updated.rows[0], refunded: refundable > 0 };
    });
    if (!done) continue;
    settled++;
    ctx.realtime.emit(done.row.workspace_id, 'message:update', done.row);
    if (done.refunded) notifyCredits(ctx, done.row.workspace_id);
  }
  return settled;
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
