import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageBubble } from '../components/inbox/MessageBubble';
import { eventText } from '../components/inbox/ContactPanel';
import { newerStatus, sendProblem, WA_MEDIA_ACCEPT } from '../components/inbox/helpers';
import { recipientDetail } from '../pages/Broadcasts';
import type { ContactEvent, Message } from '../lib/types';

const LOST = 'No pudimos confirmar si WhatsApp recibió el mensaje (falla de red o de Meta). Revisa en unos minutos antes de reenviarlo: podría llegar duplicado.';

function message(patch: Partial<Message>): Message {
  return {
    id: 'm1',
    contact_id: 'c1',
    channel_id: 'ch1',
    direction: 'out',
    type: 'text',
    body: 'Hola',
    media_file_id: null,
    media: null,
    payload: null,
    wamid: null,
    reply_to_wamid: null,
    status: 'sent',
    error: null,
    sent_by: 'user',
    user_id: 'u1',
    broadcast_id: null,
    billing_category: null,
    cost: 0,
    created_at: '2026-10-28T15:00:00Z',
    ...patch,
  };
}

describe("messages whose send outcome is 'unknown'", () => {
  const unknown = message({ status: 'unknown', error: { code: null, title: 'fetch failed', message: LOST } });

  it('show an amber "Sin confirmar" mark and the reason, not a failure', () => {
    const html = renderToStaticMarkup(<MessageBubble m={unknown} senderName="Ana" />);
    expect(html).toContain('Sin confirmar');
    expect(html).toContain('podría llegar duplicado');
    expect(html).toContain('text-amber-500');
    expect(html).not.toContain('Falló');
  });

  it('failed messages keep their red error', () => {
    const html = renderToStaticMarkup(<MessageBubble m={message({ status: 'failed', error: { code: 131026, message: 'El número no tiene WhatsApp' } })} />);
    expect(html).toContain('Falló');
    expect(html).toContain('El número no tiene WhatsApp (código 131026)');
  });

  it('the composer and the template modal warn about them instead of reporting success', () => {
    expect(sendProblem(unknown)).toBe(LOST);
    expect(sendProblem(message({ status: 'unknown' }))).toMatch(/No pudimos confirmar/);
    expect(sendProblem(message({ status: 'failed', error: { message: 'Ventana cerrada' } }))).toBe('Ventana cerrada');
    expect(sendProblem(message({ status: 'sent' }))).toBeNull();
    expect(sendProblem(message({ status: 'pending' }))).toBeNull();
  });

  it('a status webhook can still settle them, and a stale pending never hides them', () => {
    expect(newerStatus('pending', 'unknown')).toBe('unknown');
    expect(newerStatus('unknown', 'pending')).toBe('unknown');
    expect(newerStatus('unknown', 'sent')).toBe('sent');
    expect(newerStatus('unknown', 'delivered')).toBe('delivered');
    expect(newerStatus('unknown', 'failed')).toBe('failed');
    expect(newerStatus('sent', 'unknown')).toBe('sent');
  });
});

describe('the attachment picker offers only what WhatsApp accepts', () => {
  const accept = WA_MEDIA_ACCEPT.split(',');

  it('matches the server allow-list (services/media.ts WA_MEDIA_LIMITS)', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/3gpp', 'audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'application/pdf']) {
      expect(accept).toContain(mime);
    }
    for (const ext of ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt']) expect(accept).toContain(ext);
  });

  it('no longer offers files the server refuses', () => {
    expect(accept).not.toContain('.csv');
    expect(accept).not.toContain('.zip');
    expect(accept).not.toContain('audio/*');
    expect(accept.every((a) => !a.endsWith('/*'))).toBe(true);
  });
});

describe("the contact history explains WhatsApp's changed-number notice", () => {
  const ev = (data: Record<string, unknown>): ContactEvent => ({
    id: 'e1',
    type: 'number_changed',
    data,
    user_id: null,
    user_name: null,
    created_at: '2026-10-28T15:00:00Z',
  });
  const memberName = () => '';

  it('when the contact moved to the new number', () => {
    const text = eventText(
      ev({ old_wa_id: '5215512345678', new_wa_id: '5215587654321', old_phone: '525512345678', new_phone: '525587654321', moved: true, other_contact_id: null }),
      memberName,
    );
    expect(text).toBe('Cambió su número de WhatsApp: +52 55 1234 5678 → +52 55 8765 4321');
  });

  it('when another contact already had the new number', () => {
    const text = eventText(
      ev({ old_wa_id: '573001234567', new_wa_id: '5491112345678', old_phone: '573001234567', new_phone: '5491112345678', moved: false, other_contact_id: 'c2' }),
      memberName,
    );
    expect(text).toBe('Avisó que su nuevo número es +5491112345678 (ya existe otro contacto con ese número)');
  });
});

describe('broadcast recipients waiting after a Meta rate limit', () => {
  it('show the reason as a pending retry, not as a failure', () => {
    expect(recipientDetail({ status: 'queued', error: 'Límite de velocidad alcanzado. Se reintentará.', message_status: null, message_error: null })).toEqual({
      text: 'En espera: Límite de velocidad alcanzado. Se reintentará.',
      tone: 'warning',
    });
    expect(recipientDetail({ status: 'queued', error: null, message_status: null, message_error: null })).toBeNull();
  });

  it('an unconfirmed send is a warning, a rejected one an error', () => {
    expect(recipientDetail({ status: 'sent', error: LOST, message_status: 'unknown', message_error: { message: LOST } })).toEqual({ text: LOST, tone: 'warning' });
    expect(recipientDetail({ status: 'failed', error: 'El número no tiene WhatsApp', message_status: 'failed', message_error: { message: 'El número no tiene WhatsApp' } })).toEqual({
      text: 'El número no tiene WhatsApp',
      tone: 'error',
    });
  });

  it('an unconfirmed send that Meta later confirms drops the old warning', () => {
    // The server clears messages.error when a status webhook settles it, but not broadcast_recipients.error.
    for (const message_status of ['sent', 'delivered', 'read']) {
      expect(recipientDetail({ status: 'sent', error: LOST, message_status, message_error: null })).toBeNull();
    }
  });
});
