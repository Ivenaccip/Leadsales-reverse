import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hmacSha256Hex } from '../lib/crypto.js';
import { fakeFetch, setup, type TestEnv } from './helpers.js';

// Regression tests for the inbound webhook pipeline (whatsapp/inbound.ts).

const PHONE_ID = '1098765400011';
const WABA_ID = '2223334400011';
const APP_SECRET = 'app-secret-inbound-fixes-0123456789';
const TOKEN = 'EAAG-fake-token-inbound-fixes-xxxxxxxxxx';
const MEDIA_ID = '5550001112';
/** 'lost': Meta answers sends with a 503, so the outcome of the send is unknown. */
let sendMode: 'ok' | 'lost' = 'ok';

const meta = fakeFetch([
  (c) => (c.url.includes(`/${PHONE_ID}?fields=`) ? { json: { id: PHONE_ID, display_phone_number: '+52 55 1234 0011', verified_name: 'Tienda' } } : undefined),
  (c) => (c.url.endsWith(`/${WABA_ID}/subscribed_apps`) ? { json: { success: true } } : undefined),
  (c) => (c.url.includes(`/${WABA_ID}/phone_numbers`) ? { json: { data: [{ id: PHONE_ID }] } } : undefined),
  (c) =>
    c.url.includes(`/${WABA_ID}/message_templates?limit`)
      ? {
          json: {
            data: [
              { id: 't1', name: 'recordatorio', language: 'es_MX', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hola, tu cita es mañana' }] },
              { id: 't3', name: 'recordatorio', language: 'en_US', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi, see you tomorrow' }] },
            ],
          },
        }
      : undefined,
  (c) => {
    if (!c.url.endsWith(`/${PHONE_ID}/messages`)) return undefined;
    if (c.body?.status === 'read') return { json: { success: true } };
    if (sendMode === 'lost') return { status: 503, json: { error: { message: 'Service temporarily unavailable', code: 2 } } };
    return { json: { messaging_product: 'whatsapp', contacts: [{ input: c.body.to, wa_id: c.body.to }], messages: [{ id: `wamid.OUT.${meta.calls.length}` }] } };
  },
  (c) => (c.url.endsWith(`/${MEDIA_ID}`) ? { json: { url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=9', mime_type: 'image/jpeg' } } : undefined),
  (c) => (c.url.startsWith('https://lookaside.fbsbx.com/') ? { body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) } : undefined),
]);

let env: TestEnv;
let ws: string;
let channelId: string;

/** Every job the code queues; failNext makes the next matching enqueue throw once (a dropped DB connection). */
const enqueued: { type: string; payload: any }[] = [];
let failNext: ((type: string, payload: any) => boolean) | null = null;

const q = (sql: string, params: unknown[] = []) => env.built.ctx.db.query<any>(sql, params);
const nowTs = (offsetSec = 0) => String(Math.floor(Date.now() / 1000) + offsetSec);
let seq = 0;
const newWamid = (p = 'IN') => `wamid.${p}.${++seq}`;

function envelope(field: string, value: unknown) {
  return JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: WABA_ID, changes: [{ field, value }] }] });
}

function messagesValue(messages: any[], statuses: any[] = []) {
  return {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '525512340011', phone_number_id: PHONE_ID },
    contacts: messages.length ? messages.map((m) => ({ profile: { name: 'Cliente' }, wa_id: m.from })) : undefined,
    messages: messages.length ? messages : undefined,
    statuses: statuses.length ? statuses : undefined,
  };
}

async function post(body: string, secret = APP_SECRET) {
  const res = await env.built.app.inject({
    method: 'POST',
    url: '/webhooks/whatsapp',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${hmacSha256Hex(secret, body)}` },
    payload: body,
  });
  expect(res.statusCode).toBe(200);
}

async function deliver(messages: any[], statuses: any[] = []) {
  await post(envelope('messages', messagesValue(messages, statuses)));
  await env.drain();
}

async function echo(echoes: any[]) {
  await post(envelope('smb_message_echoes', { messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_ID }, message_echoes: echoes }));
  await env.drain();
}

function text(from: string, body: string, ts = nowTs()) {
  return { from, id: newWamid(), timestamp: ts, type: 'text', text: { body } };
}

/** Runs the retries the worker scheduled with backoff right away. */
async function retryNow() {
  await q(`UPDATE jobs SET run_at = now() WHERE status = 'queued'`);
  await env.drain();
}

async function contactsWithPhone(phone: string) {
  return (await q(`SELECT * FROM contacts WHERE workspace_id = $1 AND phone = $2`, [ws, phone])).rows;
}

async function messageByWamid(wamid: string) {
  return (await q(`SELECT * FROM messages WHERE workspace_id = $1 AND wamid = $2`, [ws, wamid])).rows[0];
}

async function jobCount(type: string, messageId: string) {
  return (await q(`SELECT count(*)::int AS n FROM jobs WHERE type = $1 AND payload->>'messageId' = $2`, [type, messageId])).rows[0].n as number;
}

async function withWebhookEndpoint(fn: () => Promise<void>) {
  await q(`INSERT INTO webhook_endpoints (workspace_id, url, secret, events) VALUES ($1, 'https://hooks.example.com/ll', 's3cret', '{}')`, [ws]);
  try {
    await fn();
  } finally {
    await q(`DELETE FROM webhook_endpoints WHERE workspace_id = $1`, [ws]);
  }
}

function webhooksFor(event: string, wamid: string) {
  return enqueued.filter((j) => j.type === 'webhook.deliver' && j.payload.event === event && j.payload.data.wamid === wamid);
}

async function outboundBodies(contactId: string) {
  return (await q(`SELECT body FROM messages WHERE contact_id = $1 AND direction = 'out' ORDER BY created_at`, [contactId])).rows.map((r: any) => r.body);
}

async function newContact(phone: string, name = 'Cliente') {
  const r = await env.api('POST', '/api/contacts', { phone, name });
  expect(r.status).toBe(200);
  return r.body.contact;
}

async function outbound(contactId: string, wamid: string, extra: { cost?: number; category?: string | null; channelId?: string; prepaid?: boolean } = {}) {
  await q(
    `INSERT INTO messages (workspace_id, contact_id, channel_id, direction, type, body, wamid, status, sent_by, billing_category, cost, charged_prepaid)
     VALUES ($1, $2, $3, 'out', 'template', 'Plantilla', $4, 'sent', 'user', $5, $6, $7)`,
    [ws, contactId, extra.channelId ?? channelId, wamid, extra.category ?? null, extra.cost ?? 0, extra.prepaid ?? false],
  );
}

beforeAll(async () => {
  env = await setup({ fetch: meta.fetch });
  ws = (await env.register('inbound-fixes@test.com')).workspaceId;
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

  const queue = env.built.ctx.queue;
  const original = queue.enqueue.bind(queue);
  queue.enqueue = (async (...args: Parameters<typeof original>) => {
    const [type, payload] = args;
    if (failNext?.(type, payload)) {
      failNext = null;
      throw new Error('Connection terminated unexpectedly');
    }
    enqueued.push({ type, payload });
    if (type === 'webhook.deliver') return null; // outgoing webhooks never leave the test
    return original(...args);
  }) as typeof queue.enqueue;
});
afterAll(() => env.close());

describe('contact matching', () => {
  it('treats 10-digit wa_ids as international numbers (#2)', async () => {
    const sg = await newContact('+65 9123 4567', 'Cliente Singapur');
    expect(sg.phone).toBe('6591234567');
    const m = text('6591234567', 'hello from Singapore');
    await deliver([m]);
    expect((await messageByWamid(m.id)).contact_id).toBe(sg.id);
    expect(await contactsWithPhone('526591234567')).toHaveLength(0);
    // Coexistence echoes to a 10-digit wa_id (Norway) keep the number as is too
    await echo([{ from: '525512340011', to: '4791234567', id: newWamid('ECHO'), timestamp: nowTs(), type: 'text', text: { body: 'Hei' } }]);
    expect(await contactsWithPhone('4791234567')).toHaveLength(1);
    expect(await contactsWithPhone('524791234567')).toHaveLength(0);
  });

  it('matches the contact by the wa_id Meta answered on send (#11, #32)', async () => {
    const br = await newContact('+55 11 98765-4321', 'Lead Brasil');
    expect(br.phone).toBe('5511987654321');
    // What sendMessage stores when Meta answers contacts[0].wa_id without the 9th digit
    await q(`UPDATE contacts SET wa_id = '551187654321' WHERE id = $1`, [br.id]);
    const m = text('551187654321', 'Oi, tenho interesse');
    await deliver([m]);
    expect((await messageByWamid(m.id)).contact_id).toBe(br.id);
    expect(await contactsWithPhone('551187654321')).toHaveLength(0);
    const after = (await env.api('GET', `/api/contacts/${br.id}`)).body.contact;
    expect(after.last_inbound_at).toBeTruthy();
    // Echoes of replies typed on the phone land on the same contact
    const e = newWamid('ECHO');
    await echo([{ from: '525512340011', to: '551187654321', id: e, timestamp: nowTs(), type: 'text', text: { body: 'Olá!' } }]);
    expect((await messageByWamid(e)).contact_id).toBe(br.id);
  });

  it('moves the contact when WhatsApp reports a number change, without treating it as a customer message (#47)', async () => {
    await env.api('PUT', '/api/workspace/settings', { automation_mode: 'off', away: { enabled: true, text: 'Estamos cerrados', hours: {} } });
    const first = text('5215511110003', 'hola');
    await deliver([first]);
    const contactId = (await messageByWamid(first.id)).contact_id;
    const old = new Date(Date.now() - 3 * 86400_000);
    await q(`UPDATE contacts SET last_inbound_at = $2, last_message_at = $2, unread_count = 0 WHERE id = $1`, [contactId, old]);
    const outBefore = (await q(`SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND direction = 'out'`, [contactId])).rows[0].n;

    const sys = {
      from: '5215511110003',
      id: newWamid('SYS'),
      timestamp: nowTs(),
      type: 'system',
      system: { body: 'Carl changed from 5215511110003 to 5215599990003', new_wa_id: '5215599990003', type: 'user_changed_number' },
    };
    await deliver([sys]);
    const stored = await messageByWamid(sys.id);
    expect(stored.type).toBe('system');
    expect(await jobCount('automation.inbound', stored.id)).toBe(0);
    const c = (await q(`SELECT * FROM contacts WHERE id = $1`, [contactId])).rows[0];
    expect(c.unread_count).toBe(0);
    expect(new Date(c.last_inbound_at).getTime()).toBe(old.getTime());
    expect(c.phone).toBe('525599990003');
    expect(c.wa_id).toBe('5215599990003');
    const outAfter = (await q(`SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND direction = 'out'`, [contactId])).rows[0].n;
    expect(outAfter).toBe(outBefore); // no away message to the abandoned number
    const ev = (await q(`SELECT data FROM contact_events WHERE contact_id = $1 AND type = 'number_changed'`, [contactId])).rows[0];
    expect(ev.data).toMatchObject({ old_wa_id: '5215511110003', new_wa_id: '5215599990003', moved: true });
    // A redelivery of the notice does not recreate a contact for the abandoned number
    await deliver([sys]);
    expect(await contactsWithPhone('525511110003')).toHaveLength(0);

    // The customer now writes from the new number: same contact, no duplicate
    const next = text('5215599990003', 'ya cambié de número');
    await deliver([next]);
    expect((await messageByWamid(next.id)).contact_id).toBe(contactId);

    // When another contact already has the new number, nothing is merged: the event links both
    const a = text('5215511110004', 'hola');
    await deliver([a]);
    const aId = (await messageByWamid(a.id)).contact_id;
    const other = await newContact('+52 55 9999 0004', 'Ya existe');
    await deliver([
      { from: '5215511110004', id: newWamid('SYS'), timestamp: nowTs(), type: 'system', system: { body: 'cambio', wa_id: '5215599990004', type: 'user_changed_number' } },
    ]);
    const aRow = (await q(`SELECT phone FROM contacts WHERE id = $1`, [aId])).rows[0];
    expect(aRow.phone).toBe('525511110004');
    const ev2 = (await q(`SELECT data FROM contact_events WHERE contact_id = $1 AND type = 'number_changed'`, [aId])).rows[0];
    expect(ev2.data).toMatchObject({ moved: false, other_contact_id: other.id });

    // The type Meta's webhook reference documents moves the contact too
    const b = text('5215511110005', 'hola');
    await deliver([b]);
    const bId = (await messageByWamid(b.id)).contact_id;
    await deliver([
      { from: '5215511110005', id: newWamid('SYS'), timestamp: nowTs(), type: 'system', system: { body: 'cambio', wa_id: '5215599990005', type: 'customer_changed_number' } },
    ]);
    expect((await q(`SELECT phone, wa_id FROM contacts WHERE id = $1`, [bId])).rows[0]).toEqual({ phone: '525599990005', wa_id: '5215599990005' });
    const fromNew = text('5215599990005', 'soy yo, número nuevo');
    await deliver([fromNew]);
    expect((await messageByWamid(fromNew.id)).contact_id).toBe(bId);
    await env.api('PUT', '/api/workspace/settings', { away: { enabled: false, text: 'Estamos cerrados', hours: {} } });
  });
});

describe('batches', () => {
  it('skips an invalid wa_id without losing the rest of the batch (#10)', async () => {
    const target = await newContact('+52 55 4444 1010');
    await outbound(target.id, 'wamid.BATCH.OUT');
    const bad = text('12345', 'hola');
    const good = text('5215544441011', 'sí llegó');
    const niue = text('6834567', 'from Niue');
    await deliver([bad, good, niue], [{ id: 'wamid.BATCH.OUT', status: 'delivered', timestamp: nowTs(), recipient_id: '525544441010' }]);
    expect(await messageByWamid(bad.id)).toBeUndefined();
    expect(await messageByWamid(good.id)).toBeTruthy();
    expect(await contactsWithPhone('6834567')).toHaveLength(1);
    expect((await messageByWamid('wamid.BATCH.OUT')).status).toBe('delivered');
    const failed = (await q(`SELECT count(*)::int AS n FROM jobs WHERE type = 'wa.webhook' AND status <> 'done'`)).rows[0].n;
    expect(failed).toBe(0);
  });

  it('stores messages handled in one concurrent batch in arrival order (#26)', async () => {
    const from = '5215544442626';
    const texts = ['1) hola', '2) quiero agendar', '3) para mañana', '4) a las 5'];
    // One POST per message, as Meta does; the worker then runs them in one concurrent batch.
    for (const t of texts) await post(envelope('messages', messagesValue([text(from, t)])));
    await env.drain();
    const [contact] = await contactsWithPhone('525544442626');
    const rows = (await q(`SELECT body FROM messages WHERE contact_id = $1 ORDER BY created_at`, [contact.id])).rows;
    expect(rows.map((r: any) => r.body)).toEqual(texts);
    expect(contact.last_message_preview).toBe('4) a las 5');
  });

  it('keeps the newest preview when an older message arrives late (#49)', async () => {
    const from = '5215544444949';
    await deliver([text(from, 'NUEVO: ya lo pagué')]);
    await deliver([text(from, 'VIEJO: ¿cuánto cuesta?', nowTs(-300))]);
    const [contact] = await contactsWithPhone('525544444949');
    expect(contact.last_message_preview).toBe('NUEVO: ya lo pagué');
    // Late echoes do not overwrite it either
    await echo([{ from: '525512340011', to: from, id: newWamid('ECHO'), timestamp: nowTs(-200), type: 'text', text: { body: 'respuesta vieja' } }]);
    expect((await contactsWithPhone('525544444949'))[0].last_message_preview).toBe('NUEVO: ya lo pagué');
  });
});

describe('follow-up work after a failed attempt (#5)', () => {
  it('downloads media and runs automation when the first attempt failed after storing the message', async () => {
    await env.api('PUT', '/api/workspace/settings', { automation_mode: 'off' });
    const img = { from: '5215544440505', id: newWamid(), timestamp: nowTs(), type: 'image', image: { id: MEDIA_ID, mime_type: 'image/jpeg', caption: 'foto' } };
    failNext = (type) => type === 'automation.inbound';
    await deliver([img]);
    const stored = await messageByWamid(img.id);
    expect(stored.followups_done).toBe(false);
    expect(stored.media_file_id).toBeNull();
    await retryNow();
    const after = await messageByWamid(img.id);
    expect(after.followups_done).toBe(true);
    expect(after.media_file_id).toBeTruthy();
    expect(await jobCount('media.download', stored.id)).toBe(1);
    expect(await jobCount('automation.inbound', stored.id)).toBe(1);
    // A later duplicate delivery does not run the automation again
    await deliver([img]);
    expect(await jobCount('automation.inbound', stored.id)).toBe(1);
    expect((await q(`SELECT count(*)::int AS n FROM messages WHERE workspace_id = $1 AND wamid = $2`, [ws, img.id])).rows[0].n).toBe(1);
  });

  it('downloads echo media when the first attempt failed', async () => {
    const e = { from: '525512340011', to: '5215544440506', id: newWamid('ECHO'), timestamp: nowTs(), type: 'image', image: { id: MEDIA_ID, mime_type: 'image/jpeg' } };
    failNext = (type) => type === 'media.download';
    await echo([e]);
    expect((await messageByWamid(e.id)).media_file_id).toBeNull();
    await retryNow();
    const after = await messageByWamid(e.id);
    expect(after.media_file_id).toBeTruthy();
    expect(after.followups_done).toBe(true);
  });

  it('sends the message.status webhook when queuing it failed the first time', async () => {
    await withWebhookEndpoint(async () => {
      const c = await newContact('+52 55 4444 0507');
      await outbound(c.id, 'wamid.STATUS.1');
      failNext = (type, payload) => type === 'webhook.deliver' && payload?.event === 'message.status';
      await deliver([], [{ id: 'wamid.STATUS.1', status: 'delivered', timestamp: nowTs(), recipient_id: '525544440507' }]);
      // The status and its webhook commit together: neither is kept without the other
      expect((await messageByWamid('wamid.STATUS.1')).status).toBe('sent');
      await retryNow();
      expect((await messageByWamid('wamid.STATUS.1')).status).toBe('delivered');
      expect(webhooksFor('message.status', 'wamid.STATUS.1').map((j) => j.payload.data.status)).toEqual(['delivered']);
    });
  });

  it('queues the follow-ups of a message delivered twice at once only once', async () => {
    await env.api('PUT', '/api/workspace/settings', { automation_mode: 'off' });
    await withWebhookEndpoint(async () => {
      const m = text('5215544440508', 'hola');
      const body = envelope('messages', messagesValue([m]));
      // Meta redelivers while the first copy is still queued: both run in the same batch
      await post(body);
      await post(body);
      await env.drain();
      const stored = await messageByWamid(m.id);
      expect(webhooksFor('message.received', m.id)).toHaveLength(1);
      expect(await jobCount('automation.inbound', stored.id)).toBe(1);
      expect(stored.followups_done).toBe(true);
    });
  });

  it('a status of an echo leaves the echo media download pending until it runs', async () => {
    const e = { from: '525512340011', to: '5215544440509', id: newWamid('ECHO'), timestamp: nowTs(), type: 'image', image: { id: MEDIA_ID, mime_type: 'image/jpeg' } };
    failNext = (type) => type === 'media.download';
    await echo([e]);
    // Meta reports the echo as delivered before the echo job is retried
    await deliver([], [{ id: e.id, status: 'delivered', timestamp: nowTs(), recipient_id: '5215544440509' }]);
    await retryNow();
    const row = await messageByWamid(e.id);
    expect(row.status).toBe('delivered');
    expect(row.media_file_id).toBeTruthy();
    expect(row.followups_done).toBe(true);
  });

  it('welcomes a new lead when the first attempt failed after creating the contact', async () => {
    await env.api('PUT', '/api/workspace/settings', { automation_mode: 'off', welcome: { enabled: true, text: '¡Bienvenido!' } });
    try {
      await withWebhookEndpoint(async () => {
        const m = text('5215544440510', 'hola, info');
        failNext = (type, payload) => type === 'webhook.deliver' && payload?.event === 'contact.created';
        await deliver([m]);
        expect(await messageByWamid(m.id)).toBeUndefined();
        await retryNow();
        const stored = await messageByWamid(m.id);
        expect(enqueued.filter((j) => j.type === 'automation.inbound' && j.payload.messageId === stored.id).map((j) => j.payload.isNew)).toEqual([true]);
        await env.drain();
        expect(await outboundBodies(stored.contact_id)).toEqual(['¡Bienvenido!']);
      });
    } finally {
      await env.api('PUT', '/api/workspace/settings', { welcome: { enabled: false, text: '¡Bienvenido!' } });
    }
  });

  it('a burst of first messages from a new lead sends one welcome', async () => {
    await env.api('PUT', '/api/workspace/settings', { automation_mode: 'off', welcome: { enabled: true, text: '¡Bienvenido!' } });
    try {
      const from = '5215544440511';
      // One POST per message; the worker handles them concurrently
      for (const t of ['hola', 'quiero info', 'de precios']) await post(envelope('messages', messagesValue([text(from, t)])));
      await env.drain();
      const [contact] = await contactsWithPhone('525544440511');
      expect(await outboundBodies(contact.id)).toEqual(['¡Bienvenido!']);
    } finally {
      await env.api('PUT', '/api/workspace/settings', { welcome: { enabled: false, text: '¡Bienvenido!' } });
    }
  });
});

describe('opt-out', () => {
  it('a typed opt-out keyword opts out and gets no automatic answer (#8)', async () => {
    await env.api('PUT', '/api/workspace/settings', { automation_mode: 'off', welcome: { enabled: true, text: '¡Bienvenido!' } });
    const m = text('5215544440808', 'STOP');
    await deliver([m]);
    const stored = await messageByWamid(m.id);
    expect(await jobCount('automation.inbound', stored.id)).toBe(0);
    const c = (await q(`SELECT opted_out FROM contacts WHERE id = $1`, [stored.contact_id])).rows[0];
    expect(c.opted_out).toBe(true);
    const out = (await q(`SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND direction = 'out'`, [stored.contact_id])).rows[0].n;
    expect(out).toBe(0);
    await env.api('PUT', '/api/workspace/settings', { welcome: { enabled: false, text: '¡Bienvenido!' } });
  });

  it('a template quick-reply button or an interactive reply opts out too (#46, #62)', async () => {
    const button = { from: '5215544444646', id: newWamid(), timestamp: nowTs(), type: 'button', button: { text: 'Baja', payload: 'Baja' } };
    const listReply = {
      from: '5215544446262',
      id: newWamid(),
      timestamp: nowTs(),
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'stop', title: 'STOP' } },
    };
    const byPayload = { from: '5215544446263', id: newWamid(), timestamp: nowTs(), type: 'button', button: { text: 'No me interesa', payload: 'BAJA' } };
    await deliver([button, listReply, byPayload]);
    for (const m of [button, listReply, byPayload]) {
      const stored = await messageByWamid(m.id);
      expect((await q(`SELECT opted_out FROM contacts WHERE id = $1`, [stored.contact_id])).rows[0].opted_out).toBe(true);
      expect(await jobCount('automation.inbound', stored.id)).toBe(0);
    }
  });

  it("choosing the bot menu's own 'Baja' option is not an opt-out (#46)", async () => {
    const r = await env.api('PUT', '/api/workspace/settings', {
      automation_mode: 'menu',
      bot: {
        menu: {
          prompt: '¿Qué trámite necesitas?',
          options: [
            { key: '1', label: 'Alta', reply: 'Te ayudo con el alta' },
            { key: '2', label: 'Baja', reply: 'Te paso con un asesor para tu baja', handoff: true },
          ],
        },
        fallback: 'No entendí',
        handoff_message: 'Un asesor te atiende',
        interactive: true,
        only_unassigned: false,
      },
    });
    expect(r.status).toBe(200);
    try {
      const from = '5215544444647';
      const first = text(from, 'hola');
      await deliver([first]);
      const contactId = (await messageByWamid(first.id)).contact_id;
      const menu = (await q(`SELECT payload FROM messages WHERE contact_id = $1 AND direction = 'out' ORDER BY created_at DESC LIMIT 1`, [contactId])).rows[0];
      const baja = menu.payload.interactive.action.buttons.find((b: any) => b.reply.title === 'Baja');
      expect(baja.reply.id).toMatch(/^menu:/);
      const tap = { from, id: newWamid(), timestamp: nowTs(), type: 'interactive', interactive: { type: 'button_reply', button_reply: baja.reply } };
      await deliver([tap]);
      expect((await q(`SELECT opted_out FROM contacts WHERE id = $1`, [contactId])).rows[0].opted_out).toBe(false);
      expect(await jobCount('automation.inbound', (await messageByWamid(tap.id)).id)).toBe(1);
      expect((await outboundBodies(contactId)).at(-1)).toBe('Te paso con un asesor para tu baja');
    } finally {
      await env.api('PUT', '/api/workspace/settings', { automation_mode: 'off' });
    }
  });
});

describe('coexistence echoes', () => {
  it('a reply typed in the WhatsApp Business app pauses the bot and the AI (#9)', async () => {
    const m = text('5215544440909', 'hola');
    await deliver([m]);
    const contactId = (await messageByWamid(m.id)).contact_id;
    await q(`UPDATE contacts SET bot_state = '{"path":["1"]}', ai_paused = false WHERE id = $1`, [contactId]);
    await echo([{ from: '525512340011', to: '5215544440909', id: newWamid('ECHO'), timestamp: nowTs(), type: 'text', text: { body: 'Te atiendo yo' } }]);
    const c = (await q(`SELECT * FROM contacts WHERE id = $1`, [contactId])).rows[0];
    expect(c.ai_paused).toBe(true);
    expect(c.bot_state.done).toBe(true);
    expect(c.unread_count).toBe(0);
    expect(c.last_message_preview).toBe('Te atiendo yo');
  });
});

describe('statuses', () => {
  it('ignores statuses for messages of another channel, even in the same workspace (#12)', async () => {
    await q(
      `INSERT INTO channels (workspace_id, provider, name, phone_number_id, waba_id, verify_token) VALUES ($1, 'cloud_api', 'Operador', '1098765400099', $2, 'verify-operador')`,
      [ws, WABA_ID],
    );
    const operatorChannel = (await q(`SELECT id FROM channels WHERE phone_number_id = '1098765400099'`)).rows[0].id;
    const c = await newContact('+52 55 4444 1212');
    await outbound(c.id, 'wamid.OPERATOR.1', { cost: 0.0457, category: 'marketing', channelId: operatorChannel });
    // Signed with the tenant channel's secret, claiming the operator channel's message failed
    await deliver([], [{ id: 'wamid.OPERATOR.1', status: 'failed', timestamp: nowTs(-3600), recipient_id: '525544441212', errors: [{ code: 131026 }] }]);
    await deliver([], [{ id: 'wamid.OPERATOR.1', status: 'sent', timestamp: nowTs(-3600), recipient_id: '525544441212', pricing: { billable: false, category: 'marketing' } }]);
    const msg = await messageByWamid('wamid.OPERATOR.1');
    expect(msg.status).toBe('sent');
    expect(msg.cost).toBeCloseTo(0.0457);
    expect(msg.pricing_reconciled).toBe(false);
    expect((await q(`SELECT count(*)::int AS n FROM credit_ledger WHERE message_id = $1`, [msg.id])).rows[0].n).toBe(0);
  });

  it('refunds a message that fails after a billable "sent" status (#13)', async () => {
    await q(`UPDATE workspaces SET billing_mode = 'prepaid', credit_balance = 0.9543 WHERE id = $1`, [ws]);
    await q(`UPDATE channels SET operator_verified = true WHERE id = $1`, [channelId]);
    try {
      const c = await newContact('+52 55 4444 1313');
      await outbound(c.id, 'wamid.FAIL.1', { cost: 0.0457, category: 'marketing', prepaid: true });
      await deliver([], [{ id: 'wamid.FAIL.1', status: 'sent', timestamp: nowTs(), recipient_id: '525544441313', pricing: { billable: true, pricing_model: 'PMP', category: 'marketing' } }]);
      let msg = await messageByWamid('wamid.FAIL.1');
      expect(msg.pricing_reconciled).toBe(true);
      expect(msg.cost).toBeCloseTo(0.0457);
      const failed = { id: 'wamid.FAIL.1', status: 'failed', timestamp: nowTs(), recipient_id: '525544441313', errors: [{ code: 131026, title: 'Message undeliverable' }] };
      await deliver([], [failed]);
      msg = await messageByWamid('wamid.FAIL.1');
      expect(msg.status).toBe('failed');
      expect(msg.cost).toBe(0);
      const bal = async () => Number((await q(`SELECT credit_balance FROM workspaces WHERE id = $1`, [ws])).rows[0].credit_balance);
      expect(await bal()).toBeCloseTo(1.0);
      // A repeated failure does not refund twice
      await deliver([], [failed]);
      expect(await bal()).toBeCloseTo(1.0);
      expect((await q(`SELECT count(*)::int AS n FROM credit_ledger WHERE message_id = $1 AND kind = 'refund'`, [msg.id])).rows[0].n).toBe(1);
    } finally {
      await q(`UPDATE workspaces SET billing_mode = 'meta_direct' WHERE id = $1`, [ws]);
    }
  });

  it('settles a send whose answer from Meta was lost through biz_opaque_callback_data', async () => {
    await q(`UPDATE workspaces SET billing_mode = 'prepaid', credit_balance = 1 WHERE id = $1`, [ws]);
    await q(`UPDATE channels SET operator_verified = true WHERE id = $1`, [channelId]);
    const bal = async () => Number((await q(`SELECT credit_balance FROM workspaces WHERE id = $1`, [ws])).rows[0].credit_balance);
    const lostSend = async (contactId: string) => {
      sendMode = 'lost';
      try {
        const r = await env.api('POST', `/api/contacts/${contactId}/messages`, { type: 'template', name: 'recordatorio', language: 'es_MX' });
        expect(r.status).toBe(200);
        expect(r.body.message).toMatchObject({ status: 'unknown', wamid: null });
        return r.body.message;
      } finally {
        sendMode = 'ok';
      }
    };
    try {
      const c = await newContact('+52 55 4444 1717');
      const lost = await lostSend(c.id);
      expect(meta.calls.at(-1)?.body.biz_opaque_callback_data).toBe(lost.id);
      const charged = 1 - (await bal());
      expect(charged).toBeGreaterThan(0);

      // Meta says it failed: the message gets its wamid, the failure and its money back
      await deliver([], [
        { id: 'wamid.LOST.1', status: 'failed', timestamp: nowTs(), recipient_id: '525544441717', biz_opaque_callback_data: lost.id, errors: [{ code: 131026 }] },
      ]);
      const failed = await messageByWamid('wamid.LOST.1');
      expect(failed).toMatchObject({ id: lost.id, status: 'failed', cost: 0 });
      expect(await bal()).toBeCloseTo(1);

      // Another lost send that did go out: its statuses confirm it and drop the "could not confirm" error
      const lost2 = await lostSend(c.id);
      await deliver([], [
        { id: 'wamid.LOST.2', status: 'sent', timestamp: nowTs(), recipient_id: '525544441717', biz_opaque_callback_data: lost2.id, pricing: { billable: true, pricing_model: 'PMP', category: 'utility' } },
        { id: 'wamid.LOST.2', status: 'delivered', timestamp: nowTs(), recipient_id: '525544441717', biz_opaque_callback_data: lost2.id },
      ]);
      const delivered = await messageByWamid('wamid.LOST.2');
      expect(delivered).toMatchObject({ id: lost2.id, status: 'delivered', error: null, pricing_reconciled: true });
      expect(await bal()).toBeCloseTo(1 - charged);

      // The callback data never reaches a message of another channel
      const operatorChannel = (await q(`SELECT id FROM channels WHERE phone_number_id = '1098765400099'`)).rows[0].id;
      const other = await newContact('+52 55 4444 1718');
      await q(
        `INSERT INTO messages (workspace_id, contact_id, channel_id, direction, type, body, status, sent_by, billing_category, cost)
         VALUES ($1, $2, $3, 'out', 'template', 'Plantilla', 'unknown', 'user', 'marketing', 0.0457)`,
        [ws, other.id, operatorChannel],
      );
      const foreign = (await q(`SELECT id FROM messages WHERE contact_id = $1`, [other.id])).rows[0];
      await deliver([], [
        { id: 'wamid.LOST.3', status: 'failed', timestamp: nowTs(-3600), recipient_id: '525544441718', biz_opaque_callback_data: foreign.id, errors: [{ code: 131026 }] },
      ]);
      expect((await q(`SELECT status, wamid, cost FROM messages WHERE id = $1`, [foreign.id])).rows[0]).toEqual({ status: 'unknown', wamid: null, cost: 0.0457 });
    } finally {
      await q(`UPDATE workspaces SET billing_mode = 'meta_direct' WHERE id = $1`, [ws]);
    }
  });
});

describe('templates', () => {
  async function templateEvent(event: string, id = 't1', language = 'es_MX') {
    await post(
      envelope('message_template_status_update', { event, message_template_id: id, message_template_name: 'recordatorio', message_template_language: language, reason: 'NONE' }),
    );
    await env.drain();
    return (await q(`SELECT status FROM templates WHERE workspace_id = $1 AND meta_id = $2`, [ws, id])).rows[0].status as string;
  }

  it('maps template events to real statuses (#4, #31)', async () => {
    expect(await templateEvent('PAUSED')).toBe('PAUSED');
    expect(await templateEvent('REINSTATED')).toBe('APPROVED');
    expect(await templateEvent('FLAGGED')).toBe('APPROVED');
    expect(await templateEvent('LOCKED')).toBe('APPROVED');
    expect(await templateEvent('SOMETHING_NEW')).toBe('APPROVED');
    const c = await newContact('+52 55 4444 0404');
    const r = await env.api('POST', `/api/contacts/${c.id}/messages`, { type: 'template', name: 'recordatorio', language: 'es_MX' });
    expect(r.status).toBe(200);
    expect(r.body.message.status).toBe('sent');
  });

  it('recategorizes only the language version Meta names (#7, #36)', async () => {
    await post(
      envelope('template_category_update', {
        message_template_id: 't1',
        message_template_name: 'recordatorio',
        message_template_language: 'es_MX',
        previous_category: 'UTILITY',
        new_category: 'MARKETING',
      }),
    );
    await env.drain();
    const rows = (await q(`SELECT language, category FROM templates WHERE workspace_id = $1 AND name = 'recordatorio' ORDER BY language`, [ws])).rows;
    expect(rows).toEqual([
      { language: 'en_US', category: 'utility' },
      { language: 'es_MX', category: 'marketing' },
    ]);
  });
});
