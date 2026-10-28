import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, MessagesSquare, SearchX, StickyNote, Zap } from 'lucide-react';
import { api } from '../lib/api';
import { useRealtime } from '../lib/realtime';
import { useSession } from '../lib/session';
import type { Contact, Message } from '../lib/types';
import { ChatView } from '../components/inbox/ChatView';
import { ContactPanel, type ContactDetail } from '../components/inbox/ContactPanel';
import { ConversationList } from '../components/inbox/ConversationList';
import { findCachedContact, patchConversations, previewFor, removeConversations, upsertMessage } from '../components/inbox/helpers';
import { Button, cx, EmptyState, PageLoader } from '../components/ui';

function NoChatSelected() {
  return (
    <div className="chat-bg flex flex-1 items-center justify-center p-6">
      <div className="max-w-sm rounded-2xl bg-white/90 p-6 text-center shadow-sm">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-brand-600">
          <MessagesSquare className="h-6 w-6" />
        </div>
        <p className="font-semibold text-slate-800">Selecciona una conversación</p>
        <p className="mt-1 text-sm text-slate-500">Todo tu equipo atiende desde el mismo número de WhatsApp, en tiempo real.</p>
        <ul className="mt-4 space-y-2 text-left text-xs text-slate-500">
          <li className="flex gap-2">
            <Zap className="h-4 w-4 shrink-0 text-brand-600" /> Escribe <b className="font-mono">/</b> para usar respuestas rápidas.
          </li>
          <li className="flex gap-2">
            <FileText className="h-4 w-4 shrink-0 text-brand-600" /> Pasadas 24 h sin respuesta del cliente, retoma con una plantilla.
          </li>
          <li className="flex gap-2">
            <StickyNote className="h-4 w-4 shrink-0 text-brand-600" /> Deja notas internas que solo ve tu equipo.
          </li>
        </ul>
      </div>
    </div>
  );
}

export default function InboxPage() {
  const { contactId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useSession();
  const myId = user?.id;
  const [panelOpen, setPanelOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 1280);

  const detail = useQuery({
    queryKey: ['contact', contactId],
    queryFn: () => api.get<ContactDetail>(`/api/contacts/${contactId}`),
    enabled: !!contactId,
  });

  // Counters are cheap but contact events can come in bursts: refresh them at most twice per second.
  const countsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function refreshCounts() {
    if (countsTimer.current) return;
    countsTimer.current = setTimeout(() => {
      countsTimer.current = null;
      void qc.invalidateQueries({ queryKey: ['contact-counts'] });
    }, 500);
  }

  useRealtime<Contact>('contact:new', (c) => {
    patchConversations(qc, c, myId);
    refreshCounts();
  });

  useRealtime<Contact>('contact:update', (c) => {
    patchConversations(qc, c, myId);
    const cached = qc.getQueryData<ContactDetail>(['contact', c.id]);
    if (cached) {
      const metaChanged =
        cached.contact.stage_id !== c.stage_id || cached.contact.assigned_user_id !== c.assigned_user_id || cached.contact.opted_out !== c.opted_out;
      qc.setQueryData<ContactDetail>(['contact', c.id], { ...cached, contact: c });
      // the history timeline only changes with these fields
      if (metaChanged) void qc.invalidateQueries({ queryKey: ['contact', c.id] });
    }
    refreshCounts();
  });

  useRealtime<{ action: string; ids: string[] }>('contacts:bulk', (e) => {
    if (e.action === 'delete') {
      removeConversations(qc, e.ids);
      if (contactId && e.ids.includes(contactId)) navigate('/bandeja');
    } else {
      void qc.invalidateQueries({ queryKey: ['conversations'] });
    }
    refreshCounts();
  });

  useRealtime<Message>('message:new', (m) => {
    upsertMessage(qc, m);
    // Inbound messages update the list through contact:update; outbound ones only emit message:new.
    if (m.direction === 'out') {
      const c = findCachedContact(qc, m.contact_id);
      if (c) patchConversations(qc, { ...c, last_message_at: m.created_at, last_message_preview: previewFor(m.type, m.body) }, myId);
    }
  });

  useRealtime<Message>('message:update', (m) => upsertMessage(qc, m, false));

  useRealtime<{ id: string; contact_id: string }>('scheduled:update', (e) => {
    void qc.invalidateQueries({ queryKey: ['contact', e.contact_id] });
  });

  const contact = detail.data?.contact;

  return (
    <div className="flex h-full min-h-0">
      <ConversationList
        selectedId={contactId}
        onSelect={(id) => navigate(`/bandeja/${id}`)}
        className={cx('w-full lg:w-[340px] lg:shrink-0', contactId ? 'hidden lg:flex' : 'flex')}
      />

      <div className={cx('min-h-0 min-w-0 flex-1 bg-slate-50', contactId ? 'flex' : 'hidden lg:flex')}>
        {!contactId ? (
          <NoChatSelected />
        ) : detail.isLoading ? (
          <div className="flex flex-1">
            <PageLoader />
          </div>
        ) : !contact ? (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState
              icon={<SearchX className="h-6 w-6" />}
              title="No encontramos esta conversación"
              description="Puede que se haya eliminado o que esté asignada a otra persona."
              action={
                <Link to="/bandeja">
                  <Button size="sm" variant="outline">
                    Volver a la bandeja
                  </Button>
                </Link>
              }
            />
          </div>
        ) : (
          <ChatView
            key={contact.id}
            contact={contact}
            myId={myId}
            panelOpen={panelOpen}
            onTogglePanel={() => setPanelOpen((v) => !v)}
            onBack={() => navigate('/bandeja')}
          />
        )}
      </div>

      {contact && detail.data && panelOpen && (
        <>
          <div className="fixed inset-0 z-30 bg-slate-900/30 xl:hidden" onClick={() => setPanelOpen(false)} />
          <ContactPanel
            key={contact.id}
            detail={detail.data}
            myId={myId}
            onClose={() => setPanelOpen(false)}
            className="fixed inset-y-0 right-0 z-40 w-[min(92vw,340px)] shadow-xl xl:static xl:z-auto xl:w-[320px] xl:shrink-0 xl:border-l xl:border-slate-200 xl:shadow-none"
          />
        </>
      )}
    </div>
  );
}
