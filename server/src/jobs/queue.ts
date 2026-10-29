import type { Db, Queryable } from '../db/index.js';

export interface EnqueueOptions {
  runAt?: Date;
  delayMs?: number;
  maxAttempts?: number;
  /** Only one queued job per key: later enqueues are ignored while one is waiting. */
  dedupeKey?: string;
  /** Jobs that share a serial key never run at the same time: they are claimed one after another. */
  serialKey?: string;
  /** Worker lane (each lane has its own slots); defaults to the job type's lane. */
  lane?: string;
  /** Tenant that owns the job: lanes can share their slots fairly between workspaces. */
  workspaceId?: string;
}

export interface Job {
  id: number;
  type: string;
  payload: any;
  attempts: number;
  max_attempts: number;
  dedupe_key: string | null;
  workspace_id?: string | null;
}

interface JobPolicy {
  lane?: string;
  maxAttempts?: number;
  /** Floor for maxAttempts, even when the caller passes a lower one. */
  minAttempts?: number;
  /** Wait before retry n (1-based); the last value repeats. */
  retryDelaysSec?: number[];
  serialKey?: (payload: any) => string | undefined;
}

const perContact = (p: any) => (typeof p?.contactId === 'string' ? `contact:${p.contactId}` : undefined);

/**
 * Per-type defaults. Outgoing webhooks run in their own lane so slow tenant endpoints never hold
 * the slots of inbound messages, automation or broadcasts. Deliveries and media downloads retry
 * for hours: receivers restart and Graph has incidents, and Meta keeps media ids valid for 30 days.
 * Automation and AI replies of one contact run one at a time (the bot state and "who spoke last"
 * are read, then acted on).
 */
const POLICIES: Record<string, JobPolicy> = {
  'webhook.deliver': { lane: 'webhooks', maxAttempts: 12, retryDelaysSec: [30, 120, 300, 900, 1800, 3600, 7200, 14400, 21600, 28800, 43200] },
  'media.download': { maxAttempts: 10, minAttempts: 10, retryDelaysSec: [60, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200] },
  'automation.inbound': { serialKey: perContact },
  'ai.reply': { serialKey: perContact },
};

/** Seconds to wait before retrying a job that failed its n-th attempt. */
export function retryDelaySec(type: string, attempt: number): number {
  const delays = POLICIES[type]?.retryDelaysSec;
  if (delays?.length) return delays[Math.min(Math.max(attempt, 1), delays.length) - 1];
  return Math.min(3600, 5 * 2 ** (Math.max(attempt, 1) - 1));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class Queue {
  private listeners: (() => void)[] = [];

  constructor(private db: Db) {}

  onEnqueue(fn: () => void) {
    this.listeners.push(fn);
  }

  /**
   * Wakes the workers. enqueue() does it too, but a job enqueued inside a transaction is not
   * visible to them before COMMIT: call this after it to run the job now instead of at the next poll.
   */
  notify() {
    for (const l of this.listeners) l();
  }

  async enqueue(type: string, payload: unknown, opts: EnqueueOptions = {}, q: Queryable = this.db): Promise<number | null> {
    const policy = POLICIES[type] ?? {};
    const runAt = opts.runAt ?? new Date(Date.now() + (opts.delayMs ?? 0));
    const p = (payload ?? {}) as any;
    const workspaceId = opts.workspaceId ?? (typeof p.workspaceId === 'string' && UUID.test(p.workspaceId) ? p.workspaceId : null);
    const { rows } = await q.query<{ id: number }>(
      `INSERT INTO jobs (type, payload, run_at, max_attempts, dedupe_key, lane, serial_key, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status = 'queued' DO NOTHING
       RETURNING id`,
      [
        type,
        JSON.stringify(p),
        runAt,
        Math.max(opts.maxAttempts ?? policy.maxAttempts ?? 5, policy.minAttempts ?? 1),
        opts.dedupeKey ?? null,
        opts.lane ?? policy.lane ?? 'default',
        opts.serialKey ?? policy.serialKey?.(p) ?? null,
        workspaceId,
      ],
    );
    if (!opts.delayMs && !opts.runAt) this.notify();
    return rows[0]?.id ?? null;
  }
}
