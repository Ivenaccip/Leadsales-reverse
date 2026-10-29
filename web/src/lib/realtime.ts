import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { getWorkspaceId } from './api';

type Listener = (data: any) => void;

let socket: Socket | null = null;
/** Workspace room the current connection is in. */
let joined: string | null = null;
/** Last workspace joined by this socket, kept across reconnects to tell a re-join from a switch. */
let lastJoined: string | null = null;

// Handlers live here, not on the socket, so they survive a socket being replaced (logout, new user).
const listeners = new Map<string, Set<Listener>>();
const resyncListeners = new Set<() => void>();
let sessionHandlers: { revoked?: () => void; unauthorized?: () => void } = {};

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
    joined = null;
    joinCurrent();
  });
  // The server re-checks permissions (member removed, role or visibility changed).
  s.on('session:refresh', () => {
    if (socket !== s) return;
    joined = null;
    joinCurrent();
  });
  // Logout, password change or deactivation ended this session: nothing here may keep streaming.
  s.on('session:revoked', () => {
    if (socket !== s) return;
    disconnectRealtime();
    sessionHandlers.revoked?.();
  });
  s.on('connect_error', (err: Error) => {
    if (socket === s && err?.message === 'unauthorized') sessionHandlers.unauthorized?.();
  });
  return s;
}

function joinCurrent() {
  const s = socket;
  const ws = getWorkspaceId();
  if (!s?.connected || !ws || joined === ws) return;
  s.emit('join', ws, (r: { ok: boolean }) => {
    if (socket !== s || !r?.ok) return;
    joined = ws;
    const rejoin = lastJoined === ws;
    lastJoined = ws;
    // Events emitted while disconnected (or before a re-check) are lost: let the pages refetch.
    if (rejoin) for (const fn of [...resyncListeners]) fn();
  });
}

/** Connects (once) and joins the current workspace room. */
export function connectRealtime(workspaceId: string | null) {
  if (!workspaceId) return;
  ensureSocket();
  joinCurrent();
}

/**
 * Drops the connection. The server authenticates a socket only at its handshake, so this must run
 * whenever the signed-in user changes: the next connectRealtime() opens one with the new cookie.
 */
export function disconnectRealtime() {
  const s = socket;
  socket = null;
  joined = null;
  lastJoined = null;
  s?.disconnect();
}

/** Called when the server ends this session ('session:revoked') or refuses the handshake. */
export function setRealtimeSessionHandlers(h: { revoked?: () => void; unauthorized?: () => void }) {
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
