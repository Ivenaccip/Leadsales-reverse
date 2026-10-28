import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { encryptJson, hmacSha256Hex, randomToken, safeEqual } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { syncTemplates } from '../services/templates.js';
import type { ChannelRow } from '../types.js';
import { processInboundMessage } from '../whatsapp/inbound.js';
import { channelCredentials, providerFor } from '../whatsapp/provider.js';
import { CloudApiProvider } from '../whatsapp/cloud-api.js';
import { explainMetaError, MetaApiError } from '../whatsapp/types.js';
import { ADMIN_ROLES, noContent, parse, requireWs, uuid } from './helpers.js';

function publicChannel(ctx: AppContext, ch: ChannelRow) {
  const creds = channelCredentials(ctx, ch);
  const { credentials, ...rest } = ch;
  return {
    ...rest,
    has_access_token: !!creds.accessToken,
    has_app_secret: !!creds.appSecret,
    webhook_url: `${ctx.config.publicUrl}/webhooks/whatsapp`,
  };
}

async function getOwnChannel(ctx: AppContext, workspaceId: string, id: string): Promise<ChannelRow> {
  const { rows } = await ctx.db.query<ChannelRow>(`SELECT * FROM channels WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]);
  if (!rows[0]) throw notFound('Canal');
  return rows[0];
}

function metaError(err: unknown): never {
  if (err instanceof MetaApiError) {
    throw badRequest(`Meta respondió: ${explainMetaError(err.code, err.message)}`, 'META_ERROR', { code: err.code, message: err.message });
  }
  throw err;
}

const cloudSchema = z.object({
  provider: z.literal('cloud_api'),
  name: z.string().trim().min(1).default('WhatsApp'),
  phone_number_id: z.string().trim().regex(/^\d{5,25}$/, 'El Phone Number ID son solo dígitos'),
  waba_id: z.string().trim().regex(/^\d{5,25}$/, 'El WABA ID son solo dígitos'),
  access_token: z.string().trim().min(20, 'Pega el token de acceso permanente'),
  app_secret: z.string().trim().min(16, 'Pega la clave secreta de la app (App Secret)'),
  verify_token: z.string().trim().min(8).optional(),
  skip_test: z.boolean().optional(),
});
const sandboxSchema = z.object({ provider: z.literal('sandbox'), name: z.string().trim().min(1).default('Sandbox de pruebas') });

export async function channelRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/channels', async (req) => {
    const a = await requireWs(ctx, req);
    const { rows } = await ctx.db.query<ChannelRow>(`SELECT * FROM channels WHERE workspace_id = $1 ORDER BY created_at`, [a.workspaceId]);
    return { channels: rows.map((c) => publicChannel(ctx, c)) };
  });

  app.post('/api/channels', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const body = parse(z.discriminatedUnion('provider', [cloudSchema, sandboxSchema]), req.body);
    const count = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM channels WHERE workspace_id = $1`, [a.workspaceId]);
    const isDefault = count.rows[0].n === 0;

    if (body.provider === 'sandbox') {
      const { rows } = await ctx.db.query<ChannelRow>(
        `INSERT INTO channels (workspace_id, provider, name, display_phone, phone_number_id, verify_token, is_default)
         VALUES ($1, 'sandbox', $2, '+52 55 0000 0000', $3, $4, $5) RETURNING *`,
        [a.workspaceId, body.name, `sandbox-${crypto.randomUUID()}`, randomToken(12), isDefault],
      );
      await syncTemplates(ctx, rows[0]);
      return { channel: publicChannel(ctx, rows[0]) };
    }

    const taken = await ctx.db.query(`SELECT 1 FROM channels WHERE phone_number_id = $1`, [body.phone_number_id]);
    if (taken.rows[0]) throw conflict('Ese número ya está conectado en esta instancia');

    let displayPhone: string | null = null;
    if (!body.skip_test) {
      const provider = new CloudApiProvider({
        baseUrl: ctx.config.graphBaseUrl,
        version: ctx.config.graphVersion,
        accessToken: body.access_token,
        phoneNumberId: body.phone_number_id,
        wabaId: body.waba_id,
        fetch: ctx.fetch,
      });
      const info = await provider.getPhoneInfo().catch(metaError);
      displayPhone = info.display_phone_number ?? null;
    }
    const { rows } = await ctx.db.query<ChannelRow>(
      `INSERT INTO channels (workspace_id, provider, name, display_phone, phone_number_id, waba_id, credentials, verify_token, is_default)
       VALUES ($1, 'cloud_api', $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        a.workspaceId,
        body.name,
        displayPhone,
        body.phone_number_id,
        body.waba_id,
        encryptJson(ctx.config.encryptionKey, { accessToken: body.access_token, appSecret: body.app_secret }),
        body.verify_token ?? randomToken(12),
        isDefault,
      ],
    );
    const channel = rows[0];
    const warnings: string[] = [];
    if (!body.skip_test) {
      try {
        await providerFor(ctx, channel).subscribeApp();
      } catch (err) {
        warnings.push(`No se pudo suscribir la app a la WABA: ${(err as Error).message}`);
      }
      try {
        await syncTemplates(ctx, channel);
      } catch (err) {
        warnings.push(`No se pudieron sincronizar las plantillas: ${(err as Error).message}`);
      }
    }
    return { channel: publicChannel(ctx, channel), warnings };
  });

  app.patch('/api/channels/:id', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).optional(),
        waba_id: z.string().trim().regex(/^\d{5,25}$/).optional(),
        access_token: z.string().trim().min(20).optional(),
        app_secret: z.string().trim().min(16).optional(),
        verify_token: z.string().trim().min(8).optional(),
        is_default: z.literal(true).optional(),
        status: z.enum(['active', 'disabled']).optional(),
      }),
      req.body,
    );
    const ch = await getOwnChannel(ctx, a.workspaceId, id);
    let credentials = ch.credentials;
    if (body.access_token || body.app_secret) {
      const creds = channelCredentials(ctx, ch);
      credentials = encryptJson(ctx.config.encryptionKey, {
        accessToken: body.access_token ?? creds.accessToken,
        appSecret: body.app_secret ?? creds.appSecret,
      });
    }
    if (body.is_default) await ctx.db.query(`UPDATE channels SET is_default = false WHERE workspace_id = $1`, [a.workspaceId]);
    const { rows } = await ctx.db.query<ChannelRow>(
      `UPDATE channels SET name = COALESCE($2, name), waba_id = COALESCE($3, waba_id), credentials = $4,
         verify_token = COALESCE($5, verify_token), is_default = COALESCE($6, is_default), status = COALESCE($7, status)
       WHERE id = $1 RETURNING *`,
      [id, body.name ?? null, body.waba_id ?? null, credentials, body.verify_token ?? null, body.is_default ?? null, body.status ?? null],
    );
    return { channel: publicChannel(ctx, rows[0]) };
  });

  app.delete('/api/channels/:id', async (req, reply) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    await getOwnChannel(ctx, a.workspaceId, id);
    await ctx.db.query(`DELETE FROM channels WHERE id = $1`, [id]);
    return noContent(reply);
  });

  app.post('/api/channels/:id/test', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const ch = await getOwnChannel(ctx, a.workspaceId, id);
    try {
      const info = await providerFor(ctx, ch).getPhoneInfo();
      await ctx.db.query(`UPDATE channels SET display_phone = COALESCE($2, display_phone), status = 'active', last_error = NULL WHERE id = $1`, [
        id,
        info.display_phone_number ?? null,
      ]);
      return { ok: true, info };
    } catch (err) {
      const msg = err instanceof MetaApiError ? explainMetaError(err.code, err.message) : (err as Error).message;
      await ctx.db.query(`UPDATE channels SET last_error = $2 WHERE id = $1`, [id, msg]);
      return { ok: false, error: msg };
    }
  });

  app.post('/api/channels/:id/subscribe', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const ch = await getOwnChannel(ctx, a.workspaceId, id);
    await providerFor(ctx, ch).subscribeApp().catch(metaError);
    return { ok: true };
  });

  // Sandbox only: pretend a customer wrote to us.
  app.post('/api/channels/:id/simulate', async (req) => {
    const a = await requireWs(ctx, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(
      z.object({
        from: z.string().trim().regex(/^\+?\d{8,15}$/, 'Teléfono inválido (solo dígitos con lada)'),
        name: z.string().trim().max(80).optional(),
        text: z.string().trim().min(1).max(4096).optional(),
        reply_id: z.string().max(64).optional(),
      }),
      req.body,
    );
    const ch = await getOwnChannel(ctx, a.workspaceId, id);
    if (ch.provider !== 'sandbox') throw badRequest('Solo los canales sandbox pueden simular mensajes');
    const from = body.from.replace(/\D/g, '');
    const msg = body.reply_id
      ? { from, id: `wamid.SIM.${crypto.randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: body.reply_id, title: body.text ?? body.reply_id } } }
      : { from, id: `wamid.SIM.${crypto.randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: body.text ?? '' } };
    const message = await processInboundMessage(ctx, ch, msg, { wa_id: from, profile: { name: body.name || 'Cliente de prueba' } });
    return { message };
  });
}

/** Meta's webhook: GET for the verification handshake, POST for events (signed with the app secret). */
export async function metaWebhookRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/webhooks/whatsapp', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const mode = q['hub.mode'];
    const token = q['hub.verify_token'] ?? '';
    const challenge = q['hub.challenge'] ?? '';
    let ok = mode === 'subscribe' && !!token;
    if (ok) {
      const global = ctx.config.metaVerifyToken && safeEqual(token, ctx.config.metaVerifyToken);
      const { rows } = await ctx.db.query(`SELECT 1 FROM channels WHERE verify_token = $1`, [token]);
      ok = !!global || !!rows[0];
    }
    if (!ok) return reply.code(403).send('Verify token inválido');
    return reply.type('text/plain').send(challenge);
  });

  app.post('/webhooks/whatsapp', { config: { rawBody: true } }, async (req, reply) => {
    const raw = (req as any).rawBody as Buffer | undefined;
    const body = req.body as any;
    if (!raw || body?.object !== 'whatsapp_business_account') return reply.code(200).send('IGNORED');

    // Find which channels the payload is about to know which app secret(s) can sign it.
    const phoneIds = new Set<string>();
    const wabaIds = new Set<string>();
    for (const e of body.entry ?? []) {
      if (e.id) wabaIds.add(String(e.id));
      for (const ch of e.changes ?? []) if (ch.value?.metadata?.phone_number_id) phoneIds.add(String(ch.value.metadata.phone_number_id));
    }
    const { rows } = await ctx.db.query<ChannelRow>(
      `SELECT * FROM channels WHERE provider = 'cloud_api' AND (phone_number_id = ANY($1::text[]) OR waba_id = ANY($2::text[]))`,
      [[...phoneIds], [...wabaIds]],
    );
    const secrets = new Set<string>();
    for (const ch of rows) {
      const s = channelCredentials(ctx, ch).appSecret;
      if (s) secrets.add(s);
    }
    if (ctx.config.metaAppSecret) secrets.add(ctx.config.metaAppSecret);
    if (!rows.length && !ctx.config.metaAppSecret) return reply.code(200).send('IGNORED');

    const header = String(req.headers['x-hub-signature-256'] ?? '');
    const valid = [...secrets].some((s) => safeEqual(header, `sha256=${hmacSha256Hex(s, raw)}`));
    if (!valid) {
      ctx.log.warn({ phoneIds: [...phoneIds] }, 'invalid webhook signature');
      return reply.code(401).send('Firma inválida');
    }
    await ctx.queue.enqueue('wa.webhook', { body }, { maxAttempts: 6 });
    return reply.code(200).send('EVENT_RECEIVED');
  });
}
