import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hmacSha256Hex } from '../lib/crypto.js';
import { phoneVariants } from '../lib/phone.js';
import { CloudApiProvider } from '../whatsapp/cloud-api.js';
import { optOutKeyword, parseInboundContent, processInboundMessage } from '../whatsapp/inbound.js';
import { fakeFetch, setup, sleep, type TestEnv } from './helpers.js';

// Regression tests for review round 3, inbound pipeline (whatsapp/inbound.ts, media downloads, jobs/handlers.ts).

const PHONE_ID = '1098765400031';
const PHONE_ID_2 = '1098765400032';
const WABA_ID = '2223334400031';
const APP_SECRET = 'app-secret-r3-inbound-0123456789';
const TOKEN = 'EAAG-fake-token-r3-inbound-xxxxxxxxxxxx';

/** Templates as Meta lists them right now (tests edit them "in WhatsApp Manager"). */
let remoteTemplates: any[] = [
  { id: 'tp1', name: 'pedido', language: 'es_MX', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hola {{1}}, tu pedido está listo' }] },
];
/** Media Meta serves, by media id. */
const media: Record<string, () => { status?: number; json?: unknown; body?: any; headers?: Record<string, string> }> = {};

const meta = fakeFetch([
  (c) => {
    const m = c.url.match(/\/(\d+)\?fields=display_phone_number/);
    return m ? { json: { id: m[1], display_phone_number: '+52 55 1234 0031', verified_name: 'Tienda' } } : undefined;
  },
  (c) => (c.url.endsWith(`/${WABA_ID}/subscribed_apps`) ? { json: { success: true } } : undefined),
  (c) => (c.url.includes(`/${WABA_ID}/phone_numbers`) ? { json: { data: [{ id: PHONE_ID }, { id: PHONE_ID_2 }] } } : undefined),
  (c) => (c.url.includes(`/${WABA_ID}/message_templates?limit`) ? { json: { data: remoteTemplates } } : undefined),
  (c) => {
    if (!/\/\d+\/messages$/.test(c.url)) return undefined;
    if (c.body?.status === 'read') return { json: { success: true } };
    return { json: { messaging_product: 'whatsapp', contacts: [{ input: c.body.to, wa_id: c.body.to }], messages: [{ id: `wamid.OUT.${meta.calls.length}` }] } };
  },
  (c) => {
    const m = c.url.match(/^https:\/\/graph\.facebook\.com\/v[\d.]+\/(\d+)$/);
    if (!m || !media[m[1]]) return undefined;
    return { json: { url: `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${m[1]}`, mime_type: 'application/pdf' } };
  },
  (c) => {
    const m = c.url.match(/^https:\/\/lookaside\.fbsbx\.com\/.*mid=(\d+)/);
    return m && media[m[1]] ? media[m[1]]() : undefined;
  },
]);

let env: TestEnv;
let ws: string;
let channelId: string;

const q = (sql: string, params: unknown[] = []) => env.built.ctx.db.query<any>(sql, params);
const nowTs = (offsetSec = 0) => String(Math.floor(Date.now() / 1000) + offsetSec);
let seq = 0;
const newWamid = (p = 'IN') => `wamid.R3.${p}.${++seq}`;

function envelope(field: string, value: unknown) {
  return JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: WABA_ID, changes: [{ field, value }] }] });
}

function messagesValue(messages: any[], statuses: any[] = [], phoneId = PHONE_ID) {
  return {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '525512340031', phone_number_id: phoneId },
    contacts: messages.length ? messages.map((m) => ({ profile: { name: 'Cliente' }, wa_id: m.from })) : undefined,
    messages: messages.length ? messages : undefined,
    statuses: statuses.length ? statuses : undefined,
  };
}

async function post(body: string) {
  const res = await env.built.app.inject({
    method: 'POST',
    url: '/webhooks/whatsapp',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${hmacSha256Hex(APP_SECRET, body)}` },
    payload: body,
  });
  expect(res.statusCode).toBe(200);
}

async function deliver(messages: any[], statuses: any[] = [], phoneId = PHONE_ID) {
  await post(envelope('messages', messagesValue(messages, statuses, phoneId)));
  await env.drain();
}

async function echo(echoes: any[]) {
  await post(envelope('smb_message_echoes', { messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_ID }, message_echoes: echoes }));
  await env.drain();
}

/** Runs a wa.webhook job the way the route queues it, with the channels it vouches for. */
async function runWebhookJob(statuses: any[], payload: { channelIds: string[]; trustedChannelIds?: string[] }, phoneId = PHONE_ID) {
  await env.built.ctx.queue.enqueue('wa.webhook', { body: JSON.parse(envelope('messages', messagesValue([], statuses, phoneId))), ...payload }, { maxAttempts: 6 });
  await env.drain();
}

function text(from: string, body: string, ts = nowTs()) {
  return { from, id: newWamid(), timestamp: ts, type: 'text', text: { body } };
}

async function messageByWamid(wamid: string) {
  return (await q(`SELECT * FROM messages WHERE workspace_id = $1 AND wamid = $2`, [ws, wamid])).rows[0];
}

async function contactsWithPhone(phone: string) {
  return (await q(`SELECT * FROM contacts WHERE workspace_id = $1 AND phone = $2`, [ws, phone])).rows;
}

async function newContact(phone: string, name = 'Lead') {
  const r = await env.api('POST', '/api/contacts', { phone, name });
  expect(r.status).toBe(200);
  return r.body.contact;
}

async function outbound(
  contactId: string,
  wamid: string,
  o: { cost?: number; prepaid?: boolean; reconciled?: boolean; channelId?: string | null; broadcastId?: string } = {},
) {
  const { rows } = await q(
    `INSERT INTO messages (workspace_id, contact_id, channel_id, direction, type, body, wamid, status, sent_by, billing_category, cost, charged_prepaid, pricing_reconciled, broadcast_id)
     VALUES ($1, $2, $3, 'out', 'template', 'Plantilla', $4, 'sent', 'user', 'marketing', $5, $6, $7, $8) RETURNING *`,
    [ws, contactId, o.channelId === undefined ? channelId : o.channelId, wamid, o.cost ?? 0, o.prepaid ?? false, o.reconciled ?? false, o.broadcastId ?? null],
  );
  return rows[0];
}

const balance = async () => Number((await q(`SELECT credit_balance FROM workspaces WHERE id = $1`, [ws])).rows[0].credit_balance);
const refunds = async (messageId: string) => (await q(`SELECT count(*)::int AS n FROM credit_ledger WHERE message_id = $1`, [messageId])).rows[0].n as number;

beforeAll(async () => {
  env = await setup({ fetch: meta.fetch });
  ws = (await env.register('r3-inbound@test.com')).workspaceId;
  const r = await env.api('POST', '/api/channels', {
    provider: 'cloud_api',
    name: 'Ventas',
    phone_number_id: PHONE_ID,
    waba_id: WABA_ID,
    access_token: TOKEN,
    app_secret: APP_SECRET,
  });
  expect(r.status).toBe(200);
  channelId = r.body.channel.id;
  await env.api('PUT', '/api/workspace/settings', { automation_mode: 'off' });
});
afterAll(() => env.close());

describe('statuses of messages whose channel was deleted (#2)', () => {
  it('a number disconnected and connected again still gets the late statuses of its old messages', async () => {
    const created = await env.api('POST', '/api/channels', {
      provider: 'cloud_api',
      name: 'Soporte',
      phone_number_id: PHONE_ID_2,
      waba_id: WABA_ID,
      access_token: TOKEN,
      app_secret: APP_SECRET,
    });
    expect(created.status).toBe(200);
    const c = await newContact('+52 55 4444 0201');
    const sent = await outbound(c.id, 'wamid.R3.ORPHAN.1', { channelId: created.body.channel.id });
    expect((await env.api('DELETE', `/api/channels/${created.body.channel.id}`)).status).toBe(204);
    expect((await messageByWamid('wamid.R3.ORPHAN.1')).channel_id).toBeNull();
    const again = await env.api('POST', '/api/channels', {
      provider: 'cloud_api',
      name: 'Soporte',
      phone_number_id: PHONE_ID_2,
      waba_id: WABA_ID,
      access_token: TOKEN,
      app_secret: APP_SECRET,
    });
    expect(again.status).toBe(200);
    await deliver([], [{ id: 'wamid.R3.ORPHAN.1', status: 'delivered', timestamp: nowTs(), recipient_id: '525544440201' }], PHONE_ID_2);
    expect((await messageByWamid('wamid.R3.ORPHAN.1')).status).toBe('delivered');
    expect((await q(`SELECT count(*)::int AS n FROM jobs WHERE type = 'wa.webhook' AND status = 'queued'`)).rows[0].n).toBe(0);
    await q(`DELETE FROM messages WHERE id = $1`, [sent.id]);
  });

  it('an orphaned prepaid send is refunded only by a payload the operator signed', async () => {
    await q(`UPDATE workspaces SET billing_mode = 'prepaid', credit_balance = 1 WHERE id = $1`, [ws]);
    try {
      const c = await newContact('+52 55 4444 0202');
      const a = await outbound(c.id, 'wamid.R3.ORPHAN.2', { channelId: null, cost: 0.0457, prepaid: true, reconciled: true });
      const b = await outbound(c.id, 'wamid.R3.ORPHAN.3', { channelId: null, cost: 0.0457, prepaid: true, reconciled: true });
      const failed = (id: string) => ({ id, status: 'failed', timestamp: nowTs(-3600), recipient_id: '525544440202', errors: [{ code: 131026 }] });
      // Signed with a secret the tenant may know: the status is stored, the wallet is not touched
      await runWebhookJob([failed('wamid.R3.ORPHAN.2')], { channelIds: [channelId], trustedChannelIds: [] });
      expect((await q(`SELECT status, cost FROM messages WHERE id = $1`, [a.id])).rows[0]).toEqual({ status: 'failed', cost: 0.0457 });
      expect(await refunds(a.id)).toBe(0);
      expect(await balance()).toBeCloseTo(1);
      // Signed by the operator: refunded
      await runWebhookJob([failed('wamid.R3.ORPHAN.3')], { channelIds: [channelId], trustedChannelIds: [channelId] });
      expect((await q(`SELECT status, cost FROM messages WHERE id = $1`, [b.id])).rows[0]).toEqual({ status: 'failed', cost: 0 });
      expect(await balance()).toBeCloseTo(1.0457);
    } finally {
      await q(`UPDATE workspaces SET billing_mode = 'meta_direct' WHERE id = $1`, [ws]);
    }
  });
});

describe('prepaid money moves only on statuses the operator signed (#28, #7)', () => {
  const failed = (id: string, recipient: string) => ({ id, status: 'failed', timestamp: nowTs(-3600), recipient_id: recipient, errors: [{ code: 131026 }] });

  it('an untrusted signature cannot refund or reconcile a prepaid-era send', async () => {
    await q(`UPDATE workspaces SET billing_mode = 'meta_direct', credit_balance = 0.5 WHERE id = $1`, [ws]);
    const c = await newContact('+52 55 4444 2801');
    const reconciled = await outbound(c.id, 'wamid.R3.PP.1', { cost: 0.0457, prepaid: true, reconciled: true });
    const pending = await outbound(c.id, 'wamid.R3.PP.2', { cost: 0.0457, prepaid: true });
    await runWebhookJob(
      [failed('wamid.R3.PP.1', '525544442801'), { id: 'wamid.R3.PP.2', status: 'sent', timestamp: nowTs(-3600), recipient_id: '525544442801', pricing: { billable: false, category: 'marketing' } }],
      { channelIds: [channelId], trustedChannelIds: [] },
    );
    expect((await q(`SELECT status, cost FROM messages WHERE id = $1`, [reconciled.id])).rows[0]).toEqual({ status: 'failed', cost: 0.0457 });
    expect((await q(`SELECT cost, pricing_reconciled FROM messages WHERE id = $1`, [pending.id])).rows[0]).toEqual({ cost: 0.0457, pricing_reconciled: false });
    expect(await refunds(reconciled.id)).toBe(0);
    expect(await refunds(pending.id)).toBe(0);
    expect(await balance()).toBeCloseTo(0.5);

    // The same statuses signed by the operator settle them
    await runWebhookJob(
      [{ id: 'wamid.R3.PP.2', status: 'sent', timestamp: nowTs(-3600), recipient_id: '525544442801', pricing: { billable: false, category: 'marketing' } }],
      { channelIds: [channelId], trustedChannelIds: [channelId] },
    );
    expect((await q(`SELECT cost, pricing_reconciled FROM messages WHERE id = $1`, [pending.id])).rows[0]).toEqual({ cost: 0, pricing_reconciled: true });
    expect(await balance()).toBeCloseTo(0.5457);
  });

  it('messages the wallet did not pay for still reconcile on any valid signature', async () => {
    const c = await newContact('+52 55 4444 2802');
    const m = await outbound(c.id, 'wamid.R3.PP.3', { cost: 0.0457 });
    await runWebhookJob(
      [{ id: 'wamid.R3.PP.3', status: 'sent', timestamp: nowTs(-3600), recipient_id: '525544442802', pricing: { billable: false, category: 'marketing' } }],
      { channelIds: [channelId], trustedChannelIds: [] },
    );
    expect((await q(`SELECT cost, pricing_reconciled FROM messages WHERE id = $1`, [m.id])).rows[0]).toEqual({ cost: 0, pricing_reconciled: true });
  });

  it('a job queued before the route listed trusted channels trusts only operator-verified channels', async () => {
    await q(`UPDATE workspaces SET credit_balance = 1 WHERE id = $1`, [ws]);
    const c = await newContact('+52 55 4444 2803');
    const a = await outbound(c.id, 'wamid.R3.PP.4', { cost: 0.0457, prepaid: true, reconciled: true });
    const b = await outbound(c.id, 'wamid.R3.PP.5', { cost: 0.0457, prepaid: true, reconciled: true });
    await runWebhookJob([failed('wamid.R3.PP.4', '525544442803')], { channelIds: [channelId] });
    expect(await refunds(a.id)).toBe(0);
    await q(`UPDATE channels SET operator_verified = true WHERE id = $1`, [channelId]);
    try {
      await runWebhookJob([failed('wamid.R3.PP.5', '525544442803')], { channelIds: [channelId] });
      expect(await refunds(b.id)).toBe(1);
      expect(await balance()).toBeCloseTo(1.0457);
    } finally {
      await q(`UPDATE channels SET operator_verified = false WHERE id = $1`, [channelId]);
    }
  });
});

describe('human takeover (#8)', () => {
  it('a reply typed in the WhatsApp Business app stops the menu bot even before it started', async () => {
    const r = await env.api('PUT', '/api/workspace/settings', {
      automation_mode: 'menu',
      bot: {
        menu: {
          prompt: 'Soy el asistente virtual, elige:',
          options: [
            { key: '1', label: 'Precios', reply: 'Nuestros precios' },
            { key: '2', label: 'Asesor', reply: 'Te paso con un asesor', handoff: true },
          ],
        },
        fallback: 'No entendí',
        handoff_message: 'Un asesor te atiende',
        interactive: false,
        only_unassigned: false,
      },
    });
    expect(r.status).toBe(200);
    try {
      const to = '5215544440801';
      await echo([{ from: '525512340031', to, id: newWamid('ECHO'), timestamp: nowTs(), type: 'text', text: { body: 'Hola Juan, soy Ana. ¿Te llegó tu pedido?' } }]);
      const [contact] = await contactsWithPhone('525544440801');
      expect(contact.ai_paused).toBe(true);
      expect(contact.bot_state).toMatchObject({ done: true });
      const reply = text(to, 'Sí, todo bien, gracias Ana');
      await deliver([reply]);
      const bot = (await q(`SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND sent_by = 'bot'`, [contact.id])).rows[0].n;
      expect(bot).toBe(0);
    } finally {
      await env.api('PUT', '/api/workspace/settings', { automation_mode: 'off' });
    }
  });
});

describe('chat order follows Meta time (#26)', () => {
  it('an older message delivered seconds after a newer one goes before it and does not take the preview', async () => {
    const from = '5215544442601';
    const m2 = text(from, 'M2: ya hice el pago', nowTs());
    const m1 = text(from, 'M1: ¿cuánto cuesta?', nowTs(-20));
    await deliver([m2]);
    await deliver([m1]);
    const [contact] = await contactsWithPhone('525544442601');
    const rows = (await q(`SELECT body, wa_ts FROM messages WHERE contact_id = $1 ORDER BY created_at`, [contact.id])).rows;
    expect(rows.map((r: any) => r.body)).toEqual(['M1: ¿cuánto cuesta?', 'M2: ya hice el pago']);
    expect(rows.map((r: any) => r.wa_ts)).toEqual([Number(m1.timestamp), Number(m2.timestamp)]);
    expect(contact.last_message_preview).toBe('M2: ya hice el pago');
    const api = await env.api('GET', `/api/contacts/${contact.id}/messages`);
    expect(api.body.messages.map((m: any) => m.body)).toEqual(['M1: ¿cuánto cuesta?', 'M2: ya hice el pago']);
  });

  it('a question delivered after the reply typed on the phone goes before it and stays read', async () => {
    const from = '5215544442602';
    await deliver([text(from, 'hola', nowTs(-30))]);
    await echo([{ from: '525512340031', to: from, id: newWamid('ECHO'), timestamp: nowTs(-3), type: 'text', text: { body: 'Sí, mañana abrimos' } }]);
    await deliver([text(from, '¿abren mañana?', nowTs(-10))]);
    const [contact] = await contactsWithPhone('525544442602');
    const rows = (await q(`SELECT body FROM messages WHERE contact_id = $1 ORDER BY created_at`, [contact.id])).rows;
    expect(rows.map((r: any) => r.body)).toEqual(['hola', '¿abren mañana?', 'Sí, mañana abrimos']);
    expect(contact.unread_count).toBe(0);
    expect(contact.last_message_preview).toBe('Sí, mañana abrimos');
  });

  /** The chat as stored and as the API returns it; every message must have a time of its own. */
  async function chat(phone: string) {
    const [contact] = await contactsWithPhone(phone);
    const rows = (await q(`SELECT body, created_at::text AS t FROM messages WHERE contact_id = $1 ORDER BY created_at, id`, [contact.id])).rows;
    expect(new Set(rows.map((r: any) => r.t)).size).toBe(rows.length);
    const api = await env.api('GET', `/api/contacts/${contact.id}/messages`);
    expect(api.body.messages.map((m: any) => m.body)).toEqual(rows.map((r: any) => r.body));
    return { contact, bodies: rows.map((r: any) => r.body) };
  }

  it('several older messages delivered after a newer one keep their own order, together or one by one', async () => {
    const ways: Record<string, (m1: any, m2: any) => Promise<void>> = {
      together: (m1, m2) => deliver([m1, m2]),
      inOrder: async (m1, m2) => {
        await deliver([m1]);
        await deliver([m2]);
      },
      reversed: async (m1, m2) => {
        await deliver([m2]);
        await deliver([m1]);
      },
    };
    let n = 10;
    for (const [way, late] of Object.entries(ways)) {
      const from = `52155444426${++n}`;
      const m3 = text(from, 'M3: ya pagué', nowTs());
      await deliver([m3]);
      await late(text(from, 'M1: hola', nowTs(-20)), text(from, 'M2: ¿cuánto cuesta?', nowTs(-10)));
      const { contact, bodies } = await chat(`5255444426${n}`);
      expect({ way, bodies }).toEqual({ way, bodies: ['M1: hola', 'M2: ¿cuánto cuesta?', 'M3: ya pagué'] });
      expect(contact.last_message_preview).toBe('M3: ya pagué');
    }
  });

  it('a message Meta stamped between messages of one payload goes between them', async () => {
    const from = '5215544442621';
    // One payload: its messages are stored 1 µs apart, so there is no free time between them.
    await deliver([text(from, 'M1', nowTs(-30)), text(from, 'M2', nowTs(-20)), text(from, 'M4', nowTs())]);
    await deliver([text(from, 'M3', nowTs(-10))]);
    expect((await chat('525544442621')).bodies).toEqual(['M1', 'M2', 'M3', 'M4']);
  });

  it('a newer message placed by Meta time still goes after an older one placed at its receipt', async () => {
    const from = '5215544442622';
    const t = Math.floor(Date.now() / 1000);
    await deliver([text(from, 'M1: hola', String(t - 50))]); // 50 s late: stored at its receipt
    const channel = (await q(`SELECT * FROM channels WHERE id = $1`, [channelId])).rows[0];
    // 70 s late: stored at Meta's time, which is earlier than M1's receipt.
    await processInboundMessage(env.built.ctx, channel, text(from, 'M2: sigo esperando', String(t - 40)), undefined, (t + 30) * 1_000_000);
    await env.drain();
    const { contact, bodies } = await chat('525544442622');
    expect(bodies).toEqual(['M1: hola', 'M2: sigo esperando']);
    expect(contact.last_message_preview).toBe('M2: sigo esperando');
  });
});

describe('locks of an inbound message or echo against deleting its channel (#26)', () => {
  /** Waits until `n` sessions of this test database are waiting for a lock (PostgreSQL only). */
  async function lockWaiters(n: number) {
    for (let i = 0; i < 400; i++) {
      const { rows } = await q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
      if (rows[0].n >= n) return;
      await sleep(25);
    }
    throw new Error(`expected ${n} sessions waiting for a lock`);
  }

  it('takes the channel row before the contact row, as DELETE /api/channels does', async () => {
    const db = env.built.ctx.db;
    const txs: string[][] = [];
    const tx = db.tx.bind(db);
    const spy = vi.spyOn(db, 'tx').mockImplementation((fn: any) =>
      tx((tq) => {
        const sqls: string[] = [];
        txs.push(sqls);
        return fn({ query: (sql: string, params?: unknown[]) => (sqls.push(sql), tq.query(sql, params)) });
      }),
    );
    const from = '5215544442631';
    try {
      await deliver([text(from, 'hola')]);
      await echo([{ from: '525512340031', to: from, id: newWamid('ECHO'), timestamp: nowTs(), type: 'text', text: { body: 'Hola, ¿en qué te ayudo?' } }]);
    } finally {
      spy.mockRestore();
    }
    const stores = txs.filter((sqls) => sqls.some((s) => s.includes('INSERT INTO messages') && s.includes('wa_ts')));
    expect(stores).toHaveLength(2);
    for (const sqls of stores) {
      const channelLock = sqls.findIndex((s) => /FROM channels WHERE id = \$1 FOR KEY SHARE/.test(s));
      const contactLock = sqls.findIndex((s) => /FROM contacts WHERE id = \$1 FOR NO KEY UPDATE/.test(s));
      expect(channelLock).toBeGreaterThanOrEqual(0);
      expect(channelLock).toBeLessThan(contactLock);
    }
  });

  it.skipIf(!process.env.TEST_DATABASE_URL)('a message handled while its channel is deleted does not deadlock (PostgreSQL)', async () => {
    const created = await env.api('POST', '/api/channels', { provider: 'sandbox', name: 'Pruebas (se borra)' });
    expect(created.status).toBe(200);
    const channel = (await q(`SELECT * FROM channels WHERE id = $1`, [created.body.channel.id])).rows[0];
    const from = '5215544442632';
    await processInboundMessage(env.built.ctx, channel, text(from, 'hola'));
    await env.drain();
    const [contact] = await contactsWithPhone('525544442632');
    // Another message of this chat holds the contact while the next one arrives and the channel is deleted.
    let release!: () => void;
    let holding!: () => void;
    const held = new Promise<void>((r) => (holding = r));
    const other = env.built.ctx.db.tx(async (tq) => {
      await tq.query(`SELECT 1 FROM contacts WHERE id = $1 FOR NO KEY UPDATE`, [contact.id]);
      holding();
      await new Promise<void>((r) => (release = r));
    });
    await held;
    const inbound = processInboundMessage(env.built.ctx, channel, text(from, 'sigo aquí'));
    await lockWaiters(1);
    const removal = env.built.ctx.db.query(`DELETE FROM channels WHERE id = $1`, [channel.id]);
    await lockWaiters(2);
    release();
    await other;
    const [stored, deleted] = await Promise.allSettled([inbound, removal]);
    expect(deleted).toMatchObject({ status: 'fulfilled' });
    expect(stored).toMatchObject({ status: 'fulfilled' });
    await env.drain();
    const rows = (await q(`SELECT body, channel_id FROM messages WHERE contact_id = $1 ORDER BY created_at`, [contact.id])).rows;
    expect(rows).toEqual([
      { body: 'hola', channel_id: null },
      { body: 'sigo aquí', channel_id: null },
    ]);
  });
});

describe('Brazilian and Argentine leads who write first (#27)', () => {
  it('lists the other forms of the same mobile number', () => {
    expect(phoneVariants('551187654321')).toEqual(['5511987654321']);
    expect(phoneVariants('5511987654321')).toEqual(['551187654321']);
    expect(phoneVariants('551134567890')).toEqual([]); // landline: no 9th digit
    expect(phoneVariants('5491123456789').sort()).toEqual(['541123456789', '54111523456789', '54112153456789', '54112315456789'].sort());
    expect(phoneVariants('541123456789')).toContain('5491123456789');
    expect(phoneVariants('5215512345678')).toEqual([]);
  });

  it('a lead stored with the 9th digit receives the messages of the 9-less WhatsApp id', async () => {
    const lead = await newContact('+55 11 98765-4321', 'Lead Brasil');
    expect(lead.phone).toBe('5511987654321');
    const m = text('551187654321', 'Oi, tenho interesse');
    await deliver([m]);
    expect((await messageByWamid(m.id)).contact_id).toBe(lead.id);
    expect(await contactsWithPhone('551187654321')).toHaveLength(0);
    expect((await q(`SELECT wa_id FROM contacts WHERE id = $1`, [lead.id])).rows[0].wa_id).toBe('551187654321');
    // Later messages and sends keep using the same contact
    const again = text('551187654321', 'Ainda está disponível?');
    await deliver([again]);
    expect((await messageByWamid(again.id)).contact_id).toBe(lead.id);
  });

  it('an Argentine lead without the mobile 9 (or with the local 15) receives the 549 WhatsApp id', async () => {
    const lead = await newContact('+54 11 2345-6789', 'Lead Argentina');
    expect(lead.phone).toBe('541123456789');
    const m = text('5491123456789', 'Hola, quiero info');
    await deliver([m]);
    expect((await messageByWamid(m.id)).contact_id).toBe(lead.id);
    expect(await contactsWithPhone('5491123456789')).toHaveLength(0);

    const local = await newContact('+54 351 15 456 7890', 'Lead Córdoba');
    expect(local.phone).toBe('54351154567890');
    const m2 = text('5493514567890', 'Buenas');
    await deliver([m2]);
    expect((await messageByWamid(m2.id)).contact_id).toBe(local.id);
  });

  it('never takes a lead another WhatsApp id already claimed', async () => {
    const lead = await newContact('+55 21 98888-7777', 'Ya vinculado');
    await q(`UPDATE contacts SET wa_id = '5521900000001' WHERE id = $1`, [lead.id]);
    const m = text('552188887777', 'Olá');
    await deliver([m]);
    expect((await messageByWamid(m.id)).contact_id).not.toBe(lead.id);
  });
});

describe('templates edited at Meta (#35)', () => {
  /** One row per channel of the WABA; all of them follow Meta. */
  async function stored() {
    const rows = (await q(`SELECT status, components FROM templates WHERE workspace_id = $1 AND name = 'pedido'`, [ws])).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toEqual(rows[0]);
    return rows[0];
  }

  it('an APPROVED event after an edit refreshes the components, keeping the status of the events', async () => {
    expect((await stored()).components[0].text).toBe('Hola {{1}}, tu pedido está listo');
    // Edited in WhatsApp Manager; Meta's list still says PENDING when the event arrives
    remoteTemplates = [{ ...remoteTemplates[0], status: 'PENDING', components: [{ type: 'BODY', text: 'Hola {{1}}, tu pedido {{2}} está listo' }] }];
    const event = (e: string) =>
      envelope('message_template_status_update', { event: e, message_template_id: 'tp1', message_template_name: 'pedido', message_template_language: 'es_MX', reason: 'NONE' });
    await post(event('PENDING'));
    await env.drain();
    await post(event('APPROVED'));
    await env.drain();
    const t = await stored();
    expect(t.status).toBe('APPROVED');
    expect(t.components[0].text).toBe('Hola {{1}}, tu pedido {{2}} está listo');
    const api = await env.api('GET', '/api/templates');
    expect(api.body.templates.find((x: any) => x.name === 'pedido').components[0].text).toContain('{{2}}');
  });

  it('a message_template_components_update refreshes them too', async () => {
    remoteTemplates = [{ ...remoteTemplates[0], status: 'APPROVED', components: [{ type: 'BODY', text: 'Hola {{1}}, pedido {{2}} listo en {{3}}' }] }];
    await post(
      envelope('message_template_components_update', {
        message_template_id: 'tp1',
        message_template_name: 'pedido',
        message_template_language: 'es_MX',
        message_template_element: 'Hola {{1}}, pedido {{2}} listo en {{3}}',
      }),
    );
    await env.drain();
    expect((await stored()).components[0].text).toBe('Hola {{1}}, pedido {{2}} listo en {{3}}');
  });
});

describe('opt-out from buttons (#42)', () => {
  it('only explicit opt-out phrases count on buttons and list options', () => {
    const button = (text: string, payload = text) => parseInboundContent({ type: 'button', button: { text, payload } });
    expect(optOutKeyword(button('Alto', 'nivel_alto'))).toBeNull();
    expect(optOutKeyword(button('Alto'))).toBeNull();
    expect(optOutKeyword(button('Baja'))).toBeNull();
    expect(optOutKeyword(button('No me interesa', 'BAJA'))).toBeNull();
    expect(optOutKeyword(button('Stop promotions'))).toBe('stop promotions');
    expect(optOutKeyword(button('Detener promociones'))).toBe('detener promociones');
    expect(optOutKeyword(button('No gracias', 'STOP'))).toBe('stop');
    const list = (id: string, title: string) => parseInboundContent({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title } } });
    expect(optOutKeyword(list('prio_baja', 'Baja'))).toBeNull();
    expect(optOutKeyword(list('x', 'Cancelar suscripción'))).toBe('cancelar suscripción');
    // Typed alone, the classic keywords still opt out
    expect(optOutKeyword(parseInboundContent({ type: 'text', text: { body: 'Baja' } }))).toBe('baja');
    expect(optOutKeyword(parseInboundContent({ type: 'text', text: { body: 'ALTO' } }))).toBe('alto');
  });

  it('a survey answer "Alto" neither opts out nor skips the automation', async () => {
    const m = { from: '5215544444201', id: newWamid(), timestamp: nowTs(), type: 'button', button: { text: 'Alto', payload: 'nivel_alto' } };
    const b = { from: '5215544444202', id: newWamid(), timestamp: nowTs(), type: 'button', button: { text: 'Baja', payload: 'Baja' } };
    await deliver([m, b]);
    for (const x of [m, b]) {
      const stored = await messageByWamid(x.id);
      expect((await q(`SELECT opted_out FROM contacts WHERE id = $1`, [stored.contact_id])).rows[0].opted_out).toBe(false);
      expect((await q(`SELECT count(*)::int AS n FROM jobs WHERE type = 'automation.inbound' AND payload->>'messageId' = $1`, [stored.id])).rows[0].n).toBe(1);
    }
  });
});

describe('broadcast progress (#48)', () => {
  it('a trailing broadcast:update follows the last status of a burst', async () => {
    const b = (
      await q(
        `INSERT INTO broadcasts (workspace_id, channel_id, name, template_name, template_language, status, finished_at, total_recipients)
         VALUES ($1, $2, 'Promo', 'pedido', 'es_MX', 'completed', now(), 3) RETURNING id`,
        [ws, channelId],
      )
    ).rows[0].id;
    for (let i = 1; i <= 3; i++) {
      const c = await newContact(`+52 55 1111 480${i}`);
      const m = await outbound(c.id, `wamid.R3.BC.${i}`, { broadcastId: b });
      await q(`INSERT INTO broadcast_recipients (broadcast_id, contact_id, message_id, status) VALUES ($1, $2, $3, 'sent')`, [b, c.id, m.id]);
    }
    const hist = env.built.ctx.realtime.history;
    const status = (i: number) => ({ id: `wamid.R3.BC.${i}`, status: 'delivered', timestamp: nowTs(), recipient_id: `52551111480${i}` });
    const updatesSince = (at: number) => hist.slice(at).filter((e) => e.event === 'broadcast:update' && (e.data as any).id === b).length;
    const start = hist.length;
    await deliver([], [status(1)]);
    await deliver([], [status(2)]);
    const beforeLast = hist.length;
    await deliver([], [status(3)]);
    expect(updatesSince(start)).toBeGreaterThanOrEqual(1);
    // Within the 2 s window the last status is not shown at once, but an event always follows it
    await sleep(2300);
    expect(updatesSince(beforeLast)).toBeGreaterThanOrEqual(1);
    expect((await q(`SELECT count(*)::int AS n FROM messages WHERE broadcast_id = $1 AND status = 'delivered'`, [b])).rows[0].n).toBe(3);
  });
});

describe('inbound media (#6, #47)', () => {
  const PDF = Buffer.from('%PDF-1.4 r3 test document');

  async function deliverDocument(mediaId: string | undefined, from: string) {
    const doc = { from, id: newWamid(), timestamp: nowTs(), type: 'document', document: { ...(mediaId ? { id: mediaId } : {}), mime_type: 'application/pdf', filename: 'cotizacion.pdf' } };
    await deliver([doc]);
    return messageByWamid(doc.id);
  }

  it('streams the file to disk instead of buffering it, in a job that names its workspace', async () => {
    media['7001'] = () => ({ body: new Uint8Array(PDF) });
    const buffered = vi.spyOn(CloudApiProvider.prototype, 'downloadMedia').mockRejectedValue(new Error('buffered download'));
    try {
      const m = await deliverDocument('7001', '5215544440601');
      const after = await messageByWamid(m.wamid);
      expect(after.media_file_id).toBeTruthy();
      expect(buffered).not.toHaveBeenCalled();
      const file = (await q(`SELECT * FROM media_files WHERE id = $1`, [after.media_file_id])).rows[0];
      expect(Number(file.size)).toBe(PDF.length);
      expect(fs.readFileSync(path.join(env.config.dataDir, file.path))).toEqual(PDF);
      const job = (await q(`SELECT workspace_id FROM jobs WHERE type = 'media.download' AND payload->>'messageId' = $1`, [m.id])).rows[0];
      expect(job.workspace_id).toBe(ws);
      // No temporary file is left behind
      expect(fs.readdirSync(path.join(env.config.dataDir, 'media', '.tmp'))).toEqual([]);
    } finally {
      buffered.mockRestore();
    }
  });

  it('stops a download that goes over the limit while streaming and deletes the partial file', async () => {
    const chunk = new Uint8Array(512).fill(1);
    const f = fakeFetch([
      (c) => (c.url.endsWith('/7002') ? { json: { url: 'https://lookaside.fbsbx.com/x?mid=7002', mime_type: 'application/pdf' } } : undefined),
      (c) =>
        c.url.startsWith('https://lookaside.fbsbx.com/')
          ? {
              body: new ReadableStream({
                pull(ctrl) {
                  ctrl.enqueue(chunk); // no content-length: only counting the bytes catches it
                },
              }) as any,
            }
          : undefined,
    ]);
    const provider = new CloudApiProvider({ baseUrl: 'https://graph.facebook.com', version: 'v23.0', accessToken: 't', phoneNumberId: '1', wabaId: null, fetch: f.fetch, maxMediaBytes: 4096 });
    const dest = path.join(env.config.dataDir, 'stream-test.part');
    await expect(provider.downloadMediaToFile('7002', dest)).rejects.toMatchObject({ httpStatus: 413, retry: false });
    expect(fs.existsSync(dest)).toBe(false);
    media['7003'] = () => ({ body: new Uint8Array(3000).fill(2) });
    const ok = new CloudApiProvider({ baseUrl: 'https://graph.facebook.com', version: 'v23.0', accessToken: 't', phoneNumberId: '1', wabaId: null, fetch: meta.fetch, maxMediaBytes: 4096 });
    expect(await ok.downloadMediaToFile('7003', dest)).toEqual({ size: 3000, mime: 'application/pdf' });
    expect(fs.statSync(dest).size).toBe(3000);
  });

  it('a file that can never be downloaded says why instead of waiting forever', async () => {
    media['7004'] = () => ({ body: new Uint8Array(4), headers: { 'content-length': String(150 * 1024 * 1024) } });
    const hist = env.built.ctx.realtime.history;
    const start = hist.length;
    const m = await deliverDocument('7004', '5215544444701');
    const after = await messageByWamid(m.wamid);
    expect(after.media_file_id).toBeNull();
    expect(after.media.download_error).toMatch(/supera el máximo/);
    expect(hist.slice(start).some((e) => e.event === 'message:update' && (e.data as any).media?.download_error)).toBe(true);
  });

  it('gives up with a reason on the last attempt only', async () => {
    media['7005'] = () => ({ status: 500, json: { error: { message: 'Service temporarily unavailable', code: 2 } } });
    const m = await deliverDocument('7005', '5215544444702');
    expect((await messageByWamid(m.wamid)).media.download_error).toBeUndefined();
    const job = (await q(`SELECT id, max_attempts FROM jobs WHERE type = 'media.download' AND payload->>'messageId' = $1`, [m.id])).rows[0];
    await q(`UPDATE jobs SET attempts = max_attempts - 1, run_at = now() WHERE id = $1`, [job.id]);
    await env.drain();
    expect((await q(`SELECT status FROM jobs WHERE id = $1`, [job.id])).rows[0].status).toBe('failed');
    expect((await messageByWamid(m.wamid)).media.download_error).toBeTruthy();
  });

  it('a download whose channel was deleted, or a media message without a file id, is marked at once', async () => {
    const c = await newContact('+52 55 4444 4703');
    const { rows } = await q(
      `INSERT INTO messages (workspace_id, contact_id, channel_id, direction, type, media, status, sent_by)
       VALUES ($1, $2, NULL, 'in', 'document', '{"wa_media_id":"7006","mime":"application/pdf"}', 'received', 'contact') RETURNING id`,
      [ws, c.id],
    );
    await env.built.ctx.queue.enqueue('media.download', { messageId: rows[0].id });
    await env.drain();
    const orphan = (await q(`SELECT media FROM messages WHERE id = $1`, [rows[0].id])).rows[0];
    expect(orphan.media.download_error).toMatch(/ya no está conectado/);

    const noId = await deliverDocument(undefined, '5215544444704');
    expect(noId.media.download_error).toBeTruthy();
    expect((await q(`SELECT count(*)::int AS n FROM jobs WHERE type = 'media.download' AND payload->>'messageId' = $1`, [noId.id])).rows[0].n).toBe(0);
  });
});
