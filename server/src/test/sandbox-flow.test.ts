import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type TestEnv } from './helpers.js';

let env: TestEnv;
let channelId: string;

beforeAll(async () => {
  env = await setup();
  await env.register('dueno@test.com', 'Tacos Don Pepe');
  const r = await env.api('POST', '/api/channels', { provider: 'sandbox', name: 'Pruebas' });
  expect(r.status).toBe(200);
  channelId = r.body.channel.id;
});
afterAll(() => env.close());

describe('auth & workspace bootstrap', () => {
  it('first user is superadmin with default funnel, stages and tags', async () => {
    const me = await env.api('GET', '/api/auth/me');
    expect(me.body.user.is_superadmin).toBe(true);
    expect(me.body.workspaces[0].role).toBe('owner');
    const funnels = await env.api('GET', '/api/funnels');
    expect(funnels.body.funnels).toHaveLength(1);
    expect(funnels.body.funnels[0].stages.map((s: any) => s.name)).toEqual(['Nuevo', 'Contactado', 'Interesado', 'Cotización enviada', 'Ganado', 'Perdido']);
    const tags = await env.api('GET', '/api/tags');
    expect(tags.body.tags.length).toBe(3);
  });

  it('rejects bad logins and requires auth', async () => {
    const bad = await env.api('POST', '/api/auth/login', { email: 'dueno@test.com', password: 'nope' }, { cookie: '' });
    expect(bad.status).toBe(401);
    const ok = await env.api('POST', '/api/auth/login', { email: 'dueno@test.com', password: 'secreto123' }, { cookie: '' });
    expect(ok.status).toBe(200);
    const anon = await env.api('GET', '/api/contacts', undefined, { cookie: '' });
    expect(anon.status).toBe(401);
  });

  it('syncs sandbox templates on channel creation', async () => {
    const t = await env.api('GET', '/api/templates');
    expect(t.body.templates.map((x: any) => x.name).sort()).toEqual(['bienvenida', 'hello_world', 'promo_mes', 'seguimiento']);
    const bienvenida = t.body.templates.find((x: any) => x.name === 'bienvenida');
    expect(bienvenida.inputs.body).toEqual(['1', '2']);
    expect(bienvenida.category).toBe('marketing');
  });
});

describe('conversation flow', () => {
  let contactId: string;

  it('creates a lead when a customer writes', async () => {
    const sim = await env.api('POST', `/api/channels/${channelId}/simulate`, { from: '5215511112222', name: 'Laura Gómez', text: 'Hola, ¿precios?' });
    expect(sim.status).toBe(200);
    contactId = sim.body.message.contact_id;
    const c = await env.api('GET', `/api/contacts/${contactId}`);
    expect(c.body.contact.phone).toBe('525511112222');
    expect(c.body.contact.wa_id).toBe('5215511112222');
    expect(c.body.contact.name).toBe('Laura Gómez');
    expect(c.body.contact.unread_count).toBe(1);
    expect(c.body.window_open).toBe(true);
    const funnels = await env.api('GET', '/api/funnels');
    expect(c.body.contact.stage_id).toBe(funnels.body.funnels[0].stages[0].id);
    expect(c.body.events.map((e: any) => e.type)).toContain('created');
    const events = env.built.ctx.realtime.history.map((h) => h.event);
    expect(events).toContain('contact:new');
    expect(events).toContain('message:new');
  });

  it('dedupes the same inbound wamid', async () => {
    const { processInboundMessage } = await import('../whatsapp/inbound.js');
    const ch = (await env.built.ctx.db.query(`SELECT * FROM channels WHERE id = $1`, [channelId])).rows[0];
    const msg = { from: '5215511112222', id: 'wamid.DUP', timestamp: '1700000000', type: 'text', text: { body: 'x' } };
    expect(await processInboundMessage(env.built.ctx, ch, msg)).not.toBeNull();
    expect(await processInboundMessage(env.built.ctx, ch, msg)).toBeNull();
  });

  it('replies inside the 24h window for free and receives statuses', async () => {
    const r = await env.api('POST', `/api/contacts/${contactId}/messages`, { type: 'text', text: 'Hola Laura, con gusto 😊' });
    expect(r.status).toBe(200);
    expect(r.body.message.status).toBe('sent');
    expect(r.body.message.wamid).toMatch(/^wamid\.SANDBOX/);
    await env.drain();
    const msgs = await env.api('GET', `/api/contacts/${contactId}/messages`);
    const out = msgs.body.messages.find((m: any) => m.id === r.body.message.id);
    expect(out.status).toBe('read');
    expect(out.cost).toBe(0);
    expect(out.pricing_reconciled).toBe(true);
    const c = await env.api('GET', `/api/contacts/${contactId}`);
    expect(c.body.contact.unread_count).toBe(0);
  });

  it('adds internal notes that are never sent', async () => {
    const r = await env.api('POST', `/api/contacts/${contactId}/notes`, { text: 'Cliente pidió factura' });
    expect(r.body.message.direction).toBe('internal');
    expect(r.body.message.wamid).toBeNull();
  });

  it('charges templates by country and category (meta_direct records spend)', async () => {
    const r = await env.api('POST', `/api/contacts/${contactId}/messages`, {
      type: 'template',
      name: 'bienvenida',
      language: 'es_MX',
      params: { body: ['{primer_nombre}', 'Tacos Don Pepe'] },
    });
    expect(r.status).toBe(200);
    expect(r.body.message.body).toBe('¡Hola Laura! Gracias por tu interés en Tacos Don Pepe. ¿Te puedo ayudar con algo hoy?\n\n[Sí, por favor] [Ahora no]');
    expect(r.body.message.cost).toBeCloseTo(0.0457);
    await env.drain();
    const credits = await env.api('GET', '/api/credits');
    expect(credits.body.billing_mode).toBe('meta_direct');
    expect(credits.body.spent_this_month).toBeCloseTo(0.0457);
    expect(credits.body.balance).toBe(0);
  });

  it('blocks free text outside the 24h window but allows templates', async () => {
    const c = await env.api('POST', '/api/contacts', { phone: '573001234567', name: 'Carlos' });
    expect(c.status).toBe(200);
    const t = await env.api('POST', `/api/contacts/${c.body.contact.id}/messages`, { type: 'text', text: 'hola' });
    expect(t.status).toBe(400);
    expect(t.body.error.code).toBe('WINDOW_CLOSED');
    const tpl = await env.api('POST', `/api/contacts/${c.body.contact.id}/messages`, { type: 'template', name: 'seguimiento', language: 'es_MX', params: { body: ['Carlos'] } });
    expect(tpl.status).toBe(200);
    expect(tpl.body.message.cost).toBeCloseTo(0.0008); // Colombia utility
  });

  it('refunds when Meta reports the message as failed', async () => {
    const c = await env.api('POST', '/api/contacts', { phone: '5255990000', name: 'Sin WhatsApp' });
    const before = (await env.api('GET', '/api/credits')).body.spent_total;
    const r = await env.api('POST', `/api/contacts/${c.body.contact.id}/messages`, { type: 'template', name: 'promo_mes', language: 'es_MX', params: { header: { type: 'text', text: 'Octubre' }, body: ['Hola', '15%'] } });
    expect(r.body.message.cost).toBeCloseTo(0.0457);
    await env.drain();
    const msgs = await env.api('GET', `/api/contacts/${c.body.contact.id}/messages`);
    const m = msgs.body.messages[0];
    expect(m.status).toBe('failed');
    expect(m.error.message).toMatch(/no tiene WhatsApp/);
    expect(m.cost).toBe(0);
    const after = (await env.api('GET', '/api/credits')).body.spent_total;
    expect(after).toBeCloseTo(before);
    const ledger = await env.api('GET', '/api/credits/ledger');
    expect(ledger.body.entries[0].kind).toBe('refund');
  });
});

describe('prepaid credits mode', () => {
  it('blocks templates without balance and allows them after a top-up', async () => {
    const owner = await env.register('otro@test.com', 'Segundo negocio');
    const ws = owner.workspaceId;
    const opts = { cookie: owner.cookie, ws };
    // the instance admin switches this workspace to prepaid
    const sw = await env.api('PATCH', `/api/admin/workspaces/${ws}`, { billing_mode: 'prepaid' });
    expect(sw.status).toBe(200);
    // a non-superadmin cannot top up
    const denied = await env.api('POST', `/api/admin/workspaces/${ws}/credits`, { amount: 5 }, opts);
    expect(denied.status).toBe(403);

    const ch = await env.api('POST', '/api/channels', { provider: 'sandbox', name: 'S' }, opts);
    const c = await env.api('POST', '/api/contacts', { phone: '5255123456', name: 'Pedro' }, opts);
    const send = () =>
      env.api('POST', `/api/contacts/${c.body.contact.id}/messages`, { type: 'template', name: 'promo_mes', language: 'es_MX', params: { header: { type: 'text', text: 'x' }, body: ['a', 'b'] } }, opts);
    const r1 = await send();
    expect(r1.status).toBe(402);
    expect(r1.body.error.code).toBe('INSUFFICIENT_CREDITS');
    const msgs = await env.api('GET', `/api/contacts/${c.body.contact.id}/messages`, undefined, opts);
    expect(msgs.body.messages).toHaveLength(0);

    const top = await env.api('POST', `/api/admin/workspaces/${ws}/credits`, { amount: 1, description: 'Pago transferencia' });
    expect(top.body.balance).toBe(1);
    const r2 = await send();
    expect(r2.status).toBe(200);
    await env.drain();
    const credits = await env.api('GET', '/api/credits', undefined, opts);
    expect(credits.body.balance).toBeCloseTo(1 - 0.0457);
    expect(ch.status).toBe(200);
  });
});

describe('roles', () => {
  it('agents cannot manage channels or broadcasts', async () => {
    const add = await env.api('POST', '/api/workspace/members', { email: 'agente@test.com', name: 'Agente', password: 'agente1234', role: 'agent' });
    expect(add.status).toBe(200);
    const login = await env.built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'agente@test.com', password: 'agente1234' } });
    const cookie = `ll_token=${login.cookies[0].value}`;
    const r = await env.api('POST', '/api/channels', { provider: 'sandbox', name: 'x' }, { cookie });
    expect(r.status).toBe(403);
    const b = await env.api('GET', '/api/broadcasts', undefined, { cookie });
    expect(b.status).toBe(403);
    const contacts = await env.api('GET', '/api/contacts', undefined, { cookie });
    expect(contacts.status).toBe(200);
  });
});
