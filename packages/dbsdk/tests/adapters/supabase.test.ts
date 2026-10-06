import { describe, expect, it } from 'vitest';

import { CapabilityError, ConfigurationError } from '../../src/adapters/errors.js';
import { supabase } from '../../src/adapters/supabase.js';
import { FakePool } from './helpers.js';

const DIRECT = 'postgresql://postgres:pass@db.abcdefghijklmnopqrst.supabase.co:5432/postgres';
const SESSION = 'postgresql://postgres.abcdefghijklmnopqrst:pass@aws-0-eu-central-1.pooler.supabase.com:5432/postgres';
const TRANSACTION = 'postgresql://postgres.abcdefghijklmnopqrst:pass@aws-0-eu-central-1.pooler.supabase.com:6543/postgres';

function adapterWith(connectionString: string, mode: 'direct' | 'session' | 'transaction', extra = {}) {
  const pools: FakePool[] = [];
  const db = supabase({
    connectionString,
    connectionMode: mode,
    poolFactory: (config) => {
      const pool = new FakePool(config);
      pools.push(pool);
      return pool;
    },
    ...extra,
  });
  return { db, pools };
}

describe('supabase adapter — connection mode validation (never rewrites endpoints)', () => {
  it('rejects transaction mode pointing at port 5432', () => {
    expect(() => supabase({ connectionString: SESSION, connectionMode: 'transaction' })).toThrow(
      ConfigurationError,
    );
    try {
      supabase({ connectionString: SESSION, connectionMode: 'transaction' });
    } catch (error) {
      expect((error as Error).message).toMatch(/6543/);
      expect((error as Error).message).toMatch(/does not rewrite endpoints/);
    }
  });

  it('rejects session mode pointing at the transaction pooler port', () => {
    expect(() => supabase({ connectionString: TRANSACTION, connectionMode: 'session' })).toThrow(
      ConfigurationError,
    );
  });

  it('rejects direct mode pointing at a pooler port', () => {
    expect(() => supabase({ connectionString: TRANSACTION, connectionMode: 'direct' })).toThrow(
      ConfigurationError,
    );
  });

  it('requires a connection mode', () => {
    expect(() =>
      supabase({ connectionString: DIRECT, connectionMode: undefined as unknown as 'direct' }),
    ).toThrow(ConfigurationError);
  });

  it('rejects pooler usernames that are not postgres.<project-ref>', () => {
    const bad = 'postgresql://postgres:pass@aws-0-eu-central-1.pooler.supabase.com:6543/postgres';
    expect(() => supabase({ connectionString: bad, connectionMode: 'transaction' })).toThrow(
      /postgres\.<project-ref>/,
    );
  });

  it('rejects non-postgres URL schemes', () => {
    expect(() =>
      supabase({ connectionString: 'mysql://u:p@host:5432/db', connectionMode: 'direct' }),
    ).toThrow(/postgres/);
  });

  it('can tolerate an intentional mismatch when explicitly allowed', async () => {
    const { db } = adapterWith(SESSION, 'transaction', { allowModeMismatch: true });
    expect(db.capabilities.sessionState).toBe(false);
  });

  it('resolves the project reference without exposing secrets', async () => {
    const { db } = adapterWith(TRANSACTION, 'transaction');
    await db.query('select 1');
    expect(db.raw.resolved).toEqual({
      host: 'aws-0-eu-central-1.pooler.supabase.com',
      port: 6543,
      database: 'postgres',
      projectRef: 'abcdefghijklmnopqrst',
    });
    expect(JSON.stringify(db.raw.resolved)).not.toMatch(/pass/);
  });
});

describe('supabase adapter — capabilities per connection mode', () => {
  it('direct mode: full session state', () => {
    const { db } = adapterWith(DIRECT, 'direct');
    expect(db.capabilities).toMatchObject({
      interactiveTransactions: true,
      atomicBatch: true,
      sessionState: true,
      transport: 'tcp',
    });
  });

  it('session pooler: full session state', () => {
    const { db } = adapterWith(SESSION, 'session');
    expect(db.capabilities.sessionState).toBe(true);
  });

  it('transaction pooler: no session state', () => {
    const { db } = adapterWith(TRANSACTION, 'transaction');
    expect(db.capabilities).toMatchObject({
      interactiveTransactions: true,
      atomicBatch: true,
      sessionState: false,
      transport: 'tcp',
    });
  });
});

describe('supabase adapter — transaction-mode session restrictions', () => {
  it('rejects session-level SET before dispatch, allows SET LOCAL', async () => {
    const { db, pools } = adapterWith(TRANSACTION, 'transaction');

    await expect(db.query('SET statement_timeout = 5000')).rejects.toBeInstanceOf(CapabilityError);
    await expect(db.query('RESET ALL')).rejects.toBeInstanceOf(CapabilityError);
    await expect(db.query('LISTEN channel')).rejects.toBeInstanceOf(CapabilityError);
    await expect(db.query('NOTIFY channel')).rejects.toBeInstanceOf(CapabilityError);
    await expect(db.query('PREPARE plan AS SELECT 1')).rejects.toBeInstanceOf(CapabilityError);
    await expect(db.query('DEALLOCATE plan')).rejects.toBeInstanceOf(CapabilityError);
    await expect(db.query('CREATE TEMP TABLE t (id int)')).rejects.toBeInstanceOf(CapabilityError);
    await expect(db.query('DECLARE c CURSOR WITH HOLD FOR SELECT 1')).rejects.toBeInstanceOf(
      CapabilityError,
    );
    // nothing reached the pool — all rejections happened before dispatch
    expect(pools).toHaveLength(0);

    await expect(db.query('SET LOCAL statement_timeout = 5000')).resolves.toBeTruthy();
    expect(pools[0]!.queries[0]!.text).toBe('SET LOCAL statement_timeout = 5000');
  });

  it('restrictions also apply inside transactions and batches', async () => {
    const { db, pools } = adapterWith(TRANSACTION, 'transaction');

    await expect(
      db.transaction!(async (tx) => {
        await tx.query('select 1');
        await tx.query('LISTEN channel');
      }),
    ).rejects.toBeInstanceOf(CapabilityError);
    // transaction leased a client, started, then failed on the guarded statement
    expect(pools[0]!.clientQueries(1).map((q) => q.text)).toEqual(['BEGIN', 'select 1', 'ROLLBACK']);

    await expect(db.batch!([{ text: 'LISTEN channel' }])).rejects.toBeInstanceOf(CapabilityError);
  });

  it('does not restrict session statements in direct or session modes', async () => {
    const { db, pools } = adapterWith(DIRECT, 'direct');
    await db.query('SET application_name = test');
    expect(pools[0]!.queries[0]!.text).toBe('SET application_name = test');
  });

  it('can be disabled explicitly', async () => {
    const { db, pools } = adapterWith(TRANSACTION, 'transaction', {
      enforceSessionRestrictions: false,
    });
    await db.query('LISTEN channel');
    expect(pools[0]!.queries[0]!.text).toBe('LISTEN channel');
  });
});

describe('supabase adapter — configuration details', () => {
  it('defaults SSL to certificate validation ON for remote endpoints, off for localhost', async () => {
    const remote = adapterWith(TRANSACTION, 'transaction');
    await remote.db.query('select 1');
    expect(remote.pools[0]!.config.ssl).toEqual({ rejectUnauthorized: true });

    const local = supabase({
      connectionString: 'postgresql://postgres:pass@localhost:5432/postgres',
      connectionMode: 'direct',
      poolFactory: (config) => new FakePool(config),
    });
    await local.query('select 1');
    expect((local.raw as unknown as { pool: FakePool }).pool.config.ssl).toBe(false);
  });

  it('lets the user opt out of certificate validation explicitly', async () => {
    const optedOut = adapterWith(TRANSACTION, 'transaction', {
      ssl: { rejectUnauthorized: false },
    });
    await optedOut.db.query('select 1');
    expect(optedOut.pools[0]!.config.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('exposes the pool through raw and passes queries through the shared engine', async () => {
    const { db, pools } = adapterWith(TRANSACTION, 'transaction');
    const result = await db.query('select 1 as one', []);
    expect(result).toEqual({ rows: [], rowCount: 0, command: 'EXECUTE' });
    expect(db.raw.pool).toBe(pools[0]);
    expect(pools[0]!.queries[0]).toEqual({ text: 'select 1 as one', client: 0, named: false });
  });

  it('supports transactions and batches like any TCP adapter', async () => {
    const { db, pools } = adapterWith(TRANSACTION, 'transaction');
    const value = await db.transaction!(async (tx) => {
      await tx.query('insert into t values ($1)', [1]);
      return 'done';
    });
    expect(value).toBe('done');
    expect(pools[0]!.clientQueries(1).map((q) => q.text)).toEqual([
      'BEGIN',
      'insert into t values ($1)',
      'COMMIT',
    ]);

    const results = await db.batch!([{ text: 'select 1' }, { text: 'select 2' }]);
    expect(results).toHaveLength(2);
  });

  it('close() ends the pool', async () => {
    const { db, pools } = adapterWith(TRANSACTION, 'transaction');
    await db.query('select 1');
    await db.close();
    expect(pools[0]!.ended).toBe(true);
  });
});
