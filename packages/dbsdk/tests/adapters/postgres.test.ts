import { describe, expect, it } from 'vitest';

import { postgres } from '../../src/adapters/postgres.js';
import { FakePool, type FakeBehavior } from './helpers.js';

const URL = 'postgres://user:pass@localhost:5432/app';

function adapterWith(behavior?: FakeBehavior) {
  const pools: FakePool[] = [];
  const db = postgres({
    connectionString: URL,
    poolFactory: (config) => {
      const pool = new FakePool(config, behavior);
      pools.push(pool);
      return pool;
    },
  });
  return { db, pools };
}

describe('postgres adapter — configuration', () => {
  it('requires a connection string', () => {
    expect(() => postgres({ connectionString: '' })).toThrow(/connectionString/);
  });

  it('creates the pool lazily on first use, with expected defaults', async () => {
    const { db, pools } = adapterWith();
    expect(pools).toHaveLength(0); // no side effects at construction

    await db.query('select 1');

    expect(pools).toHaveLength(1);
    expect(pools[0]!.config).toMatchObject({
      connectionString: URL,
      max: 10,
      application_name: 'dbsdk',
    });
  });

  it('passes through sizing, timeout, and ssl options', async () => {
    const pools: FakePool[] = [];
    const db = postgres({
      connectionString: URL,
      max: 3,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 2000,
      statementTimeout: 1500,
      ssl: false,
      poolFactory: (config) => {
        const pool = new FakePool(config);
        pools.push(pool);
        return pool;
      },
    });
    await db.query('select 1');
    expect(pools[0]!.config).toMatchObject({
      max: 3,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 2000,
      statement_timeout: 1500,
      ssl: false,
    });
  });

  it('exposes the live pool through the raw escape hatch', async () => {
    const { db, pools } = adapterWith();
    await db.query('select 1');
    expect(db.raw).toBe(pools[0]);
    await db.close();
  });
});

describe('postgres adapter — query', () => {
  it('returns the normalized result shape', async () => {
    const { db } = adapterWith({
      rows: (text) =>
        text.includes('from users')
          ? { rows: [{ id: 1, email: 'a@b.c' }], rowCount: 1, command: 'SELECT' }
          : undefined,
    });

    const result = await db.query<{ id: number; email: string }>('select * from users where id = $1', [1]);

    expect(result).toEqual({ rows: [{ id: 1, email: 'a@b.c' }], rowCount: 1, command: 'SELECT' });
  });

  it('binds parameters instead of interpolating them', async () => {
    const { db, pools } = adapterWith();
    await db.query('select * from users where email = $1', ["robert'); drop table users;--"]);

    expect(pools[0]!.queries[0]).toMatchObject({
      text: 'select * from users where email = $1',
      values: ["robert'); drop table users;--"],
    });
  });

  it('uses the simple query protocol (no values) when there are no parameters', async () => {
    const { db, pools } = adapterWith();
    await db.query('select 1');
    expect(pools[0]!.queries[0]).toEqual({ text: 'select 1', client: 0, named: false });
  });

  it('never creates reusable named prepared statements', async () => {
    const { db, pools } = adapterWith();
    await db.query('select 1', [1]);
    await db.query('select 2', [2]);
    for (const q of pools[0]!.queries) {
      expect(q.named).toBe(false);
    }
  });

  it('propagates driver errors untouched, preserving the error code', async () => {
    const failure = Object.assign(new Error('relation "missing" does not exist'), { code: '42P01' });
    const { db } = adapterWith({ fail: () => failure });

    let caught: unknown;
    try {
      await db.query('select * from missing');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect((failure as { code?: string }).code).toBe('42P01');
  });
});

describe('postgres adapter — transaction', () => {
  it('leases one connection: BEGIN, callback queries, COMMIT, release', async () => {
    const { db, pools } = adapterWith({
      rows: (text) => (text.includes('count') ? { rows: [{ n: 1 }], rowCount: 1, command: 'SELECT' } : undefined),
    });

    const value = await db.transaction!(async (tx) => {
      const first = await tx.query('select count(*) as n from users');
      await tx.query("insert into users (email) values ($1)", ['tx@example.com']);
      return first.rows[0]!.n;
    });

    expect(value).toBe(1);
    const clientQueries = pools[0]!.clientQueries(1);
    expect(clientQueries.map((q) => q.text)).toEqual([
      'BEGIN',
      'select count(*) as n from users',
      "insert into users (email) values ($1)",
      'COMMIT',
    ]);
    expect(pools[0]!.releasedCount).toBe(1);
    expect(pools[0]!.clients[0]!.released).toBe(true);
  });

  it('rolls back and releases when the callback throws, rethrowing the original error', async () => {
    const { db, pools } = adapterWith();
    const original = new Error('business rule violated');

    await expect(
      db.transaction!(async (tx) => {
        await tx.query('insert into users (email) values ($1)', ['x@example.com']);
        throw original;
      }),
    ).rejects.toBe(original);

    const texts = pools[0]!.clientQueries(1).map((q) => q.text);
    expect(texts).toEqual(['BEGIN', 'insert into users (email) values ($1)', 'ROLLBACK']);
    expect(pools[0]!.releasedCount).toBe(1);
  });

  it('rolls back and releases when COMMIT itself fails, and surfaces the COMMIT error', async () => {
    const commitFailure = Object.assign(new Error('could not serialize access'), { code: '40001' });
    const { db, pools } = adapterWith({ fail: (text) => (text === 'COMMIT' ? commitFailure : undefined) });

    await expect(db.transaction!(async (tx) => void (await tx.query('select 1')))).rejects.toBe(commitFailure);

    const texts = pools[0]!.clientQueries(1).map((q) => q.text);
    expect(texts).toEqual(['BEGIN', 'select 1', 'COMMIT', 'ROLLBACK']);
    expect(pools[0]!.releasedCount).toBe(1);
  });

  it('releases the connection even when rollback fails', async () => {
    const original = new Error('boom');
    const rollbackFailure = new Error('connection terminated');
    const { db, pools } = adapterWith({
      fail: (text) => (text === 'ROLLBACK' ? rollbackFailure : undefined),
    });

    await expect(
      db.transaction!(async (tx) => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(pools[0]!.releasedCount).toBe(1);
  });
});

describe('postgres adapter — batch', () => {
  it('runs all statements atomically on one leased connection', async () => {
    const { db, pools } = adapterWith({
      rows: (text) => (text.includes('users') ? { rows: [{ id: 1 }], rowCount: 1, command: 'SELECT' } : undefined),
    });

    const results = await db.batch!([
      { text: "insert into users (email) values ($1)", params: ['a@example.com'] },
      { text: 'select id from users' },
    ]);

    expect(results).toHaveLength(2);
    expect(results[1]).toEqual({ rows: [{ id: 1 }], rowCount: 1, command: 'SELECT' });

    const texts = pools[0]!.clientQueries(1).map((q) => q.text);
    expect(texts).toEqual(['BEGIN', 'insert into users (email) values ($1)', 'select id from users', 'COMMIT']);
    expect(pools[0]!.clientQueries(1)[1]!.values).toEqual(['a@example.com']);
    expect(pools[0]!.releasedCount).toBe(1);
  });

  it('returns an empty array without touching the database for an empty batch', async () => {
    const { db, pools } = adapterWith();
    expect(await db.batch!([])).toEqual([]);
    expect(pools).toHaveLength(0);
  });

  it('rolls back the whole batch when a statement fails', async () => {
    const statementFailure = Object.assign(new Error('duplicate key'), { code: '23505' });
    const { db, pools } = adapterWith({
      fail: (text) => (text.includes('bad_table') ? statementFailure : undefined),
    });

    await expect(
      db.batch!([
        { text: "insert into users (email) values ($1)", params: ['a@example.com'] },
        { text: 'select * from bad_table' },
      ]),
    ).rejects.toBe(statementFailure);

    const texts = pools[0]!.clientQueries(1).map((q) => q.text);
    expect(texts).toEqual(['BEGIN', 'insert into users (email) values ($1)', 'select * from bad_table', 'ROLLBACK']);
    expect(pools[0]!.releasedCount).toBe(1);
  });
});

describe('postgres adapter — lifecycle', () => {
  it('closes the pool and rejects further use', async () => {
    const { db, pools } = adapterWith();
    await db.query('select 1');
    await db.close();
    expect(pools[0]!.ended).toBe(true);
    await expect(db.query('select 1')).rejects.toThrow(/closed/);
  });

  it('close() is idempotent when the pool was never used', async () => {
    const { db, pools } = adapterWith();
    await expect(db.close()).resolves.toBeUndefined();
    expect(pools).toHaveLength(0);
  });
});

describe('postgres adapter — capabilities', () => {
  it('reports full TCP capabilities with test-level evidence', () => {
    const { db } = adapterWith();
    expect(db.capabilities).toEqual({
      interactiveTransactions: true,
      atomicBatch: true,
      sessionState: true,
      transport: 'tcp',
      evidence: {
        interactiveTransactions: 'tests',
        atomicBatch: 'tests',
        sessionState: 'tests',
        transport: 'docs',
      },
    });
    expect(db.id).toBe('postgres');
    expect(db.engine).toBe('postgresql');
  });
});
