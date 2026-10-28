/**
 * Phone helpers. Contacts are keyed by digits-only international numbers
 * (country code + national number), the same shape WhatsApp uses for wa_id.
 */

// Calling code -> ISO country. Longest prefix wins.
const CALLING_CODES: Record<string, string> = {
  '1': 'US', '1809': 'DO', '1829': 'DO', '1849': 'DO', '1787': 'PR', '1939': 'PR',
  '1204': 'CA', '1236': 'CA', '1250': 'CA', '1289': 'CA', '1306': 'CA', '1343': 'CA', '1365': 'CA',
  '1403': 'CA', '1416': 'CA', '1418': 'CA', '1431': 'CA', '1437': 'CA', '1438': 'CA', '1450': 'CA',
  '1506': 'CA', '1514': 'CA', '1519': 'CA', '1548': 'CA', '1579': 'CA', '1581': 'CA', '1587': 'CA',
  '1604': 'CA', '1613': 'CA', '1639': 'CA', '1647': 'CA', '1705': 'CA', '1709': 'CA', '1778': 'CA',
  '1780': 'CA', '1782': 'CA', '1807': 'CA', '1819': 'CA', '1825': 'CA', '1867': 'CA', '1873': 'CA',
  '1902': 'CA', '1905': 'CA',
  '52': 'MX', '57': 'CO', '55': 'BR', '54': 'AR', '56': 'CL', '51': 'PE', '58': 'VE', '593': 'EC',
  '591': 'BO', '595': 'PY', '598': 'UY', '502': 'GT', '503': 'SV', '504': 'HN', '505': 'NI',
  '506': 'CR', '507': 'PA', '53': 'CU', '509': 'HT', '34': 'ES', '351': 'PT', '44': 'GB', '49': 'DE',
  '33': 'FR', '39': 'IT', '31': 'NL', '41': 'CH', '91': 'IN', '86': 'CN', '81': 'JP', '61': 'AU',
};

const LATAM = new Set(['VE', 'EC', 'BO', 'PY', 'UY', 'GT', 'SV', 'HN', 'NI', 'CR', 'PA', 'CU', 'HT', 'DO', 'PR']);
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

export function isValidPhone(d: string): boolean {
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
