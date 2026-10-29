import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { migrations } from './migrations.js';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Run a multi-statement SQL script without parameters. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  kind: 'postgres' | 'pglite';
}

// NUMERIC comes back as string by default; we only store money-like values in it.
pg.types.setTypeParser(1700, (v) => parseFloat(v));
pg.types.setTypeParser(20, (v) => Number(v));

function createPgDb(url: string, onIdleError?: (err: Error) => void): Db {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  // A connection that drops while idle in the pool (database restart or failover, a proxy's idle
  // timeout) is already discarded and replaced on demand. Without a listener the pool re-emits the
  // error as an unhandled 'error' event, which ends the whole process.
  pool.on('error', (err) => onIdleError?.(err));
  return {
    kind: 'postgres',
    async query(sql, params = []) {
      const r = await pool.query(sql, params as any[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    async tx(fn) {
      const client = await pool.connect();
      // While checked out the pool's own listener is detached: a connection that drops mid-transaction
      // (restart, failover, pg_terminate_backend, a proxy reset) would emit an unhandled 'error' and end
      // the process. The pending query rejects on its own; the broken client is discarded on release.
      let broken: Error | undefined;
      const onError = (err: Error) => {
        broken ??= err;
        onIdleError?.(err);
      };
      client.on('error', onError);
      try {
        await client.query('BEGIN');
        const q: Queryable = {
          async query(sql, params = []) {
            const r = await client.query(sql, params as any[]);
            return { rows: r.rows, rowCount: r.rowCount ?? 0 };
          },
        };
        const out = await fn(q);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        // A ROLLBACK that fails leaves the connection in an unknown state: never reuse it.
        await client.query('ROLLBACK').catch((e: Error) => {
          broken ??= e;
        });
        throw err;
      } finally {
        client.off('error', onError);
        client.release(broken);
      }
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async close() {
      await pool.end();
    },
  };
}

async function createPgliteDb(dir: string | null): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const db = await PGlite.create(dir ?? undefined, {
    parsers: { 1700: (v: string) => parseFloat(v), 20: (v: string) => Number(v) },
  });
  const wrap = (r: { rows: any[]; affectedRows?: number }) => ({
    rows: r.rows,
    rowCount: r.affectedRows ?? r.rows.length,
  });
  return {
    kind: 'pglite',
    async query(sql, params = []) {
      return wrap(await db.query(sql, params as any[]));
    },
    async tx(fn) {
      return db.transaction(async (t) =>
        fn({
          async query(sql, params = []) {
            return wrap(await t.query(sql, params as any[]));
          },
        }),
      );
    },
    async exec(sql) {
      await db.exec(sql);
    },
    async close() {
      await db.close();
    },
  };
}

/**
 * With DATABASE_URL we use a regular PostgreSQL server. Without it we run an
 * embedded PostgreSQL (PGlite) stored in DATA_DIR/pgdata: zero setup for small teams.
 * Pass dataDir = null for an in-memory database (tests).
 */
export async function createDb(opts: { databaseUrl: string | null; dataDir: string | null; onIdleError?: (err: Error) => void }): Promise<Db> {
  const db = opts.databaseUrl
    ? createPgDb(opts.databaseUrl, opts.onIdleError)
    : await createPgliteDb(opts.dataDir ? path.join(opts.dataDir, 'pgdata') : null);
  await migrate(db);
  return db;
}

export async function migrate(db: Db): Promise<void> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const { rows } = await db.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  for (const m of migrations) {
    if (applied.has(m.name)) continue;
    await db.tx(async (q) => {
      for (const stmt of splitSql(m.sql)) await q.query(stmt);
      await q.query('INSERT INTO schema_migrations (name) VALUES ($1)', [m.name]);
    });
  }
}

/** Splits a migration on semicolons that end a line (our migrations avoid functions with bodies). */
export function splitSql(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^(--[^\n]*\n?)+$/.test(s));
}
