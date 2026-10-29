import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encryptJson } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { processBroadcast, renderPlaceholders } from '../services/broadcasts.js';
import { MAX_TEXT_LENGTH, sendMessage, settleStaleSends } from '../services/messages.js';
import { processScheduled, recoverOrphanedScheduled } from '../services/scheduled.js';
import { upsertTemplate } from '../services/templates.js';
import type { ChannelRow, MessageRow } from '../types.js';
import { processStatus } from '../whatsapp/inbound.js';
import { explainMetaError } from '../whatsapp/types.js';
import { fakeFetch, setup, type FakeCall, type TestEnv } from './helpers.js';

const PHONE_ID = '1098765432133';
const WABA_ID = '2223334445533';

type Reply = { status?: number; json?: unknown } | undefined;

/** Per-test behaviour of Meta's POST /messages (n = how many sends so far). */
let onSend: (call: FakeCall, n: number) => Reply = () => undefined;
/** Transport failures: 'refused'/'dns' never reach Meta; 'reset' loses Meta's answer after it accepted the message. */
let transport: (n: number) => 'refused' | 'dns' | 'reset' | null = () => null;
let hold: (() => Promise<void>) | null = null;
let onTemplateCreate: () => Reply = () => undefined;
let sends = 0;

const meta = fakeFetch([
  (c) => {
    if (!c.url.endsWith(`/${PHONE_ID}/messages`) || c.body?.status === 'read') return undefined;
    const custom = onSend(c, sends);
    if (custom) return custom;
    return { json: { messaging_product: 'whatsapp', contacts: [{ input: c.body.to, wa_id: c.body.to }], messages: [{ id: `wamid.R3.${meta.calls.length}` }] } };
  },
  (c) => (c.url.includes(`/${WABA_ID}/message_templates`) && c.method === 'POST' ? (onTemplateCreate() ?? { json: { id: 'tpl-1', status: 'PENDING', category: 'UTILITY' } }) : undefined),
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
  if (transport(n) === 'dns') throw connError('EAI_AGAIN');
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
async function newContact(name = 'Cliente', openWindow = false): Promise<string> {
  const r = await env.api('POST', '/api/contacts', { phone: `+52 55 7300 ${String(1000 + ++phoneSeq)}`, name });
  expect(r.status).toBe(200);
  if (openWindow) await q(`UPDATE contacts SET last_inbound_at = now() WHERE id = $1`, [r.body.contact.id]);
  return r.body.contact.id;
}
async function sendTemplate(contactId: string, name = 'promo', body = ['x']) {
  return env.api('POST', `/api/contacts/${contactId}/messages`, { type: 'template', name, language: 'es_MX', params: { body } });
}
async function getMsg(id: string): Promise<MessageRow> {
  return (await q(`SELECT * FROM messages WHERE id = $1`, [id])).rows[0];
}
async function runDelayedJobs() {
  await q(`UPDATE jobs SET run_at = now() WHERE status = 'queued'`);
  await env.drain();
}

beforeAll(async () => {
  env = await setup({ fetch: metaFetch });
  ws = (await env.register('r3-cobros@test.com', 'Cobros R3')).workspaceId;
  const { rows } = await q(
    `INSERT INTO channels (workspace_id, provider, name, phone_number_id, waba_id, credentials, verify_token, is_default, operator_verified)
     VALUES ($1, 'cloud_api', 'Meta', $2, $3, $4, 'vt-r3', true, true) RETURNING *`,
    [ws, PHONE_ID, WABA_ID, encryptJson(ctx().config.encryptionKey, { accessToken: 'EAAG-test-token', appSecret: 'secret-r3' })],
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
  onTemplateCreate = () => undefined;
  await setBilling('meta_direct', 0);
});

describe('send precondition (contract for #45/#46)', () => {
  it('a failing precondition stores, charges and sends nothing, and its error propagates', async () => {
    await setBilling('prepaid', 1);
    const id = await newContact();
    const before = sends;
    let lockedByThisSend = false;
    const err = await sendMessage(ctx(), {
      workspaceId: ws,
      contactId: id,
      sentBy: 'bot',
      content: { type: 'template', name: 'promo', language: 'es_MX', params: { body: ['x'] } },
      precondition: async (tx) => {
        // Runs inside the send's transaction, after it locked the contact row (xmax = this transaction).
        const r = await tx.query<{ locked: boolean }>(`SELECT xmax::text = pg_current_xact_id()::text AS locked FROM contacts WHERE id = $1`, [id]);
        lockedByThisSend = r.rows[0].locked;
        throw new AppError(409, 'SEND_SKIPPED', 'Envío omitido');
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('SEND_SKIPPED');
    expect(lockedByThisSend).toBe(true);
    expect(sends).toBe(before);
    expect((await q(`SELECT count(*)::int AS n FROM messages WHERE contact_id = $1`, [id])).rows[0].n).toBe(0);
    expect(await balance()).toBe(1);
  });

  it('a passing precondition lets the send go through', async () => {
    const id = await newContact('Pasa', true);
    let ran = 0;
    const m = await sendMessage(ctx(), {
      workspaceId: ws,
      contactId: id,
      sentBy: 'bot',
      content: { type: 'text', text: 'hola' },
      precondition: async (tx) => {
        ran++;
        expect((await tx.query(`SELECT count(*)::int AS n FROM messages WHERE contact_id = $1`, [id])).rows[0].n).toBe(0);
      },
    });
    expect(ran).toBe(1);
    expect(m.status).toBe('sent');
  });
});

describe('human takeover of a contact the bot never talked to (#8)', () => {
  it('an inbox reply marks the bot done even when bot_state was NULL', async () => {
    const id = await newContact('Lupita', true);
    expect((await q(`SELECT bot_state FROM contacts WHERE id = $1`, [id])).rows[0].bot_state).toBeNull();
    const r = await env.api('POST', `/api/contacts/${id}/messages`, { type: 'text', text: 'Hola Lupita, soy Ana' });
    expect(r.status).toBe(200);
    const c = (await q(`SELECT bot_state, ai_paused FROM contacts WHERE id = $1`, [id])).rows[0];
    expect(c.ai_paused).toBe(true);
    expect(c.bot_state).toMatchObject({ path: [], done: true });
  });

  it('the menu bot does not answer the customer after an agent wrote first', async () => {
    const other = await env.register('r3-bot@test.com', 'Bot R3');
    const o = { cookie: other.cookie, ws: other.workspaceId };
    const chId = (await env.api('POST', '/api/channels', { provider: 'sandbox', name: 'S' }, o)).body.channel.id;
    const say = async (text: string) => {
      const r = await env.api('POST', `/api/channels/${chId}/simulate`, { from: '5215500077777', text, name: 'Juan' }, o);
      expect(r.status).toBe(200);
      await env.drain();
      return r.body.message.contact_id as string;
    };
    // The customer wrote while the bot was off, so the bot never started (bot_state stays NULL).
    expect((await env.api('PUT', '/api/workspace/settings', { automation_mode: 'off' }, o)).status).toBe(200);
    const id = await say('hola');
    const menu = { prompt: 'Soy el asistente virtual, elige:', options: [{ key: '1', label: 'Precios' }, { key: '2', label: 'Asesor', handoff: true }] };
    const s = await env.api(
      'PUT',
      '/api/workspace/settings',
      { automation_mode: 'menu', bot: { menu, fallback: 'No entendí.', handoff_message: 'Te atiende un asesor.', interactive: false, only_unassigned: false } },
      o,
    );
    expect(s.status).toBe(200);
    expect((await env.api('POST', `/api/contacts/${id}/messages`, { type: 'text', text: 'Hola Juan, soy Ana. ¿Te llegó tu pedido?' }, o)).status).toBe(200);
    await say('Sí, todo bien, gracias Ana');
    const outs = (await q(`SELECT sent_by FROM messages WHERE contact_id = $1 AND direction = 'out'`, [id])).rows;
    expect(outs.map((m: any) => m.sent_by)).toEqual(['user']);
  });
});

describe('text longer than WhatsApp accepts (#17)', () => {
  it('refuses text over 4096 characters with TEXT_TOO_LONG before storing or sending it', async () => {
    const id = await newContact('Largo', true);
    const before = sends;
    const err = await sendMessage(ctx(), { workspaceId: ws, contactId: id, sentBy: 'ai', content: { type: 'text', text: 'a'.repeat(MAX_TEXT_LENGTH + 1) } }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(400);
    expect(err.code).toBe('TEXT_TOO_LONG');
    expect(sends).toBe(before);
    expect((await q(`SELECT count(*)::int AS n FROM messages WHERE contact_id = $1`, [id])).rows[0].n).toBe(0);
    const ok = await sendMessage(ctx(), { workspaceId: ws, contactId: id, sentBy: 'ai', content: { type: 'text', text: 'a'.repeat(MAX_TEXT_LENGTH) } });
    expect(ok.status).toBe('sent');
  });
});

describe('callback data on every send (#36)', () => {
  it('a text whose answer was lost is settled by its status webhooks', async () => {
    const id = await newContact('Texto', true);
    transport = () => 'reset';
    const m = (await env.api('POST', `/api/contacts/${id}/messages`, { type: 'text', text: 'Tu pedido va en camino' })).body.message;
    expect(m.status).toBe('unknown');
    expect(sendCalls().pop()!.body.biz_opaque_callback_data).toBe(m.id);
    const ts = String(Math.floor(Date.now() / 1000));
    expect(await processStatus(ctx(), channel, { id: 'wamid.LOST.TEXT', status: 'delivered', timestamp: ts, biz_opaque_callback_data: m.id })).toBe(true);
    const after = await getMsg(m.id);
    expect(after.status).toBe('delivered');
    expect(after.wamid).toBe('wamid.LOST.TEXT');
    expect(after.error).toBeNull();
  });
});

describe('settling sends Meta never confirmed (#10)', () => {
  const age = (id: string) => q(`UPDATE messages SET created_at = now() - interval '8 days' WHERE id = $1`, [id]);

  it('refunds an unknown send after the webhook horizon, once, and a late status never charges it again', async () => {
    await setBilling('prepaid', 1);
    const id = await newContact();
    onSend = () => ({ status: 500, json: { error: { message: 'Something went wrong', code: 131000 } } });
    const m = (await sendTemplate(id)).body.message;
    expect(m.status).toBe('unknown');
    expect(await balance()).toBe(0.9543);

    expect(await settleStaleSends(ctx())).toBe(0); // still inside Meta's retry horizon
    await age(m.id);
    env.built.ctx.realtime.history.length = 0;
    const counts = await Promise.all([settleStaleSends(ctx()), settleStaleSends(ctx())]);
    expect(counts[0] + counts[1]).toBe(1);
    const s = await getMsg(m.id);
    expect(s.status).toBe('failed');
    expect(Number(s.cost)).toBe(0);
    expect(s.pricing_reconciled).toBe(true);
    expect(s.error?.message).toMatch(/nunca confirmó/);
    expect(await balance()).toBe(1);
    expect((await q(`SELECT count(*)::int AS n FROM credit_ledger WHERE message_id = $1 AND kind = 'refund'`, [m.id])).rows[0].n).toBe(1);
    expect(env.built.ctx.realtime.history.some((h) => h.event === 'message:update' && (h.data as any).id === m.id)).toBe(true);
    expect(await settleStaleSends(ctx())).toBe(0);

    // A billable status arriving even later claims the row but cannot charge it again.
    const ts = String(Math.floor(Date.now() / 1000));
    await processStatus(ctx(), channel, {
      id: 'wamid.LATE.1',
      status: 'delivered',
      timestamp: ts,
      biz_opaque_callback_data: m.id,
      pricing: { billable: true, category: 'marketing', pricing_model: 'PMP' },
    });
    expect(await balance()).toBe(1);
  });

  it('settles a send orphaned in pending by a crash and fails its broadcast recipient', async () => {
    await setBilling('prepaid', 1);
    const ids = [await newContact('Difusión')];
    const created = await env.api('POST', '/api/broadcasts', { name: 'Huérfano', template_name: 'promo', template_language: 'es_MX', params: { body: ['x'] }, audience: { contact_ids: ids } });
    transport = () => 'reset';
    expect((await env.api('POST', `/api/broadcasts/${created.body.broadcast.id}/launch`)).status).toBe(200);
    await env.drain();
    const br = (await q(`SELECT * FROM broadcast_recipients WHERE broadcast_id = $1`, [created.body.broadcast.id])).rows[0];
    expect(br.status).toBe('sent');
    // As if the process had died between storing the message and sending it.
    await q(`UPDATE messages SET status = 'pending', error = NULL WHERE id = $1`, [br.message_id]);
    expect(await balance()).toBe(0.9543);
    await age(br.message_id);
    expect(await settleStaleSends(ctx())).toBe(1);
    expect((await getMsg(br.message_id)).status).toBe('failed');
    expect(await balance()).toBe(1);
    expect((await q(`SELECT status FROM broadcast_recipients WHERE id = $1`, [br.id])).rows[0].status).toBe('failed');
  });

  it('leaves alone sends that have a wamid or already ended', async () => {
    const id = await newContact('Normal', true);
    const ok = await sendMessage(ctx(), { workspaceId: ws, contactId: id, sentBy: 'user', content: { type: 'text', text: 'hola' } });
    await age(ok.id);
    expect(await settleStaleSends(ctx())).toBe(0);
    expect((await getMsg(ok.id)).status).toBe('sent');
  });
});

describe('scheduled messages no job will finish (#22)', () => {
  async function schedule(contactId: string, content: unknown) {
    const r = await env.api('POST', `/api/contacts/${contactId}/scheduled`, { send_at: new Date(Date.now() + 3_600_000).toISOString(), content });
    expect(r.status).toBe(200);
    return r.body.scheduled.id as string;
  }
  const row = async (id: string) => (await q(`SELECT * FROM scheduled_messages WHERE id = $1`, [id])).rows[0];
  const job = async (id: string) => (await q(`SELECT * FROM jobs WHERE type = 'scheduled.send' AND payload->>'id' = $1 ORDER BY id DESC LIMIT 1`, [id])).rows[0];
  const content = { type: 'template', name: 'recordatorio', language: 'es_MX', params: { body: ['x'] } };

  it('a crash on the last attempt after the claim ends as failed, and the row can be dismissed', async () => {
    const id = await newContact();
    const sid = await schedule(id, content);
    const j = await job(sid);
    // The last attempt claimed the row and its process died before storing the message.
    await q(`UPDATE scheduled_messages SET status = 'sending', send_at = now() - interval '5 minutes' WHERE id = $1`, [sid]);
    await q(`UPDATE jobs SET status = 'running', attempts = max_attempts, locked_by = 'dead-worker', locked_at = now() - interval '1 hour' WHERE id = $1`, [j.id]);
    await env.built.worker.recoverStale(true);
    expect((await job(sid)).status).toBe('failed');
    expect((await env.api('DELETE', `/api/scheduled/${sid}`)).status).toBe(409);

    env.built.ctx.realtime.history.length = 0;
    expect(await recoverOrphanedScheduled(ctx())).toBe(1);
    const s = await row(sid);
    expect(s.status).toBe('failed');
    expect(s.error).toMatch(/error interno/);
    expect(env.built.ctx.realtime.history.find((h) => h.event === 'scheduled:update')?.data).toMatchObject({ id: sid, status: 'failed' });
    expect(await recoverOrphanedScheduled(ctx())).toBe(0);
    expect((await env.api('DELETE', `/api/scheduled/${sid}`)).status).toBe(204);
  });

  it('a row linked to a stored message ends as that message did, without resending', async () => {
    const id = await newContact();
    const sid = await schedule(id, content);
    const m = (await sendTemplate(id, 'recordatorio')).body.message;
    await q(`UPDATE scheduled_messages SET status = 'sending', message_id = $2, send_at = now() WHERE id = $1`, [sid, m.id]);
    await q(`UPDATE jobs SET status = 'failed' WHERE type = 'scheduled.send' AND payload->>'id' = $1`, [sid]);
    const before = sends;
    expect(await recoverOrphanedScheduled(ctx())).toBe(1);
    expect(sends).toBe(before);
    expect(await row(sid)).toMatchObject({ status: 'sent', message_id: m.id, error: null });
  });

  it('a due pending row whose job is gone fails; rows with a live job are left alone', async () => {
    const id = await newContact();
    const orphan = await schedule(id, content);
    const live = await schedule(id, content);
    const sending = await schedule(id, content);
    await q(`UPDATE scheduled_messages SET send_at = now() - interval '5 minutes' WHERE id = ANY($1::uuid[])`, [[orphan, live, sending]]);
    await q(`UPDATE jobs SET status = 'failed' WHERE type = 'scheduled.send' AND payload->>'id' = $1`, [orphan]);
    await q(`UPDATE scheduled_messages SET status = 'sending' WHERE id = $1`, [sending]);
    await q(`UPDATE jobs SET status = 'running', locked_by = 'w' WHERE type = 'scheduled.send' AND payload->>'id' = $1`, [sending]);
    expect(await recoverOrphanedScheduled(ctx())).toBe(1);
    expect((await row(orphan)).status).toBe('failed');
    expect((await row(live)).status).toBe('pending');
    expect((await row(sending)).status).toBe('sending');
    await q(`UPDATE jobs SET status = 'failed' WHERE type = 'scheduled.send' AND payload->>'id' = ANY($1::text[])`, [[live, sending]]);
    await recoverOrphanedScheduled(ctx());
  });
});

describe('pre-send network failures (#9)', () => {
  async function launch(n: number, params: unknown = { body: ['x'] }) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push(await newContact(`Dest ${i}`));
    const created = await env.api('POST', '/api/broadcasts', { name: 'Red', template_name: 'recordatorio', template_language: 'es_MX', params, audience: { contact_ids: ids } });
    expect(created.status).toBe(200);
    const id = created.body.broadcast.id;
    const first = sends;
    expect((await env.api('POST', `/api/broadcasts/${id}/launch`)).status).toBe(200);
    return { id, first };
  }
  const recipients = async (id: string) => (await q(`SELECT status, error FROM broadcast_recipients WHERE broadcast_id = $1`, [id])).rows;
  const get = async (id: string) => (await env.api('GET', `/api/broadcasts/${id}`)).body.broadcast;

  it('stores the failure as a network one, in Spanish, and refunds it', async () => {
    await setBilling('prepaid', 1);
    const id = await newContact();
    transport = () => 'dns';
    const m = (await sendTemplate(id)).body.message;
    expect(m.status).toBe('failed');
    expect(m.error).toMatchObject({ code: null, network: true });
    expect(m.error.message).toMatch(/No se pudo conectar con WhatsApp/);
    expect(m.error.title).toMatch(/EAI_AGAIN/);
    expect(await balance()).toBe(1);
  });

  it('a short outage does not fail the broadcast recipients: they are sent once the network is back', async () => {
    let down = true;
    transport = () => (down ? 'dns' : null);
    const { id } = await launch(4);
    await env.drain();
    const b = await get(id);
    expect(b.status).toBe('running');
    expect(b.stats.failed).toBe(0);
    const rs = await recipients(id);
    expect(rs.map((r: any) => r.status)).toEqual(['queued', 'queued', 'queued', 'queued']);
    expect(rs.some((r: any) => /Se reintentará automáticamente/.test(r.error ?? ''))).toBe(true);
    const next = (await q(`SELECT payload, run_at > now() + interval '20 seconds' AS later FROM jobs WHERE type = 'broadcast.process' AND status = 'queued' AND payload->>'broadcastId' = $1`, [id])).rows;
    expect(next).toHaveLength(1);
    expect(next[0].payload.netRetry).toBe(1);
    expect(next[0].later).toBe(true);
    down = false;
    await runDelayedJobs();
    const done = await get(id);
    expect(done.status).toBe('completed');
    expect(done.stats.failed).toBe(0);
    expect((await recipients(id)).map((r: any) => r.status)).toEqual(['sent', 'sent', 'sent', 'sent']);
  });

  it('a long outage pauses the broadcast instead of failing anyone, and it resumes', async () => {
    let down = true;
    transport = () => (down ? 'refused' : null);
    const { id } = await launch(2);
    await env.drain();
    for (let i = 0; i < 8 && (await get(id)).status === 'running'; i++) await runDelayedJobs();
    const paused = await get(id);
    expect(paused.status).toBe('paused');
    expect(paused.last_error).toMatch(/falla de red/);
    expect(paused.stats.failed).toBe(0);
    down = false;
    expect((await env.api('POST', `/api/broadcasts/${id}/launch`)).status).toBe(200);
    await env.drain();
    expect((await get(id)).status).toBe('completed');
    expect((await recipients(id)).map((r: any) => r.status)).toEqual(['sent', 'sent']);
  });

  it('a scheduled send that could not reach Meta is retried later instead of failing', async () => {
    const id = await newContact();
    const r = await env.api('POST', `/api/contacts/${id}/scheduled`, { send_at: new Date(Date.now() + 3_600_000).toISOString(), content: { type: 'template', name: 'recordatorio', language: 'es_MX', params: { body: ['x'] } } });
    const sid = r.body.scheduled.id;
    await q(`UPDATE scheduled_messages SET send_at = now() - interval '1 second' WHERE id = $1`, [sid]);
    let down = true;
    transport = () => (down ? 'refused' : null);
    await processScheduled(ctx(), { id: sid });
    const s = (await q(`SELECT * FROM scheduled_messages WHERE id = $1`, [sid])).rows[0];
    expect(s.status).toBe('pending');
    expect(s.error).toMatch(/Se reintentará automáticamente/);
    down = false;
    await runDelayedJobs();
    const done = (await q(`SELECT * FROM scheduled_messages WHERE id = $1`, [sid])).rows[0];
    expect(done.status).toBe('sent');
    expect((await getMsg(done.message_id)).status).toBe('sent');
  });
});

describe('placeholder rendering in linear time (#33)', () => {
  const contact = { name: 'Ana López', phone: '5215512345678', email: null, company: 'Taquería', custom_fields: { cupon: 'X1' } };

  it('renders an unclosed default value of 180 KB without stalling the event loop', () => {
    const start = Date.now();
    const out = renderPlaceholders('{a|'.repeat(60_000), contact, false);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(out.length).toBe(180_000);
  });

  it('renders normal placeholders as before', () => {
    expect(renderPlaceholders('Hola {primer_nombre|amigo} de {empresa}, cupón {campo.cupon} {campo.otro|sin cupón} {desconocido}', contact)).toBe(
      'Hola Ana de Taquería, cupón X1 sin cupón {desconocido}',
    );
    expect(renderPlaceholders('{nombre|}', { ...contact, name: null })).toBe('-');
  });

  it('caps the number of named variables of a broadcast', async () => {
    const bodyNamed = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`v${i}`, 'x']));
    const r = await env.api('POST', '/api/broadcasts', { name: 'Muchas', template_name: 'promo', template_language: 'es_MX', params: { bodyNamed }, audience: {} });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION');
  });
});

describe('rate-limit texts (#37)', () => {
  it('a throttled inbox reply does not claim it will be retried', async () => {
    const id = await newContact('Prisa', true);
    onSend = () => ({ status: 429, json: { error: { message: '(#130429) Rate limit hit', code: 130429 } } });
    const m = (await env.api('POST', `/api/contacts/${id}/messages`, { type: 'text', text: 'hola' })).body.message;
    expect(m.status).toBe('failed');
    expect(m.error.message).not.toMatch(/reintentar/i);
    expect(explainMetaError(130429, '')).not.toMatch(/reintentar/i);
  });

  it('broadcast recipients waiting after a rate limit say they will be retried', async () => {
    const ids = [await newContact('A'), await newContact('B')];
    const created = await env.api('POST', '/api/broadcasts', { name: 'Lenta', template_name: 'recordatorio', template_language: 'es_MX', params: { body: ['x'] }, audience: { contact_ids: ids } });
    let base = 0;
    onSend = (_c, n) => (n - base === 1 ? { status: 429, json: { error: { message: '(#130429) Rate limit hit', code: 130429 } } } : undefined);
    base = sends;
    await env.api('POST', `/api/broadcasts/${created.body.broadcast.id}/launch`);
    await env.drain();
    const errs = (await q(`SELECT error FROM broadcast_recipients WHERE broadcast_id = $1 AND status = 'queued'`, [created.body.broadcast.id])).rows;
    expect(errs.some((r: any) => /Se reintentará automáticamente/.test(r.error ?? ''))).toBe(true);
    await env.api('POST', `/api/broadcasts/${created.body.broadcast.id}/cancel`);
  });
});

describe('Meta error details are kept (#58)', () => {
  it('explainMetaError puts the Spanish summary first and keeps Meta’s text', () => {
    const text = explainMetaError(100, "Variables can't be at the start or end of the template.");
    expect(text).toMatch(/^Parámetro inválido en la solicitud a Meta\./);
    expect(text).toContain("Variables can't be at the start or end of the template.");
    expect(explainMetaError(100, '')).toBe('Parámetro inválido en la solicitud a Meta.');
    expect(explainMetaError(null, 'Algo raro')).toBe('Algo raro');
  });

  it('a send rejected with error_data.details stores Meta’s details', async () => {
    const id = await newContact('Detalle', true);
    onSend = () => ({
      status: 400,
      json: { error: { message: '(#131009) Parameter value is not valid', code: 131009, error_data: { details: 'Parameter text.body must be at most 4096 characters long' } } },
    });
    const m = (await env.api('POST', `/api/contacts/${id}/messages`, { type: 'text', text: 'hola' })).body.message;
    expect(m.status).toBe('failed');
    expect(m.error.message).toMatch(/^Valor de parámetro inválido\./);
    expect(m.error.message).toContain('text.body must be at most 4096 characters long');
  });

  it('a template Meta rejects tells the admin why', async () => {
    onTemplateCreate = () => ({
      status: 400,
      json: { error: { message: 'Invalid parameter', code: 100, error_subcode: 2388024, error_user_title: 'Content already exists', error_user_msg: 'Content in this language already exists.' } },
    });
    const r = await env.api('POST', '/api/templates', { channel_id: channel.id, name: 'pedido_listo', language: 'es_MX', category: 'UTILITY', body: { text: 'Hola {{1}}, tu pedido está listo.', examples: ['Ana'] } });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('Content in this language already exists.');
  });
});

describe('editing a paused broadcast (#43)', () => {
  async function pausedByTemplateSync() {
    await ctx().db.tx((tx) =>
      upsertTemplate(tx, channel, { meta_id: 't9', name: 'seguimiento', language: 'es_MX', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hola {{1}}, ¿seguimos?' }] }),
    );
    const ids = [await newContact('Ana Uno'), await newContact('Beto Dos'), await newContact('Caro Tres')];
    const created = await env.api('POST', '/api/broadcasts', { name: 'Seguimiento', template_name: 'seguimiento', template_language: 'es_MX', params: { body: ['{primer_nombre}'] }, audience: { contact_ids: ids } });
    const id = created.body.broadcast.id;
    // The first send goes out, then a sync adds a second variable to the template.
    let synced = false;
    hold = async () => {
      if (synced) return;
      synced = true;
      await q(`UPDATE templates SET components = $1 WHERE channel_id = $2 AND name = 'seguimiento'`, [
        JSON.stringify([{ type: 'BODY', text: 'Hola {{1}}, tu folio es {{2}}' }]),
        channel.id,
      ]);
    };
    expect((await env.api('POST', `/api/broadcasts/${id}/launch`)).status).toBe(200);
    await env.drain();
    hold = null;
    return id;
  }

  it('can be given the missing value and resumed; only the remaining recipients are messaged', async () => {
    const id = await pausedByTemplateSync();
    const b = (await env.api('GET', `/api/broadcasts/${id}`)).body.broadcast;
    expect(b.status).toBe('paused');
    expect(b.last_error).toMatch(/\{\{2\}\}/);
    const sentBefore = (await q(`SELECT count(*)::int AS n FROM broadcast_recipients WHERE broadcast_id = $1 AND status = 'sent'`, [id])).rows[0].n;
    expect(sentBefore).toBe(1);
    expect((await env.api('POST', `/api/broadcasts/${id}/launch`)).body.error.code).toBe('TEMPLATE_PARAMS_MISSING');

    expect((await env.api('PATCH', `/api/broadcasts/${id}`, { audience: { contact_ids: [] } })).status).toBe(400);
    const bad = await env.api('PATCH', `/api/broadcasts/${id}`, { params: { body: ['{primer_nombre}'] } });
    expect(bad.status).toBe(400);
    const p = await env.api('PATCH', `/api/broadcasts/${id}`, { params: { body: ['{primer_nombre}', '123'] } });
    expect(p.status).toBe(200);
    expect(p.body.broadcast.status).toBe('paused');
    expect(p.body.broadcast.total_recipients).toBe(3);

    const first = sends;
    expect((await env.api('POST', `/api/broadcasts/${id}/launch`)).status).toBe(200);
    await env.drain();
    const done = (await env.api('GET', `/api/broadcasts/${id}`)).body.broadcast;
    expect(done.status).toBe('completed');
    expect(sends - first).toBe(2);
    expect(sendCalls().slice(-2).map((c) => c.body.template.components[0].parameters[1].text)).toEqual(['123', '123']);
  });

  it('a run started before an edit made while paused does not keep sending the old values', async () => {
    const ids = [await newContact('Uno'), await newContact('Dos'), await newContact('Tres')];
    const created = await env.api('POST', '/api/broadcasts', { name: 'Carrera', template_name: 'recordatorio', template_language: 'es_MX', params: { body: ['VIEJO'] }, audience: { contact_ids: ids } });
    const id = created.body.broadcast.id;
    expect((await env.api('POST', `/api/broadcasts/${id}/launch`)).status).toBe(200);
    let release!: () => void;
    let reached!: () => void;
    const inFlight = new Promise<void>((r) => (reached = r));
    hold = () => {
      hold = null;
      reached();
      return new Promise<void>((r) => (release = r));
    };
    const run = processBroadcast(ctx(), { broadcastId: id });
    await inFlight;
    expect((await env.api('POST', `/api/broadcasts/${id}/pause`)).status).toBe(200);
    expect((await env.api('PATCH', `/api/broadcasts/${id}`, { params: { body: ['NUEVO'] } })).status).toBe(200);
    expect((await env.api('POST', `/api/broadcasts/${id}/launch`)).status).toBe(200);
    const first = sendCalls().length;
    release();
    await run;
    await env.drain();
    expect((await env.api('GET', `/api/broadcasts/${id}`)).body.broadcast.status).toBe('completed');
    const texts = sendCalls()
      .slice(first)
      .map((c) => c.body.template.components[0].parameters[0].text);
    expect(texts).toEqual(['VIEJO', 'NUEVO', 'NUEVO']);
  });
});

describe('the job queue follows edits of a paused broadcast (#43 review)', () => {
  async function scheduledThenPaused(hours: number) {
    const ids = [await newContact('Noche Uno'), await newContact('Noche Dos')];
    const at = new Date(Date.now() + hours * 3_600_000).toISOString();
    const created = await env.api('POST', '/api/broadcasts', { name: 'Noche', template_name: 'recordatorio', template_language: 'es_MX', params: { body: ['x'] }, audience: { contact_ids: ids }, scheduled_at: at });
    const id = created.body.broadcast.id;
    expect((await env.api('POST', `/api/broadcasts/${id}/launch`)).body.broadcast.status).toBe('scheduled');
    expect((await env.api('POST', `/api/broadcasts/${id}/pause`)).body.broadcast.status).toBe('paused');
    return id;
  }
  const jobs = async (id: string) =>
    (
      await q(
        `SELECT EXTRACT(EPOCH FROM run_at - now())::float / 3600 AS hours FROM jobs WHERE type = 'broadcast.process' AND status = 'queued' AND payload->>'broadcastId' = $1`,
        [id],
      )
    ).rows.map((r: any) => r.hours);
  const get = async (id: string) => (await env.api('GET', `/api/broadcasts/${id}`)).body.broadcast;

  it('moved later while paused, it goes out at the new time, not the old one', async () => {
    const id = await scheduledThenPaused(1);
    expect((await env.api('PATCH', `/api/broadcasts/${id}`, { scheduled_at: new Date(Date.now() + 10 * 3_600_000).toISOString() })).status).toBe(200);
    expect((await env.api('POST', `/api/broadcasts/${id}/launch`)).body.broadcast.status).toBe('scheduled');
    const queued = await jobs(id);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toBeGreaterThan(9.9);
    // Even a job that runs before scheduled_at (one left over from before an edit) only waits for it.
    const first = sends;
    await runDelayedJobs();
    expect((await get(id)).status).toBe('scheduled');
    expect(sends).toBe(first);
    const again = await jobs(id);
    expect(again).toHaveLength(1);
    expect(again[0]).toBeGreaterThan(9.9);
    await q(`UPDATE broadcasts SET scheduled_at = now() WHERE id = $1`, [id]);
    await runDelayedJobs();
    expect((await get(id)).status).toBe('completed');
    expect(sends - first).toBe(2);
  });

  it('moved to now while paused, the resume sends right away', async () => {
    const id = await scheduledThenPaused(5);
    expect((await env.api('PATCH', `/api/broadcasts/${id}`, { scheduled_at: null })).status).toBe(200);
    expect((await env.api('POST', `/api/broadcasts/${id}/launch`)).body.broadcast.status).toBe('running');
    await env.drain();
    const b = await get(id);
    expect(b.status).toBe('completed');
    expect(b.stats.sent).toBe(2);
    expect(await jobs(id)).toHaveLength(0);
  });

  it('resumed during a network backoff, it starts again now with a fresh retry count', async () => {
    const ids = [await newContact('Red Uno'), await newContact('Red Dos')];
    const created = await env.api('POST', '/api/broadcasts', { name: 'Backoff', template_name: 'recordatorio', template_language: 'es_MX', params: { body: ['x'] }, audience: { contact_ids: ids } });
    const id = created.body.broadcast.id;
    let down = true;
    transport = () => (down ? 'dns' : null);
    await env.api('POST', `/api/broadcasts/${id}/launch`);
    await env.drain();
    expect((await q(`SELECT payload FROM jobs WHERE type = 'broadcast.process' AND status = 'queued' AND payload->>'broadcastId' = $1`, [id])).rows[0].payload.netRetry).toBe(1);
    await env.api('POST', `/api/broadcasts/${id}/pause`);
    down = false;
    expect((await env.api('POST', `/api/broadcasts/${id}/launch`)).status).toBe(200);
    await env.drain();
    expect((await get(id)).status).toBe('completed');
  });
});

describe('automatic retries keep one message and do not ask for a manual resend (#9 review)', () => {
  const msgs = async (contactId: string) =>
    (await q(`SELECT * FROM messages WHERE contact_id = $1 AND direction = 'out' ORDER BY created_at`, [contactId])).rows as MessageRow[];
  const lastAt = async (contactId: string) => (await q(`SELECT last_message_at FROM contacts WHERE id = $1`, [contactId])).rows[0].last_message_at.getTime();
  const get = async (id: string) => (await env.api('GET', `/api/broadcasts/${id}`)).body.broadcast;

  it('a broadcast retried through an outage leaves one bubble per recipient, which says it retries by itself', async () => {
    await setBilling('prepaid', 10);
    const ids = [await newContact('Uno'), await newContact('Dos'), await newContact('Tres')];
    const created = await env.api('POST', '/api/broadcasts', { name: 'Caída', template_name: 'promo', template_language: 'es_MX', params: { body: ['x'] }, audience: { contact_ids: ids } });
    const id = created.body.broadcast.id;
    let down = true;
    transport = () => (down ? 'dns' : null);
    env.built.ctx.realtime.history.length = 0;
    await env.api('POST', `/api/broadcasts/${id}/launch`);
    await env.drain();
    const firstTry = (await q(`SELECT * FROM messages WHERE broadcast_id = $1`, [id])).rows as MessageRow[];
    expect(firstTry).toHaveLength(1);
    const failed = firstTry[0];
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatchObject({ network: true, auto_retry: true });
    expect(failed.error!.message).toMatch(/Se reintentará automáticamente/);
    expect(failed.error!.message).not.toMatch(/Intenta de nuevo/);
    const firstAt = await lastAt(failed.contact_id);
    for (let i = 0; i < 8 && (await get(id)).status === 'running'; i++) await runDelayedJobs();
    expect((await get(id)).status).toBe('paused');
    const during = (await q(`SELECT id, error FROM messages WHERE broadcast_id = $1`, [id])).rows;
    expect(during.map((m: any) => m.id)).toEqual([failed.id]);
    expect(during[0].error.message).toMatch(/Se reintentará automáticamente/);
    expect(await lastAt(failed.contact_id)).toBe(firstAt);
    expect(env.built.ctx.realtime.history.filter((h) => h.event === 'message:new' && (h.data as MessageRow).contact_id === failed.contact_id)).toHaveLength(1);
    expect(await balance()).toBe(10);

    down = false;
    expect((await env.api('POST', `/api/broadcasts/${id}/launch`)).status).toBe(200);
    await env.drain();
    expect((await get(id)).status).toBe('completed');
    for (const c of ids) {
      const m = await msgs(c);
      expect(m).toHaveLength(1);
      expect(m[0].status).toBe('sent');
      expect(m[0].error).toBeNull();
    }
    expect((await msgs(failed.contact_id))[0].id).toBe(failed.id);
    // Sent at last: the conversation moves to it, and it is charged once.
    expect(await lastAt(failed.contact_id)).toBeGreaterThan(firstAt);
    const cost = (await q(`SELECT sum(cost)::float AS c FROM messages WHERE broadcast_id = $1`, [id])).rows[0].c;
    expect(await balance()).toBeCloseTo(10 - cost, 4);
  });

  it('a rate-limited broadcast recipient keeps one bubble too', async () => {
    const ids = [await newContact('Lento')];
    const created = await env.api('POST', '/api/broadcasts', { name: 'Lenta 2', template_name: 'recordatorio', template_language: 'es_MX', params: { body: ['x'] }, audience: { contact_ids: ids } });
    let base = 0;
    onSend = (_c, n) => (n - base <= 2 ? { status: 429, json: { error: { message: '(#130429) Rate limit hit', code: 130429 } } } : undefined);
    base = sends;
    await env.api('POST', `/api/broadcasts/${created.body.broadcast.id}/launch`);
    await env.drain();
    const waiting = await msgs(ids[0]);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].error).toMatchObject({ code: 130429, auto_retry: true });
    expect(waiting[0].error!.message).toMatch(/Se reintentará automáticamente/);
    expect(waiting[0].error!.message).not.toMatch(/antes de volver a enviar/);
    for (let i = 0; i < 3; i++) await runDelayedJobs();
    expect((await get(created.body.broadcast.id)).status).toBe('completed');
    const done = await msgs(ids[0]);
    expect(done.map((m) => [m.id, m.status])).toEqual([[waiting[0].id, 'sent']]);
  });

  it('cancelling the broadcast tells the team to resend what will no longer be retried', async () => {
    const ids = [await newContact('Cancelado')];
    const created = await env.api('POST', '/api/broadcasts', { name: 'Cancelada', template_name: 'recordatorio', template_language: 'es_MX', params: { body: ['x'] }, audience: { contact_ids: ids } });
    const id = created.body.broadcast.id;
    transport = () => 'refused';
    await env.api('POST', `/api/broadcasts/${id}/launch`);
    await env.drain();
    expect((await msgs(ids[0]))[0].error!.message).toMatch(/Se reintentará automáticamente/);
    env.built.ctx.realtime.history.length = 0;
    expect((await env.api('POST', `/api/broadcasts/${id}/cancel`)).status).toBe(200);
    const m = (await msgs(ids[0]))[0];
    expect(m.error!.message).toMatch(/Intenta de nuevo en unos minutos/);
    expect(m.error!.auto_retry).toBeUndefined();
    expect(env.built.ctx.realtime.history.some((h) => h.event === 'message:update' && (h.data as MessageRow).id === m.id)).toBe(true);
  });

  async function scheduledTemplate() {
    const id = await newContact('Programado');
    const r = await env.api('POST', `/api/contacts/${id}/scheduled`, { send_at: new Date(Date.now() + 3_600_000).toISOString(), content: { type: 'template', name: 'recordatorio', language: 'es_MX', params: { body: ['x'] } } });
    const sid = r.body.scheduled.id;
    await q(`UPDATE scheduled_messages SET send_at = now() - interval '1 second' WHERE id = $1`, [sid]);
    return { id, sid };
  }
  const srow = async (sid: string) => (await q(`SELECT * FROM scheduled_messages WHERE id = $1`, [sid])).rows[0];

  it('a scheduled send keeps one bubble across its retries and only its last failure asks for a resend', async () => {
    const { id, sid } = await scheduledTemplate();
    transport = () => 'dns';
    await processScheduled(ctx(), { id: sid });
    const first = await msgs(id);
    expect(first).toHaveLength(1);
    expect(first[0].error!.message).toMatch(/Se reintentará automáticamente/);
    expect((await srow(sid)).status).toBe('pending');
    await runDelayedJobs(); // retry 1, still down
    const second = await msgs(id);
    expect(second.map((m) => m.id)).toEqual([first[0].id]);
    expect(second[0].error!.message).toMatch(/Se reintentará automáticamente/);
    // The last allowed attempt fails for good: now the bubble and the panel ask for a resend.
    await processScheduled(ctx(), { id: sid, retry: 5 });
    const last = await msgs(id);
    expect(last.map((m) => m.id)).toEqual([first[0].id]);
    expect(last[0].error!.message).toMatch(/Intenta de nuevo en unos minutos/);
    expect(last[0].error!.auto_retry).toBeUndefined();
    const s = await srow(sid);
    expect(s.status).toBe('failed');
    expect(s.error).toMatch(/Intenta de nuevo en unos minutos/);
  });

  it('a scheduled retry that goes through is the same message, and cancelling one that waits asks for a resend', async () => {
    const a = await scheduledTemplate();
    let down = true;
    transport = () => (down ? 'dns' : null);
    await processScheduled(ctx(), { id: a.sid });
    const failed = (await msgs(a.id))[0];
    down = false;
    await runDelayedJobs();
    const s = await srow(a.sid);
    expect(s.status).toBe('sent');
    expect(s.message_id).toBe(failed.id);
    expect((await msgs(a.id)).map((m) => [m.id, m.status])).toEqual([[failed.id, 'sent']]);

    const b = await scheduledTemplate();
    transport = () => 'dns';
    await processScheduled(ctx(), { id: b.sid });
    expect((await msgs(b.id))[0].error!.message).toMatch(/Se reintentará automáticamente/);
    expect((await env.api('DELETE', `/api/scheduled/${b.sid}`)).status).toBe(204);
    expect((await msgs(b.id))[0].error!.message).toMatch(/Intenta de nuevo en unos minutos/);
  });

  it('a scheduled send that ends for another reason, or is orphaned, stops promising a retry', async () => {
    await setBilling('prepaid', 10);
    const a = await scheduledTemplate();
    await q(`UPDATE scheduled_messages SET content = jsonb_set(content, '{name}', '"promo"') WHERE id = $1`, [a.sid]);
    transport = () => 'dns';
    await processScheduled(ctx(), { id: a.sid });
    expect((await msgs(a.id))[0].error!.message).toMatch(/Se reintentará automáticamente/);
    await setBilling('prepaid', 0);
    transport = () => null;
    await runDelayedJobs(); // the retry cannot be paid
    const s = await srow(a.sid);
    expect(s.status).toBe('failed');
    expect(s.error).toMatch(/créditos/);
    expect((await msgs(a.id))[0].error!.message).toMatch(/Intenta de nuevo en unos minutos/);

    await setBilling('meta_direct', 0);
    const b = await scheduledTemplate();
    transport = () => 'dns';
    await processScheduled(ctx(), { id: b.sid });
    // Its retry job is lost (e.g. failed by a crash): maintenance ends the row and the bubble with it.
    await q(`UPDATE jobs SET status = 'failed' WHERE type = 'scheduled.send' AND payload->>'id' = $1 AND status = 'queued'`, [b.sid]);
    await q(`UPDATE scheduled_messages SET send_at = now() - interval '2 minutes' WHERE id = $1`, [b.sid]);
    expect(await recoverOrphanedScheduled(ctx())).toBeGreaterThanOrEqual(1);
    expect((await srow(b.sid)).status).toBe('failed');
    expect((await msgs(b.id))[0].error!.message).toMatch(/Intenta de nuevo en unos minutos/);
  });
});
