import type { AppContext } from '../context.js';

/**
 * The workspace's time zone, for calendar days (UTC if the stored one is unknown here). Zone names
 * are only ever read by Intl (here, in localDay and dayStart): Postgres knows other names (and reads
 * an offset like '-03:00' with the opposite sign), so SQL gets instants, never the zone.
 */
export async function workspaceTimezone(ctx: AppContext, workspaceId: string): Promise<string> {
  const { rows } = await ctx.db.query<{ timezone: string }>(`SELECT timezone FROM workspaces WHERE id = $1`, [workspaceId]);
  const tz = rows[0]?.timezone || 'UTC';
  try {
    wallClock(tz);
    return tz;
  } catch {
    return 'UTC';
  }
}

const wallClocks = new Map<string, Intl.DateTimeFormat>();

function wallClock(tz: string): Intl.DateTimeFormat {
  let f = wallClocks.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    if (wallClocks.size >= 500) wallClocks.clear();
    wallClocks.set(tz, f);
  }
  return f;
}

/** Milliseconds the zone's wall clock is ahead of UTC at an instant. */
function utcOffset(tz: string, at: number): number {
  const p: Record<string, number> = {};
  for (const { type, value } of wallClock(tz).formatToParts(at)) p[type] = Number(value);
  const wall = new Date(0);
  wall.setUTCFullYear(p.year, p.month - 1, p.day); // Date.UTC would read years below 100 as 19xx
  wall.setUTCHours(p.hour, p.minute, p.second);
  return wall.getTime() - Math.floor(at / 1000) * 1000;
}

/** Today's date (YYYY-MM-DD) in a time zone. */
export function localDay(tz: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The calendar day after a YYYY-MM-DD one. */
export function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 24 * 3600 * 1000).toISOString().slice(0, 10);
}

/** The instant a calendar day (YYYY-MM-DD) starts in a time zone: its first local midnight. */
export function dayStart(day: string, tz: string): Date {
  const wall = Date.parse(`${day}T00:00:00Z`);
  // The offset at the wall time read as UTC, then at the first guess: they differ near a DST change.
  const first = wall - utcOffset(tz, wall);
  const guesses = [first, wall - utcOffset(tz, first)];
  const exact = guesses.filter((t) => t + utcOffset(tz, t) === wall);
  // No exact one: the clocks skip midnight that day, and the day starts when they jump.
  return new Date(exact.length ? Math.min(...exact) : Math.max(...guesses));
}

/**
 * Report for the calendar days fromDay..toDay (YYYY-MM-DD, both included) of the workspace's
 * time zone: Settings says reports use it, and one instance serves workspaces in many zones.
 */
export async function overviewReport(ctx: AppContext, workspaceId: string, fromDay: string, toDay: string, tz: string) {
  const q = ctx.db;
  // Each day runs from its local midnight to the next one (23 or 25 hours on a DST change).
  const days: { day: string; lo: Date; hi: Date }[] = [];
  for (let day = fromDay, lo = dayStart(day, tz); day <= toDay; ) {
    const next = nextDay(day);
    const hi = dayStart(next, tz);
    days.push({ day, lo, hi });
    day = next;
    lo = hi;
  }
  const from = days[0].lo;
  const to = days[days.length - 1].hi;
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
    `WITH days AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS d(day text, lo timestamptz, hi timestamptz))
     SELECT d.day,
       (SELECT count(*)::int FROM contacts c WHERE c.workspace_id = $1 AND c.created_at >= d.lo AND c.created_at < d.hi) AS leads,
       (SELECT count(*)::int FROM messages m WHERE m.workspace_id = $1 AND m.direction = 'in' AND m.created_at >= d.lo AND m.created_at < d.hi) AS messages_in,
       (SELECT count(*)::int FROM messages m WHERE m.workspace_id = $1 AND m.direction = 'out' AND m.created_at >= d.lo AND m.created_at < d.hi) AS messages_out
     FROM days d ORDER BY d.day`,
    [workspaceId, JSON.stringify(days)],
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
    range: { from, to, from_day: fromDay, to_day: toDay, timezone: tz },
    totals: totals.rows[0],
    daily: daily.rows,
    sources: sources.rows,
    funnels: funnels.rows,
    agents: agents.rows,
  };
}
