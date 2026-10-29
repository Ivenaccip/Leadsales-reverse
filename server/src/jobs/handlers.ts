import { rm } from 'node:fs/promises';
import type { AppContext } from '../context.js';
import { hmacSha256Hex } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { assertPublicUrl } from '../lib/net.js';
import { runAiReply } from '../services/ai-agent.js';
import { handleInboundAutomation } from '../services/automation.js';
import { processBroadcast } from '../services/broadcasts.js';
import { mediaTempPath, saveMediaFile } from '../services/media.js';
import { processScheduled } from '../services/scheduled.js';
import { upsertTemplate } from '../services/templates.js';
import type { ChannelRow, MessageRow } from '../types.js';
import { CloudApiProvider } from '../whatsapp/cloud-api.js';
import { processWebhook } from '../whatsapp/inbound.js';
import { providerFor } from '../whatsapp/provider.js';
import { explainMetaError, MetaApiError } from '../whatsapp/types.js';
import type { Job } from './queue.js';
import { PermanentJobError, type GiveUpHandler, type JobHandler } from './worker.js';

/** Why a download gave up, for the agent (who can then ask the customer to send the file again). */
function downloadFailure(err: unknown): string {
  if (err instanceof MetaApiError) return err.code != null ? explainMetaError(err.code, err.message) : err.message;
  if (err instanceof AppError) return err.message;
  return 'WhatsApp no entregó el archivo a tiempo';
}

/** The chat stops waiting for a file that will never arrive and says why. */
async function markDownloadFailed(ctx: AppContext, msg: MessageRow, reason: string) {
  const { rows } = await ctx.db.query<MessageRow>(
    `UPDATE messages SET media = COALESCE(media, '{}'::jsonb) || jsonb_build_object('download_error', $2::text)
     WHERE id = $1 AND media_file_id IS NULL RETURNING *`,
    [msg.id, reason],
  );
  if (rows[0]) ctx.realtime.emit(msg.workspace_id, 'message:update', rows[0]);
}

async function downloadMedia(ctx: AppContext, p: { messageId: string }, job: Job) {
  const { rows } = await ctx.db.query<MessageRow>(`SELECT * FROM messages WHERE id = $1`, [p.messageId]);
  const msg = rows[0];
  if (!msg || msg.media_file_id || !msg.media?.wa_media_id) return;
  const ch = msg.channel_id ? (await ctx.db.query<ChannelRow>(`SELECT * FROM channels WHERE id = $1`, [msg.channel_id])).rows[0] : undefined;
  if (ch?.provider !== 'cloud_api') {
    await markDownloadFailed(ctx, msg, ch ? 'El canal de prueba no descarga archivos de WhatsApp' : 'El número de WhatsApp que recibió este mensaje ya no está conectado');
    return;
  }
  let temp: string | null = null;
  try {
    const provider = providerFor(ctx, ch);
    if (!(provider instanceof CloudApiProvider)) throw new PermanentJobError('Proveedor sin descarga de archivos');
    // Streamed to disk: a 100 MB document never sits in memory.
    temp = await mediaTempPath(ctx);
    const { mime } = await provider.downloadMediaToFile(String(msg.media.wa_media_id), temp);
    const file = await saveMediaFile(ctx, msg.workspace_id, temp, mime || String(msg.media.mime ?? 'application/octet-stream'), (msg.media.filename as string) ?? null);
    const upd = await ctx.db.query<MessageRow>(`UPDATE messages SET media_file_id = $2, media = media - 'download_error' WHERE id = $1 RETURNING *`, [
      msg.id,
      file.id,
    ]);
    ctx.realtime.emit(msg.workspace_id, 'message:update', upd.rows[0]);
  } catch (err) {
    if (temp) await rm(temp, { force: true }).catch(() => {});
    // The worker retries for hours; only its last attempt (or an error that never heals) gives up.
    if ((err as any)?.retry === false || job.attempts >= job.max_attempts) await markDownloadFailed(ctx, msg, downloadFailure(err));
    throw err;
  }
}

/**
 * The webhooks about a template carry no components: read the template from Meta again. Its
 * status stays the one the webhooks set (Meta's list may lag behind its own events).
 */
async function refreshTemplate(ctx: AppContext, p: { templateId: string }) {
  const { rows } = await ctx.db.query<{ id: string; workspace_id: string; channel_id: string; meta_id: string | null; name: string; language: string }>(
    `SELECT id, workspace_id, channel_id, meta_id, name, language FROM templates WHERE id = $1`,
    [p.templateId],
  );
  const t = rows[0];
  if (!t) return;
  const ch = (await ctx.db.query<ChannelRow>(`SELECT * FROM channels WHERE id = $1`, [t.channel_id])).rows[0];
  if (!ch || ch.provider !== 'cloud_api') return;
  const remote = (await providerFor(ctx, ch).listTemplates()).find(
    (r) => (t.meta_id && String(r.id) === t.meta_id) || (r.name === t.name && r.language === t.language),
  );
  if (!remote || remote.name !== t.name || remote.language !== t.language) return;
  const updated = await ctx.db.tx(async (q) => {
    const cur = await q.query<{ status: string; rejected_reason: string | null }>(`SELECT status, rejected_reason FROM templates WHERE id = $1 FOR UPDATE`, [t.id]);
    if (!cur.rows[0]) return false;
    await upsertTemplate(q, ch, { ...remote, meta_id: String(remote.id), status: cur.rows[0].status, rejected_reason: cur.rows[0].rejected_reason });
    return true;
  });
  if (updated) ctx.realtime.emit(t.workspace_id, 'template:update', { id: t.id });
}

async function deliverWebhook(ctx: AppContext, p: { endpointId: string; event: string; data: unknown; sentAt: string }) {
  const { rows } = await ctx.db.query<{ id: string; workspace_id: string; url: string; secret: string; is_active: boolean }>(
    `SELECT id, workspace_id, url, secret, is_active FROM webhook_endpoints WHERE id = $1`,
    [p.endpointId],
  );
  const ep = rows[0];
  if (!ep?.is_active) return;
  const body = JSON.stringify({ event: p.event, workspace_id: ep.workspace_id, sent_at: p.sentAt, data: p.data });
  let status = 0;
  let error: string | null = null;
  let privateNetwork = false;
  try {
    await assertPublicUrl(ep.url, ctx.config.allowPrivateWebhooks);
    const res = await ctx.webhookFetch(ep.url, {
      redirect: 'manual',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'LeadLibre-Webhooks/1.0',
        'X-LeadLibre-Event': p.event,
        'X-LeadLibre-Signature': `sha256=${hmacSha256Hex(ep.secret, body)}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
    if (res.status >= 300 && res.status < 400) error = `HTTP ${res.status}: las redirecciones no se siguen; usa la URL final`;
    else if (!res.ok) error = `HTTP ${res.status}`;
  } catch (err: any) {
    // fetch reports every connection failure as "fetch failed": the reason is its cause (refused,
    // DNS, TLS, or a hostname that resolves to a private address, refused at connect time).
    const cause = err?.cause;
    error = String(cause?.message || cause?.code || err?.message || err);
    privateNetwork = cause?.code === 'EPRIVATE' || err?.code === 'EPRIVATE' || /red privada/.test(error);
  }
  await ctx.db.query(`UPDATE webhook_endpoints SET last_status = $2, last_error = $3 WHERE id = $1`, [ep.id, status || null, error]);
  if (error) {
    // A private destination stays private: retrying for a day and a half would only resolve it again.
    if ((status >= 300 && status < 500 && status !== 429) || privateNetwork) throw new PermanentJobError(error);
    throw new Error(error);
  }
}

export const jobHandlers: Record<string, JobHandler> = {
  'wa.webhook': (ctx, p, job) =>
    processWebhook(
      ctx,
      p.body,
      job,
      Array.isArray(p.channelIds) ? p.channelIds : null,
      Array.isArray(p.trustedChannelIds) ? p.trustedChannelIds : undefined,
    ),
  'media.download': (ctx, p, job) => downloadMedia(ctx, p, job),
  'template.refresh': (ctx, p) => refreshTemplate(ctx, p),
  'automation.inbound': (ctx, p) => handleInboundAutomation(ctx, p),
  'ai.reply': (ctx, p) => runAiReply(ctx, p),
  'broadcast.process': (ctx, p) => processBroadcast(ctx, p),
  'scheduled.send': (ctx, p, job) => processScheduled(ctx, p, job),
  'webhook.deliver': (ctx, p) => deliverWebhook(ctx, p),
};

/** Jobs failed for good without their handler running: a crash cut off their last attempt. */
export const jobGiveUpHandlers: Record<string, GiveUpHandler> = {
  // downloadMedia marks its last failed attempt itself; a crash mid-download leaves the chat waiting.
  'media.download': async (ctx, p) => {
    const { rows } = await ctx.db.query<MessageRow>(`SELECT * FROM messages WHERE id = $1`, [p?.messageId ?? null]);
    // A last attempt that failed by itself already stored why (only its job's final write was lost).
    if (rows[0] && !rows[0].media?.download_error) {
      await markDownloadFailed(ctx, rows[0], 'La descarga se interrumpió varias veces porque el servidor se reinició');
    }
  },
};
