import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Queue } from '../jobs/queue.js';
import { Worker } from '../jobs/worker.js';
import { encryptJson } from '../lib/crypto.js';
import { dispatchWebhook } from '../services/events.js';
import { upsertTemplate } from '../services/templates.js';
import type { ChannelRow } from '../types.js';
import { processInboundMessage, processStatus } from '../whatsapp/inbound.js';
import { fakeFetch, setup, type FakeCall, type TestEnv } from './helpers.js';

// Cross-group follow-ups: broadcast location/coupon params (#66), shared template rendering, public
// API template params, sandbox never taking over a real contact (#69), duplicate bot menu keys,
// lost send answers settled by a webhook (#17) and the single-replica warning (#76).

const PHONE_ID = '1098765432177';

/** Runs inside Meta's POST /messages before the answer is "lost" (connection reset). */
let beforeReset: ((call: FakeCall) => Promise<void>) | null = null;

const meta = fakeFetch([
  (c) =>
    c.url.endsWith(`/${PHONE_ID}/messages`) && c.body?.status !== 'read'
      ? { json: { messaging_product: 'whatsapp', contacts: [{ input: c.body.to, wa_id: c.body.to }], messages: [{ id: `wamid.X.${meta.calls.length}` }] } }
      : undefined,
  (c) => (c.url.endsWith(`/${PHONE_ID}/messages`) ? { json: { success: true } } : undefined),
]);

const metaFetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? input);
  const res = await meta.fetch(input, init);
  if (beforeReset && url.endsWith(`/${PHONE_ID}/messages`) && !String(init?.body ?? '').includes('"status":"read"')) {
    await beforeReset(meta.calls.at(-1)!);
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }) });
  }
  return res;
}) as typeof fetch;

let env: TestEnv;
let ws: string;
let cloud: ChannelRow;
let sandbox: ChannelRow;

const ctx = () => env.built.ctx;
const q = (sql: string, params: unknown[] = []) => ctx().db.query<any>(sql, params);
const sends = () => meta.calls.filter((c) => c.url.endsWith(`/${PHONE_ID}/messages`) && c.body?.type === 'template');

const LOCATION = [{ type: 'HEADER', format: 'LOCATION' }, { type: 'BODY', text: 'Hola {{1}}, te esperamos aquí' }];
const COUPON = [{ type: 'BODY', text: 'Tu cupón de descuento' }, { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE', example: 'VERANO15' }] }];
const CAROUSEL = [
  { type: 'BODY', text: 'Mira las novedades' },
  { type: 'CAROUSEL', cards: [{ components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Tarjeta' }] }] },
];

let seq = 0;
async function newContact(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await env.api('POST', '/api/contacts', { phone: `+52 55 8100 ${String(1000 + ++seq)}`, name, ...extra });
  expect(r.status).toBe(200);
  return r.body.contact.id;
}

async function template(name: string, components: any[], category = 'MARKETING') {
  await ctx().db.tx((tx) => upsertTemplate(tx, cloud, { meta_id: `m-${name}`, name, language: 'es_MX', category, status: 'APPROVED', components }));
}

beforeAll(async () => {
  env = await setup({ fetch: metaFetch });
  ws = (await env.register('xreq@test.com', 'Cruces')).workspaceId;
  cloud = (
    await q(
      `INSERT INTO channels (workspace_id, provider, name, phone_number_id, waba_id, credentials, verify_token, is_default)
       VALUES ($1, 'cloud_api', 'Meta', $2, '2223334445577', $3, 'vt-x', true) RETURNING *`,
      [ws, PHONE_ID, encryptJson(ctx().config.encryptionKey, { accessToken: 'EAAG-test', appSecret: 'secret-x' })],
    )
  ).rows[0];
  sandbox = (
    await q(`INSERT INTO channels (workspace_id, provider, name, phone_number_id, verify_token) VALUES ($1, 'sandbox', 'Pruebas', $2, 'vt') RETURNING *`, [
      ws,
      `sandbox-x-${Date.now()}`,
    ])
  ).rows[0];
  await template('sucursal', LOCATION);
  await template('cupon', COUPON);
  await template('promo', [{ type: 'BODY', text: 'Promo {{1}}' }]);
});
afterAll(() => env.close());
beforeEach(() => {
  beforeReset = null;
});

describe('broadcasts with location headers and coupon buttons (#66)', () => {
  it('accepts a location header and sends it to every recipient', async () => {
    const ids = [await newContact('Ana López'), await newContact('Beto')];
    const before = sends().length;
    const created = await env.api('POST', '/api/broadcasts', {
      name: 'Inauguración',
      template_name: 'sucursal',
      template_language: 'es_MX',
      params: { header: { type: 'location', latitude: 19.4326, longitude: -99.1332, name: 'Sucursal' }, body: ['{primer_nombre}'] },
      audience: { contact_ids: ids },
    });
    expect(created.status).toBe(200);
    expect(created.body.broadcast.params.header).toEqual({ type: 'location', latitude: 19.4326, longitude: -99.1332, name: 'Sucursal' });
    expect((await env.api('POST', `/api/broadcasts/${created.body.broadcast.id}/launch`)).status).toBe(200);
    await env.drain();
    const out = sends().slice(before);
    expect(out).toHaveLength(2);
    for (const call of out) {
      expect(call.body.template.components[0]).toEqual({
        type: 'header',
        parameters: [{ type: 'location', location: { latitude: 19.4326, longitude: -99.1332, name: 'Sucursal' } }],
      });
    }
    expect(out.map((c) => c.body.template.components[1].parameters[0].text).sort()).toEqual(['Ana', 'Beto']);
    const b = (await env.api('GET', `/api/broadcasts/${created.body.broadcast.id}`)).body.broadcast;
    expect(b.status).toBe('completed');
    expect(b.stats).toMatchObject({ total: 2, failed: 0 });
  });

  it('sends coupon codes per contact; a code too long for one contact fails only that recipient', async () => {
    const ok = await newContact('Con cupón');
    const long = await newContact('Cupón largo');
    await q(`UPDATE contacts SET custom_fields = '{"cupon":"ANA10"}' WHERE id = $1`, [ok]);
    await q(`UPDATE contacts SET custom_fields = '{"cupon":"ESTE_CUPON_ES_DEMASIADO_LARGO"}' WHERE id = $1`, [long]);
    const before = sends().length;
    const created = await env.api('POST', '/api/broadcasts', {
      name: 'Cupones',
      template_name: 'cupon',
      template_language: 'es_MX',
      params: { buttons: [{ index: 0, value: '{campo.cupon}', sub_type: 'copy_code' }] },
      audience: { contact_ids: [ok, long] },
    });
    expect(created.status).toBe(200);
    expect(created.body.broadcast.params.buttons).toEqual([{ index: 0, value: '{campo.cupon}', sub_type: 'copy_code' }]);
    await env.api('POST', `/api/broadcasts/${created.body.broadcast.id}/launch`);
    await env.drain();
    const out = sends().slice(before);
    expect(out).toHaveLength(1);
    expect(out[0].body.template.components).toEqual([
      { type: 'button', sub_type: 'copy_code', index: '0', parameters: [{ type: 'coupon_code', coupon_code: 'ANA10' }] },
    ]);
    const b = (await env.api('GET', `/api/broadcasts/${created.body.broadcast.id}`)).body.broadcast;
    expect(b.status).toBe('completed');
    const failed = (await q(`SELECT contact_id, error FROM broadcast_recipients WHERE broadcast_id = $1 AND status = 'failed'`, [b.id])).rows;
    expect(failed).toEqual([{ contact_id: long, error: expect.stringMatching(/15 caracteres/) }]);
  });

  it('keeps sub_type for a template that is not synced', async () => {
    const id = await newContact('Sin sincronizar');
    const before = sends().length;
    const created = await env.api('POST', '/api/broadcasts', {
      name: 'Sin plantilla local',
      template_name: 'promo',
      template_language: 'es_MX',
      params: { body: ['x'], buttons: [{ index: 1, value: 'X1', sub_type: 'copy_code' }] },
      audience: { contact_ids: [id] },
    });
    expect(created.status).toBe(200);
    // The stored template has no such button: sub_type tells the send which kind of parameter it is.
    await env.api('POST', `/api/broadcasts/${created.body.broadcast.id}/launch`);
    await env.drain();
    const out = sends().slice(before);
    expect(out).toHaveLength(1);
    expect(out[0].body.template.components.at(-1)).toEqual({
      type: 'button',
      sub_type: 'copy_code',
      index: '1',
      parameters: [{ type: 'coupon_code', coupon_code: 'X1' }],
    });
  });

  it('refuses incomplete params or unsupported templates on create, edit and launch', async () => {
    await template('carrusel', CAROUSEL);
    const id = await newContact('Validación');
    const create = (body: Record<string, unknown>) =>
      env.api('POST', '/api/broadcasts', { name: 'X', template_language: 'es_MX', audience: { contact_ids: [id] }, ...body });

    const noLocation = await create({ template_name: 'sucursal', params: { body: ['Ana'] } });
    expect(noLocation.status).toBe(400);
    expect(noLocation.body.error).toMatchObject({ code: 'TEMPLATE_PARAMS_MISSING', message: expect.stringMatching(/ubicación/) });
    const badLat = await create({ template_name: 'sucursal', params: { header: { type: 'location', latitude: 120, longitude: 0 }, body: ['Ana'] } });
    expect(badLat.status).toBe(400);
    const noCoupon = await create({ template_name: 'cupon' });
    expect(noCoupon.body.error.code).toBe('TEMPLATE_PARAMS_MISSING');
    const longCoupon = await create({ template_name: 'cupon', params: { buttons: [{ index: 0, value: 'DEMASIADO_LARGO_123' }] } });
    expect(longCoupon.body.error.code).toBe('TEMPLATE_PARAMS_INVALID');
    const carousel = await create({ template_name: 'carrusel' });
    expect(carousel.status).toBe(400);
    expect(carousel.body.error).toMatchObject({ code: 'TEMPLATE_UNSUPPORTED', message: expect.stringMatching(/carrusel/) });

    const draft = await create({ name: 'Borrador', template_name: 'promo', params: { body: ['x'] } });
    expect(draft.status).toBe(200);
    const bid = draft.body.broadcast.id;
    // Switching to a template the stored params do not fill is refused; with its params it is fine.
    const switched = await env.api('PATCH', `/api/broadcasts/${bid}`, { template_name: 'sucursal' });
    expect(switched.body.error.code).toBe('TEMPLATE_PARAMS_MISSING');
    const filled = await env.api('PATCH', `/api/broadcasts/${bid}`, {
      template_name: 'sucursal',
      params: { header: { type: 'location', latitude: 20.67, longitude: -103.35, address: 'Av. Juárez 1' }, body: ['{nombre}'] },
    });
    expect(filled.status).toBe(200);

    // A draft saved before this check (incomplete params) can still be renamed, but not launched.
    await q(`UPDATE broadcasts SET params = '{"body":["x"]}' WHERE id = $1`, [bid]);
    expect((await env.api('PATCH', `/api/broadcasts/${bid}`, { name: 'Renombrada' })).status).toBe(200);
    const before = sends().length;
    const launch = await env.api('POST', `/api/broadcasts/${bid}/launch`);
    expect(launch.status).toBe(400);
    expect(launch.body.error.code).toBe('TEMPLATE_PARAMS_MISSING');
    expect((await q(`SELECT status FROM broadcasts WHERE id = $1`, [bid])).rows[0].status).toBe('draft');
    expect((await q(`SELECT count(*)::int AS n FROM broadcast_recipients WHERE broadcast_id = $1`, [bid])).rows[0].n).toBe(0);
    await env.drain();
    expect(sends().length).toBe(before);
  });

  it('pauses instead of failing everyone when a sync makes the template unsendable', async () => {
    await template('cambiante', LOCATION);
    const ids = [await newContact('Uno'), await newContact('Dos')];
    const created = await env.api('POST', '/api/broadcasts', {
      name: 'Cambia',
      template_name: 'cambiante',
      template_language: 'es_MX',
      params: { header: { type: 'location', latitude: 19.4, longitude: -99.1 }, body: ['x'] },
      audience: { contact_ids: ids },
    });
    const bid = created.body.broadcast.id;
    expect((await env.api('POST', `/api/broadcasts/${bid}/launch`)).status).toBe(200);
    await template('cambiante', CAROUSEL);
    const before = sends().length;
    await env.drain();
    expect(sends().length).toBe(before);
    const b = (await q(`SELECT status, last_error FROM broadcasts WHERE id = $1`, [bid])).rows[0];
    expect(b.status).toBe('paused');
    expect(b.last_error).toMatch(/carrusel/);
    const statuses = (await q(`SELECT status FROM broadcast_recipients WHERE broadcast_id = $1`, [bid])).rows.map((r: any) => r.status);
    expect(statuses).toEqual(['queued', 'queued']);
    // Resuming is refused up front while the template stays unsendable.
    const resume = await env.api('POST', `/api/broadcasts/${bid}/launch`);
    expect(resume.body.error.code).toBe('TEMPLATE_UNSUPPORTED');
  });
});

describe('one-off template sends keep location and button sub_type', () => {
  it('renders placeholders through the shared helper (inbox send)', async () => {
    const id = await newContact('Carla Ruiz');
    const before = sends().length;
    const r = await env.api('POST', `/api/contacts/${id}/messages`, {
      type: 'template',
      name: 'sucursal',
      language: 'es_MX',
      params: { header: { type: 'location', latitude: 19.4, longitude: -99.1, name: 'Centro' }, body: ['{primer_nombre}'] },
    });
    expect(r.status).toBe(200);
    const [call] = sends().slice(before);
    expect(call.body.template.components).toEqual([
      { type: 'header', parameters: [{ type: 'location', location: { latitude: 19.4, longitude: -99.1, name: 'Centro' } }] },
      { type: 'body', parameters: [{ type: 'text', text: 'Carla' }] },
    ]);
  });

  it('accepts a location header and a coupon sub_type in the public API', async () => {
    const key = (await env.api('POST', '/api/api-keys', { name: 'Zapier' })).body.key;
    const opts = { cookie: '', ws: null, headers: { authorization: `Bearer ${key}` } };
    const before = sends().length;
    const loc = await env.api(
      'POST',
      '/api/v1/messages',
      { phone: '+52 55 8200 0001', name: 'Diego Paz', template: { name: 'sucursal', header: { type: 'location', latitude: 25.67, longitude: -100.31 }, body: ['{primer_nombre}'] } },
      opts,
    );
    expect(loc.status).toBe(200);
    const coupon = await env.api(
      'POST',
      '/api/v1/messages',
      { phone: '+52 55 8200 0001', template: { name: 'promo', body: ['x'], buttons: [{ index: 1, text: 'OTRO1', sub_type: 'copy_code' }] } },
      opts,
    );
    expect(coupon.status).toBe(200);
    const bad = await env.api('POST', '/api/v1/messages', { phone: '+52 55 8200 0001', template: { name: 'sucursal', header: { type: 'location', latitude: 95, longitude: 0 } } }, opts);
    expect(bad.status).toBe(400);
    const [a, b] = sends().slice(before);
    expect(a.body.template.components).toEqual([
      { type: 'header', parameters: [{ type: 'location', location: { latitude: 25.67, longitude: -100.31 } }] },
      { type: 'body', parameters: [{ type: 'text', text: 'Diego' }] },
    ]);
    // promo has no buttons stored: sub_type decides the parameter kind.
    expect(b.body.template.components.at(-1)).toEqual({ type: 'button', sub_type: 'copy_code', index: '1', parameters: [{ type: 'coupon_code', coupon_code: 'OTRO1' }] });
    // A plain string header still fills a text header variable.
    await template('saludo', [{ type: 'HEADER', format: 'TEXT', text: 'Hola {{1}}' }, { type: 'BODY', text: 'Bienvenido' }]);
    const text = await env.api('POST', '/api/v1/messages', { phone: '+52 55 8200 0001', template: { name: 'saludo', header: '{primer_nombre}' } }, opts);
    expect(text.status).toBe(200);
    expect(sends().at(-1)!.body.template.components).toEqual([{ type: 'header', parameters: [{ type: 'text', text: 'Diego' }] }]);
  });
});

describe('a sandbox message never moves a real contact (#69)', () => {
  const inbound = (channel: ChannelRow, from: string, id: string) =>
    processInboundMessage(ctx(), channel, { from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hola' } });

  it('keeps the Cloud API channel of a contact that writes through the sandbox', async () => {
    const id = await newContact('Real');
    const phone = (await q(`UPDATE contacts SET wa_id = phone, channel_id = $2 WHERE id = $1 RETURNING phone`, [id, cloud.id])).rows[0].phone;
    const m = await inbound(sandbox, phone, `wamid.SBX.${Date.now()}`);
    expect(m?.contact_id).toBe(id);
    expect(m?.channel_id).toBe(sandbox.id);
    expect((await q(`SELECT channel_id FROM contacts WHERE id = $1`, [id])).rows[0].channel_id).toBe(cloud.id);
  });

  it('still follows the channel a message arrives on otherwise', async () => {
    const onSandbox = await newContact('De pruebas');
    const p1 = (await q(`UPDATE contacts SET wa_id = phone, channel_id = $2 WHERE id = $1 RETURNING phone`, [onSandbox, sandbox.id])).rows[0].phone;
    await inbound(cloud, p1, `wamid.CL.${Date.now()}`);
    expect((await q(`SELECT channel_id FROM contacts WHERE id = $1`, [onSandbox])).rows[0].channel_id).toBe(cloud.id);

    const noChannel = await newContact('Sin canal');
    const p2 = (await q(`UPDATE contacts SET wa_id = phone, channel_id = NULL WHERE id = $1 RETURNING phone`, [noChannel])).rows[0].phone;
    await inbound(sandbox, p2, `wamid.SBX2.${Date.now()}`);
    expect((await q(`SELECT channel_id FROM contacts WHERE id = $1`, [noChannel])).rows[0].channel_id).toBe(sandbox.id);
  });
});

describe('bot menu keys', () => {
  const put = (menu: unknown) =>
    env.api('PUT', '/api/workspace/settings', { bot: { menu, fallback: 'f', handoff_message: 'h', interactive: false, only_unassigned: false } });

  it('refuses two options with the same key in one menu level, at any depth', async () => {
    const top = await put({ prompt: '¿Qué necesitas?', options: [{ key: '1', label: 'Ventas' }, { key: ' 1 ', label: 'Soporte' }] });
    expect(top.status).toBe(400);
    expect(top.body.error.message).toMatch(/bot\.menu\.options\.1\.key: La clave "1" está repetida/);
    const nested = await put({
      prompt: 'Hola',
      options: [{ key: '1', label: 'Citas', submenu: { prompt: '¿Cuándo?', options: [{ key: 'a', label: 'Hoy' }, { key: 'a', label: 'Mañana' }] } }],
    });
    expect(nested.status).toBe(400);
    expect(nested.body.error.message).toMatch(/submenu\.options\.1\.key/);
  });

  it('allows the same key on different levels', async () => {
    const ok = await put({ prompt: 'Hola', options: [{ key: '1', label: 'Citas', submenu: { prompt: '¿Cuándo?', options: [{ key: '1', label: 'Hoy' }] } }, { key: '2', label: 'Otro' }] });
    expect(ok.status).toBe(200);
  });
});

describe('a lost send answer never overwrites what a status webhook settled (#17)', () => {
  const settleThenLose = (status: 'delivered' | 'failed') => async (call: FakeCall) => {
    const st: Record<string, unknown> = {
      id: `wamid.SETTLED.${status}.${Date.now()}`,
      status,
      recipient_id: call.body.to,
      timestamp: String(Math.floor(Date.now() / 1000)),
      biz_opaque_callback_data: call.body.biz_opaque_callback_data,
    };
    if (status === 'failed') st.errors = [{ code: 131026, title: 'Message undeliverable' }];
    expect(await processStatus(ctx(), cloud, st)).toBe(true);
  };

  it('keeps a delivered status and drops no error onto it', async () => {
    const id = await newContact('Entregado');
    beforeReset = settleThenLose('delivered');
    const r = await env.api('POST', `/api/contacts/${id}/messages`, { type: 'template', name: 'promo', language: 'es_MX', params: { body: ['x'] } });
    expect(r.status).toBe(200);
    expect(r.body.message).toMatchObject({ status: 'delivered', error: null, wamid: expect.stringMatching(/^wamid\.SETTLED\.delivered/) });
    const row = (await q(`SELECT status, error FROM messages WHERE id = $1`, [r.body.message.id])).rows[0];
    expect(row).toEqual({ status: 'delivered', error: null });
  });

  it("keeps Meta's failure reason instead of 'could not confirm'", async () => {
    const id = await newContact('Fallido');
    beforeReset = settleThenLose('failed');
    const r = await env.api('POST', `/api/contacts/${id}/messages`, { type: 'template', name: 'promo', language: 'es_MX', params: { body: ['x'] } });
    expect(r.body.message.status).toBe('failed');
    expect(r.body.message.error.code).toBe(131026);
    expect(r.body.message.error.message).not.toMatch(/No pudimos confirmar/);
  });

  it('still marks an unanswered send unknown', async () => {
    const id = await newContact('Sin respuesta');
    beforeReset = async () => {};
    const r = await env.api('POST', `/api/contacts/${id}/messages`, { type: 'template', name: 'promo', language: 'es_MX', params: { body: ['x'] } });
    expect(r.body.message.status).toBe('unknown');
    expect(r.body.message.error.message).toMatch(/No pudimos confirmar/);
  });
});

describe('single replica warning (#76)', () => {
  it("lists other live instances, never this process's own heartbeat", async () => {
    await q(`DELETE FROM worker_heartbeats`);
    const w = new Worker(ctx(), {});
    await q(`INSERT INTO worker_heartbeats (id, seen_at) VALUES ($1, now()), ('otra:1:abc', now() - interval '5 seconds'), ('vieja:1:abc', now() - interval '2 minutes')`, [w.id]);
    expect(await w.otherInstances()).toEqual(['otra:1:abc']);
    await q(`DELETE FROM worker_heartbeats WHERE id <> $1`, [w.id]);
    expect(await w.otherInstances()).toEqual([]);
    expect(await w.liveReplicas(10)).toEqual([]);
  });

  it('ignores a run that crashed moments ago and reports one that keeps beating', async () => {
    await q(`DELETE FROM worker_heartbeats`);
    const w = new Worker(ctx(), {});
    await q(`INSERT INTO worker_heartbeats (id, seen_at) VALUES ('caida:1:abc', now() - interval '5 seconds')`);
    expect(await w.liveReplicas(30)).toEqual([]);

    await q(`INSERT INTO worker_heartbeats (id, seen_at) VALUES ('viva:2:def', now() - interval '5 seconds')`);
    const beat = setTimeout(() => void q(`UPDATE worker_heartbeats SET seen_at = now() WHERE id = 'viva:2:def'`), 20);
    try {
      expect(await w.liveReplicas(200)).toEqual(['viva:2:def']);
    } finally {
      clearTimeout(beat);
      await q(`DELETE FROM worker_heartbeats`);
    }
  });
});

describe('status webhooks remember the WhatsApp id Meta delivered to', () => {
  const status = (wamid: string, recipient: string) =>
    processStatus(ctx(), cloud, { id: wamid, status: 'sent', recipient_id: recipient, timestamp: String(Math.floor(Date.now() / 1000)) });

  it('stores recipient_id when the contact has no wa_id yet, unless another contact holds it', async () => {
    const id = await newContact('Brasil');
    const r = await env.api('POST', `/api/contacts/${id}/messages`, { type: 'template', name: 'promo', language: 'es_MX', params: { body: ['x'] } });
    expect((await q(`SELECT wa_id FROM contacts WHERE id = $1`, [id])).rows[0].wa_id).toBeNull();
    expect(await status(r.body.message.wamid, '551187650001')).toBe(true);
    expect((await q(`SELECT wa_id FROM contacts WHERE id = $1`, [id])).rows[0].wa_id).toBe('551187650001');
    // A later status never replaces a wa_id the contact already has.
    await status(r.body.message.wamid, '551187650002');
    expect((await q(`SELECT wa_id FROM contacts WHERE id = $1`, [id])).rows[0].wa_id).toBe('551187650001');

    const other = await newContact('Otro');
    const r2 = await env.api('POST', `/api/contacts/${other}/messages`, { type: 'template', name: 'promo', language: 'es_MX', params: { body: ['x'] } });
    await status(r2.body.message.wamid, '551187650001');
    expect((await q(`SELECT wa_id FROM contacts WHERE id = $1`, [other])).rows[0].wa_id).toBeNull();
  });
});

describe('jobs queued inside a transaction', () => {
  it('dispatchWebhook queues deliveries only if the transaction commits', async () => {
    const hook = await env.api('POST', '/api/webhooks', { url: 'https://93.184.216.34/hook', events: ['message.received'] });
    expect(hook.status).toBe(200);
    const count = async () => (await q(`SELECT count(*)::int AS n FROM jobs WHERE type = 'webhook.deliver' AND payload->>'endpointId' = $1`, [hook.body.webhook.id])).rows[0].n;
    try {
      await expect(
        ctx().db.tx(async (tx) => {
          await dispatchWebhook(ctx(), ws, 'message.received', { id: 'x' }, tx);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await count()).toBe(0);
      await ctx().db.tx((tx) => dispatchWebhook(ctx(), ws, 'message.received', { id: 'y' }, tx));
      expect(await count()).toBe(1);
    } finally {
      await q(`DELETE FROM jobs WHERE type = 'webhook.deliver'`);
      await env.api('DELETE', `/api/webhooks/${hook.body.webhook.id}`);
    }
  });

  it('notify() wakes the workers without enqueuing anything', () => {
    const queue = new Queue(ctx().db);
    let woken = 0;
    queue.onEnqueue(() => woken++);
    queue.notify();
    expect(woken).toBe(1);
  });
});

describe('scheduled messages being sent', () => {
  it('stay in the contact panel while they are sent, and cannot be cancelled', async () => {
    const id = await newContact('Programado');
    const send_at = new Date(Date.now() + 3600_000).toISOString();
    const s = await env.api('POST', `/api/contacts/${id}/scheduled`, { send_at, content: { type: 'text', text: 'Recordatorio' } });
    expect(s.status).toBe(200);
    await q(`UPDATE scheduled_messages SET status = 'sending' WHERE id = $1`, [s.body.scheduled.id]);
    const detail = (await env.api('GET', `/api/contacts/${id}`)).body;
    expect(detail.scheduled.map((r: any) => [r.id, r.status])).toEqual([[s.body.scheduled.id, 'sending']]);
    const cancel = await env.api('DELETE', `/api/scheduled/${s.body.scheduled.id}`);
    expect(cancel.status).toBe(409);
    expect(cancel.body.error.code).toBe('SCHEDULED_SENDING');
    await q(`UPDATE scheduled_messages SET status = 'cancelled' WHERE id = $1`, [s.body.scheduled.id]);
  });
});

describe('scheduled template params', () => {
  it('are checked with their placeholders filled for the contact', async () => {
    const id = await newContact('Cupón programado');
    await q(`UPDATE contacts SET custom_fields = '{"codigo_de_cupon":"ANA10"}' WHERE id = $1`, [id]);
    const send_at = new Date(Date.now() + 3600_000).toISOString();
    // The placeholder itself is longer than a coupon may be; the code it renders to is not.
    const ok = await env.api('POST', `/api/contacts/${id}/scheduled`, {
      send_at,
      content: { type: 'template', name: 'cupon', language: 'es_MX', params: { buttons: [{ index: 0, text: '{campo.codigo_de_cupon}' }] } },
    });
    expect(ok.status).toBe(200);
    await q(`UPDATE scheduled_messages SET status = 'cancelled' WHERE id = $1`, [ok.body.scheduled.id]);
    await q(`UPDATE contacts SET custom_fields = '{"codigo_de_cupon":"ESTE_CUPON_ES_DEMASIADO_LARGO"}' WHERE id = $1`, [id]);
    const long = await env.api('POST', `/api/contacts/${id}/scheduled`, {
      send_at,
      content: { type: 'template', name: 'cupon', language: 'es_MX', params: { buttons: [{ index: 0, text: '{campo.codigo_de_cupon}' }] } },
    });
    expect(long.status).toBe(400);
    expect(long.body.error.code).toBe('TEMPLATE_PARAMS_INVALID');
  });
});
