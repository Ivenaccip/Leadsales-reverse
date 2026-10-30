import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { exportPageSql } from '../routes/contacts.js';
import { createTagsByName, MAX_TAGS_PER_WORKSPACE } from '../routes/crm.js';
import { fakeFetch, setup, sleep, type TestEnv } from './helpers.js';

// Review round 5, routes and realtime: one test (or more) per finding, each failing without its fix.

const PHONE_ID = '1098765400501';
const WABA_ID = '2223334440501';
let platformType = 'NOT_APPLICABLE';
const meta = fakeFetch([
  (c) => (c.url.includes(`/${PHONE_ID}?fields=`) ? { json: { id: PHONE_ID, display_phone_number: '+52 55 1234 0501', platform_type: platformType } } : undefined),
  (c) => (c.url.endsWith(`/${WABA_ID}/subscribed_apps`) ? { json: { success: true } } : undefined),
  (c) => (c.url.includes(`/${WABA_ID}/phone_numbers`) ? { json: { data: [{ id: PHONE_ID }] } } : undefined),
  (c) => (c.url.includes(`/${WABA_ID}/message_templates?limit`) ? { json: { data: [] } } : undefined),
]);

const PASSWORD = 'secreto123';
let env: TestEnv;
let base: string;
let op: { cookie: string; userId: string; workspaceId: string };
let owner: { cookie: string; userId: string; workspaceId: string };
const sockets: Socket[] = [];

async function login(email: string, password = PASSWORD) {
  const r = await env.built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  if (r.statusCode !== 200) throw new Error(`login failed: ${r.body}`);
  return { cookie: `ll_token=${r.cookies.find((c) => c.name === 'll_token')!.value}`, userId: JSON.parse(r.body).user.id as string };
}

/** The ll_token a response set, as a Cookie header. */
function sessionCookie(headers: any): string {
  return String([headers['set-cookie']].flat().find((c) => String(c).startsWith('ll_token='))).split(';')[0];
}

function sidOf(cookie: string): string {
  return (jwt.decode(cookie.replace('ll_token=', '')) as { sid: string }).sid;
}

function listen(cookie: string, opts: { reconnection?: boolean } = {}) {
  const s = connect(base, {
    path: '/socket.io',
    extraHeaders: { cookie },
    transports: ['websocket'],
    reconnection: opts.reconnection ?? false,
    reconnectionDelay: 50,
    reconnectionDelayMax: 50,
  });
  sockets.push(s);
  const events: { event: string; data: any }[] = [];
  s.onAny((event, data) => events.push({ event, data }));
  return { s, events };
}

function join(s: Socket, workspaceId: string) {
  return new Promise<boolean>((r) => s.emit('join', workspaceId, (a: { ok: boolean }) => r(a.ok)));
}

async function joined(cookie: string, workspaceId: string, opts: { reconnection?: boolean } = {}) {
  const rt = listen(cookie, opts);
  await new Promise<void>((resolve, reject) => {
    rt.s.once('connect_error', reject);
    rt.s.once('connect', () => resolve());
  });
  expect(await join(rt.s, workspaceId)).toBe(true);
  return rt;
}

/** Runs `hook` once, right after the first db.query whose SQL matches (requests' plain queries). */
function afterQuery(match: (sql: string) => boolean, hook: () => Promise<void>) {
  const db = env.built.ctx.db as any;
  const original = db.query;
  let armed = true;
  db.query = async (sql: string, params?: unknown[]) => {
    const result = await original.call(db, sql, params);
    if (armed && match(sql)) {
      armed = false;
      await hook();
    }
    return result;
  };
  return () => {
    db.query = original;
  };
}

/** Counts the db.query calls whose SQL matches while `fn` runs. */
async function counting<T>(match: (sql: string) => boolean, fn: () => Promise<T>): Promise<{ out: T; n: number }> {
  const db = env.built.ctx.db as any;
  const original = db.query;
  let n = 0;
  db.query = async (sql: string, params?: unknown[]) => {
    if (match(sql)) n++;
    return original.call(db, sql, params);
  };
  try {
    return { out: await fn(), n };
  } finally {
    db.query = original;
  }
}

async function member(workspaceId: string, email: string, role: 'admin' | 'agent' = 'agent', password = PASSWORD) {
  const r = await env.api('POST', '/api/workspace/members', { email, name: email.split('@')[0], password, role }, { cookie: op.cookie, ws: workspaceId });
  if (r.status !== 200) throw new Error(`member failed: ${JSON.stringify(r.body)}`);
  return { ...(await login(email, password)), workspaceId };
}

const q = <T = any>(sql: string, params?: unknown[]) => env.built.ctx.db.query<T>(sql, params);

beforeAll(async () => {
  env = await setup({ fetch: meta.fetch });
  op = await env.register('op@r5.com', 'Operación'); // first account: instance operator
  owner = await env.register('owner@r5.com', 'Negocio R5');
  await env.built.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(env.built.app.server.address() as { port: number }).port}`;
});
afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await env.close();
});

describe('#8 a socket never outlives its session', () => {
  it('is ended when its token expires', async () => {
    const s = await member(owner.workspaceId, 'caduca@r5.com');
    // The same session, signed with a 2 s lifetime: stands for a token on its 30th day.
    const { uid, sid } = jwt.decode(s.cookie.replace('ll_token=', '')) as { uid: string; sid: string };
    const short = `ll_token=${jwt.sign({ uid, sid }, env.config.jwtSecret, { expiresIn: '2s' })}`;
    const rt = await joined(short, owner.workspaceId);
    await sleep(2600);
    expect((await env.api('GET', '/api/auth/me', undefined, { cookie: short, ws: null })).status).toBe(401);
    expect(rt.events.map((e) => e.event)).toContain('session:revoked');
    expect(rt.s.connected).toBe(false);
  });

  it('keeps a fresh 30-day session connected (its expiry timer does not overflow)', async () => {
    const rt = await joined(owner.cookie, owner.workspaceId);
    await sleep(300);
    expect(rt.s.connected).toBe(true);
    expect(rt.events.map((e) => e.event)).not.toContain('session:revoked');
    rt.s.disconnect();
  });

  it('a session row past 30 days counts as ended: HTTP refuses it and a join ends the socket', async () => {
    const s = await member(owner.workspaceId, 'vieja@r5.com');
    const rt = await joined(s.cookie, owner.workspaceId);
    await q(`UPDATE sessions SET created_at = now() - interval '31 days' WHERE id = $1`, [sidOf(s.cookie)]);
    expect((await env.api('GET', '/api/auth/me', undefined, { cookie: s.cookie, ws: null })).status).toBe(401);
    expect(await join(rt.s, owner.workspaceId)).toBe(false);
    await sleep(100);
    expect(rt.events.map((e) => e.event)).toContain('session:revoked');
    expect(rt.s.connected).toBe(false);
  });

  it('the periodic check ends sockets whose session row was deleted or revoked without an eviction', async () => {
    const a = await member(owner.workspaceId, 'borrada@r5.com');
    const b = await login('borrada@r5.com');
    const keep = await login('borrada@r5.com');
    const rtA = await joined(a.cookie, owner.workspaceId);
    const rtB = await joined(b.cookie, owner.workspaceId);
    const rtKeep = await joined(keep.cookie, owner.workspaceId);
    await q(`DELETE FROM sessions WHERE id = $1`, [sidOf(a.cookie)]);
    await q(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [sidOf(b.cookie)]);
    await env.built.ctx.realtime.sweepSessions();
    await sleep(100);
    for (const rt of [rtA, rtB]) {
      expect(rt.events.map((e) => e.event)).toContain('session:revoked');
      expect(rt.s.connected).toBe(false);
    }
    expect(rtKeep.s.connected).toBe(true);
    // and they hear nothing more of the workspace
    env.built.ctx.realtime.emit(owner.workspaceId, 'credits:update', { balance: 1 });
    await sleep(100);
    expect(rtA.events.map((e) => e.event)).not.toContain('credits:update');
    expect(rtKeep.events.map((e) => e.event)).toContain('credits:update');
    rtKeep.s.disconnect();
  });
});

describe('#32 a password change replaces the session it was made from', () => {
  it('a copy of the cookie stops working; the browser goes on with a new one and its tabs reconnect', async () => {
    const mine = await member(owner.workspaceId, 'copia@r5.com', 'admin');
    const copy = mine.cookie; // what an infostealer took from this browser
    const tab = await joined(mine.cookie, owner.workspaceId);
    const stolenTab = await joined(copy, owner.workspaceId, { reconnection: true });
    const closed = new Promise<string>((r) => tab.s.on('disconnect', r));
    const refused = new Promise<string>((r) => stolenTab.s.on('connect_error', (e) => r(e.message)));
    const change = await env.api('PATCH', '/api/auth/me', { currentPassword: PASSWORD, password: 'otraClave12345' }, { cookie: mine.cookie, ws: null });
    expect(change.status).toBe(200);
    const fresh = sessionCookie(change.headers);
    expect(fresh).toMatch(/^ll_token=./);
    expect(sidOf(fresh)).not.toBe(sidOf(copy));

    // The copy: refused everywhere, its socket cannot reconnect.
    const asCopy = { cookie: copy, ws: owner.workspaceId };
    expect((await env.api('GET', '/api/auth/me', undefined, asCopy)).status).toBe(401);
    expect((await env.api('POST', '/api/api-keys', { name: 'robada' }, asCopy)).status).toBe(401);
    expect(await refused).toBe('unauthorized');
    // This browser: its tab was closed to reconnect (not signed out), and the new cookie works.
    expect(await closed).toBe('transport close');
    expect(tab.events.map((e) => e.event)).not.toContain('session:revoked');
    expect((await env.api('GET', '/api/auth/me', undefined, { cookie: fresh, ws: null })).status).toBe(200);
    const again = await joined(fresh, owner.workspaceId);
    expect(again.s.connected).toBe(true);
    // The change was made with the right password, so it does not count against the new session.
    expect((await login('copia@r5.com', 'otraClave12345')).cookie).toBeTruthy();
    again.s.disconnect();
  });
});

describe('#21 operator rights change one at a time', () => {
  let b: { cookie: string; userId: string; workspaceId: string };

  async function operators() {
    return (await q<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE is_superadmin`)).rows[0].n;
  }
  const setOperator = (asWho: { cookie: string }, id: string, value: boolean) =>
    env.api('PATCH', `/api/admin/users/${id}`, { is_superadmin: value, currentPassword: PASSWORD }, { cookie: asWho.cookie, ws: null });

  beforeAll(async () => {
    b = await env.register('op2@r5.com', 'Operación 2');
  });

  it('two operators removing each other at once leave one operator', async () => {
    expect((await setOperator(op, b.userId, true)).status).toBe(200);
    expect(await operators()).toBe(2);
    const [ab, ba] = await Promise.all([setOperator(op, b.userId, false), setOperator(b, op.userId, false)]);
    expect([ab.status, ba.status].sort()).toEqual([200, 403]);
    expect(await operators()).toBe(1);
    const survivor = ab.status === 200 ? op : b;
    expect((await env.api('GET', '/api/admin/overview', undefined, { cookie: survivor.cookie, ws: null })).status).toBe(200);
    // Back to the starting point for the next tests (the operator is `op`).
    if (survivor === b) {
      expect((await setOperator(b, op.userId, true)).status).toBe(200);
      expect((await setOperator(op, b.userId, false)).status).toBe(200);
    }
    expect(await operators()).toBe(1);
  });

  it('an operator demoted while its request was in flight changes nobody', async () => {
    expect((await setOperator(op, b.userId, true)).status).toBe(200);
    const c = await env.register('candidato@r5.com', 'Candidato');
    // B's request has checked its rights; A's demotion of B commits before B's change runs.
    const restore = afterQuery(
      (sql) => sql.startsWith('SELECT is_superadmin FROM users WHERE id = $1'),
      async () => {
        await q(`UPDATE users SET is_superadmin = false WHERE id = $1`, [b.userId]);
      },
    );
    let r;
    try {
      r = await setOperator(b, c.userId, true);
    } finally {
      restore();
    }
    expect(r.status).toBe(403);
    expect((await q(`SELECT is_superadmin FROM users WHERE id = $1`, [c.userId])).rows[0].is_superadmin).toBe(false);
  });

  it("refuses to reset an account's password once it became an operator during the request", async () => {
    const c = await member(owner.workspaceId, 'ascendida@r5.com');
    const restore = afterQuery(
      (sql) => sql.startsWith('SELECT is_superadmin FROM users WHERE id = $1'),
      async () => {
        await q(`UPDATE users SET is_superadmin = true WHERE id = $1`, [c.userId]);
      },
    );
    let r;
    try {
      r = await env.api('POST', `/api/admin/users/${c.userId}/password`, { password: 'temporal12345', currentPassword: PASSWORD }, { cookie: op.cookie, ws: null });
    } finally {
      restore();
    }
    expect(r.status).toBe(400);
    expect((await env.api('GET', '/api/auth/me', undefined, { cookie: c.cookie, ws: null })).status).toBe(200);
    expect((await login('ascendida@r5.com')).cookie).toBeTruthy();
    await q(`UPDATE users SET is_superadmin = false WHERE id = $1`, [c.userId]);
  });
});

describe('#23 a number that is not registered on the Cloud API', () => {
  const connectBody = { provider: 'cloud_api', name: 'Oficial', phone_number_id: PHONE_ID, waba_id: WABA_ID, access_token: 'EAAG-token-de-prueba-0501', app_secret: 'secreto-de-app-0501' };

  it('is refused when connecting, with how to register it', async () => {
    platformType = 'NOT_APPLICABLE';
    const r = await env.api('POST', '/api/channels', connectBody, owner);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('PHONE_NOT_REGISTERED');
    expect(r.body.error.message).toContain('/register');
    expect((await q(`SELECT 1 FROM channels WHERE phone_number_id = $1`, [PHONE_ID])).rows).toHaveLength(0);
    platformType = 'ON_PREMISE';
    expect((await env.api('POST', '/api/channels', connectBody, owner)).body.error.code).toBe('PHONE_NOT_REGISTERED');
  });

  it('connects once registered, and the test reports it when it stops being so', async () => {
    platformType = 'CLOUD_API';
    const r = await env.api('POST', '/api/channels', connectBody, owner);
    expect(r.status).toBe(200);
    const id = r.body.channel.id;
    expect((await env.api('POST', `/api/channels/${id}/test`, undefined, owner)).body.ok).toBe(true);
    platformType = 'NOT_APPLICABLE';
    const t = await env.api('POST', `/api/channels/${id}/test`, undefined, owner);
    expect(t.body.ok).toBe(false);
    expect(t.body.error).toContain('no está registrado en la Cloud API');
    expect((await q(`SELECT last_error FROM channels WHERE id = $1`, [id])).rows[0].last_error).toContain('no está registrado');
    platformType = 'CLOUD_API';
    expect((await env.api('POST', `/api/channels/${id}/test`, undefined, owner)).body.ok).toBe(true);
    expect((await q(`SELECT last_error FROM channels WHERE id = $1`, [id])).rows[0].last_error).toBeNull();
  });
});

describe('#10 CSV import: the tags of one row are bounded and created in one statement', () => {
  const tagCount = async (prefix: string) =>
    (await q<{ n: number }>(`SELECT count(*)::int AS n FROM tags WHERE workspace_id = $1 AND name LIKE $2`, [owner.workspaceId, `${prefix}%`])).rows[0].n;

  it('reports a row with more than 50 tags as an error and creates none of them', async () => {
    const names = Array.from({ length: 60 }, (_, i) => `r5muchas${i}`).join(',');
    const r = await env.api('POST', '/api/contacts/import', { csv: `telefono,etiquetas\n+5215512300001,"${names}"\n+5215512300002,uno\n`, lossy: false }, owner);
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(1);
    expect(r.body.errors).toEqual([{ row: 2, error: 'Máximo 50 etiquetas por contacto' }]);
    expect(await tagCount('r5muchas')).toBe(0);
  });

  it('creates a row’s new tags with one query, counting spellings of a name once', async () => {
    const names = [...Array.from({ length: 50 }, (_, i) => `r5lote${i}`), 'R5LOTE0', 'r5lote1'].join(';');
    const { out, n } = await counting(
      (sql) => sql.startsWith('INSERT INTO tags'),
      () => env.api('POST', '/api/contacts/import', { csv: `telefono,etiquetas\n+5215512300003,"${names}"\n`, lossy: false }, owner),
    );
    expect(out.body.created).toBe(1);
    expect(n).toBe(1);
    expect(await tagCount('r5lote')).toBe(50);
    const c = (await env.api('GET', '/api/contacts?search=12300003', undefined, owner)).body.items[0];
    expect(c.tag_ids).toHaveLength(50);
  });

  it('a workspace holds at most MAX_TAGS_PER_WORKSPACE tags: imports, the public API and POST /api/tags stop there', async () => {
    const ws = await env.register('tope@r5.com', 'Tope de etiquetas');
    const count = async () => (await q<{ n: number }>(`SELECT count(*)::int AS n FROM tags WHERE workspace_id = $1`, [ws.workspaceId])).rows[0].n;
    await q(`INSERT INTO tags (workspace_id, name) SELECT $1, 'previa' || i FROM generate_series(1, $2::int - $3::int - 10) i`, [
      ws.workspaceId,
      MAX_TAGS_PER_WORKSPACE,
      await count(),
    ]);
    expect(await count()).toBe(MAX_TAGS_PER_WORKSPACE - 10);
    const cell = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(';');
    const csv = [
      'telefono,etiquetas',
      `+5215512300101,"${cell('caben', 6)}"`, // fits: 4 left
      `+5215512300102,"${cell('nocaben', 5)}"`, // 5 > 4: refused, nothing created
      `+5215512300103,"previa1;previa2"`, // existing tags only
      `+5215512300104,"${cell('justas', 4)}"`, // fills the workspace
      `+5215512300105,"otra"`,
    ].join('\n');
    const { out: r, n } = await counting(
      (sql) => sql.startsWith('INSERT INTO tags'),
      () => env.api('POST', '/api/contacts/import', { csv, lossy: false }, ws),
    );
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(3);
    expect(r.body.errors.map((e: { row: number }) => e.row)).toEqual([3, 6]);
    expect(r.body.errors[0].error).toContain(`máximo de ${MAX_TAGS_PER_WORKSPACE.toLocaleString('en-US')} etiquetas`);
    expect(n).toBe(2); // the rows that could not fit never got to the insert
    expect(await count()).toBe(MAX_TAGS_PER_WORKSPACE);

    const tag = await env.api('POST', '/api/tags', { name: 'una más' }, ws);
    expect(tag.status).toBe(400);
    expect(tag.body.error.code).toBe('TAG_LIMIT_REACHED');
    expect((await env.api('POST', '/api/tags', { name: 'previa1' }, ws)).status).toBe(200); // an existing one still answers
    const key = (await env.api('POST', '/api/api-keys', { name: 'tope' }, ws)).body.key;
    const asKey = { cookie: '', ws: null, headers: { authorization: `Bearer ${key}` } };
    const v1 = await env.api('POST', '/api/v1/contacts', { phone: '+5215512300106', tags: ['previa3', 'nueva'] }, asKey);
    expect(v1.status).toBe(400);
    expect(v1.body.error.code).toBe('TAG_LIMIT_REACHED');
    expect((await env.api('POST', '/api/v1/contacts', { phone: '+5215512300106', tags: ['previa3'] }, asKey)).status).toBe(200);
    expect(await count()).toBe(MAX_TAGS_PER_WORKSPACE);

    // Deleting one makes room again.
    const victim = (await q<{ id: string }>(`SELECT id FROM tags WHERE workspace_id = $1 AND name = 'previa9'`, [ws.workspaceId])).rows[0].id;
    expect((await env.api('DELETE', `/api/tags/${victim}`, undefined, ws)).status).toBe(204);
    expect((await env.api('POST', '/api/tags', { name: 'una más' }, ws)).status).toBe(200);
  });

  it('creates the names in one sorted order, so requests creating the same ones cannot lock each other', async () => {
    const seen: string[][] = [];
    const db = env.built.ctx.db as any;
    const original = db.query;
    db.query = async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('INSERT INTO tags') && sql.includes('unnest')) seen.push([...(params![1] as string[])]);
      return original.call(db, sql, params);
    };
    try {
      await createTagsByName(env.built.ctx.db, owner.workspaceId, ['r5orden-c', 'r5orden-a', 'r5orden-b', 'r5orden-a']);
    } finally {
      db.query = original;
    }
    expect(seen).toEqual([['r5orden-a', 'r5orden-b', 'r5orden-c']]);
  });

  it.skipIf(!process.env.TEST_DATABASE_URL)('two public-API calls creating the same 50 new tags in opposite orders both succeed (PostgreSQL)', async () => {
    const ws = await env.register('cruce@r5.com', 'Cruce de etiquetas');
    const key = (await env.api('POST', '/api/api-keys', { name: 'cruce' }, ws)).body.key;
    const asKey = { cookie: '', ws: null, headers: { authorization: `Bearer ${key}` } };
    const statuses: number[] = [];
    for (let round = 0; round < 30; round++) {
      const tags = Array.from({ length: 50 }, (_, i) => `cruce${round}-${i}`);
      const rs = await Promise.all([
        env.api('POST', '/api/v1/contacts', { phone: `+52155123${String(round).padStart(3, '0')}01`, tags }, asKey),
        env.api('POST', '/api/v1/contacts', { phone: `+52155123${String(round).padStart(3, '0')}02`, tags: [...tags].reverse() }, asKey),
      ]);
      statuses.push(...rs.map((r) => r.status));
    }
    expect(statuses.filter((s) => s !== 200)).toEqual([]);
  });
});

describe('#11 public API: the 50-tag cap holds after splitting', () => {
  let key: string;
  const asKey = () => ({ cookie: '', ws: null, headers: { authorization: `Bearer ${key}` } });

  beforeAll(async () => {
    key = (await env.api('POST', '/api/api-keys', { name: 'r5' }, owner)).body.key;
  });

  it('refuses more than 50 names once "a, b, c" strings are split, creating none', async () => {
    const tags = Array.from({ length: 50 }, (_, i) => `r5api${i}a, r5api${i}b, r5api${i}c`);
    const r = await env.api('POST', '/api/v1/contacts', { phone: '+5215512300010', tags }, asKey());
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('TOO_MANY_TAGS');
    expect((await q(`SELECT count(*)::int AS n FROM tags WHERE workspace_id = $1 AND name LIKE 'r5api%'`, [owner.workspaceId])).rows[0].n).toBe(0);
  });

  it('resolves and creates the names with a fixed number of queries', async () => {
    await env.api('POST', '/api/tags', { name: 'r5ya' }, owner);
    const tags = ['r5ya', ...Array.from({ length: 24 }, (_, i) => `r5nueva${i}`), 'r5nueva0, r5nueva1'];
    const { out, n } = await counting(
      (sql) => /\btags\b/.test(sql) && !sql.includes('contact_tags'),
      () => env.api('POST', '/api/v1/contacts', { phone: '+5215512300011', tags }, asKey()),
    );
    expect(out.status).toBe(200);
    expect(out.body.contact.tag_ids).toHaveLength(25);
    // legacy "a, b" names, the existing ones, the room left in the workspace, the insert
    expect(n).toBeLessThanOrEqual(4);
  });
});

describe('#12 CSV export is read in pages and streamed', () => {
  it('exports every contact through keyset pages, in phone order', async () => {
    const ws = await env.register('export@r5.com', 'Exportadora');
    // One statement: every row gets the same created_at, so pages must break ties by id.
    await q(
      `INSERT INTO contacts (workspace_id, phone, name) SELECT $1, '52155' || lpad(i::text, 8, '0'), 'Cliente ' || i FROM generate_series(1, 1201) i`,
      [ws.workspaceId],
    );
    const { out, n } = await counting(
      (sql) => sql.includes('FROM contacts c') && /LIMIT \d+/.test(sql),
      () => env.api('GET', '/api/contacts/export.csv', undefined, ws),
    );
    expect(out.status).toBe(200);
    expect(out.headers['content-type']).toContain('text/csv');
    expect(n).toBe(3);
    const lines = out.raw.replace(/^﻿/, '').trim().split('\n');
    expect(lines[0]).toBe('"telefono","nombre","correo","empresa","embudo","etapa","asignado_a","etiquetas","valor","origen","creado","ultimo_mensaje","campos"');
    expect(lines).toHaveLength(1202);
    const phones = lines.slice(1).map((l) => l.split(',')[0]);
    expect(new Set(phones).size).toBe(1201);
    expect(phones).toEqual([...phones].sort());
    // the file still imports back as before
    const empty = await env.api('GET', '/api/contacts/export.csv?search=nadie-se-llama-asi', undefined, ws);
    expect(empty.raw.replace(/^﻿/, '').trim().split('\n')).toHaveLength(1);
  });

  it('reads each page from the (workspace_id, phone) index instead of sorting what is left of the workspace', async () => {
    const ws = await env.register('plan@r5.com', 'Plan de exportación');
    await q(
      `INSERT INTO contacts (workspace_id, phone, name, created_at) SELECT $1, '52156' || lpad(i::text, 8, '0'), 'Cliente ' || i, now() - (i || ' seconds')::interval
       FROM generate_series(1, 3000) i`,
      [ws.workspaceId],
    );
    await q('ANALYZE contacts');
    // The filter of a plain export (buildWhere's default); with a sequential scan ruled out, an
    // order no index gives needs a Sort over every remaining contact of the workspace, page after page.
    const plan = await env.built.ctx.db.tx(async (tq) => {
      await tq.query('SET LOCAL enable_seqscan = off');
      const r = await tq.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${exportPageSql('c.workspace_id = $1 AND NOT c.is_archived', '$2')}`, [
        ws.workspaceId,
        '5215600001500',
      ]);
      const raw = r.rows[0]['QUERY PLAN'];
      return (typeof raw === 'string' ? JSON.parse(raw) : raw) as { Plan: PlanNode }[];
    });
    type PlanNode = { 'Node Type': string; 'Index Name'?: string; 'Relation Name'?: string; Plans?: PlanNode[] };
    const nodes: PlanNode[] = [];
    const walk = (n: PlanNode) => {
      nodes.push(n);
      for (const c of n.Plans ?? []) walk(c);
    };
    walk(plan[0].Plan);
    expect(nodes.filter((n) => n['Node Type'].includes('Sort'))).toEqual([]);
    expect(nodes.find((n) => n['Relation Name'] === 'contacts')?.['Index Name']).toBe('contacts_workspace_id_phone_key');
  });
});

describe('#34 custom fields have one set of limits everywhere', () => {
  const asOwner = () => owner;
  const tooBig = [
    { [`k${'x'.repeat(100)}`]: 'largo' },
    { campo: 'v'.repeat(1001) },
    { anidado: { a: 1 } },
    Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`c${i}`, 'v'])),
    Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`c${i}`, 'v'.repeat(1000)])), // ~70 KB
  ];

  it('POST and PATCH /api/contacts refuse fields over the limits', async () => {
    for (const custom_fields of tooBig) {
      expect((await env.api('POST', '/api/contacts', { phone: '+5215512300020', custom_fields }, asOwner())).status).toBe(400);
    }
    const ok = await env.api('POST', '/api/contacts', { phone: '+5215512300020', custom_fields: { ciudad: 'Puebla', visitas: 3, vip: true, nota: null } }, asOwner());
    expect(ok.status).toBe(200);
    for (const custom_fields of tooBig) {
      expect((await env.api('PATCH', `/api/contacts/${ok.body.contact.id}`, { custom_fields }, asOwner())).status).toBe(400);
    }
    expect((await env.api('GET', `/api/contacts/${ok.body.contact.id}`, undefined, asOwner())).body.contact.custom_fields).toEqual({ ciudad: 'Puebla', visitas: 3, vip: true, nota: null });
  });

  it('the public API applies them, also to the fields it merges into the stored ones', async () => {
    const key = (await env.api('POST', '/api/api-keys', { name: 'r5-campos' }, owner)).body.key;
    const opts = { cookie: '', ws: null, headers: { 'x-api-key': key } };
    expect((await env.api('POST', '/api/v1/contacts', { phone: '+5215512300021', custom_fields: { campo: 'v'.repeat(1001) } }, opts)).status).toBe(400);
    const first = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`a${i}`, 'v']));
    expect((await env.api('POST', '/api/v1/contacts', { phone: '+5215512300021', custom_fields: first }, opts)).status).toBe(200);
    const second = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`b${i}`, 'v']));
    const merged = await env.api('POST', '/api/v1/contacts', { phone: '+5215512300021', custom_fields: second }, opts);
    expect(merged.status).toBe(400);
    expect(merged.body.error.message).toContain('Máximo 100 campos');
  });

  it('the CSV import refuses long column names and huge records, and reports oversized rows', async () => {
    const long = await env.api('POST', '/api/contacts/import', { csv: `telefono,"${'n'.repeat(101)}"\n+5215512300030,x\n`, lossy: false }, asOwner());
    expect(long.status).toBe(400);
    expect(long.body.error.code).toBe('CSV_HEADER_TOO_LONG');
    // A quoted header of 1 MB is refused while parsing, before it becomes any row's key.
    const t0 = performance.now();
    const huge = await env.api('POST', '/api/contacts/import', { csv: `"${'h'.repeat(1_000_000)}",telefono\nx,+5215512300031\n`, lossy: false }, asOwner());
    expect(huge.status).toBe(400);
    expect(huge.body.error.code).toBe('CSV_RECORD_TOO_LARGE');
    expect(performance.now() - t0).toBeLessThan(2000);
    expect((await q(`SELECT 1 FROM contacts WHERE phone = '5215512300031'`)).rows).toHaveLength(0);

    const rows = await env.api('POST', '/api/contacts/import', { csv: `telefono,nota\n+5215512300032,${'v'.repeat(1001)}\n+5215512300033,corta\n`, lossy: false }, asOwner());
    expect(rows.body.created).toBe(1);
    expect(rows.body.errors).toHaveLength(1);
    expect(rows.body.errors[0].row).toBe(2);
    expect(rows.body.errors[0].error).toContain('1000 caracteres');
  });
});
