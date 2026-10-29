export type Role = 'owner' | 'admin' | 'agent';

export interface WorkspaceRow {
  id: string;
  name: string;
  timezone: string;
  default_country_code: string;
  billing_mode: 'meta_direct' | 'prepaid';
  credit_balance: number;
  settings: WorkspaceSettings;
  is_active: boolean;
  created_at: Date;
}

export interface ChannelRow {
  id: string;
  workspace_id: string;
  provider: 'cloud_api' | 'sandbox';
  name: string;
  display_phone: string | null;
  phone_number_id: string;
  waba_id: string | null;
  credentials: string | null;
  verify_token: string;
  status: string;
  last_error: string | null;
  is_default: boolean;
  /** Connected or re-keyed by the instance operator: the tenant does not know its app secret. */
  operator_verified?: boolean;
  created_at: Date;
}

export interface ContactRow {
  id: string;
  workspace_id: string;
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
  last_message_at: Date | null;
  last_message_preview: string | null;
  last_inbound_at: Date | null;
  unread_count: number;
  bot_state: BotState | null;
  ai_paused: boolean;
  last_away_at: Date | null;
  is_archived: boolean;
  opted_out: boolean;
  stage_changed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface MessageRow {
  id: string;
  workspace_id: string;
  contact_id: string;
  channel_id: string | null;
  direction: 'in' | 'out' | 'internal';
  type: string;
  body: string | null;
  media_file_id: string | null;
  media: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
  wamid: string | null;
  reply_to_wamid: string | null;
  status: string;
  error: { code?: number | null; title?: string; message?: string } | null;
  sent_by: string | null;
  user_id: string | null;
  broadcast_id: string | null;
  billing_category: string | null;
  cost: number;
  pricing_reconciled: boolean;
  /** The prepaid wallet pays for this message (workspace was prepaid when it was sent): refunds/adjustments touch the balance only then. */
  charged_prepaid?: boolean;
  /** False while the work queued after storing/updating the message (jobs, webhooks) is not committed yet. */
  followups_done?: boolean;
  created_at: Date;
  status_updated_at: Date | null;
}

export interface BotState {
  path: string[];
  done?: boolean;
  updated_at?: string;
}

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
  automation_mode?: 'off' | 'menu' | 'ai';
  welcome?: { enabled: boolean; text: string };
  away?: {
    enabled: boolean;
    text: string;
    /** Weekday 0 (domingo) .. 6 (sábado) -> list of [from, to] "HH:MM". */
    hours: Record<string, [string, string][]>;
  };
  bot?: {
    menu: BotMenu;
    fallback: string;
    handoff_message: string;
    interactive: boolean;
    only_unassigned: boolean;
  };
  ai?: {
    model: string;
    api_key_enc?: string | null;
    instructions: string;
    knowledge: string;
    handoff_message: string;
    only_unassigned: boolean;
    max_replies: number;
  };
  agent_visibility?: 'all' | 'assigned';
}
