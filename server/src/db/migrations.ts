// Migrations are plain SQL kept in code so the build has nothing extra to copy.
// Statements are split on ";\n": avoid function bodies or multi-line strings with ';'.

const init = `
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name text NOT NULL,
  is_superadmin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'America/Mexico_City',
  default_country_code text NOT NULL DEFAULT '52',
  billing_mode text NOT NULL DEFAULT 'meta_direct' CHECK (billing_mode IN ('meta_direct', 'prepaid')),
  credit_balance numeric(14,4) NOT NULL DEFAULT 0,
  settings jsonb NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'agent')),
  is_active boolean NOT NULL DEFAULT true,
  receives_leads boolean NOT NULL DEFAULT true,
  last_assigned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('cloud_api', 'sandbox')),
  name text NOT NULL,
  display_phone text,
  phone_number_id text NOT NULL UNIQUE,
  waba_id text,
  credentials text,
  verify_token text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  last_error text,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE funnels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  position int NOT NULL DEFAULT 0,
  auto_assign boolean NOT NULL DEFAULT false,
  assignee_ids uuid[] NOT NULL DEFAULT '{}',
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  funnel_id uuid NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text NOT NULL DEFAULT '#64748b',
  position int NOT NULL DEFAULT 0,
  kind text NOT NULL DEFAULT 'open' CHECK (kind IN ('open', 'won', 'lost')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text NOT NULL DEFAULT '#0ea5e9',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  phone text NOT NULL,
  wa_id text,
  name text,
  email text,
  company text,
  channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
  funnel_id uuid REFERENCES funnels(id) ON DELETE SET NULL,
  stage_id uuid REFERENCES stages(id) ON DELETE SET NULL,
  assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  deal_value numeric(14,2) NOT NULL DEFAULT 0,
  custom_fields jsonb NOT NULL DEFAULT '{}',
  source text NOT NULL DEFAULT 'whatsapp',
  last_message_at timestamptz,
  last_message_preview text,
  last_inbound_at timestamptz,
  unread_count int NOT NULL DEFAULT 0,
  bot_state jsonb,
  ai_paused boolean NOT NULL DEFAULT false,
  last_away_at timestamptz,
  is_archived boolean NOT NULL DEFAULT false,
  opted_out boolean NOT NULL DEFAULT false,
  stage_changed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, phone)
);
CREATE INDEX contacts_ws_last_msg ON contacts (workspace_id, last_message_at DESC NULLS LAST);
CREATE INDEX contacts_ws_stage ON contacts (workspace_id, stage_id);
CREATE INDEX contacts_ws_assigned ON contacts (workspace_id, assigned_user_id);

CREATE TABLE contact_tags (
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, tag_id)
);
CREATE INDEX contact_tags_tag ON contact_tags (tag_id);

CREATE TABLE media_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  path text NOT NULL,
  mime text NOT NULL,
  size int NOT NULL DEFAULT 0,
  filename text,
  wa_media_ids jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE broadcasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
  name text NOT NULL,
  template_name text NOT NULL,
  template_language text NOT NULL,
  template_category text NOT NULL DEFAULT 'marketing',
  params jsonb NOT NULL DEFAULT '{}',
  audience jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled')),
  scheduled_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  last_error text,
  total_recipients int NOT NULL DEFAULT 0,
  estimated_cost numeric(14,4) NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
  direction text NOT NULL CHECK (direction IN ('in', 'out', 'internal')),
  type text NOT NULL,
  body text,
  media_file_id uuid REFERENCES media_files(id) ON DELETE SET NULL,
  media jsonb,
  payload jsonb,
  wamid text UNIQUE,
  reply_to_wamid text,
  status text NOT NULL DEFAULT 'pending',
  error jsonb,
  sent_by text,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  broadcast_id uuid REFERENCES broadcasts(id) ON DELETE SET NULL,
  billing_category text,
  cost numeric(14,4) NOT NULL DEFAULT 0,
  pricing_reconciled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  status_updated_at timestamptz
);
CREATE INDEX messages_contact_created ON messages (contact_id, created_at DESC);
CREATE INDEX messages_ws_created ON messages (workspace_id, created_at);
CREATE INDEX messages_broadcast ON messages (broadcast_id) WHERE broadcast_id IS NOT NULL;

CREATE TABLE broadcast_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id uuid NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued',
  error text,
  processed_at timestamptz,
  UNIQUE (broadcast_id, contact_id)
);
CREATE INDEX broadcast_recipients_queue ON broadcast_recipients (broadcast_id, status);

CREATE TABLE quick_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  shortcut text NOT NULL,
  title text,
  body text NOT NULL,
  media_file_id uuid REFERENCES media_files(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, shortcut)
);

CREATE TABLE templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  meta_id text,
  name text NOT NULL,
  language text NOT NULL,
  category text NOT NULL,
  status text NOT NULL,
  components jsonb NOT NULL DEFAULT '[]',
  parameter_format text,
  rejected_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, name, language)
);

CREATE TABLE scheduled_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  content jsonb NOT NULL,
  send_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scheduled_messages_ws ON scheduled_messages (workspace_id, status, send_at);

CREATE TABLE credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  amount numeric(14,4) NOT NULL,
  balance_after numeric(14,4) NOT NULL,
  kind text NOT NULL CHECK (kind IN ('topup', 'charge', 'refund', 'adjustment')),
  description text,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  broadcast_id uuid REFERENCES broadcasts(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_ledger_ws ON credit_ledger (workspace_id, created_at DESC);

CREATE TABLE rate_card (
  market text NOT NULL,
  category text NOT NULL CHECK (category IN ('marketing', 'utility', 'authentication', 'service')),
  price numeric(10,5) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (market, category)
);

CREATE TABLE contact_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  type text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contact_events_ws_type ON contact_events (workspace_id, type, created_at);
CREATE INDEX contact_events_contact ON contact_events (contact_id, created_at DESC);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url text NOT NULL,
  secret text NOT NULL,
  events text[] NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  last_status int,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id bigserial PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  dedupe_key text,
  last_error text,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX jobs_ready ON jobs (status, run_at);
CREATE UNIQUE INDEX jobs_dedupe ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL AND status = 'queued';
`;

// Reference Meta per-message prices in USD (October 2026). Meta updates them every
// quarter: the instance admin can edit them from the admin panel.
// Markets: individual countries Meta lists, NA = US/Canada, LATAM = rest of Latin America, OTHER = rest of world.
const rates: Record<string, [number, number, number, number]> = {
  // market: [marketing, utility, authentication, service]
  MX: [0.0457, 0.0085, 0.0085, 0.0085],
  CO: [0.0125, 0.0008, 0.0008, 0.0008],
  BR: [0.0625, 0.0068, 0.0068, 0.0068],
  AR: [0.0618, 0.026, 0.026, 0.026],
  CL: [0.0889, 0.02, 0.02, 0.02],
  PE: [0.0703, 0.02, 0.02, 0.02],
  ES: [0.0615, 0.02, 0.02, 0.02],
  NA: [0.025, 0.0034, 0.0034, 0.0034],
  LATAM: [0.074, 0.0113, 0.0113, 0.0113],
  OTHER: [0.0604, 0.0077, 0.0077, 0.0077],
};
const categories = ['marketing', 'utility', 'authentication', 'service'];
const seedRates =
  'INSERT INTO rate_card (market, category, price) VALUES ' +
  Object.entries(rates)
    .flatMap(([market, prices]) => prices.map((p, i) => `('${market}', '${categories[i]}', ${p})`))
    .join(', ') +
  ' ON CONFLICT DO NOTHING;\n';

// WhatsApp message ids are unique per tenant: one workspace must never be able to
// "claim" an id and make another workspace drop its message as a duplicate.
const wamidPerWorkspace = `
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_wamid_key;
CREATE UNIQUE INDEX IF NOT EXISTS messages_ws_wamid ON messages (workspace_id, wamid);
ALTER TABLE broadcast_recipients ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
`;

// Hardening after the adversarial review: revocable sessions, invitations instead of
// admin-created accounts, billing mode recorded at charge time, 6-decimal money, and
// job ownership/lanes for fast crash recovery and per-tenant fairness.
const hardening = `
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  user_agent text,
  ip text
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL,
  name text,
  role text NOT NULL CHECK (role IN ('admin', 'agent')),
  token_hash text NOT NULL UNIQUE,
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS invitations_ws ON invitations (workspace_id);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS charged_prepaid boolean NOT NULL DEFAULT false;
-- Before 004 the wallet followed the workspace's current mode: keep that for messages that can
-- still be settled (refund on failure, reconciliation), so upgrading does not strand their charges.
UPDATE messages m SET charged_prepaid = true FROM workspaces w
  WHERE w.id = m.workspace_id AND w.billing_mode = 'prepaid' AND m.direction = 'out' AND NOT m.charged_prepaid
    AND (m.status NOT IN ('delivered', 'read', 'failed') OR NOT m.pricing_reconciled);
CREATE INDEX IF NOT EXISTS contacts_ws_wa_id ON contacts (workspace_id, wa_id) WHERE wa_id IS NOT NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS followups_done boolean NOT NULL DEFAULT true;
ALTER TABLE workspaces ALTER COLUMN credit_balance TYPE numeric(16,6);
ALTER TABLE credit_ledger ALTER COLUMN amount TYPE numeric(16,6);
ALTER TABLE credit_ledger ALTER COLUMN balance_after TYPE numeric(16,6);
ALTER TABLE messages ALTER COLUMN cost TYPE numeric(16,6);
ALTER TABLE broadcasts ALTER COLUMN estimated_cost TYPE numeric(16,6);
ALTER TABLE rate_card ALTER COLUMN price TYPE numeric(12,6);

ALTER TABLE channels ADD COLUMN IF NOT EXISTS operator_verified boolean NOT NULL DEFAULT false;
-- Since 850282e only the operator could connect numbers in prepaid workspaces: keep them working.
UPDATE channels SET operator_verified = true
  WHERE provider = 'cloud_api' AND NOT operator_verified
    AND workspace_id IN (SELECT id FROM workspaces WHERE billing_mode = 'prepaid');

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS locked_by text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS workspace_id uuid;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lane text NOT NULL DEFAULT 'default';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS serial_key text;
CREATE UNIQUE INDEX IF NOT EXISTS jobs_serial_running ON jobs (serial_key) WHERE serial_key IS NOT NULL AND status = 'running';
CREATE INDEX IF NOT EXISTS jobs_lane_ready ON jobs (lane, status, run_at);
CREATE INDEX IF NOT EXISTS jobs_lane_ws_queued ON jobs (lane, workspace_id, run_at) WHERE status = 'queued';
UPDATE jobs SET lane = 'webhooks',
  workspace_id = (SELECT e.workspace_id FROM webhook_endpoints e WHERE e.id::text = jobs.payload->>'endpointId')
WHERE type = 'webhook.deliver' AND status IN ('queued', 'running');
CREATE TABLE IF NOT EXISTS worker_heartbeats (
  id text PRIMARY KEY,
  seen_at timestamptz NOT NULL DEFAULT now()
);
`;

// Third review: sessions tied to the password they were opened with, Meta's own timestamp on
// inbound messages, and template statuses older versions stored from notification events.
const reviewThree = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_version int NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS password_version int NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS wa_ts bigint;
UPDATE templates SET status = 'APPROVED' WHERE status IN ('REINSTATED', 'FLAGGED', 'LOCKED', 'UNLOCKED');
-- Periodic settlement of sends Meta never confirmed, and of scheduled rows whose job died.
CREATE INDEX IF NOT EXISTS messages_unsettled ON messages (created_at) WHERE direction = 'out' AND status IN ('pending', 'unknown') AND wamid IS NULL;
CREATE INDEX IF NOT EXISTS scheduled_messages_stuck ON scheduled_messages (send_at) WHERE status IN ('pending', 'sending');
CREATE INDEX IF NOT EXISTS jobs_scheduled_live ON jobs ((payload->>'id')) WHERE type = 'scheduled.send' AND status IN ('queued', 'running');
-- Jobs: only the first queued job of each serial key can be claimed (held marks the ones behind
-- it), claims read partial indexes of claimable jobs, and queued jobs move to this version's lanes.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS held boolean NOT NULL DEFAULT false;
DROP INDEX IF EXISTS jobs_lane_ready;
DROP INDEX IF EXISTS jobs_lane_ws_queued;
CREATE INDEX IF NOT EXISTS jobs_claimable ON jobs (lane, run_at, id) WHERE status = 'queued' AND NOT held;
CREATE INDEX IF NOT EXISTS jobs_claimable_ws ON jobs (lane, workspace_id, run_at, id) WHERE status = 'queued' AND NOT held;
CREATE INDEX IF NOT EXISTS jobs_serial_queued ON jobs (serial_key, run_at, id) WHERE status = 'queued' AND serial_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_serial_unheld ON jobs (serial_key, run_at) WHERE status = 'queued' AND NOT held AND serial_key IS NOT NULL;
UPDATE jobs j SET held = true
WHERE j.status = 'queued' AND j.serial_key IS NOT NULL
  AND EXISTS (SELECT 1 FROM jobs p WHERE p.serial_key = j.serial_key AND p.id <> j.id
              AND (p.status = 'running' OR (p.status = 'queued' AND (p.run_at, p.id) < (j.run_at, j.id))));
UPDATE jobs SET lane = 'inbound' WHERE type = 'wa.webhook' AND status = 'queued';
UPDATE jobs SET lane = 'media',
  workspace_id = COALESCE(workspace_id, (SELECT m.workspace_id FROM messages m
    WHERE m.id = CASE WHEN jobs.payload->>'messageId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (jobs.payload->>'messageId')::uuid END))
WHERE type = 'media.download' AND status = 'queued';
UPDATE jobs SET lane = 'bulk',
  workspace_id = COALESCE(workspace_id, (SELECT s.workspace_id FROM scheduled_messages s
    WHERE s.id = CASE WHEN jobs.payload->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (jobs.payload->>'id')::uuid END))
WHERE type = 'scheduled.send' AND status = 'queued';
UPDATE jobs SET lane = 'bulk',
  workspace_id = COALESCE(workspace_id, (SELECT b.workspace_id FROM broadcasts b
    WHERE b.id = CASE WHEN jobs.payload->>'broadcastId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (jobs.payload->>'broadcastId')::uuid END))
WHERE type = 'broadcast.process' AND status = 'queued';
-- Claims are planned from the statistics of jobs: refresh them after every 1000 changes, not after
-- 10% of a table that keeps a week of finished jobs (a burst would be planned as an empty queue).
ALTER TABLE jobs SET (autovacuum_analyze_scale_factor = 0, autovacuum_analyze_threshold = 1000);
`;

// Shipped migrations are never edited (installs that applied them would never see the change):
// corrections go in a new one. test/migrations-frozen.test.ts enforces it.
// 006 fixes what 004 trusted too much, and backfills rows older versions left behind.
const reviewFour = `
-- 004 marked every prepaid cloud number operator-verified, including numbers a business connected
-- with its own Meta app while it paid Meta directly: it knows their App Secret and could forge
-- billing statuses. They stay off until the operator re-verifies them with their own app.
UPDATE channels SET operator_verified = false, status = 'disabled',
  last_error = 'Desactivado en modo de créditos prepagados: el negocio puede conocer la clave secreta (App Secret) de este número. Para activarlo, el administrador de la instancia debe capturar el token y la App Secret de su propia app de Meta.'
  WHERE provider = 'cloud_api' AND operator_verified
    AND workspace_id IN (SELECT id FROM workspaces WHERE billing_mode = 'prepaid')
    AND created_at < (SELECT applied_at FROM schema_migrations WHERE name = '004_hardening');
-- Inbound files whose download had already given up before download_error existed: show why
-- instead of a spinner that never ends.
UPDATE messages m SET media = m.media || jsonb_build_object('download_error', 'No se pudo descargar el archivo de WhatsApp.')
  WHERE m.direction = 'in' AND m.media_file_id IS NULL AND m.media IS NOT NULL
    AND jsonb_typeof(m.media) = 'object' AND NOT (m.media ? 'download_error')
    AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.type = 'media.download' AND j.status IN ('queued', 'running')
                    AND j.payload->>'messageId' = m.id::text);
-- Conversations a person answered after the bot's last step (or where it never ran): the menu bot
-- must not start in them (it now needs bot_state.done, which older versions only set once the bot
-- had run). A bot restarted after the reply (the customer typed 'menú') keeps going.
UPDATE contacts c SET bot_state = jsonb_set(COALESCE(c.bot_state, '{"path":[]}'::jsonb), '{done}', 'true')
  WHERE COALESCE(c.bot_state->>'done', 'false') <> 'true'
    AND EXISTS (SELECT 1 FROM messages m WHERE m.contact_id = c.id AND m.direction = 'out' AND m.sent_by IN ('user', 'phone')
                AND m.created_at > COALESCE(CASE WHEN c.bot_state->>'updated_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$'
                                                 THEN (c.bot_state->>'updated_at')::timestamptz END, '-infinity'));
-- Contacts an earlier version pointed back at the number the customer had left (a late status of a
-- message sent before the change): replies went to the old number and its new holder's messages
-- landed in their chat. Back to the number they moved to.
UPDATE contacts c SET wa_id = c.phone, updated_at = now()
  WHERE c.wa_id IS NOT NULL AND c.wa_id <> c.phone
    AND EXISTS (SELECT 1 FROM contact_events e WHERE e.contact_id = c.id AND e.type = 'number_changed'
                AND e.data->>'moved' = 'true' AND e.data->>'old_wa_id' = c.wa_id)
    AND NOT EXISTS (SELECT 1 FROM contact_events e WHERE e.contact_id = c.id AND e.type = 'number_changed'
                    AND e.data->>'moved' = 'true' AND e.data->>'new_wa_id' = c.wa_id)
    AND NOT EXISTS (SELECT 1 FROM contacts o WHERE o.workspace_id = c.workspace_id AND o.wa_id = c.phone AND o.id <> c.id);
-- Template webhooks are applied in the order Meta raised them (entry.time): a redelivered or retried
-- older event must not undo a newer one.
ALTER TABLE templates ADD COLUMN IF NOT EXISTS status_event_at timestamptz;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS category_event_at timestamptz;
`;

export const migrations: { name: string; sql: string }[] = [
  { name: '001_init', sql: init },
  { name: '002_rate_card_seed', sql: seedRates },
  { name: '003_wamid_per_workspace', sql: wamidPerWorkspace },
  { name: '004_hardening', sql: hardening },
  { name: '005_review_three', sql: reviewThree },
  { name: '006_review_four', sql: reviewFour },
];
