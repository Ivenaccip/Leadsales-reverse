import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { retryDelaySec } from '../jobs/queue.js';
import { Worker, type JobHandler, type WorkerOptions } from '../jobs/worker.js';
import { fakeFetch, setup, sleep, type TestEnv } from './helpers.js';

let env: TestEnv;
const workers: Worker[] = [];
const hooks = fakeFetch([(c) => (c.url.startsWith('https://93.184.216.34/caido') ? { status: 503, json: { error: 'down' } } : undefined)]);

beforeAll(async () => {
  env = await setup({ fetch: hooks.fetch, config: { allowPrivateWebhooks: false } });
  await env.register('jobs@test.com', 'Trabajos');
});
afterAll(() => env.close());
afterEach(async () => {
  for (const w of workers.splice(0)) await w.stop(200);
  await q(`DELETE FROM jobs`);
  await q(`DELETE FROM worker_heartbeats`);
});

const q = (sql: string, params?: unknown[]) => env.built.ctx.db.query(sql, params);

function worker(handlers: Record<string, JobHandler>, opts: WorkerOptions = {}) {
  const w = new Worker(env.built.ctx, handlers, { pollMs: 20, ...opts });
  workers.push(w);
  return w;
}

/** A promise the test resolves by hand: stands in for a slow endpoint or a long Claude call. */
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

async function job(id: number | null) {
  return (await q(`SELECT * FROM jobs WHERE id = $1`, [id])).rows[0];
}

async function insertRunning(o: { type?: string; lockedBy?: string | null; lockedAgo?: string; attempts?: number; maxAttempts?: number; dedupeKey?: string }) {
  const { rows } = await q(
    `INSERT INTO jobs (type, payload, status, locked_at, locked_by, attempts, max_attempts, dedupe_key)
     VALUES ($1, '{}', 'running', now() - $2::interval, $3, $4, $5, $6) RETURNING id`,
    [o.type ?? 'test.job', o.lockedAgo ?? '0 seconds', o.lockedBy === undefined ? 'muerto' : o.lockedBy, o.attempts ?? 1, o.maxAttempts ?? 5, o.dedupeKey ?? null],
  );
  return rows[0].id as number;
}

describe('job queue policies', () => {
  it('gives each job type its lane, serial key and retry schedule', async () => {
    const contactId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const queue = env.built.ctx.queue;
    const a = await job(await queue.enqueue('automation.inbound', { workspaceId, contactId, messageId: 'm', isNew: false }, { delayMs: 60_000 }));
    const ai = await job(await queue.enqueue('ai.reply', { workspaceId, contactId }, { delayMs: 60_000, dedupeKey: `ai:${contactId}` }));
    const wh = await job(await queue.enqueue('webhook.deliver', { workspaceId, endpointId: 'e' }, { delayMs: 60_000 }));
    // inbound.ts asks for 4 attempts: inbound media still gets the long schedule.
    const media = await job(await queue.enqueue('media.download', { messageId: 'm' }, { delayMs: 60_000, maxAttempts: 4 }));
    expect(a.serial_key).toBe(`contact:${contactId}`);
    expect(ai.serial_key).toBe(`contact:${contactId}`);
    expect(a.lane).toBe('default');
    expect(wh.lane).toBe('webhooks');
    expect(wh.workspace_id).toBe(workspaceId);
    expect(wh.max_attempts).toBeGreaterThanOrEqual(12);
    expect(media.max_attempts).toBeGreaterThanOrEqual(10);
  });

  it('retries webhook deliveries and media downloads for hours, not seconds', () => {
    const window = (type: string, attempts: number) => Array.from({ length: attempts - 1 }, (_, i) => retryDelaySec(type, i + 1)).reduce((s, x) => s + x, 0);
    expect(window('webhook.deliver', 12)).toBeGreaterThan(12 * 3600);
    expect(window('media.download', 10)).toBeGreaterThan(12 * 3600);
    expect(retryDelaySec('webhook.deliver', 1)).toBeGreaterThanOrEqual(30);
    expect(retryDelaySec('wa.webhook', 1)).toBe(5); // other jobs keep the short exponential backoff
  });

  it('requeues a failed webhook delivery with the long schedule', async () => {
    const w = await env.api('POST', '/api/webhooks', { url: 'https://93.184.216.34/caido', events: ['contact.created'] });
    expect(w.status).toBe(200);
    await env.api('POST', '/api/contacts', { phone: '5215512340000', name: 'Webhook caído' });
    await env.drain();
    const { rows } = await q(`SELECT *, extract(epoch FROM run_at - now())::int AS wait FROM jobs WHERE type = 'webhook.deliver'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('queued');
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].max_attempts).toBe(12);
    expect(rows[0].wait).toBeGreaterThanOrEqual(25);
    await env.api('DELETE', `/api/webhooks/${w.body.webhook.id}`);
  });
});

describe('worker slots and lanes', () => {
  it('claims a new job as soon as a slot frees instead of waiting for the slowest job of a batch', async () => {
    const slow = gate();
    const done: number[] = [];
    const w = worker({ slow: () => slow.promise, fast: async (_c, p) => void done.push(p.n) }, { lanes: { default: { concurrency: 2 } } });
    await env.built.ctx.queue.enqueue('slow', {});
    for (let n = 0; n < 6; n++) await env.built.ctx.queue.enqueue('fast', { n });
    w.start();
    await until(() => done.length === 6);
    expect((await q(`SELECT status FROM jobs WHERE type = 'slow'`)).rows[0].status).toBe('running');
    slow.open();
    await until(async () => (await q(`SELECT count(*)::int AS n FROM jobs WHERE status <> 'done'`)).rows[0].n === 0);
  });

  it("runs outgoing webhooks in their own lane: one tenant's hanging endpoint delays neither core jobs nor other tenants", async () => {
    const hang = gate();
    const delivered: string[] = [];
    let core = 0;
    const w = worker(
      {
        'webhook.deliver': async (_c, p) => {
          if (p.slow) return hang.promise;
          delivered.push(p.workspaceId);
        },
        'wa.webhook': async () => void core++,
      },
      { lanes: { default: { concurrency: 2 }, inbound: { concurrency: 2 }, webhooks: { concurrency: 4, perWorkspace: 2 } } },
    );
    const attacker = crypto.randomUUID();
    const victim = crypto.randomUUID();
    for (let i = 0; i < 40; i++) await env.built.ctx.queue.enqueue('webhook.deliver', { workspaceId: attacker, slow: true });
    await env.built.ctx.queue.enqueue('webhook.deliver', { workspaceId: victim });
    await env.built.ctx.queue.enqueue('wa.webhook', {});
    w.start();
    await until(() => core === 1 && delivered.includes(victim));
    // Handlers record their effect before the worker writes 'done': wait for those rows to settle.
    await until(async () => (await q(`SELECT count(*)::int AS n FROM jobs WHERE status = 'running' AND workspace_id IS DISTINCT FROM $1`, [attacker])).rows[0].n === 0);
    const running = (await q(`SELECT workspace_id, count(*)::int AS n FROM jobs WHERE status = 'running' GROUP BY workspace_id`)).rows;
    expect(running).toEqual([{ workspace_id: attacker, n: 2 }]); // capped per workspace
    hang.open();
  });

  it('keeps delivering for a tenant with fast endpoints while many workspaces with hanging endpoints share the lane', async () => {
    let victimDone = 0;
    const w = worker(
      {
        'webhook.deliver': async (_c, p) => {
          if (p.slow) await sleep(200);
          else victimDone++;
        },
      },
      { lanes: { webhooks: { concurrency: 4, perWorkspace: 2 } } },
    );
    for (let k = 0; k < 6; k++) {
      const attacker = crypto.randomUUID();
      for (let i = 0; i < 15; i++) await env.built.ctx.queue.enqueue('webhook.deliver', { workspaceId: attacker, slow: true });
    }
    const victim = crypto.randomUUID();
    for (let i = 0; i < 30; i++) await env.built.ctx.queue.enqueue('webhook.deliver', { workspaceId: victim });
    w.start();
    // Shared by slot count, the victim would get 1 slot in 7 as they free up (about 10 s here):
    // shared by slot time, its quick deliveries keep the slots the hanging ones give back.
    await until(() => victimDone === 30, 3000);
  });

  it('never runs two jobs with the same serial key at once, and keeps their order', async () => {
    const active = new Map<string, number>();
    let maxPerKey = 0;
    let maxOverall = 0;
    let overall = 0;
    const order: number[] = [];
    const w = worker(
      {
        step: async (_c, p) => {
          active.set(p.key, (active.get(p.key) ?? 0) + 1);
          overall++;
          maxPerKey = Math.max(maxPerKey, active.get(p.key)!);
          maxOverall = Math.max(maxOverall, overall);
          if (p.key === 'a') order.push(p.n);
          await sleep(15);
          active.set(p.key, active.get(p.key)! - 1);
          overall--;
        },
      },
      { lanes: { default: { concurrency: 6 } } },
    );
    for (let n = 0; n < 4; n++) {
      await env.built.ctx.queue.enqueue('step', { key: 'a', n }, { serialKey: 'contact:a' });
      await env.built.ctx.queue.enqueue('step', { key: 'b', n }, { serialKey: 'contact:b' });
    }
    w.start();
    await until(async () => (await q(`SELECT count(*)::int AS n FROM jobs WHERE status <> 'done'`)).rows[0].n === 0);
    expect(maxPerKey).toBe(1);
    expect(maxOverall).toBe(2); // different contacts still run side by side
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('lets the database refuse a second running job with the same serial key', async () => {
    await q(`INSERT INTO jobs (type, status, serial_key, locked_by) VALUES ('x', 'running', 'contact:z', 'w1')`);
    await expect(q(`INSERT INTO jobs (type, status, serial_key, locked_by) VALUES ('x', 'running', 'contact:z', 'w2')`)).rejects.toThrow();
  });

  it('gives the slot back when a handler hangs past the job timeout', async () => {
    const w = worker({ stuck: () => new Promise(() => {}) }, { jobTimeoutMs: 50 });
    const id = await env.built.ctx.queue.enqueue('stuck', {}, { maxAttempts: 1 });
    w.start();
    await until(async () => (await job(id)).status === 'failed');
    expect((await job(id)).last_error).toMatch(/no terminó/);
  });
});

describe('recovery of interrupted jobs', () => {
  it('recovers every stale job even when two share a dedupe key, and still cleans up old jobs', async () => {
    const a = await insertRunning({ type: 'ai.reply', dedupeKey: 'ai:X' });
    const b = await insertRunning({ type: 'ai.reply', dedupeKey: 'ai:X' });
    const other = await insertRunning({ type: 'webhook.deliver' });
    const old = (await q(`INSERT INTO jobs (type, status, finished_at) VALUES ('viejo', 'done', now() - interval '30 days') RETURNING id`)).rows[0].id;
    await worker({}).maintenance();
    const statuses = [(await job(a)).status, (await job(b)).status].sort();
    expect(statuses).toEqual(['done', 'queued']); // one runs again, the duplicate is superseded
    expect((await job(other)).status).toBe('queued');
    expect(await job(old)).toBeUndefined();
  });

  it('fails a recovered job that is out of attempts instead of retrying it forever', async () => {
    const spent = await insertRunning({ type: 'media.download', attempts: 4, maxAttempts: 4 });
    const left = await insertRunning({ type: 'media.download', attempts: 2, maxAttempts: 4 });
    await worker({}).recoverStale();
    const s = await job(spent);
    expect(s.status).toBe('failed');
    expect(s.last_error).toMatch(/se detuvo/);
    const l = (await q(`SELECT status, run_at > now() AS later FROM jobs WHERE id = $1`, [left])).rows[0];
    expect(l).toEqual({ status: 'queued', later: true }); // with backoff
  });

  it('recovers the jobs of a worker without a fresh heartbeat, not those of a live one', async () => {
    await q(`INSERT INTO worker_heartbeats (id, seen_at) VALUES ('vivo', now()), ('caido', now() - interval '2 minutes')`);
    const alive = await insertRunning({ lockedBy: 'vivo', lockedAgo: '20 minutes' });
    const dead = await insertRunning({ lockedBy: 'caido', lockedAgo: '30 seconds' });
    const legacyRecent = await insertRunning({ lockedBy: null, lockedAgo: '1 minute' });
    const legacyOld = await insertRunning({ lockedBy: null, lockedAgo: '11 minutes' });
    expect(await worker({}).recoverStale()).toBe(2);
    expect((await job(alive)).status).toBe('running');
    expect((await job(dead)).status).toBe('queued');
    expect((await job(legacyRecent)).status).toBe('running');
    expect((await job(legacyOld)).status).toBe('queued');
  });

  // On PostgreSQL another live process may own those jobs, so they wait for its heartbeat instead.
  it.skipIf(!!process.env.TEST_DATABASE_URL)('on the embedded database, runs jobs left running by the previous process right after start', async () => {
    await q(`INSERT INTO worker_heartbeats (id, seen_at) VALUES ('anterior', now())`);
    const ran: number[] = [];
    const id = await insertRunning({ type: 'again', lockedBy: 'anterior' });
    await q(`UPDATE jobs SET run_at = now() WHERE id = $1`, [id]);
    const w = worker({ again: async (_c, _p, j) => void ran.push(j.id) });
    w.start();
    await until(() => ran.includes(id));
    await until(async () => (await job(id)).status === 'done');
  });

  it("rides out a database blip during a job's final write, so the contact's next automation still runs", async () => {
    let outage = false;
    const real = env.built.ctx.db;
    const db = new Proxy(real, {
      get: (t, k) => (k === 'query' ? (sql: string, p?: unknown[]) => (outage ? Promise.reject(new Error('Connection terminated unexpectedly')) : t.query(sql, p)) : (t as any)[k]),
    });
    const ran: string[] = [];
    const w = new Worker(
      { ...env.built.ctx, db } as any,
      {
        'automation.inbound': async (_c, p) => {
          ran.push(p.messageId);
          if (p.messageId === 'm1') {
            // The database restarts while the handler runs: its query fails, and so does the first try of the final write.
            outage = true;
            setTimeout(() => (outage = false), 400);
            throw new Error('Connection terminated unexpectedly');
          }
        },
      },
      { pollMs: 20 },
    );
    workers.push(w);
    const contactId = crypto.randomUUID();
    const first = await env.built.ctx.queue.enqueue('automation.inbound', { contactId, messageId: 'm1' });
    w.start();
    await until(() => ran.includes('m1'));
    const second = await env.built.ctx.queue.enqueue('automation.inbound', { contactId, messageId: 'm2' });
    await until(async () => (await job(second)).status === 'done', 5000);
    expect(await job(first)).toMatchObject({ status: 'queued', attempts: 1, locked_by: null });
  });

  it('recovers its own claim whose final write was lost, but not the jobs it is still running', async () => {
    const hang = gate();
    const ran: string[] = [];
    const w = worker({ long: () => hang.promise, auto: async (_c, p) => void ran.push(p.n) });
    const longId = await env.built.ctx.queue.enqueue('long', {});
    w.start();
    await until(async () => (await job(longId))?.status === 'running');
    await q(`UPDATE jobs SET locked_at = now() - interval '5 minutes' WHERE id = $1`, [longId]);
    // Left 'running' by this live worker after its writes failed: it holds the contact's serial key.
    const stranded = (
      await q(
        `INSERT INTO jobs (type, payload, status, locked_at, locked_by, attempts, serial_key)
         VALUES ('auto', '{"n":"viejo"}', 'running', now() - interval '2 minutes', $1, 1, 'contact:q') RETURNING id`,
        [w.id],
      )
    ).rows[0].id;
    const recent = await insertRunning({ type: 'auto', lockedBy: w.id });
    const next = await env.built.ctx.queue.enqueue('auto', { n: 'nuevo' }, { serialKey: 'contact:q' });
    await sleep(100);
    expect(ran).toEqual([]); // blocked behind the stranded claim

    await w.maintenance();
    expect(await job(stranded)).toMatchObject({ status: 'queued', attempts: 1, locked_by: null });
    expect((await job(stranded)).last_error).toMatch(/base de datos/);
    expect((await job(recent)).status).toBe('running'); // too recent to tell from a claim in flight
    expect((await job(longId)).status).toBe('running'); // its handler is still working
    await until(async () => (await job(next)).status === 'done');
    expect(ran).toEqual(['nuevo']);
    hang.open();
  });

  it('stops within its deadline and hands unfinished jobs back to the queue', async () => {
    const hang = gate();
    const w = worker({ long: () => hang.promise });
    const id = await env.built.ctx.queue.enqueue('long', {});
    w.start();
    await until(async () => (await job(id))?.status === 'running');
    const t = Date.now();
    await w.stop(100);
    expect(Date.now() - t).toBeLessThan(1000);
    const j = await job(id);
    expect(j).toMatchObject({ status: 'queued', attempts: 0, locked_by: null });
    expect((await q(`SELECT count(*)::int AS n FROM worker_heartbeats WHERE id = $1`, [w.id])).rows[0].n).toBe(0);
    // The interrupted run finishing late must not mark the requeued job as done.
    hang.open();
    await sleep(30);
    expect((await job(id)).status).toBe('queued');
  });
});
