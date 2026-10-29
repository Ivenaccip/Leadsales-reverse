import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { infiniteQueryOptions, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { MessageSquarePlus, Search, SlidersHorizontal, Smartphone } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { displayName, timeAgo } from '../../lib/format';
import { stageMap, useChannels, useFunnels, useMembers, useTags } from '../../lib/queries';
import type { Contact, Paged } from '../../lib/types';
import { StageSelect } from '../pickers';
import { Avatar, Button, cx, EmptyState, Select, Spinner } from '../ui';
import { LIVE_QUERY, uniqueById, type ConversationFilters, type InboxTab } from './helpers';

const PAGE_SIZE = 30;

export interface Counts {
  all: number;
  mine: number;
  unassigned: number;
  unread: number;
}

/**
 * The inbox list. Pages are read by keyset (`cursor`: after the last row the server sent), not by
 * page number: live events move conversations to the top or out of this tab in the cached pages,
 * and an OFFSET into the server's current order would then skip conversations or repeat them.
 */
export function conversationsQuery(filters: ConversationFilters) {
  return infiniteQueryOptions({
    queryKey: ['conversations', filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.get<Paged<Contact>>(
        `/api/contacts${qs({
          has_messages: true,
          sort: 'recent',
          inbox: filters.inbox,
          search: filters.search.trim(),
          unread: filters.unread,
          tag_id: filters.tag_id,
          stage_id: filters.stage_id,
          cursor: pageParam,
          limit: PAGE_SIZE,
        })}`,
      ),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    ...LIVE_QUERY,
  });
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function ConversationList({ selectedId, onSelect, className }: { selectedId?: string; onSelect: (id: string) => void; className?: string }) {
  const [tab, setTab] = useState<InboxTab>('all');
  const [searchInput, setSearchInput] = useState('');
  const [unread, setUnread] = useState(false);
  const [tagId, setTagId] = useState('');
  const [stageId, setStageId] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const search = useDebounced(searchInput, 300);

  const filters: ConversationFilters = useMemo(() => ({ inbox: tab, search, unread, tag_id: tagId, stage_id: stageId }), [tab, search, unread, tagId, stageId]);

  const funnels = useFunnels();
  const tags = useTags();
  const members = useMembers();
  const channels = useChannels();
  const stages = useMemo(() => stageMap(funnels.data), [funnels.data]);
  const memberName = useMemo(() => new Map((members.data ?? []).map((m) => [m.id, m.name])), [members.data]);

  const counts = useQuery({ queryKey: ['contact-counts'], queryFn: () => api.get<Counts>('/api/contacts/counts'), ...LIVE_QUERY });

  const list = useInfiniteQuery(conversationsQuery(filters));

  // A conversation an event put into the first page can come again with a later one.
  const items = uniqueById(list.data?.pages.flatMap((p) => p.items) ?? []);
  // Deleting the only number keeps its conversations: they stay listed, with a nudge to connect one.
  const noChannel = !!channels.data && channels.data.length === 0;
  const activeFilters = Number(unread) + Number(!!tagId) + Number(!!stageId);
  const tabs: { id: InboxTab; label: string; count?: number }[] = [
    { id: 'all', label: 'Todas', count: counts.data?.all },
    { id: 'mine', label: 'Mías', count: counts.data?.mine },
    { id: 'unassigned', label: 'Sin asignar', count: counts.data?.unassigned },
  ];

  return (
    <div className={cx('min-h-0 flex-col border-r border-slate-200 bg-white', className)}>
      <div className="space-y-3 border-b border-slate-200 px-3 pb-2 pt-3">
        <div className="flex items-center justify-between">
          <h1 className="px-1 text-lg font-semibold text-slate-900">Bandeja</h1>
          {counts.data && counts.data.unread > 0 && (
            <span className="rounded-full bg-brand-600 px-2 py-0.5 text-xs font-semibold text-white">{counts.data.unread} sin leer</span>
          )}
        </div>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Buscar nombre, teléfono, correo…"
              className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pl-8 pr-3 text-sm placeholder:text-slate-400 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
          </div>
          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            title="Filtros"
            className={cx(
              'relative inline-flex h-9 w-9 items-center justify-center rounded-lg border text-slate-500 hover:bg-slate-50',
              showFilters || activeFilters ? 'border-brand-300 text-brand-700' : 'border-slate-200',
            )}
          >
            <SlidersHorizontal className="h-4 w-4" />
            {activeFilters > 0 && (
              <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-brand-600 text-[10px] font-bold text-white">{activeFilters}</span>
            )}
          </button>
        </div>
        {showFilters && (
          <div className="space-y-2 rounded-lg bg-slate-50 p-2">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={unread} onChange={(e) => setUnread(e.target.checked)} className="h-4 w-4 accent-brand-600" />
              Solo no leídos
            </label>
            <Select value={tagId} onChange={(e) => setTagId(e.target.value)} className="h-9">
              <option value="">Todas las etiquetas</option>
              {(tags.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
            <StageSelect className="h-9" funnels={funnels.data ?? []} value={stageId} onChange={(v) => setStageId(v ?? '')} allowEmpty emptyLabel="Todas las etapas" />
            {activeFilters > 0 && (
              <button
                type="button"
                className="text-xs font-medium text-brand-700 hover:underline"
                onClick={() => {
                  setUnread(false);
                  setTagId('');
                  setStageId('');
                }}
              >
                Limpiar filtros
              </button>
            )}
          </div>
        )}
        <div className="flex gap-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cx(
                'flex flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-lg px-1.5 py-1.5 text-xs font-medium transition-colors',
                tab === t.id ? 'bg-brand-50 text-brand-800' : 'text-slate-500 hover:bg-slate-100',
              )}
            >
              {t.label}
              {t.count != null && <span className={cx('rounded-full px-1.5 text-[11px]', tab === t.id ? 'bg-brand-100' : 'bg-slate-100')}>{t.count}</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {noChannel && items.length > 0 && (
          <div className="m-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            No hay ningún número de WhatsApp conectado: puedes revisar tus conversaciones, pero para responder{' '}
            <Link to="/ajustes/canales" className="font-medium underline">
              conecta un número
            </Link>
            .
          </div>
        )}
        {list.isLoading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : noChannel && items.length === 0 ? (
          <EmptyState
            icon={<Smartphone className="h-6 w-6" />}
            title="Conecta tu número de WhatsApp"
            description="Agrega tu número de la API oficial de WhatsApp (o un canal de pruebas) para empezar a recibir conversaciones."
            action={
              <Link to="/ajustes/canales">
                <Button size="sm">Ir a Canales</Button>
              </Link>
            }
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<MessageSquarePlus className="h-6 w-6" />}
            title={search || activeFilters || tab !== 'all' ? 'Sin resultados' : 'Aún no hay conversaciones'}
            description={
              search || activeFilters || tab !== 'all'
                ? 'Prueba con otros filtros.'
                : 'Cuando un cliente te escriba aparecerá aquí. ¿Quieres probar? Crea un canal sandbox en Ajustes → Canales y simula mensajes.'
            }
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {items.map((c) => {
              const stage = c.stage_id ? stages.get(c.stage_id)?.stage : undefined;
              const assigned = c.assigned_user_id ? memberName.get(c.assigned_user_id) : undefined;
              const unreadCount = c.unread_count;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(c.id)}
                    className={cx('flex w-full gap-3 px-3 py-3 text-left transition-colors', c.id === selectedId ? 'bg-brand-50' : 'hover:bg-slate-50')}
                  >
                    <Avatar name={c.name ?? c.phone} seed={c.id} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className={cx('truncate text-sm', unreadCount ? 'font-semibold text-slate-900' : 'font-medium text-slate-800')}>{displayName(c)}</span>
                        <span className={cx('shrink-0 text-[11px]', unreadCount ? 'font-semibold text-brand-700' : 'text-slate-400')}>{timeAgo(c.last_message_at)}</span>
                      </span>
                      <span className="mt-0.5 flex items-center justify-between gap-2">
                        <span className={cx('truncate text-xs', unreadCount ? 'text-slate-700' : 'text-slate-500')}>{c.last_message_preview ?? ''}</span>
                        {unreadCount > 0 && (
                          <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand-600 px-1.5 text-[11px] font-bold text-white">
                            {unreadCount > 99 ? '99+' : unreadCount}
                          </span>
                        )}
                      </span>
                      <span className="mt-1 flex items-center gap-2 text-[11px] text-slate-400">
                        {stage && (
                          <span className="inline-flex min-w-0 items-center gap-1">
                            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: stage.color }} />
                            <span className="truncate">{stage.name}</span>
                          </span>
                        )}
                        {assigned ? (
                          <span className="ml-auto inline-flex items-center gap-1" title={`Asignado a ${assigned}`}>
                            <Avatar name={assigned} size="sm" />
                          </span>
                        ) : (
                          <span className="ml-auto rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">Sin asignar</span>
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {list.hasNextPage && (
          <div className="p-3">
            <Button variant="outline" size="sm" className="w-full" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              Cargar más
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
