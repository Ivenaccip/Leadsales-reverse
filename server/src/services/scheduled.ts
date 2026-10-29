import type { AppContext } from '../context.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import type { MessageRow } from '../types.js';
import { isMetaThrottle } from '../whatsapp/types.js';
import { renderTemplateParams, withRetryNote } from './broadcasts.js';
import { getContact } from './contacts.js';
import { abandonAutoRetry, isAwaitingRetry, isNetworkFailure, manualRetryText, sendMessage, type SendContent } from './messages.js';

export interface ScheduledRow {
  id: string;
  workspace_id: string;
  contact_id: string;
  created_by: string | null;
  content: SendContent;
  send_at: Date;
  status: string;
  message_id: string | null;
  error: string | null;
  created_at: Date;
}

/** Rate-limited sends, and sends that never reached Meta, are retried this many times (spaced out) before the row is marked failed. */
const MAX_THROTTLE_RETRIES = 5;

const INTERNAL_ERROR = 'No se pudo enviar por un error interno. Prográmalo de nuevo.';

export async function scheduleMessage(
  ctx: AppContext,
  workspaceId: string,
  contactId: string,
  userId: string,
  content: SendContent,
  sendAt: Date,
): Promise<ScheduledRow> {
  await getContact(ctx.db, workspaceId, contactId);
  if (Number.isNaN(sendAt.getTime()) || sendAt.getTime() < Date.now() - 60_000) throw badRequest('La fecha de envío debe ser futura');
  // Row and job are stored together: a pending row without a job is an orphan (recoverOrphanedScheduled).
  return ctx.db.tx(async (q) => {
    const { rows } = await q.query<ScheduledRow>(
      `INSERT INTO scheduled_messages (workspace_id, contact_id, created_by, content, send_at) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [workspaceId, contactId, userId, JSON.stringify(content), sendAt],
    );
    await ctx.queue.enqueue('scheduled.send', { id: rows[0].id }, { runAt: sendAt, maxAttempts: 3 }, q);
    return rows[0];
  });
}

function notify(ctx: AppContext, s: Pick<ScheduledRow, 'id' | 'workspace_id' | 'contact_id'>, status: string, error: string | null = null) {
  ctx.realtime.emit(s.workspace_id, 'scheduled:update', { id: s.id, contact_id: s.contact_id, status, ...(error ? { error } : {}) });
}

/** Cancels a pending message, or dismisses a failed one from the contact panel. */
export async function cancelScheduled(ctx: AppContext, workspaceId: string, id: string): Promise<void> {
  const { rows } = await ctx.db.query<ScheduledRow>(
    `UPDATE scheduled_messages SET status = 'cancelled' WHERE id = $1 AND workspace_id = $2 AND status IN ('pending', 'failed') RETURNING *`,
    [id, workspaceId],
  );
  // A pending row linked to a message is waiting to retry it: that message will not be retried now.
  if (rows[0]?.message_id) await abandonAutoRetry(ctx, { messageId: rows[0].message_id });
  if (!rows[0]) {
    const cur = await ctx.db.query<{ status: string }>(`SELECT status FROM scheduled_messages WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]);
    if (cur.rows[0]?.status === 'sending') {
      throw new AppError(409, 'SCHEDULED_SENDING', 'El mensaje ya se está enviando y no se puede cancelar.');
    }
    throw notFound('Mensaje programado pendiente');
  }
  notify(ctx, rows[0], 'cancelled');
}

/** Records the outcome of the send and tells the contact panel. Only the run holding the claim may finish it. */
async function finish(ctx: AppContext, s: ScheduledRow, status: 'sent' | 'failed', messageId: string | null, error: string | null) {
  const { rows } = await ctx.db.query<{ message_id: string | null }>(
    `UPDATE scheduled_messages SET status = $2, message_id = COALESCE($3, message_id), error = $4 WHERE id = $1 AND status = 'sending' RETURNING message_id`,
    [s.id, status, messageId, error],
  );
  if (!rows[0]) return;
  // Failed for good: an earlier attempt's message that said it would be retried will not be.
  if (status === 'failed' && rows[0].message_id) await abandonAutoRetry(ctx, { messageId: rows[0].message_id });
  notify(ctx, s, status, error);
}

function outcome(msg: Pick<MessageRow, 'status' | 'error' | 'wamid'>): { status: 'sent' | 'failed'; error: string | null } {
  // An attempt that was waiting for a retry no run will make now.
  if (isAwaitingRetry(msg)) return { status: 'failed', error: manualRetryText(msg.error) };
  if (msg.status === 'failed') return { status: 'failed', error: msg.error?.message ?? 'Meta rechazó el mensaje' };
  // 'unknown' (Meta may have it) and 'pending' (a run died mid-send) are never resent automatically.
  if (msg.status === 'unknown' || msg.status === 'pending') {
    return { status: 'sent', error: msg.error?.message ?? 'No pudimos confirmar el envío. Revisa el chat antes de reenviarlo.' };
  }
  return { status: 'sent', error: null };
}

/**
 * Job "scheduled.send". The row is claimed (pending → sending) before anything is sent, so a
 * cancellation in flight or a second run can never send it twice; the message is linked to the
 * row in the same transaction that stores it, so a run that died mid-send is finished from
 * that message instead of being sent again.
 */
export async function processScheduled(
  ctx: AppContext,
  p: { id: string; retry?: number },
  job?: { attempts: number; max_attempts: number },
): Promise<void> {
  // Due-ness is decided by the database clock, the same one the queue used to start this job.
  const { rows } = await ctx.db.query<ScheduledRow & { due: boolean }>(
    `SELECT *, send_at <= now() + interval '1 second' AS due FROM scheduled_messages WHERE id = $1`,
    [p.id],
  );
  let s: ScheduledRow | undefined = rows[0];
  if (!s) return;
  if (s.status === 'sending') {
    const m = s.message_id ? (await ctx.db.query<MessageRow>(`SELECT status, error, wamid FROM messages WHERE id = $1`, [s.message_id])).rows[0] : null;
    // Linked to the failed message of an earlier attempt, still waiting for its retry: the previous
    // run stopped before sending again. Otherwise it ends as its message did, never resent.
    if (s.message_id && !(m && isAwaitingRetry(m))) {
      const o = m ? outcome(m) : { status: 'sent' as const, error: 'No pudimos confirmar el envío. Revisa el chat antes de reenviarlo.' };
      return finish(ctx, s, o.status, s.message_id, o.error);
    }
    // Claimed but nothing was stored: the previous run stopped before sending.
  } else if (s.status === 'pending') {
    if (!rows[0].due) {
      // Started early (clock skew between app servers and the database): run again when due.
      await ctx.queue.enqueue('scheduled.send', { id: s.id, retry: p.retry }, { runAt: new Date(s.send_at), maxAttempts: 3 });
      return;
    }
    // message_id is kept: after a throttle or network failure it is the failed attempt, sent again as that same message.
    const claim = await ctx.db.query<ScheduledRow>(
      `UPDATE scheduled_messages SET status = 'sending', error = NULL WHERE id = $1 AND status = 'pending' RETURNING *`,
      [s.id],
    );
    s = claim.rows[0];
    if (!s) return; // cancelled meanwhile
  } else {
    return;
  }

  const row = s;
  let created: string | null = null;
  try {
    let content = row.content;
    if (content.type === 'template') {
      // Placeholders like {primer_nombre} are rendered at send time, as immediate sends do.
      const contact = await getContact(ctx.db, row.workspace_id, row.contact_id);
      content = { ...content, params: renderTemplateParams(content.params, contact) };
    }
    const retry = p.retry ?? 0;
    const msg = await sendMessage(ctx, {
      workspaceId: row.workspace_id,
      contactId: row.contact_id,
      content,
      sentBy: 'scheduled',
      userId: row.created_by,
      // The last attempt's failure asks the team to resend it; earlier ones say it will be retried.
      autoRetry: retry < MAX_THROTTLE_RETRIES,
      retryOf: row.message_id,
      onCreated: async (q, m) => {
        created = m.id;
        await q.query(`UPDATE scheduled_messages SET message_id = $2 WHERE id = $1`, [row.id, m.id]);
      },
    });
    const network = isNetworkFailure(msg);
    if (msg.status === 'failed' && (isMetaThrottle(msg.error?.code) || network) && retry < MAX_THROTTLE_RETRIES) {
      // Meta's rate limits are temporary, and a send that never reached Meta (network down) can go
      // again safely: retry later instead of failing the message. Row and job change together.
      const reason = network ? 'No se pudo conectar con WhatsApp (falla de red del servidor).' : 'Meta limitó la velocidad de envío.';
      await ctx.db.tx(async (q) => {
        const back = await q.query(`UPDATE scheduled_messages SET status = 'pending', error = $2 WHERE id = $1 AND status = 'sending'`, [
          row.id,
          withRetryNote(reason),
        ]);
        if (back.rowCount) {
          await ctx.queue.enqueue('scheduled.send', { id: row.id, retry: retry + 1 }, { delayMs: 30_000 * 2 ** retry, maxAttempts: 3 }, q);
        }
      });
      return;
    }
    const o = outcome(msg);
    await finish(ctx, row, o.status, msg.id, o.error);
  } catch (err: any) {
    if (err instanceof AppError) return finish(ctx, row, 'failed', null, err.message);
    if (job && job.attempts >= job.max_attempts) {
      // Last attempt: never leave the row pending or sending forever.
      if (!created) return finish(ctx, row, 'failed', null, INTERNAL_ERROR);
      const m = await ctx.db.query<MessageRow>(`SELECT status, error, wamid FROM messages WHERE id = $1`, [created]);
      const o = m.rows[0] ? outcome(m.rows[0]) : { status: 'failed' as const, error: INTERNAL_ERROR };
      return finish(ctx, row, o.status, m.rows[0] ? created : null, o.error);
    }
    if (!created) {
      // Nothing was stored, so nothing was sent: give the claim back and let the job retry.
      await ctx.db.query(`UPDATE scheduled_messages SET status = 'pending' WHERE id = $1 AND status = 'sending'`, [row.id]);
    }
    // Otherwise the row stays claimed and linked: the retry finishes it from the message.
    throw err;
  }
}

/**
 * Finishes scheduled messages no job will ever finish. A run cut off by a crash on its last attempt
 * leaves the row 'sending' (or 'pending', if it died before the claim) while the queue fails the job
 * without running the handler. A row linked to a stored message ends as that message did (it is never
 * resent); otherwise nothing was sent and it is marked failed, so the panel shows it and it can be
 * dismissed. Run periodically by the worker; each row is re-checked under its lock.
 */
export async function recoverOrphanedScheduled(ctx: AppContext): Promise<number> {
  const stuck = `(s.status = 'sending' OR (s.status = 'pending' AND s.send_at < now() - interval '1 minute'))`;
  const noJob = `NOT EXISTS (SELECT 1 FROM jobs j WHERE j.type = 'scheduled.send' AND j.status IN ('queued', 'running') AND j.payload->>'id' = s.id::text)`;
  const { rows } = await ctx.db.query<{ id: string }>(`SELECT s.id FROM scheduled_messages s WHERE ${stuck} AND ${noJob} LIMIT 500`);
  let recovered = 0;
  for (const { id } of rows) {
    const done = await ctx.db.tx(async (q) => {
      const locked = await q.query<ScheduledRow>(`SELECT s.* FROM scheduled_messages s WHERE s.id = $1 AND ${stuck} FOR UPDATE SKIP LOCKED`, [id]);
      const s = locked.rows[0];
      if (!s) return null;
      // Checked again now that the row is locked: a job queued together with a change to it is visible.
      const live = await q.query(`SELECT 1 FROM scheduled_messages s WHERE s.id = $1 AND ${noJob}`, [id]);
      if (!live.rows[0]) return null;
      let o: { status: 'sent' | 'failed'; error: string | null } = { status: 'failed', error: INTERNAL_ERROR };
      if (s.status === 'sending' && s.message_id) {
        const m = await q.query<MessageRow>(`SELECT status, error, wamid FROM messages WHERE id = $1`, [s.message_id]);
        if (m.rows[0]) o = outcome(m.rows[0]);
      }
      await q.query(`UPDATE scheduled_messages SET status = $2, error = $3 WHERE id = $1`, [s.id, o.status, o.error]);
      return { s, ...o };
    });
    if (!done) continue;
    recovered++;
    if (done.status === 'failed' && done.s.message_id) await abandonAutoRetry(ctx, { messageId: done.s.message_id });
    notify(ctx, done.s, done.status, done.error);
  }
  return recovered;
}
