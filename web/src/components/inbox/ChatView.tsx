import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { api } from '../../lib/api';
import { dayLabel, displayName, formatPhone, windowRemaining } from '../../lib/format';
import { stageMap, useFunnels, useMembers } from '../../lib/queries';
import type { Contact, Message } from '../../lib/types';
import { Avatar, Button, IconButton, Spinner } from '../ui';
import { Composer } from './Composer';
import { LIVE_QUERY, messagesPath, olderMessagesCursor, patchConversations, upsertMessage, whenVisible, type MessagesPage } from './helpers';
import { MessageBubble } from './MessageBubble';
import { ScheduleModal, SendTemplateModal } from './TemplateModals';

const PAGE = 60;

/** Re-renders every minute so the 24h window countdown stays accurate. */
function useMinuteTick() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
}

/** Render with key={contact.id}: scroll state and the composer reset per conversation. */
export function ChatView({
  contact,
  myId,
  panelOpen,
  onTogglePanel,
  onBack,
}: {
  contact: Contact;
  myId: string | undefined;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onBack: () => void;
}) {
  useMinuteTick();
  const qc = useQueryClient();
  const funnels = useFunnels();
  const members = useMembers();
  const memberName = useMemo(() => new Map((members.data ?? []).map((m) => [m.id, m.name])), [members.data]);
  const stage = contact.stage_id ? stageMap(funnels.data).get(contact.stage_id)?.stage : undefined;
  const [templateOpen, setTemplateOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const messages = useInfiniteQuery({
    queryKey: ['messages', contact.id],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.get<MessagesPage>(messagesPath(contact.id, PAGE, pageParam)),
    getNextPageParam: olderMessagesCursor,
    ...LIVE_QUERY,
  });

  // Pages arrive newest-first; each page is in chronological order.
  const list = useMemo(() => [...(messages.data?.pages ?? [])].reverse().flatMap((p) => p.messages), [messages.data]);

  // Mark as read when the open chat has unread messages (also when new ones arrive while it is open),
  // once the agent can see it: messages that arrived in a background tab are read on coming back.
  const unread = contact.unread_count;
  const latest = useRef(contact);
  latest.current = contact;
  useEffect(() => {
    if (unread <= 0) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const cancel = whenVisible(document, () => {
      t = setTimeout(() => {
        void api
          .post(`/api/contacts/${contact.id}/read`)
          .then(() => {
            qc.invalidateQueries({ queryKey: ['contact-counts'] });
          })
          .catch(() => {});
        // The contact may have changed while the tab was hidden: patch its latest version.
        patchConversations(qc, { ...latest.current, unread_count: 0 }, myId);
      }, 400);
    });
    return () => {
      cancel();
      clearTimeout(t);
    };
  }, [contact.id, unread]);

  // ---- Scrolling ----
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const firstId = list[0]?.id;
  const lastMsg = list[list.length - 1];
  const prevFirst = useRef<{ id?: string; height: number }>({ height: 0 });
  const prevLast = useRef<string | undefined>(undefined);

  // Keep the viewport stable when older messages are prepended.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const before = prevFirst.current;
    if (before.id && firstId && before.id !== firstId && prevLast.current === lastMsg?.id) {
      el.scrollTop += el.scrollHeight - before.height;
    }
    prevFirst.current = { id: firstId, height: el.scrollHeight };
  }, [firstId, lastMsg?.id]);

  // Stick to the bottom on new messages (always for our own).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !lastMsg) return;
    const changed = prevLast.current !== lastMsg.id;
    const firstLoad = prevLast.current === undefined;
    prevLast.current = lastMsg.id;
    if (!changed) return;
    if (firstLoad || nearBottom.current || lastMsg.direction !== 'in') {
      el.scrollTop = el.scrollHeight;
      setShowJump(false);
    } else {
      setShowJump(true);
    }
    prevFirst.current = { id: firstId, height: el.scrollHeight };
  }, [lastMsg, firstId]);

  // Images and media change the height after they load: stay pinned to the bottom if we were there.
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (nearBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [messages.isLoading]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom.current) setShowJump(false);
    if (el.scrollTop < 80 && messages.hasNextPage && !messages.isFetchingNextPage) void messages.fetchNextPage();
  }

  function onSent(m: Message) {
    upsertMessage(qc, m);
    if (m.direction !== 'internal') {
      patchConversations(qc, { ...contact, last_message_at: m.created_at, last_message_preview: m.body ?? contact.last_message_preview, unread_count: 0 }, myId);
    }
    qc.invalidateQueries({ queryKey: ['contact', contact.id] });
  }

  const remaining = windowRemaining(contact.last_inbound_at);
  const windowOpen = remaining > 0;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-3 py-2.5">
        <IconButton title="Volver" className="lg:hidden" onClick={onBack}>
          <ArrowLeft className="h-5 w-5" />
        </IconButton>
        <Avatar name={contact.name ?? contact.phone} seed={contact.id} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-slate-900">{displayName(contact)}</p>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
            <span>{formatPhone(contact.phone)}</span>
            {stage && (
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ background: stage.color }} />
                {stage.name}
              </span>
            )}
            {contact.assigned_user_id && <span>· {memberName.get(contact.assigned_user_id) ?? 'Asignado'}</span>}
            {contact.opted_out && <span className="text-red-600">· Dado de baja</span>}
          </p>
        </div>
        <IconButton title={panelOpen ? 'Ocultar detalles' : 'Ver detalles del contacto'} onClick={onTogglePanel}>
          {panelOpen ? <PanelRightClose className="h-5 w-5" /> : <PanelRightOpen className="h-5 w-5" />}
        </IconButton>
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="chat-bg scroll-thin absolute inset-0 overflow-y-auto px-3 py-4 sm:px-6">
          {messages.isLoading ? (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          ) : (
            <div ref={contentRef} className="mx-auto flex max-w-3xl flex-col gap-1.5">
              {messages.hasNextPage ? (
                <div className="flex justify-center pb-2">
                  <Button size="sm" variant="outline" loading={messages.isFetchingNextPage} onClick={() => void messages.fetchNextPage()}>
                    Cargar mensajes anteriores
                  </Button>
                </div>
              ) : (
                list.length > 0 && (
                  <p className="mx-auto mb-2 rounded-lg bg-amber-50/90 px-3 py-1.5 text-center text-xs text-amber-800 shadow-sm">
                    Inicio de la conversación con {displayName(contact)}
                  </p>
                )
              )}
              {list.length === 0 && <p className="py-10 text-center text-sm text-slate-500">Aún no hay mensajes con este contacto.</p>}
              {list.map((m, i) => {
                const prev = list[i - 1];
                const newDay = !prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString();
                return (
                  <Fragment key={m.id}>
                    {newDay && (
                      <div className="my-2 flex justify-center">
                        <span className="rounded-lg bg-white/90 px-3 py-1 text-xs font-medium capitalize text-slate-500 shadow-sm">{dayLabel(m.created_at)}</span>
                      </div>
                    )}
                    <MessageBubble m={m} senderName={m.user_name ?? (m.user_id ? memberName.get(m.user_id) : null)} />
                  </Fragment>
                );
              })}
            </div>
          )}
        </div>
        {showJump && (
          <button
            type="button"
            onClick={() => {
              const el = scrollRef.current;
              if (el) el.scrollTop = el.scrollHeight;
              setShowJump(false);
            }}
            className="absolute bottom-4 right-6 inline-flex items-center gap-1 rounded-full bg-white px-3 py-2 text-xs font-medium text-brand-700 shadow-lg ring-1 ring-slate-200"
          >
            <ArrowDown className="h-4 w-4" /> Nuevos mensajes
          </button>
        )}
      </div>

      <Composer
        contact={contact}
        windowOpen={windowOpen}
        remainingMs={remaining}
        onSent={onSent}
        onOpenTemplate={() => setTemplateOpen(true)}
        onOpenSchedule={() => setScheduleOpen(true)}
      />

      <SendTemplateModal open={templateOpen} onClose={() => setTemplateOpen(false)} contact={contact} onSent={onSent} />
      <ScheduleModal
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        contact={contact}
        windowOpen={windowOpen}
        onScheduled={() => qc.invalidateQueries({ queryKey: ['contact', contact.id] })}
      />
    </div>
  );
}
