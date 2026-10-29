import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import jwt from 'jsonwebtoken';
import { AppError } from './errors.js';

/** uid = user, sid = row in `sessions` (revocable). */
export interface TokenPayload {
  uid: string;
  sid: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BCRYPT_ROUNDS = 10;

// bcryptjs is pure JavaScript: one comparison blocks its thread ~90 ms. It runs in worker threads
// so password work never stalls the event loop every tenant shares (requests, sockets, webhooks,
// jobs). The pool is also the process-wide bound on that work, whatever network the requests
// come from: past a short queue, callers get 503 at once instead of piling up.
const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const bcrypt = require(workerData.bcryptPath);
parentPort.on('message', (t) => {
  try {
    const result = t.op === 'hash' ? bcrypt.hashSync(t.password, t.rounds) : bcrypt.compareSync(t.password, t.hash);
    parentPort.postMessage({ result });
  } catch (err) {
    parentPort.postMessage({ error: String((err && err.message) || err) });
  }
});
`;

interface HashTask {
  op: 'hash' | 'compare';
  password: string;
  hash?: string;
  resolve: (v: any) => void;
  reject: (e: unknown) => void;
}

export const serverBusy = () => new AppError(503, 'BUSY', 'El servidor está ocupado. Intenta de nuevo en unos segundos.');

export class HashPool {
  private slots: { worker: Worker; task: HashTask | null }[] = [];
  private queue: HashTask[] = [];
  private bcryptPath = createRequire(import.meta.url).resolve('bcryptjs');

  constructor(
    readonly size: number,
    readonly maxQueued: number,
  ) {}

  /** Tasks running or waiting. */
  get pending(): number {
    return this.queue.length + this.slots.filter((s) => s.task).length;
  }

  run<T>(op: 'hash' | 'compare', password: string, hash?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: HashTask = { op, password, hash, resolve, reject };
      const slot = this.slots.find((s) => !s.task) ?? (this.slots.length < this.size ? this.spawn() : null);
      if (slot) return this.start(slot, task);
      if (this.queue.length >= this.maxQueued) return reject(serverBusy());
      this.queue.push(task);
    });
  }

  private spawn() {
    const worker = new Worker(WORKER_SRC, { eval: true, workerData: { bcryptPath: this.bcryptPath } });
    const slot = { worker, task: null as HashTask | null };
    worker.unref();
    worker.on('message', (m: { result?: unknown; error?: string }) => {
      const t = slot.task;
      slot.task = null;
      worker.unref();
      if (t) {
        if (m.error !== undefined) t.reject(new Error(m.error));
        else t.resolve(m.result);
      }
      this.next(slot);
    });
    const fail = (err: unknown) => {
      // A dead worker is replaced on the next call; its task fails instead of hanging.
      this.slots = this.slots.filter((s) => s !== slot);
      slot.task?.reject(err instanceof Error ? err : new Error(`hash worker exited (${String(err)})`));
      slot.task = null;
      const t = this.queue.shift();
      if (t) this.run(t.op, t.password, t.hash).then(t.resolve, t.reject);
    };
    worker.on('error', fail);
    worker.on('exit', (code) => {
      if (this.slots.includes(slot)) fail(code);
    });
    this.slots.push(slot);
    return slot;
  }

  private start(slot: { worker: Worker; task: HashTask | null }, task: HashTask) {
    slot.task = task;
    // Referenced only while working: an idle pool never keeps the process alive.
    slot.worker.ref();
    slot.worker.postMessage({ op: task.op, password: task.password, hash: task.hash, rounds: BCRYPT_ROUNDS });
  }

  private next(slot: { worker: Worker; task: HashTask | null }) {
    const t = this.queue.shift();
    if (t) this.start(slot, t);
  }
}

// Leave a core to the event loop; two workers at most (~20 bcrypt operations per second).
export const hashPool = new HashPool(Math.max(1, Math.min(2, os.availableParallelism() - 1)), 16);

export const hashPassword = (password: string) => hashPool.run<string>('hash', password);
export const verifyPassword = (password: string, hash: string) => hashPool.run<boolean>('compare', password, hash);

let dummyHash: Promise<string> | null = null;
/** A real bcrypt hash of a random secret: comparing against it costs the same as a real account. */
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(crypto.randomBytes(24).toString('base64url'));
  // A failed attempt (e.g. pool busy at startup) must not be cached for good.
  dummyHash.catch(() => (dummyHash = null));
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

/*
 * Device cookies (OWASP "device cookies"): a browser that signed in to an account gets a signed
 * entry "userId.passwordVersion.nonce.signature". It lets that browser log in while the account's
 * shared limiter is full, wherever it connects from. A password change invalidates the entries.
 */
const MAX_DEVICE_ENTRIES = 5;
const NO_USER = '00000000-0000-0000-0000-000000000000';

function deviceSignature(secret: string, userId: string, version: number, nonce: string): string {
  return crypto.createHmac('sha256', secret).update(`ll-device|${userId}|${version}|${nonce}`).digest('base64url');
}

function deviceEntries(cookie: string | undefined | null): string[] {
  if (!cookie || cookie.length > 2000) return [];
  return cookie.split('~').filter((e) => /^[0-9a-f-]{36}\.\d{1,9}\.[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{43}$/i.test(e)).slice(0, MAX_DEVICE_ENTRIES);
}

/**
 * The nonce of this account's valid device entry, if the cookie has one. It does the same work
 * whether or not the account exists (pass null): timing must not reveal accounts.
 */
export function knownDevice(secret: string, cookie: string | undefined | null, user: { id: string; password_version: number } | null): string | null {
  const userId = user?.id ?? NO_USER;
  let found: string | null = null;
  for (const entry of deviceEntries(cookie)) {
    const [uid, version, nonce, sig] = entry.split('.');
    const ok = safeCompare(sig, deviceSignature(secret, userId, Number(version), nonce));
    if (ok && user && uid.toLowerCase() === user.id.toLowerCase() && Number(version) === user.password_version) found ??= nonce;
  }
  return found;
}

/** Cookie value after a successful login: this account's new entry first, older ones of other accounts kept. */
export function rememberDevice(secret: string, cookie: string | undefined | null, userId: string, version: number): string {
  const nonce = crypto.randomBytes(16).toString('base64url');
  const entry = `${userId}.${version}.${nonce}.${deviceSignature(secret, userId, version, nonce)}`;
  const others = deviceEntries(cookie).filter((e) => e.split('.')[0].toLowerCase() !== userId.toLowerCase());
  return [entry, ...others].slice(0, MAX_DEVICE_ENTRIES).join('~');
}

function safeCompare(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
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
