import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Channel } from '../lib/types';
import { api, ApiError, errorMessage } from '../lib/api';
import {
  AdminUserRow,
  currentPasswordProblem,
  OperatorRoleModal,
  patchWorkspace,
  setOperatorRights,
  setTemporaryPassword,
  TempPasswordModal,
  WorkspaceWarnings,
  type AdminUser,
} from '../pages/Admin';
import { afterNoChannel, BroadcastNumberField, broadcastChangedMeanwhile, broadcastLostNumber, broadcastSaveBody } from '../pages/Broadcasts';
import { importRequestBody } from '../pages/Contacts';
import { existingTagNotice } from '../components/settings/LibraryTabs';
import { ToastProvider } from '../components/ui';

/** Requests the page sent, with their JSON bodies. */
let sent: { url: string; method: string; body: any }[];

/** Answers every request with `status` and the JSON `body`. */
function answer(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
}

async function refusal(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('the request was not refused');
}

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function withProviders(node: ReactNode) {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(ToastProvider, null, node)));
}

// ------------------------------------------------------------------ Administración → Usuarios

describe('operator rights and temporary passwords ask for the current password', () => {
  const bea: AdminUser = {
    id: 'u-2',
    email: 'bea@x.com',
    name: 'Bea',
    is_superadmin: false,
    created_at: '2026-10-01T00:00:00Z',
    workspaces: 1,
    workspace_names: 'Tienda A',
  };

  it('both requests carry it, with the field names the server reads', async () => {
    answer(200, { ok: true });
    await setOperatorRights('u-2', true, 'mi clave');
    await setTemporaryPassword('u-2', 'Temporal2345', 'mi clave');
    expect(sent).toEqual([
      { url: '/api/admin/users/u-2', method: 'PATCH', body: { is_superadmin: true, currentPassword: 'mi clave' } },
      { url: '/api/admin/users/u-2/password', method: 'POST', body: { password: 'Temporal2345', currentPassword: 'mi clave' } },
    ]);
  });

  it("a wrong password or too many attempts is shown by the field with the server's message; other refusals are not", async () => {
    answer(400, { error: { code: 'WRONG_PASSWORD', message: 'La contraseña actual no es correcta' } });
    expect(currentPasswordProblem(await refusal(setOperatorRights('u-2', false, 'otra')))).toBe('La contraseña actual no es correcta');
    answer(429, { error: { code: 'TOO_MANY_REQUESTS', message: 'Demasiados intentos. Espera unos minutos.' } });
    expect(currentPasswordProblem(await refusal(setTemporaryPassword('u-2', 'Temporal2345', 'otra')))).toBe('Demasiados intentos. Espera unos minutos.');
    // E.g. the account became an operator meanwhile: a toast with the server's text, not the field.
    const msg = 'La contraseña de un administrador de la instancia solo la cambia su dueño, desde su perfil';
    answer(400, { error: { code: 'BAD_REQUEST', message: msg } });
    const other = await refusal(setTemporaryPassword('u-2', 'Temporal2345', 'mi clave'));
    expect(currentPasswordProblem(other)).toBeNull();
    expect(errorMessage(other)).toBe(msg);
    expect(currentPasswordProblem(new Error('Failed to fetch'))).toBeNull();
  });

  it('the role dialog says what changes and cannot be sent without the password', () => {
    const promote = withProviders(<OperatorRoleModal u={bea} onClose={() => {}} />);
    expect(promote).toContain('Hacer administrador de la instancia');
    expect(promote).toContain('Tu contraseña actual');
    expect(promote).toMatch(/<input[^>]*type="password"[^>]*autoComplete="current-password"|<input[^>]*autocomplete="current-password"[^>]*type="password"/i);
    expect(promote).toMatch(/<button[^>]*disabled=""[^>]*>Hacer administrador<\/button>/);
    const demote = withProviders(<OperatorRoleModal u={{ ...bea, is_superadmin: true }} onClose={() => {}} />);
    expect(demote).toContain('Quitar rol de administrador');
    expect(demote).toMatch(/<button[^>]*disabled=""[^>]*>Quitar rol<\/button>/);
  });

  it('the temporary password dialog asks for it too', () => {
    const html = withProviders(<TempPasswordModal u={bea} onClose={() => {}} />);
    expect(html).toContain('Contraseña temporal');
    expect(html).toContain('Tu contraseña actual');
    // A temporary password is already suggested: only the operator's own password is missing.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Guardar contraseña<\/button>/);
  });

  it('the toggle of the row is still there (it opens the dialog)', () => {
    const html = renderToStaticMarkup(<AdminUserRow u={bea} meId="u-op" onToggleSuper={() => {}} onPassword={() => {}} onDelete={() => {}} />);
    expect(html).toContain('role="switch"');
    expect(html).toContain('Administrador de la instancia');
  });
});

// ------------------------------------------------------------------ Administración → Espacios

describe('a workspace switched to prepaid reports the numbers whose templates could not be re-read', () => {
  const warning = 'No se pudieron sincronizar las plantillas de +52 55 1111 2222: El token de acceso venció';

  it('PATCH answers { workspace, warnings }: the warnings are kept for the notice', async () => {
    answer(200, { workspace: { id: 'w1', billing_mode: 'prepaid' }, warnings: [warning] });
    expect(await patchWorkspace('w1', { billing_mode: 'prepaid' })).toEqual([warning]);
    expect(sent[0]).toEqual({ url: '/api/admin/workspaces/w1', method: 'PATCH', body: { billing_mode: 'prepaid' } });
    answer(200, { workspace: { id: 'w1', is_active: false }, warnings: [] });
    expect(await patchWorkspace('w1', { is_active: false })).toEqual([]);
    // An answer without the field (an older server) shows nothing.
    answer(200, { workspace: { id: 'w1' } });
    expect(await patchWorkspace('w1', { is_active: true })).toEqual([]);
  });

  it('the notice shows each warning and how to fix it', () => {
    const html = renderToStaticMarkup(<WorkspaceWarnings warnings={[warning]} />);
    expect(html).toContain(warning);
    expect(html).toContain('Sincronizar con Meta');
  });
});

// ------------------------------------------------------------------ paused broadcast without its number

describe('a paused broadcast whose number was deleted gets a number chosen again (NO_CHANNEL)', () => {
  const fields = {
    name: 'Promo',
    channelId: 'ch-b',
    template: { name: 'promo_octubre', language: 'es_MX' },
    params: { body: ['{primer_nombre}'] },
    audience: { tag_ids: ['t1'] },
    scheduledAt: null,
  };
  const channel = (id: string, extra: Partial<Channel> = {}) =>
    ({ id, name: `Línea ${id}`, display_phone: `+52 55 0000 ${id.slice(-1)}`, status: 'active', is_default: false, ...extra }) as Channel;
  const render = (props: Partial<Parameters<typeof BroadcastNumberField>[0]>) =>
    renderToStaticMarkup(<BroadcastNumberField channels={[channel('ch-b')]} value="ch-b" onChange={() => {}} paused={false} numberGone={false} {...props} />);

  it('only a broadcast without channel_id lost its number', () => {
    expect(broadcastLostNumber({ channel_id: null })).toBe(true);
    expect(broadcastLostNumber({ channel_id: 'ch-a' })).toBe(false);
    expect(broadcastLostNumber(undefined)).toBe(false); // a new broadcast
  });

  it('the save body of such a paused broadcast names the number; otherwise a paused one still never does', () => {
    expect(broadcastSaveBody('paused', fields, true)).toEqual({
      name: 'Promo',
      template_name: 'promo_octubre',
      template_language: 'es_MX',
      params: { body: ['{primer_nombre}'] },
      channel_id: 'ch-b',
    });
    // Still no audience (AUDIENCE_LOCKED) nor schedule.
    expect(broadcastSaveBody('paused', fields, true)).not.toHaveProperty('audience');
    expect(broadcastSaveBody('paused', fields)).not.toHaveProperty('channel_id');
    // No number left to choose: nothing is invented, the server answers NO_CHANNEL with its message.
    expect(broadcastSaveBody('paused', { ...fields, channelId: '' }, true)).toMatchObject({ channel_id: undefined });
    expect(broadcastSaveBody('draft', fields, true)).toMatchObject({ channel_id: 'ch-b', audience: { tag_ids: ['t1'] } });
  });

  it("the 'Número que envía' selector shows up even with a single number, and is not locked", () => {
    expect(render({})).toBe('');
    const single = render({ paused: true, numberGone: true });
    expect(single).toContain('Número que envía');
    expect(single).toContain('Línea ch-b');
    expect(single).toContain('elige el que la enviará');
    expect(single).not.toMatch(/<select[^>]*disabled=""/);
    const two = [channel('ch-b'), channel('ch-c')];
    // A paused broadcast that kept its number keeps it.
    expect(render({ channels: two, paused: true })).toMatch(/<select[^>]*disabled=""/);
    expect(render({ channels: two, paused: true, numberGone: true })).not.toMatch(/<select[^>]*disabled=""/);
    expect(render({ channels: two })).not.toMatch(/<select[^>]*disabled=""/);
    // No number at all: nothing to choose from (the page says to connect one).
    expect(render({ channels: [], numberGone: true })).toBe('');
  });

  it("NO_CHANNEL shows the server's message; the editor reloads only if the broadcast lost its number meanwhile", async () => {
    const msg = 'Se eliminó el número de WhatsApp de esta difusión. Edítala, elige otro número y vuelve a enviarla o reanúdala.';
    answer(400, { error: { code: 'NO_CHANNEL', message: msg } });
    const err = await refusal(api.post('/api/broadcasts/b1/launch'));
    expect(errorMessage(err)).toBe(msg);
    // Not a state change: a disabled number (or none left) must not throw away the edits.
    expect(broadcastChangedMeanwhile(err)).toBe(false);
    const list = [channel('ch-b'), channel('ch-c')];
    const paused = { status: 'paused' as const, channel_id: 'ch-a' };
    // Its own number was deleted while it was being edited: reload, and choose a number again.
    expect(afterNoChannel(paused, { ...paused, channel_id: null }, 'ch-a', list)).toEqual({ reload: true, resetNumber: true });
    // A draft saved with a number disabled since: the edits stay, as does the number (shown disabled).
    const draft = { status: 'draft' as const, channel_id: 'ch-b' };
    expect(afterNoChannel(draft, draft, 'ch-b', list)).toEqual({ reload: false, resetNumber: false });
    // A number picked in the editor and deleted since: back to the default one, the edits stay.
    expect(afterNoChannel(draft, draft, 'ch-z', list)).toEqual({ reload: false, resetNumber: true });
    // Already without a number (chosen again here): nothing to reload either.
    const gone = { status: 'paused' as const, channel_id: null };
    expect(afterNoChannel(gone, gone, '', list)).toEqual({ reload: false, resetNumber: false });
    // Launched or resumed elsewhere: reload, like BROADCAST_CHANGED.
    expect(afterNoChannel(draft, { ...draft, status: 'running' }, 'ch-b', list).reload).toBe(true);
    expect(afterNoChannel(undefined, draft, 'ch-b', list).reload).toBe(false);
  });
});

// ------------------------------------------------------------------ tags

describe('creating a tag whose name exists says so instead of a silent success', () => {
  const vip = { id: 't-vip', name: 'VIP', color: '#ef4444' };

  it('a new tag says nothing', () => {
    expect(existingTagNotice({ id: 't-new', name: 'Expo', color: '#0ea5e9' }, [vip], '#0ea5e9', false)).toBeNull();
    expect(existingTagNotice({ id: 't-new', name: 'Expo', color: '#0EA5E9' }, undefined, '#0ea5e9', false)).toBeNull();
  });

  it('an existing one: its color did not change, and who can change it', () => {
    const agent = existingTagNotice(vip, [vip], '#0ea5e9', false);
    expect(agent).toContain('Ya existe la etiqueta “VIP”');
    expect(agent).toContain('su color no cambió');
    expect(agent).toContain('Solo un administrador puede cambiar su color.');
    expect(existingTagNotice(vip, [vip], '#0ea5e9', true)).toContain('edítala desde la lista');
    // Same color asked for: it still existed.
    expect(existingTagNotice(vip, [vip], '#ef4444', false)).toContain('Ya existe la etiqueta “VIP”');
  });

  it('a list loaded before someone else created it still tells by the color that came back', () => {
    expect(existingTagNotice(vip, [], '#0ea5e9', false)).toContain('Ya existe la etiqueta “VIP”');
  });
});

// ------------------------------------------------------------------ CSV import

describe('a CSV with too many columns', () => {
  it("shows the server's reason (CSV_TOO_MANY_COLUMNS) like any refused import", async () => {
    const msg = 'El archivo tiene demasiadas columnas (máximo 200)';
    answer(400, { error: { code: 'CSV_TOO_MANY_COLUMNS', message: msg } });
    const err = await refusal(api.post('/api/contacts/import', importRequestBody('a,b,c\n1,2,3', false, null, [])));
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).code).toBe('CSV_TOO_MANY_COLUMNS');
    expect(errorMessage(err)).toBe(msg);
  });
});
