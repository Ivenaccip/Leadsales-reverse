import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { AlarmClock, FileText, Lock, Paperclip, Send, StickyNote, X, Zap } from 'lucide-react';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useQuickReplies } from '../../lib/queries';
import type { Contact, Message, QuickReply } from '../../lib/types';
import { Alert, Button, cx, IconButton, Spinner, useToast } from '../ui';
import { renderPlaceholders } from './helpers';

type Mode = 'reply' | 'note';

interface Attachment {
  id: string;
  name: string;
  mime: string;
}

export function Composer({
  contact,
  windowOpen,
  remainingMs,
  onSent,
  onOpenTemplate,
  onOpenSchedule,
}: {
  contact: Contact;
  windowOpen: boolean;
  remainingMs: number;
  onSent: (m: Message) => void;
  onOpenTemplate: () => void;
  onOpenSchedule: () => void;
}) {
  const toast = useToast();
  const quickReplies = useQuickReplies();
  const [mode, setMode] = useState<Mode>('reply');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [creditsError, setCreditsError] = useState<string | null>(null);
  const [qrIndex, setQrIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Reset the composer when switching conversations.
  useEffect(() => {
    setText('');
    setAttachment(null);
    setMode('reply');
    setCreditsError(null);
  }, [contact.id]);

  // Auto-grow the textarea.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  const qrQuery = mode === 'reply' && text.startsWith('/') && !text.includes(' ') ? text.slice(1).toLowerCase() : null;
  const qrMatches = useMemo(() => {
    if (qrQuery === null) return [];
    return (quickReplies.data ?? [])
      .filter((q) => q.shortcut.includes(qrQuery) || (q.title ?? '').toLowerCase().includes(qrQuery))
      .slice(0, 8);
  }, [qrQuery, quickReplies.data]);

  useEffect(() => setQrIndex(0), [qrQuery]);

  const blocked = mode === 'reply' && !windowOpen;

  function handleError(err: unknown) {
    if (err instanceof ApiError && err.code === 'WINDOW_CLOSED') {
      toast.error('La ventana de 24 h está cerrada: envía una plantilla.');
      onOpenTemplate();
      return;
    }
    if (err instanceof ApiError && err.code === 'INSUFFICIENT_CREDITS') {
      setCreditsError(err.message);
      return;
    }
    toast.error(errorMessage(err));
  }

  async function sendQuickReply(q: QuickReply) {
    if (!q.media_file_id) {
      setText(renderPlaceholders(q.body, contact));
      textareaRef.current?.focus();
      return;
    }
    setSending(true);
    try {
      const r = await api.post<{ message: Message }>(`/api/contacts/${contact.id}/messages`, { type: 'quick_reply', quick_reply_id: q.id });
      onSent(r.message);
      setText('');
    } catch (err) {
      handleError(err);
    } finally {
      setSending(false);
    }
  }

  async function submit() {
    if (sending) return;
    const body = text.trim();
    if (mode === 'note') {
      if (!body) return;
      setSending(true);
      try {
        const r = await api.post<{ message: Message }>(`/api/contacts/${contact.id}/notes`, { text: body });
        onSent(r.message);
        setText('');
      } catch (err) {
        handleError(err);
      } finally {
        setSending(false);
      }
      return;
    }
    if (blocked || (!body && !attachment)) return;
    setSending(true);
    setCreditsError(null);
    try {
      const payload = attachment
        ? { type: 'media', media_file_id: attachment.id, ...(body ? { caption: body.slice(0, 1024) } : {}) }
        : { type: 'text', text: body };
      const r = await api.post<{ message: Message }>(`/api/contacts/${contact.id}/messages`, payload);
      onSent(r.message);
      setText('');
      setAttachment(null);
      if (r.message.status === 'failed') toast.error(r.message.error?.message ?? 'WhatsApp rechazó el mensaje');
    } catch (err) {
      handleError(err);
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }

  async function pickFile(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    try {
      const r = await api.upload(file);
      setAttachment({ id: r.media.id, name: r.media.filename ?? file.name, mime: r.media.mime });
      textareaRef.current?.focus();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (qrMatches.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setQrIndex((i) => (i + 1) % qrMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setQrIndex((i) => (i - 1 + qrMatches.length) % qrMatches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        void sendQuickReply(qrMatches[qrIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setText('');
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  }

  const hours = Math.floor(remainingMs / 3600_000);
  const minutes = Math.floor((remainingMs % 3600_000) / 60_000);

  return (
    <div className="border-t border-slate-200 bg-white">
      {creditsError && (
        <div className="px-3 pt-3">
          <Alert tone="warning" title="Sin créditos suficientes">
            {creditsError}{' '}
            <Link to="/creditos" className="font-medium underline">
              Ver créditos
            </Link>
          </Alert>
        </div>
      )}
      {mode === 'reply' && !windowOpen && (
        <div className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          <Lock className="h-4 w-4 shrink-0" />
          <span className="flex-1">La ventana de 24 h está cerrada; envía una plantilla aprobada para retomar la conversación.</span>
          <Button size="sm" onClick={onOpenTemplate} icon={<FileText className="h-4 w-4" />}>
            Enviar plantilla
          </Button>
        </div>
      )}

      <div className="relative px-3 pb-3 pt-2">
        {qrMatches.length > 0 && (
          <div className="absolute bottom-full left-3 right-3 z-20 mb-1 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
            <p className="flex items-center gap-1 border-b border-slate-100 px-3 py-1.5 text-xs font-medium text-slate-500">
              <Zap className="h-3.5 w-3.5" /> Respuestas rápidas · ↑↓ para elegir, Enter para usar
            </p>
            <ul className="scroll-thin max-h-64 overflow-y-auto">
              {qrMatches.map((q, i) => (
                <li key={q.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      void sendQuickReply(q);
                    }}
                    onMouseEnter={() => setQrIndex(i)}
                    className={cx('flex w-full gap-3 px-3 py-2 text-left', i === qrIndex ? 'bg-brand-50' : 'hover:bg-slate-50')}
                  >
                    <span className="shrink-0 font-mono text-xs font-semibold text-brand-700">/{q.shortcut}</span>
                    <span className="min-w-0 flex-1">
                      {q.title && <span className="block truncate text-xs font-medium text-slate-700">{q.title}</span>}
                      <span className="block truncate text-xs text-slate-500">{q.body}</span>
                    </span>
                    {q.media_file_id && <Paperclip className="h-3.5 w-3.5 shrink-0 text-slate-400" />}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {attachment && (
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-2 text-sm">
            <Paperclip className="h-4 w-4 text-slate-500" />
            <span className="flex-1 truncate text-slate-700">{attachment.name}</span>
            <span className="text-xs text-slate-400">El texto se enviará como descripción</span>
            <IconButton title="Quitar archivo" className="h-7 w-7" onClick={() => setAttachment(null)}>
              <X className="h-4 w-4" />
            </IconButton>
          </div>
        )}

        <div
          className={cx(
            'flex items-end gap-1 rounded-xl border px-2 py-1.5 transition-colors',
            mode === 'note' ? 'border-amber-300 bg-amber-50' : 'border-slate-300 bg-white focus-within:border-brand-500',
            blocked && 'bg-slate-50',
          )}
        >
          <div className="flex items-center">
            <IconButton title="Adjuntar archivo" disabled={blocked || mode === 'note' || uploading} onClick={() => fileRef.current?.click()}>
              {uploading ? <Spinner className="h-4 w-4" /> : <Paperclip className="h-5 w-5" />}
            </IconButton>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              accept="image/jpeg,image/png,image/webp,video/mp4,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip"
              onChange={(e) => void pickFile(e.target.files?.[0])}
            />
          </div>
          <textarea
            ref={textareaRef}
            rows={1}
            value={text}
            disabled={blocked}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              mode === 'note'
                ? 'Escribe una nota interna (solo la ve tu equipo)…'
                : blocked
                  ? 'Ventana cerrada: usa una plantilla'
                  : 'Escribe un mensaje… ( / para respuestas rápidas)'
            }
            className="max-h-[180px] min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none disabled:cursor-not-allowed"
          />
          <Button
            size="sm"
            className={cx('mb-0.5', mode === 'note' && 'bg-amber-500 hover:bg-amber-600')}
            onClick={() => void submit()}
            loading={sending}
            disabled={mode === 'note' ? !text.trim() : blocked || (!text.trim() && !attachment)}
            icon={sending ? undefined : <Send className="h-4 w-4" />}
          >
            <span className="hidden sm:inline">{mode === 'note' ? 'Guardar nota' : 'Enviar'}</span>
          </Button>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
          <button
            type="button"
            onClick={() => setMode(mode === 'note' ? 'reply' : 'note')}
            className={cx(
              'inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium',
              mode === 'note' ? 'bg-amber-100 text-amber-800' : 'text-slate-500 hover:bg-slate-100',
            )}
          >
            <StickyNote className="h-3.5 w-3.5" /> {mode === 'note' ? 'Modo nota interna' : 'Nota interna'}
          </button>
          <button type="button" onClick={onOpenTemplate} className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium text-slate-500 hover:bg-slate-100">
            <FileText className="h-3.5 w-3.5" /> Plantilla
          </button>
          <button type="button" onClick={onOpenSchedule} className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium text-slate-500 hover:bg-slate-100">
            <AlarmClock className="h-3.5 w-3.5" /> Programar
          </button>
          {windowOpen && mode === 'reply' && (
            <span className="ml-auto text-slate-400" title="Tiempo restante para responder con texto libre">
              Ventana abierta: {hours > 0 ? `${hours} h ` : ''}
              {minutes} min
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
