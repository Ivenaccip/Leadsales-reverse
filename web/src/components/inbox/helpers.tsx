import { Fragment, type ReactNode } from 'react';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type { Contact, Message, Paged } from '../../lib/types';

// ---------- WhatsApp text formatting (safe: builds React nodes, never raw HTML) ----------

const TOKEN = /(```[\s\S]+?```|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|https?:\/\/[^\s<]+)/g;

function formatInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(TOKEN)) {
    const tok = m[0];
    const start = m.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const key = `${keyPrefix}-${i++}`;
    if (tok.startsWith('```')) {
      out.push(
        <code key={key} className="rounded bg-black/5 px-1 font-mono text-[0.85em]">
          {tok.slice(3, -3)}
        </code>,
      );
    } else if (tok.startsWith('*')) {
      out.push(<strong key={key}>{formatInline(tok.slice(1, -1), key)}</strong>);
    } else if (tok.startsWith('_')) {
      out.push(<em key={key}>{formatInline(tok.slice(1, -1), key)}</em>);
    } else if (tok.startsWith('~')) {
      out.push(<s key={key}>{formatInline(tok.slice(1, -1), key)}</s>);
    } else {
      // URL: trim trailing punctuation that is usually not part of the link
      const url = tok.replace(/[),.;:!?]+$/, '');
      out.push(
        <a key={key} href={url} target="_blank" rel="noopener noreferrer" className="break-all text-sky-700 underline">
          {url}
        </a>,
      );
      if (url.length < tok.length) out.push(tok.slice(url.length));
    }
    last = start + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function WaText({ text, className }: { text: string | null | undefined; className?: string }) {
  if (!text) return null;
  return (
    <span className={className ?? 'wa-text whitespace-pre-wrap break-words'}>
      {text.split('\n').map((line, i, arr) => (
        <Fragment key={i}>
          {formatInline(line, `l${i}`)}
          {i < arr.length - 1 && '\n'}
        </Fragment>
      ))}
    </span>
  );
}

// ---------- Previews and labels ----------

const TYPE_LABEL: Record<string, string> = {
  image: '📷 Imagen',
  video: '🎬 Video',
  audio: '🎤 Audio',
  document: '📄 Documento',
  sticker: '💟 Sticker',
  location: '📍 Ubicación',
  contacts: '👤 Contacto',
  template: '📋 Plantilla',
  reaction: 'Reacción',
  order: '🛒 Pedido',
};

export function previewFor(type: string, body: string | null | undefined): string {
  const text = (body ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 120);
  return TYPE_LABEL[type] ?? 'Mensaje';
}

export const SENT_BY_LABEL: Record<string, string> = {
  bot: '🤖 Bot',
  ai: '✨ IA',
  broadcast: '📣 Difusión',
  scheduled: '⏰ Programado',
  api: '🔌 API',
  system: '⚙️ Automático',
  phone: '📱 Desde el teléfono',
};

/** Client-side version of the server placeholders, for quick replies inserted into the composer. */
export function renderPlaceholders(text: string, c: Pick<Contact, 'name' | 'phone' | 'email' | 'company' | 'custom_fields'>): string {
  const known = new Set(['nombre', 'primer_nombre', 'telefono', 'correo', 'empresa']);
  return text.replace(/\{([a-z_]+(?:\.[A-Za-z0-9_]+)?)(?:\|([^}]*))?\}/g, (match, key: string, def?: string) => {
    if (!known.has(key) && !key.startsWith('campo.')) return match;
    let v = '';
    if (key === 'nombre') v = c.name ?? '';
    else if (key === 'primer_nombre') v = (c.name ?? '').trim().split(/\s+/)[0] ?? '';
    else if (key === 'telefono') v = `+${c.phone}`;
    else if (key === 'correo') v = c.email ?? '';
    else if (key === 'empresa') v = c.company ?? '';
    else v = String((c.custom_fields ?? {})[key.slice(6)] ?? '');
    return v.trim() || def || '';
  });
}

// ---------- Attachments ----------

/** WhatsApp message type for an uploaded file (same rule as the server's waTypeForMime). */
export function waTypeForMime(mime: string): 'image' | 'video' | 'audio' | 'document' | 'sticker' {
  const m = mime.split(';')[0].trim().toLowerCase();
  if (m === 'image/jpeg' || m === 'image/png') return 'image';
  if (m === 'image/webp') return 'sticker';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'document';
}

export const CAPTION_MAX = 1024;

/**
 * File picker filter matching the server's upload allow-list (the WhatsApp Cloud API media types,
 * services/media.ts WA_MEDIA_LIMITS). Extensions cover browsers that report other MIME names
 * for the same audio files (audio/x-m4a, audio/mp3), which the server maps to the allowed ones.
 */
export const WA_MEDIA_ACCEPT = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/3gpp',
  'audio/aac',
  'audio/amr',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  '.mp3',
  '.m4a',
  '.aac',
  '.amr',
  '.ogg',
  'application/pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.txt',
].join(',');

/** What to tell the agent about a send that did not plainly succeed, or null when it went out. */
export function sendProblem(m: Pick<Message, 'status' | 'error'>): string | null {
  if (m.status === 'failed') return m.error?.message ?? 'WhatsApp rechazó el mensaje';
  // Meta may have it: say so, because resending could deliver it twice.
  if (m.status === 'unknown') return m.error?.message ?? 'No pudimos confirmar si WhatsApp recibió el mensaje. Revisa en unos minutos antes de reenviarlo.';
  return null;
}

export type SendPayload = { type: 'text'; text: string } | { type: 'media'; media_file_id: string; caption?: string };

/**
 * Requests that send an attachment plus the typed text. WhatsApp audios and stickers cannot carry
 * text and captions are capped, so then the text goes as its own message right after the file.
 */
export function mediaSendPlan(mediaId: string, mime: string, text: string): SendPayload[] {
  if (!text) return [{ type: 'media', media_file_id: mediaId }];
  const kind = waTypeForMime(mime);
  if (kind !== 'audio' && kind !== 'sticker' && text.length <= CAPTION_MAX) return [{ type: 'media', media_file_id: mediaId, caption: text }];
  return [
    { type: 'media', media_file_id: mediaId },
    { type: 'text', text },
  ];
}

// ---------- Conversation list filters & cache patching ----------

export type InboxTab = 'all' | 'mine' | 'unassigned';

export interface ConversationFilters {
  inbox: InboxTab;
  search: string;
  unread: boolean;
  tag_id: string;
  stage_id: string;
}

/**
 * Socket events patch the inbox caches only while the inbox is mounted and connected, so these
 * queries refetch whenever they are shown again (messages may have arrived on another page).
 */
export const LIVE_QUERY = { refetchOnMount: 'always', refetchOnWindowFocus: 'always' } as const;

export type ConversationsData = InfiniteData<Paged<Contact>, number>;
export type MessagesData = InfiniteData<{ messages: Message[]; has_more: boolean }, string | undefined>;

export function matchesFilters(c: Contact, f: ConversationFilters, myId: string | undefined): boolean {
  if (!c.last_message_at || c.is_archived) return false;
  if (f.inbox === 'mine' && c.assigned_user_id !== myId) return false;
  if (f.inbox === 'unassigned' && c.assigned_user_id) return false;
  if (f.unread && c.unread_count <= 0) return false;
  if (f.tag_id && !c.tag_ids.includes(f.tag_id)) return false;
  if (f.stage_id && c.stage_id !== f.stage_id) return false;
  if (f.search.trim()) {
    const q = f.search.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    const hit =
      (c.name ?? '').toLowerCase().includes(q) ||
      (c.email ?? '').toLowerCase().includes(q) ||
      (c.company ?? '').toLowerCase().includes(q) ||
      (digits.length >= 3 && c.phone.includes(digits));
    if (!hit) return false;
  }
  return true;
}

function upsertInto(data: ConversationsData, contact: Contact, filters: ConversationFilters, myId: string | undefined): ConversationsData {
  let previous: Contact | undefined;
  const pages = data.pages.map((p) => {
    const found = p.items.find((x) => x.id === contact.id);
    if (found) previous = found;
    return found ? { ...p, items: p.items.filter((x) => x.id !== contact.id) } : p;
  });
  if (!matchesFilters(contact, filters, myId)) {
    if (!previous) return data;
    return { ...data, pages: pages.map((p, i) => (i === 0 ? { ...p, total: Math.max(0, p.total - 1) } : p)) };
  }
  const moved = !previous || (contact.last_message_at ?? '') > (previous.last_message_at ?? '');
  if (!moved && previous) {
    // keep the position, only refresh the data
    return { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.map((x) => (x.id === contact.id ? contact : x)) })) };
  }
  const first = pages[0];
  if (!first) return data;
  return {
    ...data,
    pages: [{ ...first, items: [contact, ...first.items], total: first.total + (previous ? 0 : 1) }, ...pages.slice(1)],
  };
}

/** Applies a contact change to every cached conversation list (each list knows its own filters). */
export function patchConversations(qc: QueryClient, contact: Contact, myId: string | undefined) {
  for (const [key, data] of qc.getQueriesData<ConversationsData>({ queryKey: ['conversations'] })) {
    if (!data) continue;
    const filters = key[1] as ConversationFilters;
    qc.setQueryData<ConversationsData>(key, upsertInto(data, contact, filters, myId));
  }
}

export function removeConversations(qc: QueryClient, ids: string[]) {
  const set = new Set(ids);
  for (const [key, data] of qc.getQueriesData<ConversationsData>({ queryKey: ['conversations'] })) {
    if (!data) continue;
    qc.setQueryData<ConversationsData>(key, { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.filter((c) => !set.has(c.id)) })) });
  }
}

/** The conversation is no longer visible to this user: drop it from every cache. */
export function revokeContact(qc: QueryClient, id: string) {
  removeConversations(qc, [id]);
  qc.removeQueries({ queryKey: ['contact', id] });
  qc.removeQueries({ queryKey: ['messages', id] });
  void qc.invalidateQueries({ queryKey: ['contact-counts'] });
  void qc.invalidateQueries({ queryKey: ['contacts'] });
  void qc.invalidateQueries({ queryKey: ['board'] });
}

/** Finds a contact in any cached list (used to patch previews on new messages). */
export function findCachedContact(qc: QueryClient, id: string): Contact | undefined {
  for (const [, data] of qc.getQueriesData<ConversationsData>({ queryKey: ['conversations'] })) {
    for (const p of data?.pages ?? []) {
      const c = p.items.find((x) => x.id === id);
      if (c) return c;
    }
  }
  const detail = qc.getQueryData<{ contact: Contact }>(['contact', id]);
  return detail?.contact;
}

/** Merges a message into the cached chat of its contact; appends it when new (unless append is false). */
export function upsertMessage(qc: QueryClient, msg: Message, append = true) {
  qc.setQueryData<MessagesData>(['messages', msg.contact_id], (data) => {
    if (!data || !data.pages.length) return data;
    let found = false;
    const pages = data.pages.map((p) => ({
      ...p,
      messages: p.messages.map((m) => {
        if (m.id !== msg.id) return m;
        found = true;
        return { ...m, ...msg, status: newerStatus(m.status, msg.status) as Message['status'], file_mime: msg.file_mime ?? m.file_mime, file_name: msg.file_name ?? m.file_name, user_name: msg.user_name ?? m.user_name };
      }),
    }));
    if (found || !append) return found ? { ...data, pages } : data;
    const [first, ...rest] = pages;
    return { ...data, pages: [{ ...first, messages: [...first.messages, msg] }, ...rest] };
  });
}

/** Status tick ordering: never downgrade a status we already showed. */
const RANK: Record<string, number> = { pending: 0, unknown: 1, sent: 2, delivered: 3, read: 4, failed: 5 };
export function newerStatus(a: string, b: string) {
  if (b === 'failed') return a === 'read' ? a : b;
  return (RANK[b] ?? 0) >= (RANK[a] ?? 0) ? b : a;
}
