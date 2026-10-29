import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type TestEnv } from './helpers.js';

let env: TestEnv;
const q = (sql: string, params: unknown[] = []) => env.built.ctx.db.query<any>(sql, params);

beforeAll(async () => {
  env = await setup();
  await env.register('r3-final@test.com', 'Final R3');
});

afterAll(async () => {
  await env?.close();
});

describe('scheduled messages', () => {
  it('two jobs for the same scheduled message never both send it', async () => {
    const ch = await env.api('POST', '/api/channels', { provider: 'sandbox', name: 'Pruebas' });
    const sim = await env.api('POST', `/api/channels/${ch.body.channel.id}/simulate`, { from: '5215511119999', name: 'Doble', text: 'hola' });
    const contactId = sim.body.message.contact_id;
    await env.drain();
    for (let round = 0; round < 5; round++) {
      const r = await env.api('POST', `/api/contacts/${contactId}/scheduled`, {
        send_at: new Date(Date.now() + 3_600_000).toISOString(),
        content: { type: 'text', text: `recordatorio ${round}` },
      });
      expect(r.status).toBe(200);
      const sid = r.body.scheduled.id;
      await q(`UPDATE scheduled_messages SET send_at = now() - interval '1 second' WHERE id = $1`, [sid]);
      // A second job for the same row (a recovered or re-queued one) becomes due with the first.
      await env.built.ctx.queue.enqueue('scheduled.send', { id: sid }, {});
      await q(`UPDATE jobs SET run_at = now() WHERE status = 'queued'`);
      await env.drain();
      const sent = await q(`SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND direction = 'out' AND body = $2`, [contactId, `recordatorio ${round}`]);
      expect(sent.rows[0].n).toBe(1);
      expect((await q(`SELECT status FROM scheduled_messages WHERE id = $1`, [sid])).rows[0].status).toBe('sent');
    }
  });
});
