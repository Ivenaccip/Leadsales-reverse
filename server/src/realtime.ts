import type { Server } from 'socket.io';

/**
 * Thin wrapper so services can emit without knowing about Socket.IO (and tests can capture events).
 *
 * Rooms per workspace:
 *  - ws:{id}             members who see every conversation
 *  - ws:{id}:admins      owners, admins and the instance operator (broadcast:* events)
 *  - ws:{id}:restricted  agents limited to their own + unassigned conversations
 *  - ws:{id}:u:{userId}  one restricted agent
 * Per connection: user:{userId} and sid:{sessionId}, used to end sessions and re-check rights.
 * Contact/message events reach restricted agents only for conversations they may see.
 *
 * Rooms live in this process's memory: the app must run as a single replica (see docs/04).
 */
export class Realtime {
  io: Server | null = null;
  readonly history: { room: string; event: string; data: unknown }[] = [];
  recordHistory = false;
  /** Returns the assigned user of a contact (set by the app; used only when restricted agents are online). */
  resolveAssignee: ((contactId: string) => Promise<string | null>) | null = null;
  /** Last assignee seen per contact, to tell restricted agents when a conversation leaves them. */
  private assignees = new Map<string, string | null>();

  emit(workspaceId: string, event: string, data: unknown): void {
    const room = `ws:${workspaceId}`;
    // Broadcasts (campaign texts, audiences, costs) are admin-only, like their REST endpoints.
    if (event.startsWith('broadcast:')) {
      if (this.recordHistory) this.history.push({ room: `${room}:admins`, event, data });
      this.io?.to(`${room}:admins`).emit(event, data);
      return;
    }
    if (this.recordHistory) this.history.push({ room, event, data });
    if (!this.io) return;
    this.io.to(room).emit(event, data);
    const restricted = `${room}:restricted`;
    if (!this.io.sockets.adapter.rooms.get(restricted)?.size) {
      // Keep track of assignments anyway, so a later change is noticed against the right owner.
      const d = data as any;
      if (event.startsWith('contact:') && d?.id && 'assigned_user_id' in d) this.trackAssignee(d.id, d.assigned_user_id);
      return;
    }
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

  /** Same as evict() for every workspace a user's sockets joined (e.g. superadmin rights removed). */
  async evictUser(userId: string): Promise<void> {
    if (!this.io) return;
    for (const s of await this.io.in(`user:${userId}`).fetchSockets()) {
      const workspaces = new Set<string>();
      for (const r of s.rooms) {
        if (!r.startsWith('ws:')) continue;
        workspaces.add(r.split(':')[1]);
        s.leave(r);
      }
      for (const workspaceId of workspaces) s.emit('session:refresh', { workspaceId });
    }
  }

  /** Tells the sockets of ended sessions to log out ('session:revoked') and disconnects them. */
  async endSessions(target: { sid: string } | { userId: string; exceptSid?: string }): Promise<void> {
    if (!this.io) return;
    const room = 'sid' in target ? `sid:${target.sid}` : `user:${target.userId}`;
    for (const s of await this.io.in(room).fetchSockets()) {
      if ('exceptSid' in target && target.exceptSid && s.data.sid === target.exceptSid) continue;
      s.emit('session:revoked', {});
      s.disconnect(true);
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
    let contactId: string | undefined;
    if (event.startsWith('contact:') && data && 'assigned_user_id' in data) {
      assignee = data.assigned_user_id;
      contactId = data.id;
    } else if (data?.contact_id && this.resolveAssignee) {
      contactId = data.contact_id;
      assignee = await this.resolveAssignee(data.contact_id);
    }
    if (assignee === undefined) return;
    const own = assignee ? `ws:${workspaceId}:u:${assignee}` : null;
    // When a conversation becomes someone's, the other restricted agents (who saw it unassigned,
    // or as theirs) get no more events about it: tell them to drop it (id only).
    if (contactId && this.trackAssignee(contactId, assignee) !== assignee && own) {
      this.io!.to(restricted).except(own).emit('contact:revoked', { id: contactId });
    }
    this.io!.to(own ?? restricted).emit(event, data);
  }

  /** Records the contact's current assignee and returns the previous one (undefined: unknown). */
  private trackAssignee(contactId: string, assignee: string | null): string | null | undefined {
    const before = this.assignees.get(contactId);
    this.assignees.delete(contactId);
    this.assignees.set(contactId, assignee);
    if (this.assignees.size > 50_000) this.assignees.delete(this.assignees.keys().next().value!);
    return before;
  }
}
