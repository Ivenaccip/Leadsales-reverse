import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageBubble } from '../components/inbox/MessageBubble';
import { api, setUnauthorizedHandler } from '../lib/api';
import type { Message } from '../lib/types';

function message(patch: Partial<Message>): Message {
  return {
    id: 'm1',
    contact_id: 'c1',
    channel_id: 'ch1',
    direction: 'in',
    type: 'text',
    body: 'Hola, ¿tienen envíos?',
    media_file_id: null,
    media: null,
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
    ...patch,
  } as Message;
}

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('messages changed in WhatsApp after they arrived', () => {
  it('an edited message says so, with the earlier text at hand', () => {
    const html = renderToStaticMarkup(
      <MessageBubble m={message({ body: 'Hola, ¿tienen envíos a Puebla?', payload: { edited_at: '2026-10-28T15:01:00Z', edits: [{ body: 'Hola, ¿tienen envíos?', until: '2026-10-28T15:01:00Z' }] } })} />,
    );
    expect(html).toContain('Editado');
    expect(html).toContain('Hola, ¿tienen envíos a Puebla?');
    expect(html).toContain('Antes:\nHola, ¿tienen envíos?');
  });

  it('a message the customer deleted is marked, and its text kept for the record', () => {
    const html = renderToStaticMarkup(<MessageBubble m={message({ payload: { deleted_at: '2026-10-28T15:02:00Z' } })} />);
    expect(html).toContain('El cliente eliminó este mensaje');
    expect(html).toContain('Hola, ¿tienen envíos?');
    expect(html).not.toContain('Editado');
  });

  it('a reply deleted from the Business app reads as such', () => {
    const html = renderToStaticMarkup(<MessageBubble m={message({ direction: 'out', sent_by: 'phone', status: 'sent', payload: { deleted_at: '2026-10-28T15:02:00Z' } })} />);
    expect(html).toContain('Mensaje eliminado');
    expect(html).not.toContain('El cliente eliminó');
  });

  it('an ordinary message carries neither mark', () => {
    const html = renderToStaticMarkup(<MessageBubble m={message({})} />);
    expect(html).not.toContain('Editado');
    expect(html).not.toContain('eliminó');
  });
});

describe('a 401 from a request sent with a cookie another tab just replaced (#32)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setUnauthorizedHandler(() => {});
  });

  it('does not sign out while the session the browser holds now is valid', async () => {
    const signedOut = vi.fn();
    setUnauthorizedHandler(signedOut);
    const fetchSpy = vi.fn(async (path: string) =>
      path === '/api/auth/me' ? jsonResponse({ user: { id: 'u1' } }) : jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'Inicia sesión' } }, 401),
    );
    vi.stubGlobal('fetch', fetchSpy);
    await expect(api.get('/api/broadcasts')).rejects.toMatchObject({ status: 401 });
    expect(signedOut).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls.map((c) => c[0])).toEqual(['/api/broadcasts', '/api/auth/me']);
  });

  it('signs out when the session check is refused too', async () => {
    const signedOut = vi.fn();
    setUnauthorizedHandler(signedOut);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'Inicia sesión' } }, 401)));
    await expect(api.post('/api/contacts/c1/messages', { type: 'text', text: 'hola' })).rejects.toMatchObject({ status: 401 });
    expect(signedOut).toHaveBeenCalledTimes(1);
  });

  it('a 401 on the session check itself signs out at once, without asking again', async () => {
    const signedOut = vi.fn();
    setUnauthorizedHandler(signedOut);
    const fetchSpy = vi.fn(async () => jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'Inicia sesión' } }, 401));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(api.get('/api/auth/me')).rejects.toMatchObject({ status: 401 });
    expect(signedOut).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('several refused requests at once ask about the session once', async () => {
    const signedOut = vi.fn();
    setUnauthorizedHandler(signedOut);
    const fetchSpy = vi.fn(async (path: string) =>
      path === '/api/auth/me' ? jsonResponse({ user: { id: 'u1' } }) : jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'Inicia sesión' } }, 401),
    );
    vi.stubGlobal('fetch', fetchSpy);
    await Promise.allSettled([api.get('/api/tags'), api.get('/api/funnels'), api.get('/api/broadcasts')]);
    expect(fetchSpy.mock.calls.filter((c) => c[0] === '/api/auth/me')).toHaveLength(1);
    expect(signedOut).not.toHaveBeenCalled();
  });

  it('a network error during the check is not taken as signed out', async () => {
    const signedOut = vi.fn();
    setUnauthorizedHandler(signedOut);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        if (path === '/api/auth/me') throw new TypeError('Failed to fetch');
        return jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'Inicia sesión' } }, 401);
      }),
    );
    await expect(api.get('/api/broadcasts')).rejects.toMatchObject({ status: 401 });
    expect(signedOut).not.toHaveBeenCalled();
  });
});
