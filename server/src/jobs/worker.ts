import type { AppContext } from '../context.js';
import type { Job } from './queue.js';

export type JobHandler = (ctx: AppContext, payload: any, job: Job) => Promise<void>;

/**
 * Postgres-backed job runner (no Redis needed). Jobs are claimed with
 * FOR UPDATE SKIP LOCKED so several server instances can share the queue.
 */
export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  private pendingKick = false;
  private lastMaintenance = 0;

  constructor(
    private ctx: AppContext,
    private handlers: Record<string, JobHandler>,
    private opts: { pollMs?: number; batch?: number } = {},
  ) {
    ctx.queue.onEnqueue(() => this.kick());
  }

  start() {
    this.stopped = false;
    this.schedule(0);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 20));
  }

  kick() {
    if (this.stopped) return;
    if (this.running) {
      this.pendingKick = true;
      return;
    }
    this.schedule(0);
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    let processed = 0;
    try {
      processed = await this.runOnce();
      if (Date.now() - this.lastMaintenance > 60_000) await this.maintenance();
    } catch (err) {
      this.ctx.log.error({ err }, 'worker tick failed');
    } finally {
      this.running = false;
      const again = processed > 0 || this.pendingKick;
      this.pendingKick = false;
      this.schedule(again ? 0 : this.opts.pollMs ?? 1000);
    }
  }

  /** Claims and runs one batch of ready jobs. Returns how many ran. */
  async runOnce(): Promise<number> {
    const { rows: jobs } = await this.ctx.db.query<Job>(
      `UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
       WHERE id IN (
         SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now()
         ORDER BY run_at, id LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       RETURNING id, type, payload, attempts, max_attempts, dedupe_key`,
      [this.opts.batch ?? 10],
    );
    await Promise.all(jobs.map((job) => this.runJob(job)));
    return jobs.length;
  }

  /** Test helper: runs ready jobs until none are left (or a safety cap). */
  async drain(maxRounds = 50): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      if ((await this.runOnce()) === 0) return;
    }
  }

  private async runJob(job: Job) {
    const handler = this.handlers[job.type];
    try {
      if (!handler) throw new Error(`No handler for job type ${job.type}`);
      await handler(this.ctx, job.payload, job);
      await this.ctx.db.query(`UPDATE jobs SET status = 'done', finished_at = now(), last_error = NULL WHERE id = $1`, [job.id]);
    } catch (err: any) {
      const message = String(err?.message ?? err).slice(0, 2000);
      const final = job.attempts >= job.max_attempts || err?.retry === false;
      this.ctx.log.warn({ jobId: job.id, type: job.type, attempt: job.attempts, err: message }, 'job failed');
      const backoffSec = Math.min(3600, 5 * 2 ** (job.attempts - 1));
      try {
        await this.ctx.db.query(
          `UPDATE jobs SET status = $2, last_error = $3, locked_at = NULL,
             run_at = now() + ($4 || ' seconds')::interval,
             finished_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END
           WHERE id = $1`,
          [job.id, final ? 'failed' : 'queued', message, String(backoffSec)],
        );
      } catch {
        // A newer queued job with the same dedupe key exists: it supersedes this one.
        await this.ctx.db.query(`UPDATE jobs SET status = 'done', last_error = $2, finished_at = now() WHERE id = $1`, [job.id, message]);
      }
    }
  }

  private async maintenance() {
    this.lastMaintenance = Date.now();
    await this.ctx.db.query(
      `UPDATE jobs SET status = 'queued', locked_at = NULL
       WHERE status = 'running' AND locked_at < now() - interval '10 minutes'
         AND NOT (dedupe_key IS NOT NULL AND EXISTS (
           SELECT 1 FROM jobs j2 WHERE j2.dedupe_key = jobs.dedupe_key AND j2.status = 'queued'))`,
    );
    await this.ctx.db.query(`DELETE FROM jobs WHERE status IN ('done', 'failed') AND finished_at < now() - interval '7 days'`);
  }
}

/** Throw from a handler to fail without retrying. */
export class PermanentJobError extends Error {
  retry = false;
}
