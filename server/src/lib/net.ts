import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function isBlockedV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  });
}

/** Expands an IPv6 address to 8 numeric groups (handles :: and embedded IPv4). */
function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0];
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    s = s.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  if (tail === undefined && h.length !== 8) return null;
  const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t].map((g) => parseInt(g || '0', 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

function embeddedV4(hi: number, lo: number): string {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isBlockedV4(ip);
  const g = expandV6(ip);
  if (!g) return true; // unparseable: refuse
  const zeroPrefix = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroPrefix(8)) return true; // ::
  if (zeroPrefix(7) && g[7] === 1) return true; // ::1
  if (zeroPrefix(5) && g[5] === 0xffff) return isBlockedV4(embeddedV4(g[6], g[7])); // ::ffff:a.b.c.d
  if (zeroPrefix(6)) return true; // deprecated IPv4-compatible ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isBlockedV4(embeddedV4(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isBlockedV4(embeddedV4(g[1], g[2])); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link local fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  return false;
}

/** Pre-check for IP-literal hosts (connect-time lookup only runs for hostnames). */
export async function assertPublicUrl(url: string, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) return;
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Solo se permiten URLs http(s)');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isPrivateIp(host)) throw new Error(`Destino no permitido (red privada): ${host}`);
}

type LookupCb = (err: NodeJS.ErrnoException | null, address?: any, family?: number) => void;

/**
 * DNS lookup used at connect time: the address that is actually dialed is the one
 * checked, so DNS rebinding between a check and the request cannot reach private hosts.
 */
export function publicOnlyLookup(hostname: string, options: any, cb: LookupCb) {
  const opts = typeof options === 'object' && options ? options : {};
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = addresses as unknown as dns.LookupAddress[];
    const bad = list.find((a) => isPrivateIp(a.address));
    if (bad || !list.length) {
      const e = new Error(`Destino no permitido (red privada): ${hostname}`) as NodeJS.ErrnoException;
      e.code = 'EPRIVATE';
      return cb(e);
    }
    if (opts.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

/** fetch for tenant-configured URLs (outgoing webhooks): public destinations only. */
export function createWebhookFetch(allowPrivate: boolean): typeof fetch {
  if (allowPrivate) return fetch;
  const dispatcher = new Agent({ connect: { lookup: publicOnlyLookup as any } });
  return ((input: any, init: any = {}) => undiciFetch(input, { ...init, dispatcher }) as any) as typeof fetch;
}
