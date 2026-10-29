import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { encryptJson, hmacSha256Hex, randomToken, safeEqual } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { normalizePhone } from '../lib/phone.js';
import { syncTemplates } from '../services/templates.js';
import type { ChannelRow } from '../types.js';
import { processInboundMessage } from '../whatsapp/inbound.js';
import { channelCredentials, providerFor } from '../whatsapp/provider.js';
import { CloudApiProvider } from '../whatsapp/cloud-api.js';
import { explainMetaError, MetaApiError } from '../whatsapp/types.js';
import { ADMIN_ROLES, noContent, parse, requireWs, uuid, type WsAuth } from './helpers.js';

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

/**
 * Proves the token controls this phone number AND that the number belongs to the WABA,
 * so nobody can register (squat) someone else's number id or WABA id.
 */
async function verifyOwnership(ctx: AppContext, accessToken: string, phoneNumberId: string, wabaId: string) {
  const provider = new CloudApiProvider({
    baseUrl: ctx.config.graphBaseUrl,
    version: ctx.config.graphVersion,
    accessToken,
    phoneNumberId,
    wabaId,
    fetch: ctx.fetch,
  });
  const info = await provider.getPhoneInfo().catch(metaError);
  const ids = await provider.listPhoneNumberIds().catch(metaError);
  if (!ids.includes(phoneNumberId)) {
    throw badRequest('Ese Phone Number ID no pertenece a la cuenta de WhatsApp (WABA) indicada', 'PHONE_NOT_IN_WABA');
  }
  return info;
}

async function billingModeOf(ctx: AppContext, workspaceId: string): Promise<string | undefined> {
  const { rows } = await ctx.db.query<{ billing_mode: string }>(`SELECT billing_mode FROM workspaces WHERE id = $1`, [workspaceId]);
  return rows[0]?.billing_mode;
}

/**
 * In prepaid workspaces the instance operator pays Meta, so only the operator may
 * connect or change the official numbers (whoever holds the app secret can sign webhooks).
 */
async function assertCanManageCloudChannels(ctx: AppContext, a: WsAuth) {
  if (a.user.is_superadmin) return;
  if ((await billingModeOf(ctx, a.workspaceId)) === 'prepaid') {
    throw forbidden('En modo de créditos prepagados, el administrador de la instancia conecta y edita los números oficiales');
  }
}

/**
 * A number counts as operator-verified only with an app secret the business cannot know. A secret
 * that is already on a number of this workspace the operator never verified (typed by the business,
 * or typed while the business paid Meta and likely came from its own app) proves nothing.
 */
async function assertSecretUnknownToBusiness(ctx: AppContext, workspaceId: string, secret: string) {
  const { rows } = await ctx.db.query<ChannelRow>(
    `SELECT * FROM channels WHERE workspace_id = $1 AND provider = 'cloud_api' AND NOT operator_verified`,
    [workspaceId],
  );
  if (rows.some((c) => channelCredentials(ctx, c).appSecret === secret)) {
    throw badRequest(
      'Esa clave secreta (App Secret) ya estaba en un número de este negocio y el negocio puede conocerla. Usa el token y la App Secret de tu propia app de Meta.',
      'APP_SECRET_NOT_NEW',
    );
  }
}

/** One WABA belongs to one workspace: templates live per WABA at Meta, so sharing it leaks them. */
async function assertWabaFree(ctx: AppContext, workspaceId: string, wabaId: string) {
  const { rows } = await ctx.db.query(`SELECT 1 FROM channels WHERE waba_id = $1 AND workspace_id <> $2 LIMIT 1`, [wabaId, workspaceId]);
  if (rows[0]) throw conflict('Esa cuenta de WhatsApp (WABA) ya está conectada en otro espacio de trabajo', 'WABA_TAKEN');
}

const PREPAID_UNVERIFIED =
  'Desactivado en modo de créditos prepagados: el negocio puede conocer la clave secreta (App Secret) de este número. Para activarlo, el administrador de la instancia debe capturar el token y la App Secret de su propia app de Meta.';

/**
 * Switching a workspace to prepaid: numbers the operator did not verify stop working (the tenant
 * connected them, or the operator typed them while the tenant paid Meta, usually with the tenant's
 * own app), because the tenant may know their app secret and sign fake status webhooks (refunds).
 */
export async function disableUnverifiedCloudChannels(ctx: AppContext, workspaceId: string) {
  await ctx.db.query(
    `UPDATE channels SET status = 'disabled', last_error = $2
     WHERE workspace_id = $1 AND provider = 'cloud_api' AND NOT operator_verified AND status <> 'disabled'`,
    [workspaceId, PREPAID_UNVERIFIED],
  );
}

/**
 * The simulator writes messages as if the customer sent them and moves the contact onto the
 * sandbox (where replies are never delivered): only new numbers or contacts already living
 * on this sandbox channel may be used, never a real customer.
 */
async function assertSimulatable(ctx: AppContext, ch: ChannelRow, from: string) {
  const { rows } = await ctx.db.query(
    `SELECT 1 FROM contacts c
     WHERE c.workspace_id = $1 AND (c.wa_id = $2 OR c.phone = $3)
       AND (c.channel_id IS DISTINCT FROM $4
         OR EXISTS (SELECT 1 FROM messages m JOIN channels mc ON mc.id = m.channel_id WHERE m.contact_id = c.id AND mc.provider <> 'sandbox'))
     LIMIT 1`,
    [ch.workspace_id, from, normalizePhone(`+${from}`), ch.id],
  );
  if (rows[0]) throw conflict('Ese número es de un contacto real de tu espacio: usa otro número para simular', 'REAL_CONTACT');
}

const cloudSchema = z.object({
  provider: z.literal('cloud_api'),
  name: z.string().trim().min(1).default('WhatsApp'),
  phone_number_id: z.string().trim().regex(/^\d{5,25}$/, 'El Phone Number ID son solo dígitos'),
  waba_id: z.string().trim().regex(/^\d{5,25}$/, 'El WABA ID son solo dígitos'),
  access_token: z.string().trim().min(20, 'Pega el token de acceso permanente'),
  app_secret: z.string().trim().min(16, 'Pega la clave secreta de la app (App Secret)'),
  verify_token: z.string().trim().min(8).optional(),
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

    await assertCanManageCloudChannels(ctx, a);
    const taken = await ctx.db.query(`SELECT 1 FROM channels WHERE phone_number_id = $1`, [body.phone_number_id]);
    if (taken.rows[0]) throw conflict('Ese número ya está conectado en esta instancia');
    // Only the operator connects numbers in prepaid workspaces; elsewhere the business pays Meta and
    // the credentials are probably its own, even when the operator typed them.
    const verified = (await billingModeOf(ctx, a.workspaceId)) === 'prepaid';
    if (verified) await assertSecretUnknownToBusiness(ctx, a.workspaceId, body.app_secret);

    const info = await verifyOwnership(ctx, body.access_token, body.phone_number_id, body.waba_id);
    await assertWabaFree(ctx, a.workspaceId, body.waba_id);
    const { rows } = await ctx.db.query<ChannelRow>(
      `INSERT INTO channels (workspace_id, provider, name, display_phone, phone_number_id, waba_id, credentials, verify_token, is_default, operator_verified)
       VALUES ($1, 'cloud_api', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        a.workspaceId,
        body.name,
        info.display_phone_number ?? null,
        body.phone_number_id,
        body.waba_id,
        encryptJson(ctx.config.encryptionKey, { accessToken: body.access_token, appSecret: body.app_secret }),
        body.verify_token ?? randomToken(12),
        isDefault,
        verified,
      ],
    );
    const channel = rows[0];
    const warnings: string[] = [];
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
    const prepaid = ch.provider === 'cloud_api' && (await billingModeOf(ctx, a.workspaceId)) === 'prepaid';
    let credentials = ch.credentials;
    let verified = !!ch.operator_verified;
    let status = body.status ?? null;
    let lastError: string | null = ch.last_error;
    if (ch.provider === 'cloud_api' && (body.access_token || body.app_secret || body.waba_id || body.status)) {
      await assertCanManageCloudChannels(ctx, a);
    }
    if (body.access_token || body.app_secret || body.waba_id) {
      const creds = channelCredentials(ctx, ch);
      const accessToken = body.access_token ?? creds.accessToken;
      // Verifying a number for prepaid billing moves it to the operator's own Meta app: a secret the
      // business may know is refused, and the token proves the operator's app controls the number.
      if (prepaid && a.user.is_superadmin && body.app_secret && !(ch.operator_verified && body.app_secret === creds.appSecret)) {
        await assertSecretUnknownToBusiness(ctx, a.workspaceId, body.app_secret);
        if (!ch.operator_verified && !body.access_token) {
          throw badRequest(
            'Para verificar este número en modo prepagado, captura también el token de acceso de tu propia app de Meta',
            'OPERATOR_VERIFICATION_REQUIRED',
          );
        }
      }
      if (ch.provider === 'cloud_api' && (body.access_token || body.waba_id)) {
        await verifyOwnership(ctx, accessToken ?? '', ch.phone_number_id, body.waba_id ?? ch.waba_id ?? '');
      }
      if (ch.provider === 'cloud_api' && body.waba_id && body.waba_id !== ch.waba_id) await assertWabaFree(ctx, a.workspaceId, body.waba_id);
      credentials = encryptJson(ctx.config.encryptionKey, {
        accessToken,
        appSecret: body.app_secret ?? creds.appSecret,
      });
      // Verified = the operator typed the app secret while the workspace was prepaid (checked above);
      // credentials the tenant changes never are.
      if (!a.user.is_superadmin) verified = false;
      else if (body.app_secret) verified = prepaid;
    }
    if (prepaid) {
      if (body.status === 'active' && !verified) {
        throw badRequest(
          'En modo prepagado, captura el token y la clave secreta (App Secret) de tu propia app de Meta para verificar este número antes de activarlo',
          'OPERATOR_VERIFICATION_REQUIRED',
        );
      }
      // Re-keyed by the operator after the switch to prepaid: it may work again.
      if (verified && !ch.operator_verified && !body.status && ch.status === 'disabled' && ch.last_error === PREPAID_UNVERIFIED) status = 'active';
    }
    if (status === 'active' && ch.last_error === PREPAID_UNVERIFIED) lastError = null;
    if (body.is_default) await ctx.db.query(`UPDATE channels SET is_default = false WHERE workspace_id = $1`, [a.workspaceId]);
    const { rows } = await ctx.db.query<ChannelRow>(
      `UPDATE channels SET name = COALESCE($2, name), waba_id = COALESCE($3, waba_id), credentials = $4,
         verify_token = COALESCE($5, verify_token), is_default = COALESCE($6, is_default), status = COALESCE($7, status),
         operator_verified = $8, last_error = $9
       WHERE id = $1 RETURNING *`,
      [id, body.name ?? null, body.waba_id ?? null, credentials, body.verify_token ?? null, body.is_default ?? null, status, verified, lastError],
    );
    const warnings: string[] = [];
    // New credentials may belong to another Meta app (in prepaid, the operator's): that app must be
    // the one subscribed to the WABA, or Meta keeps sending webhooks signed by the old one.
    if (ch.provider === 'cloud_api' && (body.access_token || body.app_secret || body.waba_id) && (!prepaid || verified)) {
      await providerFor(ctx, rows[0])
        .subscribeApp()
        .catch((err) => warnings.push(`No se pudo suscribir la app a la WABA: ${(err as Error).message}`));
    }
    return { channel: publicChannel(ctx, rows[0]), warnings };
  });

  app.delete('/api/channels/:id', async (req, reply) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const ch = await getOwnChannel(ctx, a.workspaceId, id);
    if (ch.provider === 'cloud_api') await assertCanManageCloudChannels(ctx, a);
    await ctx.db.query(`DELETE FROM channels WHERE id = $1`, [id]);
    return noContent(reply);
  });

  app.post('/api/channels/:id/test', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const ch = await getOwnChannel(ctx, a.workspaceId, id);
    try {
      const info = await providerFor(ctx, ch).getPhoneInfo();
      // A test only reports: re-enabling a number is a PATCH (operator-only in prepaid workspaces).
      await ctx.db.query(
        `UPDATE channels SET display_phone = COALESCE($2, display_phone), last_error = CASE WHEN status = 'disabled' THEN last_error END WHERE id = $1`,
        [id, info.display_phone_number ?? null],
      );
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
    if (ch.provider === 'cloud_api') await assertCanManageCloudChannels(ctx, a);
    await providerFor(ctx, ch).subscribeApp().catch(metaError);
    return { ok: true };
  });

  // Sandbox only: pretend a customer wrote to us (admins only: it writes as if the customer did).
  app.post('/api/channels/:id/simulate', async (req) => {
    const a = await requireWs(ctx, req, ADMIN_ROLES);
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
    // Meta always sends full international wa_ids: a national number typed here gets the
    // workspace's country code, like contacts created by hand.
    const ws = await ctx.db.query<{ default_country_code: string }>(`SELECT default_country_code FROM workspaces WHERE id = $1`, [a.workspaceId]);
    const digits = body.from.replace(/\D/g, '');
    const from = digits.length === 10 && !body.from.startsWith('+') ? (ws.rows[0]?.default_country_code ?? '52') + digits : digits;
    await assertSimulatable(ctx, ch, from);
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
    const { rows } = await ctx.db.query<ChannelRow & { tenant_secret_ok: boolean }>(
      `SELECT ch.*, (w.billing_mode <> 'prepaid' OR ch.operator_verified) AS tenant_secret_ok
       FROM channels ch JOIN workspaces w ON w.id = ch.workspace_id
       WHERE ch.provider = 'cloud_api' AND (ch.phone_number_id = ANY($1::text[]) OR ch.waba_id = ANY($2::text[]))`,
      [[...phoneIds], [...wabaIds]],
    );
    if (!rows.length && !ctx.config.metaAppSecret) return reply.code(200).send('IGNORED');

    // Which secret signed the payload decides which channels it may touch: a tenant that
    // knows its own app secret must never be able to inject events into another tenant.
    const header = String(req.headers['x-hub-signature-256'] ?? '');
    const signedWith = (secret: string) => safeEqual(header, `sha256=${hmacSha256Hex(secret, raw)}`);
    let allowed: string[];
    if (ctx.config.metaAppSecret && signedWith(ctx.config.metaAppSecret)) {
      allowed = rows.map((ch) => ch.id);
    } else {
      const bySecret = new Map<string, string[]>();
      // In prepaid workspaces a secret the tenant typed cannot vouch for billing events.
      for (const ch of rows.filter((c) => c.tenant_secret_ok)) {
        const secret = channelCredentials(ctx, ch).appSecret;
        if (secret) bySecret.set(secret, [...(bySecret.get(secret) ?? []), ch.id]);
      }
      const match = [...bySecret.entries()].find(([secret]) => signedWith(secret));
      if (!match) {
        // Signed with the secret of a prepaid number the operator never verified (e.g. one connected
        // before verification existed): stop the number visibly instead of losing its events silently.
        const distrusted = rows.filter((c) => !c.tenant_secret_ok && c.status !== 'disabled').filter((c) => {
          const secret = channelCredentials(ctx, c).appSecret;
          return !!secret && signedWith(secret);
        });
        if (distrusted.length) {
          await ctx.db.query(
            `UPDATE channels ch SET status = 'disabled', last_error = $2 FROM workspaces w
             WHERE w.id = ch.workspace_id AND ch.id = ANY($1::uuid[]) AND w.billing_mode = 'prepaid' AND NOT ch.operator_verified AND ch.status <> 'disabled'`,
            [distrusted.map((c) => c.id), PREPAID_UNVERIFIED],
          );
          ctx.log.warn({ channelIds: distrusted.map((c) => c.id) }, 'webhook signed with an unverified secret in a prepaid workspace: number disabled');
        } else {
          ctx.log.warn({ phoneIds: [...phoneIds] }, 'invalid webhook signature');
        }
        return reply.code(401).send('Firma inválida');
      }
      allowed = match[1];
    }
    await ctx.queue.enqueue('wa.webhook', { body, channelIds: allowed }, { maxAttempts: 6 });
    return reply.code(200).send('EVENT_RECEIVED');
  });
}
