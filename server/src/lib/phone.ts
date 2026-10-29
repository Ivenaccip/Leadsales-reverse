/**
 * Phone helpers. Contacts are keyed by digits-only international numbers
 * (country code + national number), the same shape WhatsApp uses for wa_id.
 */

// Calling code -> ISO country. Longest prefix wins.
const CALLING_CODES: Record<string, string> = {
  '1': 'US',
  '1204': 'CA', '1226': 'CA', '1236': 'CA', '1249': 'CA', '1250': 'CA', '1257': 'CA', '1263': 'CA', '1289': 'CA',
  '1306': 'CA', '1343': 'CA', '1354': 'CA', '1365': 'CA', '1367': 'CA', '1368': 'CA', '1382': 'CA', '1387': 'CA',
  '1403': 'CA', '1416': 'CA', '1418': 'CA', '1428': 'CA', '1431': 'CA', '1437': 'CA', '1438': 'CA', '1450': 'CA',
  '1460': 'CA', '1468': 'CA', '1474': 'CA', '1506': 'CA', '1514': 'CA', '1519': 'CA', '1548': 'CA', '1579': 'CA',
  '1581': 'CA', '1584': 'CA', '1587': 'CA', '1604': 'CA', '1613': 'CA', '1639': 'CA', '1647': 'CA', '1672': 'CA',
  '1683': 'CA', '1705': 'CA', '1709': 'CA', '1742': 'CA', '1753': 'CA', '1778': 'CA', '1780': 'CA', '1782': 'CA',
  '1807': 'CA', '1819': 'CA', '1825': 'CA', '1867': 'CA', '1873': 'CA', '1879': 'CA', '1902': 'CA', '1905': 'CA',
  '1942': 'CA',
  // +1 numbers outside the US and Canada: Meta does not price them as North America.
  '1809': 'DO', '1829': 'DO', '1849': 'DO', '1787': 'PR', '1939': 'PR', '1876': 'JM', '1658': 'JM',
  '1242': 'BS', '1246': 'BB', '1264': 'AI', '1268': 'AG', '1284': 'VG', '1340': 'VI', '1345': 'KY', '1441': 'BM',
  '1473': 'GD', '1649': 'TC', '1664': 'MS', '1670': 'MP', '1671': 'GU', '1684': 'AS', '1721': 'SX', '1758': 'LC',
  '1767': 'DM', '1784': 'VC', '1868': 'TT', '1869': 'KN',
  '52': 'MX', '57': 'CO', '55': 'BR', '54': 'AR', '56': 'CL', '51': 'PE', '58': 'VE', '593': 'EC',
  '591': 'BO', '595': 'PY', '598': 'UY', '502': 'GT', '503': 'SV', '504': 'HN', '505': 'NI',
  '506': 'CR', '507': 'PA', '53': 'CU', '509': 'HT', '34': 'ES', '351': 'PT', '44': 'GB', '49': 'DE',
  '33': 'FR', '39': 'IT', '31': 'NL', '41': 'CH', '91': 'IN', '86': 'CN', '81': 'JP', '61': 'AU',
};

const LATAM = new Set(['VE', 'EC', 'BO', 'PY', 'UY', 'GT', 'SV', 'HN', 'NI', 'CR', 'PA', 'CU', 'HT', 'DO', 'PR', 'JM']);
const INDIVIDUAL_MARKETS = new Set(['MX', 'CO', 'BR', 'AR', 'CL', 'PE', 'ES']);

export function digitsOnly(value: string): string {
  return value.replace(/\D+/g, '');
}

/**
 * Normalizes user input or a wa_id to the canonical contact phone.
 * - strips symbols and international "00" prefix
 * - adds the workspace default country code to 10-digit national numbers
 * - Mexico: WhatsApp reports mobiles as 521XXXXXXXXXX; we store 52XXXXXXXXXX so
 *   leads created by hand/API and leads that write in are the same contact.
 */
export function normalizePhone(input: string, defaultCountryCode = '52'): string {
  let d = digitsOnly(input);
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 && !input.trim().startsWith('+')) d = defaultCountryCode + d;
  if (d.length === 13 && d.startsWith('521')) d = '52' + d.slice(3);
  return d;
}

/**
 * Other ways the same mobile line is commonly written, for a WhatsApp id.
 * - Brazil: older accounts have no 9th digit (55 DD 8765-4321 vs 55 DD 9 8765-4321).
 * - Argentina: WhatsApp reports mobiles as 549 + area + number; people write 54 + area + number,
 *   often with the local "15" mobile prefix after a 2-4 digit area code.
 */
export function phoneVariants(waId: string): string[] {
  const d = digitsOnly(waId);
  const out = new Set<string>();
  if (d.startsWith('55')) {
    const ddd = d.slice(2, 4);
    const sub = d.slice(4);
    if (sub.length === 8 && /^[6-9]/.test(sub)) out.add(`55${ddd}9${sub}`);
    if (sub.length === 9 && /^9[6-9]/.test(sub)) out.add(`55${ddd}${sub.slice(1)}`);
  } else if (d.startsWith('54')) {
    const national = d.startsWith('549') && d.length === 13 ? d.slice(3) : d.length === 12 ? d.slice(2) : null;
    if (national) {
      out.add(`54${national}`);
      out.add(`549${national}`);
      for (const area of [2, 3, 4]) out.add(`54${national.slice(0, area)}15${national.slice(area)}`);
    }
  }
  out.delete(d);
  return [...out];
}

// Countries whose subscriber numbers can be 4 digits: their full international numbers have 7.
const SHORT_NUMBER_CODES = ['683', '690', '290'];

export function isValidPhone(d: string): boolean {
  if (/^\d{7}$/.test(d)) return SHORT_NUMBER_CODES.some((cc) => d.startsWith(cc));
  return /^\d{8,15}$/.test(d);
}

export function countryFromPhone(phone: string): string | null {
  const d = digitsOnly(phone);
  for (let len = 4; len >= 1; len--) {
    const cc = CALLING_CODES[d.slice(0, len)];
    if (cc) return cc;
  }
  return null;
}

/** Pricing market used in the rate card for a phone number. */
export function marketFromPhone(phone: string): string {
  const country = countryFromPhone(phone);
  if (!country) return 'OTHER';
  if (INDIVIDUAL_MARKETS.has(country)) return country;
  if (country === 'US' || country === 'CA') return 'NA';
  if (LATAM.has(country)) return 'LATAM';
  return 'OTHER';
}
