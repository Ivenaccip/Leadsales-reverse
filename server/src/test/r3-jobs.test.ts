import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Queue } from '../jobs/queue.js';
import { Worker, type JobHandler, type WorkerOptions } from '../jobs/worker.js';
import { encryptJson, hmacSha256Hex } from '../lib/crypto.js';
import { DEFAULT_AI_MODEL, runAiReply } from '../services/ai-agent.js';
import type { ChannelRow } from '../types.js';
import { processInboundMessage } from '../whatsapp/inbound.js';
import { fakeFetch, setup, sleep, type TestEnv } from './helpers.js';

// Review round 3, jobs group: lanes and fairness (#14, #53), claim cost of a serial backlog (#54),
// event-loop starvation on PGlite (#52), run_at from the database clock (#31), NUL in payloads (#32),
// periodic settlement hooks (#10, #22), and automation that must not talk over a human (#45, #46),
// keep answering contacts who opted out of broadcasts (#42), stay bounded in time (#13) and split
// replies longer than WhatsApp allows (#17).

const PHONE_ID = '1098765400777';
const APP_SECRET = 'r3-jobs-app-secret';
let wamid = 0;
const replies: any[] = [];
const fake = fakeFetch([
  (c) =>
    c.url.endsWith(`/${PHONE_ID}/messages`) && c.body?.status !== 'read'
      ? { json: { messaging_product: 'whatsapp', contacts: [{ input: c.body.to, wa_id: c.body.to }], messages: [{ id: `wamid.R3J.${++wamid}` }] } }
      : undefined,
  (c) => (c.url.endsWith(`/${PHONE_ID}/messages`) ? { json: { success: true } } : undefined),
  (c) =>
    c.url.startsWith('https://api.anthropic.com/v1/messages')
      ? {
          json: {
            id: `msg_${fake.calls.length}`,
            type: 'message',
            role: 'assistant',
            model: c.body.model,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 10 },
            ...(replies.shift() ?? { content: [{ type: 'text', text: 'Con gusto.' }], stop_reason: 'end_turn' }),
          },
        }
      : undefined,
]);

/** Runs once, inside the next Graph send whose body contains `match`. */
let duringSend: { match: string; fn: () => Promise<void> } | null = null;
/** Runs once, inside the next Claude call (the AI is "writing"). */
let duringClaude: ((init: any) => Promise<void>) | null = null;
/** Every Claude call hangs until its request is aborted. */
let claudeHangs = false;

const fetchWithHooks = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (duringSend && url.endsWith(`/${PHONE_ID}/messages`) && String(init?.body ?? '').includes(duringSend.match)) {
    const h = duringSend;
    duringSend = null;
    await h.fn();
  }
  if (url.startsWith('https://api.anthropic.com/')) {
    if (claudeHangs) {
      return new Promise((_, reject) => {
        const signal: AbortSignal | undefined = init?.signal;
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')));
      });
    }
    if (duringClaude) {
      const h = duringClaude;
      duringClaude = null;
      await h(init);
    }
  }
  return fake.fetch(input, init);
}) as typeof fetch;

let env: TestEnv;
let ws: string;
let channel: ChannelRow;
const workers: Worker[] = [];
const ctx = () => env.built.ctx;
const q = (sql: string, params?: unknown[]) => ctx().db.query<any>(sql, params);

beforeAll(async () => {
  env = await setup({ fetch: fetchWithHooks, config: { metaAppSecret: APP_SECRET } as any });
  ws = (await env.register('r3jobs@test.com', 'Trabajos R3')).workspaceId;
  channel = (
    await q(
      `INSERT INTO channels (workspace_id, provider, name, phone_number_id, waba_id, credentials, verify_token, is_default)
       VALUES ($1, 'cloud_api', 'Meta', $2, '2223334400777', $3, 'vt-r3j', true) RETURNING *`,
      [ws, PHONE_ID, encryptJson(ctx().config.encryptionKey, { accessToken: 'EAAG-test', appSecret: APP_SECRET })],
    )
  ).rows[0];
});
afterAll(() => env.close());

function worker(handlers: Record<string, JobHandler>, opts: WorkerOptions = {}) {
  const w = new Worker(ctx(), handlers, { pollMs: 20, ...opts });
  workers.push(w);
  return w;
}

async function until(cond: () => Promise<boolean> | boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(10);
  }
  throw new Error('condition not met in time');
}

const job = async (id: number | null) => (await q(`SELECT * FROM jobs WHERE id = $1`, [id])).rows[0];

/** A workspace owned by `userId`, created straight in the database. */
async function workspaceOf(userId: string, name = 'Extra'): Promise<string> {
  const id = (await q(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [name])).rows[0].id;
  await q(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, userId]);
  return id;
}

describe('queue and worker', () => {
  afterEach(async () => {
    for (const w of workers.splice(0)) await w.stop(200);
    await q(`DELETE FROM jobs`);
    await q(`DELETE FROM worker_heartbeats`);
  });

  it('gives inbound webhooks, bulk sends and media downloads their own lanes, with their workspace (#14)', async () => {
    const contactId = (await q(`INSERT INTO contacts (workspace_id, phone) VALUES ($1, '5215500077001') RETURNING id`, [ws])).rows[0].id;
    const sched = (
      await q(`INSERT INTO scheduled_messages (workspace_id, contact_id, content, send_at) VALUES ($1, $2, '{"type":"text","text":"x"}', now() + interval '1 day') RETURNING id`, [
        ws,
        contactId,
      ])
    ).rows[0].id;
    const queue = ctx().queue;
    const later = { delayMs: 3_600_000 };
    const hook = await job(await queue.enqueue('wa.webhook', { body: {}, channelIds: [] }, { ...later, workspaceId: ws }));
    const send = await job(await queue.enqueue('scheduled.send', { id: sched }, later));
    const media = await job(await queue.enqueue('media.download', { messageId: crypto.randomUUID() }, { ...later, workspaceId: ws }));
    const auto = await job(await queue.enqueue('automation.inbound', { workspaceId: ws, contactId, messageId: 'm', isNew: false }, later));
    expect(hook).toMatchObject({ lane: 'inbound', workspace_id: ws });
    expect(send).toMatchObject({ lane: 'bulk', workspace_id: ws }); // looked up from the scheduled row
    expect(media).toMatchObject({ lane: 'media', workspace_id: ws });
    expect(auto).toMatchObject({ lane: 'default', workspace_id: ws });
  });

  it("does not hold back other tenants' inbound messages and automation behind one tenant's burst of scheduled sends (#14)", async () => {
    const attacker = (await env.register()).workspaceId;
    const contactId = (await q(`INSERT INTO contacts (workspace_id, phone) VALUES ($1, '5215500077002') RETURNING id`, [attacker])).rows[0].id;
    const { rows } = await q(
      `INSERT INTO scheduled_messages (workspace_id, contact_id, content, send_at)
       SELECT $1, $2, '{"type":"text","text":"x"}', now() - interval '1 minute' FROM generate_series(1, 200) RETURNING id`,
      [attacker, contactId],
    );
    const due = new Date(Date.now() - 60_000);
    for (const r of rows) await ctx().queue.enqueue('scheduled.send', { id: r.id }, { runAt: due });
    let sent = 0;
    const victim: string[] = [];
    const w = worker({
      'scheduled.send': async () => {
        await sleep(25);
        sent++;
      },
      'wa.webhook': async () => void victim.push('webhook'),
      'automation.inbound': async () => void victim.push('automation'),
    });
    await ctx().queue.enqueue('wa.webhook', { body: {} }, { workspaceId: ws });
    await ctx().queue.enqueue('automation.inbound', { workspaceId: ws, contactId: crypto.randomUUID(), messageId: 'm', isNew: false });
    w.start();
    await until(() => victim.length === 2);
    expect(sent).toBeLessThan(100);
  });

  it('serves a light tenant before one account that keeps opening workspaces with hanging endpoints (#53)', async () => {
    const attackerUser = (await env.register()).userId;
    const victimWs = (await env.register()).workspaceId;
    let victimDone = 0;
    const w = worker({
      'webhook.deliver': async (_c, p) => {
        if (p.slow) await sleep(150);
        else victimDone++;
      },
    });
    const flood = async (n: number) => {
      for (let i = 0; i < n; i++) {
        const id = await workspaceOf(attackerUser, 'Ataque');
        for (let k = 0; k < 3; k++) await ctx().queue.enqueue('webhook.deliver', { workspaceId: id, slow: true });
      }
    };
    await flood(4);
    w.start();
    await sleep(200); // the attacker's workspaces are busy: the victim now has history, fresh ones have none
    for (let i = 0; i < 20; i++) await ctx().queue.enqueue('webhook.deliver', { workspaceId: victimWs });
    const t0 = Date.now();
    let attacking = true;
    const attack = (async () => {
      while (attacking && Date.now() - t0 < 2000) {
        await flood(2);
        await sleep(20);
      }
    })();
    await until(() => victimDone === 20, 1500).finally(() => (attacking = false));
    await attack;
  });

  it('serves a fast workspace before its hanging siblings when one account owns them all (#53)', async () => {
    // A closed instance: the operator created (and owns) every tenant's workspace.
    const operator = (await env.register()).userId;
    const slow = [await workspaceOf(operator, 'Lento 1'), await workspaceOf(operator, 'Lento 2'), await workspaceOf(operator, 'Lento 3')];
    const fast = await workspaceOf(operator, 'Rápido');
    let fastDone = 0;
    const w = worker(
      {
        'webhook.deliver': async (_c, p) => {
          if (p.slow) await sleep(400);
          else fastDone++;
        },
      },
      { lanes: { webhooks: { concurrency: 8, perWorkspace: 3 } } },
    );
    for (const id of slow) for (let k = 0; k < 40; k++) await ctx().queue.enqueue('webhook.deliver', { workspaceId: id, slow: true });
    w.start();
    await sleep(150); // every slot hangs now
    for (let i = 0; i < 20; i++) await ctx().queue.enqueue('webhook.deliver', { workspaceId: fast });
    const t0 = Date.now();
    await until(() => fastDone === 20, 5000);
    // Before, freed slots went to the owner's workspaces in turn: 3 of every 4 to a hanging one (about 2.7 s).
    expect(Date.now() - t0).toBeLessThan(1200);
  });

  it.skipIf(!!process.env.TEST_DATABASE_URL)('keeps claims from reading a large ready backlog of one workspace on PGlite (#54)', async () => {
    const tenant = (await env.register()).workspaceId;
    // Statistics from when nothing was queued: PGlite has no autovacuum to refresh them.
    await q(`ANALYZE jobs`);
    await q(
      `INSERT INTO jobs (type, payload, run_at, lane, workspace_id)
       SELECT 'scheduled.send', '{}', now() - interval '1 minute', 'bulk', $1::uuid FROM generate_series(1, 32000)`,
      [tenant],
    );
    const rowsRead = async () => {
      await q(`SELECT pg_stat_force_next_flush()`);
      await q(`SELECT 1`);
      return Number((await q(`SELECT seq_tup_read + COALESCE(idx_tup_fetch, 0) AS n FROM pg_stat_user_tables WHERE relid = 'jobs'::regclass`)).rows[0].n);
    };
    let ran = 0;
    const w = worker({ 'scheduled.send': async () => void ran++ }, { lanes: { bulk: { concurrency: 6, perWorkspace: 3 } } });
    await w.maintenance();
    const before = await rowsRead();
    for (let i = 0; i < 20; i++) await w.runOnce();
    expect(ran).toBe(60);
    // About 300. Planned as an empty queue, every claim read the 32,000 queued jobs (2.5 million
    // in all); with fresh statistics but "id IN (...)", it joined its picks against the whole table.
    expect((await rowsRead()) - before).toBeLessThan(5000);
  });

  it("claims past one contact's backlog without reading it: only the first job of a serial key is claimable (#54)", async () => {
    const key = crypto.randomUUID();
    const queue = ctx().queue;
    const running = await queue.enqueue('step', { contactId: key }, { serialKey: `contact:${key}` });
    await q(`UPDATE jobs SET status = 'running', locked_by = 'otro', locked_at = now(), attempts = 1 WHERE id = $1`, [running]);
    for (let i = 0; i < 30; i++) await queue.enqueue('step', { contactId: key, n: i }, { serialKey: `contact:${key}` });
    const claimable = await q(`SELECT count(*)::int AS n FROM jobs WHERE serial_key = $1 AND status = 'queued' AND NOT held`, [`contact:${key}`]);
    expect(claimable.rows[0].n).toBe(0);

    // A large backlog (as enqueue leaves it) does not slow down claims for everyone else.
    await q(
      `INSERT INTO jobs (type, payload, run_at, serial_key, held)
       SELECT 'step', '{}', now() - interval '1 minute', $1, true FROM generate_series(1, 20000)`,
      [`contact:${key}`],
    );
    let other = 0;
    const w = worker({ other: async () => void other++ }, { lanes: { default: { concurrency: 1 } } });
    for (let i = 0; i < 20; i++) await queue.enqueue('other', { n: i });
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) await w.runOnce();
    expect(other).toBe(20);
    // Reading past 20,000 blocked rows took about 20-40 ms per claim; skipping them takes a few ms.
    expect(performance.now() - t0).toBeLessThan(300);
  });

  it('runs the next job of a contact once the running one finishes, fails over to its retry, or is handed back (#54)', async () => {
    const order: string[] = [];
    let failOnce = true;
    const w = worker({
      step: async (_c, p) => {
        if (p.n === 'falla' && failOnce) {
          failOnce = false;
          throw new Error('transitorio');
        }
        order.push(p.n);
      },
    });
    const key = 'contact:cadena';
    const first = await ctx().queue.enqueue('step', { n: 'falla' }, { serialKey: key });
    await ctx().queue.enqueue('step', { n: 'b' }, { serialKey: key });
    await ctx().queue.enqueue('step', { n: 'c' }, { serialKey: key });
    w.start();
    // The failed job waits for its retry (5 s); the jobs behind it still run, in order.
    await until(() => order.length === 2);
    expect(order).toEqual(['b', 'c']);
    expect(await job(first)).toMatchObject({ status: 'queued', attempts: 1 });
    await q(`UPDATE jobs SET run_at = now() WHERE id = $1`, [first]);
    await until(() => order.length === 3);

    // A held job left without a running job ahead of it (lost release) is released by maintenance.
    await w.stop(200);
    const orphan = await ctx().queue.enqueue('step', { n: 'huerfano' }, { serialKey: 'contact:huerfano' });
    await q(`UPDATE jobs SET held = true WHERE id = $1`, [orphan]);
    await worker({}).maintenance();
    expect((await job(orphan)).held).toBe(false);
  });

  it('releases the next job of a contact when recovery fails the running one for good (#54)', async () => {
    const a = await ctx().queue.enqueue('step', { n: 'mata' }, { serialKey: 'contact:caido', maxAttempts: 1 });
    const b = await ctx().queue.enqueue('step', { n: 'siguiente' }, { serialKey: 'contact:caido' });
    expect((await job(b)).held).toBe(true);
    // Its worker died mid-run on the last attempt.
    await q(`UPDATE jobs SET status = 'running', locked_by = 'muerto', locked_at = now(), attempts = 1 WHERE id = $1`, [a]);
    await worker({}).recoverStale();
    expect((await job(a)).status).toBe('failed');
    expect((await job(b)).held).toBe(false);
    const ran: string[] = [];
    worker({ step: async (_c, p) => void ran.push(p.n) }).start();
    await until(() => ran.length === 1);
    expect(ran).toEqual(['siguiente']);
  });

  it('hands control back to the event loop while draining a backlog of database-only jobs (#52)', async () => {
    const N = 1500;
    await q(`INSERT INTO jobs (type, payload, run_at) SELECT 'quick', '{}', now() - interval '1 minute' FROM generate_series(1, $1)`, [N]);
    let done = 0;
    let timer!: Promise<number>;
    const w = worker(
      {
        quick: async (c) => {
          await c.db.query(`SELECT 1`);
          // Once draining has started: a timer due in 10 ms.
          if (++done === 1) timer = new Promise<number>((r) => setTimeout(() => r(done), 10));
        },
      },
      { pollMs: 1000 },
    );
    w.start();
    await until(() => done > 0);
    // Before, the timer fired only once every job had run.
    expect(await timer).toBeLessThan(N);
    await until(async () => (await q(`SELECT count(*)::int AS n FROM jobs WHERE status <> 'done'`)).rows[0].n === 0, 30_000);
  });

  it('sets run_at with the database clock, so clock skew neither delays jobs nor removes a delay (#31)', async () => {
    const real = Date.now.bind(Date);
    let skew = 0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => real() + skew);
    // The embedded database reads the process clock: run its queries without the skew.
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        const s = skew;
        skew = 0;
        try {
          return await ctx().db.query(sql, params);
        } finally {
          skew = s;
        }
      },
    };
    const queue = new Queue(db as any);
    try {
      skew = 3_600_000; // app server an hour ahead
      const now = await queue.enqueue('r3.reloj', {});
      skew = -3_600_000; // an hour behind
      const debounce = await queue.enqueue('r3.reloj', {}, { delayMs: 4000 });
      skew = 0;
      const wait = async (id: number | null) => Number((await q(`SELECT extract(epoch FROM run_at - now()) AS s FROM jobs WHERE id = $1`, [id])).rows[0].s);
      expect(Math.abs(await wait(now))).toBeLessThan(5);
      const d = await wait(debounce);
      expect(d).toBeGreaterThan(2);
      expect(d).toBeLessThan(5);
    } finally {
      spy.mockRestore();
    }
  });

  it('queues payloads with NUL characters (jsonb rejects them) by dropping the NUL (#32)', async () => {
    const id = await ctx().queue.enqueue('r3.nul', { text: 'hola\u0000mundo', nested: [{ ['cla\u0000ve']: 'x\u0000' }], literal: '\\u0000' }, { delayMs: 60_000 });
    const payload = (await job(id)).payload;
    expect(payload).toEqual({ text: 'holamundo', nested: [{ clave: 'x' }], literal: '\\u0000' });
  });

  it('queues payloads with a lone UTF-16 surrogate (jsonb rejects it) as U+FFFD, keeping whole emoji (#32)', async () => {
    const id = await ctx().queue.enqueue(
      'r3.surrogate',
      { text: 'hola \ud83d', low: '\ude00x', emoji: 'ok 😀', nested: [{ ['cla\ud83dve']: '\ud83d😀' }], literal: '\\ud83d' },
      { delayMs: 60_000 },
    );
    expect((await job(id)).payload).toEqual({
      text: 'hola \ufffd',
      low: '\ufffdx',
      emoji: 'ok 😀',
      nested: [{ ['cla\ufffdve']: '\ufffd😀' }],
      literal: '\\ud83d',
    });
  });

  it('accepts a signed Meta webhook whose text contains NUL, and stores the message (#32)', async () => {
    const raw = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '2223334400777',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: PHONE_ID },
                contacts: [{ profile: { name: 'Nu\u0000la' }, wa_id: '5215500077003' }],
                messages: [{ from: '5215500077003', id: 'wamid.R3J.NUL', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hola\u0000' } }],
              },
            },
          ],
        },
      ],
    });
    const r = await env.built.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${hmacSha256Hex(APP_SECRET, Buffer.from(raw))}` },
      payload: raw,
    });
    expect(r.statusCode).toBe(200);
    await env.drain();
    const m = (await q(`SELECT body FROM messages WHERE wamid = 'wamid.R3J.NUL'`)).rows[0];
    expect(m.body).toBe('hola');
  });

  it('accepts a signed Meta webhook whose text ends in half an emoji (a lone surrogate escape), and stores the message (#32)', async () => {
    const raw = `{"object":"whatsapp_business_account","entry":[{"id":"2223334400777","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"phone_number_id":"${PHONE_ID}"},"contacts":[{"profile":{"name":"Ana \\ud83d"},"wa_id":"5215500077005"}],"messages":[{"from":"5215500077005","id":"wamid.R3J.SUR","timestamp":"${Math.floor(Date.now() / 1000)}","type":"text","text":{"body":"hola \\ud83d"}}]}}]}]}`;
    for (let i = 0; i < 2; i++) {
      const r = await env.built.app.inject({
        method: 'POST',
        url: '/webhooks/whatsapp',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${hmacSha256Hex(APP_SECRET, Buffer.from(raw))}` },
        payload: raw,
      });
      expect(r.statusCode).toBe(200);
    }
    await env.drain();
    const m = (await q(`SELECT body FROM messages WHERE wamid = 'wamid.R3J.SUR'`)).rows;
    expect(m).toEqual([{ body: 'hola \ufffd' }]);
  });

  it('settles stale sends and orphaned scheduled messages from its periodic maintenance (#10, #22)', async () => {
    const contactId = (await q(`INSERT INTO contacts (workspace_id, phone, channel_id) VALUES ($1, '5215500077004', $2) RETURNING id`, [ws, channel.id])).rows[0].id;
    const msg = (
      await q(
        `INSERT INTO messages (workspace_id, contact_id, channel_id, direction, type, body, status, sent_by, created_at)
         VALUES ($1, $2, $3, 'out', 'text', 'perdido', 'unknown', 'user', now() - interval '8 days') RETURNING id`,
        [ws, contactId, channel.id],
      )
    ).rows[0].id;
    const sched = (
      await q(
        `INSERT INTO scheduled_messages (workspace_id, contact_id, content, send_at, status)
         VALUES ($1, $2, '{"type":"text","text":"x"}', now() - interval '1 hour', 'sending') RETURNING id`,
        [ws, contactId],
      )
    ).rows[0].id;
    await worker({}).maintenance();
    expect((await q(`SELECT status FROM messages WHERE id = $1`, [msg])).rows[0].status).toBe('failed');
    expect((await q(`SELECT status FROM scheduled_messages WHERE id = $1`, [sched])).rows[0].status).toBe('failed');
  });
});

// ---- Automation on a Cloud API number ----

let seq = 0;
const ts = () => String(Math.floor(Date.now() / 1000));

/** A customer message arriving through the Cloud API channel; runs the queue. */
async function customer(from: string, text: string, drain = true) {
  const m = await processInboundMessage(ctx(), channel, { from, id: `wamid.R3J.IN.${++seq}`, timestamp: ts(), type: 'text', text: { body: text } }, {
    profile: { name: 'Juan' },
    wa_id: from,
  });
  expect(m).not.toBeNull();
  if (drain) await runQueue();
  return m!.contact_id;
}

async function runQueue() {
  for (let i = 0; i < 3; i++) {
    await q(`UPDATE jobs SET run_at = now() WHERE status = 'queued' AND type IN ('ai.reply', 'automation.inbound')`);
    await env.drain();
  }
}

const transcript = async (contactId: string) =>
  (await q(`SELECT direction, sent_by, body FROM messages WHERE contact_id = $1 AND direction <> 'internal' ORDER BY created_at, id`, [contactId])).rows.map(
    (m: any) => `${m.direction === 'in' ? 'in/cliente' : `out/${m.sent_by}`}: ${m.body}`,
  );

describe('menu bot and a human taking over (#45, #42)', () => {
  beforeAll(async () => {
    const r = await env.api('PUT', '/api/workspace/settings', {
      automation_mode: 'menu',
      welcome: { enabled: false, text: '' },
      away: { enabled: false, text: 'x', hours: {} },
      bot: {
        menu: {
          prompt: 'Elige:',
          options: [
            {
              key: '1',
              label: 'Ventas',
              reply: 'Perfecto, ventas.',
              submenu: { prompt: '¿Qué producto?', options: [{ key: '1', label: 'Autos', handoff: true }, { key: '2', label: 'Motos', handoff: true }] },
            },
            { key: '2', label: 'Soporte', handoff: true },
          ],
        },
        fallback: 'No entendí.',
        handoff_message: 'Te atiende un asesor.',
        interactive: false,
        only_unassigned: false,
      },
    });
    expect(r.status).toBe(200);
  });

  it('stops when a person replies while the bot is sending, and stays quiet afterwards (#45)', async () => {
    const from = '5215500078001';
    const id = await customer(from, 'hola');
    duringSend = {
      match: 'Perfecto, ventas.',
      fn: async () => {
        const r = await env.api('POST', `/api/contacts/${id}/messages`, { type: 'text', text: 'Hola Juan, soy Ana, yo te atiendo.' });
        expect(r.status).toBe(200);
      },
    };
    await customer(from, '1');
    const c = (await q(`SELECT bot_state FROM contacts WHERE id = $1`, [id])).rows[0];
    expect(c.bot_state.done).toBe(true);
    await customer(from, 'gracias');
    // No submenu after the human's message, and no fallback for "gracias".
    expect((await transcript(id)).slice(-3)).toEqual(['out/bot: Perfecto, ventas.', 'out/user: Hola Juan, soy Ana, yo te atiendo.', 'in/cliente: gracias']);
  });

  it('keeps answering a contact who opted out of broadcasts when they write again (#42)', async () => {
    const from = '5215500078002';
    const id = await customer(from, 'STOP');
    expect((await q(`SELECT opted_out FROM contacts WHERE id = $1`, [id])).rows[0].opted_out).toBe(true);
    expect((await transcript(id)).filter((l: string) => l.startsWith('out/'))).toHaveLength(0); // the opt-out itself gets no answer
    await customer(from, 'Hola, quiero comprar');
    expect((await transcript(id)).at(-1)).toMatch(/^out\/bot: Elige:/);
  });

  it('starts nothing for a message the customer followed with STOP before its automation ran, opted out before or not (#46)', async () => {
    const from = '5215500078003';
    const outs = async (id: string) => (await transcript(id)).filter((l: string) => l.startsWith('out/'));
    // Both in one webhook: the automation of "hola" runs after STOP is stored.
    const id = await customer(from, 'hola', false);
    await customer(from, 'STOP', false);
    await runQueue();
    expect(await outs(id)).toEqual([]);
    expect((await q(`SELECT bot_state FROM contacts WHERE id = $1`, [id])).rows[0].bot_state).toBeNull();
    await customer(from, 'Hola', false);
    await customer(from, 'stop', false);
    await runQueue();
    expect(await outs(id)).toEqual([]);
    await customer(from, 'Hola, quiero comprar');
    expect((await transcript(id)).at(-1)).toMatch(/^out\/bot: Elige:/);
  });
});

describe('AI agent: bounded, split, and never over a human (#13, #17, #46, #42)', () => {
  beforeAll(async () => {
    const r = await env.api('PUT', '/api/workspace/settings', {
      automation_mode: 'ai',
      ai: {
        model: DEFAULT_AI_MODEL,
        api_key: 'sk-ant-test',
        instructions: 'Vende autos.',
        knowledge: 'Auto compacto: $250,000.',
        handoff_message: 'Te paso con un asesor.',
        only_unassigned: false,
        max_replies: 50,
      },
    });
    expect(r.status).toBe(200);
  });
  afterEach(() => {
    duringClaude = null;
    claudeHangs = false;
    replies.length = 0;
  });
  const claudeCalls = () => fake.calls.filter((c) => c.url.includes('api.anthropic.com'));

  it('drops a reply when a person answers while the AI is writing it (#46)', async () => {
    const from = '5215500079001';
    const id = await customer(from, '¿Precio?', false);
    duringClaude = async () => {
      const r = await env.api('POST', `/api/contacts/${id}/messages`, { type: 'text', text: 'Hola, soy Ana: cuesta $240,000.' });
      expect(r.status).toBe(200);
    };
    replies.push({ content: [{ type: 'text', text: 'IA: el precio es $250,000.' }], stop_reason: 'end_turn' });
    await runQueue();
    expect(await transcript(id)).toEqual(['in/cliente: ¿Precio?', 'out/user: Hola, soy Ana: cuesta $240,000.']);
  });

  it('drops a reply when the customer opts out while the AI is writing it, but answers contacts who opted out before (#46, #42)', async () => {
    const from = '5215500079002';
    const id = await customer(from, '¿Tienen crédito?', false);
    duringClaude = async () => {
      await customer(from, 'BAJA', false);
    };
    replies.push({ content: [{ type: 'text', text: 'Sí, a 24 meses.' }], stop_reason: 'end_turn' });
    await runQueue();
    expect((await transcript(id)).filter((l: string) => l.startsWith('out/'))).toHaveLength(0);

    // Opted out of broadcasts long ago: a new question still gets an answer.
    replies.push({ content: [{ type: 'text', text: 'Sí, a 24 meses.' }], stop_reason: 'end_turn' });
    await customer(from, '¿Y de contado?');
    expect((await transcript(id)).at(-1)).toBe('out/ai: Sí, a 24 meses.');
  });

  it('does not answer when the customer sends STOP while the reply waits out its debounce, opted out before or not (#46, #42)', async () => {
    const from = '5215500079006';
    const queuedReplies = async (id: string) =>
      (await q(`SELECT count(*)::int AS n FROM jobs WHERE type = 'ai.reply' AND status = 'queued' AND payload->>'contactId' = $1`, [id])).rows[0].n;
    const id = await customer(from, '¿Precio?', false);
    await env.drain(); // automation queues the reply, due in 4 s
    expect(await queuedReplies(id)).toBe(1);
    await customer(from, 'STOP', false);
    const before = claudeCalls().length;
    await runQueue();
    expect(claudeCalls()).toHaveLength(before);
    expect(await transcript(id)).toEqual(['in/cliente: ¿Precio?', 'in/cliente: STOP']);

    // Opted out already: a new question is answered, and a STOP during the next debounce is not.
    replies.push({ content: [{ type: 'text', text: 'Cuesta $250,000.' }], stop_reason: 'end_turn' });
    await customer(from, '¿Cuánto cuesta el compacto?');
    expect((await transcript(id)).at(-1)).toBe('out/ai: Cuesta $250,000.');
    await customer(from, '¿Y la camioneta?', false);
    await env.drain();
    expect(await queuedReplies(id)).toBe(1);
    await customer(from, 'stop', false);
    await runQueue();
    expect((await transcript(id)).slice(-2)).toEqual(['in/cliente: ¿Y la camioneta?', 'in/cliente: stop']);
  });

  it('splits a reply longer than WhatsApp allows into several messages, and asks Claude for short ones (#17)', async () => {
    const para = (n: number) => `Modelo ${n}: ${'auto con buen rendimiento y garantía. '.repeat(45).trim()}`;
    const long = Array.from({ length: 6 }, (_, i) => para(i + 1)).join('\n\n');
    expect(long.length).toBeGreaterThan(9000);
    replies.push({ content: [{ type: 'text', text: long }], stop_reason: 'end_turn' });
    const before = claudeCalls().length;
    const id = await customer('5215500079003', 'Mándame todo el catálogo');
    expect(claudeCalls()[before].body.max_tokens).toBeLessThanOrEqual(1024);
    const outs = (await q(`SELECT body, status FROM messages WHERE contact_id = $1 AND direction = 'out' ORDER BY created_at, id`, [id])).rows;
    expect(outs.length).toBeGreaterThanOrEqual(3);
    expect(outs.every((m: any) => m.body.length <= 4096 && m.status !== 'failed')).toBe(true);
    expect(outs.map((m: any) => m.body).join('\n\n')).toBe(long);

    // A reply cut off by the token limit ends at its last complete sentence.
    replies.push({ content: [{ type: 'text', text: 'El compacto cuesta $250,000. También tenemos la camioneta, que inclu' }], stop_reason: 'max_tokens' });
    await customer('5215500079003', '¿Y el compacto?');
    expect((await transcript(id)).at(-1)).toBe('out/ai: El compacto cuesta $250,000.');
  });

  it('gives up on a Claude call that never answers long before the job timeout (#13)', async () => {
    const id = await customer('5215500079004', 'Hola', false);
    claudeHangs = true;
    const t0 = Date.now();
    await runAiReply(ctx(), { workspaceId: ws, contactId: id }, { requestTimeoutMs: 100, deadlineMs: 400 }).catch(() => {});
    expect(Date.now() - t0).toBeLessThan(3000);
    const notes = (await q(`SELECT body FROM messages WHERE contact_id = $1 AND direction = 'internal'`, [id])).rows;
    expect(notes.some((n: any) => /no respondió/.test(n.body))).toBe(true);
  }, 15_000);

  it('sends one reply even when a timed-out run and its retry both reach Claude (#13)', async () => {
    const id = await customer('5215500079005', '¿Lo tienen en rojo?', false);
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    duringClaude = () => slow; // the first run waits here past its job timeout
    replies.push({ content: [{ type: 'text', text: 'Sí, en rojo.' }], stop_reason: 'end_turn' }, { content: [{ type: 'text', text: 'Sí, en rojo.' }], stop_reason: 'end_turn' });
    await q(`DELETE FROM jobs WHERE status = 'queued'`);
    const jobId = await ctx().queue.enqueue('ai.reply', { workspaceId: ws, contactId: id }, { maxAttempts: 2 });
    let settled = 0;
    const w = new Worker(ctx(), { 'ai.reply': (c, p) => runAiReply(c, p).finally(() => void settled++) }, { pollMs: 20, jobTimeoutMs: 300 });
    w.start();
    try {
      await until(async () => (await job(jobId)).attempts === 1 && (await job(jobId)).status === 'queued');
      await q(`UPDATE jobs SET run_at = now() WHERE id = $1`, [jobId]);
      await until(async () => (await job(jobId)).status === 'done');
      release();
      await until(() => settled === 2);
    } finally {
      await w.stop(200);
    }
    expect((await transcript(id)).filter((l: string) => l.startsWith('out/ai'))).toEqual(['out/ai: Sí, en rojo.']);
  });
});
