import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { setup, sleep, type TestEnv } from './helpers.js';

let env: TestEnv;
let base: string;
let ws: string;
let channelId: string;
const sockets: Socket[] = [];

async function login(email: string) {
  const r = await env.built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'agente1234' } });
  return { cookie: `ll_token=${r.cookies[0].value}`, id: JSON.parse(r.body).user.id as string };
}

async function ownerCookie() {
  const r = await env.built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'rt@test.com', password: 'secreto123' } });
  return `ll_token=${r.cookies[0].value}`;
}

async function listen(cookie: string): Promise<{ events: { event: string; data: any }[] }> {
  const s = connect(base, { path: '/socket.io', extraHeaders: { cookie }, transports: ['websocket'] });
  sockets.push(s);
  const events: { event: string; data: any }[] = [];
  s.onAny((event, data) => events.push({ event, data }));
  await new Promise<void>((resolve, reject) => {
    s.on('connect_error', reject);
    s.on('connect', () => s.emit('join', ws, (r: { ok: boolean }) => (r.ok ? resolve() : reject(new Error('join refused')))));
  });
  return { events };
}

beforeAll(async () => {
  env = await setup();
  const owner = await env.register('rt@test.com', 'Tiempo real');
  ws = owner.workspaceId;
  channelId = (await env.api('POST', '/api/channels', { provider: 'sandbox', name: 'S' })).body.channel.id;
  for (const email of ['ana@rt.com', 'beto@rt.com']) {
    await env.api('POST', '/api/workspace/members', { email, name: email, password: 'agente1234', role: 'agent' });
  }
  await env.built.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = env.built.app.server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await env.close();
});

describe('realtime isolation', () => {
  it('rejects sockets without a session and joins to foreign workspaces', async () => {
    const anon = connect(base, { path: '/socket.io', transports: ['websocket'] });
    sockets.push(anon);
    const err = await new Promise<Error>((resolve) => anon.on('connect_error', resolve));
    expect(err.message).toBe('unauthorized');
    const other = await env.register('otro-rt@test.com', 'Ajeno');
    const s = connect(base, { path: '/socket.io', extraHeaders: { cookie: other.cookie }, transports: ['websocket'] });
    sockets.push(s);
    await new Promise<void>((r) => s.on('connect', () => r()));
    const ack = await new Promise<{ ok: boolean }>((r) => s.emit('join', ws, r));
    expect(ack.ok).toBe(false);
  });

  it('survives malformed cookies and non-function join acks (#18, #71)', async () => {
    for (const transports of [['websocket'], ['polling']] as const) {
      const bad = connect(base, { path: '/socket.io', extraHeaders: { cookie: 'll_token=%E0%A4%A' }, transports: [...transports], reconnection: false });
      sockets.push(bad);
      expect((await new Promise<Error>((r) => bad.on('connect_error', r))).message).toBe('unauthorized');
    }
    const owner = await ownerCookie();
    const s = connect(base, { path: '/socket.io', extraHeaders: { cookie: owner }, transports: ['websocket'] });
    sockets.push(s);
    await new Promise<void>((r) => s.on('connect', () => r()));
    s.emit('join', 'not-a-uuid', 'boom');
    s.emit('join', ws, 'boom');
    s.emit('join', ws, 42);
    await sleep(200);
    expect(await new Promise((r) => s.emit('join', ws, (a: { ok: boolean }) => r(a.ok)))).toBe(true);
    expect((await env.api('GET', '/health')).status).toBe(200);
  });

  it('sends broadcast events to owners and admins only (#55)', async () => {
    const ana = await login('ana@rt.com');
    const anaRt = await listen(ana.cookie);
    const ownerRt = await listen(await ownerCookie());
    env.built.ctx.realtime.emit(ws, 'broadcast:update', { id: 'b1', name: 'Campaña', params: { body: ['CUPON-VIP-40'] } });
    await sleep(200);
    expect(ownerRt.events.map((e) => e.event)).toContain('broadcast:update');
    expect(anaRt.events.map((e) => e.event)).not.toContain('broadcast:update');
  });

  it('tells restricted agents when a conversation they could see goes to someone else (#64)', async () => {
    await env.api('PUT', '/api/workspace/settings', { agent_visibility: 'assigned' });
    const ana = await login('ana@rt.com');
    const beto = await login('beto@rt.com');
    const anaRt = await listen(ana.cookie);
    const betoRt = await listen(beto.cookie);
    const revoked = (rt: { events: { event: string; data: any }[] }) => rt.events.filter((e) => e.event === 'contact:revoked').map((e) => e.data.id);

    const lead = (await env.api('POST', `/api/channels/${channelId}/simulate`, { from: '5215544446666', text: 'sin dueño' })).body.message.contact_id;
    await sleep(200);
    expect(betoRt.events.some((e) => e.event === 'message:new' && e.data.contact_id === lead)).toBe(true);
    await env.api('PATCH', `/api/contacts/${lead}`, { assigned_user_id: ana.id });
    await sleep(200);
    expect(revoked(betoRt)).toEqual([lead]);
    expect(revoked(anaRt)).toEqual([]);
    // later activity on it does not repeat the notice
    await env.api('POST', `/api/channels/${channelId}/simulate`, { from: '5215544446666', text: 'otra vez' });
    await sleep(200);
    expect(revoked(betoRt)).toEqual([lead]);

    // Beto's own conversation reassigned to Ana leaves his inbox too
    const mine = (await env.api('POST', `/api/channels/${channelId}/simulate`, { from: '5215544447777', text: 'para Beto' })).body.message.contact_id;
    await env.api('PATCH', `/api/contacts/${mine}`, { assigned_user_id: beto.id });
    await sleep(200);
    await env.api('PATCH', `/api/contacts/${mine}`, { assigned_user_id: ana.id });
    await sleep(200);
    expect(revoked(betoRt)).toEqual([lead, mine]);

    // restricted agents never get broadcast data either
    env.built.ctx.realtime.emit(ws, 'broadcast:update', { id: 'b2' });
    await sleep(100);
    expect(betoRt.events.map((e) => e.event)).not.toContain('broadcast:update');
    await env.api('PUT', '/api/workspace/settings', { agent_visibility: 'all' });
  });

  it('only sends conversations an agent may see when visibility is "assigned"', async () => {
    await env.api('PUT', '/api/workspace/settings', { agent_visibility: 'assigned' });
    const ana = await login('ana@rt.com');
    const beto = await login('beto@rt.com');
    const anaRt = await listen(ana.cookie);
    const betoRt = await listen(beto.cookie);
    const ownerRt = await listen(await ownerCookie());

    // conversation assigned to Ana
    const sim = await env.api('POST', `/api/channels/${channelId}/simulate`, { from: '5215511119999', text: 'hola' });
    const contactId = sim.body.message.contact_id;
    await env.api('PATCH', `/api/contacts/${contactId}`, { assigned_user_id: ana.id });
    await env.api('POST', `/api/channels/${channelId}/simulate`, { from: '5215511119999', text: 'secreto de Ana' });
    // unassigned conversation
    await env.api('POST', `/api/channels/${channelId}/simulate`, { from: '5215522228888', text: 'sin asignar' });
    await sleep(300);

    const texts = (rt: { events: { event: string; data: any }[] }) => rt.events.filter((e) => e.event === 'message:new').map((e) => e.data.body);
    expect(texts(ownerRt)).toEqual(expect.arrayContaining(['secreto de Ana', 'sin asignar']));
    expect(texts(anaRt)).toEqual(expect.arrayContaining(['secreto de Ana', 'sin asignar']));
    expect(texts(betoRt)).toContain('sin asignar');
    expect(texts(betoRt)).not.toContain('secreto de Ana');

    // Removing Beto from the team cuts his live feed immediately.
    await env.api('DELETE', `/api/workspace/members/${beto.id}`);
    await sleep(300);
    await env.api('POST', `/api/channels/${channelId}/simulate`, { from: '5215533337777', text: 'después de quitarlo' });
    await sleep(300);
    expect(texts(betoRt)).not.toContain('después de quitarlo');
    expect(texts(ownerRt)).toContain('después de quitarlo');
  });
});
