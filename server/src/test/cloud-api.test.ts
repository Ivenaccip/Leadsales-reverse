import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hmacSha256Hex } from '../lib/crypto.js';
import { fakeFetch, setup, type TestEnv } from './helpers.js';

const PHONE_ID = '1098765432101';
const WABA_ID = '2223334445556';
const APP_SECRET = 'app-secret-0123456789abcdef';
const TOKEN = 'EAAG-fake-permanent-token-xxxxxxxxxxxx';

const meta = fakeFetch([
  (c) => (c.url.includes(`/${PHONE_ID}?fields=`) ? { json: { id: PHONE_ID, display_phone_number: '+52 55 1234 0000', verified_name: 'Tacos' } } : undefined),
  (c) => (c.url.endsWith(`/${WABA_ID}/subscribed_apps`) ? { json: { success: true } } : undefined),
  (c) =>
    c.url.includes(`/${WABA_ID}/message_templates?limit`)
      ? {
          json: {
            data: [
              { id: 't1', name: 'recordatorio', language: 'es_MX', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hola {{1}}, tu cita es mañana' }] },
              { id: 't2', name: 'oferta', language: 'es_MX', status: 'PENDING', category: 'MARKETING', components: [{ type: 'BODY', text: 'Oferta' }] },
            ],
          },
        }
      : undefined,
  (c) => {
    if (!c.url.endsWith(`/${PHONE_ID}/messages`)) return undefined;
    if (c.body?.status === 'read') return { json: { success: true } };
    if (c.body?.to === '525500000047') return { status: 400, json: { error: { message: '(#131047) Re-engagement message', code: 131047 } } };
    return { json: { messaging_product: 'whatsapp', contacts: [{ input: c.body.to, wa_id: c.body.to }], messages: [{ id: `wamid.OUT${meta.calls.length}` }] } };
  },
  (c) => (c.url.endsWith('/MEDIA123') ? { json: { url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1', mime_type: 'image/jpeg' } } : undefined),
  (c) => (c.url.startsWith('https://lookaside.fbsbx.com/') ? { body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) } : undefined),
]);

let env: TestEnv;

function sign(body: string, secret = APP_SECRET) {
  return `sha256=${hmacSha256Hex(secret, body)}`;
}

function inbound(messages: any[], statuses: any[] = []) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA_ID,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '525512340000', phone_number_id: PHONE_ID },
              contacts: messages.length ? [{ profile: { name: 'Mario' }, wa_id: messages[0].from }] : undefined,
              messages: messages.length ? messages : undefined,
              statuses: statuses.length ? statuses : undefined,
            },
          },
        ],
      },
    ],
  });
}

async function postWebhook(body: string, signature = sign(body)) {
  return env.built.app.inject({
    method: 'POST',
    url: '/webhooks/whatsapp',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    payload: body,
  });
}

beforeAll(async () => {
  env = await setup({ fetch: meta.fetch });
  await env.register('meta@test.com');
});
afterAll(() => env.close());

describe('WhatsApp Cloud API channel', () => {
  let channel: any;
  let contactId: string;

  it('validates credentials with Meta, subscribes the app and syncs templates', async () => {
    const r = await env.api('POST', '/api/channels', {
      provider: 'cloud_api',
      name: 'Ventas',
      phone_number_id: PHONE_ID,
      waba_id: WABA_ID,
      access_token: TOKEN,
      app_secret: APP_SECRET,
    });
    expect(r.status).toBe(200);
    channel = r.body.channel;
    expect(channel.display_phone).toBe('+52 55 1234 0000');
    expect(channel.has_access_token).toBe(true);
    expect(channel.credentials).toBeUndefined();
    expect(channel.webhook_url).toBe('https://crm.test/webhooks/whatsapp');
    expect(r.body.warnings).toEqual([]);
    const first = meta.calls[0];
    expect(first.url).toContain('https://graph.facebook.com/v23.0/');
    expect(first.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(meta.calls.some((c) => c.url.endsWith('/subscribed_apps') && c.method === 'POST')).toBe(true);
    const t = await env.api('GET', '/api/templates');
    expect(t.body.templates.map((x: any) => `${x.name}:${x.status}`).sort()).toEqual(['oferta:PENDING', 'recordatorio:APPROVED']);
    // secrets are stored encrypted
    const raw = await env.built.ctx.db.query(`SELECT credentials FROM channels WHERE id = $1`, [channel.id]);
    expect(raw.rows[0].credentials).not.toContain(TOKEN);
  });

  it('answers the verification handshake', async () => {
    const ok = await env.built.app.inject({
      method: 'GET',
      url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${channel.verify_token}&hub.challenge=12345`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('12345');
    const bad = await env.built.app.inject({ method: 'GET', url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1' });
    expect(bad.statusCode).toBe(403);
  });

  it('rejects payloads with an invalid signature', async () => {
    const body = inbound([{ from: '5215598765432', id: 'wamid.IN1', timestamp: '1761660000', type: 'text', text: { body: 'hola' } }]);
    const res = await postWebhook(body, sign(body, 'otro-secreto-xxxxxxxx'));
    expect(res.statusCode).toBe(401);
  });

  it('processes signed inbound messages through the queue', async () => {
    const now = String(Math.floor(Date.now() / 1000));
    const body = inbound([{ from: '5215598765432', id: 'wamid.IN1', timestamp: now, type: 'text', text: { body: 'Quiero información' } }]);
    const res = await postWebhook(body);
    expect(res.statusCode).toBe(200);
    await env.drain();
    const list = await env.api('GET', '/api/contacts?has_messages=1');
    expect(list.body.total).toBe(1);
    const contact = list.body.items[0];
    contactId = contact.id;
    expect(contact.phone).toBe('525598765432');
    expect(contact.name).toBe('Mario');
    expect(contact.last_message_preview).toBe('Quiero información');
    // duplicate delivery is ignored
    await postWebhook(body);
    await env.drain();
    const msgs = await env.api('GET', `/api/contacts/${contactId}/messages`);
    expect(msgs.body.messages).toHaveLength(1);
  });

  it('downloads inbound media from Meta', async () => {
    const now = String(Math.floor(Date.now() / 1000));
    await postWebhook(inbound([{ from: '5215598765432', id: 'wamid.IMG', timestamp: now, type: 'image', image: { id: 'MEDIA123', mime_type: 'image/jpeg', caption: 'mi foto' } }]));
    await env.drain();
    const msgs = await env.api('GET', `/api/contacts/${contactId}/messages`);
    const img = msgs.body.messages.find((m: any) => m.wamid === 'wamid.IMG');
    expect(img.media_file_id).toBeTruthy();
    expect(img.file_mime).toBe('image/jpeg');
    const file = await env.api('GET', `/api/media/${img.media_file_id}`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/jpeg');
  });

  it('marks chats as read and sends text with the Graph API format', async () => {
    const read = await env.api('POST', `/api/contacts/${contactId}/read`);
    expect(read.status).toBe(200);
    expect(meta.calls.some((c) => c.body?.status === 'read' && String(c.body?.message_id).startsWith('wamid.I'))).toBe(true);
    const r = await env.api('POST', `/api/contacts/${contactId}/messages`, { type: 'text', text: 'Claro, te comparto https://tienda.mx' });
    expect(r.body.message.status).toBe('sent');
    const call = meta.calls.filter((c) => c.url.endsWith('/messages') && c.body?.type === 'text').pop()!;
    expect(call.body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '5215598765432',
      type: 'text',
      text: { body: 'Claro, te comparto https://tienda.mx', preview_url: true },
    });
  });

  it('reconciles credits from the pricing in status webhooks', async () => {
    const r = await env.api('POST', `/api/contacts/${contactId}/messages`, {
      type: 'template',
      name: 'recordatorio',
      language: 'es_MX',
      params: { body: ['Mario'] },
    });
    const m = r.body.message;
    expect(m.cost).toBeCloseTo(0.0085);
    const tplCall = meta.calls.filter((c) => c.body?.type === 'template').pop()!;
    expect(tplCall.body.template).toEqual({ name: 'recordatorio', language: { code: 'es_MX' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Mario' }] }] });
    // Meta says it was free (inside the customer service window): refund
    const ts = String(Math.floor(Date.now() / 1000));
    await postWebhook(inbound([], [{ id: m.wamid, status: 'delivered', timestamp: ts, recipient_id: '5215598765432', pricing: { billable: false, pricing_model: 'PMP', category: 'utility', type: 'free_customer_service' } }]));
    await env.drain();
    const after = (await env.api('GET', `/api/contacts/${contactId}/messages`)).body.messages.find((x: any) => x.id === m.id);
    expect(after.status).toBe('delivered');
    expect(after.cost).toBe(0);
    expect(after.pricing_reconciled).toBe(true);
    // A later read status does not touch credits again
    await postWebhook(inbound([], [{ id: m.wamid, status: 'read', timestamp: ts, recipient_id: '5215598765432', pricing: { billable: true, pricing_model: 'PMP', category: 'marketing' } }]));
    await env.drain();
    const credits = await env.api('GET', '/api/credits');
    expect(credits.body.spent_this_month).toBeCloseTo(0);
  });

  it('charges service messages when Meta marks them billable', async () => {
    const r = await env.api('POST', `/api/contacts/${contactId}/messages`, { type: 'text', text: 'Mensaje de servicio' });
    const ts = String(Math.floor(Date.now() / 1000));
    await postWebhook(inbound([], [{ id: r.body.message.wamid, status: 'sent', timestamp: ts, recipient_id: '5215598765432', pricing: { billable: true, pricing_model: 'PMP', category: 'service', type: 'regular' } }]));
    await env.drain();
    const credits = await env.api('GET', '/api/credits');
    expect(credits.body.spent_this_month).toBeCloseTo(0.0085);
  });

  it('stores Meta errors with a Spanish explanation', async () => {
    const c = await env.api('POST', '/api/contacts', { phone: '5500000047' });
    // fake an open window to reach the API
    await env.built.ctx.db.query(`UPDATE contacts SET last_inbound_at = now() WHERE id = $1`, [c.body.contact.id]);
    const r = await env.api('POST', `/api/contacts/${c.body.contact.id}/messages`, { type: 'text', text: 'hola' });
    expect(r.status).toBe(200);
    expect(r.body.message.status).toBe('failed');
    expect(r.body.message.error.code).toBe(131047);
    expect(r.body.message.error.message).toMatch(/24 h/);
  });

  it('updates template status from Meta webhooks', async () => {
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: WABA_ID, changes: [{ field: 'message_template_status_update', value: { event: 'APPROVED', message_template_id: 't2', message_template_name: 'oferta', message_template_language: 'es_MX', reason: 'NONE' } }] }],
    });
    expect((await postWebhook(body)).statusCode).toBe(200);
    await env.drain();
    const t = await env.api('GET', '/api/templates');
    expect(t.body.templates.find((x: any) => x.name === 'oferta').status).toBe('APPROVED');
  });

  it('ignores status webhooks for unknown messages after retries', async () => {
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    await postWebhook(inbound([], [{ id: 'wamid.UNKNOWN', status: 'delivered', timestamp: old, recipient_id: '1' }]));
    await env.drain();
    const failed = await env.built.ctx.db.query(`SELECT count(*)::int AS n FROM jobs WHERE status = 'failed'`);
    expect(failed.rows[0].n).toBe(0);
  });
});
