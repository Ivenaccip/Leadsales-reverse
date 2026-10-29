import net from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hmacSha256Hex } from '../lib/crypto.js';
import { createWebhookFetch, webhookResolver } from '../lib/net.js';
import { jobHandlers } from '../jobs/handlers.js';
import { PermanentJobError } from '../jobs/worker.js';
import { processInboundMessage } from '../whatsapp/inbound.js';
import { fakeFetch, setup, type FakeCall, type TestEnv } from './helpers.js';

// Regression tests for review round 4, inbound pipeline and billing (whatsapp/inbound.ts,
// services/messages.ts, services/broadcasts.ts, jobs/handlers.ts).

const PHONE_ID = '1098765400041';
const PHONE_ID_2 = '1098765400042';
const WABA_ID = '2223334400041';
const APP_SECRET = 'app-secret-r4-inbound-0123456789';
const TOKEN = 'EAAG-fake-token-r4-inbound-xxxxxxxxxxxx';

/** What Meta answers as the recipient's WhatsApp id (default: the number sent to). */
let answerWaId: (to: string) => string = (to) => to;

const meta = fakeFetch([
  (c) => {
    const m = c.url.match(/\/(\d+)\?fields=display_phone_number/);
    return m ? { json: { id: m[1], display_phone_number: '+52 55 1234 0041', verified_name: 'Tienda' } } : undefined;
  },
  (c) => (c.url.endsWith(`/${WABA_ID}/subscribed_apps`) ? { json: { success: true } } : undefined),
  (c) => (c.url.includes(`/${WABA_ID}/phone_numbers`) ? { json: { data: [{ id: PHONE_ID }, { id: PHONE_ID_2 }] } } : undefined),
  (c) =>
    c.url.includes(`/${WABA_ID}/message_templates?limit`)
      ? {
          json: {
            data: [
              { id: 'tp-promo', name: 'promo', language: 'es_MX', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Promo del mes' }] },
            ],
          },
        }
      : undefined,
  (c) => {
    if (!/\/\d+\/messages$/.test(c.url)) return undefined;
    if (c.body?.status === 'read') return { json: { success: true } };
    return { json: { messaging_product: 'whatsapp', contacts: [{ input: c.body.to, wa_id: answerWaId(c.body.to) }], messages: [{ id: `wamid.R4.OUT.${meta.calls.length}` }] } };
  },
]);

let env: TestEnv;
let ws: string;
let channelId: string;

/** Every job the code queues (outgoing webhooks never leave the test). */
const enqueued: { type: string; payload: any }[] = [];

const q = (sql: string, params: unknown[] = []) => env.built.ctx.db.query<any>(sql, params);
const nowTs = (offsetSec = 0) => String(Math.floor(Date.now() / 1000) + offsetSec);
let seq = 0;
const newWamid = (p = 'IN') => `wamid.R4.${p}.${++seq}`;

function messagesValue(messages: any[], statuses: any[] = [], phoneId = PHONE_ID) {
  return {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '525512340041', phone_number_id: phoneId },
    contacts: messages.length ? messages.map((m) => ({ profile: { name: 'Cliente' }, wa_id: m.from })) : undefined,
    messages: messages.length ? messages : undefined,
    statuses: statuses.length ? statuses : undefined,
  };
}

function echoValue(echoes: any[]) {
  return { messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_ID }, message_echoes: echoes };
}

function payload(entries: { time?: number; changes: { field: string; value: unknown }[] }[]) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: entries.map((e) => ({ id: WABA_ID, ...(e.time != null ? { time: e.time } : {}), changes: e.changes })),
  });
}

async function post(body: string) {
  const res = await env.built.app.inject({
    method: 'POST',
    url: '/webhooks/whatsapp',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${hmacSha256Hex(APP_SECRET, body)}` },
    payload: body,
  });
  expect(res.statusCode).toBe(200);
  await env.drain();
}

const deliver = (messages: any[], statuses: any[] = []) => post(payload([{ changes: [{ field: 'messages', value: messagesValue(messages, statuses) }] }]));
const echo = (echoes: any[]) => post(payload([{ changes: [{ field: 'smb_message_echoes', value: echoValue(echoes) }] }]));

function text(from: string, body: string, ts: string | null = nowTs()) {
  return { from, id: newWamid(), ...(ts ? { timestamp: ts } : {}), type: 'text', text: { body } };
}

function notice(from: string, newWaId: string) {
  return { from, id: newWamid('SYS'), timestamp: nowTs(), type: 'system', system: { body: `Cambió a ${newWaId}`, new_wa_id: newWaId, type: 'customer_changed_number' } };
}

async function messageByWamid(wamid: string) {
  return (await q(`SELECT *, (extract(epoch FROM created_at) * 1000000)::bigint AS us FROM messages WHERE workspace_id = $1 AND wamid = $2`, [ws, wamid])).rows[0];
}

async function contactsWithPhone(phone: string) {
  return (await q(`SELECT * FROM contacts WHERE workspace_id = $1 AND phone = $2`, [ws, phone])).rows;
}

async function contactById(id: string) {
  return (await q(`SELECT * FROM contacts WHERE id = $1`, [id])).rows[0];
}

async function newContact(phone: string, name = 'Lead') {
  const r = await env.api('POST', '/api/contacts', { phone, name });
  expect(r.status).toBe(200);
  return r.body.contact;
}

async function outbound(contactId: string, wamid: string, o: { cost?: number; prepaid?: boolean } = {}) {
  const { rows } = await q(
    `INSERT INTO messages (workspace_id, contact_id, channel_id, direction, type, body, wamid, status, sent_by, billing_category, cost, charged_prepaid)
     VALUES ($1, $2, $3, 'out', 'template', 'Plantilla', $4, 'sent', 'user', 'marketing', $5, $6) RETURNING *`,
    [ws, contactId, channelId, wamid, o.cost ?? 0, o.prepaid ?? false],
  );
  return rows[0];
}

const sendCalls = (phoneId = PHONE_ID) => meta.calls.filter((c: FakeCall) => c.url.endsWith(`/${phoneId}/messages`) && c.body?.status !== 'read');
const sendTemplate = (contactId: string) => env.api('POST', `/api/contacts/${contactId}/messages`, { type: 'template', name: 'promo', language: 'es_MX' });
const balance = async () => Number((await q(`SELECT credit_balance FROM workspaces WHERE id = $1`, [ws])).rows[0].credit_balance);
const rate = async (market: string, category = 'marketing') =>
  Number((await q(`SELECT price FROM rate_card WHERE market = $1 AND category = $2`, [market, category])).rows[0].price);
const setBilling = (mode: 'prepaid' | 'meta_direct', credits = 0) =>
  q(`UPDATE workspaces SET billing_mode = $2, credit_balance = $3 WHERE id = $1`, [ws, mode, credits]);

function webhooksFor(event: string, wamid: string) {
  return enqueued.filter((j) => j.type === 'webhook.deliver' && j.payload.event === event && j.payload.data.wamid === wamid);
}

beforeAll(async () => {
  env = await setup({ fetch: meta.fetch });
  ws = (await env.register('r4-inbound@test.com')).workspaceId;
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
  // The operator connected it with its own app: its payloads may move prepaid money.
  await q(`UPDATE channels SET operator_verified = true WHERE id = $1`, [channelId]);
  await q(`INSERT INTO webhook_endpoints (workspace_id, url, secret, events) VALUES ($1, 'https://hooks.example.com/r4', 's3cret', '{}')`, [ws]);

  const queue = env.built.ctx.queue;
  const original = queue.enqueue.bind(queue);
  queue.enqueue = (async (...args: Parameters<typeof original>) => {
    const [type, p] = args;
    enqueued.push({ type, payload: p });
    if (type === 'webhook.deliver') return null;
    return original(...args);
  }) as typeof queue.enqueue;
});
afterAll(() => env.close());
beforeEach(async () => {
  answerWaId = (to) => to;
  await setBilling('meta_direct');
});

describe('a failure reported again (#6)', () => {
  it('is stored and reported to integrations once, however many times Meta delivers it', async () => {
    const c = await newContact('+52 55 4444 0601');
    await outbound(c.id, 'wamid.R4.FAIL.1');
    const failed = { id: 'wamid.R4.FAIL.1', status: 'failed', timestamp: nowTs(), recipient_id: '525544440601', errors: [{ code: 131026, title: 'Message undeliverable' }] };
    await deliver([], [failed]);
    await deliver([], [failed]);
    // A retried job runs every status of its payload again.
    await deliver([], [failed, { id: 'wamid.R4.NOT.STORED', status: 'sent', timestamp: nowTs(), recipient_id: '525544440602' }]);
    await q(`UPDATE jobs SET run_at = now() WHERE status = 'queued' AND type = 'wa.webhook'`);
    await env.drain();
    expect(webhooksFor('message.status', 'wamid.R4.FAIL.1')).toHaveLength(1);
    expect((await messageByWamid('wamid.R4.FAIL.1')).error.code).toBe(131026);

    // Another explanation of the same failure replaces the stored one, still without a second webhook.
    await deliver([], [{ ...failed, errors: [{ code: 131049, title: 'Not delivered to maintain healthy ecosystem engagement' }] }]);
    expect((await messageByWamid('wamid.R4.FAIL.1')).error.code).toBe(131049);
    expect(webhooksFor('message.status', 'wamid.R4.FAIL.1')).toHaveLength(1);
  });
});

describe('template events applied in the order Meta raised them (#7)', () => {
  const tpl = (event: string, reason = 'NONE') => ({
    field: 'message_template_status_update',
    value: { event, message_template_id: 777041, message_template_name: 'estado', message_template_language: 'es_MX', reason },
  });
  const category = (newCategory: string) => ({
    field: 'template_category_update',
    value: { message_template_id: 777041, message_template_name: 'estado', message_template_language: 'es_MX', previous_category: 'UTILITY', new_category: newCategory },
  });
  const stored = async () => (await q(`SELECT status, rejected_reason, category FROM templates WHERE channel_id = $1 AND meta_id = '777041'`, [channelId])).rows[0];

  it('a redelivered older status or category does not undo a newer one', async () => {
    await q(
      `INSERT INTO templates (workspace_id, channel_id, meta_id, name, language, category, status, components)
       VALUES ($1, $2, '777041', 'estado', 'es_MX', 'utility', 'PENDING', '[]')`,
      [ws, channelId],
    );
    const t0 = Math.floor(Date.now() / 1000) - 3600;
    await post(payload([{ time: t0 + 10, changes: [tpl('REJECTED', 'INVALID_FORMAT')] }]));
    expect((await stored()).status).toBe('REJECTED');
    await post(payload([{ time: t0 + 20, changes: [tpl('APPROVED')] }]));
    expect((await stored()).status).toBe('APPROVED');
    // Notification 1 again (a retry after an outage of this server): it is older than the approval.
    await post(payload([{ time: t0 + 10, changes: [tpl('REJECTED', 'INVALID_FORMAT')] }]));
    expect(await stored()).toMatchObject({ status: 'APPROVED', rejected_reason: null });
    // Paused later on: a newer event still applies.
    await post(payload([{ time: t0 + 30, changes: [tpl('PAUSED')] }]));
    expect((await stored()).status).toBe('PAUSED');

    await post(payload([{ time: t0 + 20, changes: [category('MARKETING')] }]));
    expect((await stored()).category).toBe('marketing');
    await post(payload([{ time: t0 + 15, changes: [category('UTILITY')] }]));
    expect((await stored()).category).toBe('marketing');
  });

  it('an event dated in the future does not freeze the template against the genuine ones after it', async () => {
    await q(
      `INSERT INTO templates (workspace_id, channel_id, meta_id, name, language, category, status, components)
       VALUES ($1, $2, '777043', 'futuro', 'es_MX', 'marketing', 'PENDING', '[]')`,
      [ws, channelId],
    );
    const ids = { message_template_id: 777043, message_template_name: 'futuro', message_template_language: 'es_MX' };
    const events = (status: string, newCategory: string) => [
      { field: 'message_template_status_update', value: { ...ids, event: status, reason: 'NONE' } },
      { field: 'template_category_update', value: { ...ids, previous_category: 'MARKETING', new_category: newCategory } },
    ];
    const row = async () => (await q(`SELECT status, category FROM templates WHERE channel_id = $1 AND meta_id = '777043'`, [channelId])).rows[0];
    // Signed with the business's own App Secret while it paid Meta directly, dated in the year 3000.
    await post(payload([{ time: 32503680000, changes: events('APPROVED', 'UTILITY') }]));
    expect(await row()).toEqual({ status: 'APPROVED', category: 'utility' });
    // Meta recategorizes and pauses it afterwards.
    await post(payload([{ time: Math.floor(Date.now() / 1000), changes: events('PAUSED', 'MARKETING') }]));
    expect(await row()).toEqual({ status: 'PAUSED', category: 'marketing' });
  });
});

describe('positions inside one payload (#8)', () => {
  it('messages of different entries or changes received together never share a time', async () => {
    const from = '525544440801';
    // One customer's burst in one Meta second, batched by Meta into two entries of one POST.
    const ts = nowTs();
    const first = text(from, 'primero', ts);
    const second = text(from, 'segundo', ts);
    await post(
      payload([
        { changes: [{ field: 'messages', value: messagesValue([first]) }] },
        { changes: [{ field: 'messages', value: messagesValue([second]) }] },
      ]),
    );
    const a = await messageByWamid(first.id);
    const b = await messageByWamid(second.id);
    expect(Number(b.us)).toBeGreaterThan(Number(a.us));

    // A reply typed on the phone, then the customer's answer, in one payload.
    const phoneReply = { from: '525512340041', to: from, id: newWamid('ECHO'), timestamp: ts, type: 'text', text: { body: 'te respondo' } };
    const answer = text(from, 'gracias', ts);
    await post(
      payload([
        {
          changes: [
            { field: 'smb_message_echoes', value: echoValue([phoneReply]) },
            { field: 'messages', value: messagesValue([answer]) },
          ],
        },
      ]),
    );
    expect(Number((await messageByWamid(answer.id)).us)).toBeGreaterThan(Number((await messageByWamid(phoneReply.id)).us));
    expect((await contactsWithPhone(from))[0].unread_count).toBeGreaterThan(0);
  });
});

describe('messages delivered late within one Meta second (#26)', () => {
  it('keep the order they reached us, each on a time of its own', async () => {
    const from = '525544442601';
    const late = nowTs(-300);
    const hola = text(from, 'Hola', late);
    const precio = text(from, 'quiero el precio', late);
    const foto = text(from, 'y una foto', late);
    await deliver([hola]);
    await deliver([precio]);
    await deliver([foto]);
    const times = await Promise.all([hola, precio, foto].map(async (m) => Number((await messageByWamid(m.id)).us)));
    expect(times[1]).toBeGreaterThan(times[0]);
    expect(times[2]).toBeGreaterThan(times[1]);
    const contact = (await contactsWithPhone(from))[0];
    const chat = (await q(`SELECT body FROM messages WHERE contact_id = $1 ORDER BY created_at, id`, [contact.id])).rows.map((r: any) => r.body);
    expect(chat).toEqual(['Hola', 'quiero el precio', 'y una foto']);
    expect(contact.last_message_preview).toBe('y una foto');
  });
});

describe('template categories never make a send free (#9)', () => {
  it('a category update with a category Meta does not have is ignored', async () => {
    const before = (await q(`SELECT category FROM templates WHERE channel_id = $1 AND name = 'promo'`, [channelId])).rows[0].category;
    expect(before).toBe('marketing');
    await post(
      payload([
        {
          time: Math.floor(Date.now() / 1000),
          changes: [
            {
              field: 'template_category_update',
              value: { message_template_id: 'tp-promo', message_template_name: 'promo', message_template_language: 'es_MX', previous_category: 'MARKETING', new_category: 'SERVICE' },
            },
          ],
        },
      ]),
    );
    expect((await q(`SELECT category FROM templates WHERE channel_id = $1 AND name = 'promo'`, [channelId])).rows[0].category).toBe('marketing');
  });

  it('a template stored as "service" is priced (and estimated) as marketing', async () => {
    // Left by a forged webhook while the business still held its own app's secret.
    await q(`UPDATE templates SET category = 'service' WHERE channel_id = $1 AND name = 'promo'`, [channelId]);
    try {
      const c = await newContact('+52 55 4444 0901');
      await setBilling('prepaid', 0);
      const refused = await sendTemplate(c.id);
      expect(refused.status).toBe(402);
      expect(refused.body.error.code).toBe('INSUFFICIENT_CREDITS');

      await setBilling('prepaid', 1);
      const sent = await sendTemplate(c.id);
      expect(sent.status).toBe(200);
      expect(sent.body.message.billing_category).toBe('marketing');
      expect(Number(sent.body.message.cost)).toBe(await rate('MX'));
      expect(await balance()).toBeCloseTo(1 - (await rate('MX')), 6);

      const est = await env.api('POST', '/api/broadcasts/estimate', {
        channel_id: channelId,
        template_name: 'promo',
        template_language: 'es_MX',
        audience: { contact_ids: [c.id] },
      });
      expect(est.status).toBe(200);
      expect(est.body.estimate).toMatchObject({ category: 'marketing', cost: await rate('MX') });
    } finally {
      await q(`UPDATE templates SET category = 'marketing' WHERE channel_id = $1 AND name = 'promo'`, [channelId]);
    }
  });
});

describe('sends go to, and are priced by, a number in the contact\'s own country (#10)', () => {
  const CO = '573001234567';
  // A different Chilean number per test: a wa_id another contact holds is never stored anyway.
  const CL = (n: number) => `5691234567${n}`;

  it('a stored WhatsApp id in another country is neither messaged nor priced', async () => {
    const c = await newContact(`+${CO}`);
    // Left by a status forged while the business still held its own app's secret.
    await q(`UPDATE contacts SET wa_id = $2 WHERE id = $1`, [c.id, CL(1)]);
    await setBilling('prepaid', 1);
    const sent = await sendTemplate(c.id);
    expect(sent.status).toBe(200);
    expect(sendCalls().at(-1)!.body.to).toBe(CO);
    expect(Number(sent.body.message.cost)).toBe(await rate('CO'));
  });

  it('a status naming a number in another country is not stored as the WhatsApp id', async () => {
    const c = await newContact('+57 300 123 0002');
    await outbound(c.id, 'wamid.R4.WAID.1');
    await deliver([], [{ id: 'wamid.R4.WAID.1', status: 'delivered', timestamp: nowTs(), recipient_id: CL(2) }]);
    expect((await contactById(c.id)).wa_id).toBeNull();
  });

  it("Meta's answer naming a number in another country is not stored either", async () => {
    const c = await newContact('+57 300 123 0003');
    answerWaId = () => CL(3);
    const sent = await sendTemplate(c.id);
    expect(sent.status).toBe(200);
    expect((await contactById(c.id)).wa_id).toBeNull();
  });

  it("another form of the contact's own number (Brazil's 9th digit) is still learned from a status", async () => {
    const c = await newContact('+55 11 98765 0010');
    await outbound(c.id, 'wamid.R4.WAID.BR');
    await deliver([], [{ id: 'wamid.R4.WAID.BR', status: 'delivered', timestamp: nowTs(), recipient_id: '551187650010' }]);
    expect((await contactById(c.id)).wa_id).toBe('551187650010');
    expect((await sendTemplate(c.id)).status).toBe(200);
    expect(sendCalls().at(-1)!.body.to).toBe('551187650010');
  });

  it("reconciliation prices by the number Meta says it delivered to", async () => {
    const c = await newContact('+57 300 123 0004');
    await setBilling('prepaid', 1);
    const sent = await sendTemplate(c.id);
    expect(Number(sent.body.message.cost)).toBe(await rate('CO'));
    const status = {
      id: sent.body.message.wamid,
      status: 'sent',
      timestamp: nowTs(),
      recipient_id: CL(4),
      pricing: { billable: true, pricing_model: 'PMP', category: 'marketing' },
    };
    await deliver([], [status]);
    const row = await messageByWamid(sent.body.message.wamid);
    expect(Number(row.cost)).toBe(await rate('CL'));
    expect(await balance()).toBeCloseTo(1 - (await rate('CL')), 6);
  });
});

describe('number changes (#25, #34)', () => {
  it('a late status of a message sent before the change does not point the contact back at the old number', async () => {
    const OLD = '573001112225';
    const NEW = '573009998825';
    await deliver([text(OLD, 'hola')]);
    const c = (await contactsWithPhone(OLD))[0];
    await outbound(c.id, 'wamid.R4.BEFORE.1');
    await deliver([notice(OLD, NEW)]);
    expect(await contactById(c.id)).toMatchObject({ phone: NEW, wa_id: NEW });
    // The customer reads the earlier reply after changing number (or Meta redelivers its status).
    await deliver([], [{ id: 'wamid.R4.BEFORE.1', status: 'read', timestamp: nowTs(), recipient_id: OLD }]);
    expect(await contactById(c.id)).toMatchObject({ phone: NEW, wa_id: NEW });
    expect((await sendTemplate(c.id)).status).toBe(200);
    expect(sendCalls().at(-1)!.body.to).toBe(NEW);
  });

  it('a late message, a phone reply or a repeated notice from the old number stays with the contact that moved', async () => {
    const OLD = '573001112234';
    const NEW = '573009998834';
    await deliver([text(OLD, 'hola')]);
    const c = (await contactsWithPhone(OLD))[0];
    await deliver([notice(OLD, NEW)]);
    expect(await contactById(c.id)).toMatchObject({ phone: NEW, wa_id: NEW });

    // Sent from the old number just before the change, delivered after the notice.
    const late = text(OLD, 'último mensaje del número viejo', nowTs(-90));
    await deliver([late]);
    // A reply typed in the old chat on the phone before the change, and the notice again through another number.
    const reply = { from: '525512340041', to: OLD, id: newWamid('ECHO'), timestamp: nowTs(-60), type: 'text', text: { body: 'ok' } };
    await echo([reply]);
    await deliver([notice(OLD, NEW)]);

    expect(await contactsWithPhone(OLD)).toHaveLength(0);
    expect((await messageByWamid(late.id)).contact_id).toBe(c.id);
    expect((await messageByWamid(reply.id)).contact_id).toBe(c.id);
    expect(await contactById(c.id)).toMatchObject({ phone: NEW, wa_id: NEW });
    // Too old to answer: no welcome, bot or AI reply for it (they would go to the old number or repeat).
    const lateRow = await messageByWamid(late.id);
    expect(enqueued.filter((j) => j.type === 'automation.inbound' && j.payload.messageId === lateRow.id)).toHaveLength(0);
    const events = (await q(`SELECT data FROM contact_events WHERE contact_id = $1 AND type = 'number_changed'`, [c.id])).rows;
    expect(events).toHaveLength(1);
  });

  it('what is stamped after the change comes from whoever holds the old number now: a new lead', async () => {
    const OLD = '573001112299';
    const NEW = '573009998899';
    await deliver([text(OLD, 'hola, soy Ana', nowTs(-7200))]);
    const ana = (await contactsWithPhone(OLD))[0];
    await deliver([{ ...notice(OLD, NEW), timestamp: nowTs(-3600) }]);
    expect(await contactById(ana.id)).toMatchObject({ phone: NEW, wa_id: NEW });

    // Ana's old line now belongs to Luis, who writes for the first time; the business answers him on the phone.
    const luis = text(OLD, 'Hola, soy Luis, quiero información');
    await deliver([luis]);
    const reply = { from: '525512340041', to: OLD, id: newWamid('ECHO'), timestamp: nowTs(), type: 'text', text: { body: 'Hola Luis' } };
    await echo([reply]);

    const leads = await contactsWithPhone(OLD);
    expect(leads).toHaveLength(1);
    expect(leads[0].id).not.toBe(ana.id);
    const row = await messageByWamid(luis.id);
    expect(row.contact_id).toBe(leads[0].id);
    expect((await messageByWamid(reply.id)).contact_id).toBe(leads[0].id);
    expect(enqueued.filter((j) => j.type === 'automation.inbound' && j.payload.messageId === row.id)).toHaveLength(1);
    expect(await contactById(ana.id)).toMatchObject({ phone: NEW, wa_id: NEW });
    expect((await sendTemplate(leads[0].id)).status).toBe(200);
    expect(sendCalls().at(-1)!.body.to).toBe(OLD);
  });

  it('a notice of a change already made never moves the contact again, even after a later change', async () => {
    const OLD = '573001112244';
    const NEW = '573009998844';
    const NEW2 = '573007776644';
    await deliver([text(OLD, 'hola')]);
    const c = (await contactsWithPhone(OLD))[0];
    const first = notice(OLD, NEW);
    await deliver([first]);
    await deliver([notice(NEW, NEW2)]);
    expect(await contactById(c.id)).toMatchObject({ phone: NEW2, wa_id: NEW2 });
    // The first change, notified late through another of the business's numbers.
    await deliver([{ ...first, id: newWamid('SYS') }]);
    expect(await contactById(c.id)).toMatchObject({ phone: NEW2, wa_id: NEW2 });
    expect((await q(`SELECT count(*)::int AS n FROM contact_events WHERE contact_id = $1 AND type = 'number_changed'`, [c.id])).rows[0].n).toBe(2);
  });

  it('the same change notified at once through two business numbers is recorded once', async () => {
    const channel = (await q(`SELECT * FROM channels WHERE id = $1`, [channelId])).rows[0];
    for (let i = 0; i < 3; i++) {
      const OLD = `57300111330${i}`;
      const NEW = `57300999330${i}`;
      await processInboundMessage(env.built.ctx, channel, text(OLD, 'hola'));
      const c = (await contactsWithPhone(OLD))[0];
      await Promise.all([processInboundMessage(env.built.ctx, channel, notice(OLD, NEW)), processInboundMessage(env.built.ctx, channel, notice(OLD, NEW))]);
      expect(await contactById(c.id)).toMatchObject({ phone: NEW, wa_id: NEW });
      const events = (await q(`SELECT data FROM contact_events WHERE contact_id = $1 AND type = 'number_changed'`, [c.id])).rows;
      expect(events).toHaveLength(1);
      expect(events[0].data).toMatchObject({ old_phone: OLD, new_phone: NEW });
    }
  });

  it('a contact an earlier version pointed back at the old number is written to on the one it moved to', async () => {
    const OLD = '573001112277';
    const NEW = '573009998877';
    await deliver([text(OLD, 'hola')]);
    const c = (await contactsWithPhone(OLD))[0];
    await deliver([notice(OLD, NEW)]);
    // What the previous rememberRecipient left in existing databases (a late status from the old number).
    await q(`UPDATE contacts SET wa_id = $2 WHERE id = $1`, [c.id, OLD]);
    const sent = await env.api('POST', `/api/contacts/${c.id}/messages`, { type: 'text', text: 'seguimos por aquí' });
    expect(sent.status).toBe(200);
    expect(sendCalls().at(-1)!.body.to).toBe(NEW);
  });
});

describe('a broadcast whose number is deleted (#35)', () => {
  it('pauses instead of sending from another number, and resumes only on a number chosen on purpose', async () => {
    const second = await env.api('POST', '/api/channels', {
      provider: 'cloud_api',
      name: 'Campañas',
      phone_number_id: PHONE_ID_2,
      waba_id: WABA_ID,
      access_token: TOKEN,
      app_secret: APP_SECRET,
    });
    expect(second.status).toBe(200);
    const campaigns = second.body.channel.id;
    const a = await newContact('+52 55 4444 3501');
    const b = await newContact('+52 55 4444 3502');
    const created = await env.api('POST', '/api/broadcasts', {
      name: 'Campaña',
      channel_id: campaigns,
      template_name: 'promo',
      template_language: 'es_MX',
      audience: { contact_ids: [a.id, b.id] },
      scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(created.status).toBe(200);
    const id = created.body.broadcast.id;
    expect((await env.api('POST', `/api/broadcasts/${id}/launch`)).body.broadcast.status).toBe('scheduled');

    expect((await env.api('DELETE', `/api/channels/${campaigns}`)).status).toBe(204);
    const before = sendCalls().length;
    await q(`UPDATE broadcasts SET scheduled_at = now() WHERE id = $1`, [id]);
    await q(`UPDATE jobs SET run_at = now() WHERE status = 'queued' AND type = 'broadcast.process'`);
    await env.drain();
    const paused = (await env.api('GET', `/api/broadcasts/${id}`)).body.broadcast;
    expect(paused.status).toBe('paused');
    expect(paused.last_error).toMatch(/Se eliminó el número/);
    expect(sendCalls().length).toBe(before);

    // Resuming, or an edit that names no number, never falls back to the default number.
    const resume = await env.api('POST', `/api/broadcasts/${id}/launch`);
    expect(resume.status).toBe(400);
    expect(resume.body.error.code).toBe('NO_CHANNEL');
    const rename = await env.api('PATCH', `/api/broadcasts/${id}`, { name: 'Campaña 2' });
    expect(rename.status).toBe(400);
    expect(rename.body.error.code).toBe('NO_CHANNEL');
    expect((await env.api('GET', `/api/broadcasts/${id}`)).body.broadcast.channel_id).toBeNull();

    const chosen = await env.api('PATCH', `/api/broadcasts/${id}`, { channel_id: channelId });
    expect(chosen.status).toBe(200);
    expect((await env.api('POST', `/api/broadcasts/${id}/launch`)).status).toBe(200);
    await env.drain();
    expect((await env.api('GET', `/api/broadcasts/${id}`)).body.broadcast.status).toBe('completed');
    expect(sendCalls().length).toBe(before + 2);
  });

  it('a broadcast running when its number is deleted pauses too', async () => {
    const second = await env.api('POST', '/api/channels', {
      provider: 'cloud_api',
      name: 'Campañas 2',
      phone_number_id: PHONE_ID_2,
      waba_id: WABA_ID,
      access_token: TOKEN,
      app_secret: APP_SECRET,
    });
    const campaigns = second.body.channel.id;
    const c = await newContact('+52 55 4444 3503');
    const created = await env.api('POST', '/api/broadcasts', {
      name: 'En curso',
      channel_id: campaigns,
      template_name: 'promo',
      template_language: 'es_MX',
      audience: { contact_ids: [c.id] },
    });
    const id = created.body.broadcast.id;
    // Launched, then the number goes before the queued run starts.
    const launched = await env.built.ctx.db.tx(async (tx) => {
      await tx.query(`UPDATE broadcasts SET status = 'running', started_at = now() WHERE id = $1`, [id]);
      return tx.query(`INSERT INTO broadcast_recipients (broadcast_id, contact_id) VALUES ($1, $2) RETURNING id`, [id, c.id]);
    });
    expect(launched.rows).toHaveLength(1);
    expect((await env.api('DELETE', `/api/channels/${campaigns}`)).status).toBe(204);
    const before = sendCalls().length;
    await jobHandlers['broadcast.process'](env.built.ctx, { broadcastId: id }, {} as any);
    expect((await env.api('GET', `/api/broadcasts/${id}`)).body.broadcast.status).toBe('paused');
    expect(sendCalls().length).toBe(before);
    expect((await q(`SELECT status FROM broadcast_recipients WHERE broadcast_id = $1`, [id])).rows[0].status).toBe('queued');
  });
});

describe('outgoing webhooks to private destinations (#17)', () => {
  async function endpoint(url: string) {
    const { rows } = await q(`INSERT INTO webhook_endpoints (workspace_id, url, secret, events) VALUES ($1, $2, 's', '{}') RETURNING id`, [ws, url]);
    return rows[0].id as string;
  }
  const lastError = async (id: string) => (await q(`SELECT last_error FROM webhook_endpoints WHERE id = $1`, [id])).rows[0].last_error as string;
  const deliverTo = (id: string, ctx = { ...env.built.ctx, webhookFetch: createWebhookFetch(false) }) =>
    jobHandlers['webhook.deliver'](ctx as any, { endpointId: id, event: 'message.received', data: {}, sentAt: new Date().toISOString() }, {} as any);

  it('a hostname that resolves to a private address fails for good, with the reason', async () => {
    const spy = vi.spyOn(webhookResolver, 'resolve4').mockResolvedValue(['10.0.0.5'] as any);
    const spy6 = vi.spyOn(webhookResolver, 'resolve6').mockResolvedValue([] as any);
    try {
      for (const url of ['http://localhost:8080/hook', 'https://internal.corp.example/hook']) {
        const id = await endpoint(url);
        const err = await deliverTo(id).catch((e) => e);
        expect(err).toBeInstanceOf(PermanentJobError);
        expect(await lastError(id)).toMatch(/red privada/);
      }
    } finally {
      spy.mockRestore();
      spy6.mockRestore();
      await q(`DELETE FROM webhook_endpoints WHERE url <> 'https://hooks.example.com/r4'`);
    }
  });

  it('other connection failures keep their reason and are retried', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((r) => server.close(() => r()));
    const id = await endpoint(`http://127.0.0.1:${port}/hook`);
    try {
      const ctx = { ...env.built.ctx, config: { ...env.built.ctx.config, allowPrivateWebhooks: true }, webhookFetch: createWebhookFetch(true) };
      const err = await deliverTo(id, ctx as any).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(PermanentJobError);
      expect(await lastError(id)).toMatch(/ECONNREFUSED/);
    } finally {
      await q(`DELETE FROM webhook_endpoints WHERE id = $1`, [id]);
    }
  });
});
