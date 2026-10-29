import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  canManageCloudChannels,
  channelPatch,
  channelSaveNotice,
  ChannelSavedNotice,
  needsOperatorVerification,
  PrepaidVerificationNote,
  verificationGap,
} from '../components/settings/ChannelsTab';
import { isInviteResult, memberRequestBody } from '../components/settings/TeamTab';
import { ScheduledList } from '../components/inbox/ContactPanel';
import { invitationStep } from '../pages/Invitation';
import type { Channel, ScheduledMessage } from '../lib/types';

const cloud: Channel = {
  id: 'ch1',
  provider: 'cloud_api',
  name: 'Ventas',
  display_phone: '+52 55 1234 5678',
  phone_number_id: '1098765',
  waba_id: '8777777777777',
  verify_token: 'x',
  status: 'active',
  last_error: null,
  is_default: true,
  has_access_token: true,
  has_app_secret: true,
  operator_verified: false,
  webhook_url: 'https://x/webhooks/whatsapp',
  created_at: '2026-01-01T00:00:00Z',
};
const form = (patch: Partial<{ name: string; waba_id: string; access_token: string; app_secret: string }> = {}) => ({
  name: cloud.name,
  waba_id: cloud.waba_id ?? '',
  access_token: '',
  app_secret: '',
  ...patch,
});

describe('edit channel sends only what changed (#41)', () => {
  it('a rename does not resend the unchanged WABA ID', () => {
    expect(channelPatch(cloud, form({ name: 'Ventas MX' }))).toEqual({ name: 'Ventas MX' });
  });

  it('nothing changed, nothing sent', () => {
    expect(channelPatch(cloud, form())).toEqual({});
  });

  it('a new WABA ID or new credentials are sent', () => {
    expect(channelPatch(cloud, form({ waba_id: '9999999999' }))).toEqual({ waba_id: '9999999999' });
    expect(channelPatch(cloud, form({ access_token: ' EAAG-token ' }))).toEqual({ access_token: 'EAAG-token' });
  });

  it('sandbox channels never send cloud fields', () => {
    expect(channelPatch({ ...cloud, provider: 'sandbox', waba_id: null }, form({ waba_id: '123456' }))).toEqual({});
  });
});

describe('prepaid workspaces: who connects official numbers (#65)', () => {
  it('only the instance operator in prepaid mode', () => {
    expect(canManageCloudChannels('prepaid', false)).toBe(false);
    expect(canManageCloudChannels('prepaid', true)).toBe(true);
    expect(canManageCloudChannels('meta_direct', false)).toBe(true);
    expect(canManageCloudChannels(undefined, false)).toBe(true);
  });
});

describe('re-verifying a number disabled by the switch to prepaid', () => {
  const disabled: Channel = { ...cloud, status: 'disabled', operator_verified: false };

  it('only unverified cloud numbers of prepaid workspaces need the operator', () => {
    expect(needsOperatorVerification(disabled, 'prepaid')).toBe(true);
    expect(needsOperatorVerification({ ...disabled, operator_verified: true }, 'prepaid')).toBe(false);
    expect(needsOperatorVerification(disabled, 'meta_direct')).toBe(false);
    expect(needsOperatorVerification({ ...disabled, provider: 'sandbox' }, 'prepaid')).toBe(false);
  });

  it('asks for both the token and a new App Secret, never one of them alone', () => {
    expect(verificationGap(disabled, 'prepaid', form({ access_token: 'EAAG-operator-token-123456' }))).toMatch(/App Secret/);
    expect(verificationGap(disabled, 'prepaid', form({ app_secret: 'operator-secret-123456' }))).toMatch(/token de acceso/);
    expect(verificationGap(disabled, 'prepaid', form({ access_token: 'EAAG-operator-token-123456', app_secret: 'operator-secret-123456' }))).toBeNull();
    // A rename needs neither; outside prepaid nothing is required.
    expect(verificationGap(disabled, 'prepaid', form({ name: 'Ventas 2' }))).toBeNull();
    expect(verificationGap(disabled, 'meta_direct', form({ access_token: 'EAAG-operator-token-123456' }))).toBeNull();
  });

  it('PATCH warnings are shown like on connect, and a newly verified number gets its webhook data', () => {
    const warning = 'No se pudo suscribir la app a la WABA: (#200) Permissions error';
    const notice = channelSaveNotice(disabled, { channel: { ...disabled, status: 'active', operator_verified: true }, warnings: [warning] });
    expect(notice).toMatchObject({ verified: true, warnings: [warning] });
    const html = renderToStaticMarkup(<ChannelSavedNotice notice={notice!} />);
    expect(html).toContain('Número verificado y activado');
    expect(html).toContain('(#200) Permissions error');
    expect(html).toContain('https://x/webhooks/whatsapp');

    // Warnings alone are still shown; a plain rename closes with a toast.
    expect(channelSaveNotice(cloud, { channel: cloud, warnings: [warning] })).toMatchObject({ verified: false, warnings: [warning] });
    expect(channelSaveNotice(cloud, { channel: { ...cloud, name: 'Otro' }, warnings: [] })).toBeNull();
    expect(channelSaveNotice(cloud, { channel: cloud })).toBeNull();
  });

  it('the note says both credentials must come from the operator own Meta app', () => {
    const html = renderToStaticMarkup(<PrepaidVerificationNote />);
    expect(html).toContain('tu propia app de Meta');
    expect(html).toContain('token de acceso');
    expect(html).toContain('App Secret');
    expect(html).toContain('nueva');
  });
});

describe('invitations (contract 7)', () => {
  it('a workspace admin never sends a password; the operator may', () => {
    const f = { name: ' Ana ', email: ' ana@x.com ', password: 'secreta123', role: 'agent' as const };
    expect(memberRequestBody(f, false)).toEqual({ email: 'ana@x.com', role: 'agent', name: 'Ana' });
    expect(memberRequestBody(f, true)).toEqual({ email: 'ana@x.com', role: 'agent', name: 'Ana', password: 'secreta123' });
    expect(memberRequestBody({ ...f, name: '' }, false)).toEqual({ email: 'ana@x.com', role: 'agent' });
  });

  it('tells an invitation link from a directly created account', () => {
    expect(isInviteResult({ invitation: { id: 'i', email: 'a@x.com', role: 'agent', expires_at: '' }, invite_url: 'https://x/invitacion/t' })).toBe(true);
    expect(isInviteResult({ id: 'u', existing_user: false })).toBe(false);
  });

  it('the invitation page asks for the right step', () => {
    const inv = { email: 'Ana@X.com' };
    // The preview no longer says whether the account exists: register (with a login link) first.
    expect(invitationStep(inv, null)).toBe('register');
    expect(invitationStep(inv, null, true)).toBe('login');
    expect(invitationStep(inv, { email: 'ana@x.com' })).toBe('accept');
    expect(invitationStep(inv, { email: 'otro@x.com' })).toBe('switch_account');
  });
});

describe('failed scheduled messages stay visible (#86, contract 4)', () => {
  const base = { contact_id: 'c1', send_at: '2026-10-28T15:00:00Z', created_by_name: null } as const;
  const items: ScheduledMessage[] = [
    { ...base, id: 's1', content: { type: 'text', text: 'Seguimiento' }, status: 'failed', error: 'Pasaron más de 24 horas desde el último mensaje del cliente' },
    { ...base, id: 's2', content: { type: 'template', name: 'recordatorio', language: 'es_MX' }, status: 'pending', error: null },
  ];

  it('shows the failure with its reason and a dismiss action, pending ones can be cancelled', () => {
    const html = renderToStaticMarkup(<ScheduledList items={items} onCancel={() => {}} onDismiss={() => {}} />);
    expect(html).toContain('No se envió');
    expect(html).toContain('Pasaron más de 24 horas');
    expect(html).toContain('Descartar aviso');
    expect(html).toContain('Cancelar envío');
    expect(html).toContain('Plantilla recordatorio');
  });
});
