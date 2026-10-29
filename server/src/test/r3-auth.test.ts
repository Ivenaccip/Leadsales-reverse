import dgram from 'node:dgram';
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { encryptJson, hmacSha256Hex, randomToken, sha256Hex } from '../lib/crypto.js';
import { publicOnlyLookup, webhookResolver } from '../lib/net.js';
import { fakeFetch, setup, sleep, type TestEnv } from './helpers.js';

// Meta accounts: which phone numbers each token controls per WABA.
const ACCOUNTS: Record<string, Record<string, string[]>> = {
  'EAAG-victim-token-xxxxxxxxxxxxxxxx': { '3100000000001': ['4100000000001', '4100000000002'] },
};

const meta = fakeFetch([
  (c) => {
    const token = (c.headers.authorization ?? '').replace('Bearer ', '');
    const wabas = ACCOUNTS[token];
    if (!wabas) return { status: 401, json: { error: { message: 'Invalid OAuth access token', code: 190 } } };
    const phones = Object.values(wabas).flat();
    const m = /\/v[\d.]+\/(\d+)(\/[a-z_]+)?/.exec(c.url);
    if (!m) return undefined;
    const [, id, sub] = m;
    if (!sub && c.url.includes('?fields=') && phones.includes(id)) return { json: { id, display_phone_number: `+${id}` } };
    if (sub === '/phone_numbers' && wabas[id]) return { json: { data: wabas[id].map((p) => ({ id: p })) } };
    if (sub === '/subscribed_apps' && wabas[id]) return { json: { success: true } };
    if (sub === '/message_templates' && wabas[id]) return { json: { data: [] } };
    return { status: 400, json: { error: { message: 'Unsupported request', code: 100 } } };
  },
]);

let env: TestEnv;
let base: string;
let op: { cookie: string; userId: string; workspaceId: string };
let owner: { cookie: string; userId: string; workspaceId: string };
const sockets: Socket[] = [];
let ipSeq = 0;
const nextIp = () => `198.18.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

async function login(email: string, password: string, ip = nextIp(), cookie?: string) {
  const r = await env.built.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
    remoteAddress: ip,
    headers: cookie ? { cookie } : {},
  });
  const c = r.cookies.find((x) => x.name === 'll_token');
  const d = r.cookies.find((x) => x.name === 'll_device');
  return { status: r.statusCode, body: JSON.parse(r.body), cookie: c ? `ll_token=${c.value}` : '', device: d ? `ll_device=${d.value}` : '' };
}

/** An account created by the instance operator (no invitation step). */
async function member(ws: string, email: string, role: 'admin' | 'agent' = 'agent', password = 'clave123456') {
  const r = await env.api('POST', '/api/workspace/members', { email, name: 'Persona', password, role }, { cookie: op.cookie, ws });
  expect(r.body.id).toBeTruthy();
  return r.body.id as string;
}

function socketFor(cookie: string) {
  const s = connect(base, { path: '/socket.io', extraHeaders: { cookie }, transports: ['websocket'], reconnection: false });
  sockets.push(s);
  const events: { event: string; data: any }[] = [];
  s.onAny((event, data) => events.push({ event, data }));
  return { s, events };
}

async function connected(cookie: string) {
  const rt = socketFor(cookie);
  await new Promise<void>((resolve, reject) => {
    rt.s.on('connect_error', reject);
    rt.s.on('connect', () => resolve());
  });
  return rt;
}

const joinAck = (s: Socket, ws: string) => new Promise<boolean>((r) => s.emit('join', ws, (a: { ok: boolean }) => r(a.ok)));

async function cloudChannel(ws: string, phone: string, waba: string, secret: string, opts: { verified?: boolean; token?: string } = {}) {
  const { rows } = await env.built.ctx.db.query(
    `INSERT INTO channels (workspace_id, provider, name, phone_number_id, waba_id, credentials, verify_token, operator_verified)
     VALUES ($1, 'cloud_api', 'Oficial', $2, $3, $4, $5, $6) RETURNING *`,
    [ws, phone, waba, encryptJson(env.config.encryptionKey, { accessToken: opts.token ?? 'EAAG-unknown-token-xxxxxxxx', appSecret: secret }), randomToken(8), !!opts.verified],
  );
  return rows[0];
}

function postSigned(raw: string, secret: string) {
  return env.built.app.inject({
    method: 'POST',
    url: '/webhooks/whatsapp',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${hmacSha256Hex(secret, raw)}` },
    payload: raw,
  });
}

const textChange = (phone: string, from: string, id: string, text = 'hola') => ({
  field: 'messages',
  value: {
    messaging_product: 'whatsapp',
    metadata: { phone_number_id: phone },
    contacts: [{ wa_id: from, profile: { name: 'Cliente' } }],
    messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
  },
});

async function queuedWebhooks(since: number) {
  const { rows } = await env.built.ctx.db.query<{ id: number; workspace_id: string | null; payload: any }>(
    `SELECT id, workspace_id, payload FROM jobs WHERE type = 'wa.webhook' AND id > $1 ORDER BY id`,
    [since],
  );
  return rows;
}

async function lastJobId() {
  const { rows } = await env.built.ctx.db.query<{ n: number }>(`SELECT COALESCE(max(id), 0)::int AS n FROM jobs`);
  return rows[0].n;
}

/** Runs `hook` once, right after the first query whose SQL matches, before its result is returned. */
function interceptQuery(match: (sql: string) => boolean, hook: () => Promise<void>, when: 'before' | 'after' = 'after') {
  const db = env.built.ctx.db as any;
  const original = db.query;
  let armed = true;
  db.query = async (sql: string, params?: unknown[]) => {
    if (!armed || !match(sql)) return original.call(db, sql, params);
    armed = false;
    if (when === 'before') await hook();
    const result = await original.call(db, sql, params);
    if (when === 'after') await hook();
    return result;
  };
  return () => {
    db.query = original;
  };
}

beforeAll(async () => {
  env = await setup({ fetch: meta.fetch });
  op = await env.register('op@r3.com', 'Operador'); // first account: instance superadmin
  owner = await env.register('owner@r3.com', 'Negocio R3');
  await env.built.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(env.built.app.server.address() as { port: number }).port}`;
});
afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await env.close();
});

describe('WABA squatting through a sandbox channel (r3 #1)', () => {
  it('a sandbox refuses Meta credentials and never blocks the real WABA', async () => {
    const mallory = await env.register('mallory@r3.com', 'Mallory');
    const sandbox = (await env.api('POST', '/api/channels', { provider: 'sandbox' }, mallory)).body.channel;
    for (const body of [{ waba_id: '3100000000001' }, { access_token: 'EAAG-anything-xxxxxxxxxxxxxx' }, { app_secret: 'any-secret-1234567890' }]) {
      const r = await env.api('PATCH', `/api/channels/${sandbox.id}`, body, mallory);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('SANDBOX_NO_CREDENTIALS');
    }
    // a sandbox row that already carries the WABA (written by an older version) does not count
    await env.built.ctx.db.query(`UPDATE channels SET waba_id = '3100000000001' WHERE id = $1`, [sandbox.id]);
    const victim = await env.register('victim@r3.com', 'Victima');
    const r = await env.api('POST', '/api/channels', {
      provider: 'cloud_api',
      phone_number_id: '4100000000001',
      waba_id: '3100000000001',
      access_token: 'EAAG-victim-token-xxxxxxxxxxxxxxxx',
      app_secret: 'victim-secret-1234567890',
    }, victim);
    expect(r.status).toBe(200);
    // and the WABA stays one workspace's: another official number elsewhere is still refused
    const other = await env.api('POST', '/api/channels', {
      provider: 'cloud_api',
      phone_number_id: '4100000000002',
      waba_id: '3100000000001',
      access_token: 'EAAG-victim-token-xxxxxxxxxxxxxxxx',
      app_secret: 'victim-secret-1234567890',
    }, mallory);
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('WABA_TAKEN');
  });
});

describe('socket join racing an eviction (r3 #5)', () => {
  it('a join that read the rights before a removal does not put the socket back in the room', async () => {
    // the agent owns another workspace, so removing them here keeps their session alive
    const agent = await env.register('agente-race@r3.com', 'Propio');
    const inv = await env.api('POST', '/api/workspace/members', { email: 'agente-race@r3.com', role: 'agent' }, owner);
    const token = inv.body.invite_url.split('/').pop();
    expect((await env.api('POST', `/api/invitations/${token}/accept`, undefined, { cookie: agent.cookie, ws: null })).status).toBe(200);
    const rt = await connected(agent.cookie);

    // the join reads the membership; the owner removes the agent (commit + evict) before the join resumes
    const restore = interceptQuery(
      (sql) => sql.includes('LEFT JOIN memberships m ON m.workspace_id = w.id'),
      async () => {
        expect((await env.api('DELETE', `/api/workspace/members/${agent.userId}`, undefined, owner)).status).toBe(204);
      },
    );
    try {
      expect(await joinAck(rt.s, owner.workspaceId)).toBe(false);
    } finally {
      restore();
    }
    expect(rt.s.connected).toBe(true);
    env.built.ctx.realtime.emit(owner.workspaceId, 'message:new', { id: 'm-secreto', contact_id: null, body: 'Mi tarjeta es 4111 1111 1111 1111' });
    await sleep(150);
    expect(rt.events.filter((e) => e.event === 'message:new')).toEqual([]);
  });

  it('a join racing a switch to "assigned" visibility gets the restricted rooms', async () => {
    const agentId = await member(owner.workspaceId, 'vis-race@r3.com');
    const s = await login('vis-race@r3.com', 'clave123456');
    const rt = await connected(s.cookie);
    const restore = interceptQuery(
      (sql) => sql.includes('LEFT JOIN memberships m ON m.workspace_id = w.id'),
      async () => {
        expect((await env.api('PUT', '/api/workspace/settings', { agent_visibility: 'assigned' }, owner)).status).toBe(200);
      },
    );
    try {
      expect(await joinAck(rt.s, owner.workspaceId)).toBe(true);
    } finally {
      restore();
    }
    const rooms = env.built.ctx.realtime.io!.sockets.adapter.rooms;
    const sid = [...(rooms.get(`user:${agentId}`) ?? [])][0];
    expect(rooms.get(`ws:${owner.workspaceId}`)?.has(sid)).toBeFalsy();
    expect(rooms.get(`ws:${owner.workspaceId}:restricted`)?.has(sid)).toBe(true);
    await env.api('PUT', '/api/workspace/settings', { agent_visibility: 'all' }, owner);
  });

  it("evictions in another tenant's workspace never make a join retry or fail", async () => {
    const attacker = await env.register('evictor@r3.com', 'Evictor');
    const victim = await env.register('evicted@r3.com', 'Evicted');
    const rt = await connected(victim.cookie);
    const db = env.built.ctx.db as any;
    const original = db.query;
    let reads = 0;
    let visibility = 'assigned';
    // every read of the victim's rights races an eviction in the attacker's own workspace
    db.query = async (sql: string, params?: unknown[]) => {
      const result = await original.call(db, sql, params);
      if (sql.includes('LEFT JOIN memberships m ON m.workspace_id = w.id') && params?.[0] === victim.workspaceId) {
        reads++;
        expect((await env.api('PUT', '/api/workspace/settings', { agent_visibility: visibility }, attacker)).status).toBe(200);
        expect((await env.api('PATCH', `/api/workspace/members/${attacker.userId}`, { role: 'owner' }, attacker)).status).toBe(200);
        visibility = visibility === 'assigned' ? 'all' : 'assigned';
      }
      return result;
    };
    try {
      expect(await joinAck(rt.s, victim.workspaceId)).toBe(true);
    } finally {
      db.query = original;
    }
    expect(reads).toBe(1);
    // counters exist only while a join watches them
    expect((env.built.ctx.realtime as any).evictions.size).toBe(0);
  });
});

describe('inbound webhooks split per workspace (r3 #7, #28)', () => {
  let a: { cookie: string; userId: string; workspaceId: string };
  let b: { cookie: string; userId: string; workspaceId: string };
  let chA: any;
  let chB: any;

  beforeAll(async () => {
    a = await env.register('wa-a@r3.com', 'Tenant A');
    b = await env.register('wa-b@r3.com', 'Tenant B');
    chA = await cloudChannel(a.workspaceId, '5100000000001', '6100000000001', 'secret-a-1234567890');
    chB = await cloudChannel(b.workspaceId, '5100000000002', '6100000000002', 'secret-b-1234567890');
  });

  it('enqueues one job per workspace, owned by it, with only its own events', async () => {
    env.built.ctx.config.metaAppSecret = 'global-app-secret-123';
    try {
      const since = await lastJobId();
      const raw = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          { id: '6100000000001', changes: [textChange('5100000000001', '5215511110001', 'wamid.SPLIT.A')] },
          { id: '6100000000002', changes: [textChange('5100000000002', '5215511110002', 'wamid.SPLIT.B')] },
        ],
      });
      expect((await postSigned(raw, 'global-app-secret-123')).statusCode).toBe(200);
      const jobs = await queuedWebhooks(since);
      expect(jobs.map((j) => j.workspace_id).sort()).toEqual([a.workspaceId, b.workspaceId].sort());
      const forA = jobs.find((j) => j.workspace_id === a.workspaceId)!.payload;
      expect(forA.channelIds).toEqual([chA.id]);
      expect(forA.trustedChannelIds).toEqual([chA.id]);
      expect(JSON.stringify(forA.body)).toContain('wamid.SPLIT.A');
      expect(JSON.stringify(forA.body)).not.toContain('wamid.SPLIT.B');
      await env.drain();
      const stored = await env.built.ctx.db.query<{ workspace_id: string }>(`SELECT workspace_id FROM messages WHERE wamid IN ('wamid.SPLIT.A', 'wamid.SPLIT.B') ORDER BY wamid`);
      expect(stored.rows.map((r) => r.workspace_id)).toEqual([a.workspaceId, b.workspaceId]);
    } finally {
      env.built.ctx.config.metaAppSecret = null;
    }
  });

  it('refuses oversized payloads and payloads with too many events', async () => {
    const statuses = Array.from({ length: 1001 }, (_, i) => ({ id: `wamid.X${i}`, status: 'delivered', timestamp: '1700000000', recipient_id: '5215500000000' }));
    const many = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: '6100000000001', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '5100000000001' }, statuses } }] }],
    });
    const since = await lastJobId();
    const r = await postSigned(many, 'secret-a-1234567890');
    expect(r.statusCode).toBe(413);
    const huge = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: '6100000000001', changes: [textChange('5100000000001', '5215511110003', 'wamid.HUGE', 'x'.repeat(3.5 * 1024 * 1024))] }],
    });
    expect((await postSigned(huge, 'secret-a-1234567890')).statusCode).toBe(413);
    expect(await queuedWebhooks(since)).toEqual([]);
  });

  it('only a secret the business cannot know vouches for billing events', async () => {
    const since = await lastJobId();
    // signed with the secret the tenant typed: routed, but not trusted with prepaid money
    expect((await postSigned(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '6100000000002', changes: [textChange('5100000000002', '5215511110004', 'wamid.TR.1')] }] }), 'secret-b-1234567890')).statusCode).toBe(200);
    // an operator-verified number
    await env.built.ctx.db.query(`UPDATE channels SET operator_verified = true WHERE id = $1`, [chB.id]);
    expect((await postSigned(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '6100000000002', changes: [textChange('5100000000002', '5215511110004', 'wamid.TR.2')] }] }), 'secret-b-1234567890')).statusCode).toBe(200);
    // the business re-keys it after leaving prepaid: its own secret is no longer the operator's
    const rekey = await env.api('PATCH', `/api/channels/${chB.id}`, { app_secret: 'tenant-chosen-secret-999999' }, b);
    expect(rekey.status).toBe(200);
    expect(rekey.body.channel.operator_verified).toBe(false);
    expect((await postSigned(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '6100000000002', changes: [textChange('5100000000002', '5215511110004', 'wamid.TR.3')] }] }), 'tenant-chosen-secret-999999')).statusCode).toBe(200);
    const jobs = await queuedWebhooks(since);
    expect(jobs.map((j) => [j.payload.channelIds, j.payload.trustedChannelIds])).toEqual([
      [[chB.id], []],
      [[chB.id], [chB.id]],
      [[chB.id], []],
    ]);
    await env.drain();
  });
});

describe('current-password guessing on PATCH /api/auth/me (r3 #11)', () => {
  it('is limited per session, even for the right password once the limit is hit', async () => {
    await member(owner.workspaceId, 'guess@r3.com', 'agent', 'correcta123');
    const s = await login('guess@r3.com', 'correcta123');
    const me = { cookie: s.cookie, ws: null };
    for (let i = 0; i < 10; i++) {
      expect((await env.api('PATCH', '/api/auth/me', { currentPassword: `mala-${i}`, password: 'robada12345' }, me)).status).toBe(400);
    }
    const r = await env.api('PATCH', '/api/auth/me', { currentPassword: 'correcta123', password: 'robada12345' }, me);
    expect(r.status).toBe(429);
    expect((await login('guess@r3.com', 'correcta123')).status).toBe(200);
    expect((await login('guess@r3.com', 'robada12345')).status).toBe(401);
  });

  it("a stolen session's guesses do not keep the owner from changing her password and ending it", async () => {
    await member(owner.workspaceId, 'robada@r3.com', 'agent', 'correcta123');
    const mine = { cookie: (await login('robada@r3.com', 'correcta123')).cookie, ws: null };
    const stolen = { cookie: (await login('robada@r3.com', 'correcta123')).cookie, ws: null };
    for (let i = 0; i < 10; i++) {
      expect((await env.api('PATCH', '/api/auth/me', { currentPassword: `mala-${i}`, password: 'cualquiera123' }, stolen)).status).toBe(400);
    }
    expect((await env.api('PATCH', '/api/auth/me', { currentPassword: 'correcta123', password: 'cualquiera123' }, stolen)).status).toBe(429);
    const change = await env.api('PATCH', '/api/auth/me', { currentPassword: 'correcta123', password: 'nueva-segura-123' }, mine);
    expect(change.status).toBe(200);
    expect((await env.api('GET', '/api/auth/me', undefined, stolen)).status).toBe(401);
    expect((await env.api('GET', '/api/auth/me', undefined, mine)).status).toBe(200);
  });
});

describe('stale invitations (r3 #12)', () => {
  async function pendingInvite(ws: string, email: string, role: 'admin' | 'agent') {
    const token = randomToken(32);
    await env.built.ctx.db.query(
      `INSERT INTO invitations (workspace_id, email, role, token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '7 days')`,
      [ws, email, role, sha256Hex(token)],
    );
    return token;
  }
  const roleOf = async (ws: string, userId: string) =>
    (await env.built.ctx.db.query(`SELECT role, is_active FROM memberships WHERE workspace_id = $1 AND user_id = $2`, [ws, userId])).rows[0];

  it('creating the member directly revokes the pending link', async () => {
    const inv = await env.api('POST', '/api/workspace/members', { email: 'ana@r3.com', role: 'admin' }, owner);
    const token = inv.body.invite_url.split('/').pop();
    await member(owner.workspaceId, 'ana@r3.com', 'agent');
    expect((await env.api('GET', `/api/invitations/${token}`, undefined, { cookie: '', ws: null })).status).toBe(404);
  });

  it('an old link neither reactivates a deactivated member nor changes their role', async () => {
    const id = await member(owner.workspaceId, 'beto@r3.com', 'agent');
    const token = await pendingInvite(owner.workspaceId, 'beto@r3.com', 'admin');
    expect((await env.api('PATCH', `/api/workspace/members/${id}`, { is_active: false }, owner)).status).toBe(200);
    // deactivating revoked the pending link
    expect((await env.api('GET', `/api/invitations/${token}`, undefined, { cookie: '', ws: null })).status).toBe(404);
    // a link that slipped through anyway cannot undo it
    const late = await pendingInvite(owner.workspaceId, 'beto@r3.com', 'admin');
    const s = await login('beto@r3.com', 'clave123456');
    const r = await env.api('POST', `/api/invitations/${late}/accept`, undefined, { cookie: s.cookie, ws: null });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('MEMBER_DEACTIVATED');
    expect(await roleOf(owner.workspaceId, id)).toEqual({ role: 'agent', is_active: false });
  });

  it('accepting while already a member keeps the role and uses up every pending link', async () => {
    const id = await member(owner.workspaceId, 'caro@r3.com', 'agent');
    const first = await pendingInvite(owner.workspaceId, 'caro@r3.com', 'admin');
    const second = await pendingInvite(owner.workspaceId, 'caro@r3.com', 'admin');
    const s = await login('caro@r3.com', 'clave123456');
    expect((await env.api('POST', `/api/invitations/${first}/accept`, undefined, { cookie: s.cookie, ws: null })).status).toBe(200);
    expect(await roleOf(owner.workspaceId, id)).toEqual({ role: 'agent', is_active: true });
    expect((await env.api('GET', `/api/invitations/${second}`, undefined, { cookie: '', ws: null })).status).toBe(404);
  });

  it('demoting or removing a member revokes their pending links', async () => {
    const id = await member(owner.workspaceId, 'dani@r3.com', 'admin');
    const t1 = await pendingInvite(owner.workspaceId, 'dani@r3.com', 'admin');
    expect((await env.api('PATCH', `/api/workspace/members/${id}`, { role: 'agent' }, owner)).status).toBe(200);
    expect((await env.api('GET', `/api/invitations/${t1}`, undefined, { cookie: '', ws: null })).status).toBe(404);
    const t2 = await pendingInvite(owner.workspaceId, 'dani@r3.com', 'admin');
    expect((await env.api('DELETE', `/api/workspace/members/${id}`, undefined, owner)).status).toBe(204);
    expect((await env.api('GET', `/api/invitations/${t2}`, undefined, { cookie: '', ws: null })).status).toBe(404);
  });
});

describe('tenant webhook hosts are resolved off the thread pool (r3 #15)', () => {
  // A tiny DNS server: answers A queries for *.r3.test from `answers`, never answers *.blackhole.test.
  let server: dgram.Socket;
  let original: string[];
  const answers: Record<string, string> = { 'private.r3.test': '10.1.2.3', 'public.r3.test': '93.184.216.34' };

  beforeAll(async () => {
    server = dgram.createSocket('udp4');
    server.on('message', (msg, rinfo) => {
      let i = 12;
      const labels: string[] = [];
      while (msg[i]) {
        labels.push(msg.subarray(i + 1, i + 1 + msg[i]).toString());
        i += msg[i] + 1;
      }
      const name = labels.join('.').toLowerCase();
      const qtype = msg.readUInt16BE(i + 1);
      if (name.endsWith('blackhole.test')) return;
      const question = msg.subarray(12, i + 5);
      const ip = qtype === 1 ? answers[name] : undefined;
      const header = Buffer.alloc(12);
      msg.copy(header, 0, 0, 2);
      header.writeUInt16BE(ip || name in answers ? 0x8180 : 0x8183, 2);
      header.writeUInt16BE(1, 4);
      header.writeUInt16BE(ip ? 1 : 0, 6);
      const answer = ip ? Buffer.concat([Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4]), Buffer.from(ip.split('.').map(Number))]) : Buffer.alloc(0);
      server.send(Buffer.concat([header, question, answer]), rinfo.port, rinfo.address);
    });
    await new Promise<void>((r) => server.bind(0, '127.0.0.1', () => r()));
    original = webhookResolver.getServers();
    webhookResolver.setServers([`127.0.0.1:${server.address().port}`]);
  });
  afterAll(() => {
    webhookResolver.setServers(original);
    server.close();
  });

  const lookup = (host: string, opts: object = {}) =>
    new Promise<{ err: any; address?: any; family?: number }>((resolve) => publicOnlyLookup(host, opts, (err, address, family) => resolve({ err, address, family })));

  it('never uses dns.lookup, gives up quickly on a dead nameserver and still blocks private answers', async () => {
    const spy = vi.spyOn(dns, 'lookup');
    try {
      const t = performance.now();
      const dead = await lookup('hook.blackhole.test');
      expect(dead.err?.code).toMatch(/ETIMEOUT|ECONNREFUSED|ESERVFAIL/);
      expect(performance.now() - t).toBeLessThan(6000);
      expect((await lookup('private.r3.test')).err?.code).toBe('EPRIVATE');
      expect(await lookup('public.r3.test')).toMatchObject({ err: null, address: '93.184.216.34', family: 4 });
      expect((await lookup('public.r3.test', { all: true })).address).toEqual([{ address: '93.184.216.34', family: 4 }]);
      expect((await lookup('localhost')).err?.code).toBe('EPRIVATE');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('re-enabling numbers disabled by prepaid billing (r3 #18)', () => {
  it('switching back to paying Meta directly re-enables them, and a failed test keeps the reason', async () => {
    const biz = await env.register('vuelta@r3.com', 'De vuelta');
    const ch = await cloudChannel(biz.workspaceId, '5100000000009', '6100000000009', 'biz-secret-1234567890', { token: 'EAAG-revoked-token-xxxxxxxx' });
    expect((await env.api('PATCH', `/api/admin/workspaces/${biz.workspaceId}`, { billing_mode: 'prepaid' }, op)).status).toBe(200);
    // the business tests the disabled number: Meta refuses the token, the disable reason stays
    expect((await env.api('POST', `/api/channels/${ch.id}/test`, undefined, biz)).body.ok).toBe(false);
    let row = (await env.built.ctx.db.query(`SELECT status, last_error FROM channels WHERE id = $1`, [ch.id])).rows[0];
    expect(row.status).toBe('disabled');
    expect(row.last_error).toMatch(/prepagados/);
    expect((await env.api('PATCH', `/api/admin/workspaces/${biz.workspaceId}`, { billing_mode: 'meta_direct' }, op)).status).toBe(200);
    row = (await env.built.ctx.db.query(`SELECT status, last_error FROM channels WHERE id = $1`, [ch.id])).rows[0];
    expect(row).toEqual({ status: 'active', last_error: null });
    // a number the business disabled itself stays as it was
    await env.api('PATCH', `/api/channels/${ch.id}`, { status: 'disabled' }, biz);
    await env.api('PATCH', `/api/admin/workspaces/${biz.workspaceId}`, { billing_mode: 'meta_direct' }, op);
    expect((await env.built.ctx.db.query(`SELECT status FROM channels WHERE id = $1`, [ch.id])).rows[0].status).toBe('disabled');
  });
});

describe('device cookies against account lockout (r3 #24)', () => {
  it('the owner logs in from a new address with a known browser while attackers fill the account bucket', async () => {
    await member(owner.workspaceId, 'viajera@r3.com', 'admin', 'viajera12345');
    const home = await login('viajera@r3.com', 'viajera12345', '201.150.10.20');
    expect(home.status).toBe(200);
    expect(home.device).toMatch(/^ll_device=/);
    for (let ip = 1; ip <= 3; ip++) for (let i = 0; i < 10; i++) await login('viajera@r3.com', 'mala', `45.1.1.${ip}`);
    // her address changed and she has no device cookie: locked out (that is what the cookie fixes)
    expect((await login('viajera@r3.com', 'viajera12345', '201.150.77.88')).status).toBe(429);
    // same browser, new address
    const away = await login('viajera@r3.com', 'viajera12345', '201.150.77.89', home.device);
    expect(away.status).toBe(200);
    // still checked: a wrong password with the cookie is a 401, and the cookie has its own limit
    for (let i = 0; i < 10; i++) expect((await login('viajera@r3.com', 'mala', `201.150.${80 + i}.1`, away.device)).status).toBe(401);
    expect((await login('viajera@r3.com', 'viajera12345', '201.150.99.1', away.device)).status).toBe(429);
  });

  it('a device cookie is per account and dies with a password change', async () => {
    await member(owner.workspaceId, 'cambio@r3.com', 'admin', 'cambio12345');
    const s = await login('cambio@r3.com', 'cambio12345', '201.151.0.1');
    for (let ip = 1; ip <= 3; ip++) for (let i = 0; i < 10; i++) await login('cambio@r3.com', 'mala', `45.2.1.${ip}`);
    // another account's cookie does not help
    const other = await login('owner@r3.com', 'secreto123', '201.151.0.2');
    expect((await login('cambio@r3.com', 'cambio12345', '201.151.0.3', other.device)).status).toBe(429);
    // tampering breaks the signature
    const forged = s.device.replace(/\.(\d+)\./, (_, v) => `.${Number(v) + 1}.`);
    expect((await login('cambio@r3.com', 'cambio12345', '201.151.0.4', forged)).status).toBe(429);
    const changed = await env.built.app.inject({
      method: 'PATCH',
      url: '/api/auth/me',
      payload: { currentPassword: 'cambio12345', password: 'cambio-nueva-123' },
      headers: { cookie: s.cookie },
    });
    expect(changed.statusCode).toBe(200);
    expect((await login('cambio@r3.com', 'cambio-nueva-123', '201.151.0.5', s.device)).status).toBe(429);
    // the browser that changed it got a fresh entry
    const fresh = `ll_device=${changed.cookies.find((c) => c.name === 'll_device')!.value}`;
    expect((await login('cambio@r3.com', 'cambio-nueva-123', '201.151.0.6', fresh)).status).toBe(200);
  });
});

describe('device cookie and registering through an invitation (r3 #24)', () => {
  it("does not drop the device entries of the other accounts in the browser", async () => {
    await member(owner.workspaceId, 'ana.casa@r3.com', 'agent', 'ana-clave-123');
    const first = await login('ana.casa@r3.com', 'ana-clave-123', '201.152.10.20');
    expect(first.status).toBe(200);
    const inv = await env.api('POST', '/api/workspace/members', { email: 'ana.trabajo@r3.com', role: 'agent' }, owner);
    const token = inv.body.invite_url.split('/').pop();
    // the browser does not send the Path=/api/auth cookie to /api/invitations/...
    const reg = await env.built.app.inject({
      method: 'POST',
      url: `/api/invitations/${token}/register`,
      payload: { name: 'Ana', password: 'otra-clave-123' },
      remoteAddress: '201.152.10.20',
    });
    expect(reg.statusCode).toBe(200);
    expect(reg.cookies.find((c) => c.name === 'll_token')).toBeTruthy();
    expect(reg.cookies.find((c) => c.name === 'll_device')).toBeUndefined();
    for (let ip = 1; ip <= 3; ip++) for (let i = 0; i < 10; i++) await login('ana.casa@r3.com', 'mala', `45.3.1.${ip}`);
    // her first account still logs in from a new address with the browser's cookie
    expect((await login('ana.casa@r3.com', 'ana-clave-123', '201.152.77.88', first.device)).status).toBe(200);
  });
});

describe('accounts created through an invitation by someone else (r3 #25)', () => {
  it('the operator can delete a squatted account outside every workspace, so the real person can register', async () => {
    const b = await env.register('tienda-b@r3.com', 'Tienda B');
    env.built.ctx.config.allowSignup = false;
    try {
      const inv = await env.api('POST', '/api/workspace/members', { email: 'ana@tienda-b.com', role: 'agent' }, owner);
      const token = inv.body.invite_url.split('/').pop();
      const squat = await env.api('POST', `/api/invitations/${token}/register`, { name: 'Ana', password: 'elegida-por-mallory' }, { cookie: '', ws: null });
      expect(squat.status).toBe(200);
      const squatId = squat.body.user.id;
      // still a member somewhere: the operator removes it from its workspaces first
      expect((await env.api('DELETE', `/api/admin/users/${squatId}`, undefined, op)).body.error.code).toBe('USER_HAS_WORKSPACES');
      expect((await env.api('DELETE', `/api/workspace/members/${squatId}`, undefined, owner)).status).toBe(204);
      expect((await env.api('DELETE', `/api/admin/users/${squatId}`, undefined, op)).status).toBe(204);
      expect((await login('ana@tienda-b.com', 'elegida-por-mallory')).status).toBe(401);
      // the real Ana, invited by another business, creates her account
      const invB = await env.api('POST', '/api/workspace/members', { email: 'ana@tienda-b.com', role: 'agent' }, b);
      const real = await env.api('POST', `/api/invitations/${invB.body.invite_url.split('/').pop()}/register`, { name: 'Ana', password: 'la-de-ana-123' }, { cookie: '', ws: null });
      expect(real.status).toBe(200);
      // only the operator, and never over an operator account
      expect((await env.api('DELETE', `/api/admin/users/${real.body.user.id}`, undefined, owner)).status).toBe(403);
      expect((await env.api('DELETE', `/api/admin/users/${op.userId}`, undefined, op)).status).toBe(400);
    } finally {
      env.built.ctx.config.allowSignup = true;
    }
  });

  it('the operator can set a temporary password, which ends every session of the account', async () => {
    await member(owner.workspaceId, 'olvido@r3.com', 'agent', 'antigua12345');
    const s = await login('olvido@r3.com', 'antigua12345');
    const rt = await connected(s.cookie);
    const id = (await env.api('GET', '/api/auth/me', undefined, { cookie: s.cookie, ws: null })).body.user.id;
    expect((await env.api('POST', `/api/admin/users/${id}/password`, { password: 'temporal12345' }, owner)).status).toBe(403);
    expect((await env.api('POST', `/api/admin/users/${id}/password`, { password: 'temporal12345', currentPassword: 'secreto123' }, op)).status).toBe(200);
    await sleep(150);
    expect(rt.s.connected).toBe(false);
    expect((await env.api('GET', '/api/auth/me', undefined, { cookie: s.cookie, ws: null })).status).toBe(401);
    expect((await login('olvido@r3.com', 'antigua12345')).status).toBe(401);
    expect((await login('olvido@r3.com', 'temporal12345')).status).toBe(200);
    expect((await env.api('POST', `/api/admin/users/${op.userId}/password`, { password: 'temporal12345', currentPassword: 'secreto123' }, op)).status).toBe(400);
  });
});

describe('password changes racing a login (r3 #29)', () => {
  it('a login that verified the old password while it changed gets a dead session', async () => {
    await member(owner.workspaceId, 'carrera@r3.com', 'agent', 'vieja123456');
    const mine = await login('carrera@r3.com', 'vieja123456');
    // the attacker's login has checked the old password; the owner's change commits before its session row
    const restore = interceptQuery(
      (sql) => sql.startsWith('INSERT INTO sessions'),
      async () => {
        const r = await env.api('PATCH', '/api/auth/me', { currentPassword: 'vieja123456', password: 'nueva1234567' }, { cookie: mine.cookie, ws: null });
        expect(r.status).toBe(200);
      },
      'before',
    );
    let attacker;
    try {
      attacker = await login('carrera@r3.com', 'vieja123456');
    } finally {
      restore();
    }
    expect(attacker.status).toBe(200);
    expect((await env.api('GET', '/api/auth/me', undefined, { cookie: attacker.cookie, ws: null })).status).toBe(401);
    const rt = socketFor(attacker.cookie);
    expect((await new Promise<Error>((r) => rt.s.on('connect_error', r))).message).toBe('unauthorized');
    // the owner's own session survives its change
    expect((await env.api('GET', '/api/auth/me', undefined, { cookie: mine.cookie, ws: null })).status).toBe(200);
  });

  it('of two concurrent password changes only one wins', async () => {
    await member(owner.workspaceId, 'doble@r3.com', 'agent', 'doble123456');
    const s1 = await login('doble@r3.com', 'doble123456');
    const db = env.built.ctx.db as any;
    const tx = db.tx;
    // another session's change commits between this request's check and its update
    db.tx = async (fn: any) => {
      db.tx = tx;
      await env.built.ctx.db.query(`UPDATE users SET password_version = password_version + 1 WHERE email = 'doble@r3.com'`);
      return tx.call(db, fn);
    };
    try {
      const r = await env.api('PATCH', '/api/auth/me', { currentPassword: 'doble123456', password: 'perdedora123' }, { cookie: s1.cookie, ws: null });
      expect(r.status).toBe(409);
    } finally {
      db.tx = tx;
    }
    expect((await login('doble@r3.com', 'perdedora123')).status).toBe(401);
  });
});

describe('password hashing is bounded process-wide and off the event loop (r3 #30)', () => {
  it('a login flood from many networks gets fast 503s and does not stall other requests', async () => {
    let lateness = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      lateness = Math.max(lateness, now - last - 10);
      last = now;
    }, 10);
    const flood = Array.from({ length: 40 }, (_, i) =>
      env.built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `nadie${i}@flood.com`, password: 'x' }, remoteAddress: `2001:db8:77:${i.toString(16)}::1` }),
    );
    await sleep(20);
    const t = performance.now();
    const health = await env.built.app.inject({ method: 'GET', url: '/health' });
    const healthMs = performance.now() - t;
    const results = await Promise.all(flood);
    clearInterval(timer);
    expect(health.statusCode).toBe(200);
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 503).length).toBeGreaterThan(0);
    expect(codes.every((c) => c === 503 || c === 401)).toBe(true);
    expect(JSON.parse(results.find((r) => r.statusCode === 503)!.body).error.code).toBe('BUSY');
    expect(healthMs).toBeLessThan(250);
    expect(lateness).toBeLessThan(150);
  });
});

describe('docker-compose does not let clients pick their IP (r3 #50)', () => {
  it('publishes the app on loopback and runs Caddy on the host network', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('"${APP_BIND:-127.0.0.1}:${APP_PORT:-3000}:3000"');
    expect(compose).toMatch(/caddy:[\s\S]*network_mode: host/);
    expect(fs.readFileSync(path.join(root, 'deploy/Caddyfile'), 'utf8')).toMatch(/reverse_proxy 127\.0\.0\.1:/);
  });
});

describe('account existence (r3 #51)', () => {
  it('the invitation preview does not tell whether the email has an account', async () => {
    const inv = await env.api('POST', '/api/workspace/members', { email: 'op@r3.com', role: 'agent' }, owner);
    const r = await env.api('GET', `/api/invitations/${inv.body.invite_url.split('/').pop()}`, undefined, { cookie: '', ws: null });
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('account_exists');
  });

  it('a 429 does the same work for an unknown email as for a real account', async () => {
    const ip = '203.0.113.77';
    for (let i = 0; i < 50; i++) await login(`junk${i}@r3.com`, 'x', ip);
    const sessionQueries: unknown[][] = [];
    const db = env.built.ctx.db as any;
    const original = db.query;
    db.query = async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM sessions WHERE user_id')) sessionQueries.push(params ?? []);
      return original.call(db, sql, params);
    };
    try {
      expect((await login('nadie-aqui@r3.com', 'x', ip)).status).toBe(429);
      expect((await login('owner@r3.com', 'x', ip)).status).toBe(429);
    } finally {
      db.query = original;
    }
    expect(sessionQueries).toHaveLength(2);
  });
});
