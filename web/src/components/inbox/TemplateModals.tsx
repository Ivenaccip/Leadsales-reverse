import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { FileText, Search } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { CATEGORY_LABEL } from '../../lib/format';
import { recheckContactChannel, useChannels, useContactChannel, useRecheckChannels, useTemplates } from '../../lib/queries';
import type { Channel, Contact, Template } from '../../lib/types';
import {
  categoryColor,
  emptyTemplateValue,
  isTemplateValueComplete,
  TemplateForm,
  TemplatePreview,
  templateUnsupportedReason,
  toTemplateParams,
  type TemplateFormValue,
} from '../TemplateForm';
import { Alert, Badge, Button, cx, EmptyState, Field, Input, Modal, Spinner, Textarea, useToast } from '../ui';
import { sendProblem } from './helpers';

export interface TemplateChoice {
  template: Template | null;
  value: TemplateFormValue;
}

/** Why a conversation's number cannot send (shown in the composer and the template pickers). */
export function disabledChannelNotice(channel: Pick<Channel, 'name' | 'last_error'>): string {
  const why = (channel.last_error ?? '').trim();
  const reason = why ? `: ${why.endsWith('.') ? why.slice(0, -1) : why}` : '';
  return `El número de esta conversación (${channel.name}) está deshabilitado${reason}. Reactívalo en Ajustes → Canales para responder.`;
}

/**
 * Lists approved templates of a channel and lets the user fill in their variables. `disabled`: the
 * conversation's own number, when it is disabled (then there is no channelId to send from).
 */
export function TemplatePicker({
  channelId,
  disabled,
  choice,
  onChange,
}: {
  channelId: string | undefined;
  disabled?: Channel | null;
  choice: TemplateChoice;
  onChange: (c: TemplateChoice) => void;
}) {
  const templates = useTemplates(channelId);
  const channels = useChannels();
  const [q, setQ] = useState('');
  const approved = useMemo(() => (templates.data ?? []).filter((t) => t.status === 'APPROVED'), [templates.data]);
  const filtered = approved.filter((t) => t.name.toLowerCase().includes(q.toLowerCase()));

  if (!channelId) {
    // No sending number: the conversation's own is disabled, or none is connected, or every one is
    // disabled (e.g. after the switch to prepaid).
    return (
      <Alert tone="warning">
        {disabled
          ? disabledChannelNotice(disabled)
          : channels.data?.length
            ? 'Tus números de WhatsApp están deshabilitados. Reactiva uno en Ajustes → Canales para usar plantillas.'
            : 'Conecta un número de WhatsApp para usar plantillas.'}
      </Alert>
    );
  }
  if (templates.isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }
  if (!approved.length) {
    return (
      <EmptyState
        icon={<FileText className="h-6 w-6" />}
        title="No hay plantillas aprobadas"
        description="Crea o sincroniza tus plantillas de Meta para poder escribir fuera de la ventana de 24 horas."
        action={
          <Link to="/plantillas">
            <Button size="sm" variant="outline">
              Ir a Plantillas
            </Button>
          </Link>
        }
      />
    );
  }

  const t = choice.template;
  return (
    <div className="space-y-4">
      {!t ? (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-3 h-4 w-4 text-slate-400" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar plantilla…" className="pl-8" autoFocus />
          </div>
          <ul className="scroll-thin max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
            {filtered.map((tpl) => {
              const body = tpl.components.find((c: any) => c.type === 'BODY')?.text ?? '';
              return (
                <li key={tpl.id}>
                  <button
                    type="button"
                    onClick={() => onChange({ template: tpl, value: emptyTemplateValue(tpl) })}
                    className="w-full px-3 py-2.5 text-left hover:bg-slate-50"
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-sm font-medium text-slate-800">{tpl.name}</span>
                      <span className="text-xs text-slate-400">{tpl.language}</span>
                      {templateUnsupportedReason(tpl) && <Badge color="yellow">No compatible</Badge>}
                      <Badge color={categoryColor(tpl.category)} className="ml-auto">
                        {CATEGORY_LABEL[tpl.category] ?? tpl.category}
                      </Badge>
                    </span>
                    <span className="mt-1 line-clamp-2 block text-xs text-slate-500">{body}</span>
                  </button>
                </li>
              );
            })}
            {!filtered.length && <li className="px-3 py-4 text-center text-sm text-slate-400">Sin coincidencias</li>}
          </ul>
        </>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <span className="font-mono text-sm font-semibold text-slate-800">{t.name}</span>
              <span className="text-xs text-slate-400">{t.language}</span>
              <Badge color={categoryColor(t.category)}>{CATEGORY_LABEL[t.category] ?? t.category}</Badge>
            </span>
            <Button size="sm" variant="ghost" onClick={() => onChange({ template: null, value: emptyTemplateValue(null) })}>
              Cambiar
            </Button>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <TemplateForm template={t} value={choice.value} onChange={(value) => onChange({ template: t, value })} />
            <TemplatePreview template={t} value={choice.value} />
          </div>
          {t.category === 'marketing' && (
            <p className="text-xs text-slate-500">Las plantillas de marketing tienen costo en Meta según el país del contacto.</p>
          )}
        </div>
      )}
    </div>
  );
}

export function SendTemplateModal({ open, onClose, contact, onSent }: { open: boolean; onClose: () => void; contact: Contact; onSent: (message: any) => void }) {
  const qc = useQueryClient();
  const { id: channelId, disabled } = useContactChannel(contact);
  useRecheckChannels(open);
  const [choice, setChoice] = useState<TemplateChoice>({ template: null, value: emptyTemplateValue(null) });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    if (open) {
      setChoice({ template: null, value: emptyTemplateValue(null) });
      setError(null);
    }
  }, [open]);

  async function send() {
    const t = choice.template;
    if (!t) return;
    setSending(true);
    setError(null);
    try {
      const r = await api.post<{ message: any }>(`/api/contacts/${contact.id}/messages`, {
        type: 'template',
        name: t.name,
        language: t.language,
        params: toTemplateParams(t, choice.value),
      });
      onSent(r.message);
      const problem = r.message ? sendProblem(r.message) : null;
      if (problem) toast.error(problem);
      else toast.success('Plantilla enviada');
      onClose();
    } catch (err) {
      // The number was disabled since the dialog opened: the picker now names it.
      if (!(await recheckContactChannel(qc, contact, err))) setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  const ready = !!choice.template && isTemplateValueComplete(choice.template, choice.value);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Enviar plantilla"
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={send} loading={sending} disabled={!ready}>
            Enviar plantilla
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        <TemplatePicker channelId={channelId} disabled={disabled} choice={choice} onChange={setChoice} />
      </div>
    </Modal>
  );
}

function defaultLocalDateTime() {
  const d = new Date(Date.now() + 3600_000);
  d.setSeconds(0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ScheduleModal({ open, onClose, contact, windowOpen, onScheduled }: { open: boolean; onClose: () => void; contact: Contact; windowOpen: boolean; onScheduled: () => void }) {
  const qc = useQueryClient();
  const { id: channelId, disabled } = useContactChannel(contact);
  useRecheckChannels(open);
  const [when, setWhen] = useState(defaultLocalDateTime());
  const [kind, setKind] = useState<'text' | 'template'>(windowOpen ? 'text' : 'template');
  const [text, setText] = useState('');
  const [choice, setChoice] = useState<TemplateChoice>({ template: null, value: emptyTemplateValue(null) });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    if (open) {
      setWhen(defaultLocalDateTime());
      setKind(windowOpen ? 'text' : 'template');
      setText('');
      setChoice({ template: null, value: emptyTemplateValue(null) });
      setError(null);
    }
  }, [open, windowOpen]);

  const sendAt = new Date(when);
  const validDate = !Number.isNaN(sendAt.getTime()) && sendAt.getTime() > Date.now();
  // The 24h window closes at last inbound + 24h: warn when a free text would land after it.
  const windowEnds = contact.last_inbound_at ? new Date(contact.last_inbound_at).getTime() + 24 * 3600_000 : 0;
  const textAfterWindow = kind === 'text' && validDate && sendAt.getTime() > windowEnds;
  const ready = validDate && (kind === 'text' ? text.trim().length > 0 : !!choice.template && isTemplateValueComplete(choice.template, choice.value));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const t = choice.template;
      await api.post(`/api/contacts/${contact.id}/scheduled`, {
        send_at: sendAt.toISOString(),
        content:
          kind === 'text'
            ? { type: 'text', text }
            : { type: 'template', name: t!.name, language: t!.language, params: toTemplateParams(t!, choice.value) },
      });
      toast.success(`Mensaje programado para ${sendAt.toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' })}`);
      onScheduled();
      onClose();
    } catch (err) {
      if (!(await recheckContactChannel(qc, contact, err))) setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Programar mensaje"
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} loading={saving} disabled={!ready}>
            Programar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        {disabled && <Alert tone="warning">{disabledChannelNotice(disabled)}</Alert>}
        <Field label="Fecha y hora de envío" error={!validDate ? 'Elige una fecha futura' : null}>
          <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </Field>
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
          {(['text', 'template'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={cx('flex-1 rounded-md px-3 py-1.5 text-sm font-medium', kind === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500')}
            >
              {k === 'text' ? 'Texto libre' : 'Plantilla'}
            </button>
          ))}
        </div>
        {kind === 'text' ? (
          <>
            <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Escribe el mensaje…" />
            {textAfterWindow && (
              <Alert tone="warning">
                A esa hora la ventana de 24 h ya estará cerrada y WhatsApp rechazará el texto libre. Usa una plantilla o elige una hora antes de que cierre.
              </Alert>
            )}
          </>
        ) : (
          <TemplatePicker channelId={channelId} disabled={disabled} choice={choice} onChange={setChoice} />
        )}
      </div>
    </Modal>
  );
}
