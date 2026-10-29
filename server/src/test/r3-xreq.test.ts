import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Queryable } from '../db/index.js';
import { launchBroadcast } from '../services/broadcasts.js';
import { sendMessage } from '../services/messages.js';
import { syncTemplates } from '../services/templates.js';
import type { ChannelRow, MessageRow } from '../types.js';
import { processWebhook } from '../whatsapp/inbound.js';
import { webhookEnvelope } from '../whatsapp/provider.js';
import { setup, sleep, type TestEnv } from './helpers.js';

// Review round 3, cross-group requests on the server: lock order of sends, template syncs and
// broadcast launches against DELETE /api/channels, idle PostgreSQL connections that drop, audience
// dates in the workspace's time zone, sandbox status jobs owned by their workspace, webhooks that
// yield to the event loop, and the worker's cleanup of downloads a crash cut off.

let env: TestEnv;
let owner: { cookie: string; userId: string; workspaceId: string };
const onPostgres = !!process.env.TEST_DATABASE_URL;

beforeAll(async () => {
  env = await setup();
  owner = await env.register('xreq@test.com');
});
afterAll(async () => env?.close());

const db = () => env.built.ctx.db;

async function sandboxChannel(name = 'Sandbox'): Promise<ChannelRow> {
  const res = await env.api('POST', '/api/channels', { provider: 'sandbox', name }, owner);
  expect(res.status).toBe(200);
  return (await db().query<ChannelRow>(`SELECT * FROM channels WHERE id = $1`, [res.body.channel.id])).rows[0];
}

/** A contact of `channel` whose 24-hour window is open (free text can be sent). */
async function openChat(channel: ChannelRow, phone: string): Promise<string> {
  const c = (await env.api('POST', '/api/contacts', { phone, name: 'Cliente' }, owner)).body.contact;
  await db().query(`UPDATE contacts SET channel_id = $2, last_inbound_at = now() WHERE id = $1`, [c.id, channel.id]);
  return c.id;
}

/**
 * Runs `run` and returns the statements of each transaction it opened, in order. `before` runs
 * first inside every transaction (to change the world under it).
 */
async function txStatements(
  run: () => Promise<unknown>,
  before?: (q: Queryable) => Promise<void>,
  pauseAfter?: { match: RegExp; pause: () => Promise<void> },
): Promise<string[][]> {
  const d = db();
  const original = d.tx;
  const seen: string[][] = [];
  d.tx = ((fn: (q: Queryable) => Promise<unknown>) =>
    original.call(d, async (q: Queryable) => {
      const list: string[] = [];
      seen.push(list);
      if (before) await before(q);
      return fn({
        query: async (sql: string, params?: unknown[]) => {
          list.push(sql.replace(/\s+/g, ' ').trim());
          const res = await q.query(sql, params);
          if (pauseAfter?.match.test(sql)) await pauseAfter.pause();
          return res;
        },
      } as Queryable);
    })) as typeof d.tx;
  try {
    await run();
  } finally {
    d.tx = original;
  }
  return seen;
}

describe('sends lock the channel before the contact (deadlock with DELETE /api/channels)', () => {
  it('takes the channel lock as the first statement of the send transaction', async () => {
    const ch = await sandboxChannel('Orden');
    const contactId = await openChat(ch, '5255001101');
    const txs = await txStatements(() =>
      sendMessage(env.built.ctx, { workspaceId: owner.workspaceId, contactId, channelId: ch.id, content: { type: 'text', text: 'hola' }, sentBy: 'user', userId: owner.userId }),
    );
    const send = txs.find((t) => t.some((s) => s.startsWith('INSERT INTO messages')))!;
    expect(send[0]).toBe('SELECT 1 FROM channels WHERE id = $1 FOR KEY SHARE');
    expect(send[1]).toBe('SELECT id FROM contacts WHERE id = $1 FOR NO KEY UPDATE');
  });

  it('stores nothing when the channel is deleted while the send starts', async () => {
    const ch = await sandboxChannel('Se va');
    const contactId = await openChat(ch, '5255001102');
    let error: any = null;
    await txStatements(
      () =>
        sendMessage(env.built.ctx, { workspaceId: owner.workspaceId, contactId, channelId: ch.id, content: { type: 'text', text: 'hola' }, sentBy: 'user', userId: owner.userId }).catch(
          (err) => (error = err),
        ),
      (q) => q.query(`DELETE FROM channels WHERE id = $1`, [ch.id]).then(() => undefined),
    );
    expect(error?.code).toBe('NO_CHANNEL');
    // The delete ran inside the send's transaction, which rolled back: the channel is back, no message.
    const n = await db().query(`SELECT count(*)::int AS n FROM messages WHERE contact_id = $1`, [contactId]);
    expect(n.rows[0].n).toBe(0);
  });

  it('template sync locks the channel before upserting its templates', async () => {
    const ch = await sandboxChannel('Plantillas');
    const txs = await txStatements(() => syncTemplates(env.built.ctx, ch));
    const sync = txs.find((t) => t.some((s) => s.startsWith('INSERT INTO templates')))!;
    expect(sync[0]).toBe('SELECT 1 FROM channels WHERE id = $1 FOR KEY SHARE');
  });

  // The embedded database runs one transaction at a time, so only PostgreSQL can deadlock.
  it.skipIf(!onPostgres)('a send and a channel delete at the same time both finish (PostgreSQL)', async () => {
    const ch = await sandboxChannel('Carrera');
    const contactId = await openChat(ch, '5255001103');
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    // The precondition runs with the send's locks taken: the delete starts while they are held.
    const send = sendMessage(env.built.ctx, {
      workspaceId: owner.workspaceId,
      contactId,
      channelId: ch.id,
      content: { type: 'text', text: 'hola' },
      sentBy: 'user',
      userId: owner.userId,
      precondition: async () => {
        entered();
        await gate;
      },
    }).then(
      (m) => ({ ok: true as const, m }),
      (err) => ({ ok: false as const, err }),
    );
    await inside;
    const del = env.api('DELETE', `/api/channels/${ch.id}`, undefined, owner);
    for (let i = 0; i < 100; i++) {
      const waiting = await db().query(
        `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'DELETE FROM channels%'`,
      );
      if (waiting.rows[0]) break;
      await sleep(20);
    }
    open();
    const [s, d] = await Promise.all([send, del]);
    expect(s.ok ? null : String((s as any).err?.message)).toBeNull();
    expect(d.status).toBe(204);
    const m = (s as { m: MessageRow }).m;
    const stored = await db().query<MessageRow>(`SELECT * FROM messages WHERE id = $1`, [m.id]);
    expect(stored.rows[0].channel_id).toBeNull(); // ON DELETE SET NULL ran after the send committed
    expect((await db().query(`SELECT 1 FROM channels WHERE id = $1`, [ch.id])).rows).toHaveLength(0);
  });
});

describe('broadcast launches lock the channel before the broadcast (deadlock with DELETE /api/channels)', () => {
  async function draft(ch: ChannelRow, phone: string): Promise<string> {
    const c = (await env.api('POST', '/api/contacts', { phone, name: 'Cliente' }, owner)).body.contact;
    const b = await env.api(
      'POST',
      '/api/broadcasts',
      { name: 'Lanzamiento', channel_id: ch.id, template_name: 'seguimiento', template_language: 'es_MX', params: { body: ['{nombre}'] }, audience: { contact_ids: [c.id] } },
      owner,
    );
    expect(b.status).toBe(200);
    return b.body.broadcast.id;
  }
  const lockBroadcast = /FROM broadcasts WHERE id = \$1 AND workspace_id = \$2 FOR UPDATE/;

  it('takes the channel lock as the first statement of the launch transaction', async () => {
    const ch = await sandboxChannel('Lanzar');
    const id = await draft(ch, '5255001601');
    const txs = await txStatements(() => launchBroadcast(env.built.ctx, owner.workspaceId, id));
    const launch = txs.find((t) => t.some((s) => lockBroadcast.test(s)))!;
    expect(launch[0]).toBe('SELECT 1 FROM channels WHERE id = $1 FOR KEY SHARE');
    expect(launch[1]).toMatch(lockBroadcast);
  });

  it('launches nothing when the channel is deleted as the launch starts', async () => {
    const ch = await sandboxChannel('Se fue');
    const id = await draft(ch, '5255001602');
    let error: any = null;
    await txStatements(
      () => launchBroadcast(env.built.ctx, owner.workspaceId, id).catch((err) => (error = err)),
      (q) => q.query(`DELETE FROM channels WHERE id = $1`, [ch.id]).then(() => undefined),
    );
    expect(error?.code).toBe('NO_CHANNEL');
    const b = await db().query(`SELECT status FROM broadcasts WHERE id = $1`, [id]);
    expect(b.rows[0].status).toBe('draft');
    const r = await db().query(`SELECT count(*)::int AS n FROM broadcast_recipients WHERE broadcast_id = $1`, [id]);
    expect(r.rows[0].n).toBe(0);
  });

  it.skipIf(!onPostgres)('a draft launch and a channel delete at the same time both finish (PostgreSQL)', async () => {
    const ch = await sandboxChannel('Carrera difusión');
    const id = await draft(ch, '5255001603');
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let launch!: Promise<{ status: number }>;
    let del!: Promise<{ status: number }>;
    // The launch stops with the broadcast row locked; the delete starts while it is held.
    const run = txStatements(
      async () => {
        launch = env.api('POST', `/api/broadcasts/${id}/launch`, undefined, owner);
        await inside;
        del = env.api('DELETE', `/api/channels/${ch.id}`, undefined, owner);
        for (let i = 0; i < 100; i++) {
          const waiting = await db().query(
            `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'DELETE FROM channels%'`,
          );
          if (waiting.rows[0]) break;
          await sleep(20);
        }
        open();
        await Promise.all([launch, del]);
      },
      undefined,
      {
        match: lockBroadcast,
        pause: async () => {
          entered();
          await gate;
        },
      },
    );
    await run;
    expect((await launch).status).toBe(200);
    expect((await del).status).toBe(204);
    const b = await db().query(`SELECT status, channel_id FROM broadcasts WHERE id = $1`, [id]);
    expect(b.rows[0]).toEqual({ status: 'running', channel_id: null }); // ON DELETE SET NULL ran after the launch committed
    const r = await db().query(`SELECT count(*)::int AS n FROM broadcast_recipients WHERE broadcast_id = $1`, [id]);
    expect(r.rows[0].n).toBe(1);
  });
});

describe('database connections', () => {
  // Without a listener on the pool, the dropped connection's error ends the process (vitest reports
  // it as an unhandled error and fails the run).
  it.skipIf(!onPostgres)('an idle connection the database drops (restart, failover) is replaced quietly (PostgreSQL)', async () => {
    await Promise.all(Array.from({ length: 3 }, () => db().query(`SELECT pg_sleep(0.05)`)));
    const killer = await import('pg').then((pg) => new pg.default.Client({ connectionString: process.env.TEST_DATABASE_URL }));
    await killer.connect();
    try {
      const { rows: name } = await db().query<{ db: string }>(`SELECT current_database() AS db`);
      const killed = await killer.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND state = 'idle' AND backend_type = 'client backend'`,
        [name[0].db],
      );
      expect(killed.rows.length).toBeGreaterThan(0);
    } finally {
      await killer.end();
    }
    await sleep(200);
    const { rows } = await db().query<{ ok: number }>(`SELECT 1 AS ok`);
    expect(rows[0].ok).toBe(1);
  });
});

describe('broadcast audience dates are calendar days of the workspace time zone', () => {
  it('reads created_from/created_to in America/Mexico_City, estimate and launch alike', async () => {
    const ch = await sandboxChannel('Difusiones');
    expect((await env.api('PATCH', '/api/workspace', { timezone: 'America/Mexico_City' }, owner)).status).toBe(200);
    const c = (await env.api('POST', '/api/contacts', { phone: '5255001201', name: 'Tarde' }, owner)).body.contact;
    // 2026-10-28 20:00 in Mexico City is already the 29th in UTC.
    await db().query(`UPDATE contacts SET created_at = '2026-10-29T02:00:00Z' WHERE id = $1`, [c.id]);
    const estimate = async (audience: Record<string, unknown>) => {
      const res = await env.api(
        'POST',
        '/api/broadcasts/estimate',
        { channel_id: ch.id, template_name: 'seguimiento', template_language: 'es_MX', audience: { contact_ids: [c.id], ...audience } },
        owner,
      );
      expect(res.status).toBe(200);
      return res.body.estimate.recipients;
    };
    expect(await estimate({ created_from: '2026-10-29' })).toBe(0);
    expect(await estimate({ created_from: '2026-10-28' })).toBe(1);
    expect(await estimate({ created_to: '2026-10-28' })).toBe(1);
    expect(await estimate({ created_to: '2026-10-27' })).toBe(0);

    const b = await env.api(
      'POST',
      '/api/broadcasts',
      {
        name: 'Ayer',
        channel_id: ch.id,
        template_name: 'seguimiento',
        template_language: 'es_MX',
        params: { body: ['{nombre}'] },
        audience: { contact_ids: [c.id], created_from: '2026-10-28', created_to: '2026-10-28' },
      },
      owner,
    );
    expect(b.status).toBe(200);
    expect(b.body.broadcast.total_recipients).toBe(1);
    const launched = await env.api('POST', `/api/broadcasts/${b.body.broadcast.id}/launch`, undefined, owner);
    expect(launched.status).toBe(200);
    const r = await db().query(`SELECT contact_id FROM broadcast_recipients WHERE broadcast_id = $1`, [b.body.broadcast.id]);
    expect(r.rows.map((x: any) => x.contact_id)).toEqual([c.id]);
  });

  it('refuses audience dates that are not calendar days', async () => {
    const ch = await sandboxChannel('Fechas');
    for (const created_from of ['2026-10-29T00:00:00Z', '2026-02-30', 'ayer']) {
      const res = await env.api(
        'POST',
        '/api/broadcasts/estimate',
        { channel_id: ch.id, template_name: 'seguimiento', template_language: 'es_MX', audience: { created_from } },
        owner,
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    }
  });
});

describe('sandbox status webhooks', () => {
  it('queues the simulated statuses as jobs of the workspace (fair inbound lane)', async () => {
    const ch = await sandboxChannel('Estados');
    const contactId = await openChat(ch, '5255001301');
    await db().query(`DELETE FROM jobs WHERE type = 'wa.webhook'`);
    await sendMessage(env.built.ctx, { workspaceId: owner.workspaceId, contactId, channelId: ch.id, content: { type: 'text', text: 'hola' }, sentBy: 'user', userId: owner.userId });
    const jobs = await db().query(`SELECT workspace_id, lane FROM jobs WHERE type = 'wa.webhook'`);
    expect(jobs.rows.length).toBe(3);
    for (const j of jobs.rows) expect(j).toEqual({ workspace_id: owner.workspaceId, lane: 'inbound' });
  });
});

describe('one webhook with many items', () => {
  it('lets the event loop run between its messages and between its statuses', async () => {
    const ch = await sandboxChannel('Lote');
    const n = 12;
    const ts = String(Math.floor(Date.now() / 1000));
    const messages = Array.from({ length: n }, (_, i) => ({ from: `52550014${String(i).padStart(2, '0')}`, id: `wamid.LOTE.${i}`, timestamp: ts, type: 'text', text: { body: `hola ${i}` } }));
    const contacts = messages.map((m) => ({ wa_id: m.from, profile: { name: 'Lote' } }));
    const statuses = Array.from({ length: n }, (_, i) => ({ id: `wamid.NOEXISTE.${i}`, status: 'delivered', timestamp: '1', recipient_id: '5255001400' }));

    // Counts the turns other work (HTTP, Socket.IO, timers) gets while the webhook is processed.
    const turnsDuring = async (body: unknown) => {
      let done = false;
      let turns = 0;
      const tick = () => {
        if (done) return;
        turns++;
        setImmediate(tick);
      };
      setImmediate(tick);
      await processWebhook(env.built.ctx, body, undefined, [ch.id], [ch.id]);
      done = true;
      return turns;
    };
    expect(await turnsDuring(webhookEnvelope(ch, { messages, contacts }))).toBeGreaterThanOrEqual(n - 1);
    expect(await turnsDuring(webhookEnvelope(ch, { statuses }))).toBeGreaterThanOrEqual(n - 1);
    const stored = await db().query(`SELECT count(*)::int AS n FROM messages WHERE wamid LIKE 'wamid.LOTE.%'`);
    expect(stored.rows[0].n).toBe(n);

    // Many changes with one message each: the turns come between the changes.
    const spread = webhookEnvelope(ch, { messages: [], contacts: [] });
    spread.entry[0].changes = messages.map((m, i) => ({
      ...webhookEnvelope(ch, { messages: [{ ...m, id: `wamid.CAMBIO.${i}` }], contacts: [contacts[i]] }).entry[0].changes[0],
    }));
    expect(await turnsDuring(spread)).toBeGreaterThanOrEqual(n - 1);
    const spreadStored = await db().query(`SELECT count(*)::int AS n FROM messages WHERE wamid LIKE 'wamid.CAMBIO.%'`);
    expect(spreadStored.rows[0].n).toBe(n);
  });
});

describe('worker cleanup after a crash', () => {
  async function imageMessage(channel: ChannelRow, phone: string): Promise<string> {
    const contactId = await openChat(channel, phone);
    const { rows } = await db().query<{ id: string }>(
      `INSERT INTO messages (workspace_id, contact_id, channel_id, direction, type, media, status, sent_by)
       VALUES ($1, $2, $3, 'in', 'image', '{"wa_media_id": "media-1", "mime": "image/jpeg"}', 'received', 'contact') RETURNING id`,
      [owner.workspaceId, contactId, channel.id],
    );
    return rows[0].id;
  }

  /** A media.download job left 'running' by an instance that died (no heartbeat) on attempt `attempt`. */
  async function orphanedDownload(messageId: string, attempt: 'last' | 'first') {
    const id = await env.built.ctx.queue.enqueue('media.download', { messageId }, { workspaceId: owner.workspaceId });
    await db().query(
      `UPDATE jobs SET status = 'running', attempts = CASE WHEN $2 THEN max_attempts ELSE 1 END, locked_by = 'gone:1:dead', locked_at = now() - interval '1 hour'
       WHERE id = $1`,
      [id, attempt === 'last'],
    );
    return id;
  }

  it('a download cut off on its last attempt tells the chat why the file never came', async () => {
    const ch = await sandboxChannel('Descargas');
    const last = await imageMessage(ch, '5255001501');
    const first = await imageMessage(ch, '5255001502');
    const lastJob = await orphanedDownload(last, 'last');
    const firstJob = await orphanedDownload(first, 'first');
    await env.built.worker.recoverStale();

    const jobs = await db().query(`SELECT id, status FROM jobs WHERE id = ANY($1::bigint[]) ORDER BY id`, [[lastJob, firstJob]]);
    expect(jobs.rows.map((j: any) => j.status)).toEqual(['failed', 'queued']);
    const m = await db().query<MessageRow>(`SELECT id, media FROM messages WHERE id = ANY($1::uuid[])`, [[last, first]]);
    const byId = new Map(m.rows.map((r) => [r.id, r.media]));
    expect(byId.get(last)?.download_error).toBe('La descarga se interrumpió varias veces porque el servidor se reinició');
    expect(byId.get(first)?.download_error).toBeUndefined(); // it will be retried
    expect(env.built.ctx.realtime.history.some((h) => h.event === 'message:update' && (h.data as MessageRow).id === last)).toBe(true);
  });

  it('keeps the reason a last attempt stored itself when only its final write was lost', async () => {
    const ch = await sandboxChannel('Descargas 2');
    const msg = await imageMessage(ch, '5255001503');
    await db().query(`UPDATE messages SET media = media || '{"download_error": "El archivo ya no está disponible en WhatsApp"}' WHERE id = $1`, [msg]);
    await orphanedDownload(msg, 'last');
    await env.built.worker.recoverStale();
    const m = await db().query<MessageRow>(`SELECT media FROM messages WHERE id = $1`, [msg]);
    expect(m.rows[0].media?.download_error).toBe('El archivo ya no está disponible en WhatsApp');
  });

  it('periodic maintenance deletes partial downloads older than an hour', async () => {
    const dir = path.join(env.config.dataDir, 'media', '.tmp');
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'viejo.part');
    const fresh = path.join(dir, 'nuevo.part');
    const other = path.join(dir, 'otro.txt');
    for (const f of [old, fresh, other]) fs.writeFileSync(f, 'x');
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    fs.utimesSync(old, twoHoursAgo, twoHoursAgo);
    fs.utimesSync(other, twoHoursAgo, twoHoursAgo);
    (env.built.worker as any).lastCleanup = 0; // the cleanup runs every 10 minutes
    await env.built.worker.maintenance();
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
  });
});
