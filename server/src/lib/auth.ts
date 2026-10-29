import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

/** uid = user, sid = row in `sessions` (revocable). */
export interface TokenPayload {
  uid: string;
  sid: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const hashPassword = (password: string) => bcrypt.hash(password, 10);
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);

let dummyHash: Promise<string> | null = null;
/** A real bcrypt hash of a random secret: comparing against it costs the same as a real account. */
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(crypto.randomBytes(24).toString('base64url'));
  return dummyHash;
}

export function signToken(secret: string, payload: TokenPayload): string {
  return jwt.sign({ uid: payload.uid, sid: payload.sid }, secret, { expiresIn: '30d' });
}

/** Tokens issued before sessions existed carry no sid: they are rejected (one re-login). */
export function verifyToken(secret: string, token: string): TokenPayload | null {
  try {
    const p = jwt.verify(token, secret) as Partial<TokenPayload>;
    if (typeof p.uid !== 'string' || !UUID.test(p.uid) || typeof p.sid !== 'string' || !UUID.test(p.sid)) return null;
    return { uid: p.uid, sid: p.sid };
  } catch {
    return null;
  }
}

/** Reads one cookie value from a raw Cookie header (used by Socket.IO handshake). */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k !== name) continue;
    try {
      return decodeURIComponent(v.join('='));
    } catch {
      return null; // malformed %-escape: treat as no cookie instead of throwing
    }
  }
  return null;
}
