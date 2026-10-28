import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hmacSha256Hex } from '../lib/crypto.js';
import { fakeFetch, setup, type TestEnv } from './helpers.js';

const hooks = fakeFetch([(c) => (c.url.startsWith('https://93.184.216.34/') ? { json: { ok: true } } : undefined), (c) => (c.url.startsWith('http://127.0.0.1') ? { json: {} } : undefined)]);
let env: TestEnv;
let key: string;

beforeAll(async () => {
  env = await setup({ fetch: hooks.fetch, config: { allowPrivateWebhooks: false } });
  await env.register('api@test.com', 'Integraciones');
  await env.api('POST', '/api/channels', { provider: 'sandbox', name: 'S' });
});
afterAll(() => env.close());

describe('public API and webhooks', () => {
  it('creates API keys that are shown only once', async () => {
    const r = await env.api('POST', '/api/api-keys', { name: 'Make' });
    key = r.body.key;
    expect(key).toMatch(/^ll_live_/);
    const list = await env.api('GET', '/api/api-keys');
    expect(JSON.stringify(list.body)).not.toContain(key);
    const unauth = await env.api('GET', '/api/v1/funnels', undefined, { cookie: '', ws: null, headers: { authorization: 'Bearer ll_live_nope' } });
    expect(unauth.status).toBe(401);
  });

  it('delivers signed webhooks for new leads', async () => {
    const w = await env.api('POST', '/api/webhooks', { url: 'https://93.184.216.34/leadlibre', events: ['contact.created'] });
    expect(w.status).toBe(200);
    const secret = w.body.webhook.secret;
    await env.api('POST', '/api/v1/contacts', { phone: '+52 55 3333 2222', name: 'Lead de Facebook', tags: ['Facebook Ads'], stage: 'Interesado', source: 'facebook_lead_ads' }, {
      cookie: '',
      ws: null,
      headers: { authorization: `Bearer ${key}` },
    });
    await env.drain();
    const call = hooks.calls.find((c) => c.url === 'https://93.184.216.34/leadlibre')!;
    expect(call).toBeTruthy();
    expect(call.headers['x-leadlibre-event']).toBe('contact.created');
    expect(call.body.data.name).toBe('Lead de Facebook');
    const raw = JSON.stringify(call.body);
    expect(call.headers['x-leadlibre-signature']).toBe(`sha256=${hmacSha256Hex(secret, raw)}`);
  });

  it('upserts contacts by phone with stage and tag names', async () => {
    const opts = { cookie: '', ws: null, headers: { 'x-api-key': key } } as const;
    const again = await env.api('POST', '/api/v1/contacts', { phone: '5533332222', email: 'fb@lead.com', tags: ['Caliente'] }, opts);
    expect(again.body.created).toBe(false);
    expect(again.body.contact.email).toBe('fb@lead.com');
    expect(again.body.contact.tag_ids).toHaveLength(2);
    expect(again.body.contact.source).toBe('facebook_lead_ads');
    const got = await env.api('GET', '/api/v1/contacts?phone=525533332222', undefined, opts);
    expect(got.body.contact.name).toBe('Lead de Facebook');
    const badStage = await env.api('POST', '/api/v1/contacts', { phone: '5533332222', stage: 'No existe' }, opts);
    expect(badStage.status).toBe(400);
  });

  it('sends templates through the API', async () => {
    const opts = { cookie: '', ws: null, headers: { authorization: `Bearer ${key}` } } as const;
    const r = await env.api('POST', '/api/v1/messages', { phone: '5533332222', template: { name: 'seguimiento', language: 'es_MX', body: ['{primer_nombre}'] } }, opts);
    expect(r.status).toBe(200);
    expect(r.body.message.body).toContain('Hola Lead,');
    const text = await env.api('POST', '/api/v1/messages', { phone: '5533332222', text: 'hola' }, opts);
    expect(text.status).toBe(400);
    expect(text.body.error.code).toBe('WINDOW_CLOSED');
  });

  it('refuses webhook deliveries to private networks', async () => {
    const w = await env.api('POST', '/api/webhooks', { url: 'http://127.0.0.1:8080/x', events: ['*'] });
    await env.api('POST', `/api/webhooks/${w.body.webhook.id}/test`);
    await env.drain();
    expect(hooks.calls.some((c) => c.url.startsWith('http://127.0.0.1'))).toBe(false);
    const list = (await env.api('GET', '/api/webhooks')).body.webhooks.find((x: any) => x.id === w.body.webhook.id);
    expect(list.last_error).toMatch(/red privada/);
  });

  it('creates templates in Meta format', async () => {
    const ch = (await env.api('GET', '/api/channels')).body.channels[0];
    const r = await env.api('POST', '/api/templates', {
      channel_id: ch.id,
      name: 'cita_recordatorio',
      language: 'es_MX',
      category: 'UTILITY',
      body: { text: 'Hola {{1}}, tu cita es el {{2}}', examples: ['Ana', 'lunes 10am'] },
      buttons: [{ type: 'QUICK_REPLY', text: 'Confirmo' }],
    });
    expect(r.status).toBe(200);
    expect(r.body.template.status).toBe('APPROVED'); // sandbox approves instantly
    expect(r.body.template.inputs.body).toEqual(['1', '2']);
    const bad = await env.api('POST', '/api/templates', { channel_id: ch.id, name: 'Mal Nombre', category: 'UTILITY', body: { text: 'x' } });
    expect(bad.status).toBe(400);
  });
});
