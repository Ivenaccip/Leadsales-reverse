import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

export interface TokenPayload {
  uid: string;
}

export const hashPassword = (password: string) => bcrypt.hash(password, 10);
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);

export function signToken(secret: string, payload: TokenPayload): string {
  return jwt.sign(payload, secret, { expiresIn: '30d' });
}

export function verifyToken(secret: string, token: string): TokenPayload | null {
  try {
    const p = jwt.verify(token, secret) as TokenPayload;
    return typeof p.uid === 'string' ? p : null;
  } catch {
    return null;
  }
}

/** Reads one cookie value from a raw Cookie header (used by Socket.IO handshake). */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
