export type Role = 'owner' | 'admin' | 'agent';

export interface User {
  id: string;
  email: string;
  name: string;
  is_superadmin: boolean;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: Role;
  billing_mode: BillingMode;
  is_active: boolean;
}

export type BillingMode = 'meta_direct' | 'prepaid';

export interface BotMenuOption {
  key: string;
  label: string;
  reply?: string;
  stage_id?: string | null;
  tag_ids?: string[];
  assign_user_id?: string | null;
  handoff?: boolean;
  submenu?: BotMenu | null;
}

export interface BotMenu {
  prompt: string;
  options: BotMenuOption[];
}

export interface WorkspaceSettings {
  automation_mode: 'off' | 'menu' | 'ai';
  agent_visibility: 'all' | 'assigned';
  welcome: { enabled: boolean; text: string };
  away: { enabled: boolean; text: string; hours: Record<string, [string, string][]> };
  bot: { menu: BotMenu; fallback: string; handoff_message: string; interactive: boolean; only_unassigned: boolean };
  ai: {
    model: string;
    has_api_key: boolean;
    instructions: string;
    knowledge: string;
    handoff_message: string;
    only_unassigned: boolean;
    max_replies: number;
  };
}

export interface Workspace {
  id: string;
  name: string;
  timezone: string;
  default_country_code: string;
  billing_mode: BillingMode;
  credit_balance: number;
  settings: WorkspaceSettings;
  is_active: boolean;
  created_at: string;
}

export interface Member {
  id: string;
  email: string;
  name: string;
  role: Role;
  is_active: boolean;
  receives_leads: boolean;
  last_assigned_at: string | null;
  created_at: string;
}

export interface Channel {
  id: string;
  provider: 'cloud_api' | 'sandbox';
  name: string;
  display_phone: string | null;
  phone_number_id: string;
  waba_id: string | null;
  verify_token: string;
  status: string;
  last_error: string | null;
  is_default: boolean;
  has_access_token: boolean;
  has_app_secret: boolean;
  /** Credentials typed by the instance operator in prepaid mode (only such numbers work there). */
  operator_verified: boolean;
  webhook_url: string;
  created_at: string;
}

export interface Stage {
  id: string;
  funnel_id: string;
  name: string;
  color: string;
  position: number;
  kind: 'open' | 'won' | 'lost';
  contact_count?: number;
}

export interface Funnel {
  id: string;
  name: string;
  position: number;
  auto_assign: boolean;
  assignee_ids: string[];
  is_default: boolean;
  stages: Stage[];
}

export interface Tag {
  id: string;
  name: string;
  color: string;
  contact_count?: number;
}

export interface Contact {
  id: string;
  phone: string;
  wa_id: string | null;
  name: string | null;
  email: string | null;
  company: string | null;
  channel_id: string | null;
  funnel_id: string | null;
  stage_id: string | null;
  assigned_user_id: string | null;
  deal_value: number;
  custom_fields: Record<string, unknown>;
  source: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  last_inbound_at: string | null;
  unread_count: number;
  bot_state: { path: string[]; done?: boolean } | null;
  ai_paused: boolean;
  is_archived: boolean;
  opted_out: boolean;
  stage_changed_at: string | null;
  created_at: string;
  updated_at: string;
  tag_ids: string[];
}

export interface Message {
  id: string;
  contact_id: string;
  channel_id: string | null;
  direction: 'in' | 'out' | 'internal';
  type: string;
  body: string | null;
  media_file_id: string | null;
  media: Record<string, any> | null;
  payload: Record<string, any> | null;
  wamid: string | null;
  reply_to_wamid: string | null;
  /** 'unknown': sent, but Meta's answer was lost (error explains it); a status webhook may still settle it. */
  status: 'pending' | 'unknown' | 'sent' | 'delivered' | 'read' | 'failed' | 'received' | 'note';
  error: {
    code?: number | null;
    title?: string;
    message?: string;
    /** The send never reached Meta (network failure): nothing went out and its charge was refunded. */
    network?: boolean;
    /** A broadcast or scheduled send retries it by itself, as this same message: do not resend it by hand. */
    auto_retry?: boolean;
  } | null;
  sent_by: string | null;
  user_id: string | null;
  user_name?: string | null;
  broadcast_id: string | null;
  billing_category: string | null;
  cost: number;
  created_at: string;
  file_mime?: string | null;
  file_name?: string | null;
  file_size?: number | null;
}

export interface ContactEvent {
  id: string;
  type: string;
  data: Record<string, any>;
  user_id: string | null;
  user_name: string | null;
  created_at: string;
}

export interface TemplateInputs {
  header: { type: 'text' | 'image' | 'video' | 'document' | 'location'; variables: string[] } | null;
  body: string[];
  buttons: { index: number; type: string; text: string; variables: string[] }[];
  /** Why the server cannot send this template (Spanish), or null. */
  unsupported?: string | null;
}

export interface Template {
  id: string;
  channel_id: string;
  meta_id: string | null;
  name: string;
  language: string;
  category: string;
  status: string;
  components: any[];
  parameter_format: string | null;
  rejected_reason: string | null;
  updated_at: string;
  inputs: TemplateInputs;
}

export interface LocationHeaderParam {
  type: 'location';
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}

/** Button parameter kind; omitted means a URL suffix. */
export type TemplateButtonSubType = 'url' | 'copy_code';

export interface TemplateParams {
  header?: { type: 'text'; text: string } | { type: 'image' | 'video' | 'document'; link: string; filename?: string } | LocationHeaderParam;
  body?: string[];
  bodyNamed?: Record<string, string>;
  buttons?: { index: number; text: string; sub_type?: TemplateButtonSubType }[];
}

export interface QuickReply {
  id: string;
  shortcut: string;
  title: string | null;
  body: string;
  media_file_id: string | null;
  media_mime?: string | null;
  media_filename?: string | null;
}

export interface Audience {
  funnel_id?: string | null;
  stage_ids?: string[];
  tag_ids?: string[];
  exclude_tag_ids?: string[];
  assigned_user_id?: string | null;
  created_from?: string | null;
  created_to?: string | null;
  contact_ids?: string[];
}

export interface BroadcastParams {
  header?: { type: 'text'; value: string } | { type: 'image' | 'video' | 'document'; link: string; filename?: string } | LocationHeaderParam;
  body?: string[];
  bodyNamed?: Record<string, string>;
  buttons?: { index: number; value: string; sub_type?: TemplateButtonSubType }[];
}

export interface BroadcastStats {
  total: number;
  queued: number;
  skipped: number;
  failed: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  cost: number;
}

export interface Broadcast {
  id: string;
  channel_id: string | null;
  name: string;
  template_name: string;
  template_language: string;
  template_category: string;
  params: BroadcastParams;
  audience: Audience;
  status: 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'cancelled';
  scheduled_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
  total_recipients: number;
  estimated_cost: number;
  created_at: string;
  stats: BroadcastStats;
}

export interface Estimate {
  recipients: number;
  category: string;
  cost: number;
  by_market: { market: string; count: number; unit_price: number; cost: number }[];
  billing_mode: BillingMode;
  balance: number;
  sufficient: boolean;
}

export interface ScheduledMessage {
  id: string;
  contact_id: string;
  content: { type: 'text'; text: string } | { type: 'template'; name: string; language: string; params?: TemplateParams };
  send_at: string;
  status: string;
  error: string | null;
  contact_name?: string | null;
  contact_phone?: string;
  created_by_name?: string | null;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  /** GET /api/contacts with sort=recent: pass as `cursor` for the next page (null on the last one). */
  next_cursor?: string | null;
}
