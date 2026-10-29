import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { Channel, Funnel, Member, QuickReply, Tag, Template, Workspace } from './types';

/** Shared reference data used across pages (cached by React Query). */

export function useWorkspace() {
  return useQuery({
    queryKey: ['workspace'],
    queryFn: () => api.get<{ workspace: Workspace; role: string; ai_models: { id: string; label: string }[] }>('/api/workspace'),
  });
}

export function useFunnels() {
  return useQuery({ queryKey: ['funnels'], queryFn: async () => (await api.get<{ funnels: Funnel[] }>('/api/funnels')).funnels });
}

export function useTags() {
  return useQuery({ queryKey: ['tags'], queryFn: async () => (await api.get<{ tags: Tag[] }>('/api/tags')).tags });
}

export function useMembers() {
  return useQuery({ queryKey: ['members'], queryFn: async () => (await api.get<{ members: Member[] }>('/api/workspace/members')).members });
}

export function useChannels() {
  return useQuery({ queryKey: ['channels'], queryFn: async () => (await api.get<{ channels: Channel[] }>('/api/channels')).channels });
}

/**
 * The number used when none is chosen: the default one, or the first, among those that can send.
 * Same rule as the server (getChannel skips disabled numbers), so estimates, template lists and
 * sends all use the number that will really send.
 */
export function defaultChannel(channels: Channel[] | undefined): Channel | undefined {
  const usable = (channels ?? []).filter((c) => c.status !== 'disabled');
  return usable.find((c) => c.is_default) ?? usable[0];
}

/**
 * The number whose data a page shows when none is chosen: the sending default, else any number.
 * Only sends skip disabled numbers; a disabled number (e.g. right after the switch to prepaid)
 * still has its templates, and hiding them would look like no number is connected.
 */
export function viewedChannel(channels: Channel[] | undefined): Channel | undefined {
  return defaultChannel(channels) ?? channels?.find((c) => c.is_default) ?? channels?.[0];
}

export function useTemplates(channelId?: string) {
  return useQuery({
    queryKey: ['templates', channelId ?? 'all'],
    queryFn: async () => (await api.get<{ templates: Template[] }>(`/api/templates${channelId ? `?channel_id=${channelId}` : ''}`)).templates,
  });
}

export function useQuickReplies() {
  return useQuery({
    queryKey: ['quick-replies'],
    queryFn: async () => (await api.get<{ quick_replies: QuickReply[] }>('/api/quick-replies')).quick_replies,
  });
}

export function useCredits() {
  return useQuery({
    queryKey: ['credits'],
    queryFn: () =>
      api.get<{
        billing_mode: 'meta_direct' | 'prepaid';
        balance: number;
        spent_this_month: number;
        spent_total: number;
        billable_messages_this_month: number;
        by_category: { category: string; messages: number; cost: number }[];
      }>('/api/credits'),
  });
}

/** Lookup helpers. */
export function stageMap(funnels: Funnel[] | undefined) {
  const m = new Map<string, { stage: Funnel['stages'][number]; funnel: Funnel }>();
  for (const f of funnels ?? []) for (const s of f.stages) m.set(s.id, { stage: s, funnel: f });
  return m;
}
