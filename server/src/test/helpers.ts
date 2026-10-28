import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp, type BuiltApp } from '../app.js';
import { loadConfig, type Config } from '../config.js';
import { createDb } from '../db/index.js';

export interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

type Route = (call: FakeCall) => { status?: number; json?: unknown; body?: string | Uint8Array; headers?: Record<string, string> } | undefined;

/** Fake fetch: routes are tried in order; every call is recorded. */
export function fakeFetch(routes: Route[] = []) {
  const calls: FakeCall[] = [];
  const fn = (async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    const h = new Headers(init.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined));
    h.forEach((v, k) => (headers[k] = v));
    let body: any = init.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep string */
      }
    }
    const call = { url, method: (init.method ?? 'GET').toUpperCase(), headers, body };
    calls.push(call);
    for (const r of routes) {
      const out = r(call);
      if (out) {
        const payload = out.json !== undefined ? JSON.stringify(out.json) : (out.body ?? '');
        return new Response(payload as any, {
          status: out.status ?? 200,
          headers: { 'content-type': out.json !== undefined ? 'application/json' : 'application/octet-stream', ...(out.headers ?? {}) },
        });
      }
    }
    return new Response(JSON.stringify({ error: { message: `no fake route for ${call.method} ${url}`, code: 100 } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: fn, calls, routes };
}

export interface TestEnv {
  built: BuiltApp;
  config: Config;
  /** opts.workspaceId is accepted as an alias of opts.ws so register() results can be passed directly. */
  api: (
    method: string,
    url: string,
    body?: unknown,
    opts?: { cookie?: string; ws?: string | null; workspaceId?: string; headers?: Record<string, string> },
  ) => Promise<{ status: number; body: any; headers: any; raw: string }>;
  register: (email?: string, workspaceName?: string) => Promise<{ cookie: string; userId: string; workspaceId: string }>;
  drain: () => Promise<void>;
  close: () => Promise<void>;
}

let counter = 0;

export async function setup(opts: { fetch?: typeof fetch; config?: Partial<Config> } = {}): Promise<TestEnv> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leadlibre-test-'));
  const config = loadConfig(
    { DATA_DIR: dir, JWT_SECRET: 'test-secret', ENCRYPTION_KEY: 'test-key', PUBLIC_URL: 'https://crm.test', LOG_LEVEL: 'silent' },
    { sandboxStatusDelayMs: 0, broadcastRatePerSecond: 1000, webDistDir: null, ...opts.config },
  );
  // With TEST_DATABASE_URL every test file gets its own fresh PostgreSQL database.
  let databaseUrl: string | null = null;
  let dropDb: (() => Promise<void>) | null = null;
  if (process.env.TEST_DATABASE_URL) {
    const pg = (await import('pg')).default;
    const name = `leadlibre_t_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const u = new URL(process.env.TEST_DATABASE_URL);
    u.pathname = `/${name}`;
    databaseUrl = u.toString();
    dropDb = async () => {
      const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    };
  }
  const db = await createDb({ databaseUrl, dataDir: null });
  const built = await buildApp(config, { db, fetch: opts.fetch, logger: false });
  built.ctx.realtime.recordHistory = true;
  let defaultCookie = '';
  let defaultWs = '';

  const api: TestEnv['api'] = async (method, url, body, o = {}) => {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    const cookie = o.cookie ?? defaultCookie;
    if (cookie) headers.cookie = cookie;
    const ws = o.ws === undefined ? (o.workspaceId ?? defaultWs) : o.ws;
    if (ws) headers['x-workspace-id'] = ws;
    const res = await built.app.inject({ method: method as any, url, headers, ...(body !== undefined ? { payload: body as any } : {}) });
    let parsed: any = res.body;
    try {
      parsed = res.body ? JSON.parse(res.body) : null;
    } catch {
      /* not json */
    }
    return { status: res.statusCode, body: parsed, headers: res.headers, raw: res.body };
  };

  const register: TestEnv['register'] = async (email, workspaceName = 'Mi Negocio') => {
    const e = email ?? `user${++counter}-${Date.now()}@test.com`;
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { name: 'Dueño', email: e, password: 'secreto123', workspaceName },
      remoteAddress: `10.0.${counter % 250}.${(Date.now() % 250) + 1}`,
    });
    if (res.statusCode !== 200) throw new Error(`register failed: ${res.body}`);
    const cookie = `ll_token=${res.cookies.find((c) => c.name === 'll_token')!.value}`;
    const body = JSON.parse(res.body);
    if (!defaultCookie) {
      defaultCookie = cookie;
      defaultWs = body.workspaces[0].id;
    }
    return { cookie, userId: body.user.id, workspaceId: body.workspaces[0].id };
  };

  return {
    built,
    config,
    api,
    register,
    drain: () => built.worker.drain(),
    close: async () => {
      await built.close();
      await dropDb?.();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
