import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, getWorkspaceId, setUnauthorizedHandler, setWorkspaceId } from './api';
import type { Role, User, WorkspaceSummary } from './types';

interface SessionValue {
  loading: boolean;
  user: User | null;
  workspaces: WorkspaceSummary[];
  workspace: WorkspaceSummary | null;
  role: Role | null;
  isAdmin: boolean;
  setSession: (s: { user: User; workspaces: WorkspaceSummary[] }) => void;
  switchWorkspace: (id: string) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [wsId, setWsId] = useState<string | null>(getWorkspaceId());

  const apply = useCallback((s: { user: User; workspaces: WorkspaceSummary[] }) => {
    setUser(s.user);
    setWorkspaces(s.workspaces);
    const current = s.workspaces.find((w) => w.id === getWorkspaceId()) ?? s.workspaces[0] ?? null;
    setWorkspaceId(current?.id ?? null);
    setWsId(current?.id ?? null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      apply(await api.get<{ user: User; workspaces: WorkspaceSummary[] }>('/api/auth/me'));
    } catch {
      setUser(null);
      setWorkspaces([]);
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      qc.clear();
    });
    void refresh();
  }, [refresh, qc]);

  const switchWorkspace = useCallback(
    (id: string) => {
      setWorkspaceId(id);
      setWsId(id);
      qc.clear();
    },
    [qc],
  );

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout').catch(() => {});
    setUser(null);
    setWorkspaces([]);
    qc.clear();
  }, [qc]);

  const value = useMemo<SessionValue>(() => {
    const workspace = workspaces.find((w) => w.id === wsId) ?? null;
    const role = workspace?.role ?? (user?.is_superadmin && wsId ? 'owner' : null);
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
  }, [loading, user, workspaces, wsId, apply, switchWorkspace, refresh, logout]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession fuera de SessionProvider');
  return v;
}
