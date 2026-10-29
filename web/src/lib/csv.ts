// C0 control bytes other than tab, LF and CR: no text file has them, binary files (xlsx, zip) do.
const BINARY_BYTE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

// windows-1252 for bytes 0x80-0x9F (€, curly quotes, dashes…). Some engines (Node) decode the
// 'windows-1252' label as ISO-8859-1 and return C1 controls there; the five unassigned bytes stay as is.
const CP1252_C1 =
  '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f' +
  '\u0090‘’“”•–—˜™š›œ\u009džŸ';

function decodeWindows1252(bytes: Uint8Array): string {
  return new TextDecoder('windows-1252').decode(bytes).replace(/[\u0080-\u009f]/g, (c) => CP1252_C1[c.charCodeAt(0) - 0x80]);
}

function decodeStrict(label: string, bytes: Uint8Array): { text: string; lossy: boolean } {
  try {
    return { text: new TextDecoder(label, { fatal: true }).decode(bytes), lossy: false };
  } catch {
    return { text: new TextDecoder(label).decode(bytes), lossy: true };
  }
}

/**
 * Text of an uploaded CSV. Excel's plain "CSV (delimitado por comas)" is ANSI (windows-1252) in
 * Spanish locales and its "Texto Unicode" is UTF-16, so those are decoded here instead of being
 * refused by the server. Anything else is passed on as lossy UTF-8 (`lossy`: its bad bytes became
 * U+FFFD): the server then answers CSV_NOT_UTF8 with the hint to save the file as "CSV UTF-8".
 */
export function decodeCsvFile(data: ArrayBuffer | Uint8Array): { text: string; lossy: boolean } {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return decodeStrict('utf-16le', bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return decodeStrict('utf-16be', bytes);
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), lossy: false };
  } catch {
    // Every byte is valid windows-1252, so only fall back for what looks like text.
    const latin = decodeWindows1252(bytes);
    if (!BINARY_BYTE.test(latin)) return { text: latin, lossy: false };
    return { text: new TextDecoder('utf-8').decode(bytes), lossy: true };
  }
}

export function decodeCsv(data: ArrayBuffer | Uint8Array): string {
  return decodeCsvFile(data).text;
}
