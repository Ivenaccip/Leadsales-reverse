import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import type { BotMenu, BotMenuOption, Channel, Estimate, Funnel, Member, Tag, User, WorkspaceSummary } from '../lib/types';

/** Stand-in for a socket.io client socket that also delivers events to onAny, as the real one does. */
class FakeSocket {
  connected = false;
  /** socket.io's `active`: false once the server refused the handshake (it then never retries). */
  active = true;
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
  connect() {
    this.active = true;
    return this;
  }
  disconnect() {
    this.connected = false;
    this.active = false;
    return this;
  }
  // ---- server side ----
  serverConnect() {
    this.connected = true;
    this.active = true;
    for (const fn of this.handlers.get('connect') ?? []) fn();
  }
  /** The network went away: socket.io keeps the socket active and reconnects by itself. */
  serverDrop() {
    this.connected = false;
    for (const fn of this.handlers.get('disconnect') ?? []) fn('transport close');
  }
  serverEmit(event: string, data?: unknown) {
    for (const fn of this.anyHandlers) fn(event, data);
    for (const fn of this.handlers.get(event) ?? []) fn(data);
  }
  ackJoin(ok: boolean) {
    const joins = this.emitted.filter((e) => e.event === 'join');
    joins[joins.length - 1].args[1]({ ok });
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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const {
  connectRealtime,
  disconnectRealtime,
  listenForSessionChanges,
  onRealtimeResync,
  setRealtimeSessionHandlers,
  subscribeRealtime,
  JOIN_RETRY_MS,
  RECONNECT_RELOAD_MAX_MS,
} = await import('../lib/realtime');
const { LOGOUT_FAILED, SESSION_RETRY_MS, SESSION_SIGNAL_KEY, SessionProvider, useSession } = await import('../lib/session');
const { setWorkspaceId } = await import('../lib/api');
const { refreshCredits } = await import('../components/Layout');
const { createOutboundWatch, OUTBOUND_PLACE_MS } = await import('../components/inbox/helpers');
const { addOption, highestOptionKey, markKeys, MenuEditor, newSubmenu, removeOption, ROOT_MENU, submenuPath, withNextKeys } = await import('../pages/Automation');
const { funnelTeamView, FunnelTeamPicker } = await import('../pages/Funnels');
const { afterNoChannel, AudienceFunnelSelect, BroadcastNumberField, broadcastNumberOff, broadcastSaveBody } = await import('../pages/Broadcasts');
const { MemberSelect, StagePills, TagMultiSelect } = await import('../components/pickers');

const WS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ana: User = { id: 'u-ana', email: 'ana@x.com', name: 'Ana', is_superadmin: false };
const beto: User = { id: 'u-beto', email: 'beto@x.com', name: 'Beto', is_superadmin: false };
const summary = (id: string, patch: Partial<WorkspaceSummary> = {}): WorkspaceSummary => ({
  id,
  name: id === WS_A ? 'Tienda A' : 'Tienda B',
  role: 'owner',
  billing_mode: 'meta_direct',
  is_active: true,
  ...patch,
});
const member = (id: string, name: string, is_active = true): Member => ({
  id,
  email: `${id}@x.com`,
  name,
  role: 'agent',
  is_active,
  receives_leads: true,
  last_assigned_at: null,
  created_at: '2026-10-01T00:00:00.000Z',
});

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  disconnectRealtime();
  setRealtimeSessionHandlers({});
  setWorkspaceId(null);
  sockets.length = 0;
});

/** The SessionProvider a test mounted: unmounted even when the test fails before doing it. */
let mountedRoot: { unmount: () => void } | null = null;

afterEach(async () => {
  if (mountedRoot) {
    const root = mountedRoot;
    mountedRoot = null;
    await act(async () => root.unmount());
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Node's setImmediate, which the fake timers below leave alone (the web tsconfig has no Node types).
const nextTick = (globalThis as unknown as { setImmediate: (fn: () => void) => void }).setImmediate;
/** Lets pending promises (fetch, response bodies, effects) run. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => nextTick(r));
};

/** Walks a React element tree (of hook-free components called as functions). */
function findElements(node: ReactNode, match: (props: any) => boolean, out: any[] = []): any[] {
  if (Array.isArray(node)) for (const n of node) findElements(n, match, out);
  else if (isValidElement(node)) {
    const props = node.props as any;
    if (match(props)) out.push(props);
    findElements(props.children, match, out);
  }
  return out;
}

// ------------------------------------------------------------------ #15 / contract 2

describe('a reconnect reloads the session before joining, so rights changed meanwhile reach the tab (#15)', () => {
  it('the first connect does not reload; every reconnect reloads /api/auth/me, then joins', async () => {
    let release!: () => void;
    const refreshed = vi.fn(() => new Promise<void>((r) => (release = r)));
    const resync = vi.fn();
    const off = onRealtimeResync(resync);
    setRealtimeSessionHandlers({ refreshed });
    setWorkspaceId(WS_A);
    connectRealtime(WS_A);
    const s = sockets[0];
    s.serverConnect();
    expect(refreshed).not.toHaveBeenCalled();
    expect(s.joins()).toEqual([WS_A]);
    s.ackJoin(true);

    // Laptop asleep: the socket drops, the owner promotes her meanwhile, socket.io reconnects.
    s.serverDrop();
    s.serverConnect();
    expect(refreshed).toHaveBeenCalledTimes(1);
    // The join waits for the reloaded session (its workspace and role).
    expect(s.joins()).toEqual([WS_A]);
    release();
    await flush();
    expect(s.joins()).toEqual([WS_A, WS_A]);
    s.ackJoin(true);
    expect(resync).toHaveBeenCalledTimes(1);
    off();
  });

  it('a reload that moves the tab (membership lost meanwhile) joins the workspace it moved to', async () => {
    const refreshed = vi.fn(async () => setWorkspaceId(WS_B));
    setRealtimeSessionHandlers({ refreshed });
    setWorkspaceId(WS_A);
    connectRealtime(WS_A);
    const s = sockets[0];
    s.serverConnect();
    s.ackJoin(true);
    s.serverDrop();
    s.serverConnect();
    await flush();
    expect(s.joins()).toEqual([WS_A, WS_B]);
  });

  it('a reload that hangs does not keep the tab out of its room', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setRealtimeSessionHandlers({ refreshed: () => new Promise(() => {}) });
    setWorkspaceId(WS_A);
    connectRealtime(WS_A);
    const s = sockets[0];
    s.serverConnect();
    s.ackJoin(true);
    s.serverDrop();
    s.serverConnect();
    await vi.advanceTimersByTimeAsync(RECONNECT_RELOAD_MAX_MS - 1);
    expect(s.joins()).toEqual([WS_A]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.joins()).toEqual([WS_A, WS_A]);
  });

  it('the suspended screen (no workspace to join) reloads the session when its socket comes back', () => {
    const refreshed = vi.fn();
    setRealtimeSessionHandlers({ refreshed });
    listenForSessionChanges();
    const s = sockets[0];
    s.serverConnect();
    expect(refreshed).not.toHaveBeenCalled();
    // The operator reactivates the workspace while the socket is down: that 'session:refresh' is lost.
    s.serverDrop();
    s.serverConnect();
    expect(refreshed).toHaveBeenCalledTimes(1);
    expect(s.joins()).toEqual([]);
  });

  it('a socket whose first attempt failed reloads on the connect that follows', () => {
    const refreshed = vi.fn();
    setRealtimeSessionHandlers({ refreshed });
    setWorkspaceId(WS_A);
    connectRealtime(WS_A);
    const s = sockets[0];
    // A transport error socket.io retries by itself (still active).
    for (const fn of s.handlers.get('connect_error') ?? []) fn(new Error('xhr poll error'));
    s.serverConnect();
    expect(refreshed).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------------------ #17

describe("a workspace switch never shows the previous workspace's events (#17)", () => {
  it('events are dropped from the switch until the new join is confirmed, even through a refused join', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const seen: string[] = [];
    const unsub = subscribeRealtime<{ name: string }>('contact:update', (c) => seen.push(c.name));
    setWorkspaceId(WS_A);
    connectRealtime(WS_A);
    const s = sockets[0];
    s.serverConnect();
    s.ackJoin(true);
    s.serverEmit('contact:update', { name: 'Cliente de A' });

    // Switch to B (what switchWorkspace + Layout do).
    setWorkspaceId(WS_B);
    connectRealtime(WS_B);
    expect(s.joins()).toEqual([WS_A, WS_B]);
    // Still in A's rooms until the server answers.
    s.serverEmit('contact:update', { name: 'Cliente de A en vuelo' });
    // The join's query failed (database restart): the server answers false and may keep A's rooms.
    s.ackJoin(false);
    s.serverEmit('contact:update', { name: 'Cliente de A tras el rechazo' });
    await vi.advanceTimersByTimeAsync(JOIN_RETRY_MS[0]);
    expect(s.joins()).toEqual([WS_A, WS_B, WS_B]);
    s.ackJoin(true);
    s.serverEmit('contact:update', { name: 'Cliente de B', workspace_id: WS_B });
    // An event that says it belongs to another workspace is dropped too.
    s.serverEmit('contact:update', { name: 'Cliente de A rezagado', workspace_id: WS_A });
    expect(seen).toEqual(['Cliente de A', 'Cliente de B']);
    unsub();
  });

  it('a socket that is re-joining after session:refresh drops events until the join is back', () => {
    const seen: string[] = [];
    const unsub = subscribeRealtime<{ name: string }>('message:new', (m) => seen.push(m.name));
    setWorkspaceId(WS_A);
    connectRealtime(WS_A);
    const s = sockets[0];
    s.serverConnect();
    s.ackJoin(true);
    s.serverEmit('session:refresh', { workspaceId: WS_A });
    s.serverEmit('message:new', { name: 'durante la re-unión' });
    s.ackJoin(true);
    s.serverEmit('message:new', { name: 'después' });
    expect(seen).toEqual(['después']);
    unsub();
  });
});

// ------------------------------------------------------------------ SessionProvider (#16, #22, #41)

/** Mounts the real SessionProvider with just enough DOM for react-dom/client (no markup is rendered). */
async function mountSession(qc = new QueryClient()) {
  const doc = { nodeType: 9, addEventListener() {}, removeEventListener() {}, activeElement: null, body: null, defaultView: globalThis };
  const container = {
    nodeType: 1,
    ownerDocument: doc,
    addEventListener() {},
    removeEventListener() {},
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    tagName: 'DIV',
    nodeName: 'DIV',
  };
  // The window's 'storage' events (other tabs) go through this bus.
  const bus = new EventTarget();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('addEventListener', bus.addEventListener.bind(bus));
  vi.stubGlobal('removeEventListener', bus.removeEventListener.bind(bus));
  vi.stubGlobal('document', doc);
  vi.stubGlobal('HTMLIFrameElement', class {});
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const { createRoot } = await import('react-dom/client');
  const ref: { session: ReturnType<typeof useSession> | null } = { session: null };
  function Grab() {
    ref.session = useSession();
    return null;
  }
  const root = createRoot(container as unknown as Element);
  mountedRoot = root;
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: qc }, createElement(SessionProvider, null, createElement(Grab))));
  });
  const settle = () =>
    act(async () => {
      await flush();
    });
  await settle();
  return {
    get session() {
      return ref.session!;
    },
    settle,
    /** Another tab of the browser wrote `key` (the 'storage' event fires only in the other tabs). */
    otherTabWrote: (key: string) =>
      act(async () => {
        bus.dispatchEvent(Object.assign(new Event('storage'), { key }));
        await flush();
      }),
    unmount: async () => {
      mountedRoot = null;
      await act(async () => root.unmount());
    },
  };
}

describe('a session load the server could not answer is not a sign-out (#41)', () => {
  it('502, 500 and a network error keep the tab loading and retry; the valid cookie then signs it in', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const answers: (() => Response | Promise<Response>)[] = [
      () => new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
      () => jsonResponse({ error: { code: 'INTERNAL', message: 'Error interno' } }, 500),
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => jsonResponse({ user: ana, workspaces: [summary(WS_A)] }),
    ];
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url !== '/api/auth/me') return jsonResponse({});
        return answers[Math.min(calls++, answers.length - 1)]();
      }),
    );
    const m = await mountSession();
    expect(calls).toBe(1);
    // Not sent to /login: RequireAuth keeps waiting, showing the reconnecting state.
    expect(m.session.loading).toBe(true);
    expect(m.session.reconnecting).toBe(true);
    expect(m.session.user).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_RETRY_MS[0]);
      await flush();
    });
    expect(calls).toBe(2);
    expect(m.session.loading).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_RETRY_MS[1]);
      await flush();
    });
    expect(calls).toBe(3);
    expect(m.session.loading).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_RETRY_MS[2]);
      await flush();
    });
    expect(calls).toBe(4);
    expect(m.session.loading).toBe(false);
    expect(m.session.reconnecting).toBe(false);
    expect(m.session.user?.id).toBe('u-ana');
    // Signed in: no more retries.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(calls).toBe(4);
    await m.unmount();
  });

  it('of two loads started before the session is known, the newer one settles it (StrictMode, another tab)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending: ((r: Response) => void)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((r) => pending.push(r))),
    );
    const m = await mountSession();
    await m.otherTabWrote(SESSION_SIGNAL_KEY); // a second load while the first is on its way
    expect(pending).toHaveLength(2);
    await act(async () => {
      pending[0](jsonResponse({ error: { code: 'INTERNAL', message: 'Error interno' } }, 500));
      await flush();
    });
    // The older one failing schedules nothing and shows no reconnecting state: the newer one decides.
    expect(m.session.reconnecting).toBe(false);
    expect(m.session.loading).toBe(true);
    await act(async () => {
      pending[1](jsonResponse({ user: ana, workspaces: [summary(WS_A)] }));
      await flush();
    });
    expect(m.session.user?.id).toBe('u-ana');
    expect(m.session.loading).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(pending).toHaveLength(2);
    await m.unmount();
  });

  it('a 401 still means signed out, at once', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'Inicia sesión' } }, 401)));
    const m = await mountSession();
    expect(m.session.loading).toBe(false);
    expect(m.session.reconnecting).toBe(false);
    expect(m.session.user).toBeNull();
    await m.unmount();
  });

  it('a passing failure of the reload after accepting an invitation keeps the user signed in', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let me: () => Response | Promise<Response> = () => jsonResponse({ user: ana, workspaces: [summary(WS_A)] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => me()),
    );
    const m = await mountSession();
    expect(m.session.user?.id).toBe('u-ana');
    me = () => jsonResponse({ error: { code: 'INTERNAL', message: 'Error interno' } }, 500);
    await act(async () => {
      await m.session.refresh();
    });
    expect(m.session.user?.id).toBe('u-ana');
    me = () => jsonResponse({ user: ana, workspaces: [summary(WS_A), summary(WS_B)] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_RETRY_MS[0]);
      await flush();
    });
    expect(m.session.workspaces.map((w) => w.id)).toEqual([WS_A, WS_B]);
    await m.unmount();
  });
});

describe('a logout the server did not confirm keeps the session and says so (#22)', () => {
  it('a network error or a 5xx rejects with the message; 200 and 401 sign the tab out', async () => {
    let logout: () => Response | Promise<Response> = () => Promise.reject(new TypeError('Failed to fetch'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url === '/api/auth/logout' ? logout() : jsonResponse({ user: ana, workspaces: [summary(WS_A)] }))),
    );
    const m = await mountSession();
    expect(m.session.user?.id).toBe('u-ana');

    let err: unknown;
    await act(async () => {
      await m.session.logout().catch((e) => (err = e));
    });
    expect((err as Error)?.message).toBe(LOGOUT_FAILED);
    expect(m.session.user?.id).toBe('u-ana');

    logout = () => new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });
    err = undefined;
    await act(async () => {
      await m.session.logout().catch((e) => (err = e));
    });
    expect((err as Error)?.message).toBe(LOGOUT_FAILED);
    expect(m.session.user?.id).toBe('u-ana');
    // Nothing told the other tabs either.
    expect(localStorage.getItem(SESSION_SIGNAL_KEY)).toBeNull();

    logout = () => jsonResponse({ ok: true });
    await act(async () => {
      await m.session.logout();
    });
    expect(m.session.user).toBeNull();
    expect(localStorage.getItem(SESSION_SIGNAL_KEY)).toMatch(/^:/);
    await m.unmount();
  });

  it('a session that had already ended (401) signs out without an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/auth/logout'
          ? jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'Inicia sesión' } }, 401)
          : jsonResponse({ user: ana, workspaces: [summary(WS_A)] }),
      ),
    );
    const m = await mountSession();
    await act(async () => {
      await m.session.logout();
    });
    expect(m.session.user).toBeNull();
    await m.unmount();
  });
});

describe('signing in or out in another tab reloads this one (#16)', () => {
  it("another account's login in a second tab moves this tab to that user, with fresh caches", async () => {
    let me = { user: ana, workspaces: [summary(WS_A)] };
    const fetchSpy = vi.fn(async (url: string) => (url === '/api/auth/me' ? jsonResponse(me) : jsonResponse({})));
    vi.stubGlobal('fetch', fetchSpy);
    const qc = new QueryClient();
    const m = await mountSession(qc);
    expect(m.session.user?.id).toBe('u-ana');
    qc.setQueryData(['conversations', {}], { pages: [{ items: [{ id: 'lead-de-ana' }] }] });

    // Unrelated keys change nothing.
    const before = fetchSpy.mock.calls.length;
    await m.otherTabWrote('leadlibre.workspace');
    expect(fetchSpy.mock.calls.length).toBe(before);

    // Tab 2 signs Beto in: the shared cookie is now his.
    me = { user: beto, workspaces: [summary(WS_A, { role: 'agent' })] };
    await m.otherTabWrote(SESSION_SIGNAL_KEY);
    expect(m.session.user?.id).toBe('u-beto');
    expect(m.session.role).toBe('agent');
    expect(qc.getQueryData(['conversations', {}])).toBeUndefined();
    await m.unmount();
  });

  it("another tab's logout signs this one out", async () => {
    let signedIn = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        signedIn ? jsonResponse({ user: ana, workspaces: [summary(WS_A)] }) : jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'Inicia sesión' } }, 401),
      ),
    );
    const m = await mountSession();
    expect(m.session.user?.id).toBe('u-ana');
    signedIn = false;
    await m.otherTabWrote(SESSION_SIGNAL_KEY);
    expect(m.session.user).toBeNull();
    await m.unmount();
  });

  it('a sign-in in this tab tells the others', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'Inicia sesión' } }, 401)));
    const m = await mountSession();
    expect(localStorage.getItem(SESSION_SIGNAL_KEY)).toBeNull();
    await act(async () => m.session.setSession({ user: beto, workspaces: [summary(WS_A)] }));
    expect(localStorage.getItem(SESSION_SIGNAL_KEY)).toMatch(/^u-beto:/);
    await m.unmount();
  });
});

// ------------------------------------------------------------------ #26

describe('a top-up refreshes the broadcast estimate, not only the sidebar balance (#26)', () => {
  /** A wizard's estimate and the sidebar's balance, as the server computes them. */
  function setup(billing_mode: 'prepaid' | 'meta_direct', start = 1) {
    const server = { balance: start, billing_mode, estimateFetches: 0, creditsFails: false };
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: false } } });
    const estimate = new QueryObserver<Estimate>(qc, {
      queryKey: ['broadcast-estimate', '{"template_name":"promo"}'],
      queryFn: async () => {
        server.estimateFetches++;
        const { balance } = server;
        return { recipients: 10, category: 'MARKETING', cost: 5, by_market: [], billing_mode: server.billing_mode, balance, sufficient: server.billing_mode !== 'prepaid' || balance >= 5 };
      },
    });
    const credits = new QueryObserver(qc, {
      queryKey: ['credits'],
      queryFn: async () => {
        if (server.creditsFails) throw new Error('Failed to fetch');
        return { billing_mode: server.billing_mode, balance: server.balance };
      },
    });
    const offs = [estimate.subscribe(() => {}), credits.subscribe(() => {})];
    return { server, qc, estimate, credits, stop: () => offs.forEach((off) => off()) };
  }

  it("credits:update gives the cached estimate the new balance, so 'Enviar' is enabled again", async () => {
    const t = setup('prepaid');
    await vi.waitFor(() => expect(t.estimate.getCurrentResult().data?.sufficient).toBe(false));
    await vi.waitFor(() => expect(t.credits.getCurrentResult().data).toBeDefined());

    t.server.balance = 100; // the operator topped up
    await refreshCredits(t.qc); // Layout's 'credits:update' handler
    expect(t.estimate.getCurrentResult().data).toMatchObject({ balance: 100, sufficient: true, cost: 5 });
    expect(t.credits.getCurrentResult().data).toEqual({ billing_mode: 'prepaid', balance: 100 });
    // Patched from the balance: the audience is not scanned again.
    expect(t.server.estimateFetches).toBe(1);

    // A charge brings it under the cost again.
    t.server.balance = 3;
    await refreshCredits(t.qc);
    expect(t.estimate.getCurrentResult().data).toMatchObject({ balance: 3, sufficient: false });
    expect(t.server.estimateFetches).toBe(1);
    t.stop();
  });

  it('charges during a broadcast do not recompute the estimate of a workspace that pays Meta directly', async () => {
    const t = setup('meta_direct');
    await vi.waitFor(() => expect(t.estimate.getCurrentResult().data?.sufficient).toBe(true));
    await vi.waitFor(() => expect(t.credits.getCurrentResult().data).toBeDefined());
    for (let i = 0; i < 5; i++) await refreshCredits(t.qc); // one credits:update every 2 s
    expect(t.server.estimateFetches).toBe(1);
    expect(t.estimate.getCurrentResult().data?.sufficient).toBe(true);
    t.stop();
  });

  it('a balance that could not be reloaded, or a changed billing mode, asks the server for the estimate', async () => {
    const t = setup('prepaid');
    await vi.waitFor(() => expect(t.estimate.getCurrentResult().data).toBeDefined());
    await vi.waitFor(() => expect(t.credits.getCurrentResult().data).toBeDefined());
    t.server.creditsFails = true;
    t.server.balance = 100;
    await refreshCredits(t.qc);
    await vi.waitFor(() => expect(t.estimate.getCurrentResult().data?.sufficient).toBe(true));
    expect(t.server.estimateFetches).toBe(2);

    t.server.creditsFails = false;
    t.server.billing_mode = 'meta_direct';
    await refreshCredits(t.qc);
    await vi.waitFor(() => expect(t.estimate.getCurrentResult().data?.billing_mode).toBe('meta_direct'));
    expect(t.server.estimateFetches).toBe(3);
    t.stop();
  });
});

// ------------------------------------------------------------------ #37

describe("the funnel team shows members who no longer take part, and they can be removed (#37)", () => {
  const owner = member('u-owner', 'Dueño');
  const anaInactive = member('u-ana', 'Ana', false);

  it('a team of only deactivated or removed members is not shown as "nobody chosen"', () => {
    const view = funnelTeamView(['u-ana', 'u-gone'], [owner, anaInactive], true);
    expect(view.chips).toEqual([{ member: owner, on: false }]);
    expect(view.stale).toEqual([
      { id: 'u-ana', label: 'Ana (inactivo)' },
      { id: 'u-gone', label: 'Miembro eliminado' },
    ]);
    expect(view.noneActive).toBe(true);
    // Members still loading: nothing is marked as removed.
    expect(funnelTeamView(['u-ana'], [], false).stale).toEqual([]);
    // An active member in the team: the inactive ones are only flagged.
    expect(funnelTeamView(['u-owner', 'u-ana'], [owner, anaInactive], true).noneActive).toBe(false);
  });

  it('the picker lists them, and removing them can empty the team (back to "everyone")', () => {
    const props = { team: ['u-ana', 'u-gone'], members: [owner, anaInactive], membersLoaded: true, onChange: vi.fn() };
    const html = renderToStaticMarkup(createElement(FunnelTeamPicker, props));
    expect(html).toContain('Ana (inactivo)');
    expect(html).toContain('Miembro eliminado');
    expect(html).toContain('Nadie del equipo elegido sigue activo');
    const remove = findElements(FunnelTeamPicker(props), (p) => p.title === 'Quitar del equipo');
    expect(remove).toHaveLength(2);
    remove[0].onClick();
    expect(props.onChange).toHaveBeenLastCalledWith(['u-gone']);
    const after = { ...props, team: ['u-gone'] };
    findElements(FunnelTeamPicker(after), (p) => p.title === 'Quitar del equipo')[0].onClick();
    expect(props.onChange).toHaveBeenLastCalledWith([]);
  });
});

// ------------------------------------------------------------------ #39

describe('removing a bot option keeps the keys of the others (#39)', () => {
  const menu: BotMenuOption[] = [
    { key: '1', label: 'Promociones', handoff: false },
    { key: '2', label: 'Soporte', stage_id: 'st-contactado' },
    { key: '3', label: 'Quiero comprar', stage_id: 'st-cotizacion', handoff: true },
  ];
  /** What the server does with a typed answer: the option with that key in the menu as it is now. */
  const typed = (options: BotMenuOption[], input: string) => options.find((o) => o.key === input.trim())?.label;

  it('a customer who types the number they were sent still gets that option', () => {
    const edited = removeOption(menu, 0);
    expect(edited.map((o) => o.key)).toEqual(['2', '3']);
    expect(typed(edited, '2')).toBe('Soporte');
    expect(typed(edited, '3')).toBe('Quiero comprar');
    // The removed key matches nothing (the bot answers with the menu again), never another option.
    expect(typed(edited, '1')).toBeUndefined();
  });

  it('a new option takes a key no option has or had in this editing session', () => {
    expect(addOption(removeOption(menu, 0)).map((o) => o.key)).toEqual(['2', '3', '4']);
    // The highest one was removed: its key is not handed out again while it is still remembered.
    const withoutLast = removeOption(menu, 2);
    expect(addOption(withoutLast, highestOptionKey(menu)).map((o) => o.key)).toEqual(['1', '2', '4']);
    expect(addOption([]).map((o) => o.key)).toEqual(['1']);
    expect(highestOptionKey([{ key: 'a' }, { key: '7' }])).toBe(7);
  });
});

describe('a key removed in the editor stays retired however the editor is shown again (#39)', () => {
  const soporte = (): BotMenu => ({
    prompt: '¿Qué necesitas?',
    options: [
      { key: '1', label: 'Factura' },
      { key: '2', label: 'Reclamo' },
      { key: '3', label: 'Garantía' },
    ],
  });
  /** The page's draft and its onChange for the root editor (it remembers the tree before each edit). */
  function page(menu: BotMenu) {
    const marks = new Map<string, number>();
    const draft = { menu };
    const onChange = (m: BotMenu) => {
      markKeys(marks, draft.menu);
      draft.menu = m;
    };
    return { marks, draft, onChange };
  }
  /** An editor as freshly mounted (an option expanded again, the 'menu' mode picked again). */
  const editor = (p: ReturnType<typeof page>, menu: BotMenu, path: string, onChange: (m: BotMenu) => void) =>
    MenuEditor({ menu, depth: path === ROOT_MENU ? 1 : 2, path, marks: p.marks, onChange });
  const click = (tree: ReactNode, label: string) => findElements(tree, (props) => props.children === label)[0].onClick();
  const removeLabel = (tree: ReactNode, label: string) => findElements(tree, (props) => props.option?.label === label)[0].onRemove();

  it("a submenu collapsed and expanded again does not give a removed key to a new option", () => {
    const p = page({ prompt: 'Hola', options: [{ key: '1', label: 'Promociones' }, { key: '2', label: 'Soporte', submenu: soporte() }] });
    const path = submenuPath(ROOT_MENU, '2');
    const sub = () =>
      editor(p, p.draft.menu.options[1].submenu!, path, (m) =>
        p.onChange({ ...p.draft.menu, options: p.draft.menu.options.map((o) => (o.key === '2' ? { ...o, submenu: m } : o)) }),
      );
    removeLabel(sub(), 'Garantía');
    // 'Soporte' collapsed and expanded: its submenu's editor is a new one.
    click(sub(), 'Agregar opción');
    expect(p.draft.menu.options[1].submenu!.options.map((o) => o.key)).toEqual(['1', '2', '4']);
  });

  it("switching the mode away from 'menu' and back does not give a removed key to a new option", () => {
    const p = page({ prompt: 'Hola', options: [{ key: '1', label: 'Promociones' }, { key: '2', label: 'Soporte' }, { key: '3', label: 'Quiero comprar' }] });
    removeLabel(editor(p, p.draft.menu, ROOT_MENU, p.onChange), 'Quiero comprar');
    click(editor(p, p.draft.menu, ROOT_MENU, p.onChange), 'Agregar opción');
    expect(p.draft.menu.options.map((o) => o.key)).toEqual(['1', '2', '4']);
  });

  it('a submenu removed and added again goes on from the keys the old one had', () => {
    const p = page({ prompt: 'Hola', options: [{ key: '2', label: 'Soporte', submenu: soporte() }] });
    p.onChange({ ...p.draft.menu, options: [{ ...p.draft.menu.options[0], submenu: null }] }); // 'Quitar submenú'
    expect(newSubmenu(p.marks, submenuPath(ROOT_MENU, '2')).options.map((o) => o.key)).toEqual(['4']);
    // A submenu never seen before starts at 1.
    expect(newSubmenu(p.marks, submenuPath(ROOT_MENU, '9')).options.map((o) => o.key)).toEqual(['1']);
  });

  it('the saved menu carries the next key of every menu, and an editor opened from it goes on from there', () => {
    const p = page({ prompt: 'Hola', options: [{ key: '1', label: 'Promociones' }, { key: '2', label: 'Soporte', submenu: soporte() }] });
    p.onChange({ ...p.draft.menu, options: [{ ...p.draft.menu.options[1], submenu: { ...soporte(), options: soporte().options.slice(0, 2) } }] });
    const saved = withNextKeys(p.draft.menu, p.marks);
    expect(saved.next_key).toBe(3);
    expect(saved.options[0].submenu!.next_key).toBe(4);
    // After a reload (nothing remembered by the page), the saved next keys still apply.
    const reloaded = page(saved);
    click(editor(reloaded, reloaded.draft.menu, ROOT_MENU, reloaded.onChange), 'Agregar opción');
    expect(reloaded.draft.menu.options.map((o) => o.key)).toEqual(['2', '3']);
    const path = submenuPath(ROOT_MENU, '2');
    const sub = reloaded.draft.menu.options[0].submenu!;
    click(
      editor(reloaded, sub, path, (m) => reloaded.onChange({ ...reloaded.draft.menu, options: reloaded.draft.menu.options.map((o) => (o.key === '2' ? { ...o, submenu: m } : o)) })),
      'Agregar opción',
    );
    expect(reloaded.draft.menu.options[0].submenu!.options.map((o) => o.key)).toEqual(['1', '2', '4']);
  });
});

// ------------------------------------------------------------------ #24

describe('a paused broadcast whose number was disabled can be moved to another number (#24)', () => {
  const channel = (id: string, extra: Partial<Channel> = {}) =>
    ({ id, name: `Línea ${id}`, display_phone: `+52 55 0000 ${id.slice(-1)}`, status: 'active', is_default: false, ...extra }) as Channel;
  const list = [channel('ch-a', { status: 'disabled' }), channel('ch-b', { is_default: true })];
  const paused = { status: 'paused' as const, channel_id: 'ch-a' };

  it("its own number being disabled is told apart from a deleted one or a working one", () => {
    expect(broadcastNumberOff(paused, list)).toBe(true);
    expect(broadcastNumberOff(paused, [channel('ch-a'), channel('ch-b')])).toBe(false);
    expect(broadcastNumberOff({ channel_id: null }, list)).toBe(false);
    expect(broadcastNumberOff(paused, undefined)).toBe(false);
    expect(broadcastNumberOff(undefined, list)).toBe(false);
  });

  it("'Número que envía' is unlocked for it, and saving names the number chosen", () => {
    const render = (numberOff: boolean) =>
      renderToStaticMarkup(createElement(BroadcastNumberField, { channels: list, value: 'ch-a', onChange: () => {}, paused: true, numberGone: false, numberOff }));
    expect(render(false)).toMatch(/<select[^>]*disabled=""/);
    const html = render(true);
    expect(html).not.toMatch(/<select[^>]*disabled=""/);
    expect(html).toContain('está deshabilitado: elige otro');
    const fields = {
      name: 'Promo',
      channelId: 'ch-b',
      template: { name: 'promo_octubre', language: 'es_MX' },
      params: {},
      audience: {},
      scheduledAt: null,
    };
    // The wizard passes `numberGone || numberOff`.
    expect(broadcastSaveBody('paused', fields, broadcastNumberOff(paused, list))).toEqual({
      name: 'Promo',
      template_name: 'promo_octubre',
      template_language: 'es_MX',
      params: {},
      channel_id: 'ch-b',
    });
  });

  it('a NO_CHANNEL on its disabled number proposes the default number that can send', () => {
    expect(afterNoChannel(paused, paused, 'ch-a', list)).toEqual({ reload: false, resetNumber: true });
    // A number that can send keeps the choice (the server refused for another reason).
    expect(afterNoChannel(paused, paused, 'ch-b', list)).toEqual({ reload: false, resetNumber: false });
  });
});

// ------------------------------------------------------------------ #40

describe('audience filters that point to deleted or inactive things are shown and removable (#40)', () => {
  const vip: Tag = { id: 't-vip', name: 'VIP', color: '#16a34a' };

  it('a deleted tag shows as a removable chip instead of "Cualquier etiqueta"', () => {
    const html = renderToStaticMarkup(
      createElement(TagMultiSelect, { tags: [vip], value: ['t-deleted'], onChange: () => {}, placeholder: 'Cualquier etiqueta', showMissing: true }),
    );
    expect(html).toContain('Etiqueta eliminada');
    expect(html).toContain('aria-label="Quitar Etiqueta eliminada"');
    expect(html).not.toContain('Cualquier etiqueta');
    // Tags still loading: nothing is called deleted.
    const loading = renderToStaticMarkup(createElement(TagMultiSelect, { tags: [], value: ['t-vip'], onChange: () => {}, placeholder: 'Cualquier etiqueta' }));
    expect(loading).not.toContain('Etiqueta eliminada');
  });

  it('a deactivated or removed member stays the selected option, named as such', () => {
    const members = [member('u-ana', 'Ana'), member('u-beto', 'Beto', false)];
    const html = (value: string | null, list = members) =>
      renderToStaticMarkup(createElement(MemberSelect, { members: list, value, onChange: () => {}, emptyLabel: 'Cualquier asesor' }));
    expect(html('u-beto')).toContain('<option value="u-beto" selected="">Beto (inactivo)</option>');
    expect(html('u-gone')).toContain('<option value="u-gone" selected="">Asesor eliminado</option>');
    // Inactive members are still not offered otherwise.
    expect(html(null)).not.toContain('Beto');
    expect(html('u-ana')).toContain('<option value="u-ana" selected="">Ana</option>');
    // The list is not loaded yet: no "Asesor eliminado".
    expect(html('u-ana', [])).not.toContain('eliminado');
  });

  it('a deleted funnel or stage is listed as such', () => {
    const funnel: Funnel = {
      id: 'f-ventas',
      name: 'Ventas',
      position: 0,
      auto_assign: false,
      assignee_ids: [],
      is_default: true,
      stages: [{ id: 's-nuevo', funnel_id: 'f-ventas', name: 'Nuevo', color: '#0ea5e9', position: 0, kind: 'open' }],
    };
    const select = (value: string | null, loaded = true) =>
      renderToStaticMarkup(createElement(AudienceFunnelSelect, { funnels: [funnel], loaded, value, onChange: () => {} }));
    expect(select('f-borrado')).toContain('<option value="f-borrado" selected="">Embudo eliminado</option>');
    expect(select('f-ventas')).not.toContain('Embudo eliminado');
    expect(select('f-borrado', false)).not.toContain('Embudo eliminado');
    const pills = renderToStaticMarkup(createElement(StagePills, { funnel, value: ['s-borrada', 's-nuevo'], onChange: () => {} }));
    expect(pills).toContain('Etapa eliminada');
    expect(pills).toContain('Nuevo');
  });
});

// ------------------------------------------------------------------ contract 1 (safety net)

describe("an outbound message of a conversation the tab does not have is placed even without its contact:update", () => {
  it('the lists are refetched once when no contact:update came in time, not when it did', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const missed = vi.fn();
    const watch = createOutboundWatch(missed);
    watch.sent('c1');
    watch.placed('c1'); // the server's contact:update arrived
    vi.advanceTimersByTime(OUTBOUND_PLACE_MS);
    expect(missed).not.toHaveBeenCalled();
    watch.sent('c2');
    watch.sent('c3');
    vi.advanceTimersByTime(OUTBOUND_PLACE_MS);
    expect(missed).toHaveBeenCalledTimes(1);
    watch.sent('c4');
    watch.stop();
    vi.advanceTimersByTime(OUTBOUND_PLACE_MS);
    expect(missed).toHaveBeenCalledTimes(1);
  });

  it("a restricted agent's contact:update that comes before the message:new counts as placed", () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const missed = vi.fn();
    const watch = createOutboundWatch(missed);
    // A broadcast to unassigned contacts while the agent is on 'Mías': no cached list holds them, and
    // the server sends the contact:update first (the message:new waits for an assignee lookup).
    for (let i = 0; i < 30; i++) {
      watch.placed(`c${i}`);
      watch.sent(`c${i}`);
      vi.advanceTimersByTime(200);
    }
    vi.advanceTimersByTime(OUTBOUND_PLACE_MS);
    expect(missed).not.toHaveBeenCalled();
    // A contact:update from long before does not cover a later send.
    watch.placed('old');
    vi.advanceTimersByTime(OUTBOUND_PLACE_MS);
    watch.sent('old');
    vi.advanceTimersByTime(OUTBOUND_PLACE_MS);
    expect(missed).toHaveBeenCalledTimes(1);
    watch.stop();
  });
});
