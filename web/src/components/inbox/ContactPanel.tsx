import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArchiveRestore,
  Ban,
  Bot,
  CalendarClock,
  Check,
  Copy,
  ExternalLink,
  History,
  Pencil,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { dateTime, formatPhone, money, SOURCE_LABEL, timeAgo } from '../../lib/format';
import { useFunnels, useMembers, useTags, useWorkspace } from '../../lib/queries';
import type { Contact, ContactEvent, ScheduledMessage, Tag } from '../../lib/types';
import { MemberSelect, StageSelect, TagMultiSelect } from '../pickers';
import { Avatar, Badge, Button, cx, IconButton, Input, Toggle, useConfirm, useToast } from '../ui';
import { patchConversations } from './helpers';

export interface ContactDetail {
  contact: Contact;
  events: ContactEvent[];
  scheduled: ScheduledMessage[];
  window_open: boolean;
}

function Section({ title, icon, children, action }: { title: string; icon?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="border-b border-slate-100 px-4 py-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
          {icon}
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function EditableText({
  value,
  onSave,
  placeholder,
  type = 'text',
  display,
  className,
}: {
  value: string;
  onSave: (v: string) => Promise<void> | void;
  placeholder: string;
  type?: string;
  display?: ReactNode;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  async function commit() {
    setEditing(false);
    if (draft.trim() !== value.trim()) await onSave(draft.trim());
  }

  if (editing) {
    return (
      <Input
        autoFocus
        type={type}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit();
          if (e.key === 'Escape') {
            setDraft(value);
            setEditing(false);
          }
        }}
        className={cx('h-8', className)}
      />
    );
  }
  return (
    <button type="button" onClick={() => setEditing(true)} className={cx('group flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-slate-50', className)}>
      <span className={cx('min-w-0 flex-1 truncate', !value && 'text-slate-400')}>{value ? (display ?? value) : placeholder}</span>
      <Pencil className="h-3.5 w-3.5 shrink-0 text-slate-300 group-hover:text-slate-500" />
    </button>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_1fr] items-center gap-2 text-sm">
      <span className="text-xs text-slate-500">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function eventText(e: ContactEvent, memberName: (id: string | null | undefined) => string): string {
  const d = e.data ?? {};
  switch (e.type) {
    case 'created':
      return `Lead creado · origen: ${SOURCE_LABEL[d.source] ?? d.source ?? '—'}`;
    case 'stage_changed':
      return `${d.kind === 'won' ? '🎉 ' : d.kind === 'lost' ? '✖ ' : ''}Movido a “${d.to_name ?? 'otra etapa'}”`;
    case 'assigned':
      return d.to ? `Asignado a ${memberName(d.to)}${d.auto ? ' (automático)' : ''}` : 'Quedó sin asignar';
    case 'opted_out':
      return `Se dio de baja de difusiones${d.keyword ? ` (escribió “${d.keyword}”)` : ''}`;
    default:
      return e.type;
  }
}

function CustomFields({ fields, onSave }: { fields: Record<string, unknown>; onSave: (next: Record<string, unknown>) => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [key, setKey] = useState('');
  const [val, setVal] = useState('');
  const entries = Object.entries(fields ?? {});

  async function add() {
    const k = key.trim();
    if (!k) return;
    await onSave({ ...fields, [k]: val.trim() });
    setKey('');
    setVal('');
    setAdding(false);
  }

  return (
    <div className="space-y-1.5">
      {entries.length === 0 && !adding && <p className="text-xs text-slate-400">Sin campos personalizados.</p>}
      {entries.map(([k, v]) => (
        <div key={k} className="group grid grid-cols-[88px_1fr_auto] items-center gap-2 text-sm">
          <span className="truncate text-xs text-slate-500" title={k}>
            {k}
          </span>
          <EditableText value={String(v ?? '')} placeholder="—" onSave={(nv) => onSave({ ...fields, [k]: nv })} />
          <IconButton
            title={`Eliminar ${k}`}
            className="h-7 w-7 opacity-0 group-hover:opacity-100"
            onClick={() => {
              const next = { ...fields };
              delete next[k];
              void onSave(next);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      ))}
      {adding ? (
        <div className="space-y-2 rounded-lg bg-slate-50 p-2">
          <Input className="h-8" placeholder="Campo (ej. ciudad)" value={key} onChange={(e) => setKey(e.target.value)} autoFocus />
          <Input className="h-8" placeholder="Valor" value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancelar
            </Button>
            <Button size="sm" onClick={() => void add()} disabled={!key.trim()}>
              Agregar
            </Button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline">
          <Plus className="h-3.5 w-3.5" /> Agregar campo
        </button>
      )}
    </div>
  );
}

export function ContactPanel({ detail, myId, onClose, className }: { detail: ContactDetail; myId: string | undefined; onClose: () => void; className?: string }) {
  const { contact, events, scheduled } = detail;
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const funnels = useFunnels();
  const members = useMembers();
  const tags = useTags();
  const workspace = useWorkspace();
  const mode = workspace.data?.workspace.settings.automation_mode ?? 'off';
  const [copied, setCopied] = useState(false);
  const memberMap = useMemo(() => new Map((members.data ?? []).map((m) => [m.id, m.name])), [members.data]);
  const memberName = (id: string | null | undefined) => (id ? (memberMap.get(id) ?? 'alguien del equipo') : '—');

  async function patch(body: Record<string, unknown>, okText?: string, refreshEvents = false) {
    try {
      const r = await api.patch<{ contact: Contact }>(`/api/contacts/${contact.id}`, body);
      qc.setQueryData<ContactDetail>(['contact', contact.id], (old) => (old ? { ...old, contact: r.contact } : old));
      patchConversations(qc, r.contact, myId);
      if (refreshEvents) void qc.invalidateQueries({ queryKey: ['contact', contact.id] });
      if (okText) toast.success(okText);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function createTag(name: string): Promise<Tag> {
    const r = await api.post<{ tag: Tag }>('/api/tags', { name });
    await qc.invalidateQueries({ queryKey: ['tags'] });
    return r.tag;
  }

  async function cancelScheduled(id: string) {
    if (!(await confirm('El mensaje programado no se enviará.', { title: 'Cancelar mensaje programado', confirmText: 'Cancelar envío', danger: true }))) return;
    try {
      await api.delete(`/api/scheduled/${id}`);
      void qc.invalidateQueries({ queryKey: ['contact', contact.id] });
      toast.success('Mensaje programado cancelado');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <aside className={cx('flex min-h-0 flex-col bg-white', className)}>
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
        <span className="text-sm font-semibold text-slate-800">Detalles del contacto</span>
        <IconButton title="Cerrar panel" onClick={onClose}>
          <X className="h-5 w-5" />
        </IconButton>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col items-center gap-2 border-b border-slate-100 px-4 py-5 text-center">
          <Avatar name={contact.name ?? contact.phone} seed={contact.id} size="lg" />
          <EditableText
            value={contact.name ?? ''}
            placeholder="Agregar nombre"
            onSave={(v) => patch({ name: v || null })}
            className="justify-center text-base font-semibold text-slate-900"
          />
          <div className="flex items-center gap-1 text-sm text-slate-500">
            {formatPhone(contact.phone)}
            <IconButton
              title="Copiar teléfono"
              className="h-7 w-7"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(`+${contact.phone}`);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                } catch {
                  /* clipboard blocked */
                }
              }}
            >
              {copied ? <Check className="h-3.5 w-3.5 text-brand-600" /> : <Copy className="h-3.5 w-3.5" />}
            </IconButton>
            <a href={`https://wa.me/${contact.phone}`} target="_blank" rel="noopener noreferrer" title="Abrir en WhatsApp" className="rounded p-1 hover:bg-slate-100">
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
          <div className="flex flex-wrap justify-center gap-1.5">
            {contact.opted_out && (
              <Badge color="red">
                <Ban className="h-3 w-3" /> Dado de baja
              </Badge>
            )}
            {contact.is_archived && <Badge color="gray">Archivado</Badge>}
            <Badge color="gray">{SOURCE_LABEL[contact.source] ?? contact.source}</Badge>
          </div>
        </div>

        <Section title="Venta">
          <div className="space-y-2.5">
            <Row label="Etapa">
              <StageSelect className="h-8" funnels={funnels.data ?? []} value={contact.stage_id} onChange={(id) => id && void patch({ stage_id: id }, undefined, true)} />
            </Row>
            <Row label="Asignado a">
              <MemberSelect
                className="h-8"
                members={members.data ?? []}
                value={contact.assigned_user_id}
                onChange={(id) => void patch({ assigned_user_id: id }, id ? 'Conversación asignada' : 'Conversación sin asignar', true)}
              />
            </Row>
            <Row label="Valor">
              <EditableText
                type="number"
                value={contact.deal_value ? String(contact.deal_value) : ''}
                display={money(contact.deal_value)}
                placeholder="$0"
                onSave={(v) => {
                  const n = Number(v.replace(/[^\d.]/g, ''));
                  return patch({ deal_value: Number.isFinite(n) && n >= 0 ? n : 0 });
                }}
              />
            </Row>
          </div>
        </Section>

        <Section title="Etiquetas">
          <TagMultiSelect tags={tags.data ?? []} value={contact.tag_ids} onChange={(ids) => void patch({ tag_ids: ids })} onCreate={createTag} />
        </Section>

        <Section title="Datos">
          <div className="space-y-1.5">
            <Row label="Correo">
              <EditableText value={contact.email ?? ''} type="email" placeholder="Agregar correo" onSave={(v) => patch({ email: v })} />
            </Row>
            <Row label="Empresa">
              <EditableText value={contact.company ?? ''} placeholder="Agregar empresa" onSave={(v) => patch({ company: v || null })} />
            </Row>
          </div>
          <div className="mt-4">
            <p className="mb-2 text-xs font-medium text-slate-500">Campos personalizados</p>
            <CustomFields fields={contact.custom_fields ?? {}} onSave={(next) => patch({ custom_fields: next })} />
          </div>
        </Section>

        {(mode === 'ai' || mode === 'menu') && (
          <Section title="Automatización" icon={mode === 'ai' ? <Sparkles className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}>
            {mode === 'ai' ? (
              <Toggle
                checked={!contact.ai_paused}
                onChange={(on) => void patch({ ai_paused: !on }, on ? 'La IA volverá a responder este chat' : 'IA pausada en este chat')}
                label="IA activa en este chat"
                description="Se pausa sola cuando alguien del equipo responde o la IA pasa la conversación a un humano."
              />
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-slate-500">
                  {contact.bot_state ? (contact.bot_state.done ? 'El bot ya terminó con este contacto.' : 'El bot está atendiendo este chat.') : 'El bot aún no atiende a este contacto.'}
                </p>
                <Button size="sm" variant="outline" icon={<RotateCcw className="h-4 w-4" />} onClick={() => void patch({ reset_bot: true }, 'El bot volverá a mostrar el menú en el próximo mensaje')}>
                  Reiniciar bot
                </Button>
              </div>
            )}
          </Section>
        )}

        {scheduled.length > 0 && (
          <Section title="Programados" icon={<CalendarClock className="h-3.5 w-3.5" />}>
            <ul className="space-y-2">
              {scheduled.map((s) => (
                <li key={s.id} className="flex items-start gap-2 rounded-lg bg-slate-50 p-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-slate-700">{dateTime(s.send_at)}</p>
                    <p className="truncate text-xs text-slate-500">{s.content.type === 'text' ? s.content.text : `Plantilla ${s.content.name}`}</p>
                  </div>
                  <IconButton title="Cancelar envío" className="h-7 w-7" onClick={() => void cancelScheduled(s.id)}>
                    <X className="h-4 w-4" />
                  </IconButton>
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section title="Preferencias">
          <div className="space-y-3">
            <Toggle
              checked={!contact.opted_out}
              onChange={(on) => void patch({ opted_out: !on }, on ? 'El contacto volverá a recibir difusiones' : 'Contacto excluido de difusiones')}
              label="Recibe difusiones"
              description="Si escribe BAJA se desactiva automáticamente."
            />
            <Button
              size="sm"
              variant="outline"
              icon={contact.is_archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
              onClick={() => void patch({ is_archived: !contact.is_archived }, contact.is_archived ? 'Conversación restaurada' : 'Conversación archivada')}
            >
              {contact.is_archived ? 'Desarchivar' : 'Archivar conversación'}
            </Button>
            <div className="space-y-1 text-xs text-slate-500">
              <p>Creado: {dateTime(contact.created_at)}</p>
              <p>Último mensaje del cliente: {contact.last_inbound_at ? timeAgo(contact.last_inbound_at) : '—'}</p>
            </div>
          </div>
        </Section>

        <Section title="Historial" icon={<History className="h-3.5 w-3.5" />}>
          {events.length === 0 ? (
            <p className="text-xs text-slate-400">Sin movimientos.</p>
          ) : (
            <ol className="relative space-y-3 border-l border-slate-200 pl-4">
              {events.map((e) => (
                <li key={e.id} className="relative">
                  <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-brand-500" />
                  <p className="text-sm text-slate-700">{eventText(e, memberName)}</p>
                  <p className="text-[11px] text-slate-400">
                    {dateTime(e.created_at)}
                    {e.user_name ? ` · ${e.user_name}` : ''}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </Section>
      </div>
    </aside>
  );
}
