import type { AppContext } from '../context.js';
import { hmacSha256Hex } from '../lib/crypto.js';
import { assertPublicUrl } from '../lib/net.js';
import { runAiReply } from '../services/ai-agent.js';
import { handleInboundAutomation } from '../services/automation.js';
import { processBroadcast } from '../services/broadcasts.js';
import { saveMedia } from '../services/media.js';
import { processScheduled } from '../services/scheduled.js';
import type { ChannelRow, MessageRow } from '../types.js';
import { processWebhook } from '../whatsapp/inbound.js';
import { providerFor } from '../whatsapp/provider.js';
import { PermanentJobError, type JobHandler } from './worker.js';

async function downloadMedia(ctx: AppContext, p: { messageId: string }) {
  const { rows } = await ctx.db.query<MessageRow>(`SELECT * FROM messages WHERE id = $1`, [p.messageId]);
  const msg = rows[0];
  if (!msg || msg.media_file_id || !msg.media?.wa_media_id || !msg.channel_id) return;
  const ch = await ctx.db.query<ChannelRow>(`SELECT * FROM channels WHERE id = $1`, [msg.channel_id]);
  if (!ch.rows[0] || ch.rows[0].provider === 'sandbox') return;
  const { data, mime } = await providerFor(ctx, ch.rows[0]).downloadMedia(String(msg.media.wa_media_id));
  const file = await saveMedia(ctx, msg.workspace_id, data, mime || String(msg.media.mime ?? 'application/octet-stream'), (msg.media.filename as string) ?? null);
  const upd = await ctx.db.query<MessageRow>(`UPDATE messages SET media_file_id = $2 WHERE id = $1 RETURNING *`, [msg.id, file.id]);
  ctx.realtime.emit(msg.workspace_id, 'message:update', upd.rows[0]);
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
    error = String(err?.message ?? err);
  }
  await ctx.db.query(`UPDATE webhook_endpoints SET last_status = $2, last_error = $3 WHERE id = $1`, [ep.id, status || null, error]);
  if (error) {
    if ((status >= 300 && status < 500 && status !== 429) || /red privada/.test(error)) throw new PermanentJobError(error);
    throw new Error(error);
  }
}

export const jobHandlers: Record<string, JobHandler> = {
  'wa.webhook': (ctx, p, job) => processWebhook(ctx, p.body, job, Array.isArray(p.channelIds) ? p.channelIds : null),
  'media.download': (ctx, p) => downloadMedia(ctx, p),
  'automation.inbound': (ctx, p) => handleInboundAutomation(ctx, p),
  'ai.reply': (ctx, p) => runAiReply(ctx, p),
  'broadcast.process': (ctx, p) => processBroadcast(ctx, p),
  'scheduled.send': (ctx, p, job) => processScheduled(ctx, p, job),
  'webhook.deliver': (ctx, p) => deliverWebhook(ctx, p),
};
