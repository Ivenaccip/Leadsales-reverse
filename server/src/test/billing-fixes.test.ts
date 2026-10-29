import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate } from '../db/index.js';
import { encryptJson } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { charge, reconcilePricing, refund } from '../services/credits.js';
import { saveMedia } from '../services/media.js';
import { sendMessage } from '../services/messages.js';
import { processScheduled } from '../services/scheduled.js';
import { upsertTemplate } from '../services/templates.js';
import type { ChannelRow, MessageRow } from '../types.js';
import { CloudApiProvider } from '../whatsapp/cloud-api.js';
import { fakeFetch, setup, type FakeCall, type TestEnv } from './helpers.js';

const PHONE_ID = '1098765432199';
const WABA_ID = '2223334445599';

type Reply = { status?: number; json?: unknown; body?: string | Uint8Array; headers?: Record<string, string> } | undefined;

/** Per-test behaviour of Meta's POST /messages (n = how many sends so far). */
let onSend: (call: FakeCall, n: number) => Reply = () => undefined;
/** Transport failures: 'refused' never reaches Meta; 'reset' loses Meta's answer after it accepted the message. */
let transport: (n: number) => 'refused' | 'reset' | null = () => null;
/** Lets a test hold a send in flight. */
let hold: (() => Promise<void>) | null = null;
let sends = 0;

const meta = fakeFetch([
  (c) => {
    if (!c.url.endsWith(`/${PHONE_ID}/messages`) || c.body?.status === 'read') return undefined;
    const custom = onSend(c, sends);
    if (custom) return custom;
    return { json: { messaging_product: 'whatsapp', contacts: [{ input: c.body.to, wa_id: c.body.to }], messages: [{ id: `wamid.G2.${meta.calls.length}` }] } };
  },
  (c) => (c.url.endsWith(`/${PHONE_ID}/media`) ? { json: { id: '5550001' } } : undefined),
]);

const connError = (code: string) => new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });

const metaFetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? input);
  const isSend = url.endsWith(`/${PHONE_ID}/messages`) && !String(init?.body ?? '').includes('"status":"read"');
  if (!isSend) return meta.fetch(input, init);
  sends++;
  const n = sends;
  if (hold) await hold();
  if (transport(n) === 'refused') throw connError('ECONNREFUSED');
  const res = await meta.fetch(input, init);
  if (transport(n) === 'reset') throw connError('ECONNRESET');
  return res;
}) as typeof fetch;

let env: TestEnv;
let ws: string;
let channel: ChannelRow;

const ctx = () => env.built.ctx;
const q = (sql: string, params: unknown[] = []) => ctx().db.query<any>(sql, params);
const sendCalls = () => meta.calls.filter((c) => c.url.endsWith(`/${PHONE_ID}/messages`) && c.body?.status !== 'read');

async function setBilling(mode: 'prepaid' | 'meta_direct', balance?: number) {
  await q(`UPDATE workspaces SET billing_mode = $2, credit_balance = COALESCE($3, credit_balance) WHERE id = $1`, [ws, mode, balance ?? null]);
}
async function balance(): Promise<number> {
  return (await q(`SELECT credit_balance FROM workspaces WHERE id = $1`, [ws])).rows[0].credit_balance;
}
let phoneSeq = 0;
async function newContact(name = 'Cliente', phone?: string): Promise<string> {
  const r = await env.api('POST', '/api/contacts', { phone: phone ?? `+52 55 7000 ${String(1000 + ++phoneSeq)}`, name });
  expect(r.status).toBe(200);
  return r.body.contact.id;
}
async function sendTemplate(contactId: string, name = 'promo', body = ['x']) {
  return env.api('POST', `/api/contacts/${contactId}/messages`, { type: 'template', name, language: 'es_MX', params: { body } });
}
async function getMsg(id: string): Promise<MessageRow & { phone: string }> {
  return (await q(`SELECT m.*, c.phone FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE m.id = $1`, [id])).rows[0];
}
async function reconcile(id: string, pricing: Parameters<typeof reconcilePricing>[4]) {
  const m = await getMsg(id);
  await ctx().db.tx((tx) => reconcilePricing(ctx(), tx, m, m.phone, pricing));
}
async function runDelayedJobs() {
  await q(`UPDATE jobs SET run_at = now() WHERE status = 'queued'`);
  await env.drain();
}

beforeAll(async () => {
  env = await setup({ fetch: metaFetch });
  ws = (await env.register('cobros@test.com', 'Cobros')).workspaceId;
  const { rows } = await q(
    `INSERT INTO channels (workspace_id, provider, name, phone_number_id, waba_id, credentials, verify_token, is_default)
     VALUES ($1, 'cloud_api', 'Meta', $2, $3, $4, 'vt-g2', true) RETURNING *`,
    [ws, PHONE_ID, WABA_ID, encryptJson(ctx().config.encryptionKey, { accessToken: 'EAAG-test-token', appSecret: 'secret-g2' })],
  );
  channel = rows[0];
  await ctx().db.tx(async (tx) => {
    await upsertTemplate(tx, channel, { meta_id: 't1', name: 'recordatorio', language: 'es_MX', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hola {{1}}, tu cita es mañana' }] });
    await upsertTemplate(tx, channel, { meta_id: 't2', name: 'promo', language: 'es_MX', category: 'MARKETING', status: 'APPROVED', components: [{ type: 'BODY', text: 'Promo {{1}}' }] });
  });
});
afterAll(() => env.close());
beforeEach(async () => {
  onSend = () => undefined;
  transport = () => null;
  hold = null;
  await setBilling('meta_direct', 0);
});

describe('wa_id reported by Meta on send (#11, #32)', () => {
  it('stores the resolved wa_id so the reply lands on the same contact', async () => {
    const id = await newContact('Brasil', '+55 11 98765 4321');
    onSend = (c) => ({ json: { contacts: [{ input: c.body.to, wa_id: '551187654321' }], messages: [{ id: 'wamid.BR.1' }] } });
    const r = await sendTemplate(id, 'recordatorio', ['Ana']);
    expect(r.body.message.status).toBe('sent');
    const contact = (await q(`SELECT phone, wa_id FROM contacts WHERE id = $1`, [id])).rows[0];
    expect(contact).toEqual({ phone: '5511987654321', wa_id: '551187654321' });

    const { processInboundMessage } = await import('../whatsapp/inbound.js');
    const ts = String(Math.floor(Date.now() / 1000));
    const inbound = await processInboundMessage(ctx(), channel, { from: '551187654321', id: 'wamid.BR.IN', timestamp: ts, type: 'text', text: { body: 'Oi' } });
    expect(inbound?.contact_id).toBe(id);
    expect((await q(`SELECT count(*)::int AS n FROM contacts WHERE workspace_id = $1 AND phone LIKE '5511%'`, [ws])).rows[0].n).toBe(1);
  });

  it('does not give a wa_id that another contact already holds', async () => {
    const holder = await newContact('Dueño del wa_id');
    await q(`UPDATE contacts SET wa_id = '5491100000001' WHERE id = $1`, [holder]);
    const id = await newContact('Otro');
    onSend = (c) => ({ json: { contacts: [{ input: c.body.to, wa_id: '5491100000001' }], messages: [{ id: `wamid.AR.${Date.now()}` }] } });
    await sendTemplate(id, 'recordatorio');
    expect((await q(`SELECT wa_id FROM contacts WHERE id = $1`, [id])).rows[0].wa_id).toBeNull();
  });

  it('a sandbox send stores no wa_id, so the one Meta resolves later is kept (#11 review)', async () => {
    const id = await newContact('Brasil sandbox', '+55 21 98888 7777');
    const sandbox = (
      await q(`INSERT INTO channels (workspace_id, provider, name, phone_number_id, verify_token) VALUES ($1, 'sandbox', 'Sandbox', $2, 'vt') RETURNING id`, [
        ws,
        `sandbox-g2-${Date.now()}`,
      ])
    ).rows[0].id;
    const tpl = { type: 'template' as const, name: 'promo', language: 'es_MX', params: { body: ['x'] } };
    const viaSandbox = await sendMessage(ctx(), { workspaceId: ws, contactId: id, sentBy: 'user', content: tpl, channelId: sandbox });
    expect(viaSandbox.status).toBe('sent');
    expect((await q(`SELECT wa_id FROM contacts WHERE id = $1`, [id])).rows[0].wa_id).toBeNull();

    onSend = (c) => ({ json: { contacts: [{ input: c.body.to, wa_id: '552188887777' }], messages: [{ id: `wamid.BR2.${Date.now()}` }] } });
    await sendMessage(ctx(), { workspaceId: ws, contactId: id, sentBy: 'user', content: tpl, channelId: channel.id });
    expect((await q(`SELECT wa_id FROM contacts WHERE id = $1`, [id])).rows[0].wa_id).toBe('552188887777');

    const { processInboundMessage } = await import('../whatsapp/inbound.js');
    const ts = String(Math.floor(Date.now() / 1000));
    const inbound = await processInboundMessage(ctx(), channel, { from: '552188887777', id: 'wamid.BR2.IN', timestamp: ts, type: 'text', text: { body: 'Oi' } });
    expect(inbound?.contact_id).toBe(id);
    expect((await q(`SELECT count(*)::int AS n FROM contacts WHERE workspace_id = $1 AND phone LIKE '5521%'`, [ws])).rows[0].n).toBe(1);
  });

  it('replaces a wa_id that is only the typed phone with the one Meta resolves (#11 review)', async () => {
    const id = await newContact('Brasil legado', '+55 31 97777 6666');
    // What an older sandbox send left behind: the phone stored as if it were Meta's wa_id.
    await q(`UPDATE contacts SET wa_id = phone WHERE id = $1`, [id]);
    onSend = (c) => ({ json: { contacts: [{ input: c.body.to, wa_id: '553177776666' }], messages: [{ id: `wamid.BR3.${Date.now()}` }] } });
    await sendTemplate(id, 'recordatorio');
    expect((await q(`SELECT wa_id FROM contacts WHERE id = $1`, [id])).rows[0].wa_id).toBe('553177776666');
  });

  it('does not write a wa_id equal to the phone, and the reply still lands on the contact (#11 review)', async () => {
    const id = await newContact('Colombia', '+57 300 555 1234');
    await sendTemplate(id, 'recordatorio'); // the default fake answers wa_id = the number sent to
    expect((await q(`SELECT wa_id FROM contacts WHERE id = $1`, [id])).rows[0].wa_id).toBeNull();
    const { processInboundMessage } = await import('../whatsapp/inbound.js');
    const ts = String(Math.floor(Date.now() / 1000));
    const inbound = await processInboundMessage(ctx(), channel, { from: '573005551234', id: 'wamid.CO.IN', timestamp: ts, type: 'text', text: { body: 'Hola' } });
    expect(inbound?.contact_id).toBe(id);
  });

  // Needs contacts (workspace_id, wa_id) indexed in 004_hardening (requested from the migration owner):
  // both the send-side guard and inbound matching filter on it, once per message.
  it('looks contacts up by wa_id through an index, not a scan of the workspace (#11 review)', async () => {
    const plan = await ctx().db.tx(async (tx) => {
      await tx.query('SET LOCAL enable_seqscan = off');
      const { rows } = await tx.query<any>(`EXPLAIN SELECT 1 FROM contacts WHERE workspace_id = $1 AND wa_id = $2`, [ws, '551187654321']);
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(plan).toMatch(/Index Cond: .*wa_id/);
  });
});

describe('billing mode recorded at charge time (#14)', () => {
  it('a meta_direct-era failure refunded after switching to prepaid creates no credits', async () => {
    const id = await newContact();
    const sent = (await sendTemplate(id)).body.message;
    expect(sent.charged_prepaid).toBe(false);
    await setBilling('prepaid', 1);
    await reconcile(sent.id, null);
    expect(await balance()).toBe(1);
  });

  it('a meta_direct-era upward adjustment is not debited from the prepaid wallet', async () => {
    const id = await newContact();
    const sent = (await sendTemplate(id, 'recordatorio')).body.message;
    await setBilling('prepaid', 1);
    await reconcile(sent.id, { billable: true, category: 'marketing', pricing_model: 'PMP' });
    expect(await balance()).toBe(1);
    expect((await getMsg(sent.id)).cost).toBeCloseTo(0.0457, 6);
  });

  it('a prepaid-era failure refunded after switching to meta_direct gives the credits back', async () => {
    await setBilling('prepaid', 1);
    const id = await newContact();
    const sent = (await sendTemplate(id)).body.message;
    expect(sent.charged_prepaid).toBe(true);
    expect(await balance()).toBe(0.9543);
    await setBilling('meta_direct');
    await reconcile(sent.id, null);
    expect(await balance()).toBe(1);
  });

  // Needs the charged_prepaid backfill in 004_hardening (requested from the migration owner).
  it('messages sent before the upgrade by a prepaid workspace still get their refunds (#14 review)', async () => {
    const db = await createDb({ databaseUrl: null, dataDir: null });
    try {
      // The database as it was before 004_hardening.
      await db.exec(`ALTER TABLE messages DROP COLUMN charged_prepaid; DELETE FROM schema_migrations WHERE name = '004_hardening'`);
      const one = async (sql: string, params: unknown[] = []) => (await db.query<any>(sql, params)).rows[0].id as string;
      const prepaidWs = await one(`INSERT INTO workspaces (name, billing_mode, credit_balance) VALUES ('P', 'prepaid', 0.9543) RETURNING id`);
      const directWs = await one(`INSERT INTO workspaces (name) VALUES ('M') RETURNING id`);
      const pc = await one(`INSERT INTO contacts (workspace_id, phone) VALUES ($1, '525570001001') RETURNING id`, [prepaidWs]);
      const dc = await one(`INSERT INTO contacts (workspace_id, phone) VALUES ($1, '525570001002') RETURNING id`, [directWs]);
      const msg = (wsId: string, contactId: string, status: string, reconciled: boolean) =>
        one(
          `INSERT INTO messages (workspace_id, contact_id, direction, type, status, billing_category, cost, pricing_reconciled)
           VALUES ($1, $2, 'out', 'template', $3, 'marketing', 0.0457, $4) RETURNING id`,
          [wsId, contactId, status, reconciled],
        );
      // Meta prices on 'sent', so most in-flight messages are reconciled already and can still fail.
      const sentReconciled = await msg(prepaidWs, pc, 'sent', true);
      const pending = await msg(prepaidWs, pc, 'pending', false);
      const direct = await msg(directWs, dc, 'sent', false);
      await migrate(db);
      const flag = async (id: string) => (await db.query<any>(`SELECT charged_prepaid FROM messages WHERE id = $1`, [id])).rows[0].charged_prepaid;
      expect(await flag(sentReconciled)).toBe(true);
      expect(await flag(pending)).toBe(true);
      expect(await flag(direct)).toBe(false);

      const row = (await db.query<any>(`SELECT * FROM messages WHERE id = $1`, [pending])).rows[0];
      await db.tx((tx) => reconcilePricing(ctx(), tx, row, '525570001001', null));
      expect((await db.query<any>(`SELECT credit_balance FROM workspaces WHERE id = $1`, [prepaidWs])).rows[0].credit_balance).toBe(1);
    } finally {
      await db.close();
    }
  });
});

describe('6-decimal money (#16)', () => {
  it('charge and refund of a 5-decimal rate cancel out exactly, and a billed send debits the exact rate', async () => {
    await q(`UPDATE rate_card SET price = 0.04575 WHERE market = 'MX' AND category = 'marketing'`);
    try {
      await setBilling('prepaid', 1);
      const id = await newContact();
      const before = (await q(`SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1`, [ws])).rows[0].n;
      for (let i = 0; i < 10; i++) {
        const m = (await sendTemplate(id)).body.message;
        expect(m.cost).toBe(0.04575);
        await reconcile(m.id, null);
      }
      expect(await balance()).toBe(1);
      const ledger = (await q(`SELECT amount FROM credit_ledger WHERE workspace_id = $1 ORDER BY created_at OFFSET $2`, [ws, before])).rows;
      expect(ledger).toHaveLength(20);
      expect(ledger.reduce((s: number, r: any) => s + Math.round(r.amount * 1e6), 0)).toBe(0);

      const billed = (await sendTemplate(id)).body.message;
      await reconcile(billed.id, { billable: true, category: 'marketing', pricing_model: 'PMP' });
      expect(await balance()).toBe(0.95425);
      expect((await getMsg(billed.id)).cost).toBe(0.04575);
    } finally {
      await q(`UPDATE rate_card SET price = 0.0457 WHERE market = 'MX' AND category = 'marketing'`);
    }
  });

  it('rounds arbitrary amounts once, the same way for charge and refund', async () => {
    await setBilling('prepaid', 1);
    await ctx().db.tx(async (tx) => {
      await charge(tx, ws, 0.1234567, { prepaid: true });
      await refund(tx, ws, 0.1234567, { prepaid: true });
    });
    expect(await balance()).toBe(1);
  });
});

describe('ambiguous send errors (#17)', () => {
  it('keeps the charge and marks the message unknown when Meta answered but the answer was lost', async () => {
    await setBilling('prepaid', 1);
    const id = await newContact();
    transport = () => 'reset';
    const r = await sendTemplate(id);
    const m = r.body.message;
    expect(m.status).toBe('unknown');
    expect(m.cost).toBe(0.0457);
    expect(m.pricing_reconciled).toBe(false);
    expect(m.error.message).toMatch(/No pudimos confirmar/);
    expect(await balance()).toBe(0.9543);
    const refunds = (await q(`SELECT count(*)::int AS n FROM credit_ledger WHERE message_id = $1 AND kind = 'refund'`, [m.id])).rows[0].n;
    expect(refunds).toBe(0);
    // Meta echoes this id in status webhooks, so the lost wamid can still be matched later.
    expect(sendCalls().pop()!.body.biz_opaque_callback_data).toBe(m.id);
  });

  it('treats a Meta 5xx as unknown too', async () => {
    await setBilling('prepaid', 1);
    const id = await newContact();
    onSend = () => ({ status: 503, json: { error: { message: 'Service temporarily unavailable', code: 2 } } });
    const m = (await sendTemplate(id)).body.message;
    expect(m.status).toBe('unknown');
    expect(await balance()).toBe(0.9543);
  });

  it('refunds when the request never reached Meta or Meta rejected it', async () => {
    await setBilling('prepaid', 1);
    const id = await newContact();
    transport = () => 'refused';
    const a = (await sendTemplate(id)).body.message;
    expect(a.status).toBe('failed');
    expect(await balance()).toBe(1);
    transport = () => null;
    onSend = () => ({ status: 400, json: { error: { message: 'Message undeliverable', code: 131026 } } });
    const b = (await sendTemplate(id)).body.message;
    expect(b.status).toBe('failed');
    expect(b.cost).toBe(0);
    expect(await balance()).toBe(1);
  });
});

describe('inbound media download (#29)', () => {
  const graph = fakeFetch([
    (c) => (c.url === 'https://graph.facebook.com/v23.0/123456' ? { json: { url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1', mime_type: 'image/jpeg' } } : undefined),
    (c) => (c.url === 'https://graph.facebook.com/v23.0/222' ? { json: { url: 'http://169.254.169.254/latest/meta-data/iam/' } } : undefined),
    (c) => (c.url === 'https://graph.facebook.com/v23.0/333' ? { json: { url: 'https://attacker.example/x' } } : undefined),
    (c) => (c.url === 'https://graph.facebook.com/v23.0/444' ? { json: { url: 'https://lookaside.fbsbx.com/redir' } } : undefined),
    (c) => (c.url === 'https://lookaside.fbsbx.com/redir' ? { status: 302, headers: { location: 'http://127.0.0.1:5432/secret' } } : undefined),
    (c) => (c.url === 'https://graph.facebook.com/v23.0/555' ? { json: { url: 'https://mmg.whatsapp.net/big', mime_type: 'video/mp4' } } : undefined),
    (c) => (c.url === 'https://mmg.whatsapp.net/big' ? { body: new Uint8Array(4096) } : undefined),
    (c) => (c.url.startsWith('https://lookaside.fbsbx.com/whatsapp_business/') ? { body: new Uint8Array([0xff, 0xd8, 0xff]) } : undefined),
    () => ({ body: 'INTERNAL-SECRET' }),
  ]);
  const provider = new CloudApiProvider({
    baseUrl: 'https://graph.facebook.com',
    version: 'v23.0',
    accessToken: 'EAAG-x',
    phoneNumberId: '1',
    wabaId: null,
    fetch: graph.fetch,
    maxMediaBytes: 1024,
  });
  const urls = () => graph.calls.map((c) => c.url);

  it('rejects media ids that are not numeric before calling Graph', async () => {
    await expect(provider.downloadMedia('777?fields=url')).rejects.toThrow(/inválido/);
    await expect(provider.downloadMedia('../me')).rejects.toThrow(/inválido/);
    expect(graph.calls).toHaveLength(0);
  });

  it('never follows a download URL or redirect outside Meta media hosts', async () => {
    await expect(provider.downloadMedia('222')).rejects.toThrow(/no permitida/);
    await expect(provider.downloadMedia('333')).rejects.toThrow(/no permitida/);
    await expect(provider.downloadMedia('444')).rejects.toThrow(/no permitida/);
    expect(urls().some((u) => /169\.254|attacker|127\.0\.0\.1/.test(u))).toBe(false);
  });

  it('caps the download size and still downloads normal media', async () => {
    await expect(provider.downloadMedia('555')).rejects.toThrow(/supera/);
    const ok = await provider.downloadMedia('123456');
    expect(ok.mime).toBe('image/jpeg');
    expect([...ok.data]).toEqual([0xff, 0xd8, 0xff]);
  });
});

describe('broadcast drafts (#40, #68)', () => {
  it('stores the estimated cost and recipients on create and on edit', async () => {
    const a = await newContact('Uno');
    const b = await newContact('Dos');
    const created = await env.api('POST', '/api/broadcasts', { name: 'Borrador', template_name: 'promo', template_language: 'es_MX', params: { body: ['x'] }, audience: { contact_ids: [a, b] } });
    expect(created.status).toBe(200);
    expect(created.body.broadcast.total_recipients).toBe(2);
    expect(created.body.broadcast.estimated_cost).toBeCloseTo(0.0914, 6);
    const patched = await env.api('PATCH', `/api/broadcasts/${created.body.broadcast.id}`, { audience: { contact_ids: [a] }, template_name: 'recordatorio' });
    expect(patched.status).toBe(200);
    expect(patched.body.broadcast.total_recipients).toBe(1);
    expect(patched.body.broadcast.estimated_cost).toBeCloseTo(0.0085, 6);
    expect(patched.body.broadcast.template_category).toBe('utility');
  });

  it('a PATCH that omits audience and params keeps them (#40 review)', async () => {
    const a = await newContact('Solo yo');
    const created = await env.api('POST', '/api/broadcasts', {
      name: 'Borrador',
      template_name: 'promo',
      template_language: 'es_MX',
      params: { body: ['x'] },
      audience: { contact_ids: [a] },
    });
    const id = created.body.broadcast.id;
    const renamed = await env.api('PATCH', `/api/broadcasts/${id}`, { name: 'Renombrada' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.broadcast).toMatchObject({ name: 'Renombrada', total_recipients: 1, audience: { contact_ids: [a] }, params: { body: ['x'] } });
    // Sending an empty audience on purpose still means "every contact".
    const everyone = await env.api('PATCH', `/api/broadcasts/${id}`, { audience: {} });
    expect(everyone.body.broadcast.audience).toEqual({});
    expect(everyone.body.broadcast.total_recipients).toBeGreaterThan(1);
  });

  it('refuses a channel from another workspace or an unknown one', async () => {
    const other = await env.register('otra-g2@test.com', 'Otra');
    const foreign = (
      await q(
        `INSERT INTO channels (workspace_id, provider, name, phone_number_id, verify_token) VALUES ($1, 'sandbox', 'S', $2, 'vt') RETURNING id`,
        [other.workspaceId, `sandbox-${Date.now()}`],
      )
    ).rows[0].id;
    const id = await newContact();
    const draft = (await env.api('POST', '/api/broadcasts', { name: 'B', template_name: 'promo', template_language: 'es_MX', params: { body: ['x'] }, audience: { contact_ids: [id] } }))
      .body.broadcast;
    const r1 = await env.api('PATCH', `/api/broadcasts/${draft.id}`, { channel_id: foreign });
    expect(r1.status).toBe(400);
    const r2 = await env.api('PATCH', `/api/broadcasts/${draft.id}`, { channel_id: '00000000-0000-4000-8000-000000000000' });
    expect(r2.status).toBe(400);
    expect((await q(`SELECT channel_id FROM broadcasts WHERE id = $1`, [draft.id])).rows[0].channel_id).toBe(channel.id);
  });
});

describe('broadcasts and Meta errors (#56, #63)', () => {
  async function launch(n: number) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push(await newContact(`Dest ${i}`));
    const created = await env.api('POST', '/api/broadcasts', { name: 'Campaña', template_name: 'recordatorio', template_language: 'es_MX', params: { body: ['x'] }, audience: { contact_ids: ids } });
    const id = created.body.broadcast.id;
    const first = sends;
    const l = await env.api('POST', `/api/broadcasts/${id}/launch`);
    expect(l.status).toBe(200);
    return { id, first };
  }
  const recipients = async (id: string) => (await q(`SELECT status FROM broadcast_recipients WHERE broadcast_id = $1`, [id])).rows.map((r: any) => r.status).sort();
  const get = async (id: string) => (await env.api('GET', `/api/broadcasts/${id}`)).body.broadcast;

  it('retries rate-limited sends later instead of failing the recipients', async () => {
    let base = 0;
    onSend = (_c, n) => (n - base === 2 || n - base === 3 ? { status: 429, json: { error: { message: '(#130429) Rate limit hit', code: 130429 } } } : undefined);
    base = sends;
    const { id } = await launch(3);
    await env.drain();
    expect((await get(id)).status).toBe('running');
    expect(await recipients(id)).toEqual(['queued', 'queued', 'sent']);
    for (let i = 0; i < 3; i++) await runDelayedJobs();
    const b = await get(id);
    expect(b.status).toBe('completed');
    expect(await recipients(id)).toEqual(['sent', 'sent', 'sent']);
    expect(b.stats.failed).toBe(0);
  });

  it('pauses on account-level errors and sends to the rest after resuming', async () => {
    let base = 0;
    let broken = true;
    onSend = (_c, n) => (broken && n - base >= 2 ? { status: 401, json: { error: { message: 'Error validating access token', code: 190 } } } : undefined);
    base = sends;
    const { id, first } = await launch(3);
    await env.drain();
    const paused = await get(id);
    expect(paused.status).toBe('paused');
    expect(paused.last_error).toMatch(/token/);
    expect(sends - first).toBe(2);
    expect(await recipients(id)).toEqual(['queued', 'queued', 'sent']);
    broken = false;
    expect((await env.api('POST', `/api/broadcasts/${id}/launch`)).status).toBe(200);
    await env.drain();
    expect((await get(id)).status).toBe('completed');
    expect(await recipients(id)).toEqual(['sent', 'sent', 'sent']);
    expect(sends - first).toBe(4);
  });

  it('pauses on an unconfirmed send and never resends it', async () => {
    let base = 0;
    transport = (n) => (n - base === 1 ? 'reset' : null);
    base = sends;
    const { id, first } = await launch(2);
    await env.drain();
    expect((await get(id)).status).toBe('paused');
    expect((await env.api('POST', `/api/broadcasts/${id}/launch`)).status).toBe(200);
    await env.drain();
    expect((await get(id)).status).toBe('completed');
    expect(sends - first).toBe(2);
  });
});

describe('scheduled messages (#15, #39, #56, #57)', () => {
  async function schedule(contactId: string, content: unknown, inMs = 3_600_000) {
    const r = await env.api('POST', `/api/contacts/${contactId}/scheduled`, { send_at: new Date(Date.now() + inMs).toISOString(), content });
    expect(r.status).toBe(200);
    return r.body.scheduled.id as string;
  }
  const row = async (id: string) => (await q(`SELECT * FROM scheduled_messages WHERE id = $1`, [id])).rows[0];
  const makeDue = (id: string) => q(`UPDATE scheduled_messages SET send_at = now() - interval '1 second' WHERE id = $1`, [id]);

  it('renders contact placeholders in scheduled templates', async () => {
    const id = await newContact('Ana López');
    const sid = await schedule(id, { type: 'template', name: 'recordatorio', language: 'es_MX', params: { body: ['{primer_nombre}'] } });
    await makeDue(sid);
    env.built.ctx.realtime.history.length = 0;
    await processScheduled(ctx(), { id: sid });
    const s = await row(sid);
    expect(s.status).toBe('sent');
    expect((await getMsg(s.message_id)).body).toBe('Hola Ana, tu cita es mañana');
    expect(sendCalls().pop()!.body.template.components[0].parameters[0].text).toBe('Ana');
    const ev = env.built.ctx.realtime.history.find((h) => h.event === 'scheduled:update');
    expect(ev?.data).toEqual({ id: sid, contact_id: id, status: 'sent' });
  });

  it('a job that starts before send_at (clock skew) is re-queued, not dropped', async () => {
    const id = await newContact();
    const sid = await schedule(id, { type: 'template', name: 'recordatorio', language: 'es_MX', params: { body: ['x'] } });
    const before = sends;
    await processScheduled(ctx(), { id: sid });
    expect((await row(sid)).status).toBe('pending');
    expect(sends).toBe(before);
    const jobs = (await q(`SELECT run_at FROM jobs WHERE type = 'scheduled.send' AND status = 'queued' AND payload->>'id' = $1`, [sid])).rows;
    expect(jobs.length).toBeGreaterThanOrEqual(1);
  });

  it('cannot be cancelled while sending, and a second run never sends twice', async () => {
    const id = await newContact();
    const sid = await schedule(id, { type: 'template', name: 'recordatorio', language: 'es_MX', params: { body: ['x'] } });
    await makeDue(sid);
    let release!: () => void;
    let reached!: () => void;
    const inFlight = new Promise<void>((r) => (reached = r));
    hold = () => {
      reached();
      return new Promise<void>((r) => (release = r));
    };
    const run = processScheduled(ctx(), { id: sid });
    await inFlight;
    const cancel = await env.api('DELETE', `/api/scheduled/${sid}`);
    expect(cancel.status).toBe(409);
    hold = null;
    release();
    await run;
    expect((await row(sid)).status).toBe('sent');
    const before = sends;
    await processScheduled(ctx(), { id: sid });
    expect(sends).toBe(before);
  });

  it('a run that died after storing the message finishes from it instead of resending', async () => {
    const id = await newContact();
    const sid = await schedule(id, { type: 'template', name: 'recordatorio', language: 'es_MX', params: { body: ['x'] } });
    const m = (await sendTemplate(id, 'recordatorio')).body.message;
    await q(`UPDATE scheduled_messages SET status = 'sending', message_id = $2, send_at = now() WHERE id = $1`, [sid, m.id]);
    const before = sends;
    await processScheduled(ctx(), { id: sid });
    expect(sends).toBe(before);
    expect((await row(sid)).status).toBe('sent');
  });

  it('retries a rate-limited scheduled send later', async () => {
    const id = await newContact();
    const sid = await schedule(id, { type: 'template', name: 'recordatorio', language: 'es_MX', params: { body: ['x'] } });
    await makeDue(sid);
    let base = sends;
    onSend = (_c, n) => (n - base === 1 ? { status: 429, json: { error: { message: '(#130429) Rate limit hit', code: 130429 } } } : undefined);
    base = sends;
    await processScheduled(ctx(), { id: sid });
    expect((await row(sid)).status).toBe('pending');
    await runDelayedJobs();
    const s = await row(sid);
    expect(s.status).toBe('sent');
    expect((await getMsg(s.message_id)).status).toBe('sent');
  });

  it('dismissing a failed scheduled message cancels it and notifies the panel', async () => {
    const id = await newContact();
    const sid = await schedule(id, { type: 'text', text: 'hola' });
    await makeDue(sid);
    await processScheduled(ctx(), { id: sid }); // window closed: fails
    expect((await row(sid)).status).toBe('failed');
    env.built.ctx.realtime.history.length = 0;
    expect((await env.api('DELETE', `/api/scheduled/${sid}`)).status).toBe(204);
    expect((await row(sid)).status).toBe('cancelled');
    expect(env.built.ctx.realtime.history.find((h) => h.event === 'scheduled:update')?.data).toEqual({ id: sid, contact_id: id, status: 'cancelled' });
  });
});

describe('sendMessage contract', () => {
  it('emits credits:update when a template is charged (#87)', async () => {
    const other = await env.register('creditos-g2@test.com', 'Creditos');
    await q(`UPDATE workspaces SET billing_mode = 'prepaid', credit_balance = 1 WHERE id = $1`, [other.workspaceId]);
    const opts = { cookie: other.cookie, ws: other.workspaceId };
    expect((await env.api('POST', '/api/channels', { provider: 'sandbox', name: 'S' }, opts)).status).toBe(200);
    const c = await env.api('POST', '/api/contacts', { phone: '+52 55 6000 0001', name: 'Pepe' }, opts);
    env.built.ctx.realtime.history.length = 0;
    const r = await env.api(
      'POST',
      `/api/contacts/${c.body.contact.id}/messages`,
      { type: 'template', name: 'promo_mes', language: 'es_MX', params: { header: { type: 'text', text: 'x' }, body: ['a', 'b'] } },
      opts,
    );
    expect(r.status).toBe(200);
    expect(env.built.ctx.realtime.history.some((h) => h.event === 'credits:update' && h.room === `ws:${other.workspaceId}`)).toBe(true);
  });

  it('rejects text on audio and stickers with CAPTION_NOT_SUPPORTED', async () => {
    const id = await newContact();
    await q(`UPDATE contacts SET last_inbound_at = now() WHERE id = $1`, [id]);
    for (const [mime, name] of [
      ['audio/ogg', 'nota.ogg'],
      ['image/webp', 'sticker.webp'],
    ]) {
      const file = await saveMedia(ctx(), ws, Buffer.from('data'), mime, name);
      const err = await sendMessage(ctx(), { workspaceId: ws, contactId: id, sentBy: 'user', content: { type: 'media', mediaFileId: file.id, caption: 'hola' } }).catch((e) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err.code).toBe('CAPTION_NOT_SUPPORTED');
      const ok = await sendMessage(ctx(), { workspaceId: ws, contactId: id, sentBy: 'user', content: { type: 'media', mediaFileId: file.id } });
      expect(ok.status).toBe('sent');
    }
  });
});
