import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type BillingMode = 'meta_direct' | 'prepaid';

export interface Config {
  port: number;
  host: string;
  publicUrl: string;
  dataDir: string;
  databaseUrl: string | null;
  jwtSecret: string;
  encryptionKey: Buffer;
  graphVersion: string;
  graphBaseUrl: string;
  metaVerifyToken: string | null;
  metaAppSecret: string | null;
  allowSignup: boolean;
  defaultBillingMode: BillingMode;
  signupCredits: number;
  anthropicApiKey: string | null;
  broadcastRatePerSecond: number;
  webDistDir: string | null;
  isProduction: boolean;
  logLevel: string;
  maxUploadMb: number;
  /** Base delay for the fake status webhooks of sandbox channels. */
  sandboxStatusDelayMs: number;
  /** Let outgoing webhooks target private/LAN addresses (off by default: SSRF protection). */
  allowPrivateWebhooks: boolean;
  /** Which proxies may set X-Forwarded-For (Fastify trustProxy). Clients cannot spoof their IP. */
  trustProxy: string | number | boolean;
}

/**
 * Secrets that are not provided by env are generated once and persisted in the
 * data directory, so a fresh install works with zero configuration.
 */
function loadOrCreateSecrets(dataDir: string): { jwtSecret: string; encryptionKey: string } {
  const file = path.join(dataDir, 'secrets.json');
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const secrets = {
    jwtSecret: crypto.randomBytes(48).toString('base64url'),
    encryptionKey: crypto.randomBytes(32).toString('base64'),
  };
  fs.writeFileSync(file, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  return secrets;
}

function parseTrustProxy(v: string | undefined): string | number | boolean {
  // Default: only proxies on loopback/private networks (Caddy/Nginx/Docker) are trusted.
  if (!v) return 'loopback,linklocal,uniquelocal';
  if (/^\d+$/.test(v)) return Number(v);
  if (v === 'true' || v === 'false') return v === 'true';
  return v;
}

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'si', 'sí', 'on'].includes(v.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const dataDir = path.resolve(env.DATA_DIR || './data');
  let jwtSecret = env.JWT_SECRET || '';
  let encKey = env.ENCRYPTION_KEY || '';
  if (!jwtSecret || !encKey) {
    const s = loadOrCreateSecrets(dataDir);
    jwtSecret ||= s.jwtSecret;
    encKey ||= s.encryptionKey;
  }
  const encryptionKey = crypto.createHash('sha256').update(encKey).digest();
  const port = Number(env.PORT || 3000);
  const graphVersion = env.META_GRAPH_VERSION || 'v23.0';
  const billing = (env.BILLING_MODE || 'meta_direct') as BillingMode;
  if (!['meta_direct', 'prepaid'].includes(billing)) {
    throw new Error(`BILLING_MODE inválido: ${billing} (usa meta_direct o prepaid)`);
  }

  let webDistDir: string | null = env.WEB_DIST_DIR || null;
  if (!webDistDir) {
    const candidate = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../web/dist');
    if (fs.existsSync(candidate)) webDistDir = candidate;
  }

  return {
    port,
    host: env.HOST || '0.0.0.0',
    publicUrl: (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    dataDir,
    databaseUrl: env.DATABASE_URL || null,
    jwtSecret,
    encryptionKey,
    graphVersion,
    graphBaseUrl: env.META_GRAPH_BASE_URL || 'https://graph.facebook.com',
    metaVerifyToken: env.META_VERIFY_TOKEN || null,
    metaAppSecret: env.META_APP_SECRET || null,
    allowSignup: bool(env.ALLOW_SIGNUP, true),
    defaultBillingMode: billing,
    signupCredits: Number(env.SIGNUP_CREDITS || 0),
    anthropicApiKey: env.ANTHROPIC_API_KEY || null,
    broadcastRatePerSecond: Math.max(1, Number(env.BROADCAST_RATE_PER_SECOND || 10)),
    webDistDir,
    isProduction: env.NODE_ENV === 'production',
    logLevel: env.LOG_LEVEL || 'info',
    maxUploadMb: Number(env.MAX_UPLOAD_MB || 16),
    sandboxStatusDelayMs: Number(env.SANDBOX_STATUS_DELAY_MS ?? 800),
    allowPrivateWebhooks: bool(env.ALLOW_PRIVATE_WEBHOOKS, false),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    ...overrides,
  };
}
