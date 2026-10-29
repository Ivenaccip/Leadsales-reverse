import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hmacSha256Hex } from '../lib/crypto.js';
import { isPrivateIp, publicOnlyLookup } from '../lib/net.js';
import { processInboundMessage } from '../whatsapp/inbound.js';
import { fakeFetch, setup, type TestEnv } from './helpers.js';

// Two businesses, each with its own Meta app (different tokens and app secrets).
const A = { phone: '1111111111111', waba: '2111111111111', token: 'EAAG-token-of-business-A-xxxxxxxx', secret: 'secret-of-business-A-123456' };
const B = { phone: '3333333333333', waba: '4333333333333', token: 'EAAG-token-of-business-B-xxxxxxxx', secret: 'secret-of-business-B-123456' };

const meta = fakeFetch([
  (c) => {
    const auth = c.headers.authorization;
    for (const t of [A, B]) {
      if (auth !== `Bearer ${t.token}`) continue;
      if (c.url.includes(`/${t.phone}?fields=`)) return { json: { id: t.phone, display_phone_number: `+${t.phone}` } };
      if (c.url.includes(`/${t.waba}/phone_numbers`)) return { json: { data: [{ id: t.phone }] } };
      if (c.url.endsWith(`/${t.waba}/subscribed_apps`)) return { json: { success: true } };
      if (c.url.includes(`/${t.waba}/message_templates`)) return { json: { data: [] } };
      if (c.url.endsWith(`/${t.phone}/messages`)) return { json: { messages: [{ id: `wamid.${t.phone}.${meta.calls.length}` }] } };
    }
    // A token asking about a number it does not own
    if (c.url.includes('?fields=')) return { status: 400, json: { error: { message: 'Unsupported get request', code: 100 } } };
    if (c.url.includes('/phone_numbers')) return { status: 403, json: { error: { message: 'Permission denied', code: 10 } } };
    return undefined;
  },
  (c) => (c.url.startsWith('https://93.184.216.34/redirect') ? { status: 302, json: {}, headers: { location: 'http://169.254.169.254/' } } : undefined),
]);

let env: TestEnv;
let ownerA: { cookie: string; workspaceId: string };
let ownerB: { cookie: string; workspaceId: string };

function envelope(phoneNumberId: string, wabaId: string, value: Record<string, unknown>) {
  return {
    entry: [{ id: wabaId, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId }, ...value } }] }],
  };
}

async function postSigned(payload: unknown, secret: string) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', ...(payload as object) });
  return env.built.app.inject({
    method: 'POST',
    url: '/webhooks/whatsapp',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${hmacSha256Hex(secret, raw)}` },
    payload: raw,
  });
}

const textMsg = (from: string, id: string, body: string) => ({
  contacts: [{ wa_id: from, profile: { name: 'X' } }],
  messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
});

beforeAll(async () => {
  env = await setup({ fetch: meta.fetch });
  ownerA = await env.register('a@biz.com', 'Negocio A');
  ownerB = await env.register('b@biz.com', 'Negocio B');
  const ca = await env.api('POST', '/api/channels', { provider: 'cloud_api', phone_number_id: A.phone, waba_id: A.waba, access_token: A.token, app_secret: A.secret }, ownerA);
  expect(ca.status).toBe(200);
  const cb = await env.api('POST', '/api/channels', { provider: 'cloud_api', phone_number_id: B.phone, waba_id: B.waba, access_token: B.token, app_secret: B.secret }, ownerB);
  expect(cb.status).toBe(200);
});
afterAll(() => env.close());

describe('channel ownership', () => {
  it("cannot register another business's number or WABA", async () => {
    // B's token does not control A's number
    const squat = await env.api('POST', '/api/channels', { provider: 'cloud_api', phone_number_id: '5555555555555', waba_id: A.waba, access_token: B.token, app_secret: B.secret }, ownerB);
    expect(squat.status).toBe(400);
    // B's own number claimed under A's WABA
    const mixed = await env.api('POST', '/api/channels', { provider: 'cloud_api', phone_number_id: B.phone, waba_id: A.waba, access_token: B.token, app_secret: B.secret }, ownerB);
    expect(mixed.status).toBe(409); // number already connected
    const other = await env.register('c@biz.com', 'Negocio C');
    const wrongWaba = await env.api('POST', '/api/channels', { provider: 'cloud_api', phone_number_id: '6666666666666', waba_id: B.waba, access_token: B.token, app_secret: B.secret }, other);
    expect(wrongWaba.status).toBe(400);
  });

  it('only the instance operator manages official numbers of prepaid workspaces', async () => {
    const c = await env.register('d@biz.com', 'Negocio prepagado');
    await env.api('PATCH', `/api/admin/workspaces/${c.workspaceId}`, { billing_mode: 'prepaid' }, ownerA);
    const r = await env.api('POST', '/api/channels', { provider: 'cloud_api', phone_number_id: '7777777777777', waba_id: '8777777777777', access_token: 'EAAG-x-xxxxxxxxxxxxxxxxxx', app_secret: 'zzzzzzzzzzzzzzzzzz' }, c);
    expect(r.status).toBe(403);
  });
});

describe('webhook forgery', () => {
  it("rejects a payload for A's number signed with B's secret", async () => {
    const r = await postSigned(envelope(A.phone, A.waba, textMsg('5215500000001', 'wamid.FORGED1', 'mensaje inyectado')), B.secret);
    expect(r.statusCode).toBe(401);
  });

  it("drops A's entries hidden in a payload signed by B", async () => {
    const payload = {
      entry: [
        ...envelope(B.phone, B.waba, textMsg('5215500000002', 'wamid.B-OWN', 'legítimo de B')).entry,
        ...envelope(A.phone, A.waba, textMsg('5215500000003', 'wamid.FORGED2', 'inyectado en A')).entry,
      ],
    };
    const r = await postSigned(payload, B.secret);
    expect(r.statusCode).toBe(200);
    await env.drain();
    const aMsgs = await env.built.ctx.db.query(`SELECT body FROM messages WHERE workspace_id = $1`, [ownerA.workspaceId]);
    expect(aMsgs.rows.map((m: any) => m.body)).not.toContain('inyectado en A');
    const bMsgs = await env.built.ctx.db.query(`SELECT body FROM messages WHERE workspace_id = $1`, [ownerB.workspaceId]);
    expect(bMsgs.rows.map((m: any) => m.body)).toContain('legítimo de B');
  });

  it('accepts genuine payloads signed with the channel secret', async () => {
    const r = await postSigned(envelope(A.phone, A.waba, textMsg('5215500000004', 'wamid.A-OWN', 'legítimo de A')), A.secret);
    expect(r.statusCode).toBe(200);
    await env.drain();
    const aMsgs = await env.built.ctx.db.query(`SELECT body FROM messages WHERE workspace_id = $1`, [ownerA.workspaceId]);
    expect(aMsgs.rows.map((m: any) => m.body)).toContain('legítimo de A');
  });

  it('keeps WhatsApp message ids independent per workspace', async () => {
    const chA = (await env.built.ctx.db.query(`SELECT * FROM channels WHERE phone_number_id = $1`, [A.phone])).rows[0];
    const chB = (await env.built.ctx.db.query(`SELECT * FROM channels WHERE phone_number_id = $1`, [B.phone])).rows[0];
    const msg = { from: '5215500000009', id: 'wamid.SAME-ID', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'x' } };
    expect(await processInboundMessage(env.built.ctx, chB, msg)).not.toBeNull();
    expect(await processInboundMessage(env.built.ctx, chA, msg)).not.toBeNull();
  });
});

describe('media served safely', () => {
  it('downloads active content (SVG) instead of rendering it', async () => {
    const { saveMedia } = await import('../services/media.js');
    const svg = await saveMedia(env.built.ctx, ownerA.workspaceId, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml', 'x.svg');
    const r = await env.api('GET', `/api/media/${svg.id}`, undefined, ownerA);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['content-disposition']).toMatch(/^attachment/);
    expect(r.headers['content-security-policy']).toContain('sandbox');
    const other = await env.api('GET', `/api/media/${svg.id}`, undefined, ownerB);
    expect(other.status).toBe(404);
  });
});

describe('cross-tenant actions', () => {
  it("cannot cancel another workspace's broadcast", async () => {
    const sb = await env.api('POST', '/api/channels', { provider: 'sandbox', name: 'S' }, ownerA);
    expect(sb.status).toBe(200);
    await env.api('POST', '/api/contacts', { phone: '5255123400', name: 'Cliente A' }, ownerA);
    const b = await env.api(
      'POST',
      '/api/broadcasts',
      { name: 'x', channel_id: sb.body.channel.id, template_name: 'seguimiento', template_language: 'es_MX', params: { body: ['{nombre}'] }, scheduled_at: new Date(Date.now() + 3600_000).toISOString() },
      ownerA,
    );
    await env.api('POST', `/api/broadcasts/${b.body.broadcast.id}/launch`, undefined, ownerA);
    const attack = await env.api('POST', `/api/broadcasts/${b.body.broadcast.id}/cancel`, undefined, ownerB);
    expect(attack.status).toBe(404);
    const rec = await env.built.ctx.db.query(`SELECT status FROM broadcast_recipients WHERE broadcast_id = $1`, [b.body.broadcast.id]);
    expect(rec.rows.every((r: any) => r.status === 'queued')).toBe(true);
    await env.api('POST', `/api/broadcasts/${b.body.broadcast.id}/cancel`, undefined, ownerA);
  });

  it("cannot attach another workspace's file to a quick reply", async () => {
    const { saveMedia } = await import('../services/media.js');
    const f = await saveMedia(env.built.ctx, ownerA.workspaceId, Buffer.from('x'), 'image/png', 'a.png');
    const r = await env.api('POST', '/api/quick-replies', { shortcut: 'robo', body: 'x', media_file_id: f.id }, ownerB);
    expect(r.status).toBe(404);
  });
});

describe('broadcasts never run twice', () => {
  it('sends each recipient once even if two runs overlap', async () => {
    const { rows } = await env.built.ctx.db.query(`SELECT id FROM channels WHERE workspace_id = $1 AND provider = 'sandbox'`, [ownerA.workspaceId]);
    for (const p of ['5255000101', '5255000102', '5255000103']) await env.api('POST', '/api/contacts', { phone: p, name: 'Dup' }, ownerA);
    const tag = (await env.api('POST', '/api/tags', { name: 'Doble' }, ownerA)).body.tag;
    const list = (await env.api('GET', '/api/contacts?search=Dup', undefined, ownerA)).body.items;
    await env.api('POST', '/api/contacts/bulk', { ids: list.map((c: any) => c.id), action: 'add_tags', tag_ids: [tag.id] }, ownerA);
    const b = await env.api(
      'POST',
      '/api/broadcasts',
      { name: 'doble', channel_id: rows[0].id, template_name: 'seguimiento', template_language: 'es_MX', params: { body: ['{nombre}'] }, audience: { tag_ids: [tag.id] }, scheduled_at: new Date(Date.now() + 3600_000).toISOString() },
      ownerA,
    );
    const id = b.body.broadcast.id;
    expect((await env.api('POST', `/api/broadcasts/${id}/launch`, undefined, ownerA)).body.broadcast.status).toBe('scheduled');
    expect((await env.api('POST', `/api/broadcasts/${id}/pause`, undefined, ownerA)).body.broadcast.status).toBe('paused');
    const second = await env.api('POST', `/api/broadcasts/${id}/launch`, undefined, ownerA);
    expect(second.body.broadcast.status).toBe('scheduled');
    // one queued job only (dedupe), but force an overlapping second run anyway
    const jobs = await env.built.ctx.db.query(`SELECT count(*)::int AS n FROM jobs WHERE type = 'broadcast.process' AND status = 'queued' AND payload->>'broadcastId' = $1`, [id]);
    expect(jobs.rows[0].n).toBe(1);
    await env.built.ctx.queue.enqueue('broadcast.process', { broadcastId: id });
    // A scheduled broadcast never starts before its time, whatever its jobs say: make it due too.
    await env.built.ctx.db.query(`UPDATE broadcasts SET scheduled_at = now() WHERE id = $1`, [id]);
    await env.built.ctx.db.query(`UPDATE jobs SET run_at = now() WHERE status = 'queued'`);
    await env.drain();
    const msgs = await env.built.ctx.db.query(`SELECT contact_id, count(*)::int AS n FROM messages WHERE broadcast_id = $1 GROUP BY contact_id`, [id]);
    expect(msgs.rows).toHaveLength(3);
    expect(msgs.rows.every((r: any) => r.n === 1)).toBe(true);
    const charges = await env.built.ctx.db.query(`SELECT count(*)::int AS n FROM credit_ledger WHERE broadcast_id = $1 AND kind = 'charge'`, [id]);
    expect(charges.rows[0].n).toBe(3);
    expect((await env.api('GET', `/api/broadcasts/${id}`, undefined, ownerA)).body.broadcast.status).toBe('completed');
  });
});

describe('restricted agents', () => {
  it('cannot reach conversations assigned to others through bulk, scheduled or ledger', async () => {
    await env.api('POST', '/api/workspace/members', { email: 'ag1@biz.com', name: 'Ag1', password: 'agente1234', role: 'agent' }, ownerA);
    const ag2 = await env.api('POST', '/api/workspace/members', { email: 'ag2@biz.com', name: 'Ag2', password: 'agente1234', role: 'agent' }, ownerA);
    await env.api('PUT', '/api/workspace/settings', { agent_visibility: 'assigned' }, ownerA);
    const login = await env.built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ag1@biz.com', password: 'agente1234' } });
    const ag1 = { cookie: `ll_token=${login.cookies[0].value}`, ws: ownerA.workspaceId };
    const ag1Id = JSON.parse(login.body).user.id;
    const secret = (await env.api('POST', '/api/contacts', { phone: '5255777001', name: 'De Ag2', assigned_user_id: ag2.body.id }, ownerA)).body.contact;
    // the owner schedules something for that contact
    const ch = (await env.built.ctx.db.query(`SELECT id FROM channels WHERE workspace_id = $1 AND provider = 'sandbox'`, [ownerA.workspaceId])).rows[0];
    // A real lead (stored as 52 + 5255777001): the sandbox simulator refuses to write into it.
    expect((await env.api('POST', `/api/channels/${ch.id}/simulate`, { from: '525255777001', text: 'hola' }, ownerA)).status).toBe(409);
    await env.api('POST', `/api/contacts/${secret.id}/scheduled`, { send_at: new Date(Date.now() + 3600_000).toISOString(), content: { type: 'text', text: 'privado' } }, ownerA);

    const sched = await env.api('GET', '/api/scheduled', undefined, ag1);
    expect(sched.body.scheduled.map((s: any) => s.contact_id)).not.toContain(secret.id);
    const bulk = await env.api('POST', '/api/contacts/bulk', { ids: [secret.id], action: 'assign', user_id: ag1Id }, ag1);
    expect(bulk.body.updated).toBe(0);
    const still = (await env.api('GET', `/api/contacts/${secret.id}`, undefined, ownerA)).body.contact;
    expect(still.assigned_user_id).toBe(ag2.body.id);
    expect((await env.api('GET', '/api/credits/ledger', undefined, ag1)).status).toBe(403);
    await env.api('PUT', '/api/workspace/settings', { agent_visibility: 'all' }, ownerA);
  });
});

describe('suspended workspaces', () => {
  it('cannot send through the API or the inbox', async () => {
    const c = await env.register('susp@biz.com', 'Suspendido');
    await env.api('POST', '/api/channels', { provider: 'sandbox', name: 'S' }, c);
    const key = (await env.api('POST', '/api/api-keys', { name: 'k' }, c)).body.key;
    await env.api('PATCH', `/api/admin/workspaces/${c.workspaceId}`, { is_active: false }, ownerA);
    const r = await env.api('POST', '/api/v1/messages', { phone: '5255000999', template: { name: 'seguimiento', language: 'es_MX', body: ['x'] } }, { cookie: '', ws: null, headers: { authorization: `Bearer ${key}` } });
    expect(r.status).toBe(403);
    const ui = await env.api('GET', '/api/contacts', undefined, c);
    expect(ui.status).toBe(403);
  });
});

describe('login rate limit', () => {
  it('cannot be bypassed by rotating X-Forwarded-For from a direct client', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const r = await env.built.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '203.0.113.50',
        headers: { 'x-forwarded-for': `198.51.100.${i}` },
        payload: { email: 'a@biz.com', password: 'mala' },
      });
      last = r.statusCode;
    }
    expect(last).toBe(429);
  });

  it('limits guesses per account across many IPs', async () => {
    let last = 0;
    for (let i = 0; i < 32; i++) {
      const r = await env.built.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: `203.0.113.${100 + i}`, payload: { email: 'b@biz.com', password: 'mala' } });
      last = r.statusCode;
    }
    expect(last).toBe(429);
  });
});

describe('outgoing webhooks', () => {
  it('blocks private, mapped, NAT64 and 6to4 addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::1', 'fd00::1', 'fe80::1', '::127.0.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '93.184.216.34', '2001:4860:4860::8888', '::ffff:8.8.8.8']) expect(isPrivateIp(ip), ip).toBe(false);
  });

  it('refuses hostnames that resolve to private addresses at connect time', async () => {
    const err = await new Promise<any>((resolve) => publicOnlyLookup('localhost', {}, (e) => resolve(e)));
    expect(err?.code).toBe('EPRIVATE');
  });

  it('does not follow redirects', async () => {
    const w = await env.api('POST', '/api/webhooks', { url: 'https://93.184.216.34/redirect', events: ['*'] }, ownerA);
    await env.api('POST', `/api/webhooks/${w.body.webhook.id}/test`, undefined, ownerA);
    await env.drain();
    const call = meta.calls.find((c) => c.url === 'https://93.184.216.34/redirect');
    expect(call).toBeTruthy();
    expect(meta.calls.some((c) => c.url.includes('169.254.169.254'))).toBe(false);
    const hooks = (await env.api('GET', '/api/webhooks', undefined, ownerA)).body.webhooks;
    expect(hooks.find((h: any) => h.id === w.body.webhook.id).last_error).toMatch(/redirecciones/);
  });
});

describe('CSV export', () => {
  it('neutralizes spreadsheet formulas in user-controlled fields', async () => {
    await env.api('POST', '/api/contacts', { phone: '5255888001', name: '=HYPERLINK("http://evil","clic")' }, ownerA);
    const r = await env.api('GET', '/api/contacts/export.csv', undefined, ownerA);
    expect(r.raw).toContain(`"'=HYPERLINK(""http://evil"",""clic"")"`);
  });
});
