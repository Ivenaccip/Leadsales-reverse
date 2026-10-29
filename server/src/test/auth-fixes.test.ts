import jwt from 'jsonwebtoken';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hmacSha256Hex } from '../lib/crypto.js';
import { clientNet } from '../routes/auth.js';
import { RateLimiter } from '../routes/helpers.js';
import { processInboundMessage } from '../whatsapp/inbound.js';
import { fakeFetch, setup, sleep, type TestEnv } from './helpers.js';

// Meta accounts: which phone numbers each token controls per WABA.
const ACCOUNTS: Record<string, Record<string, string[]>> = {
  'EAAG-tenant-own-token-xxxxxxxxxxxx': { '2100000000001': ['1100000000001'] },
  'EAAG-operator-token-xxxxxxxxxxxxxx': {
    '2100000000001': ['1100000000001'], // the tenant's WABA, shared with the operator's app
    '2200000000002': ['1200000000021', '1200000000022', '1200000000023'],
    '2300000000003': ['1200000000023'],
    '2400000000004': ['1400000000041'],
    '2500000000005': ['1500000000051', '1500000000052'],
    '2600000000006': ['1600000000061'],
  },
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
    if (sub === '/messages' && phones.includes(id)) return { json: { messages: [{ id: `wamid.${id}.${meta.calls.length}` }] } };
    return { status: 400, json: { error: { message: 'Unsupported request', code: 100 } } };
  },
]);

let env: TestEnv;
let base: string;
let op: { cookie: string; userId: string; workspaceId: string };
let tenant: { cookie: string; userId: string; workspaceId: string };
const sockets: Socket[] = [];
let ipSeq = 0;

async function login(email: string, password: string, ip = `198.18.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`) {
  const r = await env.built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, remoteAddress: ip });
  const c = r.cookies.find((x) => x.name === 'll_token');
  return { status: r.statusCode, body: JSON.parse(r.body), cookie: c ? `ll_token=${c.value}` : '' };
}

function socketFor(cookie: string) {
  const s = connect(base, { path: '/socket.io', extraHeaders: { cookie }, transports: ['websocket'], reconnection: false });
  sockets.push(s);
  const events: { event: string; data: any }[] = [];
  s.onAny((event, data) => events.push({ event, data }));
  return { s, events };
}

async function joined(cookie: string, ws: string) {
  const rt = socketFor(cookie);
  await new Promise<void>((resolve, reject) => {
    rt.s.on('connect_error', reject);
    rt.s.on('connect', () => rt.s.emit('join', ws, (r: { ok: boolean }) => (r.ok ? resolve() : reject(new Error('join refused')))));
  });
  return rt;
}

function signed(payload: unknown, secret: string) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', ...(payload as object) });
  return env.built.app.inject({
    method: 'POST',
    url: '/webhooks/whatsapp',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${hmacSha256Hex(secret, raw)}` },
    payload: raw,
  });
}

const textFrom = (phoneNumberId: string, wabaId: string, from: string, id: string) => ({
  entry: [
    {
      id: wabaId,
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: phoneNumberId },
            contacts: [{ wa_id: from, profile: { name: 'Cliente' } }],
            messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hola' } }],
          },
        },
      ],
    },
  ],
});

beforeAll(async () => {
  env = await setup({ fetch: meta.fetch });
  op = await env.register('op@instancia.com', 'Operador'); // first account: instance superadmin
  tenant = await env.register('dueno@tenant.com', 'Tenant');
  await env.built.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(env.built.app.server.address() as { port: number }).port}`;
});
afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await env.close();
});

describe('team invitations (#1, #22)', () => {
  it('a workspace admin can neither create accounts with a password nor attach existing accounts', async () => {
    const r = await env.api('POST', '/api/workspace/members', { email: 'Juan@Victim.com', name: 'Juan', password: 'attacker-knows', role: 'admin' }, tenant);
    expect(r.status).toBe(200);
    expect(r.body.invitation).toMatchObject({ email: 'juan@victim.com', role: 'admin' });
    expect(r.body.invite_url).toMatch(/^https:\/\/crm\.test\/invitacion\/[A-Za-z0-9_-]{43}$/);
    expect((await env.built.ctx.db.query(`SELECT 1 FROM users WHERE email = 'juan@victim.com'`)).rows).toHaveLength(0);
    expect((await login('juan@victim.com', 'attacker-knows')).status).toBe(401);

    // an account owned by another business is invited, not silently added
    const other = await env.register('owner@other.com', 'Otro negocio');
    const inv = await env.api('POST', '/api/workspace/members', { email: 'owner@other.com', role: 'agent' }, tenant);
    expect(inv.body.invitation.email).toBe('owner@other.com');
    expect(inv.body.existing_user).toBeUndefined();
    const members = (await env.api('GET', '/api/workspace/members', undefined, tenant)).body.members;
    expect(members.map((m: any) => m.email)).not.toContain('owner@other.com');
    const ws = (await env.api('GET', '/api/auth/me', undefined, other)).body.workspaces;
    expect(ws.map((w: any) => w.id)).toEqual([other.workspaceId]);
  });

  it('lists, accepts, registers and revokes invitations through one-time links', async () => {
    const token = (url: string) => url.split('/').pop()!;
    const forNew = await env.api('POST', '/api/workspace/members', { email: 'nueva@tenant.com', name: 'Nueva', role: 'agent' }, tenant);
    const forOther = await env.api('POST', '/api/workspace/members', { email: 'owner@other.com', role: 'agent' }, tenant);
    const pending = (await env.api('GET', '/api/workspace/invitations', undefined, tenant)).body.invitations;
    expect(pending.map((i: any) => i.email)).toEqual(expect.arrayContaining(['nueva@tenant.com', 'owner@other.com']));
    expect(pending.find((i: any) => i.email === 'nueva@tenant.com').invited_by_name).toBe('Dueño');
    // the earlier link for owner@other.com was replaced by the new one
    expect(pending.filter((i: any) => i.email === 'owner@other.com')).toHaveLength(1);

    const info = await env.api('GET', `/api/invitations/${token(forNew.body.invite_url)}`, undefined, { cookie: '', ws: null });
    expect(info.body).toMatchObject({ workspace_name: 'Tenant', email: 'nueva@tenant.com', role: 'agent', account_exists: false });

    // a new person creates the invited account (even with sign-up closed) and is signed in
    env.built.ctx.config.allowSignup = false;
    const reg = await env.built.app.inject({
      method: 'POST',
      url: `/api/invitations/${token(forNew.body.invite_url)}/register`,
      payload: { name: 'Nueva Agente', password: 'nueva12345' },
      remoteAddress: '198.19.0.1',
    });
    env.built.ctx.config.allowSignup = true;
    expect(reg.statusCode).toBe(200);
    const regBody = JSON.parse(reg.body);
    expect(regBody.workspace_id).toBe(tenant.workspaceId);
    expect(regBody.user.email).toBe('nueva@tenant.com');
    expect(regBody.workspaces.map((w: any) => [w.id, w.role])).toEqual([[tenant.workspaceId, 'agent']]);
    // one-time
    const again = await env.api('GET', `/api/invitations/${token(forNew.body.invite_url)}`, undefined, { cookie: '', ws: null });
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe('INVITATION_INVALID');

    // an existing account must be signed in with the invited email to accept
    const t2 = token(forOther.body.invite_url);
    expect((await env.api('GET', `/api/invitations/${t2}`, undefined, { cookie: '', ws: null })).body.account_exists).toBe(true);
    const wrong = await env.api('POST', `/api/invitations/${t2}/accept`, undefined, { cookie: op.cookie, ws: null });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('INVITATION_EMAIL_MISMATCH');
    const taken = await env.api('POST', `/api/invitations/${t2}/register`, { name: 'Intruso', password: 'intruso1234' }, { cookie: '', ws: null });
    expect(taken.status).toBe(409);
    const owner = await login('owner@other.com', 'secreto123');
    const ok = await env.api('POST', `/api/invitations/${t2}/accept`, undefined, { cookie: owner.cookie, ws: null });
    expect(ok.body).toEqual({ workspace_id: tenant.workspaceId });
    const members = (await env.api('GET', '/api/workspace/members', undefined, tenant)).body.members;
    expect(members.find((m: any) => m.email === 'owner@other.com').role).toBe('agent');

    // revoked links stop working
    const third = await env.api('POST', '/api/workspace/members', { email: 'tarde@tenant.com', role: 'agent' }, tenant);
    expect((await env.api('DELETE', `/api/workspace/invitations/${third.body.invitation.id}`, undefined, tenant)).status).toBe(204);
    expect((await env.api('GET', `/api/invitations/${token(third.body.invite_url)}`, undefined, { cookie: '', ws: null })).status).toBe(404);
  });

  it('only the instance operator creates accounts directly, and never over an existing one', async () => {
    const direct = await env.api('POST', '/api/workspace/members', { email: 'directo@tenant.com', name: 'Directo', password: 'directo1234', role: 'agent' }, { cookie: op.cookie, ws: tenant.workspaceId });
    expect(direct.body.id).toBeTruthy();
    expect((await login('directo@tenant.com', 'directo1234')).status).toBe(200);
    const existing = await env.api('POST', '/api/workspace/members', { email: 'dueno@tenant.com', password: 'otraClave123', role: 'agent' }, { cookie: op.cookie, ws: op.workspaceId });
    expect(existing.body.invitation).toBeTruthy();
    expect((await login('dueno@tenant.com', 'otraClave123')).status).toBe(401);
  });
});

describe('the instance operator in tenant workspaces (#67, #73)', () => {
  it('stays owner even with a demoted or deactivated membership, which tenants cannot touch', async () => {
    await env.built.ctx.db.query(`INSERT INTO memberships (workspace_id, user_id, role, is_active) VALUES ($1, $2, 'agent', false)`, [tenant.workspaceId, op.userId]);
    const asOp = { cookie: op.cookie, ws: tenant.workspaceId };
    expect((await env.api('GET', '/api/workspace', undefined, asOp)).body.role).toBe('owner');
    expect((await env.api('GET', '/api/channels', undefined, asOp)).status).toBe(200);
    expect((await env.api('PATCH', `/api/workspace/members/${op.userId}`, { is_active: false }, tenant)).status).toBe(403);
    expect((await env.api('DELETE', `/api/workspace/members/${op.userId}`, undefined, tenant)).status).toBe(403);
    // the operator can still clean it up
    expect((await env.api('DELETE', `/api/workspace/members/${op.userId}`, undefined, asOp)).status).toBe(204);
  });
});

describe('sessions (#51)', () => {
  it('logout ends that session only; a password change ends the others and their sockets', async () => {
    await env.api('POST', '/api/workspace/members', { email: 'victima@tenant.com', name: 'Víctima', password: 'victima1234', role: 'admin' }, { cookie: op.cookie, ws: tenant.workspaceId });
    const a = await login('victima@tenant.com', 'victima1234');
    const b = await login('victima@tenant.com', 'victima1234');
    const stolen = await login('victima@tenant.com', 'victima1234');
    const asB = { cookie: b.cookie, ws: tenant.workspaceId };

    await env.api('POST', '/api/auth/logout', undefined, { cookie: a.cookie, ws: null });
    expect((await env.api('GET', '/api/auth/me', undefined, { cookie: a.cookie, ws: null })).status).toBe(401);
    expect((await env.api('GET', '/api/auth/me', undefined, asB)).status).toBe(200);
    const socketA = socketFor(a.cookie);
    expect((await new Promise<Error>((r) => socketA.s.on('connect_error', r))).message).toBe('unauthorized');

    const stolenRt = await joined(stolen.cookie, tenant.workspaceId);
    const bRt = await joined(b.cookie, tenant.workspaceId);
    const changed = await env.api('PATCH', '/api/auth/me', { currentPassword: 'victima1234', password: 'nuevaClave123' }, asB);
    expect(changed.status).toBe(200);
    await sleep(200);
    expect(stolenRt.events.map((e) => e.event)).toContain('session:revoked');
    expect(stolenRt.s.connected).toBe(false);
    expect(bRt.s.connected).toBe(true);
    expect(bRt.events.map((e) => e.event)).not.toContain('session:revoked');
    expect((await env.api('GET', '/api/contacts', undefined, { cookie: stolen.cookie, ws: tenant.workspaceId })).status).toBe(401);
    expect((await env.api('POST', '/api/api-keys', { name: 'robada' }, { cookie: stolen.cookie, ws: tenant.workspaceId })).status).toBe(401);
    expect((await env.api('GET', '/api/contacts', undefined, asB)).status).toBe(200);

    // logging out also disconnects that session's sockets
    await env.api('POST', '/api/auth/logout', undefined, asB);
    await sleep(200);
    expect(bRt.events.map((e) => e.event)).toContain('session:revoked');
    expect(bRt.s.connected).toBe(false);
  });

  it('rejects tokens without a session id', async () => {
    const legacy = jwt.sign({ uid: tenant.userId }, 'test-secret', { expiresIn: '1d' });
    expect((await env.api('GET', '/api/auth/me', undefined, { cookie: `ll_token=${legacy}`, ws: null })).status).toBe(401);
    const rt = socketFor(`ll_token=${legacy}`);
    expect((await new Promise<Error>((r) => rt.s.on('connect_error', r))).message).toBe('unauthorized');
  });

  it('a member deactivated in their only workspace is signed out', async () => {
    const add = await env.api('POST', '/api/workspace/members', { email: 'saliente@tenant.com', name: 'Saliente', password: 'saliente123', role: 'agent' }, { cookie: op.cookie, ws: tenant.workspaceId });
    const s = await login('saliente@tenant.com', 'saliente123');
    const rt = await joined(s.cookie, tenant.workspaceId);
    expect((await env.api('PATCH', `/api/workspace/members/${add.body.id}`, { is_active: false }, tenant)).status).toBe(200);
    await sleep(200);
    expect(rt.events.map((e) => e.event)).toContain('session:revoked');
    expect((await env.api('GET', '/api/auth/me', undefined, { cookie: s.cookie, ws: null })).status).toBe(401);
  });
});

describe('superadmin demotion (#20)', () => {
  it('stops the live feed of workspaces the demoted user does not belong to', async () => {
    const x = await env.register('soporte@instancia.com', 'Soporte');
    await env.api('PATCH', `/api/admin/users/${x.userId}`, { is_superadmin: true }, op);
    const rt = await joined(x.cookie, tenant.workspaceId);
    env.built.ctx.realtime.emit(tenant.workspaceId, 'contact:update', { id: 'antes', assigned_user_id: null });
    await env.api('PATCH', `/api/admin/users/${x.userId}`, { is_superadmin: false }, op);
    await sleep(200);
    expect(rt.events.find((e) => e.event === 'session:refresh')?.data).toEqual({ workspaceId: tenant.workspaceId });
    env.built.ctx.realtime.emit(tenant.workspaceId, 'contact:update', { id: 'despues', assigned_user_id: null });
    await sleep(200);
    const ids = rt.events.filter((e) => e.event === 'contact:update').map((e) => e.data.id);
    expect(ids).toContain('antes');
    expect(ids).not.toContain('despues');
    expect(await new Promise((r) => rt.s.emit('join', tenant.workspaceId, (a: { ok: boolean }) => r(a.ok)))).toBe(false);
  });
});

describe('login brute force protection (#21, #72, #53, #74)', () => {
  it('flooding the limiter with junk keys keeps live counters and bounded memory', () => {
    const l = new RateLimiter(3, 60_000, 100);
    for (let i = 0; i < 3; i++) l.hit('victima');
    expect(() => l.hit('victima')).toThrow(/Demasiados intentos/);
    for (let i = 0; i < 1000; i++) l.hit(`basura-${i}-${'x'.repeat(1000)}`);
    expect(() => l.hit('victima')).toThrow(/Demasiados intentos/);
    expect(l.size).toBeLessThanOrEqual(100);
    // keys are stored hashed, never the attacker's string
    expect([...(l as any).hits.keys()].every((k: string) => /^[0-9a-f]{64}$/.test(k))).toBe(true);
  });

  it('rejects oversized emails before they reach any limiter key', async () => {
    const r = await env.built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${'a'.repeat(5000)}@x.com`, password: 'x' }, remoteAddress: '198.19.1.1' });
    expect(r.statusCode).toBe(400);
  });

  it('groups IPv6 clients by /64', () => {
    expect(clientNet('2001:db8:1:2:aaaa::1')).toBe(clientNet('2001:0db8:0001:0002:bbbb:cccc:dddd:5'));
    expect(clientNet('2001:db8:1:2::1')).not.toBe(clientNet('2001:db8:1:3::1'));
    expect(clientNet('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(clientNet('203.0.113.9')).toBe('203.0.113.9');
  });

  it('an attacker cannot lock the owner out from an address that signed in before', async () => {
    const home = '198.19.2.1';
    await env.api('POST', '/api/workspace/members', { email: 'jefa@tenant.com', name: 'Jefa', password: 'jefa123456', role: 'admin' }, { cookie: op.cookie, ws: tenant.workspaceId });
    expect((await login('jefa@tenant.com', 'jefa123456', home)).status).toBe(200);
    // 30 wrong guesses from 3 addresses fill the per-account bucket
    for (let ip = 0; ip < 3; ip++) for (let i = 0; i < 10; i++) await login('jefa@tenant.com', 'mala', `198.19.3.${ip}`);
    expect((await login('jefa@tenant.com', 'mala', '198.19.4.1')).status).toBe(429);
    expect((await login('jefa@tenant.com', 'jefa123456', '198.19.4.2')).status).toBe(429);
    // the owner's usual address is not locked out, and is still checked (no free guesses)
    expect((await login('jefa@tenant.com', 'mala', home)).status).toBe(401);
    expect((await login('jefa@tenant.com', 'jefa123456', home)).status).toBe(200);
  });

  it('recognizes the owner by network: a rotated IPv6 address in the same /64 is not locked out', async () => {
    await env.api('POST', '/api/workspace/members', { email: 'movil@tenant.com', name: 'Movil', password: 'movil123456', role: 'agent' }, { cookie: op.cookie, ws: tenant.workspaceId });
    expect((await login('movil@tenant.com', 'movil123456', '2806:10ae:7:1a2b:91c3:4d5e:6f70:1111')).status).toBe(200);
    for (let ip = 0; ip < 3; ip++) for (let i = 0; i < 10; i++) await login('movil@tenant.com', 'mala', `198.19.9.${ip}`);
    expect((await login('movil@tenant.com', 'movil123456', '198.19.9.9')).status).toBe(429);
    // next day: privacy extensions gave the phone a new address inside the same /64
    expect((await login('movil@tenant.com', 'movil123456', '2806:10ae:7:1a2b:5a6b:7c8d:9e0f:2222')).status).toBe(200);
    expect((await login('movil@tenant.com', 'movil123456', '2806:10ae:7:1a2c::2222')).status).toBe(429);
  });

  it('someone sharing the address cannot lock out accounts that signed in from it, which stay bounded', async () => {
    const office = '198.19.10.1';
    await env.api('POST', '/api/workspace/members', { email: 'oficina@tenant.com', name: 'Oficina', password: 'oficina123456', role: 'agent' }, { cookie: op.cookie, ws: tenant.workspaceId });
    expect((await login('oficina@tenant.com', 'oficina123456', office)).status).toBe(200);
    // a guest on the office NAT burns the whole network bucket with junk emails
    for (let i = 0; i < 50; i++) expect((await login(`basura${i}@x.com`, 'x', office)).status).toBe(401);
    expect((await login('nadie@x.com', 'x', office)).status).toBe(429);
    expect((await login('dueno@tenant.com', 'secreto123', office)).status).toBe(429); // never signed in from here
    expect((await login('oficina@tenant.com', 'oficina123456', office)).status).toBe(200);
    // still limited per network and account: no free guesses from a known address
    for (let i = 0; i < 10; i++) expect((await login('oficina@tenant.com', 'mala', office)).status).toBe(401);
    expect((await login('oficina@tenant.com', 'oficina123456', office)).status).toBe(429);
  });

  it('successful logins do not use up attempts', async () => {
    for (let i = 0; i < 35; i++) expect((await login('dueno@tenant.com', 'secreto123', '198.19.5.1')).status).toBe(200);
  });

  it('takes as long for an unknown email as for a wrong password', async () => {
    await login('dueno@tenant.com', 'mala', '198.19.6.1');
    const time = async (email: string, ip: string) => {
      const t = performance.now();
      const r = await login(email, 'mala', ip);
      expect(r.status).toBe(401);
      return performance.now() - t;
    };
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 3; i++) {
      known.push(await time('dueno@tenant.com', `198.19.7.${i}`));
      unknown.push(await time(`nadie${i}@tenant.com`, `198.19.8.${i}`));
    }
    expect(Math.min(...unknown)).toBeGreaterThan(Math.min(...known) * 0.5);
  });
});

describe('first account race (#54)', () => {
  for (const allowSignup of [false, true]) {
    it(`creates exactly one superadmin (ALLOW_SIGNUP=${allowSignup})`, async () => {
      const fresh = await setup({ config: { allowSignup } });
      try {
        const results = await Promise.all(
          ['operador@x.com', 'atacante@x.com', 'atacante2@x.com'].map((email, i) =>
            fresh.built.app.inject({
              method: 'POST',
              url: '/api/auth/register',
              payload: { name: 'Alguien', email, password: 'secreto123', workspaceName: 'Negocio' },
              remoteAddress: `10.9.0.${i + 1}`,
            }),
          ),
        );
        const ok = results.filter((r) => r.statusCode === 200);
        expect(ok).toHaveLength(allowSignup ? 3 : 1);
        if (!allowSignup) expect(results.filter((r) => r.statusCode === 403)).toHaveLength(2);
        const admins = await fresh.built.ctx.db.query(`SELECT count(*)::int AS n FROM users WHERE is_superadmin`);
        expect(admins.rows[0].n).toBe(1);
      } finally {
        await fresh.close();
      }
    });
  }
});

describe('official numbers (#3, #44, #45, #52)', () => {
  const OP_TOKEN = 'EAAG-operator-token-xxxxxxxxxxxxxx';
  let tenantChannel: any;

  it('a WABA can only be connected in one workspace', async () => {
    const asOpIn = (ws: string) => ({ cookie: op.cookie, ws });
    const first = await env.api('POST', '/api/channels', { provider: 'cloud_api', phone_number_id: '1200000000021', waba_id: '2200000000002', access_token: OP_TOKEN, app_secret: 'operator-secret-123456' }, asOpIn(op.workspaceId));
    expect(first.status).toBe(200);
    const other = await env.register('waba@otro.com', 'Otro WABA');
    const second = await env.api('POST', '/api/channels', { provider: 'cloud_api', phone_number_id: '1200000000022', waba_id: '2200000000002', access_token: OP_TOKEN, app_secret: 'operator-secret-123456' }, asOpIn(other.workspaceId));
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('WABA_TAKEN');
    // same rule when an existing channel moves to that WABA
    const third = await env.api('POST', '/api/channels', { provider: 'cloud_api', phone_number_id: '1200000000023', waba_id: '2300000000003', access_token: OP_TOKEN, app_secret: 'operator-secret-123456' }, asOpIn(other.workspaceId));
    expect(third.status).toBe(200);
    const moved = await env.api('PATCH', `/api/channels/${third.body.channel.id}`, { waba_id: '2200000000002' }, asOpIn(other.workspaceId));
    expect(moved.status).toBe(409);
  });

  it('switching to prepaid disables numbers whose secret the tenant knows, until the operator re-keys them', async () => {
    const created = await env.api('POST', '/api/channels', { provider: 'cloud_api', phone_number_id: '1100000000001', waba_id: '2100000000001', access_token: 'EAAG-tenant-own-token-xxxxxxxxxxxx', app_secret: 'tenant-knows-this-secret' }, tenant);
    expect(created.status).toBe(200);
    tenantChannel = created.body.channel;
    expect(tenantChannel.operator_verified).toBe(false);
    expect((await signed(textFrom('1100000000001', '2100000000001', '5215500000001', 'wamid.T1'), 'tenant-knows-this-secret')).statusCode).toBe(200);

    expect((await env.api('PATCH', `/api/admin/workspaces/${tenant.workspaceId}`, { billing_mode: 'prepaid' }, op)).status).toBe(200);
    const ch = (await env.api('GET', '/api/channels', undefined, tenant)).body.channels.find((c: any) => c.id === tenantChannel.id);
    expect(ch.status).toBe('disabled');
    expect(ch.last_error).toMatch(/prepagados/);
    // the tenant's secret can no longer sign webhooks (no forged billing statuses)
    expect((await signed(textFrom('1100000000001', '2100000000001', '5215500000001', 'wamid.T2'), 'tenant-knows-this-secret')).statusCode).toBe(401);
    expect((await env.api('PATCH', `/api/channels/${tenantChannel.id}`, { status: 'active' }, tenant)).status).toBe(403);
    const asOp = { cookie: op.cookie, ws: tenant.workspaceId };
    const blind = await env.api('PATCH', `/api/channels/${tenantChannel.id}`, { status: 'active' }, asOp);
    expect(blind.status).toBe(400);
    expect(blind.body.error.code).toBe('OPERATOR_VERIFICATION_REQUIRED');
    // re-typing the secret the number already had proves nothing: the tenant typed it
    const same = await env.api('PATCH', `/api/channels/${tenantChannel.id}`, { access_token: OP_TOKEN, app_secret: 'tenant-knows-this-secret' }, asOp);
    expect(same.status).toBe(400);
    expect(same.body.error.code).toBe('APP_SECRET_NOT_NEW');
    // a new secret alone is not enough either: the number moves to the operator's app (token + secret)
    const secretOnly = await env.api('PATCH', `/api/channels/${tenantChannel.id}`, { app_secret: 'operator-only-secret-999' }, asOp);
    expect(secretOnly.status).toBe(400);
    expect(secretOnly.body.error.code).toBe('OPERATOR_VERIFICATION_REQUIRED');
    let row = (await env.built.ctx.db.query(`SELECT status, operator_verified FROM channels WHERE id = $1`, [tenantChannel.id])).rows[0];
    expect(row).toMatchObject({ status: 'disabled', operator_verified: false });
    expect((await signed(textFrom('1100000000001', '2100000000001', '5215500000001', 'wamid.T2b'), 'tenant-knows-this-secret')).statusCode).toBe(401);

    const subscribedBefore = meta.calls.filter((c) => c.url.endsWith('/2100000000001/subscribed_apps')).length;
    const rekeyed = await env.api('PATCH', `/api/channels/${tenantChannel.id}`, { access_token: OP_TOKEN, app_secret: 'operator-only-secret-999' }, asOp);
    expect(rekeyed.body.channel).toMatchObject({ status: 'active', operator_verified: true, last_error: null });
    expect(rekeyed.body.warnings).toEqual([]);
    // the operator's app is the one subscribed to the WABA now
    const subs = meta.calls.filter((c) => c.url.endsWith('/2100000000001/subscribed_apps')).slice(subscribedBefore);
    expect(subs.map((c) => c.headers.authorization)).toEqual([`Bearer ${OP_TOKEN}`]);
    expect((await signed(textFrom('1100000000001', '2100000000001', '5215500000001', 'wamid.T3'), 'operator-only-secret-999')).statusCode).toBe(200);
    expect((await signed(textFrom('1100000000001', '2100000000001', '5215500000001', 'wamid.T4'), 'tenant-knows-this-secret')).statusCode).toBe(401);
    row = (await env.built.ctx.db.query(`SELECT status FROM channels WHERE id = $1`, [tenantChannel.id])).rows[0];
    expect(row.status).toBe('active');
  });

  it('numbers the operator typed while the business paid Meta are not trusted once it is prepaid', async () => {
    const biz = await env.register('directo@negocio.com', 'Pago directo');
    const asOp = { cookie: op.cookie, ws: biz.workspaceId };
    // the business handed the operator its own app's credentials to set it up
    const ch = await env.api('POST', '/api/channels', { provider: 'cloud_api', phone_number_id: '1500000000051', waba_id: '2500000000005', access_token: OP_TOKEN, app_secret: 'business-gave-this-secret' }, asOp);
    expect(ch.status).toBe(200);
    expect(ch.body.channel.operator_verified).toBe(false);
    expect((await env.api('PATCH', `/api/admin/workspaces/${biz.workspaceId}`, { billing_mode: 'prepaid' }, op)).status).toBe(200);
    const after = (await env.built.ctx.db.query(`SELECT status, last_error FROM channels WHERE id = $1`, [ch.body.channel.id])).rows[0];
    expect(after.status).toBe('disabled');
    expect(after.last_error).toMatch(/propia app de Meta/);
    expect((await signed(textFrom('1500000000051', '2500000000005', '5215500000003', 'wamid.D1'), 'business-gave-this-secret')).statusCode).toBe(401);
    // neither re-keying it nor connecting another number with that secret makes it trusted
    const rekey = await env.api('PATCH', `/api/channels/${ch.body.channel.id}`, { access_token: OP_TOKEN, app_secret: 'business-gave-this-secret' }, asOp);
    expect(rekey.body.error.code).toBe('APP_SECRET_NOT_NEW');
    const other = await env.api('POST', '/api/channels', { provider: 'cloud_api', phone_number_id: '1500000000052', waba_id: '2500000000005', access_token: OP_TOKEN, app_secret: 'business-gave-this-secret' }, asOp);
    expect(other.status).toBe(400);
    expect(other.body.error.code).toBe('APP_SECRET_NOT_NEW');
  });

  it('a prepaid number without verification (e.g. from before the upgrade) is stopped visibly, not silently', async () => {
    const asOp = { cookie: op.cookie, ws: tenant.workspaceId };
    const ch = await env.api('POST', '/api/channels', { provider: 'cloud_api', phone_number_id: '1600000000061', waba_id: '2600000000006', access_token: OP_TOKEN, app_secret: 'operator-secret-666666' }, asOp);
    expect(ch.body.channel.operator_verified).toBe(true);
    await env.built.ctx.db.query(`UPDATE channels SET operator_verified = false WHERE id = $1`, [ch.body.channel.id]);
    expect((await signed(textFrom('1600000000061', '2600000000006', '5215500000004', 'wamid.U1'), 'operator-secret-666666')).statusCode).toBe(401);
    const row = (await env.api('GET', '/api/channels', undefined, tenant)).body.channels.find((c: any) => c.id === ch.body.channel.id);
    expect(row.status).toBe('disabled');
    expect(row.last_error).toMatch(/prepagados/);
  });

  it('numbers the operator connects in a prepaid workspace are verified', async () => {
    const r = await env.api('POST', '/api/channels', { provider: 'cloud_api', phone_number_id: '1400000000041', waba_id: '2400000000004', access_token: OP_TOKEN, app_secret: 'operator-secret-444444' }, { cookie: op.cookie, ws: tenant.workspaceId });
    expect(r.body.channel.operator_verified).toBe(true);
    expect((await signed(textFrom('1400000000041', '2400000000004', '5215500000002', 'wamid.O1'), 'operator-secret-444444')).statusCode).toBe(200);
  });

  it('testing the connection never re-enables a number the operator disabled', async () => {
    const asOp = { cookie: op.cookie, ws: tenant.workspaceId };
    expect((await env.api('PATCH', `/api/channels/${tenantChannel.id}`, { status: 'disabled' }, asOp)).body.channel.status).toBe('disabled');
    const test = await env.api('POST', `/api/channels/${tenantChannel.id}/test`, undefined, tenant);
    expect(test.body.ok).toBe(true);
    const ch = (await env.api('GET', '/api/channels', undefined, tenant)).body.channels.find((c: any) => c.id === tenantChannel.id);
    expect(ch.status).toBe('disabled');
    expect((await env.api('POST', `/api/channels/${tenantChannel.id}/subscribe`, undefined, tenant)).status).toBe(403);
  });
});

describe('sandbox simulator (#69, #70)', () => {
  it('is for admins only and never writes into a real customer conversation', async () => {
    const biz = await env.register('sim@biz.com', 'Simulador');
    const sandbox = (await env.api('POST', '/api/channels', { provider: 'sandbox', name: 'Pruebas' }, biz)).body.channel;
    const realChannel = (
      await env.built.ctx.db.query(
        `INSERT INTO channels (workspace_id, provider, name, phone_number_id, verify_token) VALUES ($1, 'cloud_api', 'Oficial', '1999999999999', 'vt-sim-123') RETURNING *`,
        [biz.workspaceId],
      )
    ).rows[0];
    // a real customer wrote through the official number
    const real = await processInboundMessage(env.built.ctx, realChannel, { from: '5215512345678', id: 'wamid.REAL1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hola' } });
    const contactId = real!.contact_id;

    const refused = await env.api('POST', `/api/channels/${sandbox.id}/simulate`, { from: '+5215512345678', text: 'BAJA' }, biz);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('REAL_CONTACT');
    const contact = (await env.built.ctx.db.query(`SELECT channel_id, opted_out FROM contacts WHERE id = $1`, [contactId])).rows[0];
    expect(contact).toEqual({ channel_id: realChannel.id, opted_out: false });

    // agents cannot use it at all
    const agent = await env.api('POST', '/api/workspace/members', { email: 'agente-sim@biz.com', name: 'Agente', password: 'agente1234', role: 'agent' }, { cookie: op.cookie, ws: biz.workspaceId });
    expect(agent.body.id).toBeTruthy();
    const ag = await login('agente-sim@biz.com', 'agente1234');
    expect((await env.api('POST', `/api/channels/${sandbox.id}/simulate`, { from: '5215599990001', text: 'x' }, { cookie: ag.cookie, ws: biz.workspaceId })).status).toBe(403);

    // new numbers, and contacts already on the sandbox, still work
    const sim = await env.api('POST', `/api/channels/${sandbox.id}/simulate`, { from: '5215599990001', text: 'prueba' }, biz);
    expect(sim.status).toBe(200);
    expect((await env.api('POST', `/api/channels/${sandbox.id}/simulate`, { from: '5215599990001', text: 'otra' }, biz)).status).toBe(200);
  });
});
