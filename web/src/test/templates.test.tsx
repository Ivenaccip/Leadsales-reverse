import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  emptyTemplateValue,
  fromBroadcastParams,
  isTemplateValueComplete,
  locationParam,
  TemplateForm,
  templateButtonInputs,
  templateButtons,
  templateText,
  templateUnsupportedReason,
  toBroadcastParams,
  toTemplateParams,
} from '../components/TemplateForm';
import type { Template } from '../lib/types';
import { AUTH_DEFAULTS, authPreviewComponents, authTemplateFields } from '../pages/Templates';

function template(components: any[], inputs: Partial<Template['inputs']> = {}): Template {
  return {
    id: 't1',
    channel_id: 'c1',
    meta_id: null,
    name: 'sucursal',
    language: 'es_MX',
    category: 'utility',
    status: 'APPROVED',
    components,
    parameter_format: 'POSITIONAL',
    rejected_reason: null,
    updated_at: '2026-01-01T00:00:00Z',
    inputs: { header: null, body: [], buttons: [], ...inputs },
  };
}

const locationTpl = template([{ type: 'HEADER', format: 'LOCATION' }, { type: 'BODY', text: 'Te esperamos, {{1}}' }], {
  header: { type: 'location', variables: [] },
  body: ['1'],
});

describe('LOCATION header templates (#66)', () => {
  it('are not complete until a valid latitude and longitude are given', () => {
    const v = emptyTemplateValue(locationTpl);
    v.body = ['Ana'];
    expect(isTemplateValueComplete(locationTpl, v)).toBe(false);
    v.location = { latitude: '19.4326', longitude: '', name: '', address: '' };
    expect(isTemplateValueComplete(locationTpl, v)).toBe(false);
    v.location = { latitude: '100', longitude: '-99.1332', name: '', address: '' };
    expect(isTemplateValueComplete(locationTpl, v)).toBe(false);
    v.location = { latitude: '19,4326', longitude: '-99.1332', name: '', address: '' };
    expect(isTemplateValueComplete(locationTpl, v)).toBe(true);
  });

  it('send the location as the header parameter', () => {
    const v = { ...emptyTemplateValue(locationTpl), body: ['Ana'], location: { latitude: '19.4326', longitude: '-99.1332', name: ' Sucursal Centro ', address: '' } };
    expect(toTemplateParams(locationTpl, v)).toEqual({
      header: { type: 'location', latitude: 19.4326, longitude: -99.1332, name: 'Sucursal Centro' },
      body: ['Ana'],
    });
    const b = toBroadcastParams(locationTpl, v);
    expect(b.header).toEqual({ type: 'location', latitude: 19.4326, longitude: -99.1332, name: 'Sucursal Centro' });
    // A saved draft loads back into the form.
    expect(fromBroadcastParams(locationTpl, b).location).toEqual({ latitude: '19.4326', longitude: '-99.1332', name: 'Sucursal Centro', address: '' });
  });

  it('show inputs for the place instead of "no variables"', () => {
    const html = renderToStaticMarkup(<TemplateForm template={locationTpl} value={emptyTemplateValue(locationTpl)} onChange={() => {}} />);
    expect(html).toContain('Latitud');
    expect(html).toContain('Longitud');
    expect(html).not.toContain('no tiene variables');
  });

  it('locationParam rejects out-of-range or non-numeric coordinates', () => {
    expect(locationParam({ latitude: 'abc', longitude: '1', name: '', address: '' })).toBeNull();
    expect(locationParam({ latitude: '1', longitude: '181', name: '', address: '' })).toBeNull();
    expect(locationParam({ latitude: '-33.45', longitude: '-70.66', name: '', address: 'Santiago' })).toEqual({
      type: 'location',
      latitude: -33.45,
      longitude: -70.66,
      address: 'Santiago',
    });
  });
});

describe('COPY_CODE buttons (#66)', () => {
  const coupon = template([
    { type: 'BODY', text: 'Usa tu cupón' },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'No gracias' }, { type: 'COPY_CODE', example: 'BUENFIN' }] },
  ]);

  it('ask for the coupon even when the server lists no inputs', () => {
    expect(templateButtonInputs(coupon)).toEqual([{ index: 1, text: 'Copiar código', kind: 'copy_code' }]);
    const v = emptyTemplateValue(coupon);
    expect(isTemplateValueComplete(coupon, v)).toBe(false);
    v.buttons[1] = 'CUPONDEMASIADOLARGO';
    expect(isTemplateValueComplete(coupon, v)).toBe(false);
    v.buttons[1] = 'BUENFIN25';
    expect(isTemplateValueComplete(coupon, v)).toBe(true);
    const html = renderToStaticMarkup(<TemplateForm template={coupon} value={v} onChange={() => {}} />);
    expect(html).toContain('código del cupón');
  });

  it('send it as a copy_code button parameter', () => {
    const v = { ...emptyTemplateValue(coupon), buttons: { 1: 'BUENFIN25' } };
    expect(toTemplateParams(coupon, v).buttons).toEqual([{ index: 1, text: 'BUENFIN25', sub_type: 'copy_code' }]);
    expect(toBroadcastParams(coupon, v).buttons).toEqual([{ index: 1, value: 'BUENFIN25', sub_type: 'copy_code' }]);
  });

  it('keep URL buttons as before', () => {
    const url = template([{ type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Ver pedido', url: 'https://x.com/{{1}}' }] }], {
      buttons: [{ index: 0, type: 'URL', text: 'Ver pedido', variables: ['1'] }],
    });
    expect(toTemplateParams(url, { ...emptyTemplateValue(url), buttons: { 0: 'abc' } }).buttons).toEqual([{ index: 0, text: 'abc' }]);
  });
});

describe('carousel templates (#66)', () => {
  const carousel = template([{ type: 'BODY', text: 'Mira' }, { type: 'CAROUSEL', cards: [] }]);

  it('are marked as not supported and can never be sent', () => {
    expect(templateUnsupportedReason(carousel)).toBeTruthy();
    expect(isTemplateValueComplete(carousel, emptyTemplateValue(carousel))).toBe(false);
    const html = renderToStaticMarkup(<TemplateForm template={carousel} value={emptyTemplateValue(carousel)} onChange={() => {}} />);
    expect(html).toContain('no compatible');
    expect(templateUnsupportedReason(locationTpl)).toBeNull();
  });

  it('the server reason wins when it gives one', () => {
    const lto = template([{ type: 'BODY', text: 'Oferta' }], { unsupported: 'Esta plantilla usa una oferta con vencimiento' });
    expect(templateUnsupportedReason(lto)).toBe('Esta plantilla usa una oferta con vencimiento');
    expect(isTemplateValueComplete(lto, emptyTemplateValue(lto))).toBe(false);
  });

  it('copy-code buttons listed by the server are recognized', () => {
    const coupon = template([{ type: 'BUTTONS', buttons: [{ type: 'COPY_CODE' }] }], {
      buttons: [{ index: 0, type: 'COPY_CODE', text: 'Copiar código', variables: ['coupon_code'] }],
    });
    expect(templateButtonInputs(coupon)).toEqual([{ index: 0, text: 'Copiar código', kind: 'copy_code' }]);
  });
});

describe('creating authentication templates', () => {
  it('sends only the OTP options: Meta writes header, body, footer and buttons itself', () => {
    expect(authTemplateFields(AUTH_DEFAULTS)).toEqual({ security_recommendation: true });
    expect(authTemplateFields({ security_recommendation: false, code_expiration_minutes: '10', otp_button_text: ' Copiar ' })).toEqual({
      security_recommendation: false,
      code_expiration_minutes: 10,
      otp_button_text: 'Copiar',
    });
  });

  it('refuses an expiration outside 1-90 minutes or a button label over 25 characters', () => {
    expect(authTemplateFields({ ...AUTH_DEFAULTS, code_expiration_minutes: '0' })).toBeNull();
    expect(authTemplateFields({ ...AUTH_DEFAULTS, code_expiration_minutes: '91' })).toBeNull();
    expect(authTemplateFields({ ...AUTH_DEFAULTS, code_expiration_minutes: '1.5' })).toBeNull();
    expect(authTemplateFields({ ...AUTH_DEFAULTS, code_expiration_minutes: '90' })).toEqual({ security_recommendation: true, code_expiration_minutes: 90 });
    expect(authTemplateFields({ ...AUTH_DEFAULTS, otp_button_text: 'x'.repeat(26) })).toBeNull();
  });

  it('previews the text Meta will send', () => {
    const tpl = template(authPreviewComponents({ security_recommendation: true, code_expiration_minutes: '10', otp_button_text: '' }));
    const text = templateText(tpl, emptyTemplateValue(tpl));
    expect(text).toContain('es tu código de verificación. Por tu seguridad, no lo compartas.');
    expect(text).toContain('Este código caduca en 10 minutos.');
    expect(templateButtons(tpl)).toEqual(['Copiar código']);

    const plain = template(authPreviewComponents({ security_recommendation: false, code_expiration_minutes: '', otp_button_text: 'Copiar' }));
    expect(templateText(plain, emptyTemplateValue(plain))).not.toMatch(/seguridad|caduca/);
    expect(templateButtons(plain)).toEqual(['Copiar']);
  });
});
