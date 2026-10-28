import { describe, expect, it } from 'vitest';
import { countryFromPhone, marketFromPhone, normalizePhone } from '../lib/phone.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { renderPlaceholders, resolveParams, audienceWhere } from '../services/broadcasts.js';
import { isWithinBusinessHours, matchOption, resolveMenu } from '../services/automation.js';
import { buildTemplateComponents, renderTemplateText, templateSchema, variablesIn } from '../services/templates.js';
import { buildCreateComponents } from '../routes/templates.js';
import { normalizeCategory } from '../services/credits.js';
import { parseInboundContent } from '../whatsapp/inbound.js';
import crypto from 'node:crypto';

const contact = { name: 'Ana López', phone: '5215512345678', email: null, company: 'Tacos SA', custom_fields: { ciudad: 'CDMX' } } as any;

describe('phone', () => {
  it('normalizes Mexican numbers and the WhatsApp 521 prefix', () => {
    expect(normalizePhone('55 1234 5678')).toBe('525512345678');
    expect(normalizePhone('+52 1 55 1234 5678')).toBe('525512345678');
    expect(normalizePhone('5215512345678')).toBe('525512345678');
    expect(normalizePhone('0057 300 123 4567')).toBe('573001234567');
    expect(normalizePhone('(305) 555-1234', '1')).toBe('13055551234');
  });
  it('maps phones to pricing markets', () => {
    expect(marketFromPhone('525512345678')).toBe('MX');
    expect(marketFromPhone('573001234567')).toBe('CO');
    expect(marketFromPhone('13055551234')).toBe('NA');
    expect(marketFromPhone('18095551234')).toBe('LATAM');
    expect(countryFromPhone('18095551234')).toBe('DO');
    expect(marketFromPhone('59399123456')).toBe('LATAM');
    expect(marketFromPhone('34612345678')).toBe('ES');
    expect(marketFromPhone('4915112345678')).toBe('OTHER');
  });
});

describe('crypto', () => {
  it('round-trips AES-GCM', () => {
    const key = crypto.randomBytes(32);
    expect(decrypt(key, encrypt(key, 'token-secreto'))).toBe('token-secreto');
  });
});

describe('placeholders', () => {
  it('renders contact data with defaults', () => {
    expect(renderPlaceholders('Hola {primer_nombre}', contact)).toBe('Hola Ana');
    expect(renderPlaceholders('{correo|sin correo}', contact)).toBe('sin correo');
    expect(renderPlaceholders('{campo.ciudad}', contact)).toBe('CDMX');
    expect(renderPlaceholders('{nombre}', { ...contact, name: null })).toBe('cliente');
    expect(renderPlaceholders('{desconocido} ok', contact)).toBe('{desconocido} ok');
    expect(renderPlaceholders('línea1\nlínea2', contact)).toBe('línea1 línea2');
    expect(renderPlaceholders('línea1\nlínea2 {empresa}', contact, false)).toBe('línea1\nlínea2 Tacos SA');
  });
  it('resolves broadcast params per contact', () => {
    const p = resolveParams({ header: { type: 'text', value: '{empresa}' }, body: ['{primer_nombre}', '20%'], buttons: [{ index: 0, value: 'promo' }] }, contact);
    expect(p).toEqual({ header: { type: 'text', text: 'Tacos SA' }, body: ['Ana', '20%'], buttons: [{ index: 0, text: 'promo' }] });
  });
  it('builds audience filters with numbered params', () => {
    const w = audienceWhere({ tag_ids: ['a'], stage_ids: ['b'], exclude_tag_ids: ['c'] });
    expect(w.params).toEqual([['b'], ['a'], ['c']]);
    expect(w.sql).toContain('$2');
    expect(w.sql).toContain('$4');
    expect(w.sql).toContain('NOT c.opted_out');
  });
});

describe('templates', () => {
  const components = [
    { type: 'HEADER', format: 'TEXT', text: 'Hola {{1}}' },
    { type: 'BODY', text: 'Tu pedido {{1}} llega el {{2}}' },
    { type: 'FOOTER', text: 'Gracias' },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Ver', url: 'https://x.com/p/{{1}}' }, { type: 'QUICK_REPLY', text: 'OK' }] },
  ];
  it('extracts variables and schema', () => {
    expect(variablesIn('Hola {{1}} y {{ nombre }}')).toEqual(['1', 'nombre']);
    const s = templateSchema(components);
    expect(s.header).toEqual({ type: 'text', variables: ['1'] });
    expect(s.body).toEqual(['1', '2']);
    expect(s.buttons).toEqual([{ index: 0, type: 'URL', text: 'Ver', variables: ['1'] }]);
  });
  it('builds send components and renders text', () => {
    const params = { header: { type: 'text' as const, text: 'Ana' }, body: ['A-1', 'lunes'], buttons: [{ index: 0, text: 'A-1' }] };
    expect(buildTemplateComponents(params, false, components)).toEqual([
      { type: 'header', parameters: [{ type: 'text', text: 'Ana' }] },
      { type: 'body', parameters: [{ type: 'text', text: 'A-1' }, { type: 'text', text: 'lunes' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'A-1' }] },
    ]);
    expect(renderTemplateText(components, params)).toBe('*Hola Ana*\n\nTu pedido A-1 llega el lunes\n\n_Gracias_\n\n[Ver] [OK]');
  });
  it('uses parameter names for NAMED templates', () => {
    const named = [{ type: 'BODY', text: 'Hola {{nombre}}' }];
    expect(buildTemplateComponents({ body: ['Ana'] }, true, named)).toEqual([
      { type: 'body', parameters: [{ type: 'text', parameter_name: 'nombre', text: 'Ana' }] },
    ]);
  });
  it('builds creation components with examples', () => {
    const r = buildCreateComponents({
      channel_id: '00000000-0000-0000-0000-000000000000',
      name: 'promo',
      language: 'es_MX',
      category: 'MARKETING',
      body: { text: 'Hola {{1}}, tienes {{2}} de descuento', examples: ['Ana', '20%'] },
      footer: 'Baja: responde BAJA',
      buttons: [{ type: 'QUICK_REPLY', text: 'Me interesa' }],
    });
    expect(r.parameter_format).toBe('POSITIONAL');
    expect(r.components[0]).toEqual({ type: 'BODY', text: 'Hola {{1}}, tienes {{2}} de descuento', example: { body_text: [['Ana', '20%']] } });
    expect(() =>
      buildCreateComponents({ channel_id: 'x', name: 'p', language: 'es', category: 'UTILITY', body: { text: 'Hola {{1}}' } } as any),
    ).toThrow(/ejemplo/);
  });
});

describe('automation helpers', () => {
  it('detects business hours in the workspace timezone', () => {
    const hours = { '1': [['09:00', '18:00']] } as Record<string, [string, string][]>;
    // Monday 2026-10-26 16:00 UTC = 10:00 in Mexico City (UTC-6)
    expect(isWithinBusinessHours(hours, 'America/Mexico_City', new Date('2026-10-26T16:00:00Z'))).toBe(true);
    expect(isWithinBusinessHours(hours, 'America/Mexico_City', new Date('2026-10-27T02:00:00Z'))).toBe(false);
    expect(isWithinBusinessHours(hours, 'America/Mexico_City', new Date('2026-10-25T16:00:00Z'))).toBe(false);
  });
  it('matches menu options by key, label and accents', () => {
    const menu = { prompt: 'x', options: [{ key: '1', label: 'Información', submenu: { prompt: 'y', options: [{ key: '1', label: 'Precios' }] } }, { key: '2', label: 'Soporte' }] };
    expect(matchOption(menu, '1')?.label).toBe('Información');
    expect(matchOption(menu, 'informacion')?.key).toBe('1');
    expect(matchOption(menu, ' SOPORTE ')?.key).toBe('2');
    expect(matchOption(menu, 'otro')).toBeNull();
    expect(resolveMenu(menu, ['1']).prompt).toBe('y');
  });
});

describe('inbound parsing', () => {
  it('parses message types', () => {
    expect(parseInboundContent({ type: 'text', text: { body: 'hola' } }).body).toBe('hola');
    const img = parseInboundContent({ type: 'image', image: { id: 'M1', mime_type: 'image/jpeg', caption: 'foto' } });
    expect(img.media).toMatchObject({ wa_media_id: 'M1', mime: 'image/jpeg' });
    expect(img.body).toBe('foto');
    const btn = parseInboundContent({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: '2', title: 'Soporte' } } });
    expect(btn.payload?.reply_id).toBe('2');
    expect(parseInboundContent({ type: 'weird' }).type).toBe('unsupported');
  });
  it('normalizes Meta pricing categories', () => {
    expect(normalizeCategory('marketing_lite')).toBe('marketing');
    expect(normalizeCategory('authentication_international')).toBe('authentication');
    expect(normalizeCategory('referral_conversion')).toBeNull();
  });
});
