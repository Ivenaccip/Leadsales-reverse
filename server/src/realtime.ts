import type { Server } from 'socket.io';

/**
 * Thin wrapper so services can emit without knowing about Socket.IO (and tests can capture events).
 *
 * Rooms per workspace:
 *  - ws:{id}             members who see every conversation
 *  - ws:{id}:admins      owners, admins and the instance operator (broadcast:* events)
 *  - ws:{id}:restricted  agents limited to their own + unassigned conversations
 *  - ws:{id}:u:{userId}  one restricted agent
 * Per connection: user:{userId} and sid:{sessionId}, used to end sessions and re-check rights
 * ('session:refresh' goes to user:{userId}, so every tab hears of it, whatever workspace it shows).
 * Contact/message events reach restricted agents only for conversations they may see.
 *
 * Rooms live in this process's memory: the app must run as a single replica (see docs/04).
 */
export class Realtime {
  io: Server | null = null;
  readonly history: { room: string; event: string; data: unknown }[] = [];
  recordHistory = false;
  /**
   * Returns the assigned user of a contact, null when unassigned and undefined when it does not
   * exist (set by the app; used only when restricted agents are online).
   */
  resolveAssignee: ((contactId: string) => Promise<string | null | undefined>) | null = null;
  /** Last assignee seen per contact, to tell restricted agents when a conversation leaves them. */
  private assignees = new Map<string, string | null>();
  /**
   * Eviction counters per scope (ws:{id}, ws:{id}:u:{userId}, user:{id}, sid:{id}), kept only while
   * a 'join' watches them. A join reads rights from the database and only then enters rooms: if an
   * eviction that concerns it ran in between, its rights may predate the change that caused it, so
   * it must read them again (see app.ts). Per scope, so one tenant's evictions never make another
   * tenant's joins retry (or give up).
   */
  private evictions = new Map<string, { count: number; watchers: number }>();

  /** Watches evictions of these scopes until release(); count() only grows while watched. */
  watchEvictions(scopes: string[]): { count: () => number; release: () => void } {
    const entries = scopes.map((scope) => {
      let e = this.evictions.get(scope);
      if (!e) this.evictions.set(scope, (e = { count: 0, watchers: 0 }));
      e.watchers++;
      return [scope, e] as const;
    });
    let released = false;
    return {
      count: () => entries.reduce((n, [, e]) => n + e.count, 0),
      release: () => {
        if (released) return;
        released = true;
        for (const [scope, e] of entries) if (--e.watchers === 0) this.evictions.delete(scope);
      },
    };
  }

  private bump(scope: string) {
    const e = this.evictions.get(scope);
    if (e) e.count++;
  }

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
   * The member's other tabs (and those of `alsoUsers`) are told to reload their rights too:
   * a role changed here shows wherever they look next.
   */
  async evict(workspaceId: string, userId?: string, alsoUsers: string[] = []): Promise<void> {
    this.bump(userId ? `ws:${workspaceId}:u:${userId}` : `ws:${workspaceId}`);
    if (!this.io) return;
    const targets = new Set<string>();
    for (const room of [`ws:${workspaceId}`, `ws:${workspaceId}:restricted`]) {
      const sockets = await this.io.in(room).fetchSockets();
      for (const s of sockets) {
        if (userId && s.data.userId !== userId) continue;
        for (const r of s.rooms) if (r.startsWith(`ws:${workspaceId}`)) s.leave(r);
        targets.add(s.id);
      }
    }
    for (const u of userId ? [userId, ...alsoUsers] : alsoUsers) targets.add(`user:${u}`);
    // One emit to every room: a socket in several of them still gets the event once.
    if (targets.size) this.io.to([...targets]).emit('session:refresh', { workspaceId });
  }

  /** Same as evict() for every workspace a user's sockets joined (e.g. superadmin rights removed). */
  async evictUser(userId: string): Promise<void> {
    this.bump(`user:${userId}`);
    if (!this.io) return;
    for (const s of await this.io.in(`user:${userId}`).fetchSockets()) {
      let workspaceId: string | null = null;
      for (const r of s.rooms) {
        if (!r.startsWith('ws:')) continue;
        workspaceId = r.split(':')[1];
        s.leave(r);
      }
      // Also a tab that joined no workspace (e.g. one on the "suspended" screen).
      s.emit('session:refresh', { workspaceId });
    }
  }

  /**
   * Rights that only widen or that live outside any room (promotion to instance operator, a
   * reactivated workspace, a new membership): every tab of these users reloads them.
   */
  refreshUsers(userIds: string[], workspaceId: string | null = null): void {
    for (const u of userIds) this.bump(`user:${u}`);
    if (!this.io || !userIds.length) return;
    this.io.to(userIds.map((u) => `user:${u}`)).emit('session:refresh', { workspaceId });
  }

  /**
   * Contacts deleted or archived at once ('contacts:bulk'). Members who see every conversation
   * get all the ids; a restricted agent only those of conversations it could see (its own and
   * unassigned ones), with each contact's assignee as it was when the change was made.
   */
  emitContactsBulk(workspaceId: string, action: 'delete' | 'archive', contacts: { id: string; assigned_user_id: string | null }[]): void {
    if (!contacts.length) return;
    const room = `ws:${workspaceId}`;
    const data = { action, ids: contacts.map((c) => c.id) };
    if (this.recordHistory) this.history.push({ room, event: 'contacts:bulk', data });
    if (action === 'delete') for (const c of contacts) this.assignees.delete(c.id);
    if (!this.io) return;
    this.io.to(room).emit('contacts:bulk', data);
    const restricted = `${room}:restricted`;
    if (!this.io.sockets.adapter.rooms.get(restricted)?.size) return;
    const byOwner = new Map<string | null, string[]>();
    for (const c of contacts) byOwner.set(c.assigned_user_id, [...(byOwner.get(c.assigned_user_id) ?? []), c.id]);
    for (const [owner, ids] of byOwner) this.io.to(owner ? `${room}:u:${owner}` : restricted).emit('contacts:bulk', { action, ids });
  }

  /** Tells the sockets of ended sessions to log out ('session:revoked') and disconnects them. */
  async endSessions(target: { sid: string } | { userId: string; exceptSid?: string }): Promise<void> {
    this.bump('sid' in target ? `sid:${target.sid}` : `user:${target.userId}`);
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
    // Anything about contacts is scoped: one that names no contact this can place is not sent
    // (contacts:bulk goes through emitContactsBulk, which knows each contact's assignee).
    const scoped = /^(contacts?|message|scheduled):/.test(event);
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
