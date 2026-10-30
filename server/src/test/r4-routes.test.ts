import crypto from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { hmacSha256Hex } from '../lib/crypto.js';
import { byteRange } from '../routes/misc.js';
import { saveMedia } from '../services/media.js';
import { fakeFetch, setup, sleep, type TestEnv } from './helpers.js';

// Review round 4, routes and realtime: one test (or more) per finding, each failing without its fix.

const PHONE_ID = '1098765400404';
const WABA_ID = '2223334440404';

let templateCategory = 'MARKETING';
// A second number, for the event clocks of #9 (a WABA is connected in one workspace only).
const PHONE_ID2 = '1098765400405';
const WABA_ID2 = '2223334440405';
let avisoCategory = 'UTILITY';
const meta = fakeFetch([
  (c) => (c.url.includes(`/${PHONE_ID2}?fields=`) ? { json: { id: PHONE_ID2, display_phone_number: '+56 9 1234 0001' } } : undefined),
  (c) => (c.url.endsWith(`/${WABA_ID2}/subscribed_apps`) ? { json: { success: true } } : undefined),
  (c) => (c.url.includes(`/${WABA_ID2}/phone_numbers`) ? { json: { data: [{ id: PHONE_ID2 }] } } : undefined),
  (c) =>
    c.url.includes(`/${WABA_ID2}/message_templates?limit`)
      ? { json: { data: [{ id: 'tp-aviso', name: 'aviso', language: 'es', status: 'APPROVED', category: avisoCategory, components: [{ type: 'BODY', text: 'Aviso' }] }] } }
      : undefined,
  (c) => (c.url.includes(`/${PHONE_ID}?fields=`) ? { json: { id: PHONE_ID, display_phone_number: '+56 9 1234 0000' } } : undefined),
  (c) => (c.url.endsWith(`/${WABA_ID}/subscribed_apps`) ? { json: { success: true } } : undefined),
  (c) => (c.url.includes(`/${WABA_ID}/phone_numbers`) ? { json: { data: [{ id: PHONE_ID }] } } : undefined),
  (c) =>
    c.url.includes(`/${WABA_ID}/message_templates?limit`)
      ? { json: { data: [{ id: 'tp1', name: 'promo', language: 'es', status: 'APPROVED', category: templateCategory, components: [{ type: 'BODY', text: 'Oferta' }] }] } }
      : undefined,
]);

let env: TestEnv;
let base: string;
let op: { cookie: string; userId: string; workspaceId: string };
const sockets: Socket[] = [];

const PASSWORD = 'secreto123';

async function login(email: string, password = PASSWORD) {
  const r = await env.built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  if (r.statusCode !== 200) throw new Error(`login failed: ${r.body}`);
  return { cookie: `ll_token=${r.cookies.find((c) => c.name === 'll_token')!.value}`, userId: JSON.parse(r.body).user.id as string };
}

/** An account created by the operator inside `workspaceId` (only the operator sets passwords). */
async function member(workspaceId: string, email: string, role: 'admin' | 'agent', password = PASSWORD) {
  const r = await env.api('POST', '/api/workspace/members', { email, name: email.split('@')[0], password, role }, { cookie: op.cookie, ws: workspaceId });
  if (r.status !== 200) throw new Error(`member failed: ${JSON.stringify(r.body)}`);
  return { ...(await login(email, password)), workspaceId };
}

function listen(cookie: string, opts: { reconnection?: boolean } = {}) {
  const s = connect(base, { path: '/socket.io', extraHeaders: { cookie }, transports: ['websocket'], reconnection: opts.reconnection ?? false });
  sockets.push(s);
  const events: { event: string; data: any }[] = [];
  s.onAny((event, data) => events.push({ event, data }));
  return { s, events };
}

async function joined(cookie: string, workspaceId: string) {
  const rt = listen(cookie);
  await new Promise<void>((resolve, reject) => {
    rt.s.on('connect_error', reject);
    rt.s.on('connect', () => rt.s.emit('join', workspaceId, (r: { ok: boolean }) => (r.ok ? resolve() : reject(new Error('join refused')))));
  });
  return rt;
}

beforeAll(async () => {
  env = await setup({ fetch: meta.fetch });
  op = await env.register('op@r4.com', 'Operación'); // first account: instance operator
  await env.built.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(env.built.app.server.address() as { port: number }).port}`;
});
afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await env.close();
});

describe('#23 a connection that drops inside db.tx() (PostgreSQL)', () => {
  it.skipIf(!process.env.TEST_DATABASE_URL)('rejects the transaction, discards the connection and keeps the process alive', async () => {
    const db = env.built.ctx.db;
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 100 && !ok(); i++) await sleep(20);
    };
    // Dropped between two statements, while the transaction waits on other work.
    let pid = 0;
    let release!: () => void;
    const idle = db.tx(async (q) => {
      pid = (await q.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await new Promise<void>((r) => (release = () => r()));
      await q.query('SELECT 1');
    });
    await until(() => pid > 0);
    await db.query('SELECT pg_terminate_backend($1)', [pid]);
    await sleep(200);
    release();
    await expect(idle).rejects.toThrow();

    // Dropped while a statement of the transaction runs.
    pid = 0;
    const active = db.tx(async (q) => {
      pid = (await q.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await q.query('SELECT pg_sleep(5)');
    });
    await until(() => pid > 0);
    await sleep(100);
    await db.query('SELECT pg_terminate_backend($1)', [pid]);
    await expect(active).rejects.toThrow();
    await sleep(100);
    // The pool hands out healthy connections afterwards.
    for (let i = 0; i < 12; i++) expect(await db.tx(async (q) => (await q.query<{ n: number }>('SELECT 1 AS n')).rows[0].n)).toBe(1);
  });
});

describe('#37 socket handshake errors', () => {
  it("answers 'unavailable' (retryable) when the session lookup fails, 'unauthorized' only for a dead session", async () => {
    const db = env.built.ctx.db;
    const query = db.query.bind(db);
    let fail = true;
    db.query = (async (sql: string, params?: unknown[]) => {
      if (fail && sql.includes('FROM sessions s JOIN users u')) {
        fail = false;
        throw new Error('the database is starting up');
      }
      return query(sql, params);
    }) as typeof db.query;
    try {
      const rt = listen(op.cookie);
      expect((await new Promise<Error>((r) => rt.s.on('connect_error', r))).message).toBe('unavailable');
      rt.s.connect();
      await new Promise<void>((r) => rt.s.on('connect', () => r()));
    } finally {
      db.query = query;
    }
    const revoked = await login('op@r4.com');
    await env.api('POST', '/api/auth/logout', undefined, { cookie: revoked.cookie, ws: null });
    const dead = listen(revoked.cookie);
    expect((await new Promise<Error>((r) => dead.s.on('connect_error', r))).message).toBe('unauthorized');
  });
});

describe('#3 simulating from another form of a real number', () => {
  let sandbox: string;
  beforeAll(async () => {
    sandbox = (await env.api('POST', '/api/channels', { provider: 'sandbox', name: 'Pruebas' }, op)).body.channel.id;
  });
  const simulate = (from: string) => env.api('POST', `/api/channels/${sandbox}/simulate`, { from, text: 'mensaje de prueba' }, op);

  it('refuses Brazil without the 9th digit and Argentina without the 9 (they reach the real contact)', async () => {
    const br = await env.api('POST', '/api/contacts', { phone: '+5511987654321', name: 'Cliente BR' }, op);
    const ar = await env.api('POST', '/api/contacts', { phone: '+5491112345678', name: 'Cliente AR' }, op);
    expect((await simulate('+5511987654321')).body.error.code).toBe('REAL_CONTACT');
    expect((await simulate('+551187654321')).body.error.code).toBe('REAL_CONTACT');
    expect((await simulate('+541112345678')).body.error.code).toBe('REAL_CONTACT');
    // Untouched: still no channel, no wa_id, nothing unread.
    for (const id of [br.body.contact.id, ar.body.contact.id]) {
      const c = (await env.api('GET', `/api/contacts/${id}`, undefined, op)).body.contact;
      expect([c.channel_id, c.wa_id, c.unread_count]).toEqual([null, null, 0]);
    }
  });

  it('refuses the number a real customer changed from', async () => {
    const c = (await env.api('POST', '/api/contacts', { phone: '+525511112222', name: 'Mudado' }, op)).body.contact;
    await env.built.ctx.db.query(
      `INSERT INTO contact_events (workspace_id, contact_id, type, data) VALUES ($1, $2, 'number_changed', $3)`,
      [op.workspaceId, c.id, JSON.stringify({ old_wa_id: '5215599998888', old_phone: '525599998888', new_phone: '525511112222', moved: true })],
    );
    expect((await simulate('+525599998888')).body.error.code).toBe('REAL_CONTACT');
  });

  it('still simulates new numbers, and other forms of a number that only lives on the sandbox', async () => {
    expect((await simulate('+5491133334444')).status).toBe(200);
    expect((await simulate('+541133334444')).status).toBe(200);
  });
});

describe('#5 webhook item cap', () => {
  it('counts every list in a change (message_echoes, contacts, errors…), not only messages and statuses', async () => {
    for (const field of ['message_echoes', 'contacts', 'errors']) {
      const body = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [{ id: WABA_ID, changes: [{ field: 'smb_message_echoes', value: { [field]: Array.from({ length: 1001 }, (_, i) => ({ to: '5215500000000', id: `e${i}` })) } }] }],
      });
      const r = await env.built.app.inject({ method: 'POST', url: '/webhooks/whatsapp', headers: { 'content-type': 'application/json' }, payload: body });
      expect(r.statusCode).toBe(413);
    }
  });
});

describe('#9 templates re-read from Meta once the operator vouches for the number', () => {
  it('on operator verification after the switch to prepaid, and for verified numbers at the switch', async () => {
    templateCategory = 'MARKETING';
    const tenant = await env.register('tenant-r4@r4.com', 'Inquilino');
    const conn = await env.api(
      'POST',
      '/api/channels',
      { provider: 'cloud_api', name: 'Ventas', phone_number_id: PHONE_ID, waba_id: WABA_ID, access_token: 'EAAG-tenant-token-xxxxxxxxxxxx', app_secret: 'tenant-secret-0123456789' },
      tenant,
    );
    expect(conn.status).toBe(200);
    const channelId = conn.body.channel.id;
    const category = async () =>
      (await env.built.ctx.db.query<{ category: string }>(`SELECT category FROM templates WHERE channel_id = $1 AND name = 'promo'`, [channelId])).rows[0].category;
    expect(await category()).toBe('marketing');
    // What a template_category_update signed with the tenant's own secret left while it paid Meta.
    await env.built.ctx.db.query(`UPDATE templates SET category = 'service' WHERE channel_id = $1`, [channelId]);

    expect((await env.api('PATCH', `/api/admin/workspaces/${tenant.workspaceId}`, { billing_mode: 'prepaid' }, op)).status).toBe(200);
    const verify = await env.api(
      'PATCH',
      `/api/channels/${channelId}`,
      { access_token: 'EAAG-operator-token-xxxxxxxxxx', app_secret: 'operator-secret-0123456789' },
      { cookie: op.cookie, ws: tenant.workspaceId },
    );
    expect(verify.status).toBe(200);
    expect([verify.body.channel.operator_verified, verify.body.channel.status]).toEqual([true, 'active']);
    expect(await category()).toBe('marketing');

    // A number already verified when the workspace goes back to prepaid is read again too.
    await env.api('PATCH', `/api/admin/workspaces/${tenant.workspaceId}`, { billing_mode: 'meta_direct' }, op);
    await env.built.ctx.db.query(`UPDATE templates SET category = 'service' WHERE channel_id = $1`, [channelId]);
    const back = await env.api('PATCH', `/api/admin/workspaces/${tenant.workspaceId}`, { billing_mode: 'prepaid' }, op);
    expect(back.status).toBe(200);
    expect(back.body.warnings).toEqual([]);
    expect(await category()).toBe('marketing');
  });

  it('lets the operator re-verify with the instance app (META_APP_SECRET) even if the number already has it', async () => {
    const appSecret = 'instance-app-secret-0123456789';
    env.built.ctx.config.metaAppSecret = appSecret;
    try {
      const { rows } = await env.built.ctx.db.query<{ id: string; workspace_id: string }>(`SELECT id, workspace_id FROM channels WHERE phone_number_id = $1`, [PHONE_ID]);
      const ch = rows[0];
      // As migration 006 leaves a number the operator verified on an older version.
      const verify = (secret: string) =>
        env.api('PATCH', `/api/channels/${ch.id}`, { access_token: 'EAAG-operator-token-xxxxxxxxxx', app_secret: secret }, { cookie: op.cookie, ws: ch.workspace_id });
      expect((await verify(appSecret)).status).toBe(200);
      await env.built.ctx.db.query(`UPDATE channels SET operator_verified = false, status = 'disabled' WHERE id = $1`, [ch.id]);
      const again = await verify(appSecret);
      expect(again.status).toBe(200);
      expect(again.body.channel.operator_verified).toBe(true);
      // Any other secret already stored on an unverified number is still refused.
      await env.built.ctx.db.query(`UPDATE channels SET operator_verified = false, status = 'disabled' WHERE id = $1`, [ch.id]);
      await verify('operator-secret-0123456789');
      await env.built.ctx.db.query(`UPDATE channels SET operator_verified = false, status = 'disabled' WHERE id = $1`, [ch.id]);
      expect((await verify('operator-secret-0123456789')).body.error.code).toBe('APP_SECRET_NOT_NEW');
    } finally {
      env.built.ctx.config.metaAppSecret = null;
    }
  });

  it('the re-read also drops the event clocks, so a later recategorization by Meta applies', async () => {
    avisoCategory = 'UTILITY';
    const tenant = await env.register('reloj-r4@r4.com', 'Reloj');
    const tenantSecret = 'tenant-secret-reloj-0123456789';
    const opSecret = 'operator-secret-reloj-0123456789';
    const conn = await env.api(
      'POST',
      '/api/channels',
      { provider: 'cloud_api', name: 'Avisos', phone_number_id: PHONE_ID2, waba_id: WABA_ID2, access_token: 'EAAG-tenant-token-reloj-xxxxxxx', app_secret: tenantSecret },
      tenant,
    );
    expect(conn.status).toBe(200);
    const channelId = conn.body.channel.id;
    const category = async () =>
      (await env.built.ctx.db.query<{ category: string }>(`SELECT category FROM templates WHERE channel_id = $1 AND name = 'aviso'`, [channelId])).rows[0].category;
    const recategorize = async (secret: string, time: number, newCategory: string) => {
      const body = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: WABA_ID2,
            time,
            changes: [
              {
                field: 'template_category_update',
                value: { message_template_id: 'tp-aviso', message_template_name: 'aviso', message_template_language: 'es', previous_category: 'UTILITY', new_category: newCategory },
              },
            ],
          },
        ],
      });
      const r = await env.built.app.inject({
        method: 'POST',
        url: '/webhooks/whatsapp',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${hmacSha256Hex(secret, body)}` },
        payload: body,
      });
      expect(r.statusCode).toBe(200);
      await env.drain();
    };
    const now = () => Math.floor(Date.now() / 1000);
    // While it pays Meta directly, the business signs an event of its own dated a few minutes ahead.
    await recategorize(tenantSecret, now() + 240, 'UTILITY');
    expect(await category()).toBe('utility');

    await env.api('PATCH', `/api/admin/workspaces/${tenant.workspaceId}`, { billing_mode: 'prepaid' }, op);
    const verify = await env.api(
      'PATCH',
      `/api/channels/${channelId}`,
      { access_token: 'EAAG-operator-token-reloj-xxxxxx', app_secret: opSecret },
      { cookie: op.cookie, ws: tenant.workspaceId },
    );
    expect([verify.status, verify.body.channel.operator_verified]).toEqual([200, true]);
    // Meta moves the template to marketing (signed by the operator's app, dated now).
    await recategorize(opSecret, now(), 'MARKETING');
    expect(await category()).toBe('marketing');
  });
});

describe('#11 operator rights and password resets need the operator password', () => {
  it('a stolen operator session can neither demote another operator nor reset its password', async () => {
    const op2 = await env.register('op2@r4.com', 'Segundo operador');
    expect((await env.api('PATCH', `/api/admin/users/${op2.userId}`, { is_superadmin: true }, op)).body.error.code).toBe('WRONG_PASSWORD');
    expect((await env.api('PATCH', `/api/admin/users/${op2.userId}`, { is_superadmin: true, currentPassword: PASSWORD }, op)).status).toBe(200);

    const stolen = await login('op@r4.com');
    const as = { cookie: stolen.cookie, ws: null };
    expect((await env.api('PATCH', `/api/admin/users/${op2.userId}`, { is_superadmin: false }, as)).status).toBe(400);
    expect((await env.api('PATCH', `/api/admin/users/${op2.userId}`, { is_superadmin: false, currentPassword: 'adivinando' }, as)).status).toBe(400);
    expect((await env.api('POST', `/api/admin/users/${op2.userId}/password`, { password: 'tomada12345' }, as)).status).toBe(400);
    // A helper account of its own cannot become an operator either.
    const helper = await member(op.workspaceId, 'helper@r4.com', 'agent');
    expect((await env.api('PATCH', `/api/admin/users/${helper.userId}`, { is_superadmin: true }, as)).status).toBe(400);
    expect((await env.api('POST', `/api/admin/users/${helper.userId}/password`, { password: 'tomada12345' }, as)).status).toBe(400);
    const accounts = await env.built.ctx.db.query<{ email: string; is_superadmin: boolean }>(`SELECT email, is_superadmin FROM users WHERE email IN ('op2@r4.com', 'helper@r4.com') ORDER BY email`);
    expect(accounts.rows).toEqual([
      { email: 'helper@r4.com', is_superadmin: false },
      { email: 'op2@r4.com', is_superadmin: true },
    ]);
    expect((await env.built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'op2@r4.com', password: PASSWORD } })).statusCode).toBe(200);

    // Guesses are limited per session (the same budget as PATCH /api/auth/me).
    for (let i = 0; i < 8; i++) await env.api('PATCH', `/api/admin/users/${op2.userId}`, { is_superadmin: false, currentPassword: `mala-${i}` }, as);
    expect((await env.api('PATCH', `/api/admin/users/${op2.userId}`, { is_superadmin: false, currentPassword: PASSWORD }, as)).status).toBe(429);
    expect((await env.api('PATCH', '/api/auth/me', { currentPassword: PASSWORD, password: 'otra-clave-123' }, as)).status).toBe(429);

    // With the password, the operator still can (from a session that did not guess).
    expect((await env.api('POST', `/api/admin/users/${helper.userId}/password`, { password: 'temporal12345', currentPassword: PASSWORD }, op)).status).toBe(200);
    expect((await env.api('PATCH', `/api/admin/users/${op2.userId}`, { is_superadmin: false, currentPassword: PASSWORD }, op)).status).toBe(200);
  });
});

describe('#12 the last active owner', () => {
  it('cannot leave the workspace when the only other owner is deactivated', async () => {
    const a = await env.register('duena@r4.com', 'Con dueños');
    const b = await member(a.workspaceId, 'socio@r4.com', 'admin');
    const asA = { cookie: a.cookie, ws: a.workspaceId };
    expect((await env.api('PATCH', `/api/workspace/members/${b.userId}`, { role: 'owner' }, asA)).status).toBe(200);
    expect((await env.api('PATCH', `/api/workspace/members/${b.userId}`, { is_active: false }, asA)).status).toBe(200);
    expect((await env.api('PATCH', `/api/workspace/members/${a.userId}`, { is_active: false }, asA)).status).toBe(400);
    const leave = await env.api('DELETE', `/api/workspace/members/${a.userId}`, undefined, asA);
    expect(leave.status).toBe(400);
    expect(leave.body.error.message).toBe('Debe quedar al menos un propietario activo');
    // Changing the deactivated owner does not lower the number of active owners.
    expect((await env.api('PATCH', `/api/workspace/members/${b.userId}`, { role: 'admin' }, asA)).status).toBe(200);
    expect((await env.api('PATCH', `/api/workspace/members/${b.userId}`, { role: 'owner', is_active: true }, asA)).status).toBe(200);
    // With another active owner, leaving works.
    expect((await env.api('DELETE', `/api/workspace/members/${a.userId}`, undefined, asA)).status).toBe(204);
  });

  it.skipIf(!process.env.TEST_DATABASE_URL)('two owners removing each other at once: one of them stays', async () => {
    const a = await env.register('carrera-a@r4.com', 'Carrera');
    const b = await member(a.workspaceId, 'carrera-b@r4.com', 'admin');
    await env.api('PATCH', `/api/workspace/members/${b.userId}`, { role: 'owner' }, { cookie: a.cookie, ws: a.workspaceId });
    const r = await Promise.all([
      env.api('DELETE', `/api/workspace/members/${b.userId}`, undefined, { cookie: a.cookie, ws: a.workspaceId }),
      env.api('DELETE', `/api/workspace/members/${a.userId}`, undefined, { cookie: b.cookie, ws: a.workspaceId }),
    ]);
    // The loser is refused (400, or 403 once its own membership is gone).
    expect(r.filter((x) => x.status === 204).length).toBe(1);
    const owners = await env.built.ctx.db.query(`SELECT 1 FROM memberships WHERE workspace_id = $1 AND role = 'owner' AND is_active`, [a.workspaceId]);
    expect(owners.rows.length).toBe(1);
  });
});

describe('#13 tags', () => {
  it("creating a tag that exists never changes it (agents cannot recolor tags through POST)", async () => {
    const agent = await member(op.workspaceId, 'etiquetas@r4.com', 'agent');
    const as = { cookie: agent.cookie, ws: op.workspaceId };
    const before = (await env.api('GET', '/api/tags', undefined, op)).body.tags.find((t: any) => t.name === 'Cliente');
    expect((await env.api('PATCH', `/api/tags/${before.id}`, { color: '#000000' }, as)).status).toBe(403);
    const r = await env.api('POST', '/api/tags', { name: 'Cliente', color: '#000000' }, as);
    expect(r.status).toBe(200);
    expect([r.body.tag.id, r.body.tag.color]).toEqual([before.id, before.color]);
    const after = (await env.api('GET', '/api/tags', undefined, op)).body.tags.find((t: any) => t.name === 'Cliente');
    expect(after.color).toBe(before.color);
    // A new tag still takes the color it was created with.
    expect((await env.api('POST', '/api/tags', { name: 'Nueva r4', color: '#123456' }, as)).body.tag.color).toBe('#123456');
  });
});

describe('#19 media byte ranges', () => {
  it('answers Range requests with 206 (Safari and iOS need them to play video and audio)', async () => {
    const data = crypto.randomBytes(5000);
    const media = await saveMedia(env.built.ctx, op.workspaceId, data, 'video/mp4', 'clip.mp4');
    const get = (range?: string) =>
      env.built.app.inject({ method: 'GET', url: `/api/media/${media.id}?ws=${op.workspaceId}`, headers: { cookie: op.cookie, ...(range ? { range } : {}) } });
    const probe = await get('bytes=0-1');
    expect(probe.statusCode).toBe(206);
    expect(probe.headers['content-range']).toBe('bytes 0-1/5000');
    expect(probe.headers['accept-ranges']).toBe('bytes');
    expect(probe.headers['content-type']).toBe('video/mp4');
    expect(probe.rawPayload.equals(data.subarray(0, 2))).toBe(true);
    const tail = await get('bytes=4990-');
    expect([tail.statusCode, tail.headers['content-range'], tail.rawPayload.length]).toEqual([206, 'bytes 4990-4999/5000', 10]);
    const suffix = await get('bytes=-100');
    expect(suffix.rawPayload.equals(data.subarray(4900))).toBe(true);
    const past = await get('bytes=6000-');
    expect([past.statusCode, past.headers['content-range']]).toEqual([416, 'bytes */5000']);
    const whole = await get();
    expect([whole.statusCode, whole.headers['accept-ranges'], Number(whole.headers['content-length'])]).toEqual([200, 'bytes', 5000]);
    expect(whole.rawPayload.equals(data)).toBe(true);
    // Unchanged safety headers.
    expect(probe.headers['x-content-type-options']).toBe('nosniff');
    expect(probe.headers['content-security-policy']).toContain('sandbox');
  });

  it('parses single ranges and ignores what it cannot honour', () => {
    expect(byteRange(undefined, 10)).toBe(null);
    expect(byteRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 });
    expect(byteRange('bytes=2-50', 10)).toEqual({ start: 2, end: 9 });
    expect(byteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(byteRange('bytes=-30', 10)).toEqual({ start: 0, end: 9 });
    expect(byteRange('bytes=10-', 10)).toBe('unsatisfiable');
    expect(byteRange('bytes=-0', 10)).toBe('unsatisfiable');
    expect(byteRange('bytes=5-2', 10)).toBe(null);
    expect(byteRange('bytes=0-1,4-5', 10)).toBe(null);
    expect(byteRange('items=0-1', 10)).toBe(null);
  });
});

describe('#21 contacts export → import', () => {
  it('restores custom fields and placement instead of storing the export columns as fields', async () => {
    const src = await env.register('origen-r4@r4.com', 'Origen');
    const dst = await env.register('destino-r4@r4.com', 'Destino');
    const stages = (await env.api('GET', '/api/funnels', undefined, src)).body.funnels[0].stages;
    const interesado = stages.find((s: any) => s.name === 'Interesado');
    await env.api('POST', '/api/contacts', { phone: '+525511223344', name: 'Con campos', custom_fields: { plan: 'Pro', ciudad: 'CDMX' }, stage_id: interesado.id }, src);
    const csv = (await env.api('GET', '/api/contacts/export.csv', undefined, src)).raw;
    const imp = await env.api('POST', '/api/contacts/import', { csv, lossy: false }, dst);
    expect([imp.status, imp.body.created]).toEqual([200, 1]);
    const c = (await env.api('GET', '/api/contacts?search=Con%20campos', undefined, dst)).body.items[0];
    expect(c.custom_fields).toEqual({ plan: 'Pro', ciudad: 'CDMX' });
    const dstStages = (await env.api('GET', '/api/funnels', undefined, dst)).body.funnels[0].stages;
    expect(c.stage_id).toBe(dstStages.find((s: any) => s.name === 'Interesado').id);
  });

  it('keeps storing unknown columns of other files as custom fields', async () => {
    const dst = await env.register('otro-csv@r4.com', 'Otro CSV');
    const imp = await env.api('POST', '/api/contacts/import', { csv: 'telefono,nombre,origen,etapa\n+525566778899,Feria,expo,caliente\n', lossy: false }, dst);
    expect(imp.body.created).toBe(1);
    const c = (await env.api('GET', '/api/contacts?search=Feria', undefined, dst)).body.items[0];
    expect(c.custom_fields).toEqual({ origen: 'expo', etapa: 'caliente' });
  });

  it('a "Campos" column of another file is data, not our export', async () => {
    const dst = await env.register('campos-ajeno@r4.com', 'Campos ajeno');
    const csv =
      'Telefono,Nombre,Campos,Origen,Etapa\n' +
      '+525512340001,Ana,Interesada en plan Pro,Feria 2026,Caliente\n' +
      '+525512340004,Bruno,"{""plan"":""Pro""}",Web,Frio\n';
    const imp = await env.api('POST', '/api/contacts/import', { csv, lossy: false }, dst);
    expect([imp.status, imp.body.created]).toEqual([200, 2]);
    const fields = async (q: string) => (await env.api('GET', `/api/contacts?search=${q}`, undefined, dst)).body.items[0].custom_fields;
    expect(await fields('Ana')).toEqual({ Campos: 'Interesada en plan Pro', Origen: 'Feria 2026', Etapa: 'Caliente' });
    // Even when it holds JSON: without the other columns of our export, nothing is dropped.
    expect(await fields('Bruno')).toEqual({ Campos: '{"plan":"Pro"}', Origen: 'Web', Etapa: 'Frio' });
  });

  it('a row of our export whose campos is not JSON keeps every column', async () => {
    const dst = await env.register('campos-editado@r4.com', 'Campos editado');
    const csv =
      'telefono,nombre,embudo,etapa,asignado_a,origen,creado,ultimo_mensaje,campos\n' +
      '+525512340002,Editado,Ventas,Nuevo,,manual,2026-10-01,,plan Pro\n' +
      '+525512340003,Intacto,Ventas,Nuevo,,manual,2026-10-01,,"{""plan"":""Pro""}"\n';
    const imp = await env.api('POST', '/api/contacts/import', { csv, lossy: false }, dst);
    expect([imp.status, imp.body.created]).toEqual([200, 2]);
    const fields = async (q: string) => (await env.api('GET', `/api/contacts?search=${q}`, undefined, dst)).body.items[0].custom_fields;
    expect(await fields('Editado')).toEqual({ embudo: 'Ventas', etapa: 'Nuevo', origen: 'manual', creado: '2026-10-01', campos: 'plan Pro' });
    expect(await fields('Intacto')).toEqual({ plan: 'Pro' });
  });
});

describe('#36 CSV import and the shared event loop', () => {
  async function blocked<T>(fn: () => Promise<T>): Promise<{ out: T; maxMs: number }> {
    const h = monitorEventLoopDelay({ resolution: 5 });
    h.enable();
    try {
      const out = await fn();
      return { out, maxMs: h.max / 1e6 };
    } finally {
      h.disable();
    }
  }

  it('refuses a header with too many columns before parsing it', async () => {
    const csv = 'telefono,' + Array.from({ length: 300_000 }, (_, i) => `c${i}`).join(',') + '\n+525500000001\n';
    const { out, maxMs } = await blocked(() => env.api('POST', '/api/contacts/import', { csv, lossy: false }, op));
    expect(out.body.error.code).toBe('CSV_TOO_MANY_COLUMNS');
    expect(maxMs).toBeLessThan(400);
  });

  it('measures the header the parser uses: blank lines before it do not hide its width', async () => {
    const wide = 'telefono,' + Array.from({ length: 300_000 }, (_, i) => `c${i}`).join(',');
    const files = ['\n', '\r\n', ' \t\r\n\n'].map((blank) => `${blank}${wide}\n+525500000001\n`);
    // Lines end in CRLF from the first one on, so the parser reads "x\n" as the start of a wide
    // header that a look at the first line alone takes for one column.
    files.push(`\r\nx\n${wide}\r\n+525500000001\r\n`);
    for (const [i, csv] of files.entries()) {
      const { out, maxMs } = await blocked(() => env.api('POST', '/api/contacts/import', { csv, lossy: false }, op));
      // The last one's header record is also over the parser's record size limit (round 5), which
      // may stop it first: refused either way, before its columns are walked.
      if (i === files.length - 1) expect(['CSV_TOO_MANY_COLUMNS', 'CSV_RECORD_TOO_LARGE']).toContain(out.body.error.code);
      else expect(out.body.error.code).toBe('CSV_TOO_MANY_COLUMNS');
      expect(maxMs).toBeLessThan(400);
    }
    // Millions of blank lines are skipped in linear time (no 500).
    const blanks = await blocked(() => env.api('POST', '/api/contacts/import', { csv: '\n'.repeat(5_000_000) + 'telefono\n+525500000009\n', lossy: false }, op));
    expect([blanks.out.status, blanks.out.body.created]).toEqual([200, 1]);
    expect(blanks.maxMs).toBeLessThan(400);
    // The header line checked for lost accents is that one too.
    const r = await env.api('POST', '/api/contacts/import', { csv: '\nTel\ufffdfono,nombre\n+525500000001,Ana\n' }, op);
    expect(r.body.error.code).toBe('CSV_NOT_UTF8');
  });

  it('refuses 20,001 rows, with or without a final line break', async () => {
    const rows = 'telefono\n' + Array.from({ length: 20_001 }, () => 'x').join('\n');
    for (const csv of [rows, rows + '\n']) {
      const r = await env.api('POST', '/api/contacts/import', { csv, lossy: false }, op);
      expect([r.status, r.body.error?.message]).toEqual([400, 'Máximo 20,000 filas por importación']);
    }
  });

  it('still reports a malformed file', async () => {
    const r = await env.api('POST', '/api/contacts/import', { csv: 'telefono,nombre\n+525500000002,"sin cerrar\n', lossy: false }, op);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/^No se pudo leer el CSV/);
  });

  it('parses a large file in slices and stops counting rows past the limit', async () => {
    const over = 'telefono\n' + Array.from({ length: 2_000_000 }, () => 'x').join('\n');
    const r1 = await blocked(() => env.api('POST', '/api/contacts/import', { csv: over, lossy: false }, op));
    expect(r1.out.body.error.message).toBe('Máximo 20,000 filas por importación');
    expect(r1.maxMs).toBeLessThan(400);
    // 20,000 rows of 60 columns (7 MB): about a second in one block when parsed at once.
    const cols = Array.from({ length: 60 }, (_, i) => `campo${i}`);
    const big = `telefono,${cols.join(',')}\n` + Array.from({ length: 20_000 }, () => `,${cols.map(() => 'abcde').join(',')}`).join('\n');
    const r2 = await blocked(() => env.api('POST', '/api/contacts/import', { csv: big, lossy: false }, op));
    expect([r2.out.status, r2.out.body.total, r2.out.body.error_count]).toEqual([200, 20_000, 20_000]);
    expect(r2.maxMs).toBeLessThan(400);
  });
});

describe('#30 conversation list by keyset', () => {
  it('next pages follow the cursor, whatever moved to the top or left the list meanwhile', async () => {
    const w = await env.register('paginas@r4.com', 'Páginas');
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const c = (await env.api('POST', '/api/contacts', { phone: `+5255000011${String(i).padStart(2, '0')}` }, w)).body.contact;
      ids.push(c.id);
      // Same second for several of them, microseconds apart: the cursor must keep full precision.
      await env.built.ctx.db.query(`UPDATE contacts SET last_message_at = timestamptz '2026-10-01 10:00:00Z' + $2::interval WHERE id = $1`, [c.id, `${i} microseconds`]);
    }
    const page1 = await env.api('GET', '/api/contacts?inbox=unassigned&has_messages=1&limit=5', undefined, w);
    expect(page1.body.items.length).toBe(5);
    expect(typeof page1.body.next_cursor).toBe('string');
    // Meanwhile: two of page 1 are taken (leave the tab), and one from further down gets a message.
    for (const c of page1.body.items.slice(0, 2)) await env.api('PATCH', `/api/contacts/${c.id}`, { assigned_user_id: w.userId }, w);
    const shown = new Set<string>(page1.body.items.map((c: any) => c.id));
    await env.built.ctx.db.query(`UPDATE contacts SET last_message_at = now() WHERE id = $1`, [ids[0]]);
    let cursor = page1.body.next_cursor;
    const later: string[] = [];
    while (cursor) {
      const p = await env.api('GET', `/api/contacts?inbox=unassigned&has_messages=1&limit=5&cursor=${encodeURIComponent(cursor)}`, undefined, w);
      expect(p.status).toBe(200);
      later.push(...p.body.items.map((c: any) => c.id));
      cursor = p.body.next_cursor;
    }
    // Every conversation below page 1 shows up exactly once (the one that moved up is in the refetched head).
    expect(new Set(later).size).toBe(later.length);
    expect(later.some((id) => shown.has(id))).toBe(false);
    expect(new Set([...shown, ...later, ids[0]]).size).toBe(12);
  });

  it('refuses a cursor it did not make, and with another sort', async () => {
    expect((await env.api('GET', '/api/contacts?cursor=basura', undefined, op)).body.error.code).toBe('INVALID_CURSOR');
    const p = await env.api('GET', '/api/contacts?limit=1', undefined, op);
    expect((await env.api('GET', `/api/contacts?sort=name&cursor=${p.body.next_cursor}`, undefined, op)).body.error.code).toBe('INVALID_CURSOR');
    expect((await env.api('GET', '/api/contacts?sort=name&page=2&limit=1', undefined, op)).body.next_cursor).toBe(null);
  });
});

describe('restricted agents (#4, #33)', () => {
  let ws: string;
  let r: { cookie: string; userId: string };
  let s: { cookie: string; userId: string };
  let owner: { cookie: string; userId: string; workspaceId: string };
  beforeAll(async () => {
    owner = await env.register('restringido@r4.com', 'Restringido');
    ws = owner.workspaceId;
    await env.api('PUT', '/api/workspace/settings', { agent_visibility: 'assigned' }, owner);
    r = await member(ws, 'agente-r@r4.com', 'agent');
    s = await member(ws, 'agente-s@r4.com', 'agent');
  });
  const contact = async (phone: string, assignee: string | null) =>
    (await env.api('POST', '/api/contacts', { phone, ...(assignee ? { assigned_user_id: assignee } : {}) }, owner)).body.contact.id as string;

  it('#4 contacts:bulk only carries the conversations each restricted agent could see', async () => {
    const c1 = await contact('+525540000001', s.userId);
    const c2 = await contact('+525540000002', s.userId);
    const c3 = await contact('+525540000003', null);
    const c4 = await contact('+525540000004', r.userId);
    const rt = await joined(r.cookie, ws);
    const st = await joined(s.cookie, ws);
    const ot = await joined(owner.cookie, ws);
    expect((await env.api('POST', '/api/contacts/bulk', { action: 'delete', ids: [c1, c3, c4] }, owner)).status).toBe(200);
    expect((await env.api('DELETE', `/api/contacts/${c2}`, undefined, owner)).status).toBe(204);
    await sleep(200);
    const ids = (t: typeof rt) => t.events.filter((e) => e.event === 'contacts:bulk').flatMap((e) => e.data.ids);
    expect(ids(rt).sort()).toEqual([c3, c4].sort());
    expect(ids(st).sort()).toEqual([c1, c2, c3].sort());
    expect(ids(ot).sort()).toEqual([c1, c2, c3, c4].sort());
  });

  it('#33 an event about a contact that no longer exists reaches no restricted agent', async () => {
    const rt = await joined(r.cookie, ws);
    const gone = crypto.randomUUID();
    expect(await env.built.ctx.realtime.resolveAssignee!(gone)).toBe(undefined);
    env.built.ctx.realtime.emit(ws, 'message:new', { id: crypto.randomUUID(), contact_id: gone, body: 'mi tarjeta es 4111 1111 1111 1111' });
    const own = await contact('+525540000005', null);
    env.built.ctx.realtime.emit(ws, 'message:new', { id: crypto.randomUUID(), contact_id: own, body: 'visible' });
    await sleep(200);
    const bodies = rt.events.filter((e) => e.event === 'message:new').map((e) => e.data.body);
    expect(bodies).toEqual(['visible']);
  });
});

describe('#20 rights changes reach every tab of the user', () => {
  it('a role change in another workspace, a promotion to operator and a reactivation', async () => {
    const a = await env.register('dueno-a@r4.com', 'Negocio A');
    const x = await env.register('equis@r4.com', 'Negocio B');
    await env.built.ctx.db.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [a.workspaceId, x.userId]);
    const tab = await joined(x.cookie, x.workspaceId); // looking at B
    const refreshes = () => tab.events.filter((e) => e.event === 'session:refresh').length;

    expect((await env.api('PATCH', `/api/workspace/members/${x.userId}`, { role: 'agent' }, a)).status).toBe(200);
    await sleep(200);
    expect(refreshes()).toBe(1);

    expect((await env.api('PATCH', `/api/admin/users/${x.userId}`, { is_superadmin: true, currentPassword: PASSWORD }, op)).status).toBe(200);
    await sleep(200);
    expect(refreshes()).toBe(2);

    expect((await env.api('PATCH', `/api/admin/workspaces/${a.workspaceId}`, { is_active: false }, op)).status).toBe(200);
    await sleep(200);
    expect(refreshes()).toBe(3);
    expect((await env.api('PATCH', `/api/admin/workspaces/${a.workspaceId}`, { is_active: true }, op)).status).toBe(200);
    await sleep(200);
    expect(refreshes()).toBe(4);
    // The tab stays in B (a refresh re-joins it there).
    expect(tab.s.connected).toBe(true);

    // A demotion reaches a tab that joined no workspace too.
    const idle = listen(x.cookie);
    await new Promise<void>((resolve) => idle.s.on('connect', () => resolve()));
    expect((await env.api('PATCH', `/api/admin/users/${x.userId}`, { is_superadmin: false, currentPassword: PASSWORD }, op)).status).toBe(200);
    await sleep(200);
    expect(idle.events.map((e) => e.event)).toContain('session:refresh');
  });
});
