import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { splitSql } from '../db/index.js';
import { migrations } from '../db/migrations.js';
import { Worker, type JobHandler, type WorkerOptions } from '../jobs/worker.js';
import { cutText, fitTitle } from '../services/automation.js';
import { setup, sleep, type TestEnv } from './helpers.js';

// Review round 4, jobs and automation: one test (or more) per finding, each failing without its fix.

let env: TestEnv;
const workers: Worker[] = [];
const ctx = () => env.built.ctx;
const q = (sql: string, params?: unknown[]) => ctx().db.query<any>(sql, params);

beforeAll(async () => {
  env = await setup();
  await env.register('r4jobs@test.com', 'Trabajos R4');
});
afterAll(() => env.close());

function worker(handlers: Record<string, JobHandler>, opts: WorkerOptions = {}) {
  const w = new Worker(ctx(), handlers, { pollMs: 20, ...opts });
  workers.push(w);
  return w;
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

async function until(cond: () => Promise<boolean> | boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(10);
  }
  throw new Error('condition not met in time');
}

const job = async (id: number | null) => (await q(`SELECT * FROM jobs WHERE id = $1`, [id])).rows[0];
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe('worker', () => {
  afterEach(async () => {
    for (const w of workers.splice(0)) await w.stop(200);
    await q(`DELETE FROM jobs`);
    await q(`DELETE FROM worker_heartbeats`);
  });

  // First in the file: no earlier VACUUM has made old space reusable.
  it.skipIf(!!process.env.TEST_DATABASE_URL)('reuses the space of cleaned-up jobs on the embedded database (#27)', async () => {
    const size = async () => Number((await q(`SELECT pg_relation_size('jobs') AS s`)).rows[0].s);
    const finished = () =>
      q(
        `INSERT INTO jobs (type, payload, status, finished_at)
         SELECT 'viejo', jsonb_build_object('pad', repeat('x', 400)), 'done', now() - interval '8 days' FROM generate_series(1, 4000)`,
      );
    const before = await size();
    await finished();
    const full = await size();
    const batch = full - before;
    expect(batch).toBeGreaterThan(1_000_000);
    const w = worker({});
    // The cleanup deletes them; the first run vacuums the whole database.
    await w.maintenance();
    expect((await q(`SELECT count(*)::int AS n FROM jobs WHERE type = 'viejo'`)).rows[0].n).toBe(0);
    await finished();
    // Before, deleted rows were never vacuumed: every new job added pages at the end of the table.
    expect(await size()).toBeLessThan(full + batch / 2);
    // The next 10-minute cleanup vacuums only the jobs table.
    (w as any).lastCleanup = 0;
    await w.maintenance();
    await finished();
    expect(await size()).toBeLessThan(full + batch / 2);
  });

  it('runs the jobs of a fair claim even when the claim of jobs without a workspace fails right after it (#14)', async () => {
    let failNext = true;
    const real = ctx().db;
    const db = new Proxy(real, {
      get: (t, k) =>
        k === 'query'
          ? (sql: string, p?: unknown[]) => {
              if (failNext && sql.includes('j.workspace_id IS NULL') && p?.[0] === 'webhooks') {
                failNext = false;
                return Promise.reject(Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }));
              }
              return t.query(sql, p);
            }
          : (t as any)[k],
    });
    const ran: number[] = [];
    const w = new Worker({ ...ctx(), db } as any, { 'webhook.deliver': async (_c, _p, j) => void ran.push(j.id) }, {
      pollMs: 20,
      lanes: { webhooks: { concurrency: 8, perWorkspace: 3 } },
    });
    workers.push(w);
    const ws = (await env.register()).workspaceId;
    // Its last attempt: lost and recovered, it would have failed without ever running.
    const id = (await ctx().queue.enqueue('webhook.deliver', { workspaceId: ws, endpointId: crypto.randomUUID() }, { maxAttempts: 2 }))!;
    await q(`UPDATE jobs SET attempts = 1 WHERE id = $1`, [id]);
    w.start();
    await until(() => ran.includes(id));
    expect(failNext).toBe(false);
    await until(async () => (await job(id)).status === 'done');
    expect((await job(id)).attempts).toBe(2);
  });

  it("hands a job back at shutdown ahead of the contact's later jobs, so they still run in order (#15)", async () => {
    const hang = gate();
    const contactId = crypto.randomUUID();
    const w1 = worker({ 'automation.inbound': async (_c, p) => (p.n === 'hola' ? hang.promise : undefined) });
    const first = await ctx().queue.enqueue('automation.inbound', { contactId, n: 'hola' });
    w1.start();
    await until(async () => (await job(first)).status === 'running');
    const second = await ctx().queue.enqueue('automation.inbound', { contactId, n: '2' });
    expect((await job(second)).held).toBe(true);
    // SIGTERM while the first one is still sending.
    await w1.stop(100);
    expect(await job(first)).toMatchObject({ status: 'queued', attempts: 0, held: false });
    expect((await job(second)).held).toBe(true); // still behind it
    const order: string[] = [];
    worker({ 'automation.inbound': async (_c, p) => void order.push(p.n) }).start();
    await until(() => order.length === 2);
    expect(order).toEqual(['hola', '2']);
    hang.open();
  });

  it('keeps the order of a contact when the embedded database recovers the jobs cut off by the last exit (#15)', async () => {
    const queue = ctx().queue;
    const key = 'contact:arranque';
    const a = await queue.enqueue('step', { n: 'a' }, { serialKey: key });
    await q(`UPDATE jobs SET status = 'running', locked_by = 'anterior', locked_at = now(), attempts = 1 WHERE id = $1`, [a]);
    const b = await queue.enqueue('step', { n: 'b' }, { serialKey: key });
    await worker({}).recoverStale(true);
    expect(await job(a)).toMatchObject({ status: 'queued', attempts: 1, held: false });
    expect((await job(b)).held).toBe(true);
    const order: string[] = [];
    worker({ step: async (_c, p) => void order.push(p.n) }).start();
    await until(() => order.length === 2);
    expect(order).toEqual(['a', 'b']);
  });
});

describe('menu bot', () => {
  let me: { cookie: string; userId: string; workspaceId: string };
  let channelId: string;
  const o = () => ({ cookie: me.cookie, ws: me.workspaceId });
  const menuSettings = (menu: unknown, extra: Record<string, unknown> = {}) =>
    env.api(
      'PUT',
      '/api/workspace/settings',
      { automation_mode: 'menu', bot: { menu, fallback: 'No entendí.', handoff_message: 'Te atiende un asesor.', interactive: true, only_unassigned: false, ...extra } },
      o(),
    );
  const say = async (from: string, text: string) => {
    const r = await env.api('POST', `/api/channels/${channelId}/simulate`, { from, text, name: 'Cliente' }, o());
    expect(r.status).toBe(200);
    await env.drain();
    return r.body.message.contact_id as string;
  };
  const outbound = async (contactId: string) =>
    (await q(`SELECT sent_by, type, body, payload FROM messages WHERE contact_id = $1 AND direction = 'out' ORDER BY created_at`, [contactId])).rows;

  beforeAll(async () => {
    me = await env.register('r4bot@test.com', 'Bot R4');
    channelId = (await env.api('POST', '/api/channels', { provider: 'sandbox', name: 'Pruebas' }, o())).body.channel.id;
  });

  it('never cuts a button or list title, or a body, inside an emoji (#18)', () => {
    for (const [label, max] of [
      ['Promos🔥🔥🔥🔥🔥🔥🔥🔥', 20],
      ['Precios y catálogo👗👠', 20],
      ['Atención personalizada🙋‍♂️', 24],
      ['𝗣𝗿𝗼𝗺𝗼𝗰𝗶𝗼𝗻𝗲𝘀', 20],
      ['𝗣𝗿𝗼𝗺𝗼𝗰𝗶𝗼𝗻𝗲𝘀 𝗱𝗲𝗹 𝗺𝗲𝘀', 24],
    ] as const) {
      const title = fitTitle(label, max);
      expect(title.length).toBeLessThanOrEqual(max);
      expect(title).not.toMatch(LONE_SURROGATE);
      expect(title.endsWith('…')).toBe(true);
    }
    // A cut never leaves half of an emoji sequence either.
    expect(fitTitle('Atención personalizada🙋‍♂️', 24)).toBe('Atención personalizada…');
    expect(cutText(`${'a'.repeat(1023)}🔥`, 1024)).toBe('a'.repeat(1023));
    expect(cutText('👨‍👩‍👧‍👦', 4)).toBe('👨‍');
    expect(cutText('Hola 👋', 1024)).toBe('Hola 👋');
  });

  it('sends its menu when an option label or the fallback cut lands inside an emoji (#18)', async () => {
    const r = await menuSettings(
      { prompt: `${'a'.repeat(21)}${'🔥'.repeat(10)}`, options: [{ key: '1', label: 'Promos🔥🔥🔥🔥🔥🔥🔥🔥', handoff: true }, { key: '2', label: 'Asesor', handoff: true }] },
      // With the fallback in front, the 1024-character body cut falls in the middle of the first 🔥.
      { fallback: 'x'.repeat(1000) },
    );
    expect(r.status).toBe(200);
    const contactId = await say('5215500044181', 'hola');
    let out = await outbound(contactId);
    expect(out.map((m: any) => m.sent_by)).toEqual(['bot']);
    const buttons = out[0].payload.interactive.action.buttons;
    expect(buttons[0].reply.title).toBe('Promos🔥🔥🔥🔥🔥🔥…');
    expect(buttons[0].reply.title).not.toMatch(LONE_SURROGATE);

    await say('5215500044181', 'no sé');
    out = await outbound(contactId);
    expect(out.map((m: any) => m.sent_by)).toEqual(['bot', 'bot']);
    const body = out[1].payload.interactive.body.text as string;
    expect(body.length).toBeLessThanOrEqual(1024);
    expect(body).not.toMatch(LONE_SURROGATE);
    expect((await q(`SELECT count(*)::int AS n FROM jobs WHERE type = 'automation.inbound' AND status <> 'done'`)).rows[0].n).toBe(0);
  });

  it('does not start in a conversation a person answered before the upgrade (#32)', async () => {
    const menu = { prompt: 'Soy el asistente virtual, elige:', options: [{ key: '1', label: 'Precios' }, { key: '2', label: 'Asesor', handoff: true }] };
    expect((await menuSettings(menu, { interactive: false })).status).toBe(200);
    // What older versions left behind: an agent wrote to a lead the bot never talked to, and
    // bot_state stayed NULL (they only marked it done once the bot had run).
    const c = await env.api('POST', '/api/contacts', { phone: '+5215500044182', name: 'Juan' }, o());
    const id = c.body.contact.id;
    await q(
      `INSERT INTO messages (workspace_id, contact_id, channel_id, direction, type, body, status, sent_by, user_id, created_at)
       VALUES ($1, $2, $3, 'out', 'text', 'Hola Juan, ¿te llegó tu pedido?', 'read', 'user', $4, now() - interval '1 hour')`,
      [me.workspaceId, id, channelId, me.userId],
    );
    await q(`UPDATE contacts SET channel_id = $2, bot_state = NULL WHERE id = $1`, [id, channelId]);
    // The upgrade runs migration 006, which marks the bot done in conversations a person answered.
    const backfill = splitSql(migrations.find((m) => m.name.startsWith('006_'))!.sql).filter((s) => /^UPDATE contacts\b/m.test(s) && s.includes('bot_state'));
    expect(backfill).toHaveLength(1);
    await q(backfill[0]);

    await say('5215500044182', 'Sí, todo bien, gracias');
    expect((await outbound(id)).map((m: any) => m.sent_by)).toEqual(['user']);
    // "Reset bot" in the inbox still restarts it on purpose.
    expect((await env.api('PATCH', `/api/contacts/${id}`, { reset_bot: true }, o())).status).toBe(200);
    await say('5215500044182', 'hola');
    expect((await outbound(id)).map((m: any) => m.sent_by)).toEqual(['user', 'bot']);
  });

  it('leaves running a bot that was restarted after the person answered (#32)', async () => {
    const menu = {
      prompt: 'Elige:',
      options: [
        { key: '1', label: 'Citas', submenu: { prompt: 'Tratamiento:', options: [{ key: 'a', label: 'Ortodoncia', reply: 'Ortodoncia elegida' }] } },
        { key: '2', label: 'Asesor', handoff: true },
      ],
    };
    expect((await menuSettings(menu, { interactive: false })).status).toBe(200);
    const contact = async (phone: string, sentBy: 'user' | 'phone', state: { path: string[]; updated_at: string }) => {
      const id = (await env.api('POST', '/api/contacts', { phone: `+${phone}`, name: 'Ana' }, o())).body.contact.id;
      await q(
        `INSERT INTO messages (workspace_id, contact_id, channel_id, direction, type, body, status, sent_by, user_id, created_at)
         VALUES ($1, $2, $3, 'out', 'text', 'Hola Ana', 'read', $4, $5, now() - interval '1 hour')`,
        [me.workspaceId, id, channelId, sentBy, sentBy === 'user' ? me.userId : null],
      );
      await q(`UPDATE contacts SET channel_id = $2, bot_state = $3 WHERE id = $1`, [id, channelId, JSON.stringify(state)]);
      return id as string;
    };
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    // An agent answered an hour ago (round 3 marked the bot done then); afterwards the customer typed
    // 'menú' and chose '1', or an admin reset the bot and the customer wrote again: the saved state
    // is newer than the reply and has no done.
    const restarted = await contact('5215500044183', 'user', { path: ['1'], updated_at: ago(60_000) });
    const reset = await contact('5215500044184', 'user', { path: [], updated_at: ago(0) });
    // Older versions did not stop the bot on a WhatsApp Business app reply: that reply came after
    // the bot's last step, so the person took the conversation.
    const tookOver = await contact('5215500044185', 'phone', { path: ['1'], updated_at: ago(2 * 3600_000) });

    const backfill = splitSql(migrations.find((m) => m.name.startsWith('006_'))!.sql).filter((s) => /^UPDATE contacts\b/m.test(s) && s.includes('bot_state'));
    expect(backfill).toHaveLength(1);
    await q(backfill[0]);
    const done = async (id: string) => (await q(`SELECT bot_state->>'done' AS d FROM contacts WHERE id = $1`, [id])).rows[0].d;
    expect(await done(restarted)).toBeNull();
    expect(await done(reset)).toBeNull();
    expect(await done(tookOver)).toBe('true');

    await say('5215500044183', 'a');
    expect((await outbound(restarted)).map((m: any) => `${m.sent_by}:${m.body}`)).toEqual(['user:Hola Ana', 'bot:Ortodoncia elegida']);
    await say('5215500044185', 'a');
    expect((await outbound(tookOver)).map((m: any) => m.sent_by)).toEqual(['phone']);
  });
});
