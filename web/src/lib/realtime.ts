import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { getWorkspaceId } from './api';

let socket: Socket | null = null;
let joined: string | null = null;

function ensureSocket(): Socket {
  if (!socket) {
    socket = io({ path: '/socket.io', withCredentials: true, transports: ['websocket', 'polling'] });
    socket.on('connect', () => {
      joined = null;
      joinCurrent();
    });
    // The server re-checks permissions (member removed, role or visibility changed).
    socket.on('session:refresh', () => {
      joined = null;
      joinCurrent();
    });
  }
  return socket;
}

function joinCurrent() {
  const ws = getWorkspaceId();
  if (!socket?.connected || !ws || joined === ws) return;
  socket.emit('join', ws, (r: { ok: boolean }) => {
    if (r?.ok) joined = ws;
  });
}

/** Connects (once) and joins the current workspace room. */
export function connectRealtime(workspaceId: string | null) {
  if (!workspaceId) return;
  ensureSocket();
  joinCurrent();
}

export function disconnectRealtime() {
  socket?.disconnect();
  socket = null;
  joined = null;
}

/** Subscribe to a realtime event for the lifetime of the component. */
export function useRealtime<T = any>(event: string, handler: (data: T) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const s = ensureSocket();
    const fn = (data: T) => ref.current(data);
    s.on(event, fn);
    return () => {
      s.off(event, fn);
    };
  }, [event]);
}
