import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  BarChart3,
  Bot,
  ChevronDown,
  Coins,
  FileText,
  Inbox,
  KanbanSquare,
  LogOut,
  Megaphone,
  Plus,
  Settings,
  Shield,
  Users,
} from 'lucide-react';
import { useSession, workspaceUsable } from '../lib/session';
import { connectRealtime, useRealtime, useRealtimeResync } from '../lib/realtime';
import { useCredits } from '../lib/queries';
import { credits as fmtCredits } from '../lib/format';
import { api, errorMessage } from '../lib/api';
import type { Estimate } from '../lib/types';
import { revokeContact } from './inbox/helpers';
import { Avatar, Button, Field, Input, Modal, cx, useToast } from './ui';

const NAV = [
  { to: '/bandeja', label: 'Bandeja', icon: Inbox },
  { to: '/embudos', label: 'Embudos', icon: KanbanSquare },
  { to: '/contactos', label: 'Contactos', icon: Users },
  { to: '/difusiones', label: 'Difusiones', icon: Megaphone, admin: true },
  { to: '/plantillas', label: 'Plantillas', icon: FileText },
  { to: '/automatizacion', label: 'Bot e IA', icon: Bot, admin: true },
  { to: '/reportes', label: 'Reportes', icon: BarChart3 },
  { to: '/creditos', label: 'Créditos', icon: Coins },
  { to: '/ajustes', label: 'Ajustes', icon: Settings },
];

/**
 * The balance changed (a top-up, a charge): the sidebar's balance and any broadcast estimate, whose
 * "Créditos insuficientes" and disabled "Enviar" come from the balance it was computed with.
 * Charges come every couple of seconds while a broadcast runs, and an estimate scans its whole
 * audience: the cached ones get the fresh balance instead of being computed again.
 */
export async function refreshCredits(qc: QueryClient) {
  const before = qc.getQueryState(['credits'])?.dataUpdateCount ?? 0;
  await qc.invalidateQueries({ queryKey: ['credits'] });
  const state = qc.getQueryState<{ billing_mode: Estimate['billing_mode']; balance: number }>(['credits']);
  // A newer update cancelled this reload and is reloading it: that one patches the estimates.
  if (state?.fetchStatus === 'fetching') return;
  const fresh = state?.data && state.dataUpdateCount > before ? state.data : null;
  for (const [key, e] of qc.getQueriesData<Estimate>({ queryKey: ['broadcast-estimate'] })) {
    if (!e) continue;
    // The billing mode changed since: the server computes it again.
    if (fresh && fresh.billing_mode !== e.billing_mode) void qc.invalidateQueries({ queryKey: key, exact: true });
    else if (e.billing_mode !== 'prepaid') continue; // the balance plays no part in it
    else if (fresh) qc.setQueryData<Estimate>(key, { ...e, balance: fresh.balance, sufficient: fresh.balance >= e.cost });
    // The balance could not be reloaded here: ask the server.
    else void qc.invalidateQueries({ queryKey: key, exact: true });
  }
}

/**
 * Whether to offer "Nuevo espacio": the server lets only the instance operator create workspaces
 * when sign-up is closed (ALLOW_SIGNUP=false).
 */
export function canCreateWorkspace(user: { is_superadmin: boolean } | null, instance: { allowSignup: boolean } | undefined): boolean {
  return !!user?.is_superadmin || !!instance?.allowSignup;
}

function WorkspaceMenu() {
  const { workspaces, workspace, switchWorkspace, user, logout, setSession } = useSession();
  const instance = useQuery({ queryKey: ['instance'], queryFn: () => api.get<{ allowSignup: boolean }>('/api/instance'), staleTime: Infinity, enabled: !user?.is_superadmin });
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();

  async function create() {
    setSaving(true);
    try {
      const r = await api.post<{ id: string; workspaces: any[] }>('/api/workspaces', { name });
      setSession({ user: user!, workspaces: r.workspaces });
      switchWorkspace(r.id);
      setCreating(false);
      setName('');
      navigate('/ajustes/canales');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-white/10"
      >
        <Avatar name={workspace?.name} size="sm" />
        <span className="hidden min-w-0 flex-1 lg:block">
          <span className="block truncate text-sm font-semibold text-white">{workspace?.name ?? 'Sin espacio'}</span>
          <span className="block truncate text-xs text-brand-100/80">{user?.name}</span>
        </span>
        <ChevronDown className="hidden h-4 w-4 text-brand-100 lg:block" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-40 mb-2 w-64 rounded-xl border border-slate-200 bg-white p-1 text-slate-700 shadow-xl">
            <p className="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-slate-400">Espacios de trabajo</p>
            {workspace && !workspaces.some((w) => w.id === workspace.id) && (
              <div className="flex w-full items-center gap-2 rounded-lg bg-brand-50 px-3 py-2 text-left text-sm text-brand-800">
                <span className="flex-1 truncate">{workspace.name}</span>
                <span className="text-xs text-slate-400">Operador</span>
              </div>
            )}
            {workspaces.map((w) => (
              <button
                key={w.id}
                disabled={!workspaceUsable(user, w)}
                title={w.is_active === false ? 'El administrador de la instancia suspendió este espacio' : undefined}
                onClick={() => {
                  switchWorkspace(w.id);
                  setOpen(false);
                  navigate('/bandeja');
                }}
                className={cx(
                  'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60',
                  w.id === workspace?.id && 'bg-brand-50 text-brand-800',
                )}
              >
                <span className="flex-1 truncate">{w.name}</span>
                <span className="text-xs text-slate-400">{w.is_active === false ? 'Suspendido' : w.role === 'owner' ? 'Propietario' : w.role === 'admin' ? 'Admin' : 'Agente'}</span>
              </button>
            ))}
            {canCreateWorkspace(user, instance.data) && (
              <button
                onClick={() => {
                  setCreating(true);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-100"
              >
                <Plus className="h-4 w-4" /> Nuevo espacio
              </button>
            )}
            <div className="my-1 border-t border-slate-100" />
            <NavLink to="/ajustes/perfil" onClick={() => setOpen(false)} className="block rounded-lg px-3 py-2 text-sm hover:bg-slate-100">
              Mi perfil
            </NavLink>
            <button
              onClick={() => void logout().catch((err) => toast.error(errorMessage(err)))}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
            >
              <LogOut className="h-4 w-4" /> Cerrar sesión
            </button>
          </div>
        </>
      )}
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Nuevo espacio de trabajo"
        size="sm"
        footer={
          <Button onClick={create} loading={saving} disabled={name.trim().length < 2}>
            Crear
          </Button>
        }
      >
        <Field label="Nombre del negocio" hint="Cada espacio tiene sus propios números, contactos y embudos.">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Mi otra marca" />
        </Field>
      </Modal>
    </div>
  );
}

export function Layout() {
  const { workspace, isAdmin, user } = useSession();
  const qc = useQueryClient();
  const creditsQ = useCredits();

  useEffect(() => {
    connectRealtime(workspace?.id ?? null);
  }, [workspace?.id, user?.id]);

  useRealtime('credits:update', () => void refreshCredits(qc));
  // A restricted agent lost access to a conversation (assigned to someone else): forget it everywhere.
  useRealtime<{ id: string }>('contact:revoked', (e) => revokeContact(qc, e.id));
  // After a reconnection, events sent while the socket was down never arrive: refetch what is shown.
  useRealtimeResync(() => void qc.invalidateQueries());

  const nav = NAV.filter((n) => !n.admin || isAdmin);

  return (
    <div className="flex h-full">
      <aside className="flex w-16 shrink-0 flex-col bg-brand-800 px-2 py-3 lg:w-60">
        <div className="mb-4 flex items-center gap-2 px-2">
          <img src="/favicon.svg" alt="" className="h-8 w-8 rounded-lg ring-2 ring-white/20" />
          <span className="hidden text-lg font-bold tracking-tight text-white lg:block">LeadLibre</span>
        </div>
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              title={label}
              className={({ isActive }) =>
                cx(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  isActive ? 'bg-white/15 text-white' : 'text-brand-100/80 hover:bg-white/10 hover:text-white',
                )
              }
            >
              <Icon className="h-5 w-5 shrink-0" />
              <span className="hidden lg:block">{label}</span>
            </NavLink>
          ))}
          {user?.is_superadmin && (
            <NavLink
              to="/admin"
              title="Administración"
              className={({ isActive }) =>
                cx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium', isActive ? 'bg-white/15 text-white' : 'text-brand-100/80 hover:bg-white/10 hover:text-white')
              }
            >
              <Shield className="h-5 w-5 shrink-0" />
              <span className="hidden lg:block">Administración</span>
            </NavLink>
          )}
        </nav>
        {creditsQ.data && (
          <NavLink to="/creditos" className="mb-2 hidden rounded-lg bg-white/10 px-3 py-2 text-xs text-brand-50 hover:bg-white/15 lg:block">
            {creditsQ.data.billing_mode === 'prepaid' ? (
              <>
                <span className="block text-brand-100/80">Saldo de créditos</span>
                <span className="text-sm font-semibold">{fmtCredits(creditsQ.data.balance)}</span>
              </>
            ) : (
              <>
                <span className="block text-brand-100/80">Gasto en Meta este mes</span>
                <span className="text-sm font-semibold">{fmtCredits(creditsQ.data.spent_this_month)}</span>
              </>
            )}
          </NavLink>
        )}
        <WorkspaceMenu />
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
