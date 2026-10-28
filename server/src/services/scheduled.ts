import type { AppContext } from '../context.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { getContact } from './contacts.js';
import { sendMessage, type SendContent } from './messages.js';

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
  const { rows } = await ctx.db.query<ScheduledRow>(
    `INSERT INTO scheduled_messages (workspace_id, contact_id, created_by, content, send_at) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [workspaceId, contactId, userId, JSON.stringify(content), sendAt],
  );
  await ctx.queue.enqueue('scheduled.send', { id: rows[0].id }, { runAt: sendAt, maxAttempts: 3 });
  return rows[0];
}

export async function cancelScheduled(ctx: AppContext, workspaceId: string, id: string): Promise<void> {
  const { rowCount } = await ctx.db.query(
    `UPDATE scheduled_messages SET status = 'cancelled' WHERE id = $1 AND workspace_id = $2 AND status = 'pending'`,
    [id, workspaceId],
  );
  if (!rowCount) throw notFound('Mensaje programado pendiente');
}

/** Job "scheduled.send". */
export async function processScheduled(ctx: AppContext, p: { id: string }): Promise<void> {
  const { rows } = await ctx.db.query<ScheduledRow>(`SELECT * FROM scheduled_messages WHERE id = $1`, [p.id]);
  const s = rows[0];
  if (!s || s.status !== 'pending') return;
  if (new Date(s.send_at).getTime() > Date.now() + 1000) {
    // Rescheduled to a later date: a newer job covers it.
    return;
  }
  try {
    const msg = await sendMessage(ctx, {
      workspaceId: s.workspace_id,
      contactId: s.contact_id,
      content: s.content,
      sentBy: 'scheduled',
      userId: s.created_by,
    });
    await ctx.db.query(`UPDATE scheduled_messages SET status = $2, message_id = $3, error = $4 WHERE id = $1`, [
      s.id,
      msg.status === 'failed' ? 'failed' : 'sent',
      msg.id,
      msg.error?.message ?? null,
    ]);
  } catch (err: any) {
    if (!(err instanceof AppError)) throw err; // network/db: retry
    await ctx.db.query(`UPDATE scheduled_messages SET status = 'failed', error = $2 WHERE id = $1`, [s.id, err.message]);
  }
  ctx.realtime.emit(s.workspace_id, 'scheduled:update', { id: s.id, contact_id: s.contact_id });
}
