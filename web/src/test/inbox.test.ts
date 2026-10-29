import { afterEach, describe, expect, it } from 'vitest';
import { focusManager, QueryClient, QueryObserver, type QueryObserverOptions } from '@tanstack/react-query';
import { LIVE_QUERY, mediaSendPlan, revokeContact, waTypeForMime, type ConversationsData } from '../components/inbox/helpers';

/** Same defaults as main.tsx. */
function appClient() {
  return new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: false } } });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A chat whose server gets a new message while no component observes the cache. */
async function returnToChat(extra: Partial<QueryObserverOptions<string[]>>) {
  const qc = appClient();
  const server = ['Hola'];
  let fetches = 0;
  const options = {
    queryKey: ['messages', 'A'],
    queryFn: async () => {
      fetches++;
      return [...server];
    },
    ...extra,
  } as QueryObserverOptions<string[]>;

  // Agent opens the chat, then goes to Embudos (the inbox and its socket listeners unmount).
  const first = new QueryObserver(qc, options);
  const unsub = first.subscribe(() => {});
  await tick();
  unsub();
  server.push('¿Me pueden llamar?');

  // Back to the chat a few seconds later.
  const again = new QueryObserver(qc, options);
  const unsub2 = again.subscribe(() => {});
  await tick();
  const shown = qc.getQueryData<string[]>(['messages', 'A']);
  unsub2();
  return { fetches, shown, qc, options };
}

afterEach(() => {
  focusManager.setFocused(undefined);
});

describe('inbox caches refetch when shown again (#82)', () => {
  it('without it, a message that arrived meanwhile stays missing (the reported bug)', async () => {
    const r = await returnToChat({});
    expect(r.fetches).toBe(1);
    expect(r.shown).toEqual(['Hola']);
  });

  it('LIVE_QUERY refetches on mount, so the new message shows', async () => {
    const r = await returnToChat(LIVE_QUERY);
    expect(r.fetches).toBe(2);
    expect(r.shown).toEqual(['Hola', '¿Me pueden llamar?']);
  });

  it('LIVE_QUERY refetches when the window regains focus', async () => {
    const qc = appClient();
    qc.mount(); // what QueryClientProvider does: listen to focus changes
    let fetches = 0;
    const obs = new QueryObserver(qc, { queryKey: ['contact-counts'], queryFn: async () => ++fetches, ...LIVE_QUERY });
    const unsub = obs.subscribe(() => {});
    await tick();
    expect(fetches).toBe(1);
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await tick();
    expect(fetches).toBe(2);
    unsub();
    qc.unmount();
  });
});

describe("'contact:revoked' (contract 3)", () => {
  it('drops the conversation from every list and forgets its detail and messages', () => {
    const qc = appClient();
    const contact = (id: string) => ({ id, last_message_at: '2026-01-01T00:00:00Z' }) as any;
    const list: ConversationsData = { pages: [{ items: [contact('x'), contact('y')], total: 2, page: 1, limit: 30 }], pageParams: [1] };
    qc.setQueryData(['conversations', { inbox: 'all' }], list);
    qc.setQueryData(['conversations', { inbox: 'unassigned' }], list);
    qc.setQueryData(['contact', 'x'], { contact: contact('x') });
    qc.setQueryData(['messages', 'x'], { pages: [], pageParams: [] });
    qc.setQueryData(['contact', 'y'], { contact: contact('y') });

    revokeContact(qc, 'x');

    for (const [, data] of qc.getQueriesData<ConversationsData>({ queryKey: ['conversations'] })) {
      expect(data!.pages[0].items.map((c) => c.id)).toEqual(['y']);
    }
    expect(qc.getQueryData(['contact', 'x'])).toBeUndefined();
    expect(qc.getQueryData(['messages', 'x'])).toBeUndefined();
    expect(qc.getQueryData(['contact', 'y'])).toBeTruthy();
  });
});

describe('composer: text with an attachment (#83, contract 5)', () => {
  it('sends audio and stickers first and the text as its own message', () => {
    expect(mediaSendPlan('m1', 'audio/ogg', 'Te paso el precio: $1,500 MXN')).toEqual([
      { type: 'media', media_file_id: 'm1' },
      { type: 'text', text: 'Te paso el precio: $1,500 MXN' },
    ]);
    expect(mediaSendPlan('m1', 'image/webp', 'Hola')).toEqual([
      { type: 'media', media_file_id: 'm1' },
      { type: 'text', text: 'Hola' },
    ]);
  });

  it('keeps the text as the caption of images, videos and documents', () => {
    expect(mediaSendPlan('m1', 'image/jpeg', 'Precio')).toEqual([{ type: 'media', media_file_id: 'm1', caption: 'Precio' }]);
    expect(mediaSendPlan('m1', 'application/pdf', 'Cotización')).toEqual([{ type: 'media', media_file_id: 'm1', caption: 'Cotización' }]);
  });

  it('never truncates a long text into a caption', () => {
    const long = 'a'.repeat(1500);
    expect(mediaSendPlan('m1', 'image/png', long)).toEqual([
      { type: 'media', media_file_id: 'm1' },
      { type: 'text', text: long },
    ]);
  });

  it('a file alone is a single message', () => {
    expect(mediaSendPlan('m1', 'audio/ogg', '')).toEqual([{ type: 'media', media_file_id: 'm1' }]);
  });

  it('classifies files like the server', () => {
    expect(waTypeForMime('image/webp')).toBe('sticker');
    expect(waTypeForMime('audio/ogg; codecs=opus')).toBe('audio');
    expect(waTypeForMime('image/png')).toBe('image');
    expect(waTypeForMime('video/mp4')).toBe('video');
    expect(waTypeForMime('application/zip')).toBe('document');
  });
});
