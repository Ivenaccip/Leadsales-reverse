import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Worker, type JobHandler, type WorkerOptions } from '../jobs/worker.js';
import { setup, sleep, type TestEnv } from './helpers.js';

// Round 6: fair lanes saturated by backlogs interleaved with each other.

let env: TestEnv;
const workers: Worker[] = [];
const ctx = () => env.built.ctx;
const q = (sql: string, params?: unknown[]) => ctx().db.query<any>(sql, params);
const LANES: WorkerOptions['lanes'] = { webhooks: { concurrency: 8, perWorkspace: 3 } };

beforeAll(async () => {
  env = await setup();
  await env.register('r6-jobs@test.com', 'Fair');
  // Only the workers of each test claim.
  await env.built.worker.stop(100);
});

afterAll(async () => {
  await env?.close();
});

afterEach(async () => {
  for (const w of workers.splice(0)) await w.stop(500);
  await q(`DELETE FROM jobs`);
  await q(`DELETE FROM job_wakeups`);
});

function worker(handlers: Record<string, JobHandler>) {
  const w = new Worker(ctx(), handlers, { pollMs: 50, lanes: LANES });
  workers.push(w);
  return w;
}

async function until(cond: () => Promise<boolean> | boolean, ms = 60_000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(5);
  }
}

/** `n` due jobs in the webhooks lane, taking turns among `workspaces` (as their bursts interleave). */
async function interleaved(n: number, workspaces: string[], payload: object = { a: true }) {
  await q(
    `INSERT INTO jobs (type, payload, run_at, lane, workspace_id)
     SELECT 'deliver', $3, now() - interval '1 minute', 'webhooks', ($2::uuid[])[1 + i % cardinality($2::uuid[])] FROM generate_series(1, $1::int) i`,
    [n, workspaces, JSON.stringify(payload)],
  );
}

describe('a saturated fair lane', () => {
  it('a workspace whose job just became ready gets one of the next freed slots, behind interleaved backlogs', async () => {
    await interleaved(12_000, [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]);
    // Endpoints that hang: each delivery holds its slot until released.
    const gates: (() => void)[] = [];
    let started = 0;
    let victimAfter = -1;
    worker({
      deliver: async (_c, p) => {
        if (!p.a) {
          victimAfter = started;
          return;
        }
        started++;
        await new Promise<void>((r) => gates.push(r));
      },
    }).start();
    await until(() => gates.length === 8);
    const before = started;
    await ctx().queue.enqueue('deliver', {}, { workspaceId: crypto.randomUUID(), lane: 'webhooks' });
    // They time out one at a time, each freeing one slot.
    for (let i = 0; i < 300 && victimAfter < 0; i++) {
      gates.shift()!();
      await until(() => victimAfter >= 0 || gates.length === 8);
    }
    for (const g of gates.splice(0)) g();
    expect(victimAfter).toBeGreaterThanOrEqual(0);
    // Before: about one backlog job per 256 wakeups (12,000 / 256 ≈ 47) went first.
    expect(victimAfter - before).toBeLessThanOrEqual(3);
  });

  it('folding never loses a wakeup: every job runs exactly once while more keep coming', async () => {
    const workspaces = Array.from({ length: 5 }, () => crypto.randomUUID());
    await interleaved(3000, workspaces);
    const runs = new Map<number, number>();
    const handlers: Record<string, JobHandler> = {
      deliver: async (_c, _p, job) => {
        runs.set(job.id, (runs.get(job.id) ?? 0) + 1);
        await sleep(1 + (job.id % 3));
      },
    };
    // Two instances claiming from the same lanes.
    worker(handlers).start();
    worker(handlers).start();
    for (let b = 0; b < 40; b++) {
      for (let i = 0; i < 50; i++) await ctx().queue.enqueue('deliver', { a: true, b, i }, { workspaceId: workspaces[(b + i) % 5], lane: 'webhooks' });
      await sleep(10);
    }
    const total = 3000 + 40 * 50;
    await until(async () => (await q(`SELECT count(*)::int AS n FROM jobs WHERE status = 'done'`)).rows[0].n === total, 120_000);
    expect((await q(`SELECT count(*)::int AS n FROM jobs WHERE status <> 'done'`)).rows[0].n).toBe(0);
    expect(runs.size).toBe(total);
    expect([...runs.values()].every((n) => n === 1)).toBe(true);
  });
});
