import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hmacSha256Hex } from '../lib/crypto.js';
import { deliveryNumber } from '../lib/phone.js';
import { isOptOutMessage } from '../services/automation.js';
import { CloudApiProvider } from '../whatsapp/cloud-api.js';
import { processWebhook } from '../whatsapp/inbound.js';
import { fakeFetch, setup, type FakeCall, type TestEnv } from './helpers.js';

// Regression tests for review round 5, inbound pipeline (whatsapp/inbound.ts, lib/phone.ts,
// whatsapp/cloud-api.ts, services/templates.ts, jobs/handlers.ts).

const PHONE_ID = '1098765400051';
const PHONE_ID_2 = '1098765400052';
const WABA_ID = '2223334400051';
const APP_SECRET = 'app-secret-r5-inbound-0123456789';
const TOKEN = 'EAAG-fake-token-r5-inbound-xxxxxxxxxxxx';

/** Templates as Meta lists them right now (tests change them "in WhatsApp Manager"). */
let remoteTemplates: any[] = [];
/** How Meta answers GET /{template-id}, by id (absent: the object does not exist). */
const singleTemplates: Record<string, any> = {};

const meta = fakeFetch([
  (c) => {
    const m = c.url.match(/\/(\d+)\?fields=display_phone_number/);
    return m ? { json: { id: m[1], display_phone_number: '+52 55 1234 0051', verified_name: 'Tienda' } } : undefined;
  },
  (c) => (c.url.endsWith(`/${WABA_ID}/subscribed_apps`) ? { json: { success: true } } : undefined),
  (c) => (c.url.includes(`/${WABA_ID}/phone_numbers`) ? { json: { data: [{ id: PHONE_ID }, { id: PHONE_ID_2 }] } } : undefined),
  (c) => (c.url.includes(`/${WABA_ID}/message_templates?limit`) ? { json: { data: remoteTemplates } } : undefined),
  (c) => {
    const m = c.url.match(/\/v[\d.]+\/(\d+)\?fields=id,name/);
    return m && singleTemplates[m[1]] ? { json: singleTemplates[m[1]] } : undefined;
  },
  (c) => {
    if (!/\/\d+\/messages$/.test(c.url)) return undefined;
    if (c.body?.status === 'read') return { json: { success: true } };
    return { json: { messaging_product: 'whatsapp', contacts: [{ input: c.body.to, wa_id: c.body.to }], messages: [{ id: `wamid.R5.OUT.${meta.calls.length}` }] } };
  },
]);

let env: TestEnv;
let ws: string;
let userId: string;
let channelId: string;
let channel2Id: string;

/** Every job the code queues (outgoing webhooks never leave the test). */
const enqueued: { type: string; payload: any }[] = [];
/** SQL that fails once inside a transaction (a DB blip), then works again. */
let failOnce: RegExp | null = null;

const q = (sql: string, params: unknown[] = []) => env.built.ctx.db.query<any>(sql, params);
const now = () => Math.floor(Date.now() / 1000);
const nowTs = (offsetSec = 0) => String(now() + offsetSec);
let seq = 0;
const newWamid = (p = 'IN') => `wamid.R5.${p}.${++seq}`;

function messagesValue(messages: any[], statuses: any[] = [], phoneId = PHONE_ID) {
  return {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '525512340051', phone_number_id: phoneId },
    contacts: messages.length ? messages.map((m) => ({ profile: { name: 'Cliente' }, wa_id: m.from })) : undefined,
    messages: messages.length ? messages : undefined,
    statuses: statuses.length ? statuses : undefined,
  };
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

const deliver = (messages: any[], statuses: any[] = [], phoneId = PHONE_ID) =>
  post(payload([{ changes: [{ field: 'messages', value: messagesValue(messages, statuses, phoneId) }] }]));

/** Runs the retries a test made due now (the queue waits seconds between attempts). */
async function runRetries() {
  for (let i = 0; i < 4; i++) {
    await q(`UPDATE jobs SET run_at = now() WHERE status = 'queued'`);
    await env.drain();
  }
}

function text(from: string, body: string, ts: string = nowTs()) {
  return { from, id: newWamid(), timestamp: ts, type: 'text', text: { body } };
}

function notice(from: string, newWaId: string, ts: string = nowTs()) {
  return { from, id: newWamid('SYS'), timestamp: ts, type: 'system', system: { body: `Cambió a ${newWaId}`, new_wa_id: newWaId, type: 'customer_changed_number' } };
}

async function messageByWamid(wamid: string) {
  return (await q(`SELECT * FROM messages WHERE workspace_id = $1 AND wamid = $2`, [ws, wamid])).rows[0];
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

const sendCalls = (phoneId = PHONE_ID) => meta.calls.filter((c: FakeCall) => c.url.endsWith(`/${phoneId}/messages`) && c.body?.status !== 'read');
const sentText = (c: FakeCall) => c.body?.text?.body ?? c.body?.interactive?.body?.text ?? null;
const sendTemplate = (contactId: string, name = 'promo') => env.api('POST', `/api/contacts/${contactId}/messages`, { type: 'template', name, language: 'es_MX' });
const balance = async () => Number((await q(`SELECT credit_balance FROM workspaces WHERE id = $1`, [ws])).rows[0].credit_balance);
const rate = async (market: string, category = 'marketing') =>
  Number((await q(`SELECT price FROM rate_card WHERE market = $1 AND category = $2`, [market, category])).rows[0].price);
const setBilling = (mode: 'prepaid' | 'meta_direct', credits = 0) =>
  q(`UPDATE workspaces SET billing_mode = $2, credit_balance = $3 WHERE id = $1`, [ws, mode, credits]);
const automationJobsFor = (messageId: string) => enqueued.filter((j) => j.type === 'automation.inbound' && j.payload.messageId === messageId);

/** The menu bot with a text menu (typing is the only way to answer). */
async function menuBot(options: any[], interactive = false) {
  await q(`UPDATE workspaces SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb WHERE id = $1`, [
    ws,
    JSON.stringify({
      automation_mode: 'menu',
      bot: {
        menu: { prompt: '¿Qué trámite quieres hacer?', options },
        fallback: 'No entendí tu respuesta 🙈. Elige una de las opciones:',
        handoff_message: 'Listo, te comunico con un asesor.',
        interactive,
        only_unassigned: false,
      },
    }),
  ]);
}
const automationOff = () => q(`UPDATE workspaces SET settings = COALESCE(settings, '{}'::jsonb) || '{"automation_mode":"off"}'::jsonb WHERE id = $1`, [ws]);

const PROMO = { id: '7770051', name: 'promo', language: 'es_MX', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Promo del mes' }] };

beforeAll(async () => {
  remoteTemplates = [PROMO];
  env = await setup({ fetch: meta.fetch });
  const reg = await env.register('r5-inbound@test.com');
  ws = reg.workspaceId;
  userId = reg.userId;
  const create = (name: string, phoneNumberId: string) =>
    env.api('POST', '/api/channels', { provider: 'cloud_api', name, phone_number_id: phoneNumberId, waba_id: WABA_ID, access_token: TOKEN, app_secret: APP_SECRET });
  const r = await create('Ventas', PHONE_ID);
  expect(r.status).toBe(200);
  channelId = r.body.channel.id;
  const r2 = await create('Soporte', PHONE_ID_2);
  expect(r2.status).toBe(200);
  channel2Id = r2.body.channel.id;
  // The operator connected them with its own app: their payloads may move prepaid money.
  await q(`UPDATE channels SET operator_verified = true WHERE workspace_id = $1`, [ws]);
  await q(`UPDATE channels SET is_default = (id = $2) WHERE workspace_id = $1`, [ws, channelId]);

  const queue = env.built.ctx.queue;
  const original = queue.enqueue.bind(queue);
  queue.enqueue = (async (...args: Parameters<typeof original>) => {
    const [type, p] = args;
    enqueued.push({ type, payload: p });
    if (type === 'webhook.deliver') return null;
    return original(...args);
  }) as typeof queue.enqueue;

  const db = env.built.ctx.db;
  const tx = db.tx.bind(db);
  db.tx = ((fn: any) =>
    tx((inner) =>
      fn({
        query(sql: string, params?: unknown[]) {
          if (failOnce?.test(sql)) {
            failOnce = null;
            return Promise.reject(new Error('simulado: se cortó la conexión con la base de datos'));
          }
          return inner.query(sql, params);
        },
      }),
    )) as typeof db.tx;
});
afterAll(() => env.close());
beforeEach(async () => {
  failOnce = null;
  remoteTemplates = [PROMO];
  await setBilling('meta_direct');
  await automationOff();
});

describe('contacts an old version stored under the country code + a 10-digit wa_id (#1)', () => {
  it('are messaged and priced on their real WhatsApp id; nothing else in another country is', () => {
    // Up to 850282e: wa_id 6591234567 (Singapore) in a '52' workspace was stored as phone 526591234567.
    expect(deliveryNumber('526591234567', '6591234567', '52')).toBe('6591234567');
    expect(deliveryNumber('4777123456', '4777123456', '52')).toBe('4777123456');
    // The cross-country protection holds for every other shape.
    expect(deliveryNumber('526591234567', '6591234567', '57')).toBe('526591234567');
    expect(deliveryNumber('526591234567', '6591234567')).toBe('526591234567');
    expect(deliveryNumber('573001234567', '56912345671', '57')).toBe('573001234567');
    expect(deliveryNumber('5265912345678', '65912345678', '52')).toBe('5265912345678');
    expect(deliveryNumber('525591234567', '6591234567', '52')).toBe('525591234567');
    // Other forms of the same line still go to Meta's id.
    expect(deliveryNumber('5511987650010', '551187650010', '52')).toBe('551187650010');
  });

  it('but not when that wa_id is no international number: a national one an old sandbox simulation stored', () => {
    // 850282e simulating 'from: 5512345678' stored phone 525512345678 with wa_id 5512345678: the phone is right.
    expect(deliveryNumber('525512345678', '5512345678', '52')).toBe('525512345678');
    expect(deliveryNumber('523312345678', '3312345678', '52')).toBe('523312345678');
    expect(deliveryNumber('528112345678', '8112345678', '52')).toBe('528112345678');
    expect(deliveryNumber('524421234567', '4421234567', '52')).toBe('524421234567');
    expect(deliveryNumber('573101234567', '3101234567', '57')).toBe('573101234567');
    // Countries with 10-digit numbers keep the exception: Norway, Peru (Lima), Cuba.
    expect(deliveryNumber('524791234567', '4791234567', '52')).toBe('4791234567');
    expect(deliveryNumber('525112345678', '5112345678', '52')).toBe('5112345678');
    expect(deliveryNumber('525351234567', '5351234567', '52')).toBe('5351234567');
  });

  it('such a contact is priced as the country of its phone', async () => {
    const legacy = (
      await q(`INSERT INTO contacts (workspace_id, phone, wa_id, name, source) VALUES ($1, '525512340177', '5512340177', 'Yo', 'whatsapp') RETURNING id`, [ws])
    ).rows[0];
    await q(
      `INSERT INTO messages (workspace_id, contact_id, channel_id, direction, type, body, wamid, status, sent_by, billing_category, cost)
       VALUES ($1, $2, $3, 'out', 'template', 'Plantilla', 'wamid.R5.LEGACY.2', 'sent', 'user', 'marketing', 0)`,
      [ws, legacy.id, channelId],
    );
    await deliver([], [{ id: 'wamid.R5.LEGACY.2', status: 'sent', timestamp: nowTs(), pricing: { billable: true, pricing_model: 'PMP', category: 'marketing' } }]);
    expect(Number((await messageByWamid('wamid.R5.LEGACY.2')).cost)).toBe(await rate('MX'));
  });

  it('a status without recipient reconciles at the rate of the real number, not of the country code', async () => {
    // A row 007 could not repair: another contact already holds the real number.
    await newContact('+6591234500');
    const legacy = (
      await q(`INSERT INTO contacts (workspace_id, phone, wa_id, name, source) VALUES ($1, '526591234500', '6591234500', 'Tan', 'whatsapp') RETURNING id`, [ws])
    ).rows[0];
    await q(
      `INSERT INTO messages (workspace_id, contact_id, channel_id, direction, type, body, wamid, status, sent_by, billing_category, cost)
       VALUES ($1, $2, $3, 'out', 'template', 'Plantilla', 'wamid.R5.LEGACY.1', 'sent', 'user', 'marketing', 0)`,
      [ws, legacy.id, channelId],
    );
    await deliver([], [{ id: 'wamid.R5.LEGACY.1', status: 'sent', timestamp: nowTs(), pricing: { billable: true, pricing_model: 'PMP', category: 'marketing' } }]);
    const row = await messageByWamid('wamid.R5.LEGACY.1');
    expect(row.pricing_reconciled).toBe(true);
    expect(Number(row.cost)).toBe(await rate('OTHER'));
    expect(Number(row.cost)).not.toBe(await rate('MX'));
  });
});

describe('template syncs keep the order of template events (#2)', () => {
  const tpl = (event: string, reason = 'NONE') => ({
    field: 'message_template_status_update',
    value: { event, message_template_id: Number(PROMO.id), message_template_name: 'promo', message_template_language: 'es_MX', reason },
  });
  const stored = async () => (await q(`SELECT status, status_event_at FROM templates WHERE channel_id = $1 AND name = 'promo'`, [channelId])).rows[0];
  const sync = async () => expect((await env.api('POST', '/api/templates/sync', { channel_id: channelId })).status).toBe(200);

  it('an older event delivered after a sync does not undo the newer one', async () => {
    const t0 = now() - 3600;
    await post(payload([{ time: t0 + 600, changes: [tpl('APPROVED')] }]));
    expect((await stored()).status).toBe('APPROVED');
    await sync();
    // Meta's retry of the rejection it raised before the approval reaches us only now.
    await post(payload([{ time: t0, changes: [tpl('REJECTED', 'INVALID_FORMAT')] }]));
    expect((await stored()).status).toBe('APPROVED');
    const c = await newContact('+52 55 5100 0201');
    await q(`UPDATE contacts SET channel_id = $2 WHERE id = $1`, [c.id, channelId]);
    expect((await sendTemplate(c.id)).status).toBe(200);
  });

  it('a time ahead of the clock goes back to now, so the genuine events after the sync apply', async () => {
    // Signed with the business's own App Secret, dated as far ahead as the clock skew allows.
    await post(payload([{ time: now() + 240, changes: [tpl('APPROVED')] }]));
    await sync();
    expect(new Date((await stored()).status_event_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    await new Promise((r) => setTimeout(r, 1100));
    await post(payload([{ time: now(), changes: [tpl('PAUSED')] }]));
    expect((await stored()).status).toBe('PAUSED');
    await post(payload([{ time: now(), changes: [tpl('APPROVED')] }]));
  });
});

describe('a retried webhook of a late message from the number the customer left (#3)', () => {
  it('is not answered on the new number', async () => {
    await menuBot([
      { key: '1', label: 'Ventas', reply: 'Te paso con ventas' },
      { key: '2', label: 'Soporte', reply: 'Te paso con soporte' },
    ]);
    const OLD = '525544448301';
    const NEW = '525544448302';
    await deliver([text(OLD, 'hola', nowTs(-100))]);
    const c = (await contactsWithPhone(OLD))[0];
    await deliver([notice(OLD, NEW, nowTs(-10))]);
    expect(await contactById(c.id)).toMatchObject({ phone: NEW, wa_id: NEW });
    const before = sendCalls().length;
    // Typed on the old number before the change, delivered late; the follow-ups fail once.
    const late = text(OLD, '2', nowTs(-200));
    failOnce = /UPDATE messages SET followups_done = true/;
    await deliver([late]);
    await runRetries();
    const row = await messageByWamid(late.id);
    expect(row.contact_id).toBe(c.id);
    expect(row.followups_done).toBe(true);
    expect(automationJobsFor(row.id)).toHaveLength(0);
    expect(sendCalls().slice(before)).toHaveLength(0);
  });

  it('a retry still answers a message from the number the contact has', async () => {
    await menuBot([{ key: '1', label: 'Ventas', reply: 'Te paso con ventas' }]);
    const m = text('525544448311', 'hola');
    failOnce = /UPDATE messages SET followups_done = true/;
    await deliver([m]);
    await runRetries();
    const row = await messageByWamid(m.id);
    expect(row.followups_done).toBe(true);
    expect(automationJobsFor(row.id)).toHaveLength(1);
  });
});

describe('a number change to a line the CRM has in another form (#4)', () => {
  it('Brazil without the 9th digit: links the contact saved with it, and later messages reach that contact', async () => {
    const saved = await newContact('+55 31 98765 4321', 'Número nuevo');
    expect(saved.phone).toBe('5531987654321');
    const X = '5521999990001';
    await deliver([text(X, 'oi')]);
    const x = (await contactsWithPhone(X))[0];
    await deliver([notice(X, '553187654321')]);
    const ev = (await q(`SELECT data FROM contact_events WHERE contact_id = $1 AND type = 'number_changed'`, [x.id])).rows[0].data;
    expect(ev).toMatchObject({ moved: false, other_contact_id: saved.id });
    expect(await contactById(x.id)).toMatchObject({ phone: X });
    const later = text('553187654321', 'mensagem do número novo');
    await deliver([later]);
    expect((await messageByWamid(later.id)).contact_id).toBe(saved.id);
    expect((await contactById(saved.id)).wa_id).toBe('553187654321');
  });

  it('Argentina without the 9: links the contact typed as 54 + area + number', async () => {
    await q(`UPDATE workspaces SET default_country_code = '54' WHERE id = $1`, [ws]);
    try {
      const saved = await newContact('11 4321-8765', 'Número nuevo');
      expect(saved.phone).toBe('541143218765');
      const X = '5491155550777';
      await deliver([text(X, 'hola')]);
      const x = (await contactsWithPhone(X))[0];
      await deliver([notice(X, '5491143218765')]);
      const ev = (await q(`SELECT data FROM contact_events WHERE contact_id = $1 AND type = 'number_changed'`, [x.id])).rows[0].data;
      expect(ev).toMatchObject({ moved: false, other_contact_id: saved.id });
      const later = text('5491143218765', 'desde el número nuevo');
      await deliver([later]);
      expect((await messageByWamid(later.id)).contact_id).toBe(saved.id);
    } finally {
      await q(`UPDATE workspaces SET default_country_code = '52' WHERE id = $1`, [ws]);
    }
  });
});

describe('a prepaid message Meta delivered is never refunded (#5)', () => {
  const pricing = { billable: true, pricing_model: 'PMP', category: 'marketing' };
  const failed = (id: string) => ({ id, status: 'failed', timestamp: nowTs(), recipient_id: '525544440501', errors: [{ code: 131026, title: 'Message undeliverable' }] });

  it("a 'failed' after the delivery, however many times it is processed, keeps the charge", async () => {
    const c = await newContact('+52 55 4444 0501');
    await q(`UPDATE contacts SET channel_id = $2 WHERE id = $1`, [c.id, channelId]);
    await setBilling('prepaid', 1);
    const sent = await sendTemplate(c.id);
    expect(sent.status).toBe(200);
    const wamid = sent.body.message.wamid;
    const charged = 1 - (await rate('MX'));
    await deliver([], [{ id: wamid, status: 'sent', timestamp: nowTs(), recipient_id: '525544440501', pricing }]);
    await deliver([], [{ id: wamid, status: 'delivered', timestamp: nowTs(), recipient_id: '525544440501', pricing }]);
    await deliver([], [failed(wamid)]);
    expect(await balance()).toBeCloseTo(charged, 6);
    // Meta redelivers it, and a retried job runs it again with the rest of its payload.
    await deliver([], [failed(wamid)]);
    await deliver([], [failed(wamid), { id: 'wamid.R5.NOT.STORED', status: 'sent', timestamp: nowTs(), recipient_id: '525544440502' }]);
    await runRetries();
    expect(await balance()).toBeCloseTo(charged, 6);
    const row = await messageByWamid(wamid);
    expect(row.status).toBe('failed');
    expect(Number(row.cost)).toBe(await rate('MX'));
    const refunds = (await q(`SELECT * FROM credit_ledger WHERE message_id = $1 AND kind = 'refund'`, [row.id])).rows;
    expect(refunds).toHaveLength(0);
  });

  it("a delivery processed after the message's failure takes the refund back, once", async () => {
    const c = await newContact('+52 55 4444 0502');
    await q(`UPDATE contacts SET channel_id = $2 WHERE id = $1`, [c.id, channelId]);
    await setBilling('prepaid', 1);
    const sent = await sendTemplate(c.id);
    const wamid = sent.body.message.wamid;
    const charged = 1 - (await rate('MX'));
    // Meta's statuses handled out of order: the failure first, then the 'sent' and 'delivered' it raised before.
    await deliver([], [failed(wamid)]);
    expect(await balance()).toBeCloseTo(1, 6);
    await deliver([], [{ id: wamid, status: 'sent', timestamp: nowTs(), recipient_id: '525544440502', pricing }]);
    await deliver([], [{ id: wamid, status: 'delivered', timestamp: nowTs(), recipient_id: '525544440502', pricing }]);
    expect(await balance()).toBeCloseTo(charged, 6);
    await deliver([], [{ id: wamid, status: 'delivered', timestamp: nowTs(), recipient_id: '525544440502', pricing }]);
    await deliver([], [failed(wamid)]);
    await deliver([], [{ id: wamid, status: 'read', timestamp: nowTs(), recipient_id: '525544440502' }]);
    expect(await balance()).toBeCloseTo(charged, 6);
    expect(Number((await messageByWamid(wamid)).cost)).toBe(await rate('MX'));
  });

  /** A copy of Meta's statuses signed with the business's own app (untrusted for prepaid money), or the operator's. */
  const statuses = (sts: any[], trusted: boolean) =>
    processWebhook(
      env.built.ctx,
      { object: 'whatsapp_business_account', entry: [{ id: WABA_ID, changes: [{ field: 'messages', value: messagesValue([], sts) }] }] },
      undefined,
      [channelId],
      trusted ? [channelId] : [],
    );
  const prepaidTemplate = async (phone: string) => {
    const c = await newContact(phone);
    await q(`UPDATE contacts SET channel_id = $2 WHERE id = $1`, [c.id, channelId]);
    await setBilling('prepaid', 1);
    const sent = await sendTemplate(c.id);
    expect(sent.status).toBe(200);
    expect(await balance()).toBeCloseTo(1 - (await rate('MX')), 6);
    return sent.body.message.wamid as string;
  };
  const undeliveredRefunds = async (wamid: string) =>
    (await q(`SELECT l.* FROM credit_ledger l JOIN messages m ON m.id = l.message_id WHERE m.wamid = $1 AND l.kind = 'refund'`, [wamid])).rows;

  it('an untrusted copy of the failure first does not use up the refund the trusted one gives', async () => {
    const wamid = await prepaidTemplate('+52 55 4444 0504');
    await statuses([failed(wamid)], false);
    expect(await balance()).toBeCloseTo(1 - (await rate('MX')), 6);
    expect((await messageByWamid(wamid)).status).toBe('failed');
    await statuses([failed(wamid)], true);
    await statuses([failed(wamid)], true);
    expect(await balance()).toBeCloseTo(1, 6);
    expect(await undeliveredRefunds(wamid)).toHaveLength(1);
  });

  it('also once a priced "sent" reconciled it', async () => {
    const wamid = await prepaidTemplate('+52 55 4444 0505');
    await statuses([{ id: wamid, status: 'sent', timestamp: nowTs(), recipient_id: '525544440505', pricing }], true);
    await statuses([failed(wamid)], false);
    await statuses([failed(wamid)], true);
    await statuses([failed(wamid)], true);
    expect(await balance()).toBeCloseTo(1, 6);
    expect(Number((await messageByWamid(wamid)).cost)).toBe(0);
    expect(await undeliveredRefunds(wamid)).toHaveLength(1);
  });

  it('an untrusted failure shown over the delivery does not hide it from the trusted one', async () => {
    const wamid = await prepaidTemplate('+52 55 4444 0506');
    await statuses([{ id: wamid, status: 'sent', timestamp: nowTs(), recipient_id: '525544440506', pricing }], true);
    await statuses([{ id: wamid, status: 'delivered', timestamp: nowTs(), recipient_id: '525544440506', pricing }], true);
    await statuses([failed(wamid)], false);
    await statuses([failed(wamid)], true);
    expect(await balance()).toBeCloseTo(1 - (await rate('MX')), 6);
    expect(await undeliveredRefunds(wamid)).toHaveLength(0);
  });

  it('a failure Meta priced as billable keeps its charge when it is processed again', async () => {
    const wamid = await prepaidTemplate('+52 55 4444 0507');
    await statuses([{ ...failed(wamid), pricing }], true);
    await statuses([failed(wamid)], true);
    expect(await balance()).toBeCloseTo(1 - (await rate('MX')), 6);
    expect(await undeliveredRefunds(wamid)).toHaveLength(0);
  });

  it('an undelivered message is still refunded once', async () => {
    const c = await newContact('+52 55 4444 0503');
    await q(`UPDATE contacts SET channel_id = $2 WHERE id = $1`, [c.id, channelId]);
    await setBilling('prepaid', 1);
    const sent = await sendTemplate(c.id);
    const wamid = sent.body.message.wamid;
    await deliver([], [{ id: wamid, status: 'sent', timestamp: nowTs(), recipient_id: '525544440503', pricing }]);
    await deliver([], [failed(wamid)]);
    await deliver([], [failed(wamid)]);
    expect(await balance()).toBeCloseTo(1, 6);
    expect(Number((await messageByWamid(wamid)).cost)).toBe(0);
  });
});

describe('templates past the 50th page of Meta\'s list (#13)', () => {
  const VERSION = 'v23.0';
  function pagedMeta(total: number, endless = false) {
    const all = Array.from({ length: total }, (_, i) => ({ id: String(900000 + i), name: `t_${i}`, language: 'es_MX', status: 'APPROVED', category: 'UTILITY', components: [] }));
    return fakeFetch([
      (c) => {
        if (!c.url.includes(`/${WABA_ID}/message_templates`)) return undefined;
        const after = Number(new URL(c.url).searchParams.get('after') ?? 0);
        const data = all.slice(after, after + 100);
        const next = endless || after + 100 < total ? `https://graph.facebook.com/${VERSION}/${WABA_ID}/message_templates?limit=100&after=${after + 100}` : undefined;
        return { json: { data, paging: next ? { next } : {} } };
      },
    ]);
  }
  const provider = (f: ReturnType<typeof fakeFetch>) =>
    new CloudApiProvider({ baseUrl: 'https://graph.facebook.com', version: VERSION, accessToken: TOKEN, phoneNumberId: PHONE_ID, wabaId: WABA_ID, fetch: f.fetch });

  it('the list is read to its last page', async () => {
    const list = await provider(pagedMeta(5100)).listTemplates();
    expect(list).toHaveLength(5100);
    expect(list.at(-1)!.name).toBe('t_5099');
  });

  it('a list that never ends is an error, not a partial list a sync would take as complete', async () => {
    await expect(provider(pagedMeta(100, true)).listTemplates()).rejects.toThrow(/no terminó de listar/);
  });

  it('a template edited at Meta is refreshed by its id, without reading the whole list', async () => {
    remoteTemplates = [PROMO, { id: '7770052', name: 'aviso', language: 'es_MX', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Aviso {{1}}' }] }];
    expect((await env.api('POST', '/api/templates/sync', { channel_id: channelId })).status).toBe(200);
    // Meta's list (or its first pages) does not include it any more; the template itself has the new text.
    remoteTemplates = [PROMO];
    singleTemplates['7770052'] = { id: '7770052', name: 'aviso', language: 'es_MX', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Aviso {{1}} de {{2}}' }] };
    const listed = meta.calls.filter((c) => c.url.includes('/message_templates?limit')).length;
    await post(
      payload([
        {
          changes: [
            {
              field: 'message_template_components_update',
              value: { message_template_id: 7770052, message_template_name: 'aviso', message_template_language: 'es_MX' },
            },
          ],
        },
      ]),
    );
    const t = (await q(`SELECT components FROM templates WHERE channel_id = $1 AND name = 'aviso'`, [channelId])).rows[0];
    expect(t.components[0].text).toBe('Aviso {{1}} de {{2}}');
    expect(meta.calls.filter((c) => c.url.includes('/message_templates?limit')).length).toBe(listed);
  });
});

describe('a typed answer to the bot menu that is also an opt-out word (#19)', () => {
  const options = () => [
    { key: '1', label: 'Alta', reply: 'Te ayudamos con tu alta.' },
    { key: '2', label: 'Baja', reply: 'Un asesor te ayudará con tu baja.', handoff: true, assign_user_id: userId },
  ];

  it('picks the option: no opt-out, the bot answers and hands off', async () => {
    await menuBot(options());
    const from = '525544441901';
    await deliver([text(from, 'Hola')]);
    const c = (await contactsWithPhone(from))[0];
    expect(sendCalls().at(-1)!.body.to).toBe(from);
    const answer = text(from, 'Baja');
    await deliver([answer]);
    const after = await contactById(c.id);
    expect(after.opted_out).toBe(false);
    expect(after.assigned_user_id).toBe(userId);
    expect(after.bot_state.done).toBe(true);
    expect(sentText(sendCalls().at(-1)!)).toBe('Un asesor te ayudará con tu baja.');
    const row = await messageByWamid(answer.id);
    expect(isOptOutMessage(row)).toBe(false);
    expect((await q(`SELECT 1 FROM contact_events WHERE contact_id = $1 AND type = 'opted_out'`, [c.id])).rows).toHaveLength(0);
  });

  it('also when the menu is interactive and the customer types instead of tapping', async () => {
    await menuBot(options(), true);
    const from = '525544441902';
    await deliver([text(from, 'Hola')]);
    await deliver([text(from, 'baja')]);
    const c = (await contactsWithPhone(from))[0];
    expect((await contactById(c.id)).opted_out).toBe(false);
    expect(sentText(sendCalls().at(-1)!)).toBe('Un asesor te ayudará con tu baja.');
  });

  it('"Baja" with no menu waiting for an answer is still an opt-out', async () => {
    await menuBot(options());
    const from = '525544441903';
    // The bot has not sent its menu yet: the classic keyword.
    await deliver([text(from, 'BAJA')]);
    const c = (await contactsWithPhone(from))[0];
    expect((await contactById(c.id)).opted_out).toBe(true);
    // Once the bot finished, too.
    await automationOff();
    const done = '525544441904';
    await deliver([text(done, 'Hola')]);
    await q(`UPDATE contacts SET bot_state = '{"path":[],"done":true}' WHERE workspace_id = $1 AND phone = $2`, [ws, done]);
    await menuBot(options());
    await deliver([text(done, 'Baja')]);
    expect((await contactsWithPhone(done))[0].opted_out).toBe(true);
  });
});

describe('an older message to another of the business numbers, delivered late (#29)', () => {
  it('does not move the conversation back to that number', async () => {
    const from = '525544442901';
    // To Soporte (B) at 10:10, delivered first; to Ventas (A) at 10:00, delivered late.
    await deliver([text(from, 'necesito soporte', nowTs(-5))], [], PHONE_ID_2);
    await deliver([text(from, 'hola ventas', nowTs(-600))], [], PHONE_ID);
    const c = (await contactsWithPhone(from))[0];
    expect(c.last_message_preview).toBe('necesito soporte');
    expect(c.channel_id).toBe(channel2Id);
    const reply = await env.api('POST', `/api/contacts/${c.id}/messages`, { type: 'text', text: 'Con gusto te ayudamos' });
    expect(reply.status).toBe(200);
    expect(sendCalls(PHONE_ID_2).at(-1)!.body.to).toBe(from);
    // A newer message to A still moves it there.
    await deliver([text(from, 'otra cosa de ventas')], [], PHONE_ID);
    expect((await contactById(c.id)).channel_id).toBe(channelId);
  });
});

describe('a template Meta archived and then restored (#30)', () => {
  const ids = { message_template_id: 7770053, message_template_name: 'seguimiento', message_template_language: 'es_MX' };
  const event = (e: string, time: number) => payload([{ time, changes: [{ field: 'message_template_status_update', value: { ...ids, event: e, reason: 'NONE' } }] }]);
  const status = async () => (await q(`SELECT status FROM templates WHERE channel_id = $1 AND name = 'seguimiento'`, [channelId])).rows[0].status;
  const listed = (s: string) => ({ id: '7770053', name: 'seguimiento', language: 'es_MX', status: s, category: 'UTILITY', components: [{ type: 'BODY', text: 'Seguimos en contacto' }] });

  it('takes the status Meta lists for it again, and can be sent', async () => {
    remoteTemplates = [PROMO, listed('APPROVED')];
    expect((await env.api('POST', '/api/templates/sync', { channel_id: channelId })).status).toBe(200);
    const t0 = now() - 600;
    await post(event('ARCHIVED', t0));
    expect(await status()).toBe('ARCHIVED');
    // Meta's template still says ARCHIVED for a moment after the event: the job tries again.
    singleTemplates['7770053'] = listed('ARCHIVED');
    await post(event('UNARCHIVED', t0 + 60));
    expect(await status()).toBe('ARCHIVED');
    singleTemplates['7770053'] = listed('APPROVED');
    await runRetries();
    expect(await status()).toBe('APPROVED');
    // The archival redelivered late is older than the restore.
    await post(event('ARCHIVED', t0));
    expect(await status()).toBe('APPROVED');
    const c = await newContact('+52 55 5100 3001');
    await q(`UPDATE contacts SET channel_id = $2 WHERE id = $1`, [c.id, channelId]);
    expect((await sendTemplate(c.id, 'seguimiento')).status).toBe(200);
  });

  it('a template restored to a status other than APPROVED keeps that one', async () => {
    remoteTemplates = [PROMO, listed('APPROVED')];
    expect((await env.api('POST', '/api/templates/sync', { channel_id: channelId })).status).toBe(200);
    await post(event('ARCHIVED', now() - 30));
    singleTemplates['7770053'] = listed('PAUSED');
    await post(event('UNARCHIVED', now()));
    expect(await status()).toBe('PAUSED');
  });
});

describe('a customer editing or deleting a message (#31)', () => {
  it('updates the original message: nothing new is stored, counted as unread or answered', async () => {
    const from = '525544443101';
    await deliver([text(from, 'Hola')]);
    const address = text(from, 'Mi dirección es Calle Falsa 123');
    await deliver([address]);
    const c = (await contactsWithPhone(from))[0];
    const count = async () => Number((await q(`SELECT count(*) AS n FROM messages WHERE contact_id = $1 AND direction = 'in'`, [c.id])).rows[0].n);
    const inbound = await count();
    const unread = (await contactById(c.id)).unread_count;
    const jobs = enqueued.filter((j) => j.type === 'automation.inbound').length;
    const sends = sendCalls().length;

    const edit = {
      from,
      id: newWamid('EDIT'),
      timestamp: nowTs(),
      type: 'edit',
      edit: { original_message_id: address.id, message: { type: 'text', text: { body: 'Mi dirección es Avenida Real 456' } } },
    };
    await deliver([edit]);
    let row = await messageByWamid(address.id);
    expect(row.body).toBe('Mi dirección es Avenida Real 456');
    expect(row.payload.edits).toEqual([expect.objectContaining({ body: 'Mi dirección es Calle Falsa 123' })]);
    expect((await contactById(c.id)).last_message_preview).toBe('Mi dirección es Avenida Real 456');
    // Redelivered: nothing changes again.
    await deliver([edit]);
    expect((await messageByWamid(address.id)).payload.edits).toHaveLength(1);

    await deliver([{ from, id: newWamid('REVOKE'), timestamp: nowTs(), type: 'revoke', revoke: { original_message_id: address.id } }]);
    row = await messageByWamid(address.id);
    expect(row.payload.deleted_at).toBeTruthy();
    expect((await contactById(c.id)).last_message_preview).toBe('Mensaje eliminado');
    // The older form of an edit (no content).
    await deliver([{ from, id: newWamid('UNSUP'), timestamp: nowTs(), type: 'unsupported', unsupported: { type: 'edit' }, errors: [{ code: 131051, title: 'Message type unknown' }] }]);

    expect(await count()).toBe(inbound);
    expect((await contactById(c.id)).unread_count).toBe(unread);
    expect(enqueued.filter((j) => j.type === 'automation.inbound').length).toBe(jobs);
    expect(sendCalls().length).toBe(sends);
  });

  it("an edit naming another chat's message changes nothing", async () => {
    const a = text('525544443111', 'Mensaje de Ana');
    await deliver([a]);
    await deliver([
      { from: '525544443112', id: newWamid('EDIT'), timestamp: nowTs(), type: 'edit', edit: { original_message_id: a.id, message: { type: 'text', text: { body: 'otro texto' } } } },
    ]);
    expect((await messageByWamid(a.id)).body).toBe('Mensaje de Ana');
    expect(await contactsWithPhone('525544443112')).toHaveLength(0);
  });

  it('an edit with content of another kind (or one not known here) leaves the text as it is', async () => {
    const original = text('525544443131', 'Pedido: 2 pizzas');
    await deliver([original]);
    const edit = (message: any) => ({ from: original.from, id: newWamid('EDIT'), timestamp: nowTs(), type: 'edit', edit: { original_message_id: original.id, message } });
    await deliver([edit({ type: 'poll', poll: {} })]);
    await deliver([edit({ type: 'location', location: { name: 'Casa', latitude: 19.4, longitude: -99.1 } })]);
    const row = await messageByWamid(original.id);
    expect(row.body).toBe('Pedido: 2 pizzas');
    expect(row.payload?.edits ?? []).toHaveLength(0);
  });

  it('an edit that arrives before its original waits for it', async () => {
    const original = text('525544443121', 'Quiero 2 pizzas');
    const edit = {
      from: original.from,
      id: newWamid('EDIT'),
      timestamp: nowTs(),
      type: 'edit',
      edit: { original_message_id: original.id, message: { type: 'text', text: { body: 'Quiero 3 pizzas' } } },
    };
    await deliver([edit]);
    await deliver([original]);
    await runRetries();
    expect((await messageByWamid(original.id)).body).toBe('Quiero 3 pizzas');
  });
});
