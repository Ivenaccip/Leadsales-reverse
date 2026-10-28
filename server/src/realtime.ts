import type { Server } from 'socket.io';

/**
 * Thin wrapper so services can emit without knowing about Socket.IO (and tests can capture events).
 *
 * Rooms per workspace:
 *  - ws:{id}             members who see every conversation
 *  - ws:{id}:restricted  agents limited to their own + unassigned conversations
 *  - ws:{id}:u:{userId}  one restricted agent
 * Contact/message events reach restricted agents only for conversations they may see.
 */
export class Realtime {
  io: Server | null = null;
  readonly history: { room: string; event: string; data: unknown }[] = [];
  recordHistory = false;
  /** Returns the assigned user of a contact (set by the app; used only when restricted agents are online). */
  resolveAssignee: ((contactId: string) => Promise<string | null>) | null = null;

  emit(workspaceId: string, event: string, data: unknown): void {
    const room = `ws:${workspaceId}`;
    if (this.recordHistory) this.history.push({ room, event, data });
    if (!this.io) return;
    this.io.to(room).emit(event, data);
    const restricted = `${room}:restricted`;
    if (!this.io.sockets.adapter.rooms.get(restricted)?.size) return;
    void this.emitRestricted(workspaceId, event, data).catch(() => {});
  }

  /**
   * Drops a member's (or everyone's) sockets from the workspace rooms and asks the client
   * to join again, so permission changes (removal, deactivation, visibility) apply at once.
   */
  async evict(workspaceId: string, userId?: string): Promise<void> {
    if (!this.io) return;
    for (const room of [`ws:${workspaceId}`, `ws:${workspaceId}:restricted`]) {
      const sockets = await this.io.in(room).fetchSockets();
      for (const s of sockets) {
        if (userId && s.data.userId !== userId) continue;
        for (const r of s.rooms) if (r.startsWith(`ws:${workspaceId}`)) s.leave(r);
        s.emit('session:refresh', { workspaceId });
      }
    }
  }

  private async emitRestricted(workspaceId: string, event: string, data: any) {
    const restricted = `ws:${workspaceId}:restricted`;
    const scoped = /^(contact|message|scheduled):/.test(event);
    if (!scoped) {
      this.io!.to(restricted).emit(event, data);
      return;
    }
    let assignee: string | null | undefined;
    if (event.startsWith('contact:') && data && 'assigned_user_id' in data) assignee = data.assigned_user_id;
    else if (data?.contact_id && this.resolveAssignee) assignee = await this.resolveAssignee(data.contact_id);
    if (assignee === undefined) return;
    this.io!.to(assignee ? `ws:${workspaceId}:u:${assignee}` : restricted).emit(event, data);
  }
}
