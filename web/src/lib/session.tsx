import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, ApiError, getWorkspaceId, getWorkspaceOpener, setUnauthorizedHandler, setWorkspaceId } from './api';
import { disconnectRealtime, setRealtimeSessionHandlers } from './realtime';
import type { Role, User, Workspace, WorkspaceSummary } from './types';

interface SessionValue {
  loading: boolean;
  user: User | null;
  workspaces: WorkspaceSummary[];
  /** The current workspace: a membership, or (instance operator only) any workspace opened from Administración. */
  workspace: WorkspaceSummary | null;
  role: Role | null;
  isAdmin: boolean;
  setSession: (s: { user: User; workspaces: WorkspaceSummary[] }) => void;
  switchWorkspace: (id: string, summary?: WorkspaceSummary) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * Cached queries and the realtime socket belong to the user who was signed in when they were
 * created (the server authenticates a socket only at its handshake). Both are dropped when that
 * user signs out or another one signs in, so nothing of the previous user leaks into the tab.
 */
export function createClientSession(qc: QueryClient) {
  let owner: string | null = null;
  const reset = () => {
    disconnectRealtime();
    qc.clear();
  };
  return {
    begin(userId: string) {
      if (owner === userId) return;
      if (owner) reset();
      owner = userId;
    },
    end() {
      owner = null;
      reset();
    },
  };
}

/**
 * Whether the user can work in this membership: the server refuses everything in a workspace the
 * operator suspended, except to the operator themself (an owner everywhere).
 */
export function workspaceUsable(user: Pick<User, 'is_superadmin'> | null, w: WorkspaceSummary): boolean {
  return w.is_active !== false || !!user?.is_superadmin;
}

/**
 * Which workspace to use after loading the session. `stored`/`opener` come from the browser, which
 * may be shared: a workspace without a membership is kept only for the operator who opened it, never
 * inherited from whoever used the tab before. A suspended membership is never picked.
 */
export function pickWorkspace(
  user: User,
  workspaces: WorkspaceSummary[],
  stored: string | null,
  opener: string | null,
): { id: string | null; foreign: boolean } {
  const usable = workspaces.filter((w) => workspaceUsable(user, w));
  const own = usable.find((w) => w.id === stored);
  if (own) return { id: own.id, foreign: false };
  // The instance operator may work inside any workspace (Administración → Abrir) without a membership.
  if (stored && user.is_superadmin && opener === user.id) return { id: stored, foreign: true };
  return { id: usable[0]?.id ?? null, foreign: false };
}

/** The operator to remember as opener when `id` is stored: only a superadmin without a membership there. */
export function workspaceOpener(user: User | null, workspaces: WorkspaceSummary[], id: string | null): string | null {
  return id && user?.is_superadmin && !workspaces.some((w) => w.id === id) ? user.id : null;
}

/** Why a signed-in member has no workspace to work in, or null when they have one. */
export function noWorkspaceReason(s: Pick<SessionValue, 'user' | 'workspace' | 'workspaces'>): string | null {
  if (s.workspace || !s.user || s.user.is_superadmin) return null;
  if (s.workspaces.some((w) => w.is_active === false)) {
    return 'El administrador de la instancia suspendió tu espacio de trabajo. Contáctalo para reactivarlo.';
  }
  return 'Tu usuario no pertenece a ningún espacio de trabajo activo. Pide a un administrador que te envíe una invitación.';
}

const placeholder = (id: string): WorkspaceSummary => ({ id, name: 'Espacio de trabajo', role: 'owner', billing_mode: 'meta_direct', is_active: true });

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [client] = useState(() => createClientSession(qc));
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [wsId, setWsId] = useState<string | null>(getWorkspaceId());
  const [foreign, setForeign] = useState<WorkspaceSummary | null>(null);
  // Only the latest /api/auth/me may be applied: rights can change several times in a row.
  const loadSeq = useRef(0);

  const apply = useCallback(
    (s: { user: User; workspaces: WorkspaceSummary[] }) => {
      client.begin(s.user.id);
      setUser(s.user);
      setWorkspaces(s.workspaces);
      const current = getWorkspaceId();
      const pick = pickWorkspace(s.user, s.workspaces, current, getWorkspaceOpener());
      setForeign((prev) => (pick.foreign && pick.id ? (prev?.id === pick.id ? prev : placeholder(pick.id)) : null));
      setWorkspaceId(pick.id, workspaceOpener(s.user, s.workspaces, pick.id));
      setWsId(pick.id);
      // The tab moved to another workspace (access to the shown one was lost): its cached pages go.
      if (current && current !== pick.id) qc.clear();
    },
    [client, qc],
  );

  const signOut = useCallback(() => {
    loadSeq.current++; // a session load still in flight belongs to the signed-out user
    client.end();
    setUser(null);
    setWorkspaces([]);
    setForeign(null);
  }, [client]);

  const loadMe = useCallback(async () => {
    const seq = ++loadSeq.current;
    const s = await api.get<{ user: User; workspaces: WorkspaceSummary[] }>('/api/auth/me');
    if (seq === loadSeq.current) apply(s);
  }, [apply]);

  const refresh = useCallback(async () => {
    try {
      await loadMe();
    } catch {
      setUser(null);
      setWorkspaces([]);
    } finally {
      setLoading(false);
    }
  }, [loadMe]);

  useEffect(() => {
    setUnauthorizedHandler(signOut);
    setRealtimeSessionHandlers({
      revoked: signOut,
      // A handshake refused as 'unauthorized' usually means the session ended: a 401 here signs out
      // (see api.ts). Any other answer keeps it, and the socket tries again once this settles.
      unauthorized: () => api.get('/api/auth/me').catch(() => {}),
      // Rights changed while the tab is open (role, membership, suspension, operator status): reload
      // them. A passing network error keeps the session; a 401 still signs out (api.ts).
      refreshed: () => void loadMe().catch(() => {}),
    });
    void refresh();
  }, [refresh, loadMe, signOut]);

  // A workspace opened as operator is not in /api/auth/me: load its name and billing mode.
  const foreignId = foreign?.id ?? null;
  useEffect(() => {
    if (!user?.is_superadmin || !foreignId || foreignId !== wsId || workspaces.some((w) => w.id === wsId)) return;
    let cancelled = false;
    api
      .get<{ workspace: Workspace }>('/api/workspace')
      .then(({ workspace: w }) => {
        if (cancelled || getWorkspaceId() !== w.id) return;
        setForeign({ id: w.id, name: w.name, role: 'owner', billing_mode: w.billing_mode, is_active: w.is_active });
      })
      .catch((err) => {
        // Deleted (or otherwise unreachable) workspace: fall back to a membership.
        if (cancelled || !(err instanceof ApiError) || err.status >= 500 || err.status === 401) return;
        const next = workspaces.find((w) => workspaceUsable(user, w))?.id ?? null;
        setForeign(null);
        setWorkspaceId(next);
        setWsId(next);
        qc.clear();
      });
    return () => {
      cancelled = true;
    };
  }, [user, foreignId, wsId, workspaces, qc]);

  const switchWorkspace = useCallback(
    (id: string, summary?: WorkspaceSummary) => {
      const membership = workspaces.find((w) => w.id === id);
      if (membership && !workspaceUsable(user, membership)) return;
      const member = !!membership;
      setForeign(member ? null : { ...(summary ?? placeholder(id)), id, role: 'owner' });
      setWorkspaceId(id, workspaceOpener(user, workspaces, id));
      setWsId(id);
      qc.clear();
      // The role shown comes from the last /api/auth/me: rights in this workspace may have changed
      // while the tab showed another one, so they are reloaded (a lost membership moves the tab on).
      void loadMe().catch(() => {});
    },
    [qc, workspaces, user, loadMe],
  );

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout').catch(() => {});
    signOut();
  }, [signOut]);

  const value = useMemo<SessionValue>(() => {
    const workspace = workspaces.find((w) => w.id === wsId) ?? (user?.is_superadmin && foreign?.id === wsId ? foreign : null);
    // Same rule as the server: the instance operator is an owner in every workspace.
    const role = user?.is_superadmin && wsId ? 'owner' : (workspace?.role ?? null);
    return {
      loading,
      user,
      workspaces,
      workspace,
      role,
      isAdmin: role === 'owner' || role === 'admin',
      setSession: (s) => {
        apply(s);
        setLoading(false);
      },
      switchWorkspace,
      refresh,
      logout,
    };
  }, [loading, user, workspaces, wsId, foreign, apply, switchWorkspace, refresh, logout]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession fuera de SessionProvider');
  return v;
}
