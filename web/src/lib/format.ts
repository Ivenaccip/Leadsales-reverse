export function formatPhone(digits: string | null | undefined): string {
  if (!digits) return '';
  const d = digits.replace(/\D/g, '');
  if (d.startsWith('52') && d.length === 12) return `+52 ${d.slice(2, 4)} ${d.slice(4, 8)} ${d.slice(8)}`;
  if (d.startsWith('1') && d.length === 11) return `+1 ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
  if (d.startsWith('57') && d.length === 12) return `+57 ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
  return `+${d}`;
}

export function displayName(c: { name: string | null; phone: string }): string {
  return c.name?.trim() || formatPhone(c.phone);
}

export function initials(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '#';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return 'ahora';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day');
  return new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
}

export function shortTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-MX', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Hoy';
  if (d.toDateString() === yesterday.toDateString()) return 'Ayer';
  return d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
}

export function money(n: number | null | undefined, currency = 'MXN'): string {
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n ?? 0);
}

/** Credits are USD amounts with up to 4 decimals (Meta prices are fractions of a cent). */
export function credits(n: number | null | undefined): string {
  const v = n ?? 0;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: Math.abs(v) < 1 && v !== 0 ? 4 : 2 })} USD`;
}

export function number(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString('es-MX');
}

export function duration(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86400).toFixed(1)} d`;
}

export function windowRemaining(lastInbound: string | null | undefined): number {
  if (!lastInbound) return 0;
  return Math.max(0, 24 * 3600 * 1000 - (Date.now() - new Date(lastInbound).getTime()));
}

export const MARKET_LABEL: Record<string, string> = {
  MX: 'México',
  CO: 'Colombia',
  BR: 'Brasil',
  AR: 'Argentina',
  CL: 'Chile',
  PE: 'Perú',
  ES: 'España',
  NA: 'EE. UU. y Canadá',
  LATAM: 'Resto de Latinoamérica',
  OTHER: 'Resto del mundo',
};

export const CATEGORY_LABEL: Record<string, string> = {
  marketing: 'Marketing',
  utility: 'Utilidad',
  authentication: 'Autenticación',
  service: 'Servicio',
};

export const SOURCE_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  whatsapp_ad: 'Anuncio de WhatsApp',
  manual: 'Manual',
  import: 'Importación',
  api: 'API',
  facebook_lead_ads: 'Facebook Lead Ads',
};
