import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Broadcast, Channel, Contact, Message, Template, User, WorkspaceSummary } from '../lib/types';

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
  serverEmit(event: string, data?: unknown) {
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

const { connectRealtime, disconnectRealtime, setRealtimeSessionHandlers } = await import('../lib/realtime');
const { noWorkspaceReason, pickWorkspace, SessionProvider, useSession, workspaceUsable } = await import('../lib/session');
const { ApiError, getWorkspaceId, setWorkspaceId } = await import('../lib/api');
const { canReactivateChannel, reactivateChannel } = await import('../components/settings/ChannelsTab');
const { defaultChannel } = await import('../lib/queries');
const { EstimateCard, draftTemplate } = await import('../pages/Broadcasts');
const { messagesPath, olderMessagesCursor, renderPlaceholders, whenVisible } = await import('../components/inbox/helpers');
const { MessageBubble, mediaDownloadError } = await import('../components/inbox/MessageBubble');
const { ConversationList } = await import('../components/inbox/ConversationList');
const { addDays, lastDays, rangeProblem, ReportUnavailable, todayIn } = await import('../pages/Reports');
const { canCreateWorkspace } = await import('../components/Layout');

const WS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ana: User = { id: 'u-ana', email: 'ana@x.com', name: 'Ana', is_superadmin: false };
const operator: User = { id: 'u-op', email: 'op@x.com', name: 'Op', is_superadmin: true };
const summary = (id: string, patch: Partial<WorkspaceSummary> = {}): WorkspaceSummary => ({
  id,
  name: id === WS_A ? 'Tienda A' : 'Tienda B',
  role: 'owner',
  billing_mode: 'meta_direct',
  is_active: true,
  ...patch,
});

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  disconnectRealtime();
  setRealtimeSessionHandlers({});
  setWorkspaceId(null);
  sockets.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------ #60

describe('the active workspace belongs to the tab, not to the shared localStorage (#60)', () => {
  async function openTab() {
    vi.resetModules();
    return await import('../lib/api');
  }

  it("switching workspace in another tab does not move this tab's requests, media or new tabs' default", async () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    const tab1 = await openTab();
    tab1.setWorkspaceId(WS_A);
    const tab2 = await openTab();
    expect(tab2.getWorkspaceId()).toBe(WS_A); // a new tab starts where the last one left

    tab2.setWorkspaceId(WS_B); // Administración → Abrir, or the workspace menu, in tab 2
    expect(tab2.getWorkspaceId()).toBe(WS_B);
    expect(tab1.getWorkspaceId()).toBe(WS_A);
    expect(tab1.mediaUrl('m1')).toBe(`/api/media/m1?ws=${WS_A}`);

    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchSpy);
    await tab1.api.post('/api/contacts/c1/messages', { type: 'text', text: 'hola' });
    await tab1.api.post('/api/broadcasts', {});
    for (const [, init] of fetchSpy.mock.calls) expect((init!.headers as Record<string, string>)['X-Workspace-Id']).toBe(WS_A);

    // A reload (or a new tab) starts in the last choice.
    const tab3 = await openTab();
    expect(tab3.getWorkspaceId()).toBe(WS_B);
  });

  it("the socket of a tab re-joins its own workspace after another tab switched", () => {
    setWorkspaceId(WS_A);
    connectRealtime(WS_A);
    const s = sockets[0];
    s.serverConnect();
    s.ackJoin(true);
    // Another tab writes its choice into the shared storage.
    localStorage.setItem('leadlibre.workspace', WS_B);
    s.serverConnect(); // reconnect
    expect(s.joins()).toEqual([WS_A, WS_A]);
  });
});

// ------------------------------------------------------------------ #19

describe('permission changes reload the session (#19)', () => {
  it("'session:refresh' asks the session to reload the user's rights", () => {
    const refreshed = vi.fn();
    setRealtimeSessionHandlers({ refreshed });
    setWorkspaceId(WS_A);
    connectRealtime(WS_A);
    const s = sockets[0];
    s.serverConnect();
    s.ackJoin(true);
    expect(refreshed).not.toHaveBeenCalled();

    s.serverEmit('session:refresh', { workspaceId: WS_A });
    expect(refreshed).toHaveBeenCalledTimes(1);
    s.ackJoin(true);
    expect(refreshed).toHaveBeenCalledTimes(1);
  });

  it('a refused join (membership removed, workspace suspended) also reloads it', () => {
    vi.useFakeTimers();
    try {
      const refreshed = vi.fn();
      setRealtimeSessionHandlers({ refreshed });
      setWorkspaceId(WS_A);
      connectRealtime(WS_A);
      const s = sockets[0];
      s.serverConnect();
      s.ackJoin(false);
      // A refusal is retried a few times first (r3-xreq); one that persists reloads the session.
      vi.runAllTimers();
      s.ackJoin(false);
      vi.runAllTimers();
      s.ackJoin(false);
      vi.runAllTimers();
      s.ackJoin(false);
      expect(refreshed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a reloaded session without the current workspace moves the tab to a remaining one and drops its cache', () => {
    let session!: ReturnType<typeof useSession>;
    function Grab() {
      session = useSession();
      return null;
    }
    const qc = new QueryClient();
    renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(SessionProvider, null, createElement(Grab))));
    session.setSession({ user: ana, workspaces: [summary(WS_A), summary(WS_B)] });
    expect(getWorkspaceId()).toBe(WS_A);
    qc.setQueryData(['conversations', {}], { pages: [{ items: [{ id: 'lead-de-A' }] }] });

    // Ana was removed from A: /api/auth/me no longer lists it.
    session.setSession({ user: ana, workspaces: [summary(WS_B)] });
    expect(getWorkspaceId()).toBe(WS_B);
    expect(qc.getQueryData(['conversations', {}])).toBeUndefined();

    // A refresh that keeps the workspace keeps the cache.
    qc.setQueryData(['conversations', {}], { pages: [] });
    session.setSession({ user: ana, workspaces: [summary(WS_B, { role: 'admin' })] });
    expect(qc.getQueryData(['conversations', {}])).toEqual({ pages: [] });
  });

  it('a demoted operator leaves the workspace they had opened without a membership', () => {
    const demoted = { ...operator, is_superadmin: false };
    expect(pickWorkspace(demoted, [summary(WS_A)], WS_B, operator.id)).toEqual({ id: WS_A, foreign: false });
  });
});

// ------------------------------------------------------------------ #40

describe('suspended workspaces are never picked (#40)', () => {
  const suspendedA = summary(WS_A, { is_active: false });

  it('falls back to an active membership, stored or not', () => {
    expect(pickWorkspace(ana, [suspendedA, summary(WS_B)], null, null)).toEqual({ id: WS_B, foreign: false });
    expect(pickWorkspace(ana, [suspendedA, summary(WS_B)], WS_A, null)).toEqual({ id: WS_B, foreign: false });
  });

  it('only suspended workspaces: no workspace, and the member is told why', () => {
    expect(pickWorkspace(ana, [suspendedA], WS_A, null)).toEqual({ id: null, foreign: false });
    expect(noWorkspaceReason({ user: ana, workspace: null, workspaces: [suspendedA] })).toMatch(/suspendió tu espacio de trabajo/);
    expect(noWorkspaceReason({ user: ana, workspace: null, workspaces: [] })).toMatch(/no pertenece a ningún espacio/);
    expect(noWorkspaceReason({ user: ana, workspace: summary(WS_B), workspaces: [suspendedA, summary(WS_B)] })).toBeNull();
  });

  it('the instance operator still works in a suspended workspace (the server lets them)', () => {
    expect(workspaceUsable(operator, suspendedA)).toBe(true);
    expect(workspaceUsable(ana, suspendedA)).toBe(false);
    expect(pickWorkspace(operator, [suspendedA], WS_A, null)).toEqual({ id: WS_A, foreign: false });
  });
});

// ------------------------------------------------------------------ #64

describe("'Nuevo espacio' only where the server allows it (#64)", () => {
  it('needs open sign-up, unless the user is the instance operator', () => {
    expect(canCreateWorkspace(ana, { allowSignup: false })).toBe(false);
    expect(canCreateWorkspace(ana, undefined)).toBe(false);
    expect(canCreateWorkspace(ana, { allowSignup: true })).toBe(true);
    expect(canCreateWorkspace(operator, { allowSignup: false })).toBe(true);
  });
});

// ------------------------------------------------------------------ #18

const cloud: Channel = {
  id: 'ch-a',
  provider: 'cloud_api',
  name: 'Ventas',
  display_phone: '+52 55 1234 5678',
  phone_number_id: '1098765',
  waba_id: '8777777777777',
  verify_token: 'x',
  status: 'disabled',
  last_error: null,
  is_default: true,
  has_access_token: true,
  has_app_secret: true,
  operator_verified: false,
  webhook_url: 'https://x/webhooks/whatsapp',
  created_at: '2026-01-01T00:00:00Z',
};

describe('a disabled number can be turned back on (#18)', () => {
  it('offers "Activar" for a disabled number the admin may manage', () => {
    // Prepaid and back to meta_direct: the number stayed disabled.
    expect(canReactivateChannel(cloud, 'meta_direct', true, true)).toBe(true);
    expect(canReactivateChannel({ ...cloud, provider: 'sandbox' }, 'prepaid', true, false)).toBe(true);
    // Prepaid, verified by the operator, but still disabled (a failed test overwrote last_error).
    expect(canReactivateChannel({ ...cloud, operator_verified: true }, 'prepaid', true, true)).toBe(true);
  });

  it('not for active numbers, agents, tenants of prepaid workspaces, or numbers awaiting verification', () => {
    expect(canReactivateChannel({ ...cloud, status: 'active' }, 'meta_direct', true, true)).toBe(false);
    expect(canReactivateChannel(cloud, 'meta_direct', false, true)).toBe(false);
    expect(canReactivateChannel(cloud, 'prepaid', true, false)).toBe(false);
    expect(canReactivateChannel(cloud, 'prepaid', true, true)).toBe(false);
  });

  it("'Activar' sends PATCH {status: 'active'}", async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ channel: { ...cloud, status: 'active' } }));
    vi.stubGlobal('fetch', fetchSpy);
    await reactivateChannel(cloud);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/channels/ch-a');
    expect(init!.method).toBe('PATCH');
    expect(JSON.parse(init!.body as string)).toEqual({ status: 'active' });
  });
});

// ------------------------------------------------------------------ #21

describe('the default number skips disabled ones, like the server (#21)', () => {
  const b: Channel = { ...cloud, id: 'ch-b', is_default: false, status: 'active', operator_verified: true };

  it('a disabled default is passed over', () => {
    expect(defaultChannel([cloud, b])?.id).toBe('ch-b');
    expect(defaultChannel([{ ...cloud, status: 'active' }, b])?.id).toBe('ch-a');
    expect(defaultChannel([cloud])).toBeUndefined();
    expect(defaultChannel(undefined)).toBeUndefined();
  });

  it('a refused estimate is explained instead of "Calculando…" forever', () => {
    const err = new ApiError(400, 'NO_CHANNEL', 'Conecta un número de WhatsApp (Ajustes → Canales) antes de enviar mensajes');
    const html = renderToStaticMarkup(<EstimateCard estimate={undefined} loading={false} error={err} />);
    expect(html).toContain('Conecta un número de WhatsApp');
    expect(html).not.toContain('Calculando');
    expect(renderToStaticMarkup(<EstimateCard estimate={undefined} loading={true} error={null} />)).toContain('Calculando');
  });
});

describe('a disabled number still shows its templates; only Meta calls need an enabled one (#21 review)', () => {
  // The switch to prepaid disables the workspace's only number (PREPAID_UNVERIFIED).
  const only: Channel = { ...cloud, last_error: 'Desactivado en modo de créditos prepagados: falta verificarlo.' };
  const tpl = {
    id: 't1',
    channel_id: 'ch-a',
    meta_id: null,
    name: 'promo_octubre',
    language: 'es_MX',
    category: 'marketing',
    status: 'APPROVED',
    components: [{ type: 'BODY', text: 'Hola' }],
    parameter_format: 'POSITIONAL',
    rejected_reason: null,
    updated_at: '2026-01-01T00:00:00Z',
    inputs: { header: null, body: [], buttons: [] },
  } as unknown as Template;

  function seeded(channels: Channel[]) {
    const qc = new QueryClient();
    qc.setQueryData(['channels'], channels);
    qc.setQueryData(['templates', 'ch-a'], [tpl]);
    qc.setQueryData(['templates', 'all'], [tpl]);
    return qc;
  }

  async function renderPage(channels: Channel[], admin: boolean) {
    // Fresh modules so the admin variant can stand in for the session (SSR runs no effects).
    vi.resetModules();
    if (admin) vi.doMock('../lib/session', () => ({ useSession: () => ({ isAdmin: true }) }));
    try {
      const [{ default: TemplatesPage }, session, ui] = await Promise.all([import('../pages/Templates'), import('../lib/session'), import('../components/ui')]);
      const page = createElement(ui.ToastProvider, null, createElement(ui.ConfirmProvider, null, createElement(TemplatesPage)));
      return renderToStaticMarkup(
        <QueryClientProvider client={seeded(channels)}>
          <MemoryRouter>{admin ? page : createElement(session.SessionProvider, null, page)}</MemoryRouter>
        </QueryClientProvider>,
      );
    } finally {
      vi.doUnmock('../lib/session');
    }
  }

  it('the page shown with no choice falls back to a disabled number', async () => {
    const { viewedChannel } = await import('../lib/queries');
    const b: Channel = { ...cloud, id: 'ch-b', is_default: false, status: 'active' };
    expect(viewedChannel([only])?.id).toBe('ch-a');
    expect(viewedChannel([only, b])?.id).toBe('ch-b');
    expect(viewedChannel([])).toBeUndefined();
  });

  it("lists the disabled number's templates instead of 'Conecta un número'", async () => {
    const html = await renderPage([only], false);
    expect(html).toContain('promo_octubre');
    expect(html).not.toContain('Conecta un número');
    expect(html).toContain('El número Ventas está deshabilitado');
    expect(html).toContain('Desactivado en modo de créditos prepagados');
    expect(await renderPage([], false)).toContain('Conecta un número de WhatsApp');
  });

  it('sync and create are disabled on a disabled number and enabled on an active one', async () => {
    const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(?:(?!<\/button>).)*?(Sincronizar con Meta|Nueva plantilla)/g)].map((m) => m[0]);
    const off = buttons(await renderPage([only], true));
    expect(off).toHaveLength(2);
    for (const b of off) expect(b).toMatch(/ disabled=""/);
    const on = buttons(await renderPage([{ ...only, status: 'active', last_error: null }], true));
    expect(on).toHaveLength(2);
    for (const b of on) expect(b).not.toMatch(/ disabled=""/);
  });

  it('the inbox picker says the numbers are disabled, not that none is connected', async () => {
    const { TemplatePicker } = await import('../components/inbox/TemplateModals');
    const picker = (channels: Channel[]) =>
      renderToStaticMarkup(
        <QueryClientProvider client={seeded(channels)}>
          <MemoryRouter>
            <TemplatePicker channelId={undefined} choice={{ template: null, value: {} as any }} onChange={() => {}} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    const html = picker([only]);
    expect(html).toContain('Tus números de WhatsApp están deshabilitados');
    expect(html).not.toContain('Conecta un número');
    expect(picker([])).toContain('Conecta un número de WhatsApp para usar plantillas.');
  });
});

// ------------------------------------------------------------------ #41

describe("editing a draft restores its variables from its own number's templates (#41)", () => {
  const tpl = (channel_id: string, name: string): Template =>
    ({ id: `${channel_id}-${name}`, channel_id, name, language: 'es_MX', status: 'APPROVED', category: 'MARKETING', components: [] }) as unknown as Template;
  const draft = { channel_id: 'ch-b', template_name: 'promo_b', template_language: 'es_MX' } as Pick<Broadcast, 'channel_id' | 'template_name' | 'template_language'>;

  it("waits while the list shown is the default number's", () => {
    expect(draftTemplate(draft, 'ch-a', [tpl('ch-a', 'promo_a')])).toEqual({ ready: false });
    expect(draftTemplate(draft, 'ch-b', undefined)).toEqual({ ready: false });
  });

  it("restores from the draft's number", () => {
    const r = draftTemplate(draft, 'ch-b', [tpl('ch-b', 'promo_b')]);
    expect(r.ready && r.template?.name).toBe('promo_b');
  });
});

// ------------------------------------------------------------------ #20

describe('older messages are paged by message id (#20)', () => {
  const msg = (id: string, created_at: string) => ({ id, created_at }) as Message;

  it("the cursor is the oldest message's id, sent as before_id", () => {
    // Two messages from one webhook share a millisecond: only an id cursor keeps the older one.
    const page = { messages: [msg('B', '2026-10-29T01:54:41.780Z'), msg('C', '2026-10-29T01:55:00.000Z')], has_more: true };
    expect(olderMessagesCursor(page)).toBe('B');
    expect(messagesPath('c1', 60, 'B')).toBe('/api/contacts/c1/messages?limit=60&before_id=B');
    expect(messagesPath('c1', 60)).toBe('/api/contacts/c1/messages?limit=60');
    expect(olderMessagesCursor({ ...page, has_more: false })).toBeUndefined();
  });
});

// ------------------------------------------------------------------ #33

describe('quick-reply placeholders render in linear time (#33)', () => {
  const contact = { name: 'Ana López', phone: '5215512345678', email: null, company: null, custom_fields: { ciudad: 'CDMX' } } as unknown as Contact;

  it('a long text full of unclosed "{a|" does not freeze the tab', () => {
    const text = '{a|'.repeat(80_000);
    const t = performance.now();
    expect(renderPlaceholders(text, contact)).toBe(text);
    expect(performance.now() - t).toBeLessThan(1000);
  }, 5000);

  it('placeholders and defaults work as before', () => {
    expect(renderPlaceholders('Hola {primer_nombre}, {empresa|tu empresa} en {campo.ciudad}. {otro}', contact)).toBe('Hola Ana, tu empresa en CDMX. {otro}');
    expect(renderPlaceholders('{nombre|{x}}', { ...contact, name: null })).toBe('{nombre|{x}}');
  });
});

// ------------------------------------------------------------------ #39

describe('an open chat is read when the tab comes back (#39)', () => {
  function fakeDocument(state: DocumentVisibilityState) {
    const listeners = new Set<() => void>();
    return {
      visibilityState: state,
      addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
      show() {
        this.visibilityState = 'visible';
        for (const fn of [...listeners]) fn();
      },
      listeners,
    };
  }

  it('waits for the page to become visible, then runs once', () => {
    const doc = fakeDocument('hidden');
    const read = vi.fn();
    whenVisible(doc as unknown as Document, read);
    expect(read).not.toHaveBeenCalled();
    doc.show();
    expect(read).toHaveBeenCalledTimes(1);
    doc.show();
    expect(read).toHaveBeenCalledTimes(1);
    expect(doc.listeners.size).toBe(0);
  });

  it('runs right away when visible, and not at all once cancelled', () => {
    const read = vi.fn();
    whenVisible(fakeDocument('visible') as unknown as Document, read);
    expect(read).toHaveBeenCalledTimes(1);

    const doc = fakeDocument('hidden');
    const other = vi.fn();
    const cancel = whenVisible(doc as unknown as Document, other);
    cancel();
    doc.show();
    expect(other).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ #61

describe('a media download that failed says so instead of spinning forever (#61)', () => {
  const inbound: Message = {
    id: 'm1',
    contact_id: 'c1',
    channel_id: 'ch1',
    direction: 'in',
    type: 'document',
    body: null,
    media_file_id: null,
    media: { wa_media_id: '123', mime: 'application/pdf', download_error: 'El archivo supera el máximo de 100 MB' },
    payload: null,
    wamid: 'wamid.1',
    reply_to_wamid: null,
    status: 'received',
    error: null,
    sent_by: null,
    user_id: null,
    broadcast_id: null,
    billing_category: null,
    cost: 0,
    created_at: '2026-10-28T15:00:00Z',
  };

  it('shows the reason and asks to have the file sent again', () => {
    const html = renderToStaticMarkup(<MessageBubble m={inbound} />);
    expect(html).toContain('No se pudo descargar el archivo: El archivo supera el máximo de 100 MB. Pide al cliente que lo reenvíe.');
    expect(html).not.toContain('Descargando archivo de WhatsApp');
    expect(mediaDownloadError({ direction: 'in', media: { download_error: 'Token vencido.' } })).toBe(
      'No se pudo descargar el archivo: Token vencido. Pide al cliente que lo reenvíe.',
    );
  });

  it('keeps the spinner while the download may still arrive', () => {
    const html = renderToStaticMarkup(<MessageBubble m={{ ...inbound, media: { wa_media_id: '123' } }} />);
    expect(html).toContain('Descargando archivo de WhatsApp');
  });
});

// ------------------------------------------------------------------ #63

describe('the inbox keeps listing conversations after the only number is deleted (#63)', () => {
  const lead = {
    id: 'c1',
    name: 'Cliente Histórico',
    phone: '5215512345678',
    last_message_at: '2026-10-28T15:00:00Z',
    last_message_preview: 'Gracias',
    unread_count: 0,
    is_archived: false,
    tag_ids: [],
    stage_id: null,
    assigned_user_id: null,
  } as unknown as Contact;
  const filters = { inbox: 'all', search: '', unread: false, tag_id: '', stage_id: '' };

  function render(items: Contact[]) {
    const qc = new QueryClient();
    qc.setQueryData(['channels'], []);
    qc.setQueryData(['conversations', filters], { pages: [{ items, total: items.length, page: 1, limit: 30 }], pageParams: [1] });
    return renderToStaticMarkup(
      createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, createElement(ConversationList, { onSelect: () => {} }))),
    );
  }

  it('lists the kept conversations, with a nudge to connect a number', () => {
    const html = render([lead]);
    expect(html).toContain('Cliente Histórico');
    expect(html).not.toContain('Conecta tu número de WhatsApp');
    expect(html).toContain('conecta un número');
  });

  it('still invites to connect a number when there is nothing to show', () => {
    expect(render([])).toContain('Conecta tu número de WhatsApp');
  });
});

// ------------------------------------------------------------------ #38 / #62

describe("reports use the workspace's calendar days (#38)", () => {
  it("today is the workspace's day, not the UTC one", () => {
    // 20:00 on Oct 29 in Mexico City is 02:00Z on Oct 30.
    const evening = new Date('2026-10-30T02:00:00Z');
    expect(todayIn('America/Mexico_City', evening)).toBe('2026-10-29');
    expect(todayIn('Asia/Tokyo', evening)).toBe('2026-10-30');
    expect(todayIn('No/Existe', evening)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('presets end today and span exactly the chosen days', () => {
    expect(lastDays(7, '2026-10-29')).toEqual({ from: '2026-10-23', to: '2026-10-29' });
    expect(lastDays(30, '2026-03-01')).toEqual({ from: '2026-01-31', to: '2026-03-01' });
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('a custom range the server refuses is explained, not an endless loader (#62)', () => {
  it('ranges over 400 days or reversed are caught before asking', () => {
    expect(rangeProblem({ from: '2025-01-01', to: '2026-10-29' })).toBe('El rango máximo es de 400 días.');
    expect(rangeProblem({ from: '2026-10-29', to: '2026-10-01' })).toMatch(/anterior o igual/);
    expect(rangeProblem({ from: '', to: '2026-10-01' })).toMatch(/Elige/);
    expect(rangeProblem({ from: '2025-09-25', to: '2026-10-29' })).toBeNull(); // exactly 400 days
    expect(rangeProblem({ from: '2026-10-29', to: '2026-10-29' })).toBeNull();
  });

  it("the server's refusal is shown instead of the loader", () => {
    const err = new ApiError(400, 'BAD_REQUEST', 'El rango máximo es de 400 días');
    const html = renderToStaticMarkup(<ReportUnavailable problem={null} error={err} />);
    expect(html).toContain('El rango máximo es de 400 días');
    expect(html).toContain('No se pudo cargar el reporte');
    expect(renderToStaticMarkup(<ReportUnavailable problem="El rango máximo es de 400 días." error={null} />)).toContain('El rango máximo');
  });
});

