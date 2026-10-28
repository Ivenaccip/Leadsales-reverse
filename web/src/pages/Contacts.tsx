import { useMemo, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Ban, ChevronLeft, ChevronRight, Download, Plus, Search, Tag as TagIcon, Trash2, Upload, UserPlus, Users, MoveRight, X } from 'lucide-react';
import { api, errorMessage, getWorkspaceId, qs } from '../lib/api';
import { stageMap, useFunnels, useMembers, useTags } from '../lib/queries';
import { useRealtime } from '../lib/realtime';
import { useSession } from '../lib/session';
import { SOURCE_LABEL, displayName, formatPhone, money, timeAgo } from '../lib/format';
import type { Contact, Paged, Tag } from '../lib/types';
import { useDebounced } from '../components/crm/hooks';
import { MemberSelect, StageSelect, TagMultiSelect } from '../components/pickers';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  Page,
  PageHeader,
  Select,
  Spinner,
  TagChip,
  Textarea,
  Toggle,
  cx,
  useConfirm,
  useToast,
} from '../components/ui';

const LIMIT = 50;

type BulkAction = 'add_tags' | 'remove_tags' | 'move_stage' | 'assign' | 'archive' | 'unarchive' | 'opt_out' | 'delete';

interface Filters {
  search: string;
  stageId: string;
  funnelId: string;
  tagId: string;
  assigned: string; // '' | '__none' | userId
  archived: boolean;
  optedOut: '' | '1' | '0';
  sort: 'recent' | 'created' | 'name' | 'value';
}

const EMPTY_FILTERS: Filters = { search: '', stageId: '', funnelId: '', tagId: '', assigned: '', archived: false, optedOut: '', sort: 'created' };

function filterParams(f: Filters, search: string) {
  return {
    search,
    funnel_id: f.stageId ? '' : f.funnelId,
    stage_id: f.stageId,
    tag_id: f.tagId,
    assigned_user_id: f.assigned && f.assigned !== '__none' ? f.assigned : '',
    inbox: f.assigned === '__none' ? 'unassigned' : '',
    archived: f.archived,
    opted_out: f.optedOut,
    sort: f.sort,
  };
}

export default function ContactsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { isAdmin } = useSession();
  const funnels = useFunnels().data ?? [];
  const tags = useTags().data ?? [];
  const members = useMembers().data ?? [];
  const stages = useMemo(() => stageMap(funnels), [funnels]);
  const tagById = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<BulkAction | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const search = useDebounced(filters.search, 350);
  const params = filterParams(filters, search);

  const listQ = useQuery({
    queryKey: ['contacts', params, page],
    queryFn: () => api.get<Paged<Contact>>(`/api/contacts${qs({ ...params, page, limit: LIMIT })}`),
    placeholderData: (prev) => prev,
  });
  const items = listQ.data?.items ?? [];
  const total = listQ.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / LIMIT));

  const refresh = () => void qc.invalidateQueries({ queryKey: ['contacts'] });
  useRealtime('contact:new', refresh);
  useRealtime('contacts:bulk', refresh);

  function update<K extends keyof Filters>(k: K, v: Filters[K]) {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
    setSelected(new Set());
  }

  const allSelected = items.length > 0 && items.every((c) => selected.has(c.id));
  function toggleAll() {
    setSelected((s) => {
      const next = new Set(s);
      if (allSelected) items.forEach((c) => next.delete(c.id));
      else items.forEach((c) => next.add(c.id));
      return next;
    });
  }
  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const { sort: _sort, ...rest } = params;
      const res = await fetch(`/api/contacts/export.csv${qs(rest)}`, {
        headers: { 'X-Workspace-Id': getWorkspaceId() ?? '' },
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`No se pudo exportar (HTTP ${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `contactos-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setExporting(false);
    }
  }

  const hasFilters = JSON.stringify({ ...filters, sort: '' }) !== JSON.stringify({ ...EMPTY_FILTERS, sort: '' });

  return (
    <Page wide>
      <PageHeader
        title="Contactos"
        description="Todos tus leads y clientes. Selecciona varios para aplicar acciones masivas."
        actions={
          <>
            {isAdmin && (
              <>
                <Button variant="outline" icon={<Upload className="h-4 w-4" />} onClick={() => setImporting(true)}>
                  Importar
                </Button>
                <Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={exportCsv} loading={exporting}>
                  Exportar
                </Button>
              </>
            )}
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
              Nuevo contacto
            </Button>
          </>
        }
      />

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
          <div className="relative min-w-52 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-3 h-4 w-4 text-slate-400" />
            <Input value={filters.search} onChange={(e) => update('search', e.target.value)} placeholder="Buscar por nombre, teléfono, correo o empresa" className="pl-8" />
          </div>
          <Select
            value={filters.funnelId}
            onChange={(e) => {
              setFilters((f) => ({ ...f, funnelId: e.target.value, stageId: '' }));
              setPage(1);
            }}
            className="w-48"
          >
            <option value="">Todos los embudos</option>
            {funnels.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
          <StageSelect
            funnels={funnels}
            funnelId={filters.funnelId || undefined}
            value={filters.stageId}
            onChange={(v) => update('stageId', v ?? '')}
            allowEmpty
            emptyLabel="Todas las etapas"
            className="w-44"
          />
          <Select value={filters.tagId} onChange={(e) => update('tagId', e.target.value)} className="w-48">
            <option value="">Todas las etiquetas</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
          <Select value={filters.assigned} onChange={(e) => update('assigned', e.target.value)} className="w-48">
            <option value="">Cualquier asesor</option>
            <option value="__none">Sin asignar</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
          <Select value={filters.optedOut} onChange={(e) => update('optedOut', e.target.value as Filters['optedOut'])} className="w-44">
            <option value="">Con y sin baja</option>
            <option value="0">Reciben difusiones</option>
            <option value="1">Dados de baja</option>
          </Select>
          <Select value={filters.sort} onChange={(e) => update('sort', e.target.value as Filters['sort'])} className="w-44">
            <option value="created">Más recientes</option>
            <option value="recent">Último mensaje</option>
            <option value="name">Nombre (A-Z)</option>
            <option value="value">Mayor valor</option>
          </Select>
          <Toggle checked={filters.archived} onChange={(v) => update('archived', v)} label="Archivados" />
          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              icon={<X className="h-4 w-4" />}
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                setPage(1);
              }}
            >
              Limpiar
            </Button>
          )}
        </div>

        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-brand-100 bg-brand-50 px-3 py-2 text-sm">
            <span className="font-medium text-brand-800">{selected.size} seleccionados</span>
            <Button size="sm" variant="outline" icon={<TagIcon className="h-4 w-4" />} onClick={() => setBulk('add_tags')}>
              Etiquetar
            </Button>
            <Button size="sm" variant="outline" onClick={() => setBulk('remove_tags')}>
              Quitar etiquetas
            </Button>
            <Button size="sm" variant="outline" icon={<MoveRight className="h-4 w-4" />} onClick={() => setBulk('move_stage')}>
              Mover de etapa
            </Button>
            <Button size="sm" variant="outline" icon={<UserPlus className="h-4 w-4" />} onClick={() => setBulk('assign')}>
              Asignar
            </Button>
            <Button size="sm" variant="outline" icon={<Archive className="h-4 w-4" />} onClick={() => setBulk(filters.archived ? 'unarchive' : 'archive')}>
              {filters.archived ? 'Desarchivar' : 'Archivar'}
            </Button>
            {isAdmin && (
              <>
                <Button size="sm" variant="outline" icon={<Ban className="h-4 w-4" />} onClick={() => setBulk('opt_out')}>
                  Dar de baja
                </Button>
                <Button size="sm" variant="danger" icon={<Trash2 className="h-4 w-4" />} onClick={() => setBulk('delete')}>
                  Eliminar
                </Button>
              </>
            )}
            <button className="ml-auto text-xs text-slate-500 hover:underline" onClick={() => setSelected(new Set())}>
              Deseleccionar
            </button>
          </div>
        )}

        {listQ.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Users className="h-6 w-6" />}
            title={hasFilters ? 'Ningún contacto coincide con los filtros' : 'Aún no tienes contactos'}
            description={hasFilters ? 'Prueba con otros filtros.' : 'Llegan solos cuando te escriben por WhatsApp, o puedes crearlos e importarlos.'}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="w-10 px-3 py-2">
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Seleccionar todos" className="h-4 w-4 accent-brand-600" />
                  </th>
                  <th className="px-3 py-2">Contacto</th>
                  <th className="px-3 py-2">Etapa</th>
                  <th className="px-3 py-2">Etiquetas</th>
                  <th className="px-3 py-2">Asignado</th>
                  <th className="px-3 py-2 text-right">Valor</th>
                  <th className="px-3 py-2">Origen</th>
                  <th className="px-3 py-2">Actividad</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((c) => {
                  const st = c.stage_id ? stages.get(c.stage_id) : undefined;
                  const member = c.assigned_user_id ? memberById.get(c.assigned_user_id) : undefined;
                  return (
                    <tr key={c.id} onClick={() => navigate(`/bandeja/${c.id}`)} className={cx('cursor-pointer hover:bg-slate-50', selected.has(c.id) && 'bg-brand-50/60')}>
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} aria-label="Seleccionar" className="h-4 w-4 accent-brand-600" />
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2.5">
                          <Avatar name={c.name ?? c.phone} seed={c.id} size="sm" />
                          <div className="min-w-0">
                            <p className="truncate font-medium text-slate-900">
                              {displayName(c)}
                              {c.opted_out && (
                                <Badge color="red" className="ml-2">
                                  Baja
                                </Badge>
                              )}
                            </p>
                            <p className="truncate text-xs text-slate-500">
                              {formatPhone(c.phone)}
                              {c.email ? ` · ${c.email}` : ''}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        {st ? (
                          <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium" style={{ background: `${st.stage.color}1f`, color: st.stage.color }}>
                            <span className="h-1.5 w-1.5 rounded-full" style={{ background: st.stage.color }} />
                            {st.stage.name}
                          </span>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                        {st && funnels.length > 1 && <p className="mt-0.5 text-[11px] text-slate-400">{st.funnel.name}</p>}
                      </td>
                      <td className="max-w-56 px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {c.tag_ids.map((id) => {
                            const t = tagById.get(id);
                            return t ? <TagChip key={id} name={t.name} color={t.color} /> : null;
                          })}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-slate-600">{member?.name ?? <span className="text-xs text-slate-400">Sin asignar</span>}</td>
                      <td className="px-3 py-2 text-right font-medium text-slate-700">{Number(c.deal_value) > 0 ? money(c.deal_value) : '—'}</td>
                      <td className="px-3 py-2 text-xs text-slate-500">{SOURCE_LABEL[c.source] ?? c.source}</td>
                      <td className="px-3 py-2 text-xs text-slate-500">
                        {c.last_message_at ? <>Mensaje {timeAgo(c.last_message_at)}</> : <>Creado {timeAgo(c.created_at)}</>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center justify-between border-t border-slate-100 px-3 py-2 text-sm text-slate-500">
          <span>
            {total.toLocaleString('es-MX')} contacto{total === 1 ? '' : 's'}
            {listQ.isFetching && !listQ.isLoading && <Spinner className="ml-2 inline h-4 w-4" />}
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} icon={<ChevronLeft className="h-4 w-4" />}>
              Anterior
            </Button>
            <span>
              Página {page} de {pages}
            </span>
            <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
              Siguiente <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </Card>

      {bulk && (
        <BulkModal
          action={bulk}
          ids={[...selected]}
          onClose={() => setBulk(null)}
          onDone={() => {
            setBulk(null);
            setSelected(new Set());
            refresh();
            void qc.invalidateQueries({ queryKey: ['board'] });
            void qc.invalidateQueries({ queryKey: ['tags'] });
          }}
        />
      )}
      {creating && <CreateContactModal onClose={() => setCreating(false)} onCreated={(id) => navigate(`/bandeja/${id}`)} />}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={refresh} />}
    </Page>
  );
}

function useCreateTag() {
  const qc = useQueryClient();
  return async (name: string): Promise<Tag> => {
    const r = await api.post<{ tag: Tag }>('/api/tags', { name });
    void qc.invalidateQueries({ queryKey: ['tags'] });
    return r.tag;
  };
}

const BULK_TITLE: Record<BulkAction, string> = {
  add_tags: 'Agregar etiquetas',
  remove_tags: 'Quitar etiquetas',
  move_stage: 'Mover de etapa',
  assign: 'Asignar asesor',
  archive: 'Archivar contactos',
  unarchive: 'Desarchivar contactos',
  opt_out: 'Dar de baja de difusiones',
  delete: 'Eliminar contactos',
};

function BulkModal({ action, ids, onClose, onDone }: { action: BulkAction; ids: string[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const funnels = useFunnels().data ?? [];
  const tags = useTags().data ?? [];
  const members = useMembers().data ?? [];
  const createTag = useCreateTag();
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [stageId, setStageId] = useState<string | null>(funnels[0]?.stages[0]?.id ?? null);
  const [userId, setUserId] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: () =>
      api.post<{ updated: number }>('/api/contacts/bulk', {
        ids,
        action,
        ...(action === 'add_tags' || action === 'remove_tags' ? { tag_ids: tagIds } : {}),
        ...(action === 'move_stage' ? { stage_id: stageId } : {}),
        ...(action === 'assign' ? { user_id: userId } : {}),
      }),
    onSuccess: (r) => {
      toast.success(`${r.updated} contacto${r.updated === 1 ? '' : 's'} actualizado${r.updated === 1 ? '' : 's'}`);
      onDone();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  async function submit() {
    if (action === 'delete') {
      const ok = await confirm(`Se eliminarán ${ids.length} contactos con todo su historial de mensajes. Esta acción no se puede deshacer.`, {
        title: 'Eliminar contactos',
        confirmText: 'Eliminar',
        danger: true,
      });
      if (!ok) return;
    }
    run.mutate();
  }

  const invalid = ((action === 'add_tags' || action === 'remove_tags') && !tagIds.length) || (action === 'move_stage' && !stageId);

  return (
    <Modal
      open
      onClose={onClose}
      title={BULK_TITLE[action]}
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant={action === 'delete' ? 'danger' : 'primary'} onClick={submit} loading={run.isPending} disabled={invalid}>
            Aplicar a {ids.length}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-slate-600">
        {(action === 'add_tags' || action === 'remove_tags') && (
          <Field label="Etiquetas">
            <TagMultiSelect tags={tags} value={tagIds} onChange={setTagIds} onCreate={action === 'add_tags' ? createTag : undefined} />
          </Field>
        )}
        {action === 'move_stage' && (
          <Field label="Etapa destino">
            <StageSelect funnels={funnels} value={stageId} onChange={setStageId} />
          </Field>
        )}
        {action === 'assign' && (
          <Field label="Asesor" hint="Elige “Sin asignar” para liberar los contactos.">
            <MemberSelect members={members} value={userId} onChange={setUserId} />
          </Field>
        )}
        {action === 'archive' && <p>Los contactos archivados se ocultan de la bandeja hasta que vuelvan a escribir.</p>}
        {action === 'unarchive' && <p>Los contactos volverán a mostrarse en la bandeja y en las listas.</p>}
        {action === 'opt_out' && <p>No recibirán más difusiones. Esto ayuda a cuidar la calidad de tu número en WhatsApp.</p>}
        {action === 'delete' && <Alert tone="error">Se borrarán los contactos y todas sus conversaciones.</Alert>}
      </div>
    </Modal>
  );
}

function CreateContactModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const funnels = useFunnels().data ?? [];
  const tags = useTags().data ?? [];
  const members = useMembers().data ?? [];
  const createTag = useCreateTag();
  const [form, setForm] = useState({ phone: '', name: '', email: '', company: '', deal_value: '' });
  const [stageId, setStageId] = useState<string | null>(null);
  const [assigned, setAssigned] = useState<string | null>(null);
  const [tagIds, setTagIds] = useState<string[]>([]);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ contact: Contact; created: boolean }>('/api/contacts', {
        phone: form.phone,
        name: form.name || undefined,
        email: form.email || undefined,
        company: form.company || undefined,
        deal_value: form.deal_value ? Number(form.deal_value) : undefined,
        stage_id: stageId ?? undefined,
        assigned_user_id: assigned ?? undefined,
        tag_ids: tagIds.length ? tagIds : undefined,
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['contacts'] });
      toast[r.created ? 'success' : 'info'](r.created ? 'Contacto creado' : 'Ese teléfono ya existía: te llevamos a su conversación');
      onCreated(r.contact.id);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Modal
      open
      onClose={onClose}
      title="Nuevo contacto"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={form.phone.replace(/\D/g, '').length < 8}>
            Crear contacto
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Teléfono (WhatsApp)" hint="Con lada del país, ej. +52 55 1234 5678" className="sm:col-span-2">
          <Input value={form.phone} onChange={set('phone')} autoFocus inputMode="tel" placeholder="+52 55 1234 5678" />
        </Field>
        <Field label="Nombre">
          <Input value={form.name} onChange={set('name')} />
        </Field>
        <Field label="Correo">
          <Input type="email" value={form.email} onChange={set('email')} />
        </Field>
        <Field label="Empresa">
          <Input value={form.company} onChange={set('company')} />
        </Field>
        <Field label="Valor estimado">
          <Input type="number" min={0} value={form.deal_value} onChange={set('deal_value')} placeholder="0" />
        </Field>
        <Field label="Etapa">
          <StageSelect funnels={funnels} value={stageId} onChange={setStageId} allowEmpty emptyLabel="Embudo principal (primera etapa)" />
        </Field>
        <Field label="Asignar a">
          <MemberSelect members={members} value={assigned} onChange={setAssigned} emptyLabel="Automático / sin asignar" />
        </Field>
        <Field label="Etiquetas" className="sm:col-span-2">
          <TagMultiSelect tags={tags} value={tagIds} onChange={setTagIds} onCreate={createTag} />
        </Field>
      </div>
      <p className="mt-4 text-xs text-slate-500">
        Para escribirle primero necesitarás una plantilla aprobada: WhatsApp solo permite texto libre durante 24 h después de que el cliente te escriba.
      </p>
    </Modal>
  );
}

interface ImportResult {
  total: number;
  created: number;
  existing: number;
  errors: { row: number; error: string }[];
  error_count: number;
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const funnels = useFunnels().data ?? [];
  const tags = useTags().data ?? [];
  const createTag = useCreateTag();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [stageId, setStageId] = useState<string | null>(null);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [result, setResult] = useState<ImportResult | null>(null);

  const run = useMutation({
    mutationFn: () => api.post<ImportResult>('/api/contacts/import', { csv, stage_id: stageId ?? undefined, tag_ids: tagIds.length ? tagIds : undefined }),
    onSuccess: (r) => {
      setResult(r);
      onDone();
      toast.success(`Importación lista: ${r.created} nuevos`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setCsv(String(reader.result ?? ''));
      setFileName(file.name);
    };
    reader.onerror = () => toast.error('No se pudo leer el archivo');
    reader.readAsText(file, 'utf-8');
  }

  const rows = csv.trim() ? csv.trim().split(/\r?\n/).length - 1 : 0;

  return (
    <Modal
      open
      onClose={onClose}
      title="Importar contactos desde CSV"
      size="lg"
      footer={
        result ? (
          <Button onClick={onClose}>Listo</Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button onClick={() => run.mutate()} loading={run.isPending} disabled={!csv.trim()} icon={<Upload className="h-4 w-4" />}>
              Importar {rows > 0 ? `${rows} filas` : ''}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['Filas', result.total],
              ['Nuevos', result.created],
              ['Ya existían', result.existing],
              ['Con error', result.error_count],
            ].map(([label, n]) => (
              <div key={label} className="rounded-lg border border-slate-200 p-3 text-center">
                <p className="text-xs text-slate-500">{label}</p>
                <p className="text-xl font-semibold text-slate-900">{n}</p>
              </div>
            ))}
          </div>
          {result.existing > 0 && <p className="text-sm text-slate-500">A los contactos que ya existían solo se les agregaron las etiquetas.</p>}
          {result.errors.length > 0 && (
            <div className="max-h-56 overflow-y-auto rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
              {result.errors.map((e) => (
                <p key={e.row}>
                  Fila {e.row}: {e.error}
                </p>
              ))}
              {result.error_count > result.errors.length && <p>…y {result.error_count - result.errors.length} más</p>}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <Alert tone="info" title="Columnas reconocidas">
            <b>teléfono</b> (obligatoria, con lada), <b>nombre</b>, <b>correo</b>, <b>empresa</b>, <b>etiquetas</b> (separadas por “;”) y <b>valor</b>. Cualquier otra
            columna se guarda como campo personalizado. Los teléfonos repetidos no se duplican.
          </Alert>
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
              <Upload className="h-4 w-4" /> Elegir archivo .csv
              <input type="file" accept=".csv,text/csv,text/plain" className="hidden" onChange={onFile} />
            </label>
            {fileName && <span className="text-sm text-slate-500">{fileName}</span>}
          </div>
          <Field label="…o pega el contenido" hint={rows > 0 ? `${rows} filas detectadas (sin contar el encabezado)` : 'La primera fila debe tener los nombres de las columnas.'}>
            <Textarea
              rows={6}
              value={csv}
              onChange={(e) => {
                setCsv(e.target.value);
                setFileName(null);
              }}
              placeholder={'nombre,teléfono,correo,etiquetas\nAna López,+52 55 1234 5678,ana@correo.com,VIP;Expo'}
              className="font-mono text-xs"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Etapa para los nuevos">
              <StageSelect funnels={funnels} value={stageId} onChange={setStageId} allowEmpty emptyLabel="Embudo principal (primera etapa)" />
            </Field>
            <Field label="Etiquetas para todos">
              <TagMultiSelect tags={tags} value={tagIds} onChange={setTagIds} onCreate={createTag} />
            </Field>
          </div>
        </div>
      )}
    </Modal>
  );
}
