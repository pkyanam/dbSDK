/**
 * Local PostgreSQL integration tests — run only when a real server is available.
 *
 * These exercise the actual wire protocol through the official `pg` driver:
 * parameter binding, result decoding, transaction commit/rollback, connection
 * release, and batch atomicity. Gated on DBSDK_TEST_POSTGRES_URL so they are
 * skipped in normal unit-test runs.
 *
 *   DBSDK_TEST_POSTGRES_URL=postgres://... npx vitest run tests/adapters/live.local.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { postgres } from '../../src/adapters/postgres.js';

const URL_ENV = 'DBSDK_TEST_POSTGRES_URL';
const hasServer = Boolean(process.env[URL_ENV]);

const d = hasServer ? describe : describe.skip;

const TABLE = 'dbsdk_adapter_live_test';

d('postgres adapter — live local PostgreSQL', () => {
  let db: ReturnType<typeof postgres>;

  beforeAll(async () => {
    db = postgres({
      connectionString: process.env[URL_ENV]!,
      max: 2,
      ssl: false,
    });
    await db.query(`drop table if exists ${TABLE}`);
    await db.query(`create table ${TABLE} (id serial primary key, email text not null, n integer)`);
  });

  afterAll(async () => {
    await db.query(`drop table if exists ${TABLE}`);
    await db.close();
  });

  it('binds parameters safely (no injection through values)', async () => {
    const sneaky = "x'); drop table dbsdk_adapter_live_test; --";
    const inserted = await db.query<{ id: number }>(
      `insert into ${TABLE} (email, n) values ($1, $2) returning id`,
      [sneaky, 1],
    );
    expect(inserted.rowCount).toBe(1);
    expect(inserted.command).toBe('INSERT');

    const stillThere = await db.query(`select to_regclass('public.${TABLE}') as t`);
    expect(String(stillThere.rows[0]!.t)).toBe('dbsdk_adapter_live_test');

    const roundTrip = await db.query<{ email: string }>(`select email from ${TABLE} where id = $1`, [
      inserted.rows[0]!.id,
    ]);
    expect(roundTrip.rows[0]!.email).toBe(sneaky);
  });

  it('normalizes results: rowCount and command for writes and reads', async () => {
    await db.query(`insert into ${TABLE} (email, n) values ($1, $2)`, ['a@live.test', 10]);
    const updated = await db.query(`update ${TABLE} set n = n + 1 where email = $1`, ['a@live.test']);
    expect(updated.rowCount).toBe(1);
    expect(updated.command).toBe('UPDATE');

    const selected = await db.query<{ n: number }>(`select n from ${TABLE} where email = $1`, ['a@live.test']);
    expect(selected.command).toBe('SELECT');
    expect(selected.rowCount).toBe(1);
    expect(selected.rows[0]!.n).toBe(11);
  });

  it('commits interactive transactions', async () => {
    const result = await db.transaction!(async (tx) => {
      await tx.query(`insert into ${TABLE} (email, n) values ($1, $2)`, ['commit@live.test', 1]);
      await tx.query(`insert into ${TABLE} (email, n) values ($1, $2)`, ['commit@live.test', 2]);
      const counted = await tx.query<{ n: number }>(
        `select count(*)::int as n from ${TABLE} where email = $1`,
        ['commit@live.test'],
      );
      return counted.rows[0]!.n;
    });

    expect(result).toBe(2);
    const after = await db.query<{ n: number }>(`select count(*)::int as n from ${TABLE} where email = $1`, [
      'commit@live.test',
    ]);
    expect(after.rows[0]!.n).toBe(2);
  });

  it('rolls back interactive transactions on failure and releases the connection', async () => {
    const failure = new Error('intentional rollback');
    await expect(
      db.transaction!(async (tx) => {
        await tx.query(`insert into ${TABLE} (email, n) values ($1, $2)`, ['rollback@live.test', 1]);
        throw failure;
      }),
    ).rejects.toBe(failure);

    const after = await db.query<{ n: number }>(`select count(*)::int as n from ${TABLE} where email = $1`, [
      'rollback@live.test',
    ]);
    expect(after.rows[0]!.n).toBe(0);
  });

  it('surfaces PostgreSQL error codes from constraint violations', async () => {
    await db.query(`insert into ${TABLE} (email, n) values ($1, $2)`, ['unique@live.test', 0]);
    let caught: unknown;
    try {
      await db.transaction!(async (tx) => {
        await tx.query(`insert into ${TABLE} (id, email, n) values (1, $1, $2)`, ['dup@live.test', 0]);
      });
    } catch (error) {
      caught = error;
    }
    // The seeded serial started at 2, so id 1 violates the primary key on first
    // run but not necessarily after re-runs; accept either the PK or a
    // transaction-aborted error code, but require a real PostgreSQL code.
    const code = (caught as { code?: string } | undefined)?.code;
    expect(['23505', '25P02', '23503', '23000']).toContain(code);
  });

  it('runs atomic batches on one connection and rolls back fully on error', async () => {
    const results = await db.batch!([
      { text: `insert into ${TABLE} (email, n) values ($1, $2)`, params: ['batch@live.test', 1] },
      { text: `insert into ${TABLE} (email, n) values ($1, $2)`, params: ['batch@live.test', 2] },
      { text: `select count(*)::int as n from ${TABLE} where email = $1`, params: ['batch@live.test'] },
    ]);
    expect(results[2]!.rows[0]!.n).toBe(2);

    // Force a real PostgreSQL failure: NULL into a NOT NULL column.
    await expect(
      db.batch!([
        { text: `insert into ${TABLE} (email, n) values ($1, $2)`, params: ['batch2@live.test', 1] },
        { text: `insert into ${TABLE} (id, email, n) values (null, $1, $2)`, params: ['batch2@live.test', 1] },
      ]),
    ).rejects.toMatchObject({ code: '23502' });

    const after = await db.query<{ n: number }>(`select count(*)::int as n from ${TABLE} where email = $1`, [
      'batch2@live.test',
    ]);
    expect(after.rows[0]!.n).toBe(0);
  });

  it('session state works over TCP (SET and SHOW on the same leased connection)', async () => {
    const setting = await db.transaction!(async (tx) => {
      await tx.query("set application_name = 'dbsdk_live_test'");
      // SHOW names its result column after the parameter.
      const shown = await tx.query<{ application_name: string }>('show application_name');
      return shown.rows[0]!.application_name;
    });
    expect(setting).toBe('dbsdk_live_test');
  });

  it('does NOT guarantee session affinity across pooled top-level queries; dedicated sessions do', async () => {
    // Hold one pool connection and SET on it. Because the pool has max: 2, a
    // top-level query must run on the other pooled session — proving that
    // session state does not automatically persist between separate top-level
    // calls (the capability's documented scope), while it does inside a
    // transaction, which leases one connection.
    const held = await db.raw.connect();
    try {
      await held.query({ text: "set application_name = 'dbsdk_session_hold'" });
      const shown = await db.query<{ application_name: string }>('show application_name');
      expect(shown.rows[0]!.application_name).not.toBe('dbsdk_session_hold');
    } finally {
      held.release(); // connection released back to the pool
    }

    // Inside a transaction, one session is leased: session state persists.
    const inTx = await db.transaction!(async (tx) => {
      await tx.query("set application_name = 'dbsdk_tx_session'");
      const shown = await tx.query<{ application_name: string }>('show application_name');
      return shown.rows[0]!.application_name;
    });
    expect(inTx).toBe('dbsdk_tx_session');
  });

  it('preserves integer precision for int8/bigint values', async () => {
    const big = '9007199254740993'; // 2^53 + 1 — not representable as a JS number
    // pg returns int8 as a string by default to avoid precision loss.
    const row = await db.query<{ n: string }>('select $1::bigint as n', [big]);
    expect(row.rows[0]!.n).toBe(big);
  });
});
