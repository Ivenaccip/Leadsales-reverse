import crypto from 'node:crypto';
import os from 'node:os';
import type { AppContext } from '../context.js';
import { removeStaleMediaTemp } from '../services/media.js';
import { settleStaleSends } from '../services/messages.js';
import { recoverOrphanedScheduled } from '../services/scheduled.js';
import { retryDelaySec, type Job } from './queue.js';

export type JobHandler = (ctx: AppContext, payload: any, job: Job) => Promise<void>;
/** Cleans up after a job failed for good without its handler running (see WorkerOptions.onGiveUp). */
export type GiveUpHandler = (ctx: AppContext, payload: any) => Promise<void>;

export interface LaneOptions {
  /** Jobs of the lane that run at the same time. */
  concurrency: number;
  /** Most slots one workspace may hold at once; claims go first to the accounts, then the workspaces, that used the least slot time lately. */
  perWorkspace?: number;
}

/**
 * Lanes and their slots (see the job policies in queue.ts). Every lane is shared fairly between
 * workspaces, so one tenant's burst only queues behind itself.
 */
export const DEFAULT_LANES: Record<string, LaneOptions> = {
  // Messages and statuses from Meta.
  inbound: { concurrency: 8, perWorkspace: 4 },
  // Automation, AI replies and everything else.
  default: { concurrency: 10, perWorkspace: 5 },
  // Work a tenant starts in bulk: scheduled messages and broadcasts.
  bulk: { concurrency: 6, perWorkspace: 3 },
  // Media downloads stream a file each: a few at a time.
  media: { concurrency: 3, perWorkspace: 2 },
  // Tenant endpoints can be slow or down.
  webhooks: { concurrency: 8, perWorkspace: 3 },
};

export interface WorkerOptions {
  pollMs?: number;
  /** Concurrency of the default lane. */
  batch?: number;
  lanes?: Record<string, LaneOptions>;
  heartbeatMs?: number;
  /** A worker whose heartbeat is older than this is gone: its running jobs are recovered. */
  deadAfterMs?: number;
  /** A handler still running after this long gives its slot back and the job is retried. */
  jobTimeoutMs?: number;
  /** stop() waits this long for running jobs, then hands the unfinished ones back to the queue. */
  shutdownMs?: number;
  /**
   * Per job type: runs when a job is failed for good without its handler (the process died during
   * its last attempt), so the handler's own last-attempt cleanup never ran.
   */
  onGiveUp?: Record<string, GiveUpHandler>;
}

/** A claimed job; `account` is who its slot time is charged to (the owner of its workspace). */
type Claimed = Job & { account?: string };

type Usage = Map<string, { ms: number; at: number }>;

interface Lane {
  name: string;
  opts: LaneOptions;
  running: Map<number, { job: Job; started: number; account: string | null; workspace: string | null }>;
  /** Slot time each account, and each workspace, used in this lane lately (decaying), for fair claims. */
  usage: { account: Usage; workspace: Usage };
  pumping: boolean;
  again: boolean;
  rotate: number;
}

type ClaimedRow = Job & { locked_by?: string | null };

const RETURNING = 'RETURNING id, type, payload, attempts, max_attempts, dedupe_key, workspace_id, serial_key';
const CLAIM_SET = `status = 'running', locked_at = now(), locked_by = $2, attempts = attempts + 1`;
// A job whose serial key is held by a running job waits; within one claim only the oldest job per key is taken.
const SERIAL_FREE = `(j.serial_key IS NULL OR NOT EXISTS (SELECT 1 FROM jobs r WHERE r.serial_key = j.serial_key AND r.status = 'running'))`;
const ONE_PER_SERIAL_KEY = (inner: string) => `SELECT id FROM (
    SELECT c.id, c.serial_key, row_number() OVER (PARTITION BY c.serial_key ORDER BY c.run_at, c.id) AS n FROM ${inner}
  ) x WHERE x.serial_key IS NULL OR x.n = 1`;
// The jobs are picked first, then updated by primary key: with "id IN (...)" the planner joins the
// picks against the whole table (a hash join over a sequential scan) once it expects many of them.
const CLAIM = (inner: string) => `UPDATE jobs SET ${CLAIM_SET} WHERE id = ANY(ARRAY(${ONE_PER_SERIAL_KEY(inner)})) ${RETURNING}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// On PGlite every query resolves without I/O: a worker that never yields would keep HTTP, Socket.IO
// and timers waiting until its whole backlog is done.
const yieldToEventLoop = () => new Promise<void>((r) => setImmediate(r));
// Waits between tries of a job's final write, so a short database blip does not strand the job.
const RECORD_RETRY_MS = [250, 1000, 3000];
const USAGE_HALF_LIFE_MS = 60_000;
const decayed = (u: { ms: number; at: number } | undefined, now: number) => (u ? u.ms * 0.5 ** ((now - u.at) / USAGE_HALF_LIFE_MS) : 0);

/**
 * Postgres-backed job runner (no Redis needed). Every lane keeps a pool of slots and claims a
 * new job as soon as one frees, so a slow job never holds back the others. Jobs are claimed with
 * FOR UPDATE SKIP LOCKED so several server instances can share the queue; each instance writes a
 * heartbeat, and the running jobs of an instance that stops beating are recovered by the others.
 */
export class Worker {
  readonly id = `${os.hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
  private lanes: Lane[];
  private stopped = true;
  private pollTimer: NodeJS.Timeout | null = null;
  private houseTimer: NodeJS.Timeout | null = null;
  private lastBeat = 0;
  private lastCleanup = 0;
  private lastAnalyze = 0;
  /** Jobs whose handler or final write is still in progress in this process. */
  private active = new Set<number>();

  constructor(
    private ctx: AppContext,
    private handlers: Record<string, JobHandler>,
    private opts: WorkerOptions = {},
  ) {
    const lanes = opts.lanes ?? { ...DEFAULT_LANES, default: { ...DEFAULT_LANES.default, concurrency: opts.batch ?? DEFAULT_LANES.default.concurrency } };
    this.lanes = Object.entries(lanes).map(([name, o]) => ({
      name,
      opts: o,
      running: new Map(),
      usage: { account: new Map(), workspace: new Map() },
      pumping: false,
      again: false,
      rotate: 0,
    }));
    ctx.queue.onEnqueue(() => this.kick());
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.boot();
  }

  private async boot() {
    try {
      await this.beat();
      // PGlite is embedded in this process: every job still 'running' was cut off by the last exit.
      // On PostgreSQL only jobs of instances without a fresh heartbeat are taken.
      await this.recoverStale(this.ctx.db.kind === 'pglite');
      await this.refreshJobStats();
    } catch (err) {
      this.ctx.log.error({ err }, 'worker start failed');
    }
    this.scheduleHousekeeping();
    this.schedulePoll(0);
  }

  /** Stops claiming, waits up to `timeoutMs` for running jobs, then returns the unfinished ones to the queue. */
  async stop(timeoutMs = this.opts.shutdownMs ?? 8000): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.houseTimer) clearTimeout(this.houseTimer);
    const deadline = Date.now() + timeoutMs;
    while (this.lanes.some((l) => l.running.size > 0 || l.pumping) && Date.now() < deadline) await sleep(20);
    const left = this.lanes.flatMap((l) => {
      const jobs = [...l.running.values()].map((r) => r.job);
      l.running.clear();
      return jobs;
    });
    for (const job of left) {
      await this.giveBack(job, this.id, { counted: false }).catch((err) => this.ctx.log.error({ err, jobId: job.id }, 'could not requeue job'));
    }
    if (this.lastBeat) {
      // Without our heartbeat, other instances recover anything we could not hand back right away.
      await this.ctx.db.query(`DELETE FROM worker_heartbeats WHERE id = $1`, [this.id]).catch(() => {});
      this.lastBeat = 0;
    }
  }

  kick() {
    if (this.stopped) return;
    for (const lane of this.lanes) void this.pump(lane);
  }

  private schedulePoll(ms: number) {
    if (this.stopped) return;
    this.pollTimer = setTimeout(() => {
      this.kick();
      this.schedulePoll(this.opts.pollMs ?? 1000);
    }, ms);
    this.pollTimer.unref?.();
  }

  private scheduleHousekeeping() {
    if (this.stopped) return;
    this.houseTimer = setTimeout(async () => {
      if (this.stopped) return;
      await this.beat().catch((err) => this.ctx.log.error({ err }, 'worker heartbeat failed'));
      await this.maintenance();
      this.scheduleHousekeeping();
    }, this.opts.heartbeatMs ?? 15_000);
    this.houseTimer.unref?.();
  }

  private async beat() {
    await this.ctx.db.query(
      `INSERT INTO worker_heartbeats (id, seen_at) VALUES ($1, now()) ON CONFLICT (id) DO UPDATE SET seen_at = now()`,
      [this.id],
    );
    this.lastBeat = Date.now();
  }

  /** Fills the free slots of a lane; runs again whenever a job finishes or new work arrives. */
  private async pump(lane: Lane): Promise<void> {
    if (this.stopped) return;
    if (lane.pumping) {
      lane.again = true;
      return;
    }
    lane.pumping = true;
    try {
      do {
        await yieldToEventLoop();
        if (this.stopped) break;
        lane.again = false;
        const free = lane.opts.concurrency - lane.running.size;
        if (free <= 0) break;
        const jobs = await this.claim(lane, free);
        if (this.stopped) {
          for (const job of jobs) await this.giveBack(job, this.id, { counted: false });
          break;
        }
        for (const job of jobs) this.launch(lane, job);
        if (jobs.length) lane.again = true;
      } while (lane.again && !this.stopped);
    } catch (err: any) {
      if (err?.code === '23505') {
        // Another instance claimed a job with the same serial key at the same moment: try again shortly.
        setTimeout(() => void this.pump(lane), 50 + Math.random() * 200).unref?.();
      } else {
        this.ctx.log.error({ err, lane: lane.name }, 'worker claim failed');
      }
    } finally {
      lane.pumping = false;
    }
  }

  private launch(lane: Lane, job: Claimed) {
    const started = Date.now();
    const workspace = job.workspace_id ?? null;
    const account = job.account ?? workspace;
    lane.running.set(job.id, { job, started, account, workspace });
    void this.runJob(job)
      .catch((err) => this.ctx.log.error({ err, jobId: job.id }, 'job bookkeeping failed'))
      .finally(() => {
        lane.running.delete(job.id);
        if (lane.opts.perWorkspace) {
          const now = Date.now();
          for (const [usage, id] of [
            [lane.usage.account, account],
            [lane.usage.workspace, workspace],
          ] as const) {
            if (id) usage.set(id, { ms: decayed(usage.get(id), now) + (now - started), at: now });
          }
        }
        setImmediate(() => void this.pump(lane));
      });
  }

  /** Recent slot time of an account or a workspace in a lane, counting what its running jobs have held so far. */
  private slotTime(lane: Lane, of: 'account' | 'workspace', id: string, now: number): number {
    let ms = decayed(lane.usage[of].get(id), now);
    for (const r of lane.running.values()) if (r[of] === id) ms += now - r.started;
    return ms;
  }

  private async claim(lane: Lane, slots: number): Promise<Claimed[]> {
    if (slots <= 0) return [];
    if (!lane.opts.perWorkspace) return this.claimInOrder(lane.name, slots, false);
    const jobs = await this.claimFair(lane, slots);
    // Jobs without a workspace share whatever is left, in arrival order.
    if (jobs.length < slots) jobs.push(...(await this.claimInOrder(lane.name, slots - jobs.length, true)));
    return jobs;
  }

  private async claimInOrder(lane: string, limit: number, unownedOnly: boolean): Promise<Job[]> {
    const { rows } = await this.ctx.db.query<Job>(
      CLAIM(`(
         SELECT j.id, j.serial_key, j.run_at FROM jobs j
         WHERE j.lane = $1 AND j.status = 'queued' AND NOT j.held AND j.run_at <= now() AND ${SERIAL_FREE}
           ${unownedOnly ? 'AND j.workspace_id IS NULL' : ''}
         ORDER BY j.run_at, j.id LIMIT $3
         FOR UPDATE SKIP LOCKED
       ) c`),
      [lane, this.id, limit],
    );
    return rows;
  }

  /**
   * Shares the free slots between the workspaces with ready jobs, never giving one workspace more
   * than `perWorkspace` running jobs, so one tenant's backlog cannot take the lane. The accounts
   * (owners of the workspaces) that used the least slot time lately go first, and within an account
   * the workspaces that used the least: a tenant whose jobs hang spends its share in seconds, not in
   * jobs, and opening more workspaces does not buy it more of the lane.
   */
  private async claimFair(lane: Lane, slots: number): Promise<Claimed[]> {
    const cap = lane.opts.perWorkspace!;
    // Distinct workspaces with queued jobs, read with one index probe each (loose index scan).
    const { rows: owners } = await this.ctx.db.query<{ id: string; running: number; account: string | null }>(
      `WITH RECURSIVE ws AS (
         (SELECT workspace_id FROM jobs WHERE lane = $1 AND status = 'queued' AND NOT held AND workspace_id IS NOT NULL ORDER BY workspace_id LIMIT 1)
         UNION ALL
         SELECT (SELECT j.workspace_id FROM jobs j
                 WHERE j.lane = $1 AND j.status = 'queued' AND NOT j.held AND j.workspace_id > ws.workspace_id ORDER BY j.workspace_id LIMIT 1)
         FROM ws WHERE ws.workspace_id IS NOT NULL
       )
       SELECT ws.workspace_id AS id,
         (SELECT count(*)::int FROM jobs r WHERE r.lane = $1 AND r.status = 'running' AND r.workspace_id = ws.workspace_id) AS running,
         (SELECT m.user_id::text FROM memberships m WHERE m.workspace_id = ws.workspace_id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1) AS account
       FROM ws
       WHERE ws.workspace_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM jobs j WHERE j.lane = $1 AND j.status = 'queued' AND NOT j.held AND j.workspace_id = ws.workspace_id AND j.run_at <= now())`,
      [lane.name],
    );
    const now = Date.now();
    type Room = { id: string; used: number };
    const accounts = new Map<string, Room & { next: number; workspaces: (Room & { left: number })[] }>();
    const accountOf = new Map<string, string>();
    for (const o of owners) {
      const left = Math.max(0, cap - o.running);
      if (!left) continue;
      const id = o.account ?? o.id;
      accountOf.set(o.id, id);
      let a = accounts.get(id);
      if (!a) accounts.set(id, (a = { id, used: this.slotTime(lane, 'account', id, now), next: 0, workspaces: [] }));
      a.workspaces.push({ id: o.id, left, used: this.slotTime(lane, 'workspace', o.id, now) });
    }
    if (!accounts.size) return [];
    // Least slot time first; rotation breaks ties (the sort is stable).
    const rotation = lane.rotate++;
    const byUse = <T extends Room>(xs: T[]) => {
      const start = rotation % xs.length;
      return [...xs.slice(start), ...xs.slice(0, start)].sort((a, b) => a.used - b.used);
    };
    const order = byUse([...accounts.values()]);
    // Within an account too: one tenant's hanging workspace never outranks its fast siblings
    // (an operator who created every workspace of a closed instance owns them all).
    for (const a of order) a.workspaces = byUse(a.workspaces);
    const quota = new Map<string, number>();
    for (let left = slots, gave = true; left > 0 && gave; ) {
      gave = false;
      for (const a of order) {
        if (left === 0) break;
        // One slot per account and pass, to its workspaces in the same order.
        for (let tries = 0; tries < a.workspaces.length; tries++) {
          const w = a.workspaces[a.next++ % a.workspaces.length];
          const q = quota.get(w.id) ?? 0;
          if (q < w.left) {
            quota.set(w.id, q + 1);
            left--;
            gave = true;
            break;
          }
        }
      }
    }
    const { rows } = await this.ctx.db.query<Job>(
      CLAIM(`unnest($3::uuid[], $4::int[]) AS w(ws, quota)
         CROSS JOIN LATERAL (
           SELECT j.id, j.serial_key, j.run_at FROM jobs j
           WHERE j.lane = $1 AND j.status = 'queued' AND NOT j.held AND j.workspace_id = w.ws AND j.run_at <= now() AND ${SERIAL_FREE}
           ORDER BY j.run_at, j.id LIMIT w.quota
           FOR UPDATE SKIP LOCKED
         ) c`),
      [lane.name, this.id, [...quota.keys()], [...quota.values()]],
    );
    return rows.map((j) => ({ ...j, account: (j.workspace_id && accountOf.get(j.workspace_id)) || undefined }));
  }

  /** Claims and runs one round of ready jobs in every lane, waiting for all of them. Returns how many ran. */
  async runOnce(): Promise<number> {
    if (Date.now() - this.lastBeat > (this.opts.heartbeatMs ?? 15_000)) await this.beat();
    const running: Promise<void>[] = [];
    for (const lane of this.lanes) {
      const jobs = await this.claim(lane, lane.opts.concurrency);
      running.push(...jobs.map((job) => this.runJob(job)));
    }
    await Promise.all(running);
    return running.length;
  }

  /** Test helper: runs ready jobs until none are left (or a safety cap). */
  async drain(maxRounds = 50): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      if ((await this.runOnce()) === 0) return;
    }
  }

  private async runJob(job: Job) {
    const handler = this.handlers[job.type];
    // Every write is conditional on still holding this claim: a job given back to the queue
    // (shutdown, timeout, recovered by another instance) must not be marked by a late finish.
    const owned = `id = $1 AND status = 'running' AND locked_by = $2 AND attempts = $3`;
    const own = [job.id, this.id, job.attempts];
    this.active.add(job.id);
    try {
      let error: any = null;
      try {
        if (!handler) throw new Error(`No handler for job type ${job.type}`);
        await yieldToEventLoop();
        await this.withTimeout(handler(this.ctx, job.payload, job));
      } catch (err) {
        error = err ?? new Error('Error desconocido');
      }
      if (!error) {
        await this.record(`UPDATE jobs SET status = 'done', finished_at = now(), last_error = NULL, locked_at = NULL WHERE ${owned}`, own);
      } else {
        const message = String(error?.message ?? error).slice(0, 2000);
        const final = job.attempts >= job.max_attempts || error?.retry === false;
        this.ctx.log.warn({ jobId: job.id, type: job.type, attempt: job.attempts, err: message }, 'job failed');
        try {
          await this.record(
            `UPDATE jobs SET status = $4, last_error = $5, locked_at = NULL, locked_by = NULL,
               run_at = now() + ($6 || ' seconds')::interval,
               finished_at = CASE WHEN $4 = 'failed' THEN now() ELSE NULL END
             WHERE ${owned}`,
            [...own, final ? 'failed' : 'queued', message, String(retryDelaySec(job.type, job.attempts))],
          );
        } catch (err: any) {
          if (err?.code !== '23505') throw err;
          // A newer queued job with the same dedupe key exists: it supersedes this one.
          await this.record(`UPDATE jobs SET status = 'done', last_error = $4, finished_at = now(), locked_at = NULL WHERE ${owned}`, [...own, message]);
        }
      }
      await this.release(job.serial_key);
    } finally {
      this.active.delete(job.id);
    }
  }

  /**
   * Lets the next job of a serial key through once none of its jobs runs: the earliest queued one
   * stops being held (enqueue holds every job queued behind another one of its key).
   */
  private async release(serialKey: string | null | undefined) {
    if (!serialKey) return;
    try {
      await this.ctx.db.query(
        `UPDATE jobs SET held = false
         WHERE id = (SELECT id FROM jobs WHERE serial_key = $1 AND status = 'queued' ORDER BY run_at, id LIMIT 1)
           AND held AND NOT EXISTS (SELECT 1 FROM jobs WHERE serial_key = $1 AND status = 'running')`,
        [serialKey],
      );
    } catch (err) {
      // maintenance() releases whatever stays held with nothing ahead of it.
      this.ctx.log.warn({ err, serialKey }, 'could not release the next job of a serial key');
    }
  }

  /** Held jobs with nothing queued or running ahead of them (their release was lost to a crash or a database error). */
  private async releaseStranded() {
    await this.ctx.db.query(
      `WITH RECURSIVE k AS (
         (SELECT serial_key FROM jobs WHERE status = 'queued' AND held AND serial_key IS NOT NULL ORDER BY serial_key LIMIT 1)
         UNION ALL
         SELECT (SELECT j.serial_key FROM jobs j
                 WHERE j.status = 'queued' AND j.held AND j.serial_key IS NOT NULL AND j.serial_key > k.serial_key ORDER BY j.serial_key LIMIT 1)
         FROM k WHERE k.serial_key IS NOT NULL
       )
       UPDATE jobs SET held = false
       WHERE held AND id IN (
         SELECT (SELECT f.id FROM jobs f WHERE f.serial_key = k.serial_key AND f.status = 'queued' ORDER BY f.run_at, f.id LIMIT 1)
         FROM k
         WHERE k.serial_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.serial_key = k.serial_key AND r.status = 'running')
       )`,
    );
  }

  /** A job's final write, retried through a short database blip; a claim stranded anyway is recovered by maintenance(). */
  private async record(sql: string, params: unknown[]) {
    for (let i = 0; ; i++) {
      try {
        return await this.ctx.db.query(sql, params);
      } catch (err: any) {
        // A constraint violation is an answer, not a blip.
        if (String(err?.code ?? '').startsWith('23') || i >= RECORD_RETRY_MS.length) throw err;
        await sleep(RECORD_RETRY_MS[i]);
      }
    }
  }

  private withTimeout(p: Promise<void>): Promise<void> {
    const ms = this.opts.jobTimeoutMs ?? 10 * 60_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`El trabajo no terminó en ${Math.round(ms / 1000)} s`)), ms);
      timer.unref?.();
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Returns a claimed job to the queue. `counted: false` (shutdown) undoes the attempt and runs it
   * again right away; otherwise the attempt counts (waiting its backoff unless `now`) and a job out
   * of attempts fails for good, so a job that kills the process cannot crash-loop it forever.
   */
  private async giveBack(
    job: Pick<Job, 'id' | 'type' | 'attempts' | 'max_attempts' | 'serial_key'>,
    owner: string | null,
    o: { counted: boolean; now?: boolean; reason?: string },
  ) {
    const owned = `id = $1 AND status = 'running' AND attempts = $2 AND locked_by IS NOT DISTINCT FROM $3`;
    const p = [job.id, job.attempts, owner];
    try {
      if (o.counted && job.attempts >= job.max_attempts) {
        const failed = await this.ctx.db.query<{ payload: unknown }>(
          `UPDATE jobs SET status = 'failed', finished_at = now(), locked_at = NULL, last_error = $4 WHERE ${owned} RETURNING payload`,
          [...p, o.reason ?? null],
        );
        const onGiveUp = this.opts.onGiveUp?.[job.type];
        if (failed.rows[0] && onGiveUp) {
          await onGiveUp(this.ctx, failed.rows[0].payload).catch((err) => this.ctx.log.error({ err, jobId: job.id }, 'job give-up cleanup failed'));
        }
        return;
      }
      try {
        await this.ctx.db.query(
          `UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL, last_error = COALESCE($4, last_error),
             attempts = attempts - $5, run_at = now() + ($6 || ' seconds')::interval
           WHERE ${owned}`,
          [...p, o.reason ?? null, o.counted ? 0 : 1, String(o.counted && !o.now ? retryDelaySec(job.type, job.attempts) : 0)],
        );
      } catch (err: any) {
        if (err?.code !== '23505') throw err;
        // A queued job with the same dedupe key already exists and will do the work.
        await this.ctx.db.query(`UPDATE jobs SET status = 'done', finished_at = now(), locked_at = NULL, last_error = $4 WHERE ${owned}`, [
          ...p,
          'Reemplazado por un trabajo más reciente con la misma clave',
        ]);
      }
    } finally {
      await this.release(job.serial_key);
    }
  }

  /**
   * Recovers jobs left 'running' by an instance that is gone (no heartbeat for `deadAfterMs`), and
   * this instance's own claims that no handler here holds any more (their final write was lost to a
   * database outage) once they are older than `deadAfterMs`: a stranded claim would otherwise also
   * hold its contact's serial key for as long as this process lives.
   * Rows from before heartbeats existed (no locked_by) use the old 10-minute lock age.
   * `all` takes every job not owned by this worker (embedded database at startup).
   */
  async recoverStale(all = false): Promise<number> {
    const { rows } = await this.ctx.db.query<ClaimedRow>(
      `SELECT id, type, attempts, max_attempts, serial_key, locked_by FROM jobs j
       WHERE status = 'running' AND CASE WHEN locked_by = $1
         THEN NOT (id = ANY($4::bigint[])) AND locked_at < now() - ($3 || ' milliseconds')::interval
         ELSE $2::boolean
           OR (locked_by IS NULL AND locked_at < now() - interval '10 minutes')
           OR (locked_by IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM worker_heartbeats h WHERE h.id = j.locked_by AND h.seen_at > now() - ($3 || ' milliseconds')::interval))
         END
       ORDER BY id LIMIT 500`,
      [this.id, all, String(this.opts.deadAfterMs ?? 60_000), [...this.active]],
    );
    for (const job of rows) {
      const mine = job.locked_by === this.id;
      await this.giveBack(job, job.locked_by ?? null, {
        counted: true,
        // At startup the jobs were most likely cut off by the restart itself: run them again now.
        now: all,
        reason: mine
          ? 'No se pudo guardar el resultado del trabajo por una falla de la base de datos'
          : 'El proceso que ejecutaba el trabajo se detuvo antes de terminarlo',
      });
    }
    return rows.length;
  }

  /** Other instances whose heartbeat is newer than `since` (a database timestamp), else than `deadAfterMs` ago. Never this one. */
  async otherInstances(since?: string): Promise<string[]> {
    const { rows } = await this.ctx.db.query<{ id: string }>(
      `SELECT id FROM worker_heartbeats WHERE id <> $1 AND seen_at > COALESCE($2::timestamptz, now() - ($3 || ' milliseconds')::interval) ORDER BY id`,
      [this.id, since ?? null, String(this.opts.deadAfterMs ?? 60_000)],
    );
    return rows.map((r) => r.id);
  }

  /**
   * Other instances running on this database right now. A run that crashed moments ago also left a
   * fresh heartbeat, so one only counts if it beats again after this check started.
   */
  async liveReplicas(waitMs = (this.opts.heartbeatMs ?? 15_000) + 5_000): Promise<string[]> {
    // As text: a JS Date would drop the microseconds and could count a beat from just before.
    const { rows } = await this.ctx.db.query<{ now: string }>(`SELECT now()::text AS now`);
    if (!(await this.otherInstances()).length) return [];
    await sleep(waitMs);
    return this.otherInstances(rows[0].now);
  }

  /**
   * PGlite runs no autovacuum, so nothing else refreshes the planner's statistics of the queue. With
   * statistics from when it was (nearly) empty, a burst of queued jobs (the statuses of a broadcast,
   * a wave of scheduled messages) makes the planner read the whole backlog on every claim instead of
   * using the per-workspace index. Refreshed at start, after 1000 changes, and each minute with any.
   */
  private async refreshJobStats() {
    if (this.ctx.db.kind !== 'pglite') return;
    if (this.lastAnalyze) {
      const { rows } = await this.ctx.db.query<{ n: number }>(
        `SELECT n_mod_since_analyze::int AS n FROM pg_stat_user_tables WHERE relid = 'jobs'::regclass`,
      );
      const changed = rows[0]?.n ?? 0;
      if (changed < 1000 && !(changed > 0 && Date.now() - this.lastAnalyze > 60_000)) return;
    }
    await this.ctx.db.query(`ANALYZE jobs`);
    this.lastAnalyze = Date.now();
  }

  /**
   * Stale-job recovery, release of stranded serial keys, fresh planner statistics on PGlite and,
   * every 10 minutes, cleanup (old jobs, partial downloads left by a crash) and settlement of what no
   * job will finish: sends Meta never confirmed and scheduled messages whose job died with the
   * process. Each step runs on its own so one failure cannot block the others.
   */
  async maintenance(): Promise<void> {
    try {
      await this.recoverStale();
    } catch (err) {
      this.ctx.log.error({ err }, 'stale job recovery failed');
    }
    try {
      await this.releaseStranded();
    } catch (err) {
      this.ctx.log.error({ err }, 'releasing held jobs failed');
    }
    try {
      await this.refreshJobStats();
    } catch (err) {
      this.ctx.log.error({ err }, 'refreshing job statistics failed');
    }
    const now = Date.now();
    for (const lane of this.lanes) {
      for (const usage of [lane.usage.account, lane.usage.workspace]) for (const [id, u] of usage) if (now - u.at > 10 * USAGE_HALF_LIFE_MS) usage.delete(id);
    }
    if (Date.now() - this.lastCleanup < 10 * 60_000) return;
    this.lastCleanup = Date.now();
    try {
      await this.ctx.db.query(`DELETE FROM jobs WHERE status IN ('done', 'failed') AND finished_at < now() - interval '7 days'`);
      await this.ctx.db.query(`DELETE FROM worker_heartbeats WHERE seen_at < now() - interval '1 day'`);
    } catch (err) {
      this.ctx.log.error({ err }, 'job cleanup failed');
    }
    try {
      await removeStaleMediaTemp(this.ctx);
    } catch (err) {
      this.ctx.log.error({ err }, 'removing leftover downloads failed');
    }
    // Both are idempotent and re-check each row under its lock, so every instance may run them.
    const settle: [string, (ctx: AppContext) => Promise<number>][] = [
      ['stale sends', settleStaleSends],
      ['orphaned scheduled messages', recoverOrphanedScheduled],
    ];
    for (const [what, run] of settle) {
      try {
        const n = await run(this.ctx);
        if (n) this.ctx.log.info({ count: n }, `settled ${what}`);
      } catch (err) {
        this.ctx.log.error({ err }, `settling ${what} failed`);
      }
    }
  }
}

/** Throw from a handler to fail without retrying. */
export class PermanentJobError extends Error {
  retry = false;
}
