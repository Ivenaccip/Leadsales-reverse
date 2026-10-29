import { useEffect } from 'react';
import { useQuery, useQueryClient, type Query, type QueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';
import type { Channel, Contact, Funnel, Member, QuickReply, Tag, Template, Workspace } from './types';

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

const channelsQuery = { queryKey: ['channels'], queryFn: async () => (await api.get<{ channels: Channel[] }>('/api/channels')).channels };

export function useChannels() {
  return useQuery(channelsQuery);
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

/**
 * The number that sends to a contact: the one its conversation is on, else the default one. A
 * conversation on a disabled number cannot be answered (the server refuses, and never moves the
 * customer to another number by itself): then there is no id, and `disabled` is that number.
 */
export function contactChannel(
  contact: Pick<Contact, 'channel_id'> | undefined,
  channels: Channel[] | undefined,
): { id: string | undefined; disabled: Channel | null } {
  if (!contact?.channel_id) return { id: defaultChannel(channels)?.id, disabled: null };
  const own = channels?.find((c) => c.id === contact.channel_id);
  return own?.status === 'disabled' ? { id: undefined, disabled: own } : { id: contact.channel_id, disabled: null };
}

/** How often a conversation blocked by its disabled number checks whether it is back. */
export const CHANNEL_RECHECK_MS = 30_000;

/**
 * The list of numbers as a conversation watches it. Nothing announces a number being reactivated
 * elsewhere (Ajustes in another tab, another admin), and while the list says the conversation's
 * number is disabled the composer sends nothing that could fail and reload it: so until that number
 * is back, keep re-checking the list instead of trusting a cache that would never refresh.
 */
export function contactChannelQuery(contact: Pick<Contact, 'channel_id'> | undefined) {
  const blocked = (q: Query<Channel[], Error, Channel[], string[]>) => !!contactChannel(contact, q.state.data).disabled;
  return {
    ...channelsQuery,
    refetchInterval: (q: Query<Channel[], Error, Channel[], string[]>) => (blocked(q) ? CHANNEL_RECHECK_MS : false),
    refetchOnWindowFocus: (q: Query<Channel[], Error, Channel[], string[]>) => (blocked(q) ? ('always' as const) : false),
  };
}

export function useContactChannel(contact: Pick<Contact, 'channel_id'> | undefined) {
  const channels = useQuery(contactChannelQuery(contact));
  return contactChannel(contact, channels.data);
}

/**
 * After a send fails with NO_CHANNEL, reloads the numbers: the conversation's own may have been
 * disabled since they were loaded, which nothing announces. True when it now shows as disabled, so
 * the caller lets its notice name that number instead of the server's generic "Conecta un número".
 */
export async function recheckContactChannel(qc: QueryClient, contact: Pick<Contact, 'channel_id'>, err: unknown): Promise<boolean> {
  if (!(err instanceof ApiError && err.code === 'NO_CHANNEL')) return false;
  await qc.invalidateQueries({ queryKey: ['channels'] });
  return !!contactChannel(contact, qc.getQueryData<Channel[]>(['channels'])).disabled;
}

/** Reloads the numbers each time a dialog that sends opens, so it never offers a number disabled since. */
export function useRecheckChannels(open: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (open) void qc.invalidateQueries({ queryKey: ['channels'] });
  }, [open, qc]);
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
