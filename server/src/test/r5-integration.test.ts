import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { splitSql } from '../db/index.js';
import { migrations } from '../db/migrations.js';
import { encryptJson, hmacSha256Hex } from '../lib/crypto.js';
import { upsertTemplate } from '../services/templates.js';
import type { ChannelRow } from '../types.js';
import { fakeFetch, setup, type FakeCall, type TestEnv } from './helpers.js';

// Round 5, what joins the groups' fixes: the legacy number on the send path, numbers learned from
// echoes and notices, funnel teams, the menu's next key, template bounds, Meta's subcode, and 007's data.

const PHONE_A = '1098765400071';
const PHONE_B = '1098765400072';
const WABA_ID = '2223334400071';
const SECRET_B = 'secret-r5-integration-b-0123456789';

type Reply = { status?: number; json?: unknown } | undefined;
let onSend: (call: FakeCall) => Reply = () => undefined;
let sent = 0;

const meta = fakeFetch([
  (c) => {
    if (!c.url.endsWith('/messages') || c.body?.status === 'read') return undefined;
    return onSend(c) ?? { json: { messaging_product: 'whatsapp', contacts: [{ input: c.body.to, wa_id: c.body.to }], messages: [{ id: `wamid.R5I.OUT.${++sent}` }] } };
  },
]);

let env: TestEnv;
let ws: string;
let userId: string;
let chA: ChannelRow;
let chB: ChannelRow;

const q = (sql: string, params: unknown[] = []) => env.built.ctx.db.query<any>(sql, params);
const sends = () => meta.calls.filter((c) => c.url.endsWith('/messages') && c.body?.status !== 'read');
let seq = 0;

async function cloudChannel(phoneId: string, isDefault: boolean, appSecret: string): Promise<ChannelRow> {
  const { rows } = await q(
    `INSERT INTO channels (workspace_id, provider, name, phone_number_id, waba_id, credentials, verify_token, is_default, operator_verified)
     VALUES ($1, 'cloud_api', $2, $2, $3, $4, 'vt-r5i', $5, true) RETURNING *`,
    [ws, phoneId, WABA_ID, encryptJson(env.built.ctx.config.encryptionKey, { accessToken: 'EAAG-test-token', appSecret }), isDefault],
  );
  return rows[0];
}

/** A contact as stored by hand (or by an older version), with an inbound message on `channelId`. */
async function storedContact(o: { phone: string; waId?: string | null; channelId?: string | null; messageOn?: string | null; inbound?: boolean }) {
  const { rows } = await q(
    `INSERT INTO contacts (workspace_id, phone, wa_id, name, channel_id, last_inbound_at, last_message_at)
     VALUES ($1, $2, $3, 'Cliente', $4, CASE WHEN $5 THEN now() END, now()) RETURNING *`,
    [ws, o.phone, o.waId ?? null, o.channelId ?? null, o.inbound ?? true],
  );
  const c = rows[0];
  if (o.messageOn !== undefined) {
    await q(
      `INSERT INTO messages (workspace_id, contact_id, channel_id, direction, type, body, wamid, status, created_at)
       VALUES ($1, $2, $3, 'in', 'text', 'Hola', $4, 'received', now() - interval '1 minute')`,
      [ws, c.id, o.messageOn, `wamid.R5I.IN.${++seq}`],
    );
  }
  return c;
}

async function post(phoneId: string, secret: string, field: string, value: unknown) {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: WABA_ID, changes: [{ field, value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneId }, ...(value as object) } }] }] });
  const res = await env.built.app.inject({
    method: 'POST',
    url: '/webhooks/whatsapp',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${hmacSha256Hex(secret, body)}` },
    payload: body,
  });
  expect(res.statusCode).toBe(200);
  await env.drain();
}

beforeAll(async () => {
  env = await setup({ fetch: meta.fetch });
  const reg = await env.register('r5-integration@test.com');
  ws = reg.workspaceId;
  userId = reg.userId;
  await q(`UPDATE channels SET is_default = false WHERE workspace_id = $1`, [ws]);
  chA = await cloudChannel(PHONE_A, true, 'secret-r5-integration-a-0123456789');
  chB = await cloudChannel(PHONE_B, false, SECRET_B);
});

afterAll(async () => {
  await env?.close();
});

beforeEach(() => {
  onSend = () => undefined;
  meta.calls.length = 0;
});

describe('a contact an old version stored under the country code + a 10-digit wa_id (#1)', () => {
  it('is answered and priced on its real WhatsApp id, even when 007 could not repair it', async () => {
    // Another contact already holds the real number, so the migration left the legacy row as it was.
    await storedContact({ phone: '6591234567', inbound: false });
    const legacy = await storedContact({ phone: '526591234567', waId: '6591234567', channelId: chA.id, messageOn: chA.id });
    const r = await env.api('POST', `/api/contacts/${legacy.id}/messages`, { type: 'text', text: 'Hola, aquí seguimos' });
    expect(r.status).toBe(200);
    expect(sends().map((c) => c.body.to)).toEqual(['6591234567']);

    await upsertTemplate(env.built.ctx.db, chA, { meta_id: 'tpl-r5i-promo', name: 'promo', language: 'es_MX', category: 'MARKETING', status: 'APPROVED', components: [{ type: 'BODY', text: 'Promo' }] });
    const e = await env.api('POST', '/api/broadcasts/estimate', { template_name: 'promo', template_language: 'es_MX', audience: { contact_ids: [legacy.id] } });
    expect(e.status).toBe(200);
    expect(e.body.estimate.by_market.map((m: any) => m.market)).toEqual(['OTHER']);
  });

  it('a Mexican number typed into the sandbox keeps its phone', async () => {
    const typed = await storedContact({ phone: '525512345601', waId: '5512345601', channelId: chA.id, messageOn: chA.id });
    const r = await env.api('POST', `/api/contacts/${typed.id}/messages`, { type: 'text', text: 'Hola' });
    expect(r.status).toBe(200);
    expect(sends().map((c) => c.body.to)).toEqual(['525512345601']);
  });
});

describe('a conversation whose number was deleted learns it from the business app and from notices', () => {
  it("a reply typed in the WhatsApp Business app binds the contact to that app's number", async () => {
    const c = await storedContact({ phone: '525511100001', waId: '525511100001', channelId: null, messageOn: null });
    await post(PHONE_B, SECRET_B, 'smb_message_echoes', {
      message_echoes: [{ from: PHONE_B, to: '525511100001', id: `wamid.R5I.ECHO.${++seq}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Te atiendo yo' } }],
    });
    expect((await q(`SELECT channel_id FROM contacts WHERE id = $1`, [c.id])).rows[0].channel_id).toBe(chB.id);
    const r = await env.api('POST', `/api/contacts/${c.id}/messages`, { type: 'text', text: '¿Algo más?' });
    expect(r.status).toBe(200);
    expect(sends().map((s) => s.url.endsWith(`/${PHONE_B}/messages`))).toEqual([true]);
  });

  it('an echo never moves a contact already on another number', async () => {
    const c = await storedContact({ phone: '525511100002', waId: '525511100002', channelId: chA.id, messageOn: chA.id });
    await post(PHONE_B, SECRET_B, 'smb_message_echoes', {
      message_echoes: [{ from: PHONE_B, to: '525511100002', id: `wamid.R5I.ECHO.${++seq}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Hola' } }],
    });
    expect((await q(`SELECT channel_id FROM contacts WHERE id = $1`, [c.id])).rows[0].channel_id).toBe(chA.id);
  });

  it('a WhatsApp notice binds it too', async () => {
    const c = await storedContact({ phone: '525511100003', waId: '525511100003', channelId: null, messageOn: null });
    await post(PHONE_B, SECRET_B, 'messages', {
      contacts: [{ profile: { name: 'Cliente' }, wa_id: '525511100003' }],
      messages: [{ from: '525511100003', id: `wamid.R5I.SYS.${++seq}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'system', system: { body: 'Aviso de seguridad', type: 'security' } }],
    });
    expect((await q(`SELECT channel_id FROM contacts WHERE id = $1`, [c.id])).rows[0].channel_id).toBe(chB.id);
  });
});

describe('scheduling a template for a conversation answered from another number', () => {
  it('checks the variables against the template of the number that will send it', async () => {
    // Bound to no number, with its conversation on B (stored so by an earlier version).
    const c = await storedContact({ phone: '525511100004', waId: '525511100004', channelId: null, messageOn: chB.id });
    await upsertTemplate(env.built.ctx.db, chB, {
      meta_id: 'tpl-r5i-cita',
      name: 'cita',
      language: 'es_MX',
      category: 'UTILITY',
      status: 'APPROVED',
      components: [{ type: 'BODY', text: 'Tu cita es el {{1}}' }],
    });
    const r = await env.api('POST', `/api/contacts/${c.id}/scheduled`, {
      send_at: new Date(Date.now() + 3600_000).toISOString(),
      content: { type: 'template', name: 'cita', language: 'es_MX' },
    });
    expect(r.status).toBe(400);
  });
});

describe('template sends are bounded at the schema', () => {
  let contactId: string;
  beforeAll(async () => {
    contactId = (await storedContact({ phone: '525511100005', waId: '525511100005', channelId: chA.id, messageOn: chA.id })).id;
  });

  it('refuses a header link longer than any real one, or one that is not a web address', async () => {
    const long = await env.api('POST', `/api/contacts/${contactId}/messages`, {
      type: 'template',
      name: 'promo',
      language: 'es_MX',
      params: { header: { type: 'image', link: `https://cdn.test/${'a'.repeat(2100)}.jpg` } },
    });
    expect(long.status).toBe(400);
    const js = await env.api('POST', `/api/contacts/${contactId}/messages`, {
      type: 'template',
      name: 'promo',
      language: 'es_MX',
      params: { header: { type: 'document', link: 'ftp://cdn.test/a.pdf', filename: 'a.pdf' } },
    });
    expect(js.status).toBe(400);
    expect(sends()).toHaveLength(0);
  });

  it('refuses a template name or language no template has, scheduled or not', async () => {
    const name = await env.api('POST', `/api/contacts/${contactId}/messages`, { type: 'template', name: 'x'.repeat(513), language: 'es_MX' });
    expect(name.status).toBe(400);
    const lang = await env.api('POST', `/api/contacts/${contactId}/scheduled`, {
      send_at: new Date(Date.now() + 3600_000).toISOString(),
      content: { type: 'template', name: 'promo', language: 'e'.repeat(21) },
    });
    expect(lang.status).toBe(400);
  });
});

describe("Meta's send errors", () => {
  let contactId: string;
  beforeAll(async () => {
    contactId = (await storedContact({ phone: '525511100006', waId: '525511100006', channelId: chA.id, messageOn: chA.id })).id;
  });

  it('a number Meta cannot find is named as such even when Graph adds error_data', async () => {
    onSend = () => ({
      status: 400,
      json: { error: { message: 'Unsupported post request', type: 'GraphMethodException', code: 100, error_subcode: 33, error_data: { details: 'Object does not exist' } } },
    });
    const r = await env.api('POST', `/api/contacts/${contactId}/messages`, { type: 'text', text: 'Hola' });
    const m = r.body.message ?? (await q(`SELECT * FROM messages WHERE contact_id = $1 AND direction = 'out' ORDER BY created_at DESC LIMIT 1`, [contactId])).rows[0];
    expect(m.status).toBe('failed');
    expect(m.error.message).toContain('Meta no encuentra este número de WhatsApp');
  });

  it('131037 explains that the display name is not approved yet', async () => {
    onSend = () => ({ status: 400, json: { error: { message: 'Display name not approved', code: 131037 } } });
    const r = await env.api('POST', `/api/contacts/${contactId}/messages`, { type: 'text', text: 'Hola' });
    const m = r.body.message ?? (await q(`SELECT * FROM messages WHERE contact_id = $1 AND direction = 'out' ORDER BY created_at DESC LIMIT 1`, [contactId])).rows[0];
    expect(m.error.message).toContain('nombre visible');
  });
});

describe('workspace settings and members', () => {
  it("the menu editor's next key is kept", async () => {
    const bot = {
      menu: { prompt: '¿Qué necesitas?', options: [{ key: '1', label: 'Ventas' }, { key: '3', label: 'Soporte' }], next_key: 5 },
      fallback: 'Elige una opción',
      handoff_message: 'Te comunico con un asesor',
      interactive: false,
      only_unassigned: false,
    };
    const r = await env.api('PUT', '/api/workspace/settings', { bot });
    expect(r.status).toBe(200);
    const w = (await q(`SELECT settings FROM workspaces WHERE id = $1`, [ws])).rows[0];
    expect(w.settings.bot.menu.next_key).toBe(5);
  });

  it('removing a member takes them out of every funnel team', async () => {
    const other = await env.register('r5-integration-agent@test.com');
    await q(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'agent')`, [ws, other.userId]);
    const { rows } = await q(`INSERT INTO funnels (workspace_id, name, auto_assign, assignee_ids) VALUES ($1, 'Mayoreo', true, $2::uuid[]) RETURNING id`, [
      ws,
      [userId, other.userId],
    ]);
    const r = await env.api('DELETE', `/api/workspace/members/${other.userId}`);
    expect(r.status).toBe(204);
    expect((await q(`SELECT assignee_ids FROM funnels WHERE id = $1`, [rows[0].id])).rows[0].assignee_ids).toEqual([userId]);
  });
});

describe("007's data repairs", () => {
  const statement = (start: string) => {
    const sql = migrations.find((m) => m.name === '007_review_five')!.sql;
    const found = splitSql(sql).find((s) => s.replace(/^(\s*--[^\n]*\n)*/g, '').trimStart().startsWith(start));
    expect(found, start).toBeTruthy();
    return found!;
  };

  it('gives back the real number only to a wa_id Meta reported', async () => {
    const fromMeta = await storedContact({ phone: '524791234501', waId: '4791234501', channelId: chA.id, messageOn: chA.id });
    const { rows: sb } = await q(
      `INSERT INTO channels (workspace_id, provider, name, phone_number_id, verify_token, is_default) VALUES ($1, 'sandbox', 'Pruebas', $2, 'vt-r5i', false) RETURNING id`,
      [ws, `sandbox-r5i-${++seq}`],
    );
    const typed = await storedContact({ phone: '525598765401', waId: '5598765401', channelId: sb[0].id, messageOn: sb[0].id });
    const byHand = await storedContact({ phone: '524791234502', waId: '4791234502', channelId: null });
    await q(statement('UPDATE contacts c SET phone = c.wa_id'));
    const phone = async (id: string) => (await q(`SELECT phone FROM contacts WHERE id = $1`, [id])).rows[0].phone;
    expect(await phone(fromMeta.id)).toBe('4791234501');
    expect(await phone(typed.id)).toBe('525598765401');
    expect(await phone(byHand.id)).toBe('524791234502');
  });

  it('settles the recipients a cancelled broadcast left queued, from the message each got', async () => {
    const { rows: b } = await q(
      `INSERT INTO broadcasts (workspace_id, channel_id, name, template_name, template_language, status, finished_at)
       VALUES ($1, $2, 'Viejo', 'promo', 'es_MX', 'cancelled', now()) RETURNING id`,
      [ws, chA.id],
    );
    const got = await storedContact({ phone: '525511100010', waId: '525511100010', channelId: chA.id });
    const none = await storedContact({ phone: '525511100011', waId: '525511100011', channelId: chA.id });
    const live = await storedContact({ phone: '525511100012', waId: '525511100012', channelId: chA.id });
    const { rows: m } = await q(
      `INSERT INTO messages (workspace_id, contact_id, channel_id, direction, type, body, wamid, status, broadcast_id)
       VALUES ($1, $2, $3, 'out', 'template', 'Promo', $4, 'delivered', $5) RETURNING id`,
      [ws, got.id, chA.id, `wamid.R5I.B.${++seq}`, b[0].id],
    );
    await q(
      `INSERT INTO broadcast_recipients (broadcast_id, contact_id, status, claimed_at) VALUES
         ($1, $2, 'sending', now() - interval '1 hour'), ($1, $3, 'queued', NULL), ($1, $4, 'sending', now())`,
      [b[0].id, got.id, none.id, live.id],
    );
    await q(statement('UPDATE broadcast_recipients br'));
    const { rows } = await q(`SELECT contact_id, status, message_id FROM broadcast_recipients WHERE broadcast_id = $1`, [b[0].id]);
    const of = (id: string) => rows.find((r: any) => r.contact_id === id);
    expect(of(got.id)).toMatchObject({ status: 'sent', message_id: m[0].id });
    expect(of(none.id)).toMatchObject({ status: 'skipped', message_id: null });
    // A claim a run may still hold is left to it.
    expect(of(live.id)).toMatchObject({ status: 'sending' });
  });

  it('drops from funnel teams the members who left the workspace', async () => {
    const gone = await env.register('r5-integration-gone@test.com');
    const { rows } = await q(`INSERT INTO funnels (workspace_id, name, assignee_ids) VALUES ($1, 'Viejo', $2::uuid[]) RETURNING id`, [ws, [gone.userId, userId]]);
    await q(statement('UPDATE funnels f SET assignee_ids'));
    expect((await q(`SELECT assignee_ids FROM funnels WHERE id = $1`, [rows[0].id])).rows[0].assignee_ids).toEqual([userId]);
  });

  it('a claimable job of a workspace leaves a wakeup the fair lanes read', async () => {
    await env.built.ctx.queue.enqueue('noop.r5i', {}, { workspaceId: ws, delayMs: 3600_000 });
    const { rows } = await q(`SELECT lane, run_at > now() AS later FROM job_wakeups WHERE workspace_id = $1 ORDER BY id DESC LIMIT 1`, [ws]);
    expect(rows[0]).toMatchObject({ later: true });
  });
});
