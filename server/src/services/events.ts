import type { AppContext } from '../context.js';
import type { Queryable } from '../db/index.js';

export const WEBHOOK_EVENTS = [
  'contact.created',
  'contact.updated',
  'contact.stage_changed',
  'contact.assigned',
  'message.received',
  'message.sent',
  'message.status',
  'broadcast.completed',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Timeline entry for a contact (used for the history panel and reports). */
export async function recordEvent(
  q: Queryable,
  e: { workspaceId: string; contactId: string; type: string; data?: unknown; userId?: string | null },
): Promise<void> {
  await q.query(
    `INSERT INTO contact_events (workspace_id, contact_id, type, data, user_id) VALUES ($1, $2, $3, $4, $5)`,
    [e.workspaceId, e.contactId, e.type, JSON.stringify(e.data ?? {}), e.userId ?? null],
  );
}

/** Queues delivery to every active outgoing webhook subscribed to the event. */
export async function dispatchWebhook(ctx: AppContext, workspaceId: string, event: WebhookEvent, data: unknown): Promise<void> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `SELECT id FROM webhook_endpoints
     WHERE workspace_id = $1 AND is_active AND (cardinality(events) = 0 OR $2 = ANY(events) OR '*' = ANY(events))`,
    [workspaceId, event],
  );
  for (const ep of rows) {
    await ctx.queue.enqueue(
      'webhook.deliver',
      { endpointId: ep.id, event, data, sentAt: new Date().toISOString() },
      { maxAttempts: 6 },
    );
  }
}
