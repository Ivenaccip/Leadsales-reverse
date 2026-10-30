import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Queryable } from '../db/index.js';
import { encryptJson, hmacSha256Hex } from '../lib/crypto.js';
import { launchBroadcast, processBroadcast } from '../services/broadcasts.js';
import { charge, refund } from '../services/credits.js';
import { MAX_MEDIA_LINK, sendMessage } from '../services/messages.js';
import { processScheduled } from '../services/scheduled.js';
import { upsertTemplate } from '../services/templates.js';
import type { ChannelRow, MessageRow } from '../types.js';
import { fakeFetch, setup, type FakeCall, type TestEnv } from './helpers.js';

// Round 5, billing group: broadcasts, sends and the credit ledger.

const PHONE_A = '1098765432155';
const PHONE_B = '1098765432156';
const PHONE_R = '1098765432157';
const WABA_ID = '2223334445555';

type Reply = { status?: number; json?: unknown } | undefined;
let onSend: (call: FakeCall, n: number) => Reply = () => undefined;
let sends = 0;

const meta = fakeFetch([
  (c) => {
    if (!c.url.endsWith('/messages') || c.body?.status === 'read') return undefined;
    sends++;
    return (
      onSend(c, sends) ?? {
        json: { messaging_product: 'whatsapp', contacts: [{ input: c.body.to, wa_id: c.body.to }], messages: [{ id: `wamid.R5.${meta.calls.length}` }] },
      }
    );
  },
]);

const graphError = (code: number, message: string, extra: Record<string, unknown> = {}): Reply => ({
  status: 400,
  json: { error: { message, type: 'OAuthException', code, fbtrace_id: 'Ar5', ...extra } },
});

let env: TestEnv;
let ws: string;
let chA: ChannelRow;
let chB: ChannelRow;

const ctx = () => env.built.ctx;
const q = (sql: string, params: unknown[] = []) => ctx().db.query<any>(sql, params);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cloudChannel(workspaceId: string, phoneId: string, isDefault: boolean, waba = WABA_ID): Promise<ChannelRow> {
  const { rows } = await q(
    `INSERT INTO channels (workspace_id, provider, name, phone_number_id, waba_id, credentials, verify_token, is_default, operator_verified)
     VALUES ($1, 'cloud_api', $2, $2, $3, $4, 'vt-r5', $5, true) RETURNING *`,
    [workspaceId, phoneId, waba, encryptJson(ctx().config.encryptionKey, { accessToken: 'EAAG-test-token', appSecret: `secret-${phoneId}` }), isDefault],
  );
  return rows[0];
}

let phoneSeq = 0;
async function newContact(opts: { cookie?: string; ws?: string } = {}): Promise<string> {
  const r = await env.api('POST', '/api/contacts', { phone: `+52 55 7600 ${String(1000 + ++phoneSeq)}`, name: `Cliente ${phoneSeq}` }, opts);
  expect(r.status).toBe(200);
  return r.body.contact.id;
}

/**
 * Runs `after` once, right after the first statement matching `re` returns, whether it ran on its own
 * or inside a transaction (whose lock it then still holds). Returns the function that undoes the hook.
 */
function afterStatement(re: RegExp, after: () => Promise<void>): () => void {
  const db = ctx().db as any;
  const { query, tx } = db;
  let fired = false;
  const wrap =
    (run: (sql: string, params?: unknown[]) => Promise<any>) =>
    async (sql: string, params?: unknown[]) => {
      const r = await run(sql, params);
      if (!fired && re.test(sql.trim())) {
        fired = true;
        await after();
      }
      return r;
    };
  db.query = wrap(query.bind(db));
  db.tx = (fn: (q: Queryable) => Promise<unknown>) => tx.call(db, (inner: Queryable) => fn({ query: wrap(inner.query.bind(inner)) as Queryable['query'] }));
  return () => {
    db.query = query;
    db.tx = tx;
  };
}

beforeAll(async () => {
  env = await setup({ fetch: meta.fetch });
  ws = (await env.register('r5-cobros@test.com', 'Cobros R5')).workspaceId;
  chA = await cloudChannel(ws, PHONE_A, true);
  chB = await cloudChannel(ws, PHONE_B, false);
  await ctx().db.tx(async (tx) => {
    for (const ch of [chA, chB]) {
      await upsertTemplate(tx, ch, { meta_id: `p${ch.id}`, name: 'promo', language: 'es_MX', category: 'MARKETING', status: 'APPROVED', components: [{ type: 'BODY', text: 'Promo' }] });
      await upsertTemplate(tx, ch, { meta_id: `a${ch.id}`, name: 'aviso', language: 'es_MX', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'BODY', text: 'Aviso' }] });
    }
    await upsertTemplate(tx, chA, {
      meta_id: 'foto',
      name: 'foto',
      language: 'es_MX',
      category: 'MARKETING',
      status: 'APPROVED',
      components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Mira esto' }],
    });
    await upsertTemplate(tx, chA, {
      meta_id: 'factura',
      name: 'factura',
      language: 'es_MX',
      category: 'UTILITY',
      status: 'APPROVED',
      components: [{ type: 'HEADER', format: 'DOCUMENT' }, { type: 'BODY', text: 'Tu factura' }],
    });
  });
});
afterAll(() => env.close());
beforeEach(() => {
  onSend = () => undefined;
});

describe('a launch never starts a draft edited while it was being checked (#6)', () => {
  it('refuses with BROADCAST_CHANGED, and the next launch sends the saved edit', async () => {
    const ids = [await newContact(), await newContact(), await newContact()];
    const created = await env.api('POST', '/api/broadcasts', { name: 'Todos', channel_id: chA.id, template_name: 'promo', template_language: 'es_MX', audience: { contact_ids: ids } });
    expect(created.status).toBe(200);
    const id = created.body.broadcast.id;

    // Another admin saves an edit while this launch estimates the audience it read.
    let edit: { status: number } | null = null;
    const undo = afterStatement(/SELECT c\.phone, c\.wa_id FROM contacts c/, async () => {
      edit = await env.api('PATCH', `/api/broadcasts/${id}`, { channel_id: chB.id, template_name: 'aviso', audience: { contact_ids: [ids[0]] } });
    });
    const err = await launchBroadcast(ctx(), ws, id)
      .catch((e) => e)
      .finally(undo);
    expect(edit!.status).toBe(200);
    expect(err?.code).toBe('BROADCAST_CHANGED');
    const after = (await env.api('GET', `/api/broadcasts/${id}`)).body.broadcast;
    expect(after).toMatchObject({ status: 'draft', channel_id: chB.id, template_name: 'aviso', template_category: 'utility', audience: { contact_ids: [ids[0]] } });
    expect((await q(`SELECT count(*)::int AS n FROM broadcast_recipients WHERE broadcast_id = $1`, [id])).rows[0].n).toBe(0);
    expect((await q(`SELECT count(*)::int AS n FROM jobs WHERE dedupe_key = $1`, [`broadcast:${id}`])).rows[0].n).toBe(0);

    const relaunch = await env.api('POST', `/api/broadcasts/${id}/launch`);
    expect(relaunch.status).toBe(200);
    expect(relaunch.body.broadcast).toMatchObject({ channel_id: chB.id, template_category: 'utility', total_recipients: 1 });
    const before = meta.calls.length;
    await env.drain();
    const out = meta.calls.slice(before).filter((c) => c.url.endsWith('/messages'));
    expect(out).toHaveLength(1);
    expect(out[0].url).toContain(`/${PHONE_B}/messages`);
    expect(out[0].body.template.name).toBe('aviso');
  });
});

describe('a cancel that lands while a run hands its batch back (#7)', () => {
  it('leaves no recipient queued in the cancelled broadcast', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await newContact());
    const created = await env.api('POST', '/api/broadcasts', { name: 'Cancelada', channel_id: chA.id, template_name: 'promo', template_language: 'es_MX', audience: { contact_ids: ids } });
    const id = created.body.broadcast.id;
    await q(`UPDATE broadcasts SET status = 'running', started_at = now() WHERE id = $1`, [id]);
    await q(`INSERT INTO broadcast_recipients (broadcast_id, contact_id) SELECT $1, unnest($2::uuid[])`, [id, ids]);
    // The second send hits an account error: the run pauses and hands its claimed recipients back.
    const first = sends;
    onSend = (_c, n) => (n === first + 2 ? graphError(131042, 'Payment issue') : undefined);

    // The admin cancels right when the run reads the broadcast's status to hand them back.
    let cancel: Promise<{ status: number; body: any }> | null = null;
    const undo = afterStatement(/^SELECT status FROM broadcasts WHERE id = \$1/, async () => {
      cancel = env.api('POST', `/api/broadcasts/${id}/cancel`);
      // Lets the cancel commit here unless the run holds a lock it must wait for.
      await Promise.race([cancel, sleep(1000)]);
    });
    try {
      await processBroadcast(ctx(), { broadcastId: id });
    } finally {
      undo();
    }
    expect(cancel).not.toBeNull();
    expect((await cancel!).body.broadcast.status).toBe('cancelled');
    await env.drain();
    const rec = (await q(`SELECT status, count(*)::int AS n FROM broadcast_recipients WHERE broadcast_id = $1 GROUP BY status ORDER BY status`, [id])).rows;
    expect(rec).toEqual([
      { status: 'sent', n: 1 },
      { status: 'skipped', n: 4 },
    ]);
    expect((await env.api('GET', `/api/broadcasts/${id}`)).body.broadcast.stats.queued).toBe(0);
  });
});

describe('a cancel after a run died mid-batch (#7)', () => {
  async function abandoned(claimedAgo: string) {
    const ids = [await newContact(), await newContact(), await newContact()];
    const created = await env.api('POST', '/api/broadcasts', { name: 'Caída', channel_id: chA.id, template_name: 'promo', template_language: 'es_MX', audience: { contact_ids: ids } });
    const id = created.body.broadcast.id as string;
    await q(`UPDATE broadcasts SET status = 'running', started_at = now() WHERE id = $1`, [id]);
    // A run claimed them and the process died (a restart) before finishing any.
    await q(
      `INSERT INTO broadcast_recipients (broadcast_id, contact_id, status, claimed_at) SELECT $1, unnest($2::uuid[]), 'sending', now() - $3::interval`,
      [id, ids, claimedAgo],
    );
    return { id, ids };
  }
  const recipients = async (id: string) =>
    (await q(`SELECT status, count(*)::int AS n FROM broadcast_recipients WHERE broadcast_id = $1 GROUP BY status ORDER BY status`, [id])).rows;

  it('a claim that already expired is finished by the cancel itself', async () => {
    const { id } = await abandoned('1 hour');
    const r = await env.api('POST', `/api/broadcasts/${id}/cancel`);
    expect(r.status).toBe(200);
    expect(r.body.broadcast.stats.queued).toBe(0);
    expect(await recipients(id)).toEqual([{ status: 'skipped', n: 3 }]);
  });

  it('a fresh one once it expires, ending as its stored message did', async () => {
    const { id, ids } = await abandoned('1 minute');
    // The dead run had sent the first one before it could record it.
    const m = (
      await q(
        `INSERT INTO messages (workspace_id, contact_id, channel_id, direction, type, status, wamid, broadcast_id)
         VALUES ($1, $2, $3, 'out', 'template', 'delivered', 'wamid.R5.DEAD.1', $4) RETURNING id`,
        [ws, ids[0], chA.id, id],
      )
    ).rows[0];
    const r = await env.api('POST', `/api/broadcasts/${id}/cancel`);
    expect(r.body.broadcast.status).toBe('cancelled');
    // Possibly a live run's batch: left to it for now, and looked at again once the claim expires.
    expect(await recipients(id)).toEqual([{ status: 'sending', n: 3 }]);
    const watchdog = (await q(`SELECT run_at > now() + interval '10 minutes' AS later FROM jobs WHERE dedupe_key = $1 AND status = 'queued'`, [`broadcast-watchdog:${id}`])).rows;
    expect(watchdog).toEqual([{ later: true }]);

    await q(`UPDATE broadcast_recipients SET claimed_at = now() - interval '1 hour' WHERE broadcast_id = $1`, [id]);
    await processBroadcast(ctx(), { broadcastId: id }); // that check
    expect(await recipients(id)).toEqual([
      { status: 'sent', n: 1 },
      { status: 'skipped', n: 2 },
    ]);
    expect((await q(`SELECT message_id FROM broadcast_recipients WHERE broadcast_id = $1 AND contact_id = $2`, [id, ids[0]])).rows[0].message_id).toBe(m.id);
    const stats = (await env.api('GET', `/api/broadcasts/${id}`)).body.broadcast.stats;
    expect(stats).toMatchObject({ queued: 0, skipped: 2, delivered: 1 });
    // Nothing left to look at: no further check is queued.
    await q(`DELETE FROM jobs WHERE dedupe_key = $1`, [`broadcast-watchdog:${id}`]);
    await processBroadcast(ctx(), { broadcastId: id });
    expect((await q(`SELECT count(*)::int AS n FROM jobs WHERE dedupe_key = $1`, [`broadcast-watchdog:${id}`])).rows[0].n).toBe(0);
  });
});

describe('replies after the conversation’s number was deleted (#14)', () => {
  let other: { cookie: string; userId: string; workspaceId: string };
  let sandboxId: string;
  let line: ChannelRow;
  let customer: string;
  const as = (w = other) => ({ cookie: w.cookie, ws: w.workspaceId });
  const outbound = async (contactId: string) => (await q(`SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND direction = 'out'`, [contactId])).rows[0].n;
  const boundTo = async (contactId: string) => (await q(`SELECT channel_id FROM contacts WHERE id = $1`, [contactId])).rows[0].channel_id;
  let inSeq = 0;

  /** A customer who wrote an hour ago to a number that was then deleted (what DELETE /api/channels/:id runs). */
  async function orphaned(w: typeof other, phoneId: string, waba: string): Promise<string> {
    const ch = await cloudChannel(w.workspaceId, phoneId, false, waba);
    const id = await newContact(as(w));
    await q(
      `INSERT INTO messages (workspace_id, contact_id, channel_id, direction, type, body, status, wamid, created_at)
       VALUES ($1, $2, $3, 'in', 'text', 'Hola', 'received', $4, now() - interval '1 hour')`,
      [w.workspaceId, id, ch.id, `wamid.R5.IN.${++inSeq}`],
    );
    await q(`UPDATE contacts SET channel_id = $2, last_inbound_at = now() - interval '1 hour', last_message_at = now() - interval '1 hour' WHERE id = $1`, [id, ch.id]);
    await q(`DELETE FROM channels WHERE id = $1`, [ch.id]);
    expect(await boundTo(id)).toBeNull();
    return id;
  }

  beforeAll(async () => {
    other = await env.register('r5-borrado@test.com', 'Número borrado');
    // The sandbox came first, so it is the default number; the business also has another line,
    // connected before the conversation below.
    const sb = await env.api('POST', '/api/channels', { provider: 'sandbox', name: 'Pruebas' }, as());
    expect(sb.status).toBe(200);
    sandboxId = sb.body.channel.id;
    line = await cloudChannel(other.workspaceId, '1098765432160', false, '2223334445560');
    await q(`UPDATE channels SET created_at = now() - interval '1 day' WHERE id = $1`, [line.id]);
    customer = await orphaned(other, PHONE_R, '2223334445558');
  });

  it('an inbox reply or template is refused instead of going out through the default number (the sandbox) or another line', async () => {
    const text = await env.api('POST', `/api/contacts/${customer}/messages`, { type: 'text', text: 'Claro, te ayudo' }, as());
    expect(text.status).toBe(400);
    expect(text.body.error.code).toBe('NO_CHANNEL');
    expect(text.body.error.message).toMatch(/Se eliminó el número de WhatsApp de esta conversación/);
    const tpl = await env.api('POST', `/api/contacts/${customer}/messages`, { type: 'template', name: 'hello_world', language: 'en_US' }, as());
    expect(tpl.status).toBe(400);
    expect(tpl.body.error.code).toBe('NO_CHANNEL');
    expect(await outbound(customer)).toBe(0);
    // Not moved onto the sandbox either.
    expect(await boundTo(customer)).toBeNull();
  });

  it('a scheduled send to it is refused up front, and one scheduled before the deletion fails with that reason', async () => {
    const before = (await q(`SELECT count(*)::int AS n FROM scheduled_messages WHERE contact_id = $1`, [customer])).rows[0].n;
    const r = await env.api(
      'POST',
      `/api/contacts/${customer}/scheduled`,
      { send_at: new Date(Date.now() + 3600_000).toISOString(), content: { type: 'template', name: 'hello_world', language: 'en_US' } },
      as(),
    );
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/Se eliminó el número/);
    expect((await q(`SELECT count(*)::int AS n FROM scheduled_messages WHERE contact_id = $1`, [customer])).rows[0].n).toBe(before);

    const s = (
      await q(
        `INSERT INTO scheduled_messages (workspace_id, contact_id, created_by, content, send_at) VALUES ($1, $2, $3, $4, now() - interval '1 second') RETURNING id`,
        [other.workspaceId, customer, other.userId, JSON.stringify({ type: 'template', name: 'hello_world', language: 'en_US' })],
      )
    ).rows[0];
    await processScheduled(ctx(), { id: s.id });
    const row = (await q(`SELECT status, error FROM scheduled_messages WHERE id = $1`, [s.id])).rows[0];
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/Se eliminó el número/);
    expect(await outbound(customer)).toBe(0);
  });

  it('the number connected again answers it, never the sandbox nor a line that was already there', async () => {
    // The same number, connected again after the deletion: the only number connected since that conversation.
    const again = await orphaned(other, '1098765432161', '2223334445561');
    const back = await cloudChannel(other.workspaceId, '1098765432161', false, '2223334445561');
    await ctx().db.tx((tx) => upsertTemplate(tx, back, { meta_id: 'aviso-back', name: 'aviso', language: 'es_MX', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'BODY', text: 'Aviso' }] }));
    const before = meta.calls.length;
    const r = await env.api('POST', `/api/contacts/${again}/messages`, { type: 'template', name: 'aviso', language: 'es_MX' }, as());
    expect(r.status).toBe(200);
    expect(r.body.message.channel_id).toBe(back.id);
    expect(meta.calls.slice(before).filter((c) => c.url.endsWith('/1098765432161/messages'))).toHaveLength(1);
    expect(await boundTo(again)).toBe(back.id);
  });

  it('with more than one number connected since, nobody picked one: refused', async () => {
    const lost = await orphaned(other, '1098765432162', '2223334445562');
    await cloudChannel(other.workspaceId, '1098765432163', false, '2223334445563');
    await cloudChannel(other.workspaceId, '1098765432164', false, '2223334445564');
    const r = await env.api('POST', `/api/contacts/${lost}/messages`, { type: 'template', name: 'aviso', language: 'es_MX' }, as());
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('NO_CHANNEL');
    expect(r.body.error.message).toMatch(/más de un número/);
    expect(await outbound(lost)).toBe(0);
    expect(await boundTo(lost)).toBeNull();
  });

  it('a number chosen for it, and contacts that never talked, still send', async () => {
    const chosen = await sendMessage(ctx(), { workspaceId: other.workspaceId, contactId: customer, channelId: sandboxId, sentBy: 'user', content: { type: 'text', text: 'Por aquí' } });
    expect(chosen.status).toBe('sent');
    expect(chosen.channel_id).toBe(sandboxId);
    const fresh = await newContact(as());
    const first = await env.api('POST', `/api/contacts/${fresh}/messages`, { type: 'template', name: 'hello_world', language: 'en_US' }, as());
    expect(first.status).toBe(200);
    expect(first.body.message.channel_id).toBe(sandboxId);
  });

  it('a contact its number never bound (a reply typed in the WhatsApp Business app) is answered from that number', async () => {
    const own = await env.register('r5-eco@test.com', 'Eco');
    const phoneId = '1098765432165';
    const waba = '2223334445565';
    const ch = await cloudChannel(own.workspaceId, phoneId, true, waba);
    await ctx().db.tx((tx) => upsertTemplate(tx, ch, { meta_id: 'aviso-eco', name: 'aviso', language: 'es_MX', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'BODY', text: 'Aviso' }] }));
    // Added by hand (or imported): no number yet.
    const c = await env.api('POST', '/api/contacts', { phone: '+57 300 123 4567', name: 'Importado' }, as(own));
    const id = c.body.contact.id;
    expect(c.body.contact.channel_id).toBeNull();
    // The owner writes to it from the phone app, and Meta echoes it: stored on the number, the contact left unbound.
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: waba,
          changes: [
            {
              field: 'smb_message_echoes',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: phoneId },
                message_echoes: [{ from: '525512349914', to: '573001234567', id: 'wamid.R5.ECHO.1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Hola, soy de la tienda' } }],
              },
            },
          ],
        },
      ],
    });
    const hook = await env.built.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${hmacSha256Hex(`secret-${phoneId}`, body)}` },
      payload: body,
    });
    expect(hook.statusCode).toBe(200);
    await env.drain();
    expect((await q(`SELECT channel_id FROM messages WHERE contact_id = $1 AND direction = 'out'`, [id])).rows).toEqual([{ channel_id: ch.id }]);
    // The echo now binds it; earlier versions left it unbound, as contacts stored then still are.
    expect(await boundTo(id)).toBe(ch.id);
    await q(`UPDATE contacts SET channel_id = NULL WHERE id = $1`, [id]);

    const before = meta.calls.length;
    const r = await env.api('POST', `/api/contacts/${id}/messages`, { type: 'template', name: 'aviso', language: 'es_MX' }, as(own));
    expect(r.status).toBe(200);
    expect(r.body.message.channel_id).toBe(ch.id);
    expect(meta.calls.slice(before).filter((x) => x.url.endsWith(`/${phoneId}/messages`))).toHaveLength(1);
    expect(await boundTo(id)).toBe(ch.id);
  });
});

describe('ledger entries follow the order the balance changed in (#20)', () => {
  it('each entry is stamped when its balance changed, not when its transaction began', async () => {
    await q(`UPDATE workspaces SET billing_mode = 'prepaid', credit_balance = 1 WHERE id = $1`, [ws]);
    try {
      await ctx().db.tx(async (tx) => {
        await charge(tx, ws, 0.1, { prepaid: true, description: 'r5-ledger' });
        await tx.query(`SELECT pg_sleep(0.05)`);
        await refund(tx, ws, 0.1, { prepaid: true, description: 'r5-ledger' });
      });
      const rows = (await q(`SELECT kind, balance_after, created_at FROM credit_ledger WHERE workspace_id = $1 AND description = 'r5-ledger' ORDER BY created_at`, [ws])).rows;
      expect(rows.map((r: any) => [r.kind, Number(r.balance_after)])).toEqual([
        ['charge', 0.9],
        ['refund', 1],
      ]);
      expect(new Date(rows[1].created_at).getTime() - new Date(rows[0].created_at).getTime()).toBeGreaterThanOrEqual(40);
    } finally {
      await q(`UPDATE workspaces SET billing_mode = 'meta_direct', credit_balance = 0 WHERE id = $1`, [ws]);
    }
  });

  // PGlite runs one transaction at a time: only PostgreSQL can begin one before another that changes the balance first.
  it.runIf(!!process.env.TEST_DATABASE_URL)('on PostgreSQL, Movimientos adds up when a charge waited on a lock', async () => {
    await q(`UPDATE workspaces SET billing_mode = 'prepaid', credit_balance = 1 WHERE id = $1`, [ws]);
    await q(`DELETE FROM credit_ledger WHERE workspace_id = $1`, [ws]);
    try {
      const a = await newContact();
      const b = await newContact();
      const send = (contactId: string) =>
        sendMessage(ctx(), { workspaceId: ws, contactId, sentBy: 'api', content: { type: 'template', name: 'promo', language: 'es_MX' } });
      // Contact A is busy (e.g. an inbound message being stored): its send begins, then waits.
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const lock = ctx().db.tx(async (tx) => {
        await tx.query(`SELECT id FROM contacts WHERE id = $1 FOR UPDATE`, [a]);
        await held;
      });
      await sleep(50);
      const sendA = send(a);
      await sleep(300);
      await send(b); // begins later, reaches the wallet first
      release();
      await lock;
      await sendA;
      const entries = (await env.api('GET', '/api/credits/ledger')).body.entries as { amount: number; balance_after: number }[];
      expect(entries).toHaveLength(2);
      // Newest first: each balance is the one below it plus its own amount.
      expect(Number(entries[1].balance_after) + Number(entries[0].amount)).toBeCloseTo(Number(entries[0].balance_after), 6);
      expect(Number(entries[0].balance_after)).toBeLessThan(Number(entries[1].balance_after));
    } finally {
      await q(`UPDATE workspaces SET billing_mode = 'meta_direct', credit_balance = 0 WHERE id = $1`, [ws]);
    }
  });
});

describe('outbound sends tell the inboxes where the conversation went (#25)', () => {
  const contactUpdates = (from: number, id: string) =>
    env.built.ctx.realtime.history.slice(from).filter((h) => h.event === 'contact:update' && (h.data as any).id === id).map((h) => h.data as any);

  it('a send emits contact:update with the conversation’s new last message once it is stored', async () => {
    const id = await newContact();
    const start = env.built.ctx.realtime.history.length;
    const r = await env.api('POST', `/api/contacts/${id}/messages`, { type: 'template', name: 'promo', language: 'es_MX' });
    expect(r.status).toBe(200);
    const events = env.built.ctx.realtime.history.slice(start).map((h) => h.event);
    expect(events.indexOf('contact:update')).toBeGreaterThan(events.indexOf('message:new'));
    const [update] = contactUpdates(start, id);
    expect(update.last_message_preview).toBe('Promo');
    expect(update.last_message_at).not.toBeNull();
    expect(update.tag_ids).toEqual([]);
  });

  it('so does a retry that reuses its failed attempt, once it went out', async () => {
    const id = await newContact();
    onSend = () => graphError(130429, 'Rate limit hit');
    const failed = await sendMessage(ctx(), { workspaceId: ws, contactId: id, sentBy: 'scheduled', autoRetry: true, content: { type: 'template', name: 'aviso', language: 'es_MX' } });
    expect(failed.status).toBe('failed');
    onSend = () => undefined;
    const start = env.built.ctx.realtime.history.length;
    const retried = await sendMessage(ctx(), { workspaceId: ws, contactId: id, sentBy: 'scheduled', retryOf: failed.id, content: { type: 'template', name: 'aviso', language: 'es_MX' } });
    expect(retried.id).toBe(failed.id);
    expect(retried.status).toBe('sent');
    const updates = contactUpdates(start, id);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates.at(-1).last_message_preview).toBe('Aviso');
  });
});

describe('header media links and file names are bounded (#35)', () => {
  const long = (n: number) => `https://cdn.example.com/${'a'.repeat(n - 'https://cdn.example.com/'.length)}`;
  const create = (header: unknown, template = 'foto') =>
    env.api('POST', '/api/broadcasts', { name: 'Foto', channel_id: chA.id, template_name: template, template_language: 'es_MX', params: { header }, audience: { contact_ids: [] } });

  it('POST and PATCH refuse a link or file name longer than any real one, or one that is not http(s)', async () => {
    expect((await create({ type: 'image', link: long(MAX_MEDIA_LINK) })).status).toBe(200);
    expect((await create({ type: 'image', link: long(MAX_MEDIA_LINK + 1) })).status).toBe(400);
    expect((await create({ type: 'image', link: 'ftp://cdn.example.com/a.jpg' })).status).toBe(400);
    expect((await create({ type: 'document', link: 'https://cdn.example.com/a.pdf', filename: 'x'.repeat(240) }, 'factura')).status).toBe(200);
    expect((await create({ type: 'document', link: 'https://cdn.example.com/a.pdf', filename: 'x'.repeat(241) }, 'factura')).status).toBe(400);
    const ok = await create({ type: 'image', link: 'https://cdn.example.com/a.jpg' });
    const patch = await env.api('PATCH', `/api/broadcasts/${ok.body.broadcast.id}`, { params: { header: { type: 'image', link: long(5000) } } });
    expect(patch.status).toBe(400);
  });

  it('a media header the template does not have is refused', async () => {
    const r = await create({ type: 'image', link: 'https://cdn.example.com/a.jpg' }, 'promo');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('TEMPLATE_PARAMS_INVALID');
  });

  it('a draft saved before the limit cannot be launched with its huge link', async () => {
    const id = await newContact();
    const ok = await env.api('POST', '/api/broadcasts', {
      name: 'Vieja',
      channel_id: chA.id,
      template_name: 'foto',
      template_language: 'es_MX',
      params: { header: { type: 'image', link: 'https://cdn.example.com/a.jpg' } },
      audience: { contact_ids: [id] },
    });
    await q(`UPDATE broadcasts SET params = $2 WHERE id = $1`, [ok.body.broadcast.id, JSON.stringify({ header: { type: 'image', link: long(100_000) } })]);
    const launch = await env.api('POST', `/api/broadcasts/${ok.body.broadcast.id}/launch`);
    expect(launch.status).toBe(400);
    expect(launch.body.error.code).toBe('TEMPLATE_PARAMS_INVALID');
    expect((await q(`SELECT count(*)::int AS n FROM broadcast_recipients WHERE broadcast_id = $1`, [ok.body.broadcast.id])).rows[0].n).toBe(0);
  });

  it('a scheduled template refuses it before storing anything, as it does an oversized template name', async () => {
    const id = await newContact();
    const stored = async () => (await q(`SELECT count(*)::int AS n FROM scheduled_messages WHERE contact_id = $1`, [id])).rows[0].n;
    const schedule = (content: unknown) => env.api('POST', `/api/contacts/${id}/scheduled`, { send_at: new Date(Date.now() + 86400_000).toISOString(), content });
    const huge = await schedule({ type: 'template', name: 'promo', language: 'es_MX', params: { header: { type: 'image', link: long(MAX_MEDIA_LINK + 1) } } });
    expect(huge.status).toBe(400);
    // Refused by the route's schema now, before the send's own check.
    expect(huge.body.error.code).toBe('VALIDATION');
    const doc = await schedule({ type: 'template', name: 'factura', language: 'es_MX', params: { header: { type: 'document', link: 'https://cdn.example.com/a.pdf', filename: 'x'.repeat(241) } } });
    expect(doc.status).toBe(400);
    const name = await schedule({ type: 'template', name: 'p'.repeat(100_000), language: 'es_MX' });
    expect(name.status).toBe(400);
    expect(await stored()).toBe(0);
    const ok = await schedule({ type: 'template', name: 'foto', language: 'es_MX', params: { header: { type: 'image', link: 'https://cdn.example.com/a.jpg' } } });
    expect(ok.status).toBe(200);
    expect(await stored()).toBe(1);
  });

  it('any other send refuses it before storing anything', async () => {
    const id = await newContact();
    const before = sends;
    const err = await sendMessage(ctx(), {
      workspaceId: ws,
      contactId: id,
      sentBy: 'api',
      content: { type: 'template', name: 'foto', language: 'es_MX', params: { header: { type: 'image', link: long(50_000) } } },
    }).catch((e) => e);
    expect(err?.code).toBe('TEMPLATE_PARAMS_INVALID');
    expect(sends).toBe(before);
    expect((await q(`SELECT count(*)::int AS n FROM messages WHERE contact_id = $1`, [id])).rows[0].n).toBe(0);
  });
});

describe('a number Meta no longer lets this token send from pauses the broadcast (#36)', () => {
  const unreachable = () =>
    graphError(
      100,
      `Unsupported post request. Object with ID '${PHONE_A}' does not exist, cannot be loaded due to missing permissions, or does not support this operation. Please read the Graph API documentation at https://developers.facebook.com/docs/graph-api`,
      { type: 'GraphMethodException', error_subcode: 33 },
    );

  async function run(reply: () => Reply) {
    const ids = [await newContact(), await newContact(), await newContact()];
    const created = await env.api('POST', '/api/broadcasts', { name: 'Mañana', channel_id: chA.id, template_name: 'aviso', template_language: 'es_MX', audience: { contact_ids: ids } });
    const id = created.body.broadcast.id;
    onSend = reply;
    const before = sends;
    expect((await env.api('POST', `/api/broadcasts/${id}/launch`)).status).toBe(200);
    await env.drain();
    const b = (await env.api('GET', `/api/broadcasts/${id}`)).body.broadcast;
    const recipients = (await q(`SELECT status FROM broadcast_recipients WHERE broadcast_id = $1`, [id])).rows.map((r: any) => r.status);
    return { id, b, recipients, sent: sends - before };
  }

  it('code 100 with subcode 33 pauses with the reason and keeps the recipients for the resume', async () => {
    const { id, b, recipients, sent } = await run(unreachable);
    expect(sent).toBe(1);
    expect(b.status).toBe('paused');
    expect(b.last_error).toMatch(/Meta no encuentra este número de WhatsApp o el token ya no tiene acceso/);
    expect(recipients).toEqual(['queued', 'queued', 'queued']);
    const msg = (await q(`SELECT status, error FROM messages WHERE broadcast_id = $1`, [id])).rows[0] as MessageRow;
    expect(msg.status).toBe('failed');
    expect(msg.error).toMatchObject({ code: 100, subcode: 33 });

    // Fixed (the number is reachable again): the resume sends everyone, the first as its failed message.
    onSend = () => undefined;
    expect((await env.api('POST', `/api/broadcasts/${id}/launch`)).status).toBe(200);
    await env.drain();
    const done = (await env.api('GET', `/api/broadcasts/${id}`)).body.broadcast;
    expect(done.status).toBe('completed');
    expect(done.stats.sent).toBe(3);
    expect((await q(`SELECT count(*)::int AS n FROM messages WHERE broadcast_id = $1`, [id])).rows[0].n).toBe(3);
  });

  it('a number whose display name awaits approval (131037) pauses too', async () => {
    const { b, recipients } = await run(() => graphError(131037, 'WhatsApp provided number needs display name approval before message can be sent.'));
    expect(b.status).toBe('paused');
    expect(recipients).toEqual(['queued', 'queued', 'queued']);
  });

  it('code 100 for one recipient’s parameters still fails only that recipient', async () => {
    const { b, recipients, sent } = await run(() => graphError(100, 'Invalid parameter', { error_subcode: 2494010 }));
    expect(sent).toBe(3);
    expect(b.status).toBe('completed');
    expect(recipients).toEqual(['failed', 'failed', 'failed']);
  });
});
