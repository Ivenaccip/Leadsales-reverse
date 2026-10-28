import crypto from 'node:crypto';

/** AES-256-GCM. Output: base64(iv | tag | ciphertext). */
export function encrypt(key: Buffer, plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

export function decrypt(key: Buffer, payload: string): string {
  const buf = Buffer.from(payload, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

export function encryptJson(key: Buffer, value: unknown): string {
  return encrypt(key, JSON.stringify(value));
}

export function decryptJson<T>(key: Buffer, payload: string | null | undefined): T | null {
  if (!payload) return null;
  return JSON.parse(decrypt(key, payload)) as T;
}

export function hmacSha256Hex(secret: string, body: Buffer | string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
