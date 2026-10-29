import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDb, splitSql } from '../db/index.js';
import { migrations } from '../db/migrations.js';

// Every migration that has shipped, with the hash of the SQL installs ran. migrate() only applies a
// name once, so an edited migration never reaches the installs that already applied it: add a new
// migration instead, and its hash here once it ships.
const SHIPPED: Record<string, string> = {
  '001_init': '7735b297853b95b493f36517a026ce5dad25f63c8bb7995a04d951e6a6792333',
  '002_rate_card_seed': 'c2c1db58e4521c48a38ab58537d9d0e66c8d6b228ccdf3ede837552ee6335024',
  '003_wamid_per_workspace': '511c12a973cdf0e76a3a898dffe3d48490ab7350bfefe9ee5b110163b4ec2e3b',
  '004_hardening': '628ed1af392c95ab32084befc288ac3322f8cfd9e244068743e1dc443dfa249d',
  '005_review_three': 'eddff075995034a5260f0846fefe5717f21824ccdce0d807585e8fbe40843fd9',
  '006_review_four': 'b0226a1d67a392f54ad16df358faed790c9810b619dfae01f11021a141ba0bc8',
};

describe('migrations', () => {
  it('never change once shipped', () => {
    for (const [name, hash] of Object.entries(SHIPPED)) {
      const m = migrations.find((x) => x.name === name);
      expect(m, name).toBeDefined();
      expect(createHash('sha256').update(m!.sql).digest('hex'), `${name} was edited: add a new migration instead`).toBe(hash);
    }
    // Shipped ones stay first and in order.
    expect(migrations.slice(0, Object.keys(SHIPPED).length).map((m) => m.name)).toEqual(Object.keys(SHIPPED));
  });

  it('an install upgraded through 004 stops trusting prepaid numbers a business may hold the secret of', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leadlibre-mig-'));
    const { PGlite } = await import('@electric-sql/pglite');
    const old = await PGlite.create(path.join(dir, 'pgdata')); // where createDb keeps an embedded database
    await old.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const apply = async (name: string) => {
      const m = migrations.find((x) => x.name === name)!;
      await old.transaction(async (t) => {
        for (const stmt of splitSql(m.sql)) await t.query(stmt);
        await t.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [name]);
      });
    };
    for (const name of ['001_init', '002_rate_card_seed', '003_wamid_per_workspace']) await apply(name);
    // A business connected its own app while paying Meta directly; the operator then made it prepaid.
    const ws = (await old.query<{ id: string }>(`INSERT INTO workspaces (name, billing_mode) VALUES ('Tienda', 'prepaid') RETURNING id`)).rows[0].id;
    await old.query(
      `INSERT INTO channels (workspace_id, provider, name, phone_number_id, waba_id, verify_token, status)
       VALUES ($1, 'cloud_api', 'Propio', '111222333', '444555666', 'vt-mig', 'active')`,
      [ws],
    );
    const direct = (await old.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('Directo') RETURNING id`)).rows[0].id;
    await old.query(
      `INSERT INTO channels (workspace_id, provider, name, phone_number_id, waba_id, verify_token, status)
       VALUES ($1, 'cloud_api', 'Directo', '777888999', '123123123', 'vt-mig2', 'active')`,
      [direct],
    );
    await apply('004_hardening'); // as ef96be8 shipped it: marks the prepaid number verified
    expect((await old.query<any>(`SELECT operator_verified FROM channels WHERE workspace_id = $1`, [ws])).rows[0].operator_verified).toBe(true);
    await old.close();

    const db = await createDb({ databaseUrl: null, dataDir: dir });
    try {
      const prepaid = (await db.query<any>(`SELECT status, operator_verified, last_error FROM channels WHERE workspace_id = $1`, [ws])).rows[0];
      expect(prepaid.operator_verified).toBe(false);
      expect(prepaid.status).toBe('disabled');
      expect(prepaid.last_error).toMatch(/prepagados/);
      const other = (await db.query<any>(`SELECT status, operator_verified FROM channels WHERE workspace_id = $1`, [direct])).rows[0];
      expect(other).toEqual({ status: 'active', operator_verified: false }); // paying Meta directly: untouched
      const names = (await db.query<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY name`)).rows.map((r) => r.name);
      expect(names).toEqual(migrations.map((m) => m.name).sort());
    } finally {
      await db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
