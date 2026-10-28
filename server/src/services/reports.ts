import type { AppContext } from '../context.js';

export async function overviewReport(ctx: AppContext, workspaceId: string, from: Date, to: Date) {
  const q = ctx.db;
  const args = [workspaceId, from, to];

  const totals = await q.query<Record<string, number>>(
    `SELECT
       (SELECT count(*)::int FROM contacts WHERE workspace_id = $1 AND created_at >= $2 AND created_at < $3) AS new_leads,
       (SELECT count(*)::int FROM messages WHERE workspace_id = $1 AND direction = 'in' AND created_at >= $2 AND created_at < $3) AS messages_in,
       (SELECT count(*)::int FROM messages WHERE workspace_id = $1 AND direction = 'out' AND created_at >= $2 AND created_at < $3) AS messages_out,
       (SELECT count(DISTINCT contact_id)::int FROM messages WHERE workspace_id = $1 AND direction = 'in' AND created_at >= $2 AND created_at < $3) AS active_conversations,
       (SELECT count(*)::int FROM contact_events e WHERE e.workspace_id = $1 AND e.type = 'stage_changed' AND e.data->>'kind' = 'won' AND e.created_at >= $2 AND e.created_at < $3) AS won,
       (SELECT COALESCE(sum(c.deal_value), 0)::float FROM contact_events e JOIN contacts c ON c.id = e.contact_id
         WHERE e.workspace_id = $1 AND e.type = 'stage_changed' AND e.data->>'kind' = 'won' AND e.created_at >= $2 AND e.created_at < $3) AS won_value,
       (SELECT COALESCE(-sum(amount), 0)::float FROM credit_ledger WHERE workspace_id = $1 AND kind IN ('charge', 'refund') AND created_at >= $2 AND created_at < $3) AS spend`,
    args,
  );

  const daily = await q.query<{ day: string; leads: number; messages_in: number; messages_out: number }>(
    `WITH days AS (SELECT generate_series(date_trunc('day', $2::timestamptz), date_trunc('day', $3::timestamptz - interval '1 second'), interval '1 day') AS day)
     SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
       (SELECT count(*)::int FROM contacts c WHERE c.workspace_id = $1 AND c.created_at >= d.day AND c.created_at < d.day + interval '1 day') AS leads,
       (SELECT count(*)::int FROM messages m WHERE m.workspace_id = $1 AND m.direction = 'in' AND m.created_at >= d.day AND m.created_at < d.day + interval '1 day') AS messages_in,
       (SELECT count(*)::int FROM messages m WHERE m.workspace_id = $1 AND m.direction = 'out' AND m.created_at >= d.day AND m.created_at < d.day + interval '1 day') AS messages_out
     FROM days d ORDER BY d.day`,
    args,
  );

  const sources = await q.query<{ source: string; count: number }>(
    `SELECT source, count(*)::int AS count FROM contacts WHERE workspace_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY source ORDER BY count DESC`,
    args,
  );

  const funnels = await q.query<{ funnel_id: string; funnel: string; stage_id: string; stage: string; color: string; kind: string; count: number; value: number }>(
    `SELECT f.id AS funnel_id, f.name AS funnel, s.id AS stage_id, s.name AS stage, s.color, s.kind,
       count(c.id)::int AS count, COALESCE(sum(c.deal_value), 0)::float AS value
     FROM funnels f JOIN stages s ON s.funnel_id = f.id
     LEFT JOIN contacts c ON c.stage_id = s.id AND NOT c.is_archived
     WHERE f.workspace_id = $1
     GROUP BY f.id, f.name, f.position, s.id, s.name, s.color, s.kind, s.position
     ORDER BY f.position, s.position`,
    [workspaceId],
  );

  const agents = await q.query<{
    user_id: string;
    name: string;
    open_leads: number;
    messages_sent: number;
    won: number;
    avg_first_response_seconds: number | null;
  }>(
    `WITH firsts AS (
       SELECT c.assigned_user_id AS user_id,
         (SELECT min(m.created_at) FROM messages m WHERE m.contact_id = c.id AND m.direction = 'in') AS first_in,
         (SELECT min(m.created_at) FROM messages m WHERE m.contact_id = c.id AND m.direction = 'out' AND m.sent_by = 'user') AS first_reply
       FROM contacts c WHERE c.workspace_id = $1 AND c.created_at >= $2 AND c.created_at < $3 AND c.assigned_user_id IS NOT NULL
     )
     SELECT u.id AS user_id, u.name,
       (SELECT count(*)::int FROM contacts c JOIN stages s ON s.id = c.stage_id
         WHERE c.workspace_id = $1 AND c.assigned_user_id = u.id AND s.kind = 'open' AND NOT c.is_archived) AS open_leads,
       (SELECT count(*)::int FROM messages m WHERE m.workspace_id = $1 AND m.user_id = u.id AND m.direction = 'out' AND m.sent_by = 'user'
         AND m.created_at >= $2 AND m.created_at < $3) AS messages_sent,
       (SELECT count(*)::int FROM contact_events e JOIN contacts c ON c.id = e.contact_id
         WHERE e.workspace_id = $1 AND e.type = 'stage_changed' AND e.data->>'kind' = 'won' AND c.assigned_user_id = u.id
           AND e.created_at >= $2 AND e.created_at < $3) AS won,
       (SELECT avg(extract(epoch FROM f.first_reply - f.first_in))::float FROM firsts f
         WHERE f.user_id = u.id AND f.first_reply IS NOT NULL AND f.first_in IS NOT NULL AND f.first_reply > f.first_in) AS avg_first_response_seconds
     FROM memberships mb JOIN users u ON u.id = mb.user_id
     WHERE mb.workspace_id = $1
     ORDER BY u.name`,
    args,
  );

  return {
    range: { from, to },
    totals: totals.rows[0],
    daily: daily.rows,
    sources: sources.rows,
    funnels: funnels.rows,
    agents: agents.rows,
  };
}
