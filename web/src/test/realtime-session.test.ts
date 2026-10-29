import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/** Minimal stand-in for a socket.io client socket: records emits, lets the test play the server. */
class FakeSocket {
  connected = false;
  disconnected = false;
  handlers = new Map<string, ((...args: any[]) => void)[]>();
  anyHandlers: ((event: string, ...args: any[]) => void)[] = [];
  emitted: { event: string; args: any[] }[] = [];
  on(event: string, fn: (...args: any[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
    return this;
  }
  onAny(fn: (event: string, ...args: any[]) => void) {
    this.anyHandlers.push(fn);
    return this;
  }
  emit(event: string, ...args: any[]) {
    this.emitted.push({ event, args });
    return this;
  }
  disconnect() {
    this.connected = false;
    this.disconnected = true;
    return this;
  }
  // ---- server side ----
  serverConnect() {
    this.connected = true;
    for (const fn of this.handlers.get('connect') ?? []) fn();
  }
  serverDrop() {
    this.connected = false;
  }
  serverEmit(event: string, data?: unknown) {
    for (const fn of this.anyHandlers) fn(event, data);
    for (const fn of this.handlers.get(event) ?? []) fn(data);
  }
  /** Acknowledges the last 'join' with the given result. */
  ackJoin(ok: boolean) {
    const joins = this.emitted.filter((e) => e.event === 'join');
    const last = joins[joins.length - 1];
    last.args[1]({ ok });
    return last.args[0] as string;
  }
  joins() {
    return this.emitted.filter((e) => e.event === 'join').map((e) => e.args[0]);
  }
}

const sockets: FakeSocket[] = [];
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  }),
}));

const { connectRealtime, disconnectRealtime, onRealtimeResync, setRealtimeSessionHandlers, subscribeRealtime } = await import('../lib/realtime');
const { createClientSession, pickWorkspace, SessionProvider, useSession, workspaceOpener } = await import('../lib/session');
const { getWorkspaceId, getWorkspaceOpener, setWorkspaceId } = await import('../lib/api');

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  disconnectRealtime();
  sockets.length = 0;
});

/** Signs in "user" on workspace "ws" the way Layout does, and completes the handshake + join. */
function signIn(client: ReturnType<typeof createClientSession>, user: string, ws: string): FakeSocket {
  client.begin(user);
  setWorkspaceId(ws);
  connectRealtime(ws);
  const s = sockets[sockets.length - 1];
  s.serverConnect();
  s.ackJoin(true);
  return s;
}

describe('realtime connection follows the signed-in user (#38)', () => {
  it('logout disconnects the socket and clears the cache; the next user gets a new handshake', () => {
    const qc = new QueryClient();
    const client = createClientSession(qc);
    const seen: string[] = [];
    subscribeRealtime<{ name: string }>('contact:new', (c) => seen.push(c.name));

    const a = signIn(client, 'user-a', 'ws-a');
    expect(a.joins()).toEqual(['ws-a']);
    qc.setQueryData(['conversations', {}], { pages: [{ items: [{ id: 'lead-a' }] }] });

    client.end();
    expect(a.disconnected).toBe(true);
    expect(qc.getQueryCache().getAll()).toHaveLength(0);

    const b = signIn(client, 'user-b', 'ws-b');
    expect(sockets).toHaveLength(2);
    expect(b).not.toBe(a);
    expect(b.joins()).toEqual(['ws-b']);
    // The old connection can no longer feed the new user's handlers.
    a.serverEmit('contact:new', { name: 'Cliente de A' });
    b.serverEmit('contact:new', { name: 'Cliente de B' });
    expect(seen).toEqual(['Cliente de B']);
  });

  it('a different user signing in without a logout also resets the connection and the cache', () => {
    const qc = new QueryClient();
    const client = createClientSession(qc);
    const a = signIn(client, 'user-a', 'ws-a');
    qc.setQueryData(['contact', 'x'], { contact: { id: 'x' } });

    client.begin('user-a'); // same user (profile refresh, new workspace): nothing to reset
    expect(a.disconnected).toBe(false);
    expect(qc.getQueryData(['contact', 'x'])).toBeTruthy();

    client.begin('user-b');
    expect(a.disconnected).toBe(true);
    expect(qc.getQueryData(['contact', 'x'])).toBeUndefined();
    connectRealtime('ws-b');
    expect(sockets).toHaveLength(2);
  });

  it("'session:revoked' drops the socket and signs the tab out", () => {
    const qc = new QueryClient();
    const client = createClientSession(qc);
    const revoked = vi.fn();
    setRealtimeSessionHandlers({ revoked });
    const a = signIn(client, 'user-a', 'ws-a');

    a.serverEmit('session:revoked', {});
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(a.disconnected).toBe(true);
    connectRealtime('ws-a');
    expect(sockets).toHaveLength(2);
  });

  it("a refused handshake ('unauthorized') asks the session to verify itself", () => {
    const unauthorized = vi.fn();
    setRealtimeSessionHandlers({ unauthorized });
    setWorkspaceId('ws-a');
    connectRealtime('ws-a');
    for (const fn of sockets[0].handlers.get('connect_error') ?? []) fn(new Error('unauthorized'));
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });
});

describe('resync after reconnecting (#82)', () => {
  it('fires after a reconnection re-joins the same workspace, not on the first join or a switch', () => {
    const qc = new QueryClient();
    const client = createClientSession(qc);
    const resync = vi.fn();
    const off = onRealtimeResync(resync);
    const s = signIn(client, 'user-a', 'ws-a');
    expect(resync).not.toHaveBeenCalled();

    // Network drop: events emitted meanwhile are lost, so after re-joining the pages must refetch.
    s.serverDrop();
    s.serverConnect();
    expect(s.joins()).toEqual(['ws-a', 'ws-a']);
    s.ackJoin(true);
    expect(resync).toHaveBeenCalledTimes(1);

    // Switching workspace is not a resync (the cache is cleared by the switch itself).
    setWorkspaceId('ws-b');
    connectRealtime('ws-b');
    s.ackJoin(true);
    expect(resync).toHaveBeenCalledTimes(1);
    off();
  });

  it('a permission re-check (session:refresh) re-joins and resyncs', () => {
    const qc = new QueryClient();
    const client = createClientSession(qc);
    const resync = vi.fn();
    const off = onRealtimeResync(resync);
    const s = signIn(client, 'user-a', 'ws-a');
    s.serverEmit('session:refresh', { workspaceId: 'ws-a' });
    s.ackJoin(true);
    expect(resync).toHaveBeenCalledTimes(1);
    off();
  });
});

describe('pickWorkspace (#65)', () => {
  const ws = [{ id: 'own', name: 'Mío', role: 'agent' as const, billing_mode: 'meta_direct' as const, is_active: true }];
  const operator = { id: 'u1', email: 'op@x.com', name: 'Op', is_superadmin: true };
  const tenant = { ...operator, id: 'u3', is_superadmin: false };

  it('keeps a workspace the operator opened from Administración across reloads', () => {
    expect(pickWorkspace(operator, ws, 'tenant-ws', 'u1')).toEqual({ id: 'tenant-ws', foreign: true });
  });

  it('falls back to a membership for everyone else', () => {
    expect(pickWorkspace(tenant, ws, 'tenant-ws', null)).toEqual({ id: 'own', foreign: false });
    expect(pickWorkspace(tenant, ws, 'tenant-ws', 'u1')).toEqual({ id: 'own', foreign: false });
    expect(pickWorkspace(tenant, ws, null, null)).toEqual({ id: 'own', foreign: false });
    expect(pickWorkspace(operator, ws, 'own', null)).toEqual({ id: 'own', foreign: false });
    expect(pickWorkspace(tenant, [], null, null)).toEqual({ id: null, foreign: false });
  });

  it("an operator never inherits a workspace left in the browser by someone else", () => {
    // Stored by the previous user of the tab (their own membership), or opened by another operator.
    expect(pickWorkspace(operator, ws, 'tenant-ws', null)).toEqual({ id: 'own', foreign: false });
    expect(pickWorkspace(operator, ws, 'tenant-ws', 'u2')).toEqual({ id: 'own', foreign: false });
  });

  it('Abrir records the operator as opener only for a workspace they are not a member of', () => {
    expect(workspaceOpener(operator, ws, 'tenant-ws')).toBe('u1');
    expect(workspaceOpener(operator, ws, 'own')).toBeNull();
    expect(workspaceOpener(tenant, ws, 'tenant-ws')).toBeNull();
    expect(workspaceOpener(operator, ws, null)).toBeNull();
  });

  it('superadmin login after a tenant logout on a shared browser lands in their own membership', () => {
    // Tenant owner A works in WA: the session stores it as a membership (no opener).
    setWorkspaceId('WA');
    expect(getWorkspaceOpener()).toBeNull();
    // A signs out; operator B signs in on the same browser.
    expect(pickWorkspace(operator, ws, getWorkspaceId(), getWorkspaceOpener())).toEqual({ id: 'own', foreign: false });
  });

  it('the operator who opened a workspace gets it back after logout and login; the next user clears it', () => {
    setWorkspaceId('tenant-ws', 'u1'); // Administración → Abrir
    expect(pickWorkspace(operator, ws, getWorkspaceId(), getWorkspaceOpener())).toEqual({ id: 'tenant-ws', foreign: true });
    // Someone else signs in (the session stores their pick without an opener)...
    const pick = pickWorkspace(tenant, ws, getWorkspaceId(), getWorkspaceOpener());
    setWorkspaceId(pick.id, null);
    // ...so the operator no longer lands in the tenant workspace on their next login.
    expect(pickWorkspace(operator, ws, getWorkspaceId(), getWorkspaceOpener())).toEqual({ id: 'own', foreign: false });
  });

  it('signing in through the session stores who opened a foreign workspace (and only then)', () => {
    let session!: ReturnType<typeof useSession>;
    function Grab() {
      session = useSession();
      return null;
    }
    renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(SessionProvider, null, createElement(Grab))));

    // Tenant A's session leaves their own workspace in the browser.
    session.setSession({ user: tenant, workspaces: [{ ...ws[0], id: 'WA', role: 'owner' }] });
    expect(getWorkspaceId()).toBe('WA');
    expect(getWorkspaceOpener()).toBeNull();
    // Operator B signs in next on the same browser: their own membership, not A's workspace.
    session.setSession({ user: operator, workspaces: ws });
    expect(getWorkspaceId()).toBe('own');

    // A workspace B opened themselves survives B's next sign-in.
    setWorkspaceId('tenant-ws', 'u1');
    session.setSession({ user: operator, workspaces: ws });
    expect(getWorkspaceId()).toBe('tenant-ws');
    expect(getWorkspaceOpener()).toBe('u1');
  });
});
