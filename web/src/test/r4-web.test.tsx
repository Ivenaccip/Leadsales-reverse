import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { environmentManager, focusManager, InfiniteQueryObserver, QueryClient, QueryClientProvider, QueryObserver, useQuery } from '@tanstack/react-query';
import type { Channel, Contact, Message, Template, User, WorkspaceSummary } from '../lib/types';
import type { ConversationsData, MessagesData, MessagesPage } from '../components/inbox/helpers';

/** Stand-in for a socket.io client socket (same idea as realtime-session.test.ts). */
class FakeSocket {
  connected = false;
  /** socket.io's `active`: false once the server refused the handshake (it then never retries). */
  active = true;
  connects = 0;
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
  connect() {
    this.connects++;
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
  /** The handshake middleware answered next(new Error(message)). */
  refuseHandshake(message: string) {
    this.connected = false;
    this.active = false;
    for (const fn of this.handlers.get('connect_error') ?? []) fn(new Error(message));
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

const {
  connectRealtime,
  disconnectRealtime,
  listenForSessionChanges,
  onRealtimeResync,
  setRealtimeSessionHandlers,
  JOIN_RETRY_MS,
  JOIN_RETRY_MAX_MS,
  RECONNECT_MS,
} = await import('../lib/realtime');
const { SessionProvider, useSession } = await import('../lib/session');
const { ApiError, setWorkspaceId } = await import('../lib/api');
const { decodeCsvFile } = await import('../lib/csv');
const { CHANNEL_RECHECK_MS, contactChannel, contactChannelQuery, recheckContactChannel, useRecheckChannels } = await import('../lib/queries');
const { patchConversations, revokeContact, uniqueById, upsertMessage, WaText } = await import('../components/inbox/helpers');
const { ConversationList, conversationsQuery } = await import('../components/inbox/ConversationList');
const { ScheduleModal, SendTemplateModal } = await import('../components/inbox/TemplateModals');
const { Composer } = await import('../components/inbox/Composer');
const ui = await import('../components/ui');

const WS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WS_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ana: User = { id: 'u-ana', email: 'ana@x.com', name: 'Ana', is_superadmin: false };
const summary = (id: string, patch: Partial<WorkspaceSummary> = {}): WorkspaceSummary => ({
  id,
  name: id === WS_A ? 'Tienda A' : 'Tienda B',
  role: 'owner',
  billing_mode: 'meta_direct',
  is_active: true,
  ...patch,
});

function contact(id: string, patch: Partial<Contact> = {}): Contact {
  return {
    id,
    phone: '5215512345678',
    wa_id: null,
    name: `Cliente ${id}`,
    email: null,
    company: null,
    channel_id: null,
    funnel_id: null,
    stage_id: null,
    assigned_user_id: null,
    deal_value: 0,
    custom_fields: {},
    source: 'whatsapp',
    last_message_at: '2026-10-29T10:00:00.000Z',
    last_message_preview: 'Hola',
    last_inbound_at: '2026-10-29T10:00:00.000Z',
    unread_count: 0,
    bot_state: null,
    ai_paused: false,
    is_archived: false,
    opted_out: false,
    stage_changed_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-29T10:00:00.000Z',
    tag_ids: [],
    ...patch,
  };
}

const allFilters = { inbox: 'all' as const, search: '', unread: false, tag_id: '', stage_id: '' };

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

// ------------------------------------------------------------------ #16

describe('CSV: a UTF-8 file with one bad byte is not read as windows-1252 (#16)', () => {
  const utf8 = (s: string) => new TextEncoder().encode(s);
  const cp1252 = (s: string) => Uint8Array.from([...s].map((ch) => ch.charCodeAt(0)));
  const join = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };

  it('a value cut mid-character goes on as lossy UTF-8, so the server refuses it instead of storing mojibake', () => {
    const bytes = join(utf8('telefono,nombre\n5215512345678,José Pérez\n5215512345679,María\n5215512345670,Mar'), new Uint8Array([0xc3, 0x0a]));
    const r = decodeCsvFile(bytes);
    expect(r.lossy).toBe(true);
    expect(r.text).toContain('José Pérez');
    expect(r.text).toContain('María');
    expect(r.text).toContain('Mar\ufffd');
    expect(r.text).not.toContain('Ã');
  });

  it('a UTF-8 export with a windows-1252 row appended is lossy too; its accented header is kept', () => {
    const r = decodeCsvFile(join(utf8('Teléfono,Nombre\n5215512345678,José\n'), cp1252('5215512345679,Ramón\n')));
    expect(r.lossy).toBe(true);
    expect(r.text.startsWith('Teléfono,Nombre\n5215512345678,José\n')).toBe(true);
  });

  it("Excel's ANSI files are still read here, without loss", () => {
    const csv = 'Teléfono,Nombre\n5215512345678,José Muñoz\n5215512345679,Ramón “el güero”\n';
    expect(decodeCsvFile(cp1252(csv.replace(/[“”]/g, (q) => (q === '“' ? '\x93' : '\x94'))))).toEqual({ text: csv, lossy: false });
  });
});

// ------------------------------------------------------------------ #28

describe('formatting a WhatsApp text is linear in its length (#28)', () => {
  const html = (text: string) => renderToStaticMarkup(createElement(WaText, { text }));

  it('one long URL-like message from a customer does not freeze the tab', () => {
    const text = 'Hola https://a' + '.'.repeat(65_000) + 'x';
    const t0 = performance.now();
    const out = html(text);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(out).toContain('href="https://a...');
  });

  it('other hostile texts stay fast too', () => {
    const texts = [
      'https://a' + ')'.repeat(65_000) + 'x',
      '*' + 'a'.repeat(65_000),
      '```' + '`a'.repeat(30_000),
      ('_a' + '.'.repeat(50) + ' https://b').repeat(1_000),
    ];
    const t0 = performance.now();
    for (const t of texts) html(t);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('trailing punctuation still stays out of the link', () => {
    const out = html('Mira https://ejemplo.com/promo?x=1). y *ya*');
    expect(out).toContain('<a href="https://ejemplo.com/promo?x=1"');
    expect(out).toContain('https://ejemplo.com/promo?x=1</a>). y <strong>ya</strong>');
  });
});

// ------------------------------------------------------------------ #29

describe('a late inbound message is placed by its time in the open chat (#29)', () => {
  const msg = (id: string, at: string): Message =>
    ({ id, contact_id: 'c1', direction: 'in', type: 'text', body: id, status: 'received', created_at: `2026-10-29T${at}:00.000Z` }) as Message;
  function chat(pages: MessagesPage[]) {
    const qc = new QueryClient();
    qc.setQueryData<MessagesData>(['messages', 'c1'], { pages, pageParams: pages.map((_, i) => (i ? 'cursor' : undefined)) });
    return qc;
  }
  /** What ChatView lists: pages reversed and flattened, each id once. */
  const shown = (qc: QueryClient) =>
    uniqueById([...(qc.getQueryData<MessagesData>(['messages', 'c1'])?.pages ?? [])].reverse().flatMap((p) => p.messages)).map((m) => m.id);

  it('M3 delivered before M1 and M2 shows M1, M2, M3, like the server stores them', () => {
    const qc = chat([{ messages: [msg('M0', '09:00'), msg('M3', '10:03')], has_more: false }]);
    upsertMessage(qc, msg('M1', '10:01'));
    upsertMessage(qc, msg('M2', '10:02'));
    expect(shown(qc)).toEqual(['M0', 'M1', 'M2', 'M3']);
    upsertMessage(qc, msg('M4', '10:04'));
    expect(shown(qc)).toEqual(['M0', 'M1', 'M2', 'M3', 'M4']);
  });

  it('goes into the loaded page whose time range holds it', () => {
    const qc = chat([
      { messages: [msg('B3', '10:03'), msg('B4', '10:04')], has_more: true },
      { messages: [msg('B1', '10:01'), msg('B2', '10:02')], has_more: true },
    ]);
    upsertMessage(qc, msg('L', '10:02'));
    expect(shown(qc)).toEqual(['B1', 'B2', 'L', 'B3', 'B4']);
  });

  it('one older than everything loaded waits for "Cargar mensajes anteriores" instead of showing twice', () => {
    const qc = chat([{ messages: [msg('B2', '10:02'), msg('B3', '10:03')], has_more: true }]);
    upsertMessage(qc, msg('LATE', '10:00'));
    expect(shown(qc)).toEqual(['B2', 'B3']);
    // The older page (before_id = B2) brings it.
    const data = qc.getQueryData<MessagesData>(['messages', 'c1'])!;
    qc.setQueryData<MessagesData>(['messages', 'c1'], {
      pages: [...data.pages, { messages: [msg('B1', '09:59'), msg('LATE', '10:00')], has_more: false }],
      pageParams: [...data.pageParams, 'B2'],
    });
    expect(shown(qc)).toEqual(['B1', 'LATE', 'B2', 'B3']);
  });

  it('with the start of the conversation loaded it goes first', () => {
    const qc = chat([{ messages: [msg('B2', '10:02')], has_more: false }]);
    upsertMessage(qc, msg('LATE', '10:00'));
    expect(shown(qc)).toEqual(['LATE', 'B2']);
  });
});

// ------------------------------------------------------------------ #30

describe('the conversation list pages by cursor, not by offset (#30)', () => {
  it('asks for the next page after the last row the server sent, whatever live events did to the cached pages', async () => {
    const urls: string[] = [];
    const pages = [
      { items: [contact('c1'), contact('c2')], total: 4, page: 1, limit: 30, next_cursor: 'K2' },
      { items: [contact('c3'), contact('c4')], total: 4, page: 1, limit: 30, next_cursor: null },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return jsonResponse(pages[urls.length - 1]);
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const filters = { ...allFilters, inbox: 'unassigned' as const };
    const obs = new InfiniteQueryObserver(qc, conversationsQuery(filters));
    const unsub = obs.subscribe(() => {});
    await vi.waitFor(() => expect(obs.getCurrentResult().data?.pages).toHaveLength(1));
    expect(obs.getCurrentResult().hasNextPage).toBe(true);

    // The agent takes c1: it leaves 'Sin asignar' in the cached first page.
    patchConversations(qc, { ...contact('c1'), assigned_user_id: 'u-ana' }, 'u-ana');
    await obs.fetchNextPage();

    expect(urls[0]).not.toMatch(/[?&](cursor|page)=/);
    expect(urls[1]).toContain('cursor=K2');
    expect(urls[1]).not.toMatch(/[?&]page=/);
    expect(obs.getCurrentResult().data!.pages.flatMap((p) => p.items.map((c) => c.id))).toEqual(['c2', 'c3', 'c4']);
    expect(obs.getCurrentResult().hasNextPage).toBe(false);
    unsub();
  });

  it('a conversation found in two pages is listed once', () => {
    const qc = new QueryClient();
    qc.setQueryData<ConversationsData>(['conversations', allFilters], {
      pages: [
        { items: [contact('c9', { name: 'Lead Nuevo' }), contact('c1', { name: 'Ana Pérez' })], total: 3, page: 1, limit: 30, next_cursor: 'K1' },
        { items: [contact('c9', { name: 'Lead Nuevo' }), contact('c2', { name: 'Beto Ruiz' })], total: 3, page: 1, limit: 30, next_cursor: 'K2' },
      ],
      pageParams: [null, 'K1'],
    });
    const html = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, createElement(ConversationList, { onSelect: () => {} }))),
    );
    expect(html.split('Lead Nuevo').length - 1).toBe(1);
    expect(html).toContain('Ana Pérez');
    expect(html).toContain('Beto Ruiz');
    expect(html).toContain('Cargar más');
  });
});

// ------------------------------------------------------------------ #22

describe("a restricted agent's own reassignment does not bring the conversation back (#22)", () => {
  function inbox() {
    const qc = new QueryClient();
    qc.setQueryData<ConversationsData>(['conversations', allFilters], {
      pages: [{ items: [contact('c1', { assigned_user_id: 'u-ana' }), contact('c2')], total: 2, page: 1, limit: 30, next_cursor: null }],
      pageParams: [null],
    });
    return qc;
  }
  const ids = (qc: QueryClient) => qc.getQueryData<ConversationsData>(['conversations', allFilters])!.pages.flatMap((p) => p.items.map((c) => c.id));

  it("the PATCH answer that arrives after 'contact:revoked' does not list it again", () => {
    const qc = inbox();
    revokeContact(qc, 'c1'); // Layout, on 'contact:revoked' (sent before the server answers)
    patchConversations(qc, contact('c1', { assigned_user_id: 'u-beto' }), 'u-ana'); // ContactPanel, on the answer
    expect(ids(qc)).toEqual(['c2']);

    // Given back to her later: the live event lists it again, and her own changes apply again.
    patchConversations(qc, contact('c1', { assigned_user_id: 'u-ana', last_message_at: '2026-10-29T11:00:00.000Z' }), 'u-ana', true);
    expect(ids(qc)).toEqual(['c1', 'c2']);
    patchConversations(qc, contact('c1', { assigned_user_id: 'u-ana', last_message_at: '2026-10-29T11:00:00.000Z', name: 'Nuevo nombre' }), 'u-ana');
    expect(qc.getQueryData<ConversationsData>(['conversations', allFilters])!.pages[0].items[0].name).toBe('Nuevo nombre');
  });

  it('an answer that arrives first is undone by the revoke', () => {
    const qc = inbox();
    patchConversations(qc, contact('c1', { assigned_user_id: 'u-beto' }), 'u-ana');
    revokeContact(qc, 'c1');
    expect(ids(qc)).toEqual(['c2']);
  });

  it('the hold is short: later on, her own changes apply again', () => {
    vi.useFakeTimers();
    const qc = inbox();
    revokeContact(qc, 'c1');
    vi.advanceTimersByTime(61_000);
    // E.g. it was given back while her socket was down, and the list was refetched since.
    patchConversations(qc, contact('c1', { assigned_user_id: 'u-ana', last_message_at: '2026-10-29T11:00:00.000Z' }), 'u-ana');
    expect(ids(qc)).toEqual(['c1', 'c2']);
  });
});

// ------------------------------------------------------------------ #31

describe("a conversation on a disabled number says so instead of offering that number's templates (#31)", () => {
  const base: Channel = {
    id: 'ch-a',
    provider: 'cloud_api',
    name: 'Ventas',
    display_phone: '+52 55 1234 5678',
    phone_number_id: '1098765',
    waba_id: '8777777777777',
    verify_token: 'x',
    status: 'disabled',
    last_error: 'Desactivado en modo de créditos prepagados: falta verificarlo.',
    is_default: false,
    has_access_token: true,
    has_app_secret: true,
    operator_verified: false,
    webhook_url: 'https://x/webhooks/whatsapp',
    created_at: '2026-01-01T00:00:00Z',
  };
  const A = base;
  const B: Channel = { ...base, id: 'ch-b', name: 'Soporte', status: 'active', last_error: null, is_default: true };
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
  const onA = contact('c1', { channel_id: 'ch-a' });

  function render(node: ReturnType<typeof createElement>) {
    const qc = new QueryClient();
    qc.setQueryData(['channels'], [A, B]);
    qc.setQueryData(['templates', 'ch-a'], [tpl]);
    qc.setQueryData(['templates', 'ch-b'], [{ ...tpl, id: 't2', channel_id: 'ch-b', name: 'bienvenida' }]);
    qc.setQueryData(['quick-replies'], []);
    return renderToStaticMarkup(
      createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, createElement(ui.ToastProvider, null, node))),
    );
  }

  it("the conversation's number decides; a disabled one leaves nothing to send from", () => {
    expect(contactChannel(onA, [A, B])).toEqual({ id: undefined, disabled: A });
    expect(contactChannel({ channel_id: 'ch-b' }, [A, B])).toEqual({ id: 'ch-b', disabled: null });
    expect(contactChannel({ channel_id: null }, [A, B])).toEqual({ id: 'ch-b', disabled: null });
    // Numbers not loaded yet: the server decides.
    expect(contactChannel(onA, undefined)).toEqual({ id: 'ch-a', disabled: null });
  });

  it('the template and schedule dialogs name the disabled number instead of listing its templates', () => {
    for (const html of [
      render(createElement(SendTemplateModal, { open: true, onClose: () => {}, contact: onA, onSent: () => {} })),
      render(createElement(ScheduleModal, { open: true, onClose: () => {}, contact: onA, windowOpen: false, onScheduled: () => {} })),
    ]) {
      expect(html).toContain('El número de esta conversación (Ventas) está deshabilitado: Desactivado en modo de créditos prepagados: falta verificarlo. Reactívalo en Ajustes → Canales');
      expect(html).not.toContain('promo_octubre');
      expect(html).not.toContain('bienvenida');
      expect(html).not.toContain('Conecta un número');
    }
    // The other number's conversations are unaffected.
    expect(render(createElement(SendTemplateModal, { open: true, onClose: () => {}, contact: contact('c2', { channel_id: 'ch-b' }), onSent: () => {} }))).toContain('bienvenida');
  });

  it('the composer says so and does not offer a reply that the server would refuse', () => {
    const composer = (c: Contact) =>
      render(
        createElement(Composer, { contact: c, windowOpen: true, remainingMs: 3_600_000, onSent: () => {}, onOpenTemplate: () => {}, onOpenSchedule: () => {} }),
      );
    const off = composer(onA);
    expect(off).toContain('El número de esta conversación (Ventas) está deshabilitado');
    expect(off).toMatch(/<textarea[^>]* disabled=""/);
    const on = composer(contact('c2', { channel_id: 'ch-b' }));
    expect(on).not.toContain('está deshabilitado');
    expect(on).not.toMatch(/<textarea[^>]* disabled=""/);
  });

  // Nothing announces a number's status changing (PATCH /api/channels/:id emits no event), and the
  // blocked composer sends nothing that could fail and reload the list.
  describe('the block follows the number, not a cache nothing refreshes (#31 review)', () => {
    let server: Channel[];
    let fetches: number;
    beforeEach(() => {
      fetches = 0;
      // Node has no window, so React Query would take it for a server and never start timers.
      environmentManager.setIsServer(() => false);
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url !== '/api/channels') return jsonResponse({});
          fetches++;
          return jsonResponse({ channels: server });
        }),
      );
    });
    afterEach(() => environmentManager.setIsServer(() => true));
    // main.tsx's defaults: data is fresh for 30 s and focus does not refetch.
    const appClient = () => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: false } } });
    const reactivated = () => [{ ...A, status: 'active' as const, last_error: null }, B];

    it('a chat blocked by its disabled number unblocks once the number is reactivated elsewhere, then stops checking', async () => {
      vi.useFakeTimers();
      server = [A, B];
      const qc = appClient();
      const obs = new QueryObserver(qc, contactChannelQuery(onA));
      const unsub = obs.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(contactChannel(onA, obs.getCurrentResult().data).disabled?.id).toBe('ch-a');

      server = reactivated();
      await vi.advanceTimersByTimeAsync(CHANNEL_RECHECK_MS);
      expect(fetches).toBe(2);
      expect(contactChannel(onA, obs.getCurrentResult().data)).toEqual({ id: 'ch-a', disabled: null });
      // Back in service: no more polling.
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(fetches).toBe(2);
      unsub();
    });

    it('a chat on a working number does not poll', async () => {
      vi.useFakeTimers();
      server = [A, B];
      const qc = appClient();
      const obs = new QueryObserver(qc, contactChannelQuery(contact('c2', { channel_id: 'ch-b' })));
      const unsub = obs.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(fetches).toBe(1);
      unsub();
    });

    it('coming back to the tab re-checks a blocked chat at once', async () => {
      server = [A, B];
      const qc = appClient();
      qc.mount(); // listens to focus, as QueryClientProvider does
      const obs = new QueryObserver(qc, contactChannelQuery(onA));
      const unsub = obs.subscribe(() => {});
      await vi.waitFor(() => expect(obs.getCurrentResult().data).toBeDefined());
      server = reactivated();
      try {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
        await vi.waitFor(() => expect(contactChannel(onA, obs.getCurrentResult().data).disabled).toBeNull());
      } finally {
        focusManager.setFocused(undefined);
      }
      expect(fetches).toBe(2);
      unsub();
      qc.unmount();
    });

    it("a send refused with NO_CHANNEL reloads the numbers, and the notice replaces the server's generic text", async () => {
      server = reactivated();
      const qc = appClient();
      const obs = new QueryObserver(qc, contactChannelQuery(onA));
      const unsub = obs.subscribe(() => {});
      await vi.waitFor(() => expect(obs.getCurrentResult().data).toBeDefined());
      // A is disabled with no event (distrusted webhook, PATCH status 'disabled'): the dialog still listed its templates.
      server = [A, B];
      const noChannel = new ApiError(400, 'NO_CHANNEL', 'Conecta un número de WhatsApp (Ajustes → Canales) antes de enviar mensajes');
      expect(await recheckContactChannel(qc, onA, noChannel)).toBe(true);
      expect(fetches).toBe(2);
      expect(contactChannel(onA, qc.getQueryData(['channels'])).disabled?.id).toBe('ch-a');
      // Another conversation's number is fine: the server's message stays.
      expect(await recheckContactChannel(qc, { channel_id: 'ch-b' }, noChannel)).toBe(false);
      // Other errors reload nothing.
      expect(await recheckContactChannel(qc, onA, new ApiError(400, 'WINDOW_CLOSED', 'x'))).toBe(false);
      expect(fetches).toBe(3);
      unsub();
    });

    it('opening a dialog that sends reloads the numbers', async () => {
      server = reactivated();
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
      vi.stubGlobal('window', globalThis);
      vi.stubGlobal('document', doc);
      vi.stubGlobal('HTMLIFrameElement', class {});
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      const { createRoot } = await import('react-dom/client');
      // What SendTemplateModal and ScheduleModal do, minus their markup.
      function Dialog({ open }: { open: boolean }) {
        useQuery(contactChannelQuery(onA));
        useRecheckChannels(open);
        return null;
      }
      const qc = appClient();
      const root = createRoot(container as unknown as Element);
      const show = (open: boolean) =>
        act(async () => {
          root.render(createElement(QueryClientProvider, { client: qc }, createElement(Dialog, { open })));
          await new Promise((r) => setTimeout(r, 0));
        });
      await show(false);
      expect(fetches).toBe(1);
      server = [A, B];
      await show(true);
      expect(fetches).toBe(2);
      expect(contactChannel(onA, qc.getQueryData(['channels'])).disabled?.id).toBe('ch-a');
      await show(true);
      expect(fetches).toBe(2);
      await show(false);
      await show(true);
      expect(fetches).toBe(3);
      await act(async () => root.unmount());
    });
  });
});

// ------------------------------------------------------------------ #24

describe('a refused join keeps being retried while the tab shows that workspace (#24)', () => {
  it('after the quick retries the session reloads, and the join goes on until the database is back', () => {
    vi.useFakeTimers();
    const refreshed = vi.fn();
    setRealtimeSessionHandlers({ refreshed });
    const resync = vi.fn();
    const off = onRealtimeResync(resync);
    setWorkspaceId(WS_A);
    connectRealtime(WS_A);
    const s = sockets[0];
    s.serverConnect();
    s.ackJoin(true);

    // The agent switches to B during a database failover; the reloaded session keeps B.
    setWorkspaceId(WS_B);
    connectRealtime(WS_B);
    for (const wait of JOIN_RETRY_MS) {
      s.ackJoin(false);
      vi.advanceTimersByTime(wait);
    }
    s.ackJoin(false);
    expect(refreshed).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(JOIN_RETRY_MAX_MS);
    expect(s.joins()).toEqual([WS_A, WS_B, WS_B, WS_B, WS_B, WS_B]);
    s.ackJoin(false); // still down
    vi.advanceTimersByTime(JOIN_RETRY_MAX_MS);
    expect(s.joins()).toHaveLength(7);
    s.ackJoin(true); // back
    // Events sent to B meanwhile never arrived: the pages refetch.
    expect(resync).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10 * 60_000);
    expect(s.joins()).toHaveLength(7);
    off();
  });

  it('a refused switch that sends the tab back joins the room it had left again', () => {
    vi.useFakeTimers();
    setWorkspaceId(WS_C);
    connectRealtime(WS_C);
    const s = sockets[0];
    s.serverConnect();
    s.ackJoin(true);
    // Her membership in B was removed: the server leaves every room and refuses.
    setWorkspaceId(WS_B);
    connectRealtime(WS_B);
    s.ackJoin(false);
    // The reloaded session moves the tab back to C (Layout's effect).
    setWorkspaceId(WS_C);
    connectRealtime(WS_C);
    expect(s.joins()).toEqual([WS_C, WS_B, WS_C]);
  });

  it('a join that succeeds after the tab moved on is followed by the one the tab shows', () => {
    setWorkspaceId(WS_A);
    connectRealtime(WS_A);
    const s = sockets[0];
    s.serverConnect();
    s.ackJoin(true);
    setWorkspaceId(WS_B);
    connectRealtime(WS_B); // join B on its way…
    setWorkspaceId(WS_A);
    connectRealtime(WS_A); // …while the tab already went back to A
    s.ackJoin(true);
    expect(s.joins()).toEqual([WS_A, WS_B, WS_A]);
  });

  it('a member left without a usable workspace still hears session:refresh', () => {
    const refreshed = vi.fn();
    setRealtimeSessionHandlers({ refreshed });
    listenForSessionChanges();
    const s = sockets[0];
    s.serverConnect();
    expect(s.joins()).toEqual([]);
    s.serverEmit('session:refresh', {}); // the operator reactivated her workspace
    expect(refreshed).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------------------ #37

describe('a refused handshake does not end realtime for the tab (#37)', () => {
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  function opened() {
    setWorkspaceId(WS_A);
    connectRealtime(WS_A);
    return sockets[0];
  }

  it("'unavailable' (the server could not check the session) is retried with backoff", () => {
    vi.useFakeTimers();
    const s = opened();
    s.refuseHandshake('unavailable');
    expect(s.connects).toBe(0);
    vi.advanceTimersByTime(RECONNECT_MS[0]);
    expect(s.connects).toBe(1);
    s.refuseHandshake('unavailable');
    vi.advanceTimersByTime(RECONNECT_MS[0]);
    expect(s.connects).toBe(1); // backing off
    vi.advanceTimersByTime(RECONNECT_MS[1] - RECONNECT_MS[0]);
    expect(s.connects).toBe(2);
    s.serverConnect();
    expect(s.joins()).toEqual([WS_A]);
    // A later refusal starts over from the shortest wait.
    s.refuseHandshake('unavailable');
    vi.advanceTimersByTime(RECONNECT_MS[0]);
    expect(s.connects).toBe(3);
  });

  it("'unauthorized' with a session that is still valid reconnects once the check settles", async () => {
    vi.useFakeTimers();
    let settle!: () => void;
    const unauthorized = vi.fn(() => new Promise<void>((r) => (settle = r)));
    setRealtimeSessionHandlers({ unauthorized });
    const s = opened();
    s.refuseHandshake('unauthorized');
    expect(unauthorized).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(RECONNECT_MS[RECONNECT_MS.length - 1]);
    expect(s.connects).toBe(0);
    settle(); // /api/auth/me answered 200 (or 5xx, or the network failed)
    await flush();
    vi.advanceTimersByTime(RECONNECT_MS[0]);
    expect(s.connects).toBe(1);
  });

  it("'unauthorized' confirmed by a 401 signs the tab out and does not reconnect", async () => {
    vi.useFakeTimers();
    // What a 401 from /api/auth/me does (api.ts → signOut → disconnectRealtime).
    setRealtimeSessionHandlers({ unauthorized: async () => disconnectRealtime() });
    const s = opened();
    s.refuseHandshake('unauthorized');
    await flush();
    vi.runAllTimers();
    expect(s.connects).toBe(0);
  });

  it('a connection lost while the socket is still active is left to socket.io', () => {
    vi.useFakeTimers();
    const s = opened();
    s.serverConnect();
    s.connected = false;
    for (const fn of s.handlers.get('connect_error') ?? []) fn(new Error('xhr poll error'));
    vi.runAllTimers();
    expect(s.connects).toBe(0);
  });
});

// ------------------------------------------------------------------ #20

describe('switching workspace reloads the rights shown there (#20)', () => {
  it('a role changed while the tab showed another workspace is up to date after the switch', async () => {
    // Just enough DOM for react-dom/client with components that render nothing.
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
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('HTMLIFrameElement', class {});
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let me = { user: ana, workspaces: [summary(WS_A, { role: 'admin' }), summary(WS_B)] };
    const fetchSpy = vi.fn(async (url: string) => (url === '/api/auth/me' ? jsonResponse(me) : jsonResponse({})));
    vi.stubGlobal('fetch', fetchSpy);
    setWorkspaceId(WS_B);

    const { createRoot } = await import('react-dom/client');
    let session!: ReturnType<typeof useSession>;
    function Grab() {
      session = useSession();
      return null;
    }
    const settle = () =>
      act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    const root = createRoot(container as unknown as Element);
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(SessionProvider, null, createElement(Grab))));
    });
    await settle();
    expect(session.workspace?.id).toBe(WS_B);

    // Demoted to agent in A while her tab showed B: no event reached it.
    me = { user: ana, workspaces: [summary(WS_A, { role: 'agent' }), summary(WS_B)] };
    const before = fetchSpy.mock.calls.length;
    await act(async () => session.switchWorkspace(WS_A));
    await settle();
    expect(fetchSpy.mock.calls.slice(before).map(([url]) => url)).toContain('/api/auth/me');
    expect(session.workspace?.id).toBe(WS_A);
    expect(session.role).toBe('agent');
    expect(session.isAdmin).toBe(false);

    // Back in B, she is then removed from A: her menu still offers it, and the reload moves her back.
    await act(async () => session.switchWorkspace(WS_B));
    await settle();
    me = { user: ana, workspaces: [summary(WS_B)] };
    expect(session.workspaces.map((w) => w.id)).toEqual([WS_A, WS_B]);
    await act(async () => session.switchWorkspace(WS_A));
    await settle();
    expect(session.workspace?.id).toBe(WS_B);
    expect(session.workspaces.map((w) => w.id)).toEqual([WS_B]);
    await act(async () => root.unmount());
  });
});
