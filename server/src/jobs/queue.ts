import type { Db, Queryable } from '../db/index.js';

export interface EnqueueOptions {
  runAt?: Date;
  delayMs?: number;
  maxAttempts?: number;
  /** Only one queued job per key: later enqueues are ignored while one is waiting. */
  dedupeKey?: string;
}

export interface Job {
  id: number;
  type: string;
  payload: any;
  attempts: number;
  max_attempts: number;
  dedupe_key: string | null;
}

export class Queue {
  private listeners: (() => void)[] = [];

  constructor(private db: Db) {}

  onEnqueue(fn: () => void) {
    this.listeners.push(fn);
  }

  async enqueue(type: string, payload: unknown, opts: EnqueueOptions = {}, q: Queryable = this.db): Promise<number | null> {
    const runAt = opts.runAt ?? new Date(Date.now() + (opts.delayMs ?? 0));
    const { rows } = await q.query<{ id: number }>(
      `INSERT INTO jobs (type, payload, run_at, max_attempts, dedupe_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status = 'queued' DO NOTHING
       RETURNING id`,
      [type, JSON.stringify(payload ?? {}), runAt, opts.maxAttempts ?? 5, opts.dedupeKey ?? null],
    );
    if (!opts.delayMs && !opts.runAt) for (const l of this.listeners) l();
    return rows[0]?.id ?? null;
  }
}
