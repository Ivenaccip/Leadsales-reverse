import type { Queryable } from '../db/index.js';

/**
 * Round-robin: the active member (that receives leads, and belongs to the funnel's
 * team when one is set) who was assigned least recently gets the lead.
 * A team none of whose members is still active here (they were all deactivated or removed) counts
 * as no team, as the funnel settings show it: every member who receives leads takes part, instead
 * of each new lead silently staying unassigned. `log` is told when that happens.
 */
export async function pickAssignee(
  q: Queryable,
  workspaceId: string,
  funnelAssigneeIds: string[],
  log?: { warn: (obj: object, msg: string) => void },
): Promise<string | null> {
  const { rows } = await q.query<{ user_id: string; whole_team: boolean }>(
    `WITH team AS (
       SELECT user_id FROM memberships WHERE workspace_id = $1 AND is_active AND user_id = ANY($2::uuid[])
     )
     SELECT user_id, NOT EXISTS (SELECT 1 FROM team) AS whole_team FROM memberships
     WHERE workspace_id = $1 AND is_active AND receives_leads
       AND (NOT EXISTS (SELECT 1 FROM team) OR user_id IN (SELECT user_id FROM team))
     ORDER BY last_assigned_at ASC NULLS FIRST, created_at ASC
     LIMIT 1 FOR UPDATE`,
    [workspaceId, funnelAssigneeIds],
  );
  const userId = rows[0]?.user_id ?? null;
  if (userId) {
    if (funnelAssigneeIds.length && rows[0].whole_team) {
      log?.warn({ workspaceId, team: funnelAssigneeIds, assignedTo: userId }, 'funnel team has no active member: lead assigned among every member');
    }
    await q.query(`UPDATE memberships SET last_assigned_at = clock_timestamp() WHERE workspace_id = $1 AND user_id = $2`, [
      workspaceId,
      userId,
    ]);
  }
  return userId;
}
