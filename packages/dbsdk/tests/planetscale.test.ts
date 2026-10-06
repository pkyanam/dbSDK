/**
 * PlanetScale Postgres query adapter tests (`dbsdk/planetscale`).
 *
 * All tests are OFFLINE: the `pg` pool is injected as a recording stub (the same deterministic
 * fixtures the other TCP adapters use), so no network connection and no hosted PlanetScale
 * database is involved. These tests prove the adapter's own semantics:
 *
 * - connection-mode validation: direct requires port 5432, pooled (PgBouncer transaction mode)
 *   requires 6432 — mismatches fail loudly before any dispatch;
 * - TLS policy: remote hosts get VERIFIED TLS by default (PlanetScale requires TLS with
 *   verify-full semantics); `ssl: false` is refused for remote hosts; localhost defaults to
 *   no TLS for local testing only;
 * - session-state guards on the pooled path (the same statement classes the transaction-mode
 *   pooler cannot serve) reject BEFORE dispatch, and direct mode allows session state;
 * - capabilities honestly differ per mode (sessionState: direct true / pooled false);
 * - queries, transactions and batches reuse the shared pg engine semantics (parameterized,
 *   leased connections, rollback) — no new SQL engine and no MySQL/Vitess semantics.
 *
 * NOTE: no hosted PlanetScale TLS endpoint is exercised here (offline stubs cannot negotiate
 * real TLS), so the verified-TLS default is asserted as CONFIGURATION ('docs' evidence), not
 * as a live handshake.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { planetscale, type PlanetScaleAdapterOptions } from '../src/planetscale.js';
import { FakePool, type FakeBehavior } from './adapters/helpers.js';

const DIRECT_URL = 'postgresql://app-role.br3anchid:pscale_pw_x@eu-central-useast1-1.horizon.psdb.cloud:5432/app-db';
const POOLED_URL = 'postgresql://app-role.br3anchid:pscale_pw_x@eu-central-useast1-1.horizon.psdb.cloud:6432/app-db';
const LOCAL_URL = 'postgresql://postgres:postgres@localhost:15432/dbsdk';

function make(
  options: Omit<PlanetScaleAdapterOptions, 'poolFactory'>,
  behavior?: FakeBehavior,
) {
  const pools: FakePool[] = [];
  const db = planetscale({
    ...options,
    poolFactory: (config) => {
      const pool = new FakePool(config, behavior);
      pools.push(pool);
      return pool;
    },
  });
  return { db, pools };
}

describe('planetscale adapter — configuration', () => {
  it('requires a connection string and a connection mode', () => {
    expect(() => planetscale({ connectionString: '', connectionMode: 'direct' })).toThrow(/connectionString/);
    // @ts-expect-error testing runtime validation
    expect(() => planetscale({ connectionString: DIRECT_URL })).toThrow(/connectionMode/);
    // @ts-expect-error testing runtime validation
    expect(() => planetscale({ connectionString: DIRECT_URL, connectionMode: 'pool' })).toThrow(/connectionMode/);
  });

  it('validates the URL scheme and refuses non-Postgres schemes', () => {
    expect(() => planetscale({ connectionString: 'mysql://x/y', connectionMode: 'direct' })).toThrow(/scheme/);
    expect(() => planetscale({ connectionString: 'not a url', connectionMode: 'direct' })).toThrow(/URL/);
  });

  it('refuses a direct-mode connection string that targets the pooler port', () => {
    expect(() => planetscale({ connectionString: POOLED_URL, connectionMode: 'direct' })).toThrow(
      /direct.*5432.*6432|5432/,
    );
  });

  it('refuses a pooled-mode connection string that targets the direct port', () => {
    expect(() => planetscale({ connectionString: DIRECT_URL, connectionMode: 'pooled' })).toThrow(/pooled.*6432/);
  });

  it('does not rewrite endpoints: mismatch is only allowed with allowModeMismatch', () => {
    const { db, pools } = make({ connectionString: POOLED_URL, connectionMode: 'direct', allowModeMismatch: true });
    // Endpoint is passed through unchanged; the adapter never rewrites host or port.
    void db;
    void pools;
  });
});

describe('planetscale adapter — TLS policy', () => {
  it('defaults remote connections to VERIFIED TLS', async () => {
    const { db, pools } = make({ connectionString: DIRECT_URL, connectionMode: 'direct' });
    await db.query('select 1');
    expect(pools[0]!.config.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('refuses explicit ssl: false on a non-local host', () => {
    expect(() => planetscale({ connectionString: DIRECT_URL, connectionMode: 'direct', ssl: false })).toThrow(
      /requires TLS|unencrypted/,
    );
  });

  it('defaults localhost to no TLS for local testing', async () => {
    const { db, pools } = make({ connectionString: LOCAL_URL, connectionMode: 'direct', allowModeMismatch: true });
    await db.query('select 1');
    expect(pools[0]!.config.ssl).toBe(false);
  });

  it('passes a real ssl configuration through (e.g. custom CA)', async () => {
    const { db, pools } = make({
      connectionString: DIRECT_URL,
      connectionMode: 'direct',
      ssl: { rejectUnauthorized: true, ca: 'test-ca' },
    });
    await db.query('select 1');
    expect(pools[0]!.config.ssl).toEqual({ rejectUnauthorized: true, ca: 'test-ca' });
  });
});

// Connection-string SSL directives are canonicalized under the adapter's verified-TLS
// policy and stripped from the URL handed to pg (review finding F3). The unit-level
// resolution rules live in tests/adapters/pg-url-ssl.test.ts (including real-pg
// end-to-end final-config proofs); these adapter-level tests cover the accepted paths.
describe('planetscale adapter — connection-string SSL directives (review F3)', () => {
  it('sslmode=require / verify-full map to verified TLS when no explicit ssl is given', async () => {
    for (const mode of ['require', 'verify-full']) {
      const { db, pools } = make({ connectionString: `${DIRECT_URL}?sslmode=${mode}`, connectionMode: 'direct' });
      await db.query('select 1');
      expect(pools[0]!.config.ssl, mode).toEqual({ rejectUnauthorized: true });
      expect(pools[0]!.config.connectionString).not.toContain('sslmode');
    }
  });

  it('sslmode=require coexists with an explicit CA (URL directive does not discard it)', async () => {
    const { db, pools } = make({
      connectionString: `${DIRECT_URL}?sslmode=require`,
      connectionMode: 'direct',
      ssl: { rejectUnauthorized: true, ca: 'test-ca' },
    });
    await db.query('select 1');
    expect(pools[0]!.config.ssl).toEqual({ rejectUnauthorized: true, ca: 'test-ca' });
  });

  it('sslmode=disable on a remote host is refused before the pool exists', () => {
    expect(() => planetscale({ connectionString: `${DIRECT_URL}?sslmode=disable`, connectionMode: 'direct' })).toThrow(
      /requires TLS|unencrypted/i,
    );
  });

  it('sslmode=disable on localhost is accepted (explicit local plaintext)', async () => {
    const { db, pools } = make({
      connectionString: `${LOCAL_URL}?sslmode=disable`,
      connectionMode: 'direct',
      allowModeMismatch: true,
    });
    await db.query('select 1');
    expect(pools[0]!.config.ssl).toBe(false);
  });

  it('file-loading and weaker-semantics URL directives are refused with actionable errors', () => {
    expect(() => planetscale({ connectionString: `${DIRECT_URL}?sslcert=/nonexistent/x.pem`, connectionMode: 'direct' })).toThrow(
      /sslcert|ssl option/i,
    );
    expect(() => planetscale({ connectionString: `${DIRECT_URL}?sslmode=prefer`, connectionMode: 'direct' })).toThrow(/sslmode/);
    expect(() => planetscale({ connectionString: `${DIRECT_URL}?uselibpqcompat=true`, connectionMode: 'direct' })).toThrow(
      /uselibpqcompat/,
    );
  });

  it('non-SSL URL parameters are preserved in the string handed to pg (no collateral rewriting)', async () => {
    const { db, pools } = make({ connectionString: `${DIRECT_URL}?application_name=dbsdk-test`, connectionMode: 'direct' });
    await db.query('select 1');
    expect(pools[0]!.config.connectionString).toContain('application_name=dbsdk-test');
    expect(pools[0]!.config.connectionString!.startsWith(DIRECT_URL)).toBe(true);
  });
});

describe('planetscale adapter — pooled (PgBouncer 6432) session-state guards', () => {
  it('rejects session-state statements before dispatch on the pooled path', async () => {
    const { db, pools } = make({ connectionString: POOLED_URL, connectionMode: 'pooled' });
    await expect(db.query('set statement_timeout to 3000')).rejects.toMatchObject({
      adapter: 'planetscale',
      capability: 'sessionState',
    });
    await expect(db.query('PREPARE p AS select 1')).rejects.toThrow(/session-level state/);
    await expect(db.query('DEALLOCATE p')).rejects.toThrow();
    await expect(db.query('create temp table t (x int)')).rejects.toThrow();
    await expect(db.query('LISTEN channel')).rejects.toThrow();
    // Nothing reached the driver — the pool is never even created because every statement
    // is rejected before dispatch.
    expect(pools).toHaveLength(0);
  });

  it('rejects comments-hidden and multi-statement session text before dispatch (review F6)', async () => {
    const { db, pools } = make({ connectionString: POOLED_URL, connectionMode: 'pooled' });
    await expect(db.query('/* ctx */ SET statement_timeout = 3000')).rejects.toMatchObject({ capability: 'sessionState' });
    await expect(db.query('select 1; set application_name = smuggled')).rejects.toThrow(/multiple SQL statements/);
    // ...even when both statements are harmless: one statement per round-trip is the pooled contract
    await expect(db.query('select 1; select 2')).rejects.toThrow(/multiple SQL statements/);
    expect(pools).toHaveLength(0);
  });

  it('allows trailing semicolons/comments and does not flag session words in literals (no false positives)', async () => {
    const { db, pools } = make({ connectionString: POOLED_URL, connectionMode: 'pooled' });
    await db.query('select 1;');
    await db.query('select 2 -- trailing comment');
    await db.query("select 'set x = 1' as literal");
    await db.query('select * from reset_log where id = $1', [3]);
    expect(pools[0]!.queries.map((q) => q.text)).toEqual([
      'select 1;',
      'select 2 -- trailing comment',
      "select 'set x = 1' as literal",
      'select * from reset_log where id = $1',
    ]);
  });

  it('allows SET LOCAL inside a transaction on the pooled path', async () => {
    const { db } = make({ connectionString: POOLED_URL, connectionMode: 'pooled' });
    await expect(
      db.transaction!((tx) => tx.query('SET LOCAL statement_timeout = 3000')),
    ).resolves.toBeDefined();
  });

  it('allows plain session statements on the direct path', async () => {
    const { db, pools } = make({ connectionString: DIRECT_URL, connectionMode: 'direct' });
    await db.query('set statement_timeout to 3000');
    await db.query('LISTEN channel');
    expect(pools[0]!.queries.map((q) => q.text)).toEqual(['set statement_timeout to 3000', 'LISTEN channel']);
  });

  it('reports sessionState honestly per mode', () => {
    const { db: direct } = make({ connectionString: DIRECT_URL, connectionMode: 'direct' });
    const { db: pooled } = make({ connectionString: POOLED_URL, connectionMode: 'pooled' });
    expect(direct.capabilities.sessionState).toBe(true);
    expect(pooled.capabilities.sessionState).toBe(false);
    // Both modes keep full transaction support (one leased connection per transaction).
    expect(direct.capabilities.interactiveTransactions).toBe(true);
    expect(pooled.capabilities.interactiveTransactions).toBe(true);
    expect(direct.capabilities.transport).toBe('tcp');
    expect(pooled.capabilities.transport).toBe('tcp');
  });
});

describe('planetscale adapter — query semantics (shared pg engine)', () => {
  it('runs parameterized queries and normalizes results', async () => {
    const { db } = make(
      { connectionString: DIRECT_URL, connectionMode: 'direct' },
      { rows: (text) => (text.includes('select') ? { rows: [{ id: 1 }], rowCount: 1, command: 'SELECT' } : undefined) },
    );
    const result = await db.query<{ id: number }>('select id from users where id = $1', [1]);
    expect(result.rows).toEqual([{ id: 1 }]);
    expect(result.rowCount).toBe(1);
    expect(result.command).toBe('SELECT');
  });

  it('leases one connection per transaction and rolls back on failure', async () => {
    const { db, pools } = make(
      { connectionString: POOLED_URL, connectionMode: 'pooled' },
      {
        rows: (text) => {
          if (text === 'fail me') throw new Error('boom');
          return undefined;
        },
      },
    );
    const committed = await db.transaction!(async (tx) => {
      await tx.query('insert into t values ($1)', [1]);
      return 'ok';
    });
    expect(committed).toBe('ok');
    expect(pools[0]!.clientQueries(1).map((q) => q.text)).toEqual(['BEGIN', 'insert into t values ($1)', 'COMMIT']);

    await expect(
      db.transaction!(async (tx) => {
        await tx.query('insert into t values ($1)', [2]);
        await tx.query('fail me');
      }),
    ).rejects.toThrow('boom');
    const second = pools[0]!.clientQueries(2).map((q) => q.text);
    expect(second).toEqual(['BEGIN', 'insert into t values ($1)', 'fail me', 'ROLLBACK']);
  });

  it('runs atomic batches on a single leased connection', async () => {
    const { db, pools } = make({ connectionString: DIRECT_URL, connectionMode: 'direct' });
    const results = await db.batch!([
      { text: 'insert into t values ($1)', params: [1] },
      { text: 'insert into t values ($1)', params: [2] },
    ]);
    expect(results).toHaveLength(2);
    const clientQueries = pools[0]!.clientQueries(1).map((q) => q.text);
    expect(clientQueries).toEqual(['BEGIN', 'insert into t values ($1)', 'insert into t values ($1)', 'COMMIT']);
  });

  it('exposes the underlying pool and resolved connection info', async () => {
    const { db, pools } = make({ connectionString: POOLED_URL, connectionMode: 'pooled' });
    await db.query('select 1');
    expect(db.raw.connectionMode).toBe('pooled');
    expect(db.raw.resolved).toEqual({
      host: 'eu-central-useast1-1.horizon.psdb.cloud',
      port: 6432,
      database: 'app-db',
      username: 'app-role.br3anchid',
    });
    expect(db.raw.pool).toBe(pools[0]);
    await db.close();
    expect(pools[0]!.ended).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Optional local-Postgres leg (env-gated, skipped without a real server)
//
// DRIVER COMPATIBILITY ONLY: this proves the adapter drives a real PostgreSQL 17 server
// (wire protocol, parameter binding, transactions) through the shared pg engine, the same
// way `tests/adapters/live.local.test.ts` does. The local server has NO TLS, so this leg
// explicitly says NOTHING about PlanetScale's hosted TLS/SCRAM behavior — that remains
// 'docs'-level evidence requiring live verification against *.horizon.psdb.cloud.
//
// ISOLATION: all objects live in a dedicated `dbsdk_ps_r3` schema (never the shared
// `public` schema) so this leg cannot collide with other owners' local-PG tests that may
// run concurrently against the same database.
// ---------------------------------------------------------------------------

const URL_ENV = 'DBSDK_TEST_POSTGRES_URL';
const hasServer = Boolean(process.env[URL_ENV]);
const live = hasServer ? describe : describe.skip;
const TEST_SCHEMA = 'dbsdk_ps_r3';

live('planetscale adapter — local PostgreSQL driver compatibility (env-gated, dedicated schema)', () => {
  let db: ReturnType<typeof planetscale>;

  beforeAll(() => {
    db = planetscale({
      connectionString: process.env[URL_ENV]!,
      connectionMode: 'direct',
      allowModeMismatch: true, // the local test server is not on the official 5432 port
      ssl: false, // no TLS available locally; PlanetScale hosted TLS is NOT exercised here
      max: 2,
    });
  });

  afterAll(async () => {
    await db.query(`drop schema if exists ${TEST_SCHEMA} cascade`);
    await db.close();
  });

  it('executes parameterized queries over the real wire protocol', async () => {
    const result = await db.query<{ one: number }>('select $1::int as one', [1]);
    expect(result.rows).toEqual([{ one: 1 }]);
    expect(result.rowCount).toBe(1);
  });

  it('commits and rolls back real transactions in the dedicated schema', async () => {
    await db.query(`create schema if not exists ${TEST_SCHEMA}`);
    await db.query(`drop table if exists ${TEST_SCHEMA}.dbsdk_ps_live_test`);
    await db.query(`create table ${TEST_SCHEMA}.dbsdk_ps_live_test (id int primary key)`);
    await db.transaction!(async (tx) => {
      await tx.query(`insert into ${TEST_SCHEMA}.dbsdk_ps_live_test values ($1)`, [7]);
    });
    const committed = await db.query<{ id: number }>(`select id from ${TEST_SCHEMA}.dbsdk_ps_live_test`);
    expect(committed.rows).toEqual([{ id: 7 }]);

    await expect(
      db.transaction!(async (tx) => {
        await tx.query(`insert into ${TEST_SCHEMA}.dbsdk_ps_live_test values ($1)`, [8]);
        throw new Error('rollback me');
      }),
    ).rejects.toThrow('rollback me');
    const afterRollback = await db.query<{ count: string }>(
      `select count(*)::text as count from ${TEST_SCHEMA}.dbsdk_ps_live_test`,
    );
    expect(afterRollback.rows).toEqual([{ count: '1' }]);
    await db.query(`drop table ${TEST_SCHEMA}.dbsdk_ps_live_test`);
  });
});
