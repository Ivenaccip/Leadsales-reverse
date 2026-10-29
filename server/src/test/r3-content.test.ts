import { parse as parseCsv } from 'csv-parse/sync';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { csvCell, legacyTagIndex, splitTagCell, uncsvCell } from '../routes/contacts.js';
import { buildCreateComponents } from '../routes/templates.js';
import { dayStart } from '../services/reports.js';
import { buildTemplateComponents, renderTemplateText, templateSchema, variablesIn } from '../services/templates.js';
import { SandboxProvider } from '../whatsapp/sandbox.js';
import { MetaApiError } from '../whatsapp/types.js';
import { setup, type TestEnv } from './helpers.js';

let env: TestEnv;
let ws: string;
let channel: any;
let apiKey: string;
let seq = 0;

const q = (sql: string, params: unknown[] = []) => env.built.ctx.db.query<any>(sql, params);
const asKey = () => ({ cookie: '', ws: null, headers: { authorization: `Bearer ${apiKey}` } });

/** A fresh workspace (owner session) for checks that need their own data. */
async function freshWorkspace(name: string) {
  const r = await env.register(undefined, name);
  return { cookie: r.cookie, ws: r.workspaceId };
}

async function contact(phone: string, extra: Record<string, unknown> = {}, opts: { cookie?: string; ws?: string } = {}) {
  const r = await env.api('POST', '/api/contacts', { phone, ...extra }, opts);
  expect(r.status).toBe(200);
  return r.body.contact;
}

async function tagNames(workspaceId: string): Promise<string[]> {
  return (await q(`SELECT name FROM tags WHERE workspace_id = $1 ORDER BY name`, [workspaceId])).rows.map((r: any) => r.name);
}

async function contactTags(contactId: string): Promise<string[]> {
  const { rows } = await q(`SELECT t.name FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = $1 ORDER BY t.name`, [contactId]);
  return rows.map((r: any) => r.name);
}

beforeAll(async () => {
  env = await setup();
  ws = (await env.register('r3-content@test.com', 'Contenido R3')).workspaceId;
  channel = (await env.api('POST', '/api/channels', { provider: 'sandbox', name: 'S' })).body.channel;
  apiKey = (await env.api('POST', '/api/api-keys', { name: 'Zapier' })).body.key;
});
afterAll(() => env.close());
afterEach(() => vi.restoreAllMocks());

describe('older messages page by a full-precision keyset (#3)', () => {
  it('pages through messages that share a millisecond or the exact same time', async () => {
    const c = await contact('5512340300');
    // One webhook with three messages (1 µs apart) and a late redelivery that ties exactly.
    const times = ['2026-01-01T00:00:00.238000Z', '2026-01-01T00:00:00.238001Z', '2026-01-01T00:00:00.238002Z', '2026-01-01T00:00:00.238002Z'];
    for (const [i, t] of times.entries()) {
      await q(`INSERT INTO messages (workspace_id, contact_id, direction, type, body, status, created_at) VALUES ($1, $2, 'in', 'text', $3, 'received', $4)`, [
        ws,
        c.id,
        `m${i}`,
        t,
      ]);
    }
    const seen: string[] = [];
    let beforeId: string | null = null;
    for (let page = 0; page < 6; page++) {
      const r = await env.api('GET', `/api/contacts/${c.id}/messages?limit=1${beforeId ? `&before_id=${beforeId}` : ''}`);
      expect(r.status).toBe(200);
      if (!r.body.messages.length) break;
      seen.push(r.body.messages[0].body);
      beforeId = r.body.messages[0].id;
      if (!r.body.has_more) break;
    }
    expect(seen.slice().sort()).toEqual(['m0', 'm1', 'm2', 'm3']);
    expect(seen.slice(2)).toEqual(['m1', 'm0']);
    // A whole page comes back oldest first, in the same order.
    const all = await env.api('GET', `/api/contacts/${c.id}/messages?limit=10`);
    expect(all.body.messages.map((m: any) => m.body)).toEqual(seen.slice().reverse());
    // The old timestamp cursor keeps working.
    const older = await env.api('GET', `/api/contacts/${c.id}/messages?before=${encodeURIComponent('2026-01-01T00:00:00.239Z')}`);
    expect(older.body.messages).toHaveLength(4);
  });
});

describe('CSV export → import round trip (#4, #16, #34, #56, #57)', () => {
  it('undoes every formula guard the export adds, not only the first one', () => {
    for (const v of ['=1+1', 'Cliente;@ventas;+VIP;-10%', 'Pérez, -Hnos', 'a\n+1', 'x,\t@y', '\t=x', 'a; "-2+3', '\tabc', 'juan@x.com', "O'Reilly", 'normal']) {
      expect(uncsvCell(csvCell(v)), JSON.stringify(v)).toBe(v);
    }
    expect(csvCell('Cliente;@ventas')).toBe("Cliente;'@ventas");
  });

  it('runs the formula guard in linear time on long runs of tabs or line breaks', () => {
    const start = performance.now();
    const out = csvCell(`Ana${'\t'.repeat(100_000)}Lopez`);
    csvCell(`vip${'\n'.repeat(100_000)}x`);
    uncsvCell(`vip${'\t'.repeat(100_000)}x`);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(out).toBe(`Ana${'\t'.repeat(100_000)}Lopez`);
    expect(csvCell('a;\t=b')).toBe("a;\t'=b");
  });

  it('brings tags starting with = + - @ and values with a guarded segment back unchanged', async () => {
    const names = ['Cliente', '@ventas', '+VIP', '-10%'];
    const ids = [];
    for (const name of names) ids.push((await env.api('POST', '/api/tags', { name })).body.tag.id);
    const c = await contact('5512340401', { name: 'Ana Ruiz', company: 'Pérez, -Hnos', tag_ids: ids });
    const exp = await env.api('GET', '/api/contacts/export.csv');
    const row = (parseCsv(exp.raw.replace(/^﻿/, ''), { columns: true }) as Record<string, string>[]).find((r) => r.telefono.endsWith('5512340401'))!;
    expect(row.empresa).toBe("Pérez, '-Hnos");

    // Into another workspace (migration or restore): same tags, same company.
    const other = await freshWorkspace('Destino');
    const imp = await env.api('POST', '/api/contacts/import', { csv: exp.raw }, other);
    expect(imp.status).toBe(200);
    expect(imp.body.error_count).toBe(0);
    const copy = (await q(`SELECT id, company FROM contacts WHERE workspace_id = $1 AND phone = $2`, [other.ws, c.phone])).rows[0];
    expect(copy.company).toBe('Pérez, -Hnos');
    expect(await contactTags(copy.id)).toEqual([...names].sort());
    expect((await tagNames(other.ws)).filter((n) => n.startsWith("'"))).toEqual([]);

    // Back into the same workspace: no apostrophe copies of the tags.
    const again = await env.api('POST', '/api/contacts/import', { csv: exp.raw });
    expect(again.status).toBe(200);
    expect((await tagNames(ws)).filter((n) => n.startsWith("'"))).toEqual([]);
    expect(await contactTags(c.id)).toEqual([...names].sort());
  });

  it('refuses ; , and | in tag names and keeps older tags with them whole on import (#56)', async () => {
    expect((await env.api('POST', '/api/tags', { name: 'Cliente, mayoreo' })).status).toBe(400);
    const plain = (await env.api('POST', '/api/tags', { name: 'Mayorista' })).body.tag;
    expect((await env.api('PATCH', `/api/tags/${plain.id}`, { name: 'Mayorista | norte' })).status).toBe(400);

    // A tag created before the rule.
    const legacy = (await q(`INSERT INTO tags (workspace_id, name) VALUES ($1, 'Lista, mayoreo') RETURNING id`, [ws])).rows[0];
    const vip = (await env.api('POST', '/api/tags', { name: 'Promo' })).body.tag;
    const c = await contact('5512340402', { name: 'Legado', tag_ids: [legacy.id, vip.id] });
    const exp = await env.api('GET', '/api/contacts/export.csv');
    await env.api('DELETE', `/api/contacts/${c.id}`);
    const imp = await env.api('POST', '/api/contacts/import', { csv: exp.raw });
    expect(imp.status).toBe(200);
    const back = (await q(`SELECT id FROM contacts WHERE workspace_id = $1 AND phone = $2`, [ws, c.phone])).rows[0];
    expect(await contactTags(back.id)).toEqual(['Lista, mayoreo', 'Promo']);
    const tags = await tagNames(ws);
    expect(tags).not.toContain('Lista');
    expect(tags).not.toContain('mayoreo');

    expect(splitTagCell('lista, MAYOREO ; Promo|Nueva', legacyTagIndex(['Lista, mayoreo', 'Promo']))).toEqual(['Lista, mayoreo', 'Promo', 'Nueva']);
    expect(splitTagCell('A;B,C|D')).toEqual(['A', 'B', 'C', 'D']);
    // The longest older name wins where several start at the same place.
    const index = legacyTagIndex(['a,b', 'a,b|c', ' Norte ; Sur ', 'x;']);
    expect(splitTagCell(' A,B|C ;a,b; norte ; sur ,x; ,z', index)).toEqual(['a,b|c', 'a,b', ' Norte ; Sur ', 'x;', 'z']);
    expect(splitTagCell('a ,b', index)).toEqual(['a', 'b']);
  });

  it("splits tag cells in time that does not grow with the workspace's tags (#34)", () => {
    const names = Array.from({ length: 200_000 }, (_, i) => `etiqueta${i}`);
    for (let i = 0; i < 1000; i++) names.push(`legado ${i}, zona`);
    const start = performance.now();
    const index = legacyTagIndex(names);
    let found = 0;
    for (let row = 0; row < 20_000; row++) {
      found += splitTagCell(row % 2 ? '' : `VIP, legado ${row % 1000}, zona | etiqueta${row}`, index).length;
    }
    expect(found).toBe(10_000 * 3);
    // Filtering and sorting every tag name per row took minutes here.
    expect(performance.now() - start).toBeLessThan(2000);
    expect(splitTagCell('VIP, legado 7, zona | otra', index)).toEqual(['VIP', 'legado 7, zona', 'otra']);
  });

  it('imports a value that really contains U+FFFD, such as its own export of a WhatsApp name (#57)', async () => {
    const c = await contact('5512340403', { name: 'Beto � Ruiz' });
    const exp = await env.api('GET', '/api/contacts/export.csv');
    expect(exp.raw).toContain('Beto � Ruiz');
    const other = await freshWorkspace('Destino FFFD');
    const imp = await env.api('POST', '/api/contacts/import', { csv: exp.raw }, other);
    expect(imp.status).toBe(200);
    expect(imp.body.error_count).toBe(0);
    const copy = (await q(`SELECT name FROM contacts WHERE workspace_id = $1 AND phone = $2`, [other.ws, c.phone])).rows[0];
    expect(copy.name).toBe('Beto � Ruiz');
  });

  it('imports U+FFFD next to a letter when the client says nothing was lost decoding the file (#57)', async () => {
    const c = await contact('5512340404', { name: 'Ana\ufffd' });
    const exp = await env.api('GET', '/api/contacts/export.csv');
    const other = await freshWorkspace('Destino FFFD letra');
    // The web client decodes UTF-8 strictly (or as Windows-1252), so its text has no lossy U+FFFD.
    const imp = await env.api('POST', '/api/contacts/import', { csv: exp.raw, lossy: false }, other);
    expect(imp.status).toBe(200);
    expect(imp.body.error_count).toBe(0);
    expect((await q(`SELECT name FROM contacts WHERE workspace_id = $1 AND phone = $2`, [other.ws, c.phone])).rows[0].name).toBe('Ana\ufffd');
    // A caller that does not say how it decoded the file still gets the letter check.
    const unknown = await env.api('POST', '/api/contacts/import', { csv: exp.raw }, await freshWorkspace('Destino FFFD 2'));
    expect(unknown.body.error?.code).toBe('CSV_NOT_UTF8');
    // And when the client had to replace bytes, any U+FFFD means something was lost.
    const lossy = await env.api('POST', '/api/contacts/import', { csv: 'nombre,telefono\nBeto \ufffd Ruiz,55 3434 0103\n', lossy: true }, other);
    expect(lossy.status).toBe(400);
    expect(lossy.body.error.code).toBe('CSV_NOT_UTF8');
  });

  it('still refuses a non-UTF-8 file, also when only the data has accents (#57)', async () => {
    const bytes = Buffer.from('nombre,telefono\r\nAna,55 3434 0101\r\nMar\xeda P\xe9rez,55 3434 0102\r\n', 'latin1');
    const r = await env.api('POST', '/api/contacts/import', { csv: new TextDecoder('utf-8').decode(bytes) });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('CSV_NOT_UTF8');
    expect(r.body.error.message).toMatch(/fila 3/);
    expect(r.body.error.message).toMatch(/CSV UTF-8/);
    expect((await q(`SELECT count(*)::int AS n FROM contacts WHERE workspace_id = $1 AND phone = '525534340101'`, [ws])).rows[0].n).toBe(0);
  });

  it('applies the hand-entry limits to imported names, companies and tags (#34)', async () => {
    const csv = `nombre,telefono,empresa,etiquetas\n${'N'.repeat(121)},55 3434 0201,,\nOk,55 3434 0202,${'E'.repeat(121)},\nOk,55 3434 0203,,${'t'.repeat(41)}\nBien,55 3434 0204,Acme,Nueva\n`;
    const r = await env.api('POST', '/api/contacts/import', { csv });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ created: 1, error_count: 3 });
    expect(r.body.errors.map((e: any) => e.row)).toEqual([2, 3, 4]);
    expect(await tagNames(ws)).not.toContain('t'.repeat(41));
  });
});

describe('public API tags and template values (#33, #34, #56)', () => {
  it('splits "VIP, Expo" into two tags and refuses names longer than a tag allows', async () => {
    const r = await env.api('POST', '/api/v1/contacts', { phone: '5512340501', tags: ['Feria, Expo'] }, asKey());
    expect(r.status).toBe(200);
    expect(await contactTags(r.body.contact.id)).toEqual(['Expo', 'Feria']);
    const legacy = (await q(`INSERT INTO tags (workspace_id, name) VALUES ($1, 'Norte|Sur') RETURNING id`, [ws])).rows[0];
    const kept = await env.api('POST', '/api/v1/contacts', { phone: '5512340501', tags: ['Norte|Sur'] }, asKey());
    expect(kept.body.contact.tag_ids).toContain(legacy.id);
    const long = await env.api('POST', '/api/v1/contacts', { phone: '5512340502', tags: [`vip${'\t'.repeat(80)}x`] }, asKey());
    expect(long.status).toBe(400);
    expect(await tagNames(ws)).not.toContain(`vip${'\t'.repeat(80)}x`);
  });

  it('bounds the template values rendered for the contact before anything else', async () => {
    const header = await env.api('POST', '/api/v1/messages', { phone: '5512340503', template: { name: 'x', header: '{a|'.repeat(1000) } }, asKey());
    expect(header.status).toBe(400);
    expect(header.body.error.code).toBe('VALIDATION');
    const body = await env.api('POST', '/api/v1/messages', { phone: '5512340503', template: { name: 'x', body: Array(31).fill('a') } }, asKey());
    expect(body.body.error.code).toBe('VALIDATION');
    const long = await env.api('POST', '/api/v1/messages', { phone: '5512340503', template: { name: 'x', body: ['a'.repeat(1025)] } }, asKey());
    expect(long.body.error.code).toBe('VALIDATION');
    const c = await contact('5512340504');
    const named = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`v${i}`, 'x']));
    const inbox = await env.api('POST', `/api/contacts/${c.id}/messages`, { type: 'template', name: 'x', language: 'es_MX', params: { bodyNamed: named } });
    expect(inbox.status).toBe(400);
    expect(inbox.body.error.code).toBe('VALIDATION');
  });
});

describe('report days in the workspace time zone (#38)', () => {
  it('counts an evening lead on its local day, in totals and in the daily series', async () => {
    const o = await freshWorkspace('Reportes MX');
    const tz = (await q(`SELECT timezone FROM workspaces WHERE id = $1`, [o.ws])).rows[0].timezone;
    expect(tz).toBe('America/Mexico_City');
    const c = await contact('5512340601', {}, o);
    // Oct 29, 21:30 in Mexico City.
    await q(`UPDATE contacts SET created_at = '2026-10-30T03:30:00Z' WHERE id = $1`, [c.id]);
    const day29 = await env.api('GET', '/api/reports/overview?from=2026-10-29&to=2026-10-29', undefined, o);
    expect(day29.status).toBe(200);
    expect(day29.body.totals.new_leads).toBe(1);
    expect(day29.body.daily).toEqual([{ day: '2026-10-29', leads: 1, messages_in: 0, messages_out: 0 }]);
    const day30 = await env.api('GET', '/api/reports/overview?from=2026-10-30&to=2026-10-30', undefined, o);
    expect(day30.body.totals.new_leads).toBe(0);
    expect(day30.body.daily).toEqual([{ day: '2026-10-30', leads: 0, messages_in: 0, messages_out: 0 }]);
    // In Tokyo it is already Oct 30, 12:30.
    expect((await env.api('PATCH', '/api/workspace', { timezone: 'Asia/Tokyo' }, o)).status).toBe(200);
    const tokyo = await env.api('GET', '/api/reports/overview?from=2026-10-30&to=2026-10-30', undefined, o);
    expect(tokyo.body.totals.new_leads).toBe(1);
  });

  it('defaults to the last 30 local days and validates the range', async () => {
    const r = await env.api('GET', '/api/reports/overview');
    expect(r.status).toBe(200);
    expect(r.body.daily).toHaveLength(30);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    expect(r.body.daily.at(-1).day).toBe(today);
    expect((await env.api('GET', '/api/reports/overview?from=2026-10-30&to=2026-10-29')).status).toBe(400);
    expect((await env.api('GET', '/api/reports/overview?from=2026-02-30&to=2026-03-01')).status).toBe(400);
    expect((await env.api('GET', '/api/reports/overview?from=2026-13-01&to=2026-13-02')).status).toBe(400);
    expect((await env.api('GET', '/api/reports/overview?from=2024-01-01&to=2026-01-01')).status).toBe(400);
  });

  it('reads the zone only as JavaScript does, for "today", the day bounds and the month (#38)', async () => {
    const o = await freshWorkspace('Reportes desfase');
    // Postgres reads '-03:00' as POSIX (UTC+3) and does not know 'US/Pacific-New'; Intl does both.
    expect((await env.api('PATCH', '/api/workspace', { timezone: '-03:00' }, o)).status).toBe(200);
    const c = await contact('5512340602', {}, o);
    // Oct 29, 22:00 at UTC-3.
    await q(`UPDATE contacts SET created_at = '2026-10-30T01:00:00Z' WHERE id = $1`, [c.id]);
    const day29 = await env.api('GET', '/api/reports/overview?from=2026-10-29&to=2026-10-29', undefined, o);
    expect(day29.status).toBe(200);
    expect(day29.body.totals.new_leads).toBe(1);
    expect(day29.body.daily).toEqual([{ day: '2026-10-29', leads: 1, messages_in: 0, messages_out: 0 }]);
    expect(day29.body.range.from).toBe('2026-10-29T03:00:00.000Z');
    expect((await env.api('GET', '/api/reports/overview?from=2026-10-30&to=2026-10-30', undefined, o)).body.totals.new_leads).toBe(0);
    expect((await env.api('GET', '/api/credits', undefined, o)).status).toBe(200);

    expect((await env.api('PATCH', '/api/workspace', { timezone: 'US/Pacific-New' }, o)).status).toBe(200);
    const credits = await env.api('GET', '/api/credits', undefined, o);
    expect(credits.status).toBe(200);
    const la = await env.api('GET', '/api/reports/overview?from=2026-10-29&to=2026-10-29', undefined, o);
    expect(la.status).toBe(200);
    expect(la.body.range.from).toBe('2026-10-29T07:00:00.000Z');

    // Days of a DST change last 23 and 25 hours; where clocks skip midnight the day starts at the jump.
    const hours = (d1: string, d2: string, tz: string) => (dayStart(d2, tz).getTime() - dayStart(d1, tz).getTime()) / 3_600_000;
    expect(hours('2026-03-08', '2026-03-09', 'America/New_York')).toBe(23);
    expect(hours('2026-11-01', '2026-11-02', 'America/New_York')).toBe(25);
    expect(dayStart('2026-09-06', 'America/Santiago').toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(hours('2026-09-06', '2026-09-07', 'America/Santiago')).toBe(23);
  });

  it('counts "this month" credits by the local calendar month', async () => {
    const o = await freshWorkspace('Créditos MX');
    const start = (await q(`SELECT date_trunc('month', now() AT TIME ZONE 'America/Mexico_City') AT TIME ZONE 'America/Mexico_City' AS s`)).rows[0].s;
    const at = (minutes: number) => new Date(new Date(start).getTime() + minutes * 60_000);
    await q(`INSERT INTO credit_ledger (workspace_id, amount, balance_after, kind, created_at) VALUES ($1, -1, 0, 'charge', $2), ($1, -2, 0, 'charge', $3)`, [
      o.ws,
      at(-1),
      at(1),
    ]);
    const r = await env.api('GET', '/api/credits', undefined, o);
    expect(r.status).toBe(200);
    expect(r.body.spent_this_month).toBe(2);
    expect(r.body.spent_total).toBe(3);
  });
});

describe('deleting contacts with charges Meta can still settle (#49)', () => {
  async function billed(contactId: string, over: Record<string, unknown> = {}) {
    const m = { status: 'sent', cost: 0.0457, charged_prepaid: true, pricing_reconciled: true, created_at: new Date(), ...over };
    const { rows } = await q(
      `INSERT INTO messages (workspace_id, contact_id, direction, type, body, status, cost, charged_prepaid, pricing_reconciled, created_at, wamid)
       VALUES ($1, $2, 'out', 'template', 'promo', $3, $4, $5, $6, $7, $8) RETURNING id`,
      [ws, contactId, m.status, m.cost, m.charged_prepaid, m.pricing_reconciled, m.created_at, `wamid.r3del${++seq}`],
    );
    return rows[0].id as string;
  }

  it('refuses to delete one, and archives instead of deleting in bulk, until Meta settles', async () => {
    const pending = await contact('5512340701');
    const msg = await billed(pending.id);
    const del = await env.api('DELETE', `/api/contacts/${pending.id}`);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('CONTACT_BILLING_PENDING');
    expect((await q(`SELECT 1 FROM messages WHERE id = $1`, [msg])).rows).toHaveLength(1);

    const settled = await contact('5512340702');
    await billed(settled.id, { status: 'delivered' });
    const old = await contact('5512340703');
    await billed(old.id, { created_at: new Date(Date.now() - 40 * 86400_000) });
    const metaDirect = await contact('5512340704');
    await billed(metaDirect.id, { charged_prepaid: false });
    const unpriced = await contact('5512340705');
    await billed(unpriced.id, { status: 'delivered', pricing_reconciled: false });

    const bulk = await env.api('POST', '/api/contacts/bulk', { ids: [pending.id, settled.id, old.id, metaDirect.id, unpriced.id], action: 'delete' });
    expect(bulk.status).toBe(200);
    expect(bulk.body).toEqual({ updated: 3, archived: 2 });
    const left = (await q(`SELECT phone, is_archived FROM contacts WHERE id = ANY($1::uuid[]) ORDER BY phone`, [[pending.id, settled.id, old.id, metaDirect.id, unpriced.id]])).rows;
    expect(left).toEqual([
      { phone: pending.phone, is_archived: true },
      { phone: unpriced.phone, is_archived: true },
    ]);
    expect((await q(`SELECT 1 FROM messages WHERE id = $1`, [msg])).rows).toHaveLength(1);

    // Once Meta's final status is in, it can go.
    await q(`UPDATE messages SET status = 'failed', cost = 0 WHERE id = $1`, [msg]);
    expect((await env.api('DELETE', `/api/contacts/${pending.id}`)).status).toBe(204);
    expect((await q(`SELECT 1 FROM contacts WHERE id = $1`, [pending.id])).rows).toHaveLength(0);
  });
});

describe('template variables and Meta errors (#55, #58, #59)', () => {
  it('lists variables in linear time and bounds the button URL', async () => {
    const many = Array.from({ length: 60_000 }, (_, i) => `{{v${i}}}`).join('');
    let start = performance.now();
    expect(variablesIn(many)).toHaveLength(60_000);
    expect(performance.now() - start).toBeLessThan(1000);

    const url = `https://tienda.mx/p/{{1}}${'{{'.repeat(50_000)}`;
    start = performance.now();
    const built = buildCreateComponents({
      channel_id: channel.id,
      name: 'promo',
      language: 'es_MX',
      category: 'MARKETING',
      body: { text: 'Hola' },
      buttons: [{ type: 'URL', text: 'Ver', url }],
    } as any);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(built.components.at(-1).buttons[0].example[0]).toMatch(/^https:\/\/tienda\.mx\/p\/ejemplo/);

    const r = await env.api('POST', '/api/templates', {
      channel_id: channel.id,
      name: 'url_larga',
      category: 'MARKETING',
      body: { text: 'Mira' },
      buttons: [{ type: 'URL', text: 'Ver', url: `https://tienda.mx/p/${'a'.repeat(2000)}/{{1}}` }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION');
  });

  it('gives positional values by variable number, wherever the variable sits in the text (#59)', async () => {
    const text = 'Hola {{2}}, tu pedido {{1}} ya salió';
    const components = [{ type: 'BODY', text }];
    expect(templateSchema(components).body).toEqual(['1', '2']);
    // Named ones keep their order of appearance.
    expect(templateSchema([{ type: 'BODY', text: 'Hola {{nombre}}, pedido {{folio}}' }]).body).toEqual(['nombre', 'folio']);
    const params = { body: ['A-123', 'Ana'] };
    expect(buildTemplateComponents(params, false, components)).toEqual([{ type: 'body', parameters: [{ type: 'text', text: 'A-123' }, { type: 'text', text: 'Ana' }] }]);
    expect(renderTemplateText(components, params)).toBe('Hola Ana, tu pedido A-123 ya salió');

    // Created through the API as the editor does: one example per variable in order of appearance
    // ({{2}} first here), sent to Meta by number.
    const created = await env.api('POST', '/api/templates', {
      channel_id: channel.id,
      name: 'pedido_listo',
      category: 'UTILITY',
      body: { text, examples: ['Luis', 'A-001'] },
    });
    expect(created.status).toBe(200);
    expect(created.body.template.inputs.body).toEqual(['1', '2']);
    expect(created.body.template.components[0].example).toEqual({ body_text: [['A-001', 'Luis']] });
    const named = buildCreateComponents({
      channel_id: channel.id,
      name: 'pedido_nombrado',
      language: 'es_MX',
      category: 'UTILITY',
      body: { text: 'Hola {{nombre}}, pedido {{folio}}', examples: ['Luis', 'A-001'] },
    } as any);
    expect(named.components[0].example).toEqual({
      body_text_named_params: [
        { param_name: 'nombre', example: 'Luis' },
        { param_name: 'folio', example: 'A-001' },
      ],
    });
    const sim = await env.api('POST', `/api/channels/${channel.id}/simulate`, { from: '5215512340801', name: 'Ana', text: 'hola' });
    const values = Object.fromEntries(created.body.template.inputs.body.map((v: string, i: number) => [v, i]));
    const body: string[] = [];
    body[values['1']] = 'A-123';
    body[values['2']] = '{primer_nombre}';
    const sent = await env.api('POST', `/api/contacts/${sim.body.message.contact_id}/messages`, {
      type: 'template',
      name: 'pedido_listo',
      language: 'es_MX',
      params: { body },
    });
    expect(sent.status).toBe(200);
    expect(sent.body.message.body).toBe('Hola Ana, tu pedido A-123 ya salió');
  });

  it("keeps Meta's reason when it rejects a template (#58)", async () => {
    vi.spyOn(SandboxProvider.prototype, 'createTemplate').mockRejectedValueOnce(
      new MetaApiError("Variables can't be at the start or end of the template.", 100, 400, {
        message: 'Invalid parameter',
        code: 100,
        error_subcode: 2388299,
        error_user_title: 'Variables at the start or end',
        error_user_msg: "Variables can't be at the start or end of the template.",
      }),
    );
    const r = await env.api('POST', '/api/templates', { channel_id: channel.id, name: 'mala', category: 'UTILITY', body: { text: '{{1}} tu pedido está listo', examples: ['Ana'] } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('META_ERROR');
    expect(r.body.error.message).toMatch(/^Meta rechazó la plantilla: /);
    expect(r.body.error.message).toContain("Variables can't be at the start or end of the template.");
    expect(r.body.error.details).toMatchObject({ code: 100, subcode: 2388299 });

    // The reason only in error_data.details (no error_user_msg).
    vi.spyOn(SandboxProvider.prototype, 'createTemplate').mockRejectedValueOnce(
      new MetaApiError('Invalid parameter', 100, 400, { messaging_product: 'whatsapp', details: 'Header text can not contain new lines.' }),
    );
    const d = await env.api('POST', '/api/templates', { channel_id: channel.id, name: 'mala2', category: 'UTILITY', body: { text: 'Hola' } });
    expect(d.body.error.message).toContain('Header text can not contain new lines.');

    vi.spyOn(SandboxProvider.prototype, 'listTemplates').mockRejectedValueOnce(
      new MetaApiError('Unsupported get request. Object with ID does not exist.', 100, 400, { message: 'Unsupported get request.', code: 100, error_subcode: 33 }),
    );
    const sync = await env.api('POST', '/api/templates/sync', { channel_id: channel.id });
    expect(sync.status).toBe(400);
    expect(sync.body.error.message).toContain('Object with ID does not exist');
  });
});
