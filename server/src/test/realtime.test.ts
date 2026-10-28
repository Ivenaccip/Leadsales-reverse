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

  it('only sends conversations an agent may see when visibility is "assigned"', async () => {
    await env.api('PUT', '/api/workspace/settings', { agent_visibility: 'assigned' });
    const ana = await login('ana@rt.com');
    const beto = await login('beto@rt.com');
    const anaRt = await listen(ana.cookie);
    const betoRt = await listen(beto.cookie);
    const ownerRt = await listen((await env.built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'rt@test.com', password: 'secreto123' } })).cookies.map((c) => `ll_token=${c.value}`)[0]);

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
