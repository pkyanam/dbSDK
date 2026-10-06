import { describe, expect, it } from 'vitest';

import { CapabilityError, ConfigurationError } from '../../src/adapters/errors.js';
import { neon } from '../../src/adapters/neon.js';
import { createDatabase } from '../../src/core/database.js';
import { hasUncertainOutcome } from '../../src/errors.js';
import { FakePool, type FakeBehavior } from './helpers.js';

type FakeTransactionCall = { queryCount: number; opts: Record<string, unknown> | undefined; queryTexts: string[] };

function fakeHttpNeon(
  overrides: {
    rows?: (text: string) => Record<string, unknown> | undefined;
    transactionError?: Error;
  } = {},
) {
  const calls = {
    createdWith: [] as Array<{ connectionString: string; options: Record<string, unknown> | undefined }>,
    queries: [] as Array<{ text: string; values: unknown[] }>,
    transactions: [] as FakeTransactionCall[],
  };

  const sql = ((strings: TemplateStringsArray) => {
    // tagged-template form is not used by the adapter itself
    throw new Error('fake: tagged template not used by adapter');
  }) as unknown as {
    query: (text: string, params?: unknown[]) => Promise<unknown>;
    transaction: (queries: unknown[], opts?: Record<string, unknown>) => Promise<unknown[]>;
  };

  sql.query = (text, params) => {
    calls.queries.push({ text, values: params ?? [] });
    const custom = overrides.rows?.(text);
    // Emulate NeonQueryPromise: the driver attaches query metadata to the
    // promise so `sql.transaction([...])` can pick it up without awaiting.
    return Object.assign(Promise.resolve(custom ?? { rows: [], rowCount: 0, command: 'EXECUTE' }), {
      __query: { text, values: params ?? [] },
    });
  };

  sql.transaction = (queries, opts) => {
    // The adapter must pass the unawaited query promises, not awaited results.
    const queryTexts = (queries as Array<{ __query?: { text: string } }>).map(
      (q) => q.__query?.text ?? '<unknown>',
    );
    calls.transactions.push({ queryCount: queries.length, opts, queryTexts });
    if (overrides.transactionError) {
      return Promise.reject(overrides.transactionError);
    }
    return Promise.resolve(queries.map(() => ({ rows: [], rowCount: 0, command: 'EXECUTE' })));
  };

  const factory = (connectionString: string, options?: Record<string, unknown>) => {
    calls.createdWith.push({ connectionString, options });
    return sql as never;
  };

  return { calls, factory };
}

describe('neon adapter — http transport (default)', () => {
  it('requires a connection string', () => {
    expect(() => neon({ connectionString: '' })).toThrow(/connectionString/);
  });

  it('reports honest http capabilities by default', () => {
    const db = neon({ connectionString: 'postgres://u:p@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb' });
    expect(db.id).toBe('neon');
    expect(db.capabilities).toEqual({
      interactiveTransactions: false,
      atomicBatch: true,
      sessionState: false,
      transport: 'http',
      evidence: {
        interactiveTransactions: 'docs',
        atomicBatch: 'docs',
        sessionState: 'docs',
        transport: 'docs',
      },
    });
  });

  it('queries with bound parameters and returns the normalized shape', async () => {
    const { factory, calls } = fakeHttpNeon({
      rows: (text) => (text.includes('users') ? { rows: [{ id: 1 }], rowCount: 1, command: 'SELECT' } : undefined),
    });
    const db = neon({ connectionString: 'postgres://u:p@ep-x.neon.tech/db', neonFactory: factory });

    const result = await db.query<{ id: number }>('select * from users where id = $1', [1]);

    expect(result).toEqual({ rows: [{ id: 1 }], rowCount: 1, command: 'SELECT' });
    expect(calls.queries[0]).toEqual({ text: 'select * from users where id = $1', values: [1] });
  });

  it('exposes the driver query function through raw', () => {
    const { factory } = fakeHttpNeon();
    const db = neon({ connectionString: 'postgres://u:p@ep-x.neon.tech/db', neonFactory: factory });
    expect(db.raw.transport).toBe('http');
    expect(typeof (db.raw as { sql: unknown }).sql).toBe('function');
  });

  it('runs atomic batches as a single native transaction round-trip', async () => {
    const { factory, calls } = fakeHttpNeon();
    const db = neon({ connectionString: 'postgres://u:p@ep-x.neon.tech/db', neonFactory: factory });

    const results = await db.batch!([
      { text: 'insert into t values ($1)', params: [1] },
      { text: 'select * from t' },
    ]);

    expect(results).toHaveLength(2);
    expect(calls.transactions).toHaveLength(1);
    expect(calls.transactions[0]!.queryCount).toBe(2);
    expect(calls.transactions[0]!.opts).toEqual({ fullResults: true });
    expect(calls.transactions[0]!.queryTexts).toEqual(['insert into t values ($1)', 'select * from t']);
    expect(calls.queries.map((q) => q.text)).toEqual(['insert into t values ($1)', 'select * from t']);
    expect(calls.queries[0]!.values).toEqual([1]);
  });

  it('skips the network entirely for an empty batch', async () => {
    const { factory, calls } = fakeHttpNeon();
    const db = neon({ connectionString: 'postgres://u:p@ep-x.neon.tech/db', neonFactory: factory });
    expect(await db.batch!([])).toEqual([]);
    expect(calls.transactions).toHaveLength(0);
  });

  it('marks a lost batch response with an uncertain outcome when the batch writes', async () => {
    // One HTTP round-trip: if the response is lost after the server applied the
    // batch, the write may or may not have committed. The error must carry the
    // uncertain-outcome marker so the core client reports `indeterminate: true`.
    const { factory } = fakeHttpNeon({
      transactionError: new Error('fetch failed: network error'),
    });
    const db = neon({ connectionString: 'postgres://u:p@ep-x.neon.tech/db', neonFactory: factory });
    let caught: unknown;
    try {
      await db.batch!([{ text: 'insert into t values ($1)', params: [1] }]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(hasUncertainOutcome(caught)).toBe(true);

    // Through the core client this becomes a visible indeterminate flag.
    const coreDb = createDatabase({
      adapter: neon({ connectionString: 'postgres://u:p@ep-x.neon.tech/db', neonFactory: factory }),
    });
    const normalized = await coreDb
      .batch([{ text: 'insert into t values ($1)', params: [1] }])
      .catch((e) => e);
    expect(normalized).toMatchObject({ indeterminate: true });
  });

  it('does not mark read-only batches with an uncertain outcome', async () => {
    const { factory } = fakeHttpNeon({
      transactionError: new Error('fetch failed: network error'),
    });
    const db = neon({ connectionString: 'postgres://u:p@ep-x.neon.tech/db', neonFactory: factory });
    let caught: unknown;
    try {
      await db.batch!([{ text: 'select 1' }]);
    } catch (error) {
      caught = error;
    }
    expect(hasUncertainOutcome(caught)).toBe(false);
  });

  it('fails interactive transactions before dispatch with actionable guidance', async () => {
    const { factory } = fakeHttpNeon();
    const db = neon({ connectionString: 'postgres://u:p@ep-x.neon.tech/db', neonFactory: factory });

    let caught: unknown;
    try {
      await db.transaction!(async () => {
        throw new Error('should never run');
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CapabilityError);
    expect((caught as Error).message).toMatch(/interactive transactions are not supported over HTTP/);
    expect((caught as Error).message).toMatch(/db\.batch|transactionTransport/);
  });

  it('close() resolves without network activity on pure http', async () => {
    const { factory } = fakeHttpNeon();
    const db = neon({ connectionString: 'postgres://u:p@ep-x.neon.tech/db', neonFactory: factory });
    await expect(db.close()).resolves.toBeUndefined();
  });
});

describe('neon adapter — interactive transactions over postgres transport', () => {
  const directUrl = 'postgres://u:p@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb';

  it('reports interactive transactions as available', () => {
    const { factory } = fakeHttpNeon();
    const db = neon({
      connectionString: directUrl,
      transactionTransport: 'postgres',
      postgresConnectionString: directUrl,
      neonFactory: factory,
      poolFactory: (config) => new FakePool(config),
    });
    expect(db.capabilities.interactiveTransactions).toBe(true);
    expect(db.capabilities.transport).toBe('http');
    // Queries still travel over HTTP, which has no session state; only the
    // optional TCP transaction path can carry session state.
    expect(db.capabilities.sessionState).toBe(false);
  });

  it('requires the direct-endpoint connection string and never guesses it', async () => {
    const { factory } = fakeHttpNeon();
    const db = neon({
      connectionString: directUrl,
      transactionTransport: 'postgres',
      neonFactory: factory,
      poolFactory: (config) => new FakePool(config),
    });

    await expect(db.transaction!(async () => undefined)).rejects.toBeInstanceOf(ConfigurationError);
    await expect(db.transaction!(async () => undefined)).rejects.toThrow(/postgresConnectionString/);
  });

  it('leases one connection: BEGIN, callback, COMMIT, release', async () => {
    const { factory } = fakeHttpNeon();
    const pools: FakePool[] = [];
    const db = neon({
      connectionString: directUrl,
      transactionTransport: 'postgres',
      postgresConnectionString: directUrl,
      neonFactory: factory,
      poolFactory: (config) => {
        const pool = new FakePool(config, {
          rows: (text) => (text.includes('count') ? { rows: [{ n: 7 }], rowCount: 1, command: 'SELECT' } : undefined),
        });
        pools.push(pool);
        return pool;
      },
    });

    const value = await db.transaction!(async (tx) => {
      const r = await tx.query<{ n: number }>('select count(*) as n from t');
      await tx.query('insert into t values ($1)', [1]);
      return r.rows[0]!.n;
    });

    expect(value).toBe(7);
    const texts = pools[0]!.clientQueries(1).map((q) => q.text);
    expect(texts).toEqual(['BEGIN', 'select count(*) as n from t', 'insert into t values ($1)', 'COMMIT']);
    expect(pools[0]!.releasedCount).toBe(1);
  });

  it('rolls back and releases when the callback fails', async () => {
    const { factory } = fakeHttpNeon();
    const pools: FakePool[] = [];
    const db = neon({
      connectionString: directUrl,
      transactionTransport: 'postgres',
      postgresConnectionString: directUrl,
      neonFactory: factory,
      poolFactory: (config) => {
        const pool = new FakePool(config);
        pools.push(pool);
        return pool;
      },
    });

    const failure = new Error('constraint violated');
    await expect(
      db.transaction!(async (tx) => {
        await tx.query('insert into t values (1)');
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(pools[0]!.clientQueries(1).map((q) => q.text)).toEqual([
      'BEGIN',
      'insert into t values (1)',
      'ROLLBACK',
    ]);
    expect(pools[0]!.releasedCount).toBe(1);
  });

  it('close() ends the postgres pool it created', async () => {
    const { factory } = fakeHttpNeon();
    const pools: FakePool[] = [];
    const db = neon({
      connectionString: directUrl,
      transactionTransport: 'postgres',
      postgresConnectionString: directUrl,
      neonFactory: factory,
      poolFactory: (config) => {
        const pool = new FakePool(config);
        pools.push(pool);
        return pool;
      },
    });

    await db.transaction!(async () => undefined);
    await db.close();
    expect(pools).toHaveLength(1);
    expect(pools[0]!.ended).toBe(true);
  });
});

describe('neon adapter — interactive transactions over websocket transport', () => {
  const directUrl = 'postgres://u:p@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb';

  it('runs the transaction on a short-lived pool that is always closed', async () => {
    const { factory } = fakeHttpNeon();
    const pools: FakePool[] = [];
    const db = neon({
      connectionString: directUrl,
      transactionTransport: 'websocket',
      neonFactory: factory,
      websocketPoolFactory: (config) => {
        const pool = new FakePool(config);
        pools.push(pool);
        return pool;
      },
    });

    const value = await db.transaction!(async (tx) => {
      await tx.query('select 1');
      return 'ok';
    });

    expect(value).toBe('ok');
    expect(pools).toHaveLength(1);
    expect(pools[0]!.config).toMatchObject({ connectionString: directUrl, max: 1 });
    expect(pools[0]!.clientQueries(1).map((q) => q.text)).toEqual(['BEGIN', 'select 1', 'COMMIT']);
    expect(pools[0]!.releasedCount).toBe(1);
    expect(pools[0]!.ended).toBe(true); // pool closed even though close() was never called
  });

  it('closes the pool even when the callback fails', async () => {
    const { factory } = fakeHttpNeon();
    const pools: FakePool[] = [];
    const db = neon({
      connectionString: directUrl,
      transactionTransport: 'websocket',
      neonFactory: factory,
      websocketPoolFactory: (config) => {
        const pool = new FakePool(config);
        pools.push(pool);
        return pool;
      },
    });

    await expect(
      db.transaction!(async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');

    expect(pools[0]!.ended).toBe(true);
    expect(pools[0]!.releasedCount).toBe(1);
  });

  it('queries still travel over http', async () => {
    const { factory, calls } = fakeHttpNeon();
    const db = neon({
      connectionString: directUrl,
      transactionTransport: 'websocket',
      neonFactory: factory,
      websocketPoolFactory: (config) => new FakePool(config),
    });
    await db.query('select 1');
    expect(calls.queries).toHaveLength(1);
    expect(db.capabilities.transport).toBe('http');
  });
});

describe('neon adapter — websocket transport for everything', () => {
  const directUrl = 'postgres://u:p@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb';
  const pooledUrl = 'postgres://u:p@ep-cool-name-123456-pooler.us-east-2.aws.neon.tech/neondb';

  it('routes queries through the pool and supports interactive transactions', async () => {
    const pools: FakePool[] = [];
    const behavior: FakeBehavior = {
      rows: (text) => (text.includes('users') ? { rows: [{ id: 1 }], rowCount: 1, command: 'SELECT' } : undefined),
    };
    const db = neon({
      connectionString: directUrl,
      transport: 'websocket',
      websocketPoolFactory: (config) => {
        const pool = new FakePool(config, behavior);
        pools.push(pool);
        return pool;
      },
    });

    expect(db.capabilities).toMatchObject({
      interactiveTransactions: true,
      atomicBatch: true,
      sessionState: true,
      transport: 'websocket',
    });

    const result = await db.query<{ id: number }>('select * from users');
    expect(result.rows).toEqual([{ id: 1 }]);
    expect(pools[0]!.queries[0]!.client).toBe(0);

    const value = await db.transaction!(async (tx) => {
      await tx.query('insert into t values (1)');
      return 'committed';
    });
    expect(value).toBe('committed');
    expect(pools[0]!.clientQueries(1).map((q) => q.text)).toEqual([
      'BEGIN',
      'insert into t values (1)',
      'COMMIT',
    ]);
  });

  it('reports no session state on pooled endpoints', () => {
    const db = neon({
      connectionString: pooledUrl,
      transport: 'websocket',
      websocketPoolFactory: (config) => new FakePool(config),
    });
    expect(db.capabilities.sessionState).toBe(false);
  });

  it('batch runs atomically over the leased connection', async () => {
    const pools: FakePool[] = [];
    const db = neon({
      connectionString: directUrl,
      transport: 'websocket',
      websocketPoolFactory: (config) => {
        const pool = new FakePool(config);
        pools.push(pool);
        return pool;
      },
    });

    await db.batch!([{ text: 'insert into t values (1)' }, { text: 'insert into t values (2)' }]);
    expect(pools[0]!.clientQueries(1).map((q) => q.text)).toEqual([
      'BEGIN',
      'insert into t values (1)',
      'insert into t values (2)',
      'COMMIT',
    ]);
  });

  it('close() ends the pool', async () => {
    const pools: FakePool[] = [];
    const db = neon({
      connectionString: directUrl,
      transport: 'websocket',
      websocketPoolFactory: (config) => {
        const pool = new FakePool(config);
        pools.push(pool);
        return pool;
      },
    });
    await db.query('select 1');
    await db.close();
    expect(pools[0]!.ended).toBe(true);
  });
});
