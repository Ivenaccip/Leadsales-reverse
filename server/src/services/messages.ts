import type { AppContext } from '../context.js';
import { AppError, badRequest } from '../lib/errors.js';
import type { MessageRow, WorkspaceRow } from '../types.js';
import { getChannel, providerFor } from '../whatsapp/provider.js';
import { explainMetaError, MetaApiError, type TemplateParams, type WaMessage } from '../whatsapp/types.js';
import { getContact } from './contacts.js';
import { charge, getRate, normalizeCategory, refund } from './credits.js';
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
 */
export async function sendMessage(ctx: AppContext, o: SendOptions): Promise<MessageRow> {
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
      mediaFileId = file.id;
      const id = await ensureUploaded(ctx, file, channel, provider);
      const obj: Record<string, unknown> = { id };
      if (body && type !== 'audio' && type !== 'sticker') obj.caption = body;
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
         reply_to_wamid, status, sent_by, user_id, broadcast_id, billing_category, cost)
       VALUES ($1, $2, $3, 'out', $4, $5, $6, $7, $8, 'pending', $9, $10, $11, $12, $13) RETURNING *`,
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
      ],
    );
    const m = rows[0];
    if (cost > 0) {
      await charge(q, o.workspaceId, cost, {
        messageId: m.id,
        broadcastId: o.broadcastId,
        userId: o.userId,
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
    return m;
  });
  ctx.realtime.emit(o.workspaceId, 'message:new', msg);

  let final: MessageRow;
  try {
    const { wamid } = await provider.send(contact.wa_id ?? contact.phone, wa, o.replyToWamid ?? undefined);
    const { rows } = await ctx.db.query<MessageRow>(
      `UPDATE messages SET wamid = $2, status = CASE WHEN status = 'pending' THEN 'sent' ELSE status END, status_updated_at = now()
       WHERE id = $1 RETURNING *`,
      [msg.id, wamid],
    );
    final = rows[0];
    await dispatchWebhook(ctx, o.workspaceId, 'message.sent', { ...final, contact_phone: contact.phone });
  } catch (err: any) {
    const code = err instanceof MetaApiError ? err.code : null;
    const error = {
      code,
      title: err?.message ?? 'Error',
      message: explainMetaError(code, err?.message ?? 'No se pudo enviar el mensaje'),
    };
    ctx.log.warn({ err: err?.message, code, contactId: contact.id }, 'send failed');
    final = await ctx.db.tx(async (q) => {
      const { rows } = await q.query<MessageRow>(
        `UPDATE messages SET status = 'failed', error = $2, cost = 0, pricing_reconciled = true, status_updated_at = now()
         WHERE id = $1 RETURNING *`,
        [msg.id, JSON.stringify(error)],
      );
      if (cost > 0) await refund(q, o.workspaceId, cost, { messageId: msg.id, broadcastId: o.broadcastId, description: 'Reembolso: envío rechazado por Meta' });
      return rows[0];
    });
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
