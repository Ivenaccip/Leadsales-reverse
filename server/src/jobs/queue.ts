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
  serial_key?: string | null;
}

interface JobPolicy {
  lane?: string;
  maxAttempts?: number;
  /** Floor for maxAttempts, even when the caller passes a lower one. */
  minAttempts?: number;
  /** Wait before retry n (1-based); the last value repeats. */
  retryDelaysSec?: number[];
  serialKey?: (payload: any) => string | undefined;
  /** Where the owning workspace is looked up when the caller passes none: the table, and the payload key holding the row id. */
  owner?: { table: 'messages' | 'scheduled_messages' | 'broadcasts'; key: string };
}

const perContact = (p: any) => (typeof p?.contactId === 'string' ? `contact:${p.contactId}` : undefined);
// A row claimed but not yet linked to its message looks exactly like one whose run died: a second
// job for the same scheduled message (or broadcast) must wait, or both would send it.
const perScheduled = (p: any) => (typeof p?.id === 'string' ? `scheduled:${p.id}` : undefined);
const perBroadcast = (p: any) => (typeof p?.broadcastId === 'string' ? `broadcast:${p.broadcastId}` : undefined);

/**
 * Per-type defaults. Each lane has its own slots, shared fairly between workspaces (see Worker):
 * inbound messages from Meta never wait behind outgoing work, work a tenant starts in bulk
 * (scheduled messages, broadcasts) never holds back automation, media downloads (a file each) run a
 * few at a time, and slow tenant endpoints only hold webhook slots. Deliveries and media downloads
 * retry for hours: receivers restart and Graph has incidents, and Meta keeps media ids valid for 30
 * days. Automation and AI replies of one contact run one at a time (the bot state and "who spoke
 * last" are read, then acted on), and so do the jobs of one scheduled message or broadcast.
 */
const POLICIES: Record<string, JobPolicy> = {
  'wa.webhook': { lane: 'inbound' },
  'webhook.deliver': { lane: 'webhooks', maxAttempts: 12, retryDelaysSec: [30, 120, 300, 900, 1800, 3600, 7200, 14400, 21600, 28800, 43200] },
  'media.download': {
    lane: 'media',
    maxAttempts: 10,
    minAttempts: 10,
    retryDelaysSec: [60, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200],
    owner: { table: 'messages', key: 'messageId' },
  },
  'scheduled.send': { lane: 'bulk', owner: { table: 'scheduled_messages', key: 'id' }, serialKey: perScheduled },
  'broadcast.process': { lane: 'bulk', owner: { table: 'broadcasts', key: 'broadcastId' }, serialKey: perBroadcast },
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
const uuidOrNull = (v: unknown) => (typeof v === 'string' && UUID.test(v) ? v : null);

// jsonb refuses U+0000 anywhere (22P05), and so do text columns; it also refuses a lone UTF-16
// surrogate (22P02), as in a text cut in the middle of an emoji. One in a customer's message or
// profile name would make the job (and every redelivery of that webhook) impossible to store: NUL
// is dropped and a lone surrogate becomes U+FFFD, as text columns already store it.
const UNSTORABLE = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const storable = (s: string) => s.replace(UNSTORABLE, (c) => (c === '\u0000' ? '' : '�'));
const storableStrings = (_key: string, v: unknown) => {
  if (typeof v === 'string') return storable(v);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [storable(k), x]));
  }
  return v;
};

function payloadJson(p: unknown): string {
  const json = JSON.stringify(p);
  // JSON.stringify writes both as escapes (\u0000, \ud83d): only then is the (slower) cleaning pass needed.
  return /\\u(?:0000|d[89a-f])/.test(json) ? JSON.stringify(p, storableStrings) : json;
}

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
    const p = (payload ?? {}) as any;
    const workspaceId = uuidOrNull(opts.workspaceId) ?? uuidOrNull(p.workspaceId);
    const ownerId = !workspaceId && policy.owner ? uuidOrNull(p[policy.owner.key]) : null;
    const owner = ownerId && policy.owner ? `(SELECT o.workspace_id FROM ${policy.owner.table} o WHERE o.id = $10::uuid)` : 'NULL::uuid';
    // run_at comes from the database clock, the one claims compare it with: an app server whose
    // clock is ahead would delay every job, one behind would cut every delay (the AI debounce).
    // A job is held when an earlier job with its serial key is queued or running: claims only see
    // the first job of each key, so a contact's backlog never has to be read past (Worker.release
    // lets the next one through). The jobs it waits for are locked until this insert commits, so
    // none of them can finish, and release nobody, without seeing it.
    const { rows } = await q.query<{ id: number }>(
      `WITH v AS (SELECT COALESCE($3::timestamptz, now() + ($9::bigint * interval '1 millisecond')) AS run_at),
       running AS (
         SELECT r.id FROM jobs r WHERE $7::text IS NOT NULL AND r.serial_key = $7 AND r.status = 'running' FOR SHARE
       ),
       unheld AS (
         SELECT e.id FROM jobs e, v
         WHERE $7::text IS NOT NULL AND e.serial_key = $7 AND e.status = 'queued' AND NOT e.held AND e.run_at <= v.run_at
         FOR SHARE OF e
       ),
       first AS (
         SELECT f.id FROM jobs f, v
         WHERE f.status = 'queued' AND f.run_at <= v.run_at
           AND f.id = (SELECT g.id FROM jobs g WHERE $7::text IS NOT NULL AND g.serial_key = $7 AND g.status = 'queued' ORDER BY g.run_at, g.id LIMIT 1)
         FOR SHARE OF f
       )
       INSERT INTO jobs (type, payload, run_at, max_attempts, dedupe_key, lane, serial_key, workspace_id, held)
       SELECT $1, $2, v.run_at, $4, $5, $6, $7, COALESCE($8::uuid, ${owner}),
         (SELECT count(*) FROM running) + (SELECT count(*) FROM unheld) + (SELECT count(*) FROM first) > 0
       FROM v
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status = 'queued' DO NOTHING
       RETURNING id`,
      [
        type,
        payloadJson(p),
        opts.runAt ?? null,
        Math.max(opts.maxAttempts ?? policy.maxAttempts ?? 5, policy.minAttempts ?? 1),
        opts.dedupeKey ?? null,
        opts.lane ?? policy.lane ?? 'default',
        opts.serialKey ?? policy.serialKey?.(p) ?? null,
        workspaceId,
        String(Math.max(0, Math.round(Number(opts.delayMs) || 0))),
        ...(ownerId ? [ownerId] : []),
      ],
    );
    if (!opts.delayMs && !opts.runAt) this.notify();
    return rows[0]?.id ?? null;
  }
}
