import dns from 'node:dns/promises';
import net from 'node:net';

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

/**
 * Outgoing webhooks are configured by tenants: refuse targets inside the server's
 * network (cloud metadata, localhost, LAN) unless the operator allows it.
 */
export async function assertPublicUrl(url: string, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) return;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (addrs.some(isPrivateIp)) throw new Error(`Destino no permitido (red privada): ${host}`);
}
