import type { AppContext } from '../context.js';
import type { Queryable } from '../db/index.js';
import { decryptJson } from '../lib/crypto.js';
import { AppError, badRequest } from '../lib/errors.js';
import type { ChannelRow } from '../types.js';
import { CloudApiProvider } from './cloud-api.js';
import { SandboxProvider } from './sandbox.js';
import type { ChannelCredentials, WaMessage, WhatsAppProvider } from './types.js';

export function channelCredentials(ctx: AppContext, channel: ChannelRow): ChannelCredentials {
  return decryptJson<ChannelCredentials>(ctx.config.encryptionKey, channel.credentials) ?? {};
}

export function providerFor(ctx: AppContext, channel: ChannelRow): WhatsAppProvider {
  if (channel.provider === 'sandbox') {
    return new SandboxProvider(channel.phone_number_id, {
      onSent: (wamid, to, message) => simulateStatuses(ctx, channel, wamid, to, message),
    });
  }
  const creds = channelCredentials(ctx, channel);
  if (!creds.accessToken) throw badRequest('El canal no tiene token de acceso configurado', 'CHANNEL_NOT_CONFIGURED');
  return new CloudApiProvider({
    baseUrl: ctx.config.graphBaseUrl,
    version: ctx.config.graphVersion,
    accessToken: creds.accessToken,
    phoneNumberId: channel.phone_number_id,
    wabaId: channel.waba_id,
    fetch: ctx.fetch,
  });
}

export async function getChannel(q: Queryable, workspaceId: string, channelId?: string | null): Promise<ChannelRow> {
  const { rows } = await q.query<ChannelRow>(
    `SELECT * FROM channels WHERE workspace_id = $1 AND ($2::uuid IS NULL OR id = $2::uuid) AND status <> 'disabled'
     ORDER BY is_default DESC, created_at ASC LIMIT 1`,
    [workspaceId, channelId ?? null],
  );
  if (!rows[0]) {
    throw new AppError(400, 'NO_CHANNEL', 'Conecta un número de WhatsApp (Ajustes → Canales) antes de enviar mensajes');
  }
  return rows[0];
}

/** Wraps a "messages" change value the way Meta delivers it to our webhook. */
export function webhookEnvelope(channel: Pick<ChannelRow, 'waba_id' | 'phone_number_id' | 'display_phone'>, value: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: channel.waba_id ?? 'sandbox-waba',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: channel.display_phone ?? '', phone_number_id: channel.phone_number_id },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

/** Sandbox: emulate the sent → delivered → read webhooks Meta would send, pricing included. */
async function simulateStatuses(ctx: AppContext, channel: ChannelRow, wamid: string, to: string, message: WaMessage) {
  const base = ctx.config.sandboxStatusDelayMs;
  const ts = () => String(Math.floor(Date.now() / 1000));
  if (to.endsWith('0000')) {
    const status = {
      id: wamid,
      status: 'failed',
      timestamp: ts(),
      recipient_id: to,
      errors: [{ code: 131026, title: 'Message undeliverable', message: 'Message undeliverable' }],
    };
    await ctx.queue.enqueue('wa.webhook', { body: webhookEnvelope(channel, { statuses: [status] }) }, { delayMs: base });
    return;
  }
  let pricing: Record<string, unknown> = { billable: false, pricing_model: 'PMP', category: 'service', type: 'free_customer_service' };
  if (message.type === 'template') {
    const tpl = message.template as { name: string; language: { code: string } };
    const { rows } = await ctx.db.query<{ category: string }>(
      `SELECT category FROM templates WHERE channel_id = $1 AND name = $2 AND language = $3`,
      [channel.id, tpl.name, tpl.language.code],
    );
    pricing = { billable: true, pricing_model: 'PMP', category: (rows[0]?.category ?? 'marketing').toLowerCase(), type: 'regular' };
  }
  const steps: [string, number][] = [
    ['sent', 1],
    ['delivered', 2],
    ['read', 5],
  ];
  for (const [status, mult] of steps) {
    const st = { id: wamid, status, timestamp: ts(), recipient_id: to, pricing };
    await ctx.queue.enqueue('wa.webhook', { body: webhookEnvelope(channel, { statuses: [st] }) }, { delayMs: base * mult });
  }
}
