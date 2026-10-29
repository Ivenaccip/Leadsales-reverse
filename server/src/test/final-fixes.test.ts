import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeFetch, setup, type TestEnv } from './helpers.js';

const PHONE_ID = '1098765432199';
const WABA_ID = '2223334445599';

const meta = fakeFetch([
  (c) => (c.url.includes(`/${PHONE_ID}?fields=`) ? { json: { id: PHONE_ID, display_phone_number: '+52 55 1234 0099', verified_name: 'Tienda' } } : undefined),
  (c) => (c.url.endsWith(`/${WABA_ID}/subscribed_apps`) ? { json: { success: true } } : undefined),
  (c) => (c.url.includes(`/${WABA_ID}/phone_numbers`) ? { json: { data: [{ id: PHONE_ID }] } } : undefined),
  (c) => (c.url.includes(`/${WABA_ID}/message_templates`) ? { json: { data: [] } } : undefined),
]);

let env: TestEnv;

beforeAll(async () => {
  env = await setup({ fetch: meta.fetch, config: { maxUploadMb: 1 } });
  await env.register('final@test.com', 'Final');
});

afterAll(async () => {
  await env?.close();
});

describe('media upload size limit', () => {
  it('answers in Spanish when the file is over MAX_UPLOAD_MB', async () => {
    const boundary = '----leadlibre';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="grande.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      Buffer.alloc(1024 * 1024 + 10, 0x41),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const r = await env.api('POST', '/api/media', payload, { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
    expect(r.status).toBe(400);
    expect(r.body.error).toEqual({ code: 'MEDIA_TOO_LARGE', message: 'El archivo supera 1 MB' });
  });
});

describe('channel credentials', () => {
  it('subscribes the app again when the access token or app secret changes', async () => {
    const created = await env.api('POST', '/api/channels', {
      provider: 'cloud_api',
      name: 'Tienda',
      phone_number_id: PHONE_ID,
      waba_id: WABA_ID,
      access_token: 'EAAG-first-token-xxxxxxxxxxxxxxxxxxxx',
      app_secret: 'first-app-secret-0123456789',
    });
    expect(created.status).toBe(200);
    const subscribes = () => meta.calls.filter((c) => c.url.endsWith('/subscribed_apps') && c.method === 'POST').length;
    const before = subscribes();
    const r = await env.api('PATCH', `/api/channels/${created.body.channel.id}`, {
      access_token: 'EAAG-second-token-from-another-app-xx',
      app_secret: 'second-app-secret-0123456789',
    });
    expect(r.status).toBe(200);
    expect(r.body.warnings).toEqual([]);
    expect(subscribes()).toBe(before + 1);
    // A rename alone does not touch Meta.
    await env.api('PATCH', `/api/channels/${created.body.channel.id}`, { name: 'Tienda centro' });
    expect(subscribes()).toBe(before + 1);
  });
});
