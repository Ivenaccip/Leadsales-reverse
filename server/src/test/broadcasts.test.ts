import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type TestEnv } from './helpers.js';

let env: TestEnv;
let tags: any[];

beforeAll(async () => {
  env = await setup();
  await env.register('campanas@test.com', 'Tienda');
  await env.api('POST', '/api/channels', { provider: 'sandbox', name: 'S' });
  tags = (await env.api('GET', '/api/tags')).body.tags;
  const vip = tags[0].id;
  await env.api('POST', '/api/contacts', { phone: '5255100001', name: 'Ana Ruiz', tag_ids: [vip] });
  await env.api('POST', '/api/contacts', { phone: '5255100002', name: 'Beto', tag_ids: [vip] });
  await env.api('POST', '/api/contacts', { phone: '573001112233', name: 'Camila', tag_ids: [vip] });
  await env.api('POST', '/api/contacts', { phone: '5255100004', name: 'Sin etiqueta' });
  const out = await env.api('POST', '/api/contacts', { phone: '5255100005', name: 'Dado de baja', tag_ids: [vip] });
  await env.api('PATCH', `/api/contacts/${out.body.contact.id}`, { opted_out: true });
});
afterAll(() => env.close());

describe('broadcasts', () => {
  it('estimates cost by market and excludes opted-out contacts', async () => {
    const r = await env.api('POST', '/api/broadcasts/estimate', { template_name: 'bienvenida', template_language: 'es_MX', audience: { tag_ids: [tags[0].id] } });
    expect(r.status).toBe(200);
    const e = r.body.estimate;
    expect(e.recipients).toBe(3);
    expect(e.category).toBe('marketing');
    expect(e.by_market).toEqual([
      { market: 'MX', count: 2, unit_price: 0.0457, cost: 0.0914 },
      { market: 'CO', count: 1, unit_price: 0.0125, cost: 0.0125 },
    ]);
    expect(e.cost).toBeCloseTo(0.1039);
    expect(e.sufficient).toBe(true);
  });

  it('sends a template to the audience with personalized params', async () => {
    const created = await env.api('POST', '/api/broadcasts', {
      name: 'Promo octubre',
      template_name: 'bienvenida',
      template_language: 'es_MX',
      params: { body: ['{primer_nombre}', 'nuestra tienda'] },
      audience: { tag_ids: [tags[0].id] },
    });
    expect(created.status).toBe(200);
    const id = created.body.broadcast.id;
    expect(created.body.broadcast.status).toBe('draft');
    const launched = await env.api('POST', `/api/broadcasts/${id}/launch`);
    expect(launched.status).toBe(200);
    expect(launched.body.broadcast.status).toBe('running');
    expect(launched.body.broadcast.total_recipients).toBe(3);
    await env.drain();
    const b = (await env.api('GET', `/api/broadcasts/${id}`)).body.broadcast;
    expect(b.status).toBe('completed');
    expect(b.stats).toMatchObject({ total: 3, queued: 0, failed: 0, sent: 3, delivered: 3, read: 3 });
    expect(b.stats.cost).toBeCloseTo(0.1039);
    const recips = (await env.api('GET', `/api/broadcasts/${id}/recipients`)).body.recipients;
    expect(recips).toHaveLength(3);
    const ana = (await env.api('GET', '/api/contacts?search=Ana')).body.items[0];
    const msgs = (await env.api('GET', `/api/contacts/${ana.id}/messages`)).body.messages;
    expect(msgs[0].body).toContain('¡Hola Ana! Gracias por tu interés en nuestra tienda.');
    expect(msgs[0].sent_by).toBe('broadcast');
    // relaunching a completed broadcast is not allowed
    expect((await env.api('POST', `/api/broadcasts/${id}/launch`)).status).toBe(400);
  });

  it('counts replies to the broadcast', async () => {
    const list = (await env.api('GET', '/api/broadcasts')).body.broadcasts;
    const ch = (await env.api('GET', '/api/channels')).body.channels[0];
    // WhatsApp ids are full international numbers: Ana was stored as 52 + 5255100001.
    await env.api('POST', `/api/channels/${ch.id}/simulate`, { from: '525255100001', text: 'Me interesa' });
    const b = (await env.api('GET', `/api/broadcasts/${list[0].id}`)).body.broadcast;
    expect(b.stats.replied).toBe(1);
  });

  it('pauses when prepaid credits run out', async () => {
    const ws = (await env.api('GET', '/api/workspace')).body.workspace;
    await env.api('PATCH', `/api/admin/workspaces/${ws.id}`, { billing_mode: 'prepaid' });
    await env.api('POST', `/api/admin/workspaces/${ws.id}/credits`, { amount: 0.05 });
    const created = await env.api('POST', '/api/broadcasts', {
      name: 'Sin saldo',
      template_name: 'bienvenida',
      template_language: 'es_MX',
      params: { body: ['{primer_nombre}', 'x'] },
      audience: { tag_ids: [tags[0].id] },
    });
    const launch = await env.api('POST', `/api/broadcasts/${created.body.broadcast.id}/launch`);
    expect(launch.status).toBe(402);
    await env.api('PATCH', `/api/admin/workspaces/${ws.id}`, { billing_mode: 'meta_direct' });
  });

  it('schedules broadcasts for later', async () => {
    const at = new Date(Date.now() + 3600_000).toISOString();
    const created = await env.api('POST', '/api/broadcasts', {
      name: 'Mañana',
      template_name: 'seguimiento',
      template_language: 'es_MX',
      params: { body: ['{nombre}'] },
      audience: { tag_ids: [tags[0].id] },
      scheduled_at: at,
    });
    const launched = await env.api('POST', `/api/broadcasts/${created.body.broadcast.id}/launch`);
    expect(launched.body.broadcast.status).toBe('scheduled');
    const cancel = await env.api('POST', `/api/broadcasts/${created.body.broadcast.id}/cancel`);
    expect(cancel.body.broadcast.status).toBe('cancelled');
  });
});
