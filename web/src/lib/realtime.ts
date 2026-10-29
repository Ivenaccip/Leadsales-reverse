import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { getWorkspaceId } from './api';

type Listener = (data: any) => void;

let socket: Socket | null = null;
/** Workspace room the current connection is in. */
let joined: string | null = null;
/** Last workspace joined by this socket, kept across reconnects to tell a re-join from a switch. */
let lastJoined: string | null = null;
/** Pending retry of a refused join. */
let joinRetry: ReturnType<typeof setTimeout> | null = null;
/**
 * Waits before retrying a refused join. A refusal that outlasts them reloads the session (the
 * workspace may be gone), and while the tab stays on that workspace the join is still retried,
 * backing off up to JOIN_RETRY_MAX_MS: a database outage can refuse joins for minutes.
 */
export const JOIN_RETRY_MS = [500, 1000, 2000];
export const JOIN_RETRY_MAX_MS = 30_000;
/** Pending reopening of a socket whose handshake the server refused, and how many came before it. */
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
/** Upper bounds of the (randomized) waits before reopening a socket whose handshake was refused. */
export const RECONNECT_MS = [1000, 2000, 5000, 10_000, 30_000];

// Handlers live here, not on the socket, so they survive a socket being replaced (logout, new user).
const listeners = new Map<string, Set<Listener>>();
const resyncListeners = new Set<() => void>();
type SessionHandlers = {
  revoked?: () => void;
  /** The handshake was refused as 'unauthorized': check the session (its 401 signs the tab out). */
  unauthorized?: () => Promise<unknown> | void;
  /** Rights changed (or a join was refused): the tab's session (role, memberships) must be reloaded. */
  refreshed?: () => void;
};
let sessionHandlers: SessionHandlers = {};

function dispatch(event: string, data: unknown) {
  for (const fn of [...(listeners.get(event) ?? [])]) fn(data);
}

function ensureSocket(): Socket {
  if (socket) return socket;
  const s = io({ path: '/socket.io', withCredentials: true, transports: ['websocket', 'polling'] });
  socket = s;
  // A replaced socket (previous user) must never reach the handlers, even with buffered packets.
  s.onAny((event: string, data: unknown) => {
    if (socket === s) dispatch(event, data);
  });
  s.on('connect', () => {
    if (socket !== s) return;
    clearReconnect();
    reconnectAttempt = 0;
    joined = null;
    joinCurrent();
  });
  // The server re-checks permissions (member removed, role or visibility changed, workspace
  // suspended, operator demoted): the socket re-joins and the session reloads the user's rights.
  s.on('session:refresh', () => {
    if (socket !== s) return;
    joined = null;
    joinCurrent();
    sessionHandlers.refreshed?.();
  });
  // Logout, password change or deactivation ended this session: nothing here may keep streaming.
  s.on('session:revoked', () => {
    if (socket !== s) return;
    disconnectRealtime();
    sessionHandlers.revoked?.();
  });
  // socket.io retries a lost connection by itself, but never a handshake the server refused (the
  // socket is no longer active): that is done here, or the tab would stay without events until a
  // reload. 'unauthorized' (no valid session) is checked first: its 401 signs the tab out, which
  // drops this socket. 'unavailable' (the server could not check, e.g. its database is restarting)
  // and a session the check still finds valid are simply retried.
  s.on('connect_error', (err: Error) => {
    if (socket !== s || s.active) return;
    if (err?.message !== 'unauthorized') return scheduleReconnect(s);
    void Promise.resolve(sessionHandlers.unauthorized?.())
      .catch(() => {})
      .then(() => scheduleReconnect(s));
  });
  return s;
}

function clearReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect(s: Socket) {
  if (socket !== s || s.connected) return;
  clearReconnect();
  const max = RECONNECT_MS[Math.min(reconnectAttempt++, RECONNECT_MS.length - 1)];
  // Randomized, so the tabs a server restart refused together do not come back all at once.
  reconnectTimer = setTimeout(
    () => {
      reconnectTimer = null;
      if (socket === s && !s.connected) s.connect();
    },
    max * (0.5 + Math.random() / 2),
  );
}

function clearJoinRetry() {
  if (joinRetry) clearTimeout(joinRetry);
  joinRetry = null;
}

function joinCurrent(attempt = 0) {
  clearJoinRetry();
  const s = socket;
  const ws = getWorkspaceId();
  if (!s?.connected || !ws || joined === ws) return;
  s.emit('join', ws, (r: { ok: boolean }) => {
    if (socket !== s) return;
    if (!r?.ok) {
      // A refused join can leave the socket outside every room, even one it was in before.
      joined = null;
      // A refusal can be passing (a permission re-check or a database hiccup on the server), so it
      // is retried. If it persists, the workspace may be no longer reachable (membership removed,
      // suspended): the reloaded session then moves the tab, whose new room is joined right away.
      // Otherwise (the database is still down, or back) the retries go on until the join succeeds.
      const quick = JOIN_RETRY_MS[attempt];
      if (quick === undefined) sessionHandlers.refreshed?.();
      const wait = quick ?? Math.min(JOIN_RETRY_MAX_MS, 5000 * 2 ** (attempt - JOIN_RETRY_MS.length));
      clearJoinRetry();
      joinRetry = setTimeout(() => {
        joinRetry = null;
        if (socket === s) joinCurrent(getWorkspaceId() === ws ? attempt + 1 : 0);
      }, wait);
      return;
    }
    joined = ws;
    // A re-join, or a join that came late: events emitted meanwhile are lost, so the pages refetch.
    const resync = lastJoined === ws || attempt > 0;
    lastJoined = ws;
    if (resync) for (const fn of [...resyncListeners]) fn();
    // The tab moved to another workspace while this join was on its way.
    if (getWorkspaceId() !== ws) joinCurrent();
  });
}

/** Connects (once) and joins the current workspace room. */
export function connectRealtime(workspaceId: string | null) {
  if (!workspaceId) return;
  ensureSocket();
  joinCurrent();
}

/**
 * Connects without a workspace to join (a member whose only one is suspended): the socket still
 * hears its user's room, so the 'session:refresh' sent when it is reactivated lets them back in.
 */
export function listenForSessionChanges() {
  ensureSocket();
}

/**
 * Drops the connection. The server authenticates a socket only at its handshake, so this must run
 * whenever the signed-in user changes: the next connectRealtime() opens one with the new cookie.
 */
export function disconnectRealtime() {
  const s = socket;
  clearJoinRetry();
  clearReconnect();
  reconnectAttempt = 0;
  socket = null;
  joined = null;
  lastJoined = null;
  s?.disconnect();
}

/** Called when the server ends this session ('session:revoked'), refuses the handshake, or changes the user's rights. */
export function setRealtimeSessionHandlers(h: SessionHandlers) {
  sessionHandlers = h;
}

/** Subscribes to a realtime event on the current and any later socket; returns the unsubscribe. */
export function subscribeRealtime<T = any>(event: string, fn: (data: T) => void): () => void {
  let set = listeners.get(event);
  if (!set) listeners.set(event, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
  };
}

/** Runs after a reconnection (or permission re-check) re-joined the same workspace. */
export function onRealtimeResync(fn: () => void): () => void {
  resyncListeners.add(fn);
  return () => {
    resyncListeners.delete(fn);
  };
}

/** Subscribe to a realtime event for the lifetime of the component. */
export function useRealtime<T = any>(event: string, handler: (data: T) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribeRealtime<T>(event, (data) => ref.current(data)), [event]);
}

export function useRealtimeResync(handler: () => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => onRealtimeResync(() => ref.current()), []);
}
