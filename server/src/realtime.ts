import type { Server } from 'socket.io';

/** Thin wrapper so services can emit without knowing about Socket.IO (and tests can capture events). */
export class Realtime {
  io: Server | null = null;
  readonly history: { room: string; event: string; data: unknown }[] = [];
  recordHistory = false;

  emit(workspaceId: string, event: string, data: unknown): void {
    const room = `ws:${workspaceId}`;
    if (this.recordHistory) this.history.push({ room, event, data });
    this.io?.to(room).emit(event, data);
  }
}
