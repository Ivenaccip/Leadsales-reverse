import type { Queryable } from '../db/index.js';

/**
 * Round-robin: the active member (that receives leads, and belongs to the funnel's
 * team when one is set) who was assigned least recently gets the lead.
 */
export async function pickAssignee(q: Queryable, workspaceId: string, funnelAssigneeIds: string[]): Promise<string | null> {
  const { rows } = await q.query<{ user_id: string }>(
    `SELECT user_id FROM memberships
     WHERE workspace_id = $1 AND is_active AND receives_leads
       AND (cardinality($2::uuid[]) = 0 OR user_id = ANY($2::uuid[]))
     ORDER BY last_assigned_at ASC NULLS FIRST, created_at ASC
     LIMIT 1 FOR UPDATE`,
    [workspaceId, funnelAssigneeIds],
  );
  const userId = rows[0]?.user_id ?? null;
  if (userId) {
    await q.query(`UPDATE memberships SET last_assigned_at = clock_timestamp() WHERE workspace_id = $1 AND user_id = $2`, [
      workspaceId,
      userId,
    ]);
  }
  return userId;
}
