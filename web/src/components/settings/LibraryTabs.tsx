import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Paperclip, Pencil, Plus, Trash2, Zap } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useQuickReplies, useTags } from '../../lib/queries';
import { useSession } from '../../lib/session';
import type { QuickReply, Tag } from '../../lib/types';
import { PLACEHOLDERS } from '../TemplateForm';
import { WA_MEDIA_ACCEPT } from '../inbox/helpers';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, PageLoader, TagChip, Textarea, useConfirm, useToast } from '../ui';

const COLORS = ['#ef4444', '#f97316', '#f59e0b', '#22c55e', '#10b981', '#0ea5e9', '#3b82f6', '#8b5cf6', '#ec4899', '#64748b'];

function TagModal({ tag, onClose }: { tag: Partial<Tag> | null; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState(tag?.name ?? '');
  const [color, setColor] = useState(tag?.color ?? COLORS[5]);
  const save = useMutation({
    mutationFn: () => (tag?.id ? api.patch(`/api/tags/${tag.id}`, { name, color }) : api.post('/api/tags', { name, color })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tags'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={tag?.id ? 'Editar etiqueta' : 'Nueva etiqueta'}
      size="sm"
      footer={
        <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!name.trim()}>
          Guardar
        </Button>
      }
    >
      <div className="space-y-4">
        <Field label="Nombre">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={40} />
        </Field>
        <Field label="Color">
          <div className="flex flex-wrap gap-2">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className="h-8 w-8 rounded-full ring-offset-2 transition"
                style={{ background: c, boxShadow: color === c ? `0 0 0 2px white, 0 0 0 4px ${c}` : undefined }}
                aria-label={c}
              />
            ))}
          </div>
        </Field>
        <TagChip name={name || 'Vista previa'} color={color} />
      </div>
    </Modal>
  );
}

export function TagsTab() {
  const { isAdmin } = useSession();
  const tags = useTags();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Partial<Tag> | null>(null);

  async function remove(t: Tag) {
    if (!(await confirm(`Se quitará "${t.name}" de ${t.contact_count ?? 0} contactos.`, { danger: true, confirmText: 'Eliminar' }))) return;
    try {
      await api.delete(`/api/tags/${t.id}`);
      void qc.invalidateQueries({ queryKey: ['tags'] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  if (tags.isLoading) return <PageLoader />;
  return (
    <Card
      title="Etiquetas"
      description="Clasifica leads (interés, producto, origen…) y úsalas para filtrar, segmentar difusiones y en el bot."
      actions={
        <Button size="sm" onClick={() => setEditing({})} icon={<Plus className="h-4 w-4" />}>
          Nueva etiqueta
        </Button>
      }
      padded={false}
    >
      {!tags.data?.length ? (
        <EmptyState title="Sin etiquetas" />
      ) : (
        <div className="divide-y divide-slate-100">
          {tags.data.map((t) => (
            <div key={t.id} className="flex items-center gap-3 px-5 py-3">
              <TagChip name={t.name} color={t.color} />
              <span className="flex-1 text-xs text-slate-500">{t.contact_count ?? 0} contactos</span>
              {isAdmin && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(t)} icon={<Pencil className="h-4 w-4" />} />
                  <Button size="sm" variant="ghost" onClick={() => remove(t)} icon={<Trash2 className="h-4 w-4 text-red-500" />} />
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {editing && <TagModal tag={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function QuickReplyModal({ reply, onClose }: { reply: Partial<QuickReply> | null; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState({
    shortcut: reply?.shortcut ?? '',
    title: reply?.title ?? '',
    body: reply?.body ?? '',
    media_file_id: reply?.media_file_id ?? null,
    media_name: reply?.media_filename ?? null,
  });
  const [uploading, setUploading] = useState(false);
  const save = useMutation({
    mutationFn: () => {
      const body = { shortcut: form.shortcut, title: form.title || null, body: form.body, media_file_id: form.media_file_id };
      return reply?.id ? api.patch(`/api/quick-replies/${reply.id}`, body) : api.post('/api/quick-replies', body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['quick-replies'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  async function upload(file: File) {
    setUploading(true);
    try {
      const r = await api.upload(file);
      setForm((f) => ({ ...f, media_file_id: r.media.id, media_name: r.media.filename }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUploading(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={reply?.id ? 'Editar respuesta rápida' : 'Nueva respuesta rápida'}
      footer={
        <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!form.shortcut || !form.body.trim()}>
          Guardar
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Atajo" hint="En la bandeja escribe / y el atajo.">
            <Input value={form.shortcut} onChange={(e) => setForm({ ...form, shortcut: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') })} placeholder="precios" />
          </Field>
          <Field label="Título (opcional)">
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Lista de precios" />
          </Field>
        </div>
        <Field label="Mensaje">
          <Textarea rows={6} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="Hola {primer_nombre}, te comparto nuestros precios…" />
        </Field>
        <div className="flex flex-wrap gap-1.5 text-xs text-slate-500">
          Puedes usar:
          {PLACEHOLDERS.map((p) => (
            <button key={p.key} type="button" onClick={() => setForm((f) => ({ ...f, body: `${f.body}${p.key}` }))}>
              <Badge className="font-mono hover:bg-slate-200">{p.key}</Badge>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept={WA_MEDIA_ACCEPT}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void upload(file);
            }}
          />
          <Button type="button" variant="outline" size="sm" loading={uploading} onClick={() => fileRef.current?.click()} icon={<Paperclip className="h-4 w-4" />}>
            {form.media_file_id ? 'Cambiar adjunto' : 'Adjuntar archivo'}
          </Button>
          {form.media_file_id && (
            <span className="flex items-center gap-2 text-sm text-slate-600">
              {form.media_name ?? 'Archivo adjunto'}
              <button type="button" className="text-red-500" onClick={() => setForm({ ...form, media_file_id: null, media_name: null })}>
                Quitar
              </button>
            </span>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function QuickRepliesTab() {
  const { isAdmin } = useSession();
  const replies = useQuickReplies();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Partial<QuickReply> | null>(null);

  async function remove(r: QuickReply) {
    if (!(await confirm(`¿Eliminar la respuesta rápida /${r.shortcut}?`, { danger: true, confirmText: 'Eliminar' }))) return;
    try {
      await api.delete(`/api/quick-replies/${r.id}`);
      void qc.invalidateQueries({ queryKey: ['quick-replies'] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  if (replies.isLoading) return <PageLoader />;
  return (
    <Card
      title="Respuestas rápidas"
      description="Mensajes frecuentes que tu equipo envía con / desde la bandeja. Admiten adjuntos y datos del contacto."
      actions={
        isAdmin && (
          <Button size="sm" onClick={() => setEditing({})} icon={<Plus className="h-4 w-4" />}>
            Nueva respuesta
          </Button>
        )
      }
      padded={false}
    >
      {!replies.data?.length ? (
        <EmptyState icon={<Zap className="h-6 w-6" />} title="Sin respuestas rápidas" description="Crea atajos para precios, horarios, ubicación, métodos de pago…" />
      ) : (
        <div className="divide-y divide-slate-100">
          {replies.data.map((r) => (
            <div key={r.id} className="flex items-start gap-3 px-5 py-3">
              <Badge color="green" className="mt-0.5 font-mono">
                /{r.shortcut}
              </Badge>
              <div className="min-w-0 flex-1">
                {r.title && <p className="text-sm font-medium text-slate-900">{r.title}</p>}
                <p className="line-clamp-2 whitespace-pre-wrap text-sm text-slate-600">{r.body}</p>
                {r.media_file_id && (
                  <p className="mt-1 flex items-center gap-1 text-xs text-slate-500">
                    <Paperclip className="h-3 w-3" /> {r.media_filename ?? r.media_mime}
                  </p>
                )}
              </div>
              {isAdmin && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(r)} icon={<Pencil className="h-4 w-4" />} />
                  <Button size="sm" variant="ghost" onClick={() => remove(r)} icon={<Trash2 className="h-4 w-4 text-red-500" />} />
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {editing && <QuickReplyModal reply={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}
