import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Worker, type JobHandler, type WorkerOptions } from '../jobs/worker.js';
import type { ChannelRow } from '../types.js';
import { processInboundMessage } from '../whatsapp/inbound.js';
import { setup, sleep, type TestEnv } from './helpers.js';

// Review round 5, jobs and automation: one test (or more) per finding, each failing without its fix.

let env: TestEnv;
const workers: Worker[] = [];
const ctx = () => env.built.ctx;
const q = (sql: string, params?: unknown[]) => ctx().db.query<any>(sql, params);

beforeAll(async () => {
  env = await setup();
  await env.register('r5jobs@test.com', 'Trabajos R5');
});
afterAll(() => env.close());

function worker(handlers: Record<string, JobHandler>, opts: WorkerOptions = {}) {
  const w = new Worker(ctx(), handlers, { pollMs: 20, ...opts });
  workers.push(w);
  return w;
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

describe('worker', () => {
  afterEach(async () => {
    for (const w of workers.splice(0)) await w.stop(200);
    await q(`DELETE FROM jobs`);
    await q(`DELETE FROM job_wakeups`);
    await q(`DELETE FROM worker_heartbeats`);
  });

  it("keeps a contact's order when the job a crashed process was running is recovered on PostgreSQL (#9)", async () => {
    const queue = ctx().queue;
    const key = 'contact:caida';
    const a = await queue.enqueue('step', { n: 'hola' }, { serialKey: key });
    // The process running it was killed (OOM, docker kill): its heartbeat stopped two minutes ago.
    await q(`INSERT INTO worker_heartbeats (id, seen_at) VALUES ('caido', now() - interval '2 minutes')`);
    await q(`UPDATE jobs SET status = 'running', locked_by = 'caido', locked_at = now() - interval '2 minutes', attempts = 1 WHERE id = $1`, [a]);
    const b = await queue.enqueue('step', { n: '2' }, { serialKey: key });
    expect((await job(b)).held).toBe(true);
    // What maintenance() (and a start on PostgreSQL) does: only the dead instance's jobs.
    expect(await worker({}).recoverStale(false)).toBe(1);
    const recovered = await job(a);
    // The attempt counts (a job that kills the process still runs out of them), but with no backoff:
    // it stays first in its serial key, so the job behind it stays held.
    expect(recovered).toMatchObject({ status: 'queued', attempts: 1, held: false });
    expect(new Date(recovered.run_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect((await job(b)).held).toBe(true);
    const order: string[] = [];
    worker({ step: async (_c, p) => void order.push(p.n) }).start();
    await until(() => order.length === 2);
    expect(order).toEqual(['hola', '2']);
  });

  /** Rows read so far from the queue and its wakeups. */
  const reads = async () => {
    await q(`SELECT pg_stat_force_next_flush()`);
    await q(`SELECT 1`);
    const tables = `relid IN ('jobs'::regclass, 'job_wakeups'::regclass)`;
    const t = (await q(`SELECT COALESCE(sum(seq_tup_read), 0) AS n FROM pg_stat_user_tables WHERE ${tables}`)).rows[0].n;
    const i = (await q(`SELECT COALESCE(sum(idx_tup_read), 0) AS n FROM pg_stat_user_indexes WHERE ${tables}`)).rows[0].n;
    return Number(t) + Number(i);
  };

  // Workspaces whose only jobs are due a year from now (anyone can schedule them), one job each.
  const waiting = (n: number) =>
    q(
      `INSERT INTO jobs (type, payload, run_at, lane, workspace_id)
       SELECT 'scheduled.send', '{}', now() + interval '365 days', 'bulk', gen_random_uuid() FROM generate_series(1, $1::int)`,
      [n],
    );

  it.skipIf(!!process.env.TEST_DATABASE_URL)('claims a ready job without walking the workspaces whose jobs are only due later (#33)', async () => {
    await waiting(20_000);
    const tenant = (await env.register()).workspaceId;
    const due = await ctx().queue.enqueue('scheduled.send', {}, { workspaceId: tenant, lane: 'bulk', delayMs: 0 });
    await q(`ANALYZE jobs, job_wakeups`);
    const ran: number[] = [];
    const w = worker({ 'scheduled.send': async (_c, _p, j) => void ran.push(j.id) }, { lanes: { bulk: { concurrency: 6, perWorkspace: 3 } } });
    let before = await reads();
    await w.runOnce();
    expect(ran).toEqual([due]);
    // Before, the claim read an index entry for each of the 20,000 waiting workspaces (and so did
    // every bulk claim while anything was due), blocking the embedded database's event loop.
    expect((await reads()) - before).toBeLessThan(500);

    // A tenant's wave of scheduled messages (more wakeups than a claim reads) is bounded too.
    await q(
      `INSERT INTO jobs (type, payload, run_at, lane, workspace_id)
       SELECT 'scheduled.send', '{}', now() - interval '1 minute', 'bulk', $1::uuid FROM generate_series(1, 300)`,
      [tenant],
    );
    await q(`ANALYZE jobs, job_wakeups`);
    before = await reads();
    for (let i = 0; i < 3; i++) await w.runOnce();
    expect(ran).toHaveLength(10);
    expect((await reads()) - before).toBeLessThan(3000);
  });

  it("still finds a workspace's ready job behind another workspace's large backlog among many waiting ones (#33)", async () => {
    await waiting(700);
    const backlog = '00000000-0000-4000-8000-000000000001';
    const last = 'ffffffff-ffff-4fff-bfff-ffffffffffff'; // last in workspace order
    await q(
      `INSERT INTO jobs (type, payload, run_at, lane, workspace_id)
       SELECT 'scheduled.send', '{}', now() - interval '10 minutes', 'bulk', $1::uuid FROM generate_series(1, 400)`,
      [backlog],
    );
    const victim = (await q(`INSERT INTO jobs (type, payload, run_at, lane, workspace_id) VALUES ('scheduled.send', '{}', now() - interval '1 second', 'bulk', $1) RETURNING id`, [last])).rows[0].id;
    await q(`ANALYZE jobs, job_wakeups`);
    const ran: number[] = [];
    const w = worker({ 'scheduled.send': async (_c, _p, j) => void ran.push(j.id) }, { lanes: { bulk: { concurrency: 6, perWorkspace: 3 } } });
    // The backlog's wakeups alone fill what one claim reads; the next goes on where it stopped, so
    // the victim is reached within two claims, not after the 400 jobs ahead of it.
    for (let i = 0; i < 2 && !ran.includes(victim); i++) await w.runOnce();
    expect(ran).toContain(victim);
    expect(ran.length).toBeLessThan(10);
  });

  it('reaches every workspace in turn when more of them have ready jobs than one claim reads (#33)', async () => {
    // One account opened 300 workspaces, each with two ready jobs older than another tenant's.
    const owner = await env.register();
    await q(
      `WITH w AS (INSERT INTO workspaces (name) SELECT 'Espacio ' || i FROM generate_series(1, 300) i RETURNING id),
         m AS (INSERT INTO memberships (workspace_id, user_id, role) SELECT id, $1, 'owner' FROM w)
       INSERT INTO jobs (type, payload, run_at, lane, workspace_id)
       SELECT 'scheduled.send', '{}', now() - interval '10 minutes', 'bulk', w.id FROM w, generate_series(1, 2)`,
      [owner.userId],
    );
    const other = (await env.register()).workspaceId;
    const victim = (await q(`INSERT INTO jobs (type, payload, run_at, lane, workspace_id) VALUES ('scheduled.send', '{}', now() - interval '1 second', 'bulk', $1) RETURNING id`, [other])).rows[0].id;
    await q(`ANALYZE jobs, job_wakeups`);
    const order: number[] = [];
    worker({ 'scheduled.send': async (_c, _p, j) => void (await sleep(5), order.push(j.id)) }, { lanes: { bulk: { concurrency: 6, perWorkspace: 3 } } }).start();
    await until(() => order.includes(victim), 10_000);
    // Those workspaces keep their wakeups while they have ready jobs: claims that only read the
    // oldest ones would reach the other tenant after some 250 of the account's jobs.
    expect(order.indexOf(victim)).toBeLessThan(40);
  });

  it('keeps claims cheap behind a backlog at its cap once its wakeups are folded (#33)', async () => {
    const ran: number[] = [];
    const w = worker({ 'scheduled.send': async (_c, _p, j) => void ran.push(j.id) }, { lanes: { bulk: { concurrency: 6, perWorkspace: 3 } } });
    await w.maintenance(); // its 10-minute cleanup is done
    const tenant = crypto.randomUUID();
    await q(
      `INSERT INTO jobs (type, payload, run_at, lane, workspace_id)
       SELECT 'scheduled.send', '{}', now() - interval '1 minute', 'bulk', $1::uuid FROM generate_series(1, 3000)`,
      [tenant],
    );
    // Three of them are running on another instance: the tenant is at its cap.
    await q(`INSERT INTO worker_heartbeats (id, seen_at) VALUES ('otro', now())`);
    await q(
      `UPDATE jobs SET status = 'running', locked_by = 'otro', locked_at = now(), attempts = 1
       WHERE id IN (SELECT id FROM jobs WHERE workspace_id = $1 ORDER BY id LIMIT 3)`,
      [tenant],
    );
    const unowned = await ctx().queue.enqueue('scheduled.send', {}, { lane: 'bulk' });
    await q(`ANALYZE jobs, job_wakeups`);
    await w.runOnce();
    expect(ran).toEqual([unowned]);
    await w.runOnce(); // folds the rest of the backlog's wakeups
    expect(ran).toEqual([unowned]);
    // The next housekeeping (every 15 s) vacuums them on PGlite; on PostgreSQL autovacuum does.
    if (ctx().db.kind === 'pglite') await w.maintenance();
    else await q(`VACUUM job_wakeups`);
    await ctx().queue.enqueue('scheduled.send', {}, { lane: 'bulk' });
    const before = await reads();
    await w.runOnce();
    expect(ran).toHaveLength(2);
    // Without that VACUUM (PGlite runs no autovacuum, and the full one is every 10 minutes) each
    // claim read the 3,000 folded wakeups still in the index.
    expect((await reads()) - before).toBeLessThan(300);
  });

  it('runs every job once with wakeups through retries, serial keys, a run_at moved earlier and two instances (#33)', async () => {
    const spaces = Array.from({ length: 12 }, () => crypto.randomUUID());
    const ran = new Map<number, number>();
    const failed = new Set<number>();
    const handlers: Record<string, JobHandler> = {
      t: async (_c, p, j) => {
        await sleep(Math.random() * 5);
        if (p.fail && !failed.has(j.id)) {
          failed.add(j.id);
          // Back in the queue right away (the retry's backoff is tested elsewhere).
          setTimeout(() => void q(`UPDATE jobs SET run_at = now() WHERE id = $1 AND status = 'queued'`, [j.id]), 50);
          throw new Error('primer intento');
        }
        ran.set(j.id, (ran.get(j.id) ?? 0) + 1);
      },
    };
    const lanes = { bulk: { concurrency: 3, perWorkspace: 2 }, default: { concurrency: 4, perWorkspace: 2 } };
    worker(handlers, { lanes }).start();
    worker(handlers, { lanes }).start();
    const ids: number[] = [];
    await Promise.all(
      [0, 1, 2].map(async (k) => {
        for (let i = 0; i < 100; i++) {
          const r = Math.random();
          const id = await ctx().queue.enqueue(
            't',
            { fail: r < 0.1 },
            {
              workspaceId: spaces[(i + k) % spaces.length],
              lane: i % 2 ? 'bulk' : 'default',
              delayMs: r < 0.3 ? Math.floor(r * 3000) : r < 0.4 ? 3_600_000 : 0,
              serialKey: r > 0.7 ? `contact:${spaces[i % 3]}:${i % 4}` : undefined,
            },
          );
          ids.push(id!);
        }
      }),
    );
    // Jobs due in an hour are pulled in by hand (their wakeup stays an hour away).
    await q(`UPDATE jobs SET run_at = now() WHERE status = 'queued' AND run_at > now() + interval '30 minutes'`);
    await until(async () => (await q(`SELECT count(*)::int AS n FROM jobs WHERE status <> 'done'`)).rows[0].n === 0, 20_000);
    expect(ids.filter((id) => ran.get(id) !== 1)).toEqual([]);
  });

  it('serves a delivery that comes due within a poll behind a backlog at its cap among thousands of waiting workspaces (#33)', async () => {
    // Deliveries in backoff for hours in 4,000 workspaces, and one tenant whose endpoint hangs with
    // 300 deliveries due, older than everyone else's.
    await q(
      `INSERT INTO jobs (type, payload, run_at, lane, workspace_id)
       SELECT 'deliver', '{}', now() + interval '6 hours', 'webhooks', gen_random_uuid() FROM generate_series(1, 4000)`,
    );
    const backlog = '00000000-0000-4000-8000-0000000000aa';
    await q(
      `INSERT INTO jobs (type, payload, run_at, lane, workspace_id)
       SELECT 'deliver', '{"hang":true}', now() - interval '1 minute', 'webhooks', $1::uuid FROM generate_series(1, 300)`,
      [backlog],
    );
    await q(`ANALYZE jobs`);
    let release!: () => void;
    const hanging = new Promise<void>((r) => (release = r));
    let servedAt = 0;
    const w = worker(
      { deliver: async (_c, p) => (p.hang ? hanging : void (servedAt = Date.now())) },
      { pollMs: 1000, lanes: { webhooks: { concurrency: 8, perWorkspace: 3 } } },
    );
    w.start();
    try {
      await until(async () => (await q(`SELECT count(*)::int AS n FROM jobs WHERE status = 'running'`)).rows[0].n === 3);
      // Another tenant's retry comes due now (no enqueue wakes the worker), in the workspace a walk
      // in workspace order reaches last.
      const t0 = Date.now();
      await q(`INSERT INTO jobs (type, payload, run_at, lane, workspace_id) VALUES ('deliver', '{}', now(), 'webhooks', 'ffffffff-ffff-4fff-bfff-ffffffffffff')`);
      // Before, the 300 jobs at their cap filled what a claim peeks at, and the walk over the waiting
      // workspaces reached the victim's 200 per poll: about 20 s here, minutes with more of them.
      await until(() => servedAt > 0, 6000);
      expect(servedAt - t0).toBeLessThan(2500);
    } finally {
      release();
    }
  });
});

describe('menu bot', () => {
  let me: { cookie: string; userId: string; workspaceId: string };
  let channel: ChannelRow;
  const o = () => ({ cookie: me.cookie, ws: me.workspaceId });
  const menuSettings = (menu: unknown, extra: Record<string, unknown> = {}) =>
    env.api(
      'PUT',
      '/api/workspace/settings',
      { automation_mode: 'menu', bot: { menu, fallback: 'No entendí.', handoff_message: 'Te atiende un asesor.', interactive: false, only_unassigned: false, ...extra } },
      o(),
    );
  let seq = 0;
  /** A customer message as Meta delivers it, stamped `agoSec` seconds ago (a late one keeps its old stamp). */
  const deliver = async (from: string, text: string, agoSec = 0) => {
    const msg = { from, id: `wamid.R5J.${++seq}`, timestamp: String(Math.floor(Date.now() / 1000) - agoSec), type: 'text', text: { body: text } };
    const m = await processInboundMessage(ctx(), channel, msg, { wa_id: from, profile: { name: 'Cliente' } });
    await env.drain();
    return (m as any).contact_id as string;
  };
  const outbound = async (contactId: string) =>
    (await q(`SELECT sent_by, body FROM messages WHERE contact_id = $1 AND direction = 'out' ORDER BY created_at`, [contactId])).rows.map(
      (m: any) => `${m.sent_by}:${String(m.body).split('\n')[0]}`,
    );
  const contactRow = async (id: string) =>
    (
      await q(
        `SELECT bot_state, assigned_user_id, stage_id, COALESCE((SELECT json_agg(tag_id) FROM contact_tags WHERE contact_id = contacts.id), '[]') AS tags
         FROM contacts WHERE id = $1`,
        [id],
      )
    ).rows[0];
  /** A teammate in this workspace who receives leads. */
  const teammate = async () => {
    const u = await env.register();
    await q(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'agent')`, [me.workspaceId, u.userId]);
    return u.userId;
  };

  beforeAll(async () => {
    me = await env.register('r5bot@test.com', 'Bot R5');
    const id = (await env.api('POST', '/api/channels', { provider: 'sandbox', name: 'Pruebas' }, o())).body.channel.id;
    channel = (await q(`SELECT * FROM channels WHERE id = $1`, [id])).rows[0];
  });

  it('ignores a typed answer Meta delivers after a newer message the bot already acted on (#18)', async () => {
    const tag = (await env.api('POST', '/api/tags', { name: 'Ya soy cliente' }, o())).body.tag.id;
    const menu = {
      prompt: '¿Qué necesitas?',
      options: [
        { key: '1', label: 'Información', submenu: { prompt: '¿Sobre qué?', options: [{ key: '1', label: 'Precios', reply: 'PRECIOS' }, { key: '2', label: 'Horarios', reply: 'HORARIOS' }] } },
        { key: '2', label: 'Ya soy cliente', reply: 'CLIENTE', tag_ids: [tag], handoff: true },
      ],
    };
    expect((await menuSettings(menu)).status).toBe(200);
    const from = '5215500051801';
    const id = await deliver(from, 'hola', 40);
    await deliver(from, '1', 20);
    expect((await contactRow(id)).bot_state.path).toEqual(['1']);
    // The customer typed "2" (Horarios) at t-5 and then "menu" at t-1; Meta delivers the "2" last.
    await deliver(from, 'menu', 1);
    await deliver(from, '2', 5);
    const chat = (await q(`SELECT body FROM messages WHERE contact_id = $1 AND direction = 'in' ORDER BY created_at`, [id])).rows.map((m: any) => m.body);
    expect(chat).toEqual(['hola', '1', '2', 'menu']); // stored where it belongs in the chat
    // Before, the "2" was read against the main menu: 'CLIENTE', its tag, a handoff and a finished bot.
    expect(await outbound(id)).toEqual(['bot:¿Qué necesitas?', 'bot:¿Sobre qué?', 'bot:¿Qué necesitas?']);
    const c = await contactRow(id);
    expect(c.bot_state).toMatchObject({ path: [] });
    expect(c.bot_state.done).toBeUndefined();
    expect(c.tags).toEqual([]);
    expect(c.assigned_user_id).toBeNull();
    // What the customer writes next is answered as usual.
    await deliver(from, '2');
    expect((await outbound(id)).slice(-1)).toEqual(['bot:CLIENTE']);
    expect((await contactRow(id)).tags).toEqual([tag]);
  });

  it('never starts over in an assigned conversation when it only runs in unassigned ones (#28)', async () => {
    const menu = {
      prompt: 'Elige:',
      options: [
        { key: '1', label: 'Citas', assign_user_id: me.userId, submenu: { prompt: 'Tratamiento:', options: [{ key: 'a', label: 'Ortodoncia', reply: 'Ortodoncia elegida' }] } },
        { key: '2', label: 'Asesor', handoff: true },
      ],
    };
    expect((await menuSettings(menu, { only_unassigned: true })).status).toBe(200);
    // An agent's lead: the bot stays out, and the agent answers from the inbox (it marks the bot done).
    const id = (await env.api('POST', '/api/contacts', { phone: '+5215500052801', name: 'Juan', assigned_user_id: me.userId }, o())).body.contact.id;
    expect(await deliver('5215500052801', 'Hola')).toBe(id);
    expect(await outbound(id)).toEqual([]);
    expect((await env.api('POST', `/api/contacts/${id}/messages`, { type: 'text', text: 'Hola Juan, soy Ana.' }, o())).status).toBe(200);
    expect((await contactRow(id)).bot_state.done).toBe(true);
    // A restaurant customer asking for the "Menú": before, the bot sent its menu into the agent's chat.
    await deliver('5215500052801', 'Menú');
    expect(await outbound(id)).toEqual(['user:Hola Juan, soy Ana.']);
    await deliver('5215500052801', '2');
    expect(await outbound(id)).toEqual(['user:Hola Juan, soy Ana.']);

    // A bot that was mid-menu when its own option assigned the chat still finishes.
    const other = await deliver('5215500052802', 'hola');
    await deliver('5215500052802', '1');
    expect((await contactRow(other)).assigned_user_id).toBe(me.userId);
    await deliver('5215500052802', 'a');
    expect(await outbound(other)).toEqual(['bot:Elige:', 'bot:Tratamiento:', 'bot:Ortodoncia elegida']);
  });

  it('still applies the tags, stage and handoff of an option whose stage was deleted or whose member left (#38)', async () => {
    const funnel = (await env.api('GET', '/api/funnels', undefined, o())).body.funnels[0];
    const gone = (await env.api('POST', `/api/funnels/${funnel.id}/stages`, { name: 'Calificado' }, o())).body.stage.id;
    const kept = (await env.api('POST', `/api/funnels/${funnel.id}/stages`, { name: 'Cliente' }, o())).body.stage.id;
    const tag = (await env.api('POST', '/api/tags', { name: 'Interesado' }, o())).body.tag.id;
    const beto = await teammate();
    const carla = await teammate();
    const menu = {
      prompt: 'Elige:',
      options: [
        { key: '1', label: 'Precios', reply: 'R1', stage_id: gone, tag_ids: [tag] },
        { key: '2', label: 'Ventas', reply: 'R2', stage_id: kept, tag_ids: [tag], assign_user_id: beto },
        { key: '3', label: 'Soporte', reply: 'R3', tag_ids: [tag], assign_user_id: carla },
      ],
    };
    expect((await menuSettings(menu)).status).toBe(200);
    // The admin reorganizes the funnel, deactivates Beto and removes Carla.
    expect((await env.api('DELETE', `/api/stages/${gone}`, undefined, o())).status).toBe(204);
    expect((await env.api('PATCH', `/api/workspace/members/${beto}`, { is_active: false }, o())).status).toBe(200);
    expect((await env.api('DELETE', `/api/workspace/members/${carla}`, undefined, o())).status).toBe(204);

    const pick = async (phone: string, key: string) => {
      const id = await deliver(phone, 'hola');
      const stage = (await contactRow(id)).stage_id;
      await deliver(phone, key);
      return { id, stage, after: await contactRow(id) };
    };
    // Before, one stale reference failed the whole update: no tag, no stage, no assignment.
    const one = await pick('5215500053801', '1');
    expect(one.after.tags).toEqual([tag]);
    expect(one.after.stage_id).toBe(one.stage);
    expect((await outbound(one.id)).slice(-1)).toEqual(['bot:R1']);

    // Never to an inactive (or removed) member: the chat goes to whoever is next in turn.
    const two = await pick('5215500053802', '2');
    expect(two.after).toMatchObject({ tags: [tag], stage_id: kept, assigned_user_id: me.userId });
    const three = await pick('5215500053803', '3');
    expect(three.after).toMatchObject({ tags: [tag], assigned_user_id: me.userId });
  });
});

describe('funnel round-robin', () => {
  let me: { cookie: string; userId: string; workspaceId: string };
  const o = () => ({ cookie: me.cookie, ws: me.workspaceId });
  const member = async (receivesLeads = true) => {
    const u = await env.register();
    await q(`INSERT INTO memberships (workspace_id, user_id, role, receives_leads) VALUES ($1, $2, 'agent', $3)`, [me.workspaceId, u.userId, receivesLeads]);
    return u.userId;
  };
  let phone = 5215500054800;
  const newLead = async () => (await env.api('POST', '/api/contacts', { phone: `+${++phone}`, name: 'Lead' }, o())).body.contact.assigned_user_id as string | null;

  beforeAll(async () => {
    me = await env.register('r5rr@test.com', 'Reparto R5');
  });

  it('assigns among every member when the funnel team has only deactivated or removed members (#37)', async () => {
    const funnel = (await env.api('GET', '/api/funnels', undefined, o())).body.funnels[0];
    const ana = await member();
    const team = (ids: string[]) => env.api('PATCH', `/api/funnels/${funnel.id}`, { auto_assign: true, assignee_ids: ids }, o());
    expect((await team([ana])).status).toBe(200);
    expect(await newLead()).toBe(ana);

    // Ana is deactivated: the settings show no one selected ("everyone takes part"), and before the
    // server matched no one, so every new lead stayed unassigned.
    expect((await env.api('PATCH', `/api/workspace/members/${ana}`, { is_active: false }, o())).status).toBe(200);
    expect(await newLead()).toBe(me.userId);
    // Removed altogether, the same.
    expect((await env.api('DELETE', `/api/workspace/members/${ana}`, undefined, o())).status).toBe(204);
    expect(await newLead()).toBe(me.userId);

    // A team that still has an active member keeps leads to that member.
    const bob = await member();
    expect((await team([ana, bob])).status).toBe(200);
    expect(await newLead()).toBe(bob);
    expect(await newLead()).toBe(bob);
    // Active members of the team who chose not to receive leads still limit the team.
    const eva = await member(false);
    expect((await team([eva])).status).toBe(200);
    expect(await newLead()).toBeNull();
  });
});
