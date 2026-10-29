import { describe, expect, it } from 'vitest';
import { decodeCsv } from '../lib/csv';

const utf8 = (s: string) => new TextEncoder().encode(s);

/** windows-1252 bytes for the Latin-1 range (what Excel's ANSI "CSV" writes in Spanish locales). */
const cp1252 = (s: string) => Uint8Array.from([...s].map((ch) => ch.charCodeAt(0)));

const CSV = 'Nombre,Teléfono,Etiquetas\nJosé Muñoz,+52 55 1234 5678,VIP;Año nuevo\n';

describe('CSV import keeps accents whatever Excel saved (CSV_NOT_UTF8)', () => {
  it('reads UTF-8, with or without the BOM Excel adds to "CSV UTF-8"', () => {
    expect(decodeCsv(utf8(CSV))).toBe(CSV);
    expect(decodeCsv(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(CSV)]))).toBe(CSV);
  });

  it('reads Excel ANSI (windows-1252) files instead of sending them garbled', () => {
    const bytes = cp1252(CSV);
    // Read as UTF-8 these bytes become U+FFFD, which the server refuses with CSV_NOT_UTF8.
    expect(new TextDecoder('utf-8').decode(bytes)).toContain('�');
    const text = decodeCsv(bytes.buffer);
    expect(text).toBe(CSV);
    expect(text).not.toContain('�');
  });

  it('maps the cp1252-only characters (euro sign, curly quotes, dashes)', () => {
    // (Ñ right before œ would be the bytes D1 9C, a well-formed UTF-8 pair: see r4-web #16.)
    expect(decodeCsv(new Uint8Array([0x80, 0x20, 0x93, 0x61, 0x94, 0x20, 0x96, 0x20, 0xd1, 0x20, 0x9c]))).toBe('€ “a” – Ñ œ');
  });

  it('reads Excel "Texto Unicode" (UTF-16 with BOM)', () => {
    const body = 'nombre\tteléfono\nAna\t5215512345678\n';
    const le = new Uint8Array(2 + body.length * 2);
    le.set([0xff, 0xfe]);
    [...body].forEach((ch, i) => {
      le[2 + i * 2] = ch.charCodeAt(0) & 0xff;
      le[3 + i * 2] = ch.charCodeAt(0) >> 8;
    });
    expect(decodeCsv(le)).toBe(body);
  });

  it('a binary file (e.g. an .xlsx) still reaches the server as invalid UTF-8, so its hint is shown', () => {
    const xlsx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00, 0xc3, 0x28, 0x9f]);
    expect(decodeCsv(xlsx)).toContain('�');
  });
});
