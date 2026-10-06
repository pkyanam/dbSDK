import { describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../../src/core/database.js';
import { DbError, isDbError, markUncertainOutcome } from '../../src/errors.js';
import { createFixtureDatabase } from '../../src/testing.js';
import type { DatabaseAdapter, DatabaseAdapterCapabilities, QueryExecutor, QueryResult } from '../../src/types.js';

const fullCapabilities: DatabaseAdapterCapabilities = {
  interactiveTransactions: true,
  atomicBatch: true,
  sessionState: true,
  transport: 'tcp',
  evidence: {},
};

type Spy = {
  calls: string[];
  adapter: DatabaseAdapter<unknown>;
};

function spyAdapter(overrides: Partial<DatabaseAdapter> = {}): Spy {
  const calls: string[] = [];
  const adapter: DatabaseAdapter<unknown> = {
    id: 'spy',
    engine: 'postgresql',
    capabilities: fullCapabilities,
    raw: { marker: 'raw' },
    query: async <Row>(text: string, params?: readonly unknown[]): Promise<QueryResult<Row>> => {
      calls.push(`query:${text}:${JSON.stringify(params ?? [])}`);
      return { rows: [{ ok: true }], rowCount: 1, command: 'SELECT' } as QueryResult<Row>;
    },
    transaction: async <T>(fn: (tx: QueryExecutor) => Promise<T>) => {
      calls.push('tx:begin');
      try {
        const result = await fn({
          query: async (text: string, params?: readonly unknown[]) => {
            calls.push(`tx:query:${text}:${JSON.stringify(params ?? [])}`);
            return { rows: [], rowCount: 0 };
          },
        });
        calls.push('tx:commit');
        return result;
      } catch (error) {
        calls.push('tx:rollback');
        throw error;
      }
    },
    batch: async (statements) => {
      calls.push(`batch:${statements.length}`);
      return statements.map(() => ({ rows: [], rowCount: 0 }));
    },
    close: async () => {
      calls.push('close');
    },
    ...overrides,
  };
  return { calls, adapter };
}

function expectDbError(error: unknown): DbError {
  expect(isDbError(error)).toBe(true);
  return error as DbError;
}

function pgError(message: string, code: string): Error {
  const error = new Error(message);
  (error as { code?: string }).code = code;
  return error;
}

describe('createDatabase validation', () => {
  it('rejects adapters with a missing id, engine, query, close, or capabilities', () => {
    const base = spyAdapter();
    const invalid: Partial<DatabaseAdapter>[] = [
      { ...base.adapter, id: '' },
      { ...base.adapter, engine: 'mysql' as never },
      { ...base.adapter, query: undefined },
      { ...base.adapter, close: undefined },
      { ...base.adapter, capabilities: undefined },
    ];
    for (const adapter of invalid) {
      expect(() => createDatabase({ adapter: adapter as never })).toThrowError(DbError);
    }
  });

  it('rejects malformed capability metadata', () => {
    const { adapter } = spyAdapter({
      capabilities: { ...fullCapabilities, transport: 'pigeon' as never },
    });
    expect(() => createDatabase({ adapter })).toThrowError(/malformed capabilities/);
  });
});

describe('querying', () => {
  it('sends interpolated statements as text plus positional parameters', async () => {
    const db = createFixtureDatabase({
      fixtures: [{ match: 'select * from users where id = $1', params: [7], rows: [{ id: 7 }] }],
    });
    const result = await db.sql<{ id: number }>`select * from users where id = ${7}`;
    expect(result.rows).toEqual([{ id: 7 }]);
    expect(result.rowCount).toBe(1);
    await db.close();
  });

  it('executes reusable statements built with the exported sql tag', async () => {
    const { sql } = await import('../../src/sql.js');
    const db = createFixtureDatabase({
      fixtures: [{ match: 'select 1', rows: [{ one: 1 }], repeat: true }],
    });
    const statement = sql`select 1`;
    const first = await db.query<{ one: number }>(statement);
    const second = await db.query<{ one: number }>(statement);
    expect(first.rows).toEqual([{ one: 1 }]);
    expect(second.rows).toEqual([{ one: 1 }]);
    await db.close();
  });

  it('validates statements before dispatch', async () => {
    const db = createFixtureDatabase();
    await expect(db.query({ text: 5 as never })).rejects.toMatchObject({ code: 'CONFIGURATION' });
    await expect(db.query({ text: '', params: [] })).rejects.toMatchObject({ code: 'CONFIGURATION' });
    await db.close();
  });

  it('exposes engine, adapterId, capabilities, and the typed raw escape hatch', async () => {
    const db = createFixtureDatabase({ id: 'fixture-1' });
    expect(db.engine).toBe('postgresql');
    expect(db.adapterId).toBe('fixture-1');
    expect(db.capabilities.transport).toBe('tcp');
    expect(db.raw.queries).toEqual([]);
    await db.close();
  });
});

describe('error normalization', () => {
  it('maps PostgreSQL SQLSTATEs and preserves cause and sqlstate', async () => {
    const { adapter } = spyAdapter({
      query: async () => {
        const error = new Error('duplicate key value violates unique constraint');
        (error as { code?: string }).code = '23505';
        throw error;
      },
    });
    const db = createDatabase({ adapter });
    const error = expectDbError(await db.sql`insert into users (id) values (${1})`.catch((e) => e));
    expect(error.code).toBe('CONSTRAINT');
    expect(error.sqlstate).toBe('23505');
    expect(error.indeterminate).toBe(false);
    expect((error.cause as Error).message).toContain('duplicate key');
    expect(error.adapterId).toBe('spy');
  });

  it('marks transport-level failures during writes as indeterminate — and never retries', async () => {
    const { adapter, calls } = spyAdapter({
      query: async <Row>(text: string): Promise<QueryResult<Row>> => {
        calls.push(`query:${text}`);
        throw new Error('socket hang up');
      },
    });
    const db = createDatabase({ adapter });
    const error = expectDbError(await db.sql`insert into logs (x) values (${1})`.catch((e) => e));
    expect(error.indeterminate).toBe(true);
    expect(error.retryable).toBe(false);
    // No automatic replay: exactly one dispatch attempt.
    expect(calls.filter((call) => call.startsWith('query:')).length).toBe(1);
  });

  it('does not mark read failures as indeterminate', async () => {
    const { adapter } = spyAdapter({
      query: async () => {
        throw new Error('connection terminated');
      },
    });
    const db = createDatabase({ adapter });
    const error = expectDbError(await db.sql`select 1`.catch((e) => e));
    expect(error.indeterminate).toBe(false);
    expect(error.code).toBe('UNKNOWN');
  });

  it('normalizes adapter CapabilityError into CAPABILITY with the capability name', async () => {
    class CapabilityError extends Error {
      constructor(public adapter: string, public capability: string) {
        super(`${capability} unsupported`);
        this.name = 'CapabilityError';
      }
    }
    const { adapter } = spyAdapter({
      query: async () => {
        throw new CapabilityError('spy', 'interactiveTransactions');
      },
    });
    const db = createDatabase({ adapter });
    const error = expectDbError(await db.sql`select 1`.catch((e) => e));
    expect(error.code).toBe('CAPABILITY');
    expect(error.capability).toBe('interactiveTransactions');
    expect(error.indeterminate).toBe(false);
  });

  it('maps 57014 to TIMEOUT', async () => {
    const { adapter } = spyAdapter({
      query: async () => {
        const error = new Error('canceling statement due to statement timeout');
        (error as { code?: string }).code = '57014';
        throw error;
      },
    });
    const db = createDatabase({ adapter });
    const error = expectDbError(await db.sql`select 1`.catch((e) => e));
    expect(error.code).toBe('TIMEOUT');
    expect(error.retryable).toBe(true);
  });
});

describe('batch', () => {
  it('uses the native atomic batch when the adapter declares atomicBatch', async () => {
    const { adapter, calls } = spyAdapter();
    const db = createDatabase({ adapter });
    const results = await db.batch([
      { text: 'insert into a (x) values ($1)', params: [1] },
      { text: 'insert into b (x) values ($1)', params: [2] },
    ]);
    expect(results).toHaveLength(2);
    expect(calls).toEqual(['batch:2']);
  });

  it('falls back to one leased interactive transaction when native batch is unavailable', async () => {
    const { adapter, calls } = spyAdapter({
      capabilities: { ...fullCapabilities, atomicBatch: false },
      batch: undefined,
    });
    const db = createDatabase({ adapter });
    const results = await db.batch([{ text: 'insert into a (x) values ($1)', params: [1] }]);
    expect(results).toHaveLength(1);
    expect(calls).toEqual(['tx:begin', 'tx:query:insert into a (x) values ($1):[1]', 'tx:commit']);
  });

  it('fails with CAPABILITY before dispatch when atomic execution is impossible', async () => {
    const { adapter, calls } = spyAdapter({
      capabilities: { ...fullCapabilities, atomicBatch: false, interactiveTransactions: false },
      batch: undefined,
      transaction: undefined,
    });
    const db = createDatabase({ adapter });
    const error = expectDbError(
      await db.batch([{ text: 'insert into a (x) values ($1)', params: [1] }]).catch((e) => e),
    );
    expect(error.code).toBe('CAPABILITY');
    expect(error.capability).toBe('atomicBatch');
    expect(calls).toEqual([]); // nothing reached the adapter
  });

  it('runs non-atomic batches sequentially through query', async () => {
    const { adapter, calls } = spyAdapter();
    const db = createDatabase({ adapter });
    await db.batch([{ text: 'select 1' }, { text: 'select 2' }], { atomic: false });
    expect(calls).toEqual(['query:select 1:[]', 'query:select 2:[]']);
  });

  it('short-circuits empty batches without dispatching', async () => {
    const { adapter, calls } = spyAdapter();
    const db = createDatabase({ adapter });
    expect(await db.batch([])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('validates every statement before dispatch', async () => {
    const { adapter, calls } = spyAdapter();
    const db = createDatabase({ adapter });
    await expect(db.batch([{ text: 'select 1' }, 'nope' as never])).rejects.toMatchObject({
      code: 'CONFIGURATION',
    });
    expect(calls).toEqual([]);
  });
});

describe('transaction', () => {
  it('passes the callback to the adapter and returns its value', async () => {
    const { adapter, calls } = spyAdapter();
    const db = createDatabase({ adapter });
    const value = await db.transaction(async (tx) => {
      const result = await tx.query<{ ok: boolean }>('select ok', []);
      return result.rows[0]?.ok;
    });
    expect(value).toBe(undefined); // spy tx returns empty rows
    expect(calls[0]).toBe('tx:begin');
    expect(calls.at(-1)).toBe('tx:commit');
  });

  it('fails with CAPABILITY before dispatch and never invokes the callback', async () => {
    const fn = vi.fn();
    const { adapter, calls } = spyAdapter({
      capabilities: { ...fullCapabilities, interactiveTransactions: false },
      transaction: undefined,
    });
    const db = createDatabase({ adapter });
    const error = expectDbError(await db.transaction(fn).catch((e) => e));
    expect(error.code).toBe('CAPABILITY');
    expect(error.capability).toBe('interactiveTransactions');
    expect(fn).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('fails with CONFIGURATION when the capability is declared but the method is missing', async () => {
    const { adapter } = spyAdapter({ transaction: undefined });
    const db = createDatabase({ adapter });
    await expect(db.transaction(async () => 1)).rejects.toMatchObject({ code: 'CONFIGURATION' });
  });

  it('rethrows callback errors (adapter is responsible for rollback)', async () => {
    const { adapter, calls } = spyAdapter();
    const db = createDatabase({ adapter });
    await expect(
      db.transaction(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrowError('boom');
    expect(calls).toContain('tx:rollback');
  });
});

describe('lifecycle', () => {
  it('close() is idempotent and queries fail after close', async () => {
    const { adapter, calls } = spyAdapter();
    const db = createDatabase({ adapter });
    await db.close();
    await db.close();
    expect(calls.filter((call) => call === 'close').length).toBe(1);

    const error = expectDbError(await db.sql`select 1`.catch((e) => e));
    expect(error.code).toBe('CONNECTION');
    expect(calls.filter((call) => call.startsWith('query:')).length).toBe(0);
  });

  it('supports await using (async disposal)', async () => {
    const { adapter, calls } = spyAdapter();
    {
      await using db = createDatabase({ adapter });
      expect(db.adapterId).toBe('spy');
    }
    expect(calls).toContain('close');
  });

  it('batch and transaction fail after close before dispatch', async () => {
    const { adapter, calls } = spyAdapter();
    const db = createDatabase({ adapter });
    await db.close();
    await expect(db.batch([{ text: 'select 1' }])).rejects.toMatchObject({ code: 'CONNECTION' });
    await expect(db.transaction(async () => 1)).rejects.toMatchObject({ code: 'CONNECTION' });
    expect(calls).toEqual(['close']);
  });

  it('normalizes errors thrown by close()', async () => {
    const { adapter } = spyAdapter({
      close: async () => {
        throw new Error('pool ended');
      },
    });
    const db = createDatabase({ adapter });
    await expect(db.close()).rejects.toMatchObject({ code: 'UNKNOWN' });
  });
});

describe('batch error semantics', () => {
  it('propagates normalized native batch errors with the first statement as context', async () => {
    const { adapter } = spyAdapter({
      batch: async () => {
        const error = new Error('syntax error');
        (error as { code?: string }).code = '42601';
        throw error;
      },
    });
    const db = createDatabase({ adapter });
    const error = expectDbError(
      await db
        .batch([{ text: 'insert into a (x) values ($1)', params: [1] }, { text: 'select 1' }])
        .catch((e) => e),
    );
    // First statement is a write, but 42601 is a server-reported SQLSTATE (syntax),
    // so the outcome is not indeterminate.
    expect(error.code).toBe('SYNTAX');
    expect(error.sqlstate).toBe('42601');
    expect(error.indeterminate).toBe(false);
  });

  it('propagates rollback-on-error in the leased transaction fallback', async () => {
    const { adapter, calls } = spyAdapter({
      capabilities: { ...fullCapabilities, atomicBatch: false },
      batch: undefined,
      transaction: async <T>(fn: (tx: QueryExecutor) => Promise<T>) => {
        calls.push('tx:begin');
        try {
          const result = await fn({
            query: async (text) => {
              calls.push(`tx:query:${text}`);
              if (text.includes('bad')) {
                const error = new Error('bad statement');
                (error as { code?: string }).code = '42601';
                throw error;
              }
              return { rows: [], rowCount: 0 };
            },
          });
          calls.push('tx:commit');
          return result;
        } catch (error) {
          calls.push('tx:rollback');
          throw error;
        }
      },
    });
    const db = createDatabase({ adapter });
    const error = expectDbError(
      await db.batch([{ text: 'select 1' }, { text: 'bad statement' }]).catch((e) => e),
    );
    expect(error.code).toBe('SYNTAX');
    expect(calls).toEqual(['tx:begin', 'tx:query:select 1', 'tx:query:bad statement', 'tx:rollback']);
  });
});

describe('indeterminate honesty (review round 1 regressions)', () => {
  it('flags transport failures escaping db.transaction as indeterminate — COMMIT may have applied', async () => {
    const { adapter } = spyAdapter({
      // Simulates a pool client dying between the callback's writes and COMMIT.
      transaction: async <T>(fn: (tx: QueryExecutor) => Promise<T>) => {
        await fn({ query: async () => ({ rows: [], rowCount: 0 }) });
        throw new Error('connection terminated during COMMIT');
      },
    });
    const db = createDatabase({ adapter });
    const error = expectDbError(
      await db
        .transaction(async (tx) => {
          await tx.query('insert into t values (1)');
          return 'ok';
        })
        .catch((e) => e),
    );
    expect(error.indeterminate).toBe(true);
  });

  it('flags adapter-marked uncertain outcomes from db.transaction', async () => {
    const { adapter } = spyAdapter({
      transaction: async () => {
        const error = new Error('connection terminated during COMMIT');
        markUncertainOutcome(error);
        throw error;
      },
    });
    const db = createDatabase({ adapter });
    const error = expectDbError(await db.transaction(async () => 'ok').catch((e) => e));
    expect(error.indeterminate).toBe(true);
  });

  it('does not flag server-reported transaction errors as indeterminate', async () => {
    const { adapter } = spyAdapter({
      transaction: async () => {
        throw pgError('could not serialize access', '40001');
      },
    });
    const db = createDatabase({ adapter });
    const error = expectDbError(await db.transaction(async () => 'ok').catch((e) => e));
    expect(error.code).toBe('TRANSACTION');
    expect(error.indeterminate).toBe(false);
  });

  it('treats an atomic batch as a write if ANY statement is a write, not just the first', async () => {
    const { adapter } = spyAdapter({
      batch: async () => {
        throw new Error('connection reset by peer');
      },
    });
    const db = createDatabase({ adapter });
    const error = expectDbError(
      await db.batch([{ text: 'select 1' }, { text: 'update t set x = 1' }]).catch((e) => e),
    );
    expect(error.indeterminate).toBe(true);
  });

  it('does not flag transport failures in a read-only batch as indeterminate', async () => {
    const { adapter } = spyAdapter({
      batch: async () => {
        throw new Error('connection reset by peer');
      },
    });
    const db = createDatabase({ adapter });
    const error = expectDbError(
      await db.batch([{ text: 'select 1' }, { text: 'select 2' }]).catch((e) => e),
    );
    expect(error.indeterminate).toBe(false);
  });

  it('rejects undefined parameters in db.query like the sql tag does', async () => {
    const { adapter, calls } = spyAdapter();
    const db = createDatabase({ adapter });
    const error = expectDbError(
      await db.query({ text: 'select $1', params: [undefined] }).catch((e) => e),
    );
    expect(error.code).toBe('CONFIGURATION');
    expect(error.message).toMatch(/undefined/);
    expect(calls).toEqual([]); // rejected before dispatch
  });

  it('rejects function and symbol parameters in db.batch before dispatch', async () => {
    const { adapter, calls } = spyAdapter();
    const db = createDatabase({ adapter });
    await expect(db.batch([{ text: 'select $1', params: [() => 'x'] }])).rejects.toMatchObject({
      code: 'CONFIGURATION',
    });
    await expect(db.batch([{ text: 'select $1', params: [Symbol('s')] }])).rejects.toMatchObject({
      code: 'CONFIGURATION',
    });
    expect(calls).toEqual([]);
  });

  it('accepts null parameters in db.query (null is the SQL NULL spelling)', async () => {
    const { adapter, calls } = spyAdapter();
    const db = createDatabase({ adapter });
    await db.query({ text: 'select $1', params: [null] });
    expect(calls).toEqual(['query:select $1:[null]']);
  });
});

describe('lifecycle details (review round 1 regressions)', () => {
  it('does not eagerly touch adapter.raw at createDatabase time', () => {
    let rawReads = 0;
    const { adapter } = spyAdapter();
    Object.defineProperty(adapter, 'raw', {
      get() {
        rawReads += 1;
        return { marker: 'raw' };
      },
    });
    createDatabase({ adapter });
    expect(rawReads).toBe(0);
  });

  it('surfaces the adapter raw lazily and reflects close state', async () => {
    let closed = false;
    const { adapter } = spyAdapter();
    const adapterWithRaw: DatabaseAdapter<unknown> = {
      ...adapter,
      close: async () => {
        closed = true;
      },
      // Mirrors the engine-backed adapters: raw access after close throws.
      get raw() {
        if (closed) {
          throw new Error('engine: adapter is closed');
        }
        return { marker: 'pool' };
      },
    };
    const db = createDatabase({ adapter: adapterWithRaw });
    expect((db.raw as { marker: string }).marker).toBe('pool');
    await db.close();
    // The raw getter is still consulted after close (no eager cached copy of an
    // ended pool), so closed adapters surface their state instead of a stale pool.
    expect(() => db.raw).toThrowError(/closed/);
  });

  it('reports a close failure once; later close calls resolve idempotently', async () => {
    let closeCalls = 0;
    const { adapter } = spyAdapter({
      close: async () => {
        closeCalls += 1;
        throw new Error('pool already ended');
      },
    });
    const db = createDatabase({ adapter });
    await expect(db.close()).rejects.toThrow('pool already ended');
    // Idempotent: no second adapter.close(), and no re-thrown error.
    await expect(db.close()).resolves.toBeUndefined();
    expect(closeCalls).toBe(1);
  });
});
