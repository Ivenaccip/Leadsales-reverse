import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, KanbanSquare, MessageCircle, Plus, Search, Settings2, Trash2, Trophy, XCircle } from 'lucide-react';
import { api, errorMessage, qs } from '../lib/api';
import { useFunnels, useMembers, useTags } from '../lib/queries';
import { useRealtime } from '../lib/realtime';
import { useSession } from '../lib/session';
import { displayName, money, timeAgo } from '../lib/format';
import type { Contact, Funnel, Member, Stage, Tag } from '../lib/types';
import { useDebounced } from '../components/crm/hooks';
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  Field,
  IconButton,
  Input,
  Modal,
  PageLoader,
  Select,
  TagChip,
  Toggle,
  cx,
  useConfirm,
  useToast,
} from '../components/ui';

interface BoardStage extends Stage {
  count: number;
  value: number;
  contacts: Contact[];
}

interface Board {
  stages: BoardStage[];
}

const KIND_LABEL: Record<Stage['kind'], string> = { open: 'Abierta', won: 'Ganada', lost: 'Perdida' };

export default function FunnelsPage() {
  const { funnelId } = useParams();
  const navigate = useNavigate();
  const { isAdmin } = useSession();
  const funnelsQ = useFunnels();
  const funnels = funnelsQ.data ?? [];
  const funnel = funnels.find((f) => f.id === funnelId) ?? funnels.find((f) => f.is_default) ?? funnels[0];

  const [search, setSearch] = useState('');
  const [tagId, setTagId] = useState('');
  const [assigned, setAssigned] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const debouncedSearch = useDebounced(search, 350);
  const tags = useTags().data ?? [];
  const members = useMembers().data ?? [];

  if (funnelsQ.isLoading) return <PageLoader />;
  if (!funnel) {
    return (
      <EmptyState
        icon={<KanbanSquare className="h-6 w-6" />}
        title="Aún no tienes embudos"
        description="Crea un embudo para organizar tus prospectos por etapas."
        action={isAdmin && <Button onClick={() => setShowCreate(true)}>Crear embudo</Button>}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold text-slate-900">Embudos</h1>
          <div className="flex flex-wrap gap-1">
            {funnels.map((f) => (
              <button
                key={f.id}
                onClick={() => navigate(`/embudos/${f.id}`)}
                className={cx(
                  'rounded-full px-3 py-1 text-sm font-medium transition-colors',
                  f.id === funnel.id ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
                )}
              >
                {f.name}
              </button>
            ))}
            {isAdmin && (
              <button onClick={() => setShowCreate(true)} className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm text-brand-700 hover:bg-brand-50">
                <Plus className="h-4 w-4" /> Nuevo
              </button>
            )}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar lead…" className="h-9 w-44 pl-8 sm:w-56" />
            </div>
            <Select value={tagId} onChange={(e) => setTagId(e.target.value)} className="h-9 w-48">
              <option value="">Todas las etiquetas</option>
              {tags.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
            <Select value={assigned} onChange={(e) => setAssigned(e.target.value)} className="h-9 w-48">
              <option value="">Todo el equipo</option>
              <option value="__none">Sin asignar</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
            {isAdmin && (
              <Button variant="outline" size="sm" icon={<Settings2 className="h-4 w-4" />} onClick={() => setShowSettings(true)}>
                Configurar
              </Button>
            )}
          </div>
        </div>
      </div>
      <KanbanBoard funnel={funnel} search={debouncedSearch} tagId={tagId} assigned={assigned} tags={tags} members={members} />
      {showSettings && <FunnelSettingsModal funnel={funnel} funnels={funnels} members={members} onClose={() => setShowSettings(false)} />}
      {showCreate && (
        <CreateFunnelModal
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false);
            navigate(`/embudos/${id}`);
          }}
        />
      )}
    </div>
  );
}

function KanbanBoard({
  funnel,
  search,
  tagId,
  assigned,
  tags,
  members,
}: {
  funnel: Funnel;
  search: string;
  tagId: string;
  assigned: string;
  tags: Tag[];
  members: Member[];
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [dragOver, setDragOver] = useState<string | null>(null);
  const filters = {
    search,
    tag_id: tagId,
    assigned_user_id: assigned && assigned !== '__none' ? assigned : '',
    inbox: assigned === '__none' ? 'unassigned' : '',
  };
  const key = ['board', funnel.id, filters];
  const boardQ = useQuery({ queryKey: key, queryFn: () => api.get<Board>(`/api/funnels/${funnel.id}/board${qs(filters)}`) });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['board', funnel.id] });
  useRealtime('contact:update', invalidate);
  useRealtime('contact:new', invalidate);
  useRealtime('contacts:bulk', invalidate);

  const tagById = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const move = useMutation({
    mutationFn: ({ contactId, stageId }: { contactId: string; stageId: string }) => api.patch(`/api/contacts/${contactId}`, { stage_id: stageId }),
    onMutate: async ({ contactId, stageId }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<Board>(key);
      if (prev) {
        let moved: Contact | undefined;
        const stages = prev.stages.map((s) => {
          const c = s.contacts.find((x) => x.id === contactId);
          if (!c) return s;
          moved = c;
          return { ...s, contacts: s.contacts.filter((x) => x.id !== contactId), count: s.count - 1, value: s.value - Number(c.deal_value || 0) };
        });
        const next = stages.map((s) =>
          s.id === stageId && moved
            ? { ...s, contacts: [{ ...moved, stage_id: stageId }, ...s.contacts], count: s.count + 1, value: s.value + Number(moved.deal_value || 0) }
            : s,
        );
        qc.setQueryData<Board>(key, { stages: next });
      }
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.error(errorMessage(err));
    },
    onSettled: () => {
      invalidate();
      void qc.invalidateQueries({ queryKey: ['funnels'] });
    },
  });

  function onDrop(e: DragEvent, stageId: string) {
    e.preventDefault();
    setDragOver(null);
    const contactId = e.dataTransfer.getData('text/contact-id');
    const from = e.dataTransfer.getData('text/stage-id');
    if (contactId && from !== stageId) move.mutate({ contactId, stageId });
  }

  if (boardQ.isLoading) return <PageLoader />;
  if (boardQ.isError) return <EmptyState title="No se pudo cargar el tablero" description={errorMessage(boardQ.error)} />;
  const stages = boardQ.data?.stages ?? [];

  return (
    <div className="scroll-thin flex flex-1 gap-3 overflow-x-auto bg-slate-100 p-4">
      {stages.map((s) => (
        <section
          key={s.id}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (dragOver !== s.id) setDragOver(s.id);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null);
          }}
          onDrop={(e) => onDrop(e, s.id)}
          className={cx(
            'flex w-72 shrink-0 flex-col rounded-xl border bg-slate-50 transition-colors',
            dragOver === s.id ? 'border-brand-400 bg-brand-50' : 'border-slate-200',
          )}
        >
          <div className="h-1 rounded-t-xl" style={{ background: s.color }} />
          <header className="px-3 pb-2 pt-2.5">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold text-slate-800">{s.name}</h2>
              <span className="rounded-full bg-slate-200 px-1.5 text-xs font-medium text-slate-600">{s.count}</span>
              {s.kind === 'won' && (
                <Badge color="green" className="ml-auto">
                  <Trophy className="h-3 w-3" /> Ganada
                </Badge>
              )}
              {s.kind === 'lost' && (
                <Badge color="red" className="ml-auto">
                  <XCircle className="h-3 w-3" /> Perdida
                </Badge>
              )}
            </div>
            <p className="mt-0.5 text-xs text-slate-500">{money(s.value)}</p>
          </header>
          <div className="scroll-thin flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-3">
            {s.contacts.map((c) => {
              const member = c.assigned_user_id ? memberById.get(c.assigned_user_id) : undefined;
              return (
                <article
                  key={c.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/contact-id', c.id);
                    e.dataTransfer.setData('text/stage-id', s.id);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onClick={() => navigate(`/bandeja/${c.id}`)}
                  className="cursor-grab rounded-lg border border-slate-200 bg-white p-3 shadow-sm transition-shadow hover:shadow-md active:cursor-grabbing"
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-900">{displayName(c)}</p>
                      {c.company && <p className="truncate text-xs text-slate-500">{c.company}</p>}
                    </div>
                    {c.unread_count > 0 && (
                      <span className="rounded-full bg-brand-600 px-1.5 text-xs font-semibold text-white">{c.unread_count}</span>
                    )}
                  </div>
                  {Number(c.deal_value) > 0 && <p className="mt-1 text-sm font-semibold text-emerald-700">{money(c.deal_value)}</p>}
                  {c.tag_ids.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {c.tag_ids.slice(0, 3).map((id) => {
                        const t = tagById.get(id);
                        return t ? <TagChip key={id} name={t.name} color={t.color} /> : null;
                      })}
                      {c.tag_ids.length > 3 && <span className="text-xs text-slate-400">+{c.tag_ids.length - 3}</span>}
                    </div>
                  )}
                  {c.last_message_preview && (
                    <p className="mt-2 flex items-center gap-1 truncate text-xs text-slate-500">
                      <MessageCircle className="h-3 w-3 shrink-0" />
                      <span className="truncate">{c.last_message_preview}</span>
                    </p>
                  )}
                  <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
                    <span>{timeAgo(c.last_message_at ?? c.created_at)}</span>
                    {member ? (
                      <span className="flex items-center gap-1" title={member.name}>
                        <Avatar name={member.name} seed={member.id} size="sm" />
                      </span>
                    ) : (
                      <span>Sin asignar</span>
                    )}
                  </div>
                </article>
              );
            })}
            {s.contacts.length === 0 && <p className="px-2 py-6 text-center text-xs text-slate-400">Arrastra leads aquí</p>}
            {s.count > s.contacts.length && (
              <p className="px-2 py-1 text-center text-xs text-slate-400">Mostrando {s.contacts.length} de {s.count}. Usa la búsqueda para encontrar más.</p>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

function CreateFunnelModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/api/funnels', { name }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['funnels'] });
      toast.success('Embudo creado');
      onCreated(r.id);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Nuevo embudo"
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim()}>
            Crear
          </Button>
        </>
      }
    >
      <Field label="Nombre" hint="Se crea con las etapas Nuevo, En proceso, Ganado y Perdido. Puedes editarlas después.">
        <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Ej. Postventa" />
      </Field>
    </Modal>
  );
}

function FunnelSettingsModal({ funnel, funnels, members, onClose }: { funnel: Funnel; funnels: Funnel[]; members: Member[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [name, setName] = useState(funnel.name);
  const [autoAssign, setAutoAssign] = useState(funnel.auto_assign);
  const [team, setTeam] = useState<string[]>(funnel.assignee_ids ?? []);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(funnel.name);
    setAutoAssign(funnel.auto_assign);
    setTeam(funnel.assignee_ids ?? []);
  }, [funnel]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['funnels'] });
    void qc.invalidateQueries({ queryKey: ['board', funnel.id] });
  };

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/api/funnels/${funnel.id}`, { name, auto_assign: autoAssign, assignee_ids: team });
      refresh();
      toast.success('Embudo actualizado');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function makeDefault() {
    try {
      await api.patch(`/api/funnels/${funnel.id}`, { is_default: true });
      refresh();
      toast.success('Ahora es el embudo principal');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function remove() {
    const ok = await confirm(
      <>
        Se eliminará el embudo <b>{funnel.name}</b>. Sus leads se moverán al embudo principal.
      </>,
      { title: 'Eliminar embudo', confirmText: 'Eliminar', danger: true },
    );
    if (!ok) return;
    try {
      await api.delete(`/api/funnels/${funnel.id}`);
      refresh();
      toast.success('Embudo eliminado');
      onClose();
      navigate('/embudos');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <Modal open onClose={onClose} title={`Configurar “${funnel.name}”`} size="lg" footer={<Button variant="outline" onClick={onClose}>Cerrar</Button>}>
      <div className="space-y-6">
        <section className="space-y-4">
          <Field label="Nombre del embudo">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Toggle
            checked={autoAssign}
            onChange={setAutoAssign}
            label="Asignación automática"
            description="Reparte leads nuevos en round-robin entre el equipo de este embudo (solo miembros activos que reciben leads)."
          />
          <div className="space-y-2">
            <p className="text-sm font-medium text-slate-700">Equipo del embudo</p>
            <p className="text-xs text-slate-500">Si no eliges a nadie, participan todos los miembros que reciben leads.</p>
            <div className="flex flex-wrap gap-1.5">
              {members
                .filter((m) => m.is_active)
                .map((m) => {
                  const on = team.includes(m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setTeam(on ? team.filter((x) => x !== m.id) : [...team, m.id])}
                      className={cx(
                        'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
                        on ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50',
                      )}
                    >
                      {m.name}
                    </button>
                  );
                })}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} loading={saving} disabled={!name.trim()}>
              Guardar cambios
            </Button>
            {!funnel.is_default && (
              <Button variant="outline" onClick={makeDefault}>
                Hacer principal
              </Button>
            )}
            {funnel.is_default && <Badge color="green">Embudo principal: aquí llegan los leads nuevos</Badge>}
          </div>
        </section>

        <StagesEditor funnel={funnel} onChanged={refresh} />

        {funnels.length > 1 && (
          <section className="rounded-lg border border-red-200 bg-red-50 p-4">
            <p className="text-sm font-medium text-red-800">Zona de peligro</p>
            <p className="mt-1 text-xs text-red-700">Eliminar el embudo mueve sus leads al embudo principal.</p>
            <Button variant="danger" size="sm" className="mt-3" icon={<Trash2 className="h-4 w-4" />} onClick={remove}>
              Eliminar embudo
            </Button>
          </section>
        )}
      </div>
    </Modal>
  );
}

function StagesEditor({ funnel, onChanged }: { funnel: Funnel; onChanged: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('#64748b');
  const [newKind, setNewKind] = useState<Stage['kind']>('open');
  const [busy, setBusy] = useState(false);
  const stages = [...funnel.stages].sort((a, b) => a.position - b.position);

  async function run(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true);
    try {
      await fn();
      onChanged();
      if (ok) toast.success(ok);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function reorder(index: number, dir: -1 | 1) {
    const ids = stages.map((s) => s.id);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    void run(() => api.put(`/api/funnels/${funnel.id}/stages/order`, { stage_ids: ids }));
  }

  async function removeStage(s: Stage) {
    const ok = await confirm(
      <>
        Se eliminará la etapa <b>{s.name}</b>. Sus leads pasarán a la primera etapa del embudo.
      </>,
      { title: 'Eliminar etapa', confirmText: 'Eliminar', danger: true },
    );
    if (ok) void run(() => api.delete(`/api/stages/${s.id}`), 'Etapa eliminada');
  }

  return (
    <section className="space-y-3">
      <div>
        <p className="text-sm font-semibold text-slate-800">Etapas</p>
        <p className="text-xs text-slate-500">Marca las etapas de cierre como “Ganada” o “Perdida” para que los reportes cuenten tus ventas.</p>
      </div>
      <ul className="space-y-2">
        {stages.map((s, i) => (
          <StageRow
            key={s.id}
            stage={s}
            first={i === 0}
            last={i === stages.length - 1}
            busy={busy}
            onUp={() => reorder(i, -1)}
            onDown={() => reorder(i, 1)}
            onSave={(patch) => run(() => api.patch(`/api/stages/${s.id}`, patch), 'Etapa actualizada')}
            onDelete={() => removeStage(s)}
          />
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-slate-300 p-3">
        <input type="color" value={newColor} onChange={(e) => setNewColor(e.target.value)} className="h-10 w-10 cursor-pointer rounded border border-slate-300" aria-label="Color" />
        <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Nueva etapa" className="min-w-40 flex-1" />
        <Select value={newKind} onChange={(e) => setNewKind(e.target.value as Stage['kind'])} className="w-32">
          <option value="open">Abierta</option>
          <option value="won">Ganada</option>
          <option value="lost">Perdida</option>
        </Select>
        <Button
          icon={<Plus className="h-4 w-4" />}
          disabled={!newName.trim() || busy}
          onClick={() =>
            void run(async () => {
              await api.post(`/api/funnels/${funnel.id}/stages`, { name: newName.trim(), color: newColor, kind: newKind });
              setNewName('');
            }, 'Etapa agregada')
          }
        >
          Agregar
        </Button>
      </div>
    </section>
  );
}

function StageRow({
  stage,
  first,
  last,
  busy,
  onUp,
  onDown,
  onSave,
  onDelete,
}: {
  stage: Stage;
  first: boolean;
  last: boolean;
  busy: boolean;
  onUp: () => void;
  onDown: () => void;
  onSave: (patch: Partial<Pick<Stage, 'name' | 'color' | 'kind'>>) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(stage.name);
  const [color, setColor] = useState(stage.color);
  const [kind, setKind] = useState(stage.kind);
  useEffect(() => {
    setName(stage.name);
    setColor(stage.color);
    setKind(stage.kind);
  }, [stage]);
  const dirty = name !== stage.name || color !== stage.color || kind !== stage.kind;

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-2">
      <div className="flex flex-col">
        <IconButton title="Subir" className="h-5 w-7" disabled={first || busy} onClick={onUp}>
          <ArrowUp className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton title="Bajar" className="h-5 w-7" disabled={last || busy} onClick={onDown}>
          <ArrowDown className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-9 cursor-pointer rounded border border-slate-300" aria-label="Color" />
      <Input value={name} onChange={(e) => setName(e.target.value)} className="h-9 min-w-36 flex-1" />
      <Select value={kind} onChange={(e) => setKind(e.target.value as Stage['kind'])} className="h-9 w-28" title={KIND_LABEL[kind]}>
        <option value="open">Abierta</option>
        <option value="won">Ganada</option>
        <option value="lost">Perdida</option>
      </Select>
      <span className="w-14 text-center text-xs text-slate-400" title="Leads en la etapa">
        {stage.contact_count ?? 0} leads
      </span>
      <Button size="sm" variant={dirty ? 'primary' : 'ghost'} disabled={!dirty || !name.trim() || busy} onClick={() => onSave({ name: name.trim(), color, kind })}>
        Guardar
      </Button>
      <IconButton title="Eliminar etapa" disabled={busy} onClick={onDelete} className="hover:text-red-600">
        <Trash2 className="h-4 w-4" />
      </IconButton>
    </li>
  );
}
