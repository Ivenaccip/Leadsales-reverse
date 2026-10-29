import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Broadcast, Message } from '../lib/types';

/** Stand-in for a socket.io client socket (same idea as realtime-session.test.ts). */
class FakeSocket {
  connected = false;
  handlers = new Map<string, ((...args: any[]) => void)[]>();
  emitted: { event: string; args: any[] }[] = [];
  on(event: string, fn: (...args: any[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
    return this;
  }
  onAny() {
    return this;
  }
  emit(event: string, ...args: any[]) {
    this.emitted.push({ event, args });
    return this;
  }
  disconnect() {
    this.connected = false;
    return this;
  }
  serverConnect() {
    this.connected = true;
    for (const fn of this.handlers.get('connect') ?? []) fn();
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

const { connectRealtime, disconnectRealtime, onRealtimeResync, setRealtimeSessionHandlers, JOIN_RETRY_MS } = await import('../lib/realtime');
const { ApiError, setWorkspaceId } = await import('../lib/api');
const { InvitationSteps, invitationFailure, invitationStep } = await import('../pages/Invitation');
const { AdminUserRow, temporaryPassword, userRecoveryActions } = await import('../pages/Admin');
const { default: BroadcastsPage, broadcastChangedMeanwhile, broadcastSaveBody, editableBroadcast } = await import('../pages/Broadcasts');
const { isNewAttempt, newerStatus, upsertMessage } = await import('../components/inbox/helpers');
const { bulkOutcome, importRequestBody } = await import('../pages/Contacts');
const { decodeCsvFile } = await import('../lib/csv');
const { TAG_NAME_HINT, tagNameProblem } = await import('../components/pickers');
const { tagSaveBody } = await import('../components/settings/LibraryTabs');
const ui = await import('../components/ui');

const WS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  disconnectRealtime();
  setRealtimeSessionHandlers({});
  setWorkspaceId(null);
  sockets.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------ invitations (#51)

describe('the invitation page does not depend on knowing whether the account exists (#51)', () => {
  const inv = { workspace_name: 'Tienda A', email: 'ana@x.com', role: 'agent' as const, expires_at: '2026-11-05T12:00:00Z' };
  const noop = () => {};
  const render = (props: Partial<Parameters<typeof InvitationSteps>[0]>) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <InvitationSteps
          token="tok_abcdefghijklmnopqrstuvwxyz"
          inv={inv}
          step="register"
          user={null}
          form={{ name: '', password: '' }}
          onForm={noop}
          busy={false}
          error={null}
          blocked={false}
          onAccept={noop}
          onRegister={noop}
          onLogout={noop}
          {...props}
        />
      </MemoryRouter>,
    );

  it('an anonymous visitor gets the register form and a way to sign in', () => {
    expect(invitationStep(inv, null)).toBe('register');
    const html = render({});
    expect(html).toContain('Crear cuenta');
    expect(html).toContain('Crear cuenta y entrar');
    expect(html).toContain('Ya tengo cuenta: iniciar sesión');
    expect(html).toContain('href="/login"');
  });

  it('EMAIL_TAKEN on register switches to the login step and shows why', () => {
    const msg = 'Ya existe una cuenta con ese correo: inicia sesión para aceptar la invitación.';
    const f = invitationFailure(new ApiError(409, 'EMAIL_TAKEN', msg));
    expect(f).toEqual({ message: msg, emailTaken: true, final: false });
    expect(invitationStep(inv, null, f.emailTaken)).toBe('login');
    const html = render({ step: 'login', error: f.message });
    expect(html).toContain(msg);
    expect(html).toContain('Iniciar sesión');
    expect(html).not.toContain('Crear cuenta y entrar');
  });

  it('MEMBER_DEACTIVATED on accept shows the server message and no retry button', () => {
    const msg = 'Tu usuario está desactivado en este espacio de trabajo. Pide a un administrador que lo reactive.';
    const f = invitationFailure(new ApiError(409, 'MEMBER_DEACTIVATED', msg));
    expect(f.final).toBe(true);
    const html = render({ step: 'accept', user: { email: 'ana@x.com' }, error: f.message, blocked: f.final });
    expect(html).toContain(msg);
    expect(html).not.toContain('Aceptar invitación');
    // Any other failure keeps the button for a retry.
    expect(invitationFailure(new Error('Failed to fetch')).final).toBe(false);
    expect(render({ step: 'accept', user: { email: 'ana@x.com' }, error: 'Failed to fetch' })).toContain('Aceptar invitación');
  });
});

// ------------------------------------------------------------------ Administración → Usuarios (#25)

describe('the operator can recover a squatted account (#25)', () => {
  const base = { id: 'u-2', email: 'bea@x.com', name: 'Bea', is_superadmin: false, created_at: '2026-10-01T00:00:00Z' };

  it('temporary password for other non-operator accounts; delete only outside every workspace', () => {
    expect(userRecoveryActions({ ...base, workspaces: 0 }, 'u-op')).toEqual({ password: true, remove: true });
    expect(userRecoveryActions({ ...base, workspaces: 2 }, 'u-op')).toEqual({ password: true, remove: false });
    expect(userRecoveryActions({ ...base, workspaces: 0, is_superadmin: true }, 'u-op')).toEqual({ password: false, remove: false });
    expect(userRecoveryActions({ ...base, id: 'u-op', workspaces: 0 }, 'u-op')).toEqual({ password: false, remove: false });
  });

  it('the row lists the workspaces and offers only the allowed actions', () => {
    const row = (u: Parameters<typeof AdminUserRow>[0]['u']) =>
      renderToStaticMarkup(<AdminUserRow u={u} meId="u-op" onToggleSuper={() => {}} onPassword={() => {}} onDelete={() => {}} />);
    const member = row({ ...base, workspaces: 2, workspace_names: 'Tienda A, Tienda B' });
    expect(member).toContain('Tienda A, Tienda B');
    expect(member).toContain('Poner contraseña temporal');
    expect(member).not.toContain('Borrar cuenta');
    const orphan = row({ ...base, workspaces: 0, workspace_names: null });
    expect(orphan).toContain('Sin espacios de trabajo');
    expect(orphan).toContain('Borrar cuenta');
  });

  it('suggests a random temporary password the server accepts (8+ characters)', () => {
    const a = temporaryPassword();
    expect(a).toMatch(/^[a-zA-Z2-9]{12}$/);
    expect(a).not.toMatch(/[01lIO]/);
    expect(temporaryPassword()).not.toBe(a);
  });
});

// ------------------------------------------------------------------ paused broadcasts (#43)

describe('a paused broadcast can be edited, without its audience (#43)', () => {
  const fields = {
    name: 'Promo',
    channelId: 'ch-a',
    template: { name: 'promo_octubre', language: 'es_MX' },
    params: { body: ['{primer_nombre}'] },
    audience: { tag_ids: ['t1'] },
    scheduledAt: null,
  };

  it('never sends the audience (AUDIENCE_LOCKED), number or schedule of a paused one', () => {
    const paused = broadcastSaveBody('paused', fields);
    expect(paused).toEqual({ name: 'Promo', template_name: 'promo_octubre', template_language: 'es_MX', params: { body: ['{primer_nombre}'] } });
    expect('audience' in paused).toBe(false);
    expect(broadcastSaveBody('draft', fields)).toMatchObject({ channel_id: 'ch-a', audience: { tag_ids: ['t1'] }, scheduled_at: null });
    expect(broadcastSaveBody(undefined, fields)).toHaveProperty('audience');
  });

  it('drafts and paused broadcasts are editable; a state change meanwhile reloads the editor', () => {
    expect(['draft', 'paused', 'scheduled', 'running', 'completed', 'cancelled'].filter((s) => editableBroadcast(s as Broadcast['status']))).toEqual(['draft', 'paused']);
    expect(broadcastChangedMeanwhile(new ApiError(400, 'BROADCAST_CHANGED', 'La difusión cambió de estado'))).toBe(true);
    expect(broadcastChangedMeanwhile(new ApiError(400, 'AUDIENCE_LOCKED', 'La audiencia…'))).toBe(true);
    expect(broadcastChangedMeanwhile(new ApiError(400, 'VALIDATION', 'Falta una variable'))).toBe(false);
  });

  it("the detail of a paused broadcast offers 'Editar' next to 'Reanudar'", () => {
    const id = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
    const b = {
      id,
      channel_id: 'ch-a',
      name: 'Promo',
      template_name: 'promo_octubre',
      template_language: 'es_MX',
      template_category: 'marketing',
      params: {},
      audience: {},
      status: 'paused',
      scheduled_at: null,
      started_at: '2026-10-28T15:00:00Z',
      finished_at: null,
      last_error: 'Falta la variable {{2}} de la plantilla',
      total_recipients: 10,
      estimated_cost: 0.5,
      created_at: '2026-10-28T14:00:00Z',
      stats: { total: 10, queued: 6, skipped: 0, failed: 0, sent: 4, delivered: 4, read: 1, replied: 0, cost: 0.2 },
    } as Broadcast;
    const render = (status: Broadcast['status']) => {
      const qc = new QueryClient();
      qc.setQueryData(['broadcast', id], { ...b, status });
      qc.setQueryData(['broadcast-recipients', id, '', 1], []);
      return renderToStaticMarkup(
        <QueryClientProvider client={qc}>
          {createElement(
            ui.ToastProvider,
            null,
            createElement(
              ui.ConfirmProvider,
              null,
              <MemoryRouter initialEntries={[`/difusiones/${id}`]}>
                <Routes>
                  <Route path="/difusiones/*" element={<BroadcastsPage />} />
                </Routes>
              </MemoryRouter>,
            ),
          )}
        </QueryClientProvider>,
      );
    };
    const paused = render('paused');
    expect(paused).toContain('Reanudar');
    expect(paused).toMatch(/>Editar</);
    expect(render('running')).not.toMatch(/>Editar</);
  });
});

// ------------------------------------------------------------------ retried messages (G2 #43 repair)

describe('a message retried as the same row shows its new attempt (auto retry)', () => {
  const CONTACT = 'c1';
  const msg = (id: string, created_at: string, patch: Partial<Message> = {}): Message =>
    ({
      id,
      contact_id: CONTACT,
      channel_id: 'ch-a',
      direction: 'out',
      type: 'template',
      body: 'Hola',
      media_file_id: null,
      media: null,
      payload: null,
      wamid: null,
      reply_to_wamid: null,
      status: 'sent',
      error: null,
      sent_by: 'broadcast',
      user_id: null,
      broadcast_id: 'b1',
      billing_category: 'marketing',
      cost: 0,
      created_at,
      ...patch,
    }) as Message;

  function cache(messages: Message[]) {
    const qc = new QueryClient();
    qc.setQueryData(['messages', CONTACT], { pages: [{ messages, has_more: false }], pageParams: [undefined] });
    return qc;
  }
  const cached = (qc: QueryClient) => (qc.getQueryData(['messages', CONTACT]) as any).pages[0].messages as Message[];

  const failed = msg('m1', '2026-10-29T10:00:00.000Z', {
    status: 'failed',
    error: { message: 'No se pudo conectar con WhatsApp. Se reintentará automáticamente.', network: true, auto_retry: true },
  });

  it('the retry replaces the failed status and its error, and the bubble moves to its new time', () => {
    const qc = cache([failed, msg('m2', '2026-10-29T10:05:00.000Z', { direction: 'in', status: 'received' })]);
    upsertMessage(qc, { ...failed, status: 'pending', error: null, created_at: '2026-10-29T10:20:00.000Z' }, false);
    let list = cached(qc);
    expect(list.map((m) => m.id)).toEqual(['m2', 'm1']);
    expect(list[1]).toMatchObject({ status: 'pending', error: null, created_at: '2026-10-29T10:20:00.000Z' });

    // Later ticks of that attempt rank as usual.
    upsertMessage(qc, { ...list[1], status: 'sent', wamid: 'wamid.X' }, false);
    upsertMessage(qc, { ...list[1], status: 'pending' }, false);
    list = cached(qc);
    expect(list[1].status).toBe('sent');
  });

  it('an attempt that fails again and then goes out on the next retry ends up sent', () => {
    const qc = cache([failed]);
    upsertMessage(qc, { ...failed, status: 'pending', error: null, created_at: '2026-10-29T10:20:00.000Z' }, false);
    upsertMessage(qc, { ...failed, created_at: '2026-10-29T10:20:00.000Z' }, false); // failed again, auto_retry
    expect(cached(qc)[0].status).toBe('failed');
    upsertMessage(qc, { ...failed, status: 'pending', error: null, created_at: '2026-10-29T10:40:00.000Z' }, false);
    upsertMessage(qc, { ...failed, status: 'sent', error: null, wamid: 'wamid.Y', created_at: '2026-10-29T10:40:00.000Z' }, false);
    expect(cached(qc)[0]).toMatchObject({ status: 'sent', error: null });
  });

  it('a settled message is still never downgraded by a late tick', () => {
    const read = msg('m3', '2026-10-29T09:00:00.000Z', { status: 'read', wamid: 'wamid.Z' });
    const qc = cache([read]);
    upsertMessage(qc, { ...read, status: 'delivered' }, false);
    expect(cached(qc)[0].status).toBe('read');
    // A failure without auto retry stays failed (no new attempt, same created_at).
    const final = msg('m4', '2026-10-29T09:00:00.000Z', { status: 'failed', error: { message: 'Número inválido' } });
    expect(isNewAttempt(final, final)).toBe(false);
    expect(newerStatus('failed', 'pending')).toBe('failed');
    expect(isNewAttempt(failed, failed)).toBe(true);
    expect(isNewAttempt(final, { created_at: '2026-10-29T09:30:00.000Z' })).toBe(true);
  });
});

// ------------------------------------------------------------------ realtime join retries

describe('a refused workspace join is retried before reloading the session', () => {
  function connected() {
    const refreshed = vi.fn();
    setRealtimeSessionHandlers({ refreshed });
    setWorkspaceId(WS_A);
    connectRealtime(WS_A);
    const s = sockets[0];
    s.serverConnect();
    return { s, refreshed };
  }

  it('a passing refusal joins on the retry and never reloads the session', () => {
    vi.useFakeTimers();
    const { s, refreshed } = connected();
    const resync = vi.fn();
    const off = onRealtimeResync(resync);
    s.ackJoin(false);
    expect(s.joins()).toEqual([WS_A]);
    vi.advanceTimersByTime(JOIN_RETRY_MS[0] - 1);
    expect(s.joins()).toEqual([WS_A]);
    vi.advanceTimersByTime(1);
    expect(s.joins()).toEqual([WS_A, WS_A]);
    s.ackJoin(true);
    expect(refreshed).not.toHaveBeenCalled();
    // Joined late: what was sent meanwhile is refetched (r4-web #24).
    expect(resync).toHaveBeenCalledTimes(1);
    // Joined: a reconnect is a re-join of the same room.
    s.serverConnect();
    s.ackJoin(true);
    expect(resync).toHaveBeenCalledTimes(2);
    off();
  });

  it('backs off 0.5 s, 1 s and 2 s, then reloads the session once and keeps retrying (r4-web #24)', () => {
    vi.useFakeTimers();
    const { s, refreshed } = connected();
    for (const wait of JOIN_RETRY_MS) {
      const before = s.joins().length;
      s.ackJoin(false);
      expect(refreshed).not.toHaveBeenCalled();
      vi.advanceTimersByTime(wait);
      expect(s.joins()).toHaveLength(before + 1);
    }
    s.ackJoin(false);
    expect(refreshed).toHaveBeenCalledTimes(1);
    vi.runAllTimers();
    expect(s.joins()).toHaveLength(JOIN_RETRY_MS.length + 2);
  });

  it('a retry follows a workspace switch, and a disconnect cancels it', () => {
    vi.useFakeTimers();
    const { s } = connected();
    s.ackJoin(false);
    setWorkspaceId(WS_B);
    vi.advanceTimersByTime(JOIN_RETRY_MS[0]);
    expect(s.joins()).toEqual([WS_A, WS_B]);
    s.ackJoin(false);
    disconnectRealtime();
    vi.runAllTimers();
    expect(s.joins()).toEqual([WS_A, WS_B]);
  });
});

// ------------------------------------------------------------------ contacts (#49, #56, #57)

describe('contacts: bulk delete, tag names and CSV losses', () => {
  it('bulk delete says how many were archived instead of deleted (#49)', () => {
    expect(bulkOutcome('delete', { updated: 3, archived: 2 })).toEqual({
      toast: '3 contactos eliminados',
      notice: '2 contactos se archivaron en lugar de borrarse: tienen mensajes cobrados que Meta todavía no confirma. Podrás borrarlos cuando se confirmen.',
    });
    expect(bulkOutcome('delete', { updated: 0, archived: 1 })).toEqual({
      toast: null,
      notice: '1 contacto se archivó en lugar de borrarse: tiene mensajes cobrados que Meta todavía no confirma. Podrás borrarlo cuando se confirmen.',
    });
    expect(bulkOutcome('delete', { updated: 1, archived: 0 })).toEqual({ toast: '1 contacto eliminado', notice: null });
    expect(bulkOutcome('archive', { updated: 2 })).toEqual({ toast: '2 contactos actualizados', notice: null });
  });

  it('tag names cannot carry ; , or | (#56)', () => {
    expect(tagNameProblem('VIP, Expo')).toBe('El nombre de una etiqueta no puede llevar ; , ni |');
    expect(tagNameProblem('a|b')).not.toBeNull();
    expect(tagNameProblem('Año nuevo')).toBeNull();
    expect(tagNameProblem('x'.repeat(41))).toMatch(/40/);
    expect(TAG_NAME_HINT).toContain('; , ni |');
  });

  it('a tag named before the rule can still change its color, not take a new name with a separator (#56)', () => {
    const legacy = { id: 't-old', name: 'VIP, Expo', color: '#ef4444' };
    // The name is left out, so PATCH /api/tags/:id does not refuse it.
    expect(tagSaveBody(legacy, 'VIP, Expo', '#22c55e')).toEqual({ body: { color: '#22c55e' }, problem: null });
    expect(tagSaveBody(legacy, 'VIP; Expo', '#22c55e').problem).toBe('El nombre de una etiqueta no puede llevar ; , ni |');
    expect(tagSaveBody(legacy, 'VIP Expo', '#22c55e')).toEqual({ body: { name: 'VIP Expo', color: '#22c55e' }, problem: null });
    expect(tagSaveBody(null, 'a|b', '#22c55e').problem).not.toBeNull();
    expect(tagSaveBody({}, 'Nuevo', '#22c55e')).toEqual({ body: { name: 'Nuevo', color: '#22c55e' }, problem: null });
  });

  it('the import says whether decoding lost bytes (#57)', () => {
    const utf8 = new TextEncoder().encode('nombre,teléfono\nAna�,5215512345678\n');
    expect(decodeCsvFile(utf8)).toEqual({ text: 'nombre,teléfono\nAna�,5215512345678\n', lossy: false });
    expect(decodeCsvFile(Uint8Array.from([...'Jos\xe9,1'].map((c) => c.charCodeAt(0))))).toEqual({ text: 'José,1', lossy: false });
    expect(decodeCsvFile(new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toEqual({ text: 'A', lossy: false });
    // Binary-looking bytes fall back to lossy UTF-8; a broken UTF-16 file (lone surrogate) is lossy too.
    expect(decodeCsvFile(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xc3, 0x28])).lossy).toBe(true);
    expect(decodeCsvFile(new Uint8Array([0xff, 0xfe, 0x00, 0xd8, 0x41, 0x00])).lossy).toBe(true);

    expect(importRequestBody('a,b', true, null, [])).toEqual({ csv: 'a,b', lossy: true, stage_id: undefined, tag_ids: undefined });
    expect(JSON.parse(JSON.stringify(importRequestBody('a,b', false, 's1', ['t1'])))).toEqual({ csv: 'a,b', lossy: false, stage_id: 's1', tag_ids: ['t1'] });
  });
});
