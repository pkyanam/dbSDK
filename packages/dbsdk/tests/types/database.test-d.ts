import { describe, expectTypeOf, it } from 'vitest';
import { createDatabase, sql } from '../../src/index.js';
import { createFixtureAdapter } from '../../src/testing.js';
import type {
  Database,
  DatabaseAdapter,
  QueryExecutor,
  QueryResult,
  SqlStatement,
} from '../../src/types.js';

type Raw = { marker: string };

const raw: Raw = { marker: 'raw' };

const adapter: DatabaseAdapter<Raw> = {
  id: 'test',
  engine: 'postgresql',
  capabilities: {
    interactiveTransactions: true,
    atomicBatch: true,
    sessionState: true,
    transport: 'tcp',
    evidence: {},
  },
  raw,
  async query<Row>(_text: string, _params?: readonly unknown[]): Promise<QueryResult<Row>> {
    return { rows: [] as Row[], rowCount: 0 };
  },
  async close(): Promise<void> {},
};

describe('Database client types', () => {
  it('propagates the raw driver type from the adapter', () => {
    const db = createDatabase({ adapter });
    expectTypeOf(db).toMatchTypeOf<Database<Raw>>();
    expectTypeOf(db.raw).toEqualTypeOf<Raw>();
    expectTypeOf(db.adapterId).toEqualTypeOf<string>();
    expectTypeOf(db.engine).toEqualTypeOf<'postgresql'>();
    expectTypeOf(db.capabilities.transport).toEqualTypeOf<'tcp' | 'http' | 'websocket'>();
  });

  it('treats row generics as caller assertions', async () => {
    const db = createDatabase({ adapter });
    const result = await db.sql<{ id: string; n: number }>`select 1`;
    expectTypeOf(result).toMatchTypeOf<QueryResult<{ id: string; n: number }>>();
    expectTypeOf(result.rows).toEqualTypeOf<{ id: string; n: number }[]>();
    expectTypeOf(result.rowCount).toEqualTypeOf<number | null>();

    const fromQuery = await db.query<{ id: string }>({ text: 'select 1', params: [] });
    expectTypeOf(fromQuery.rows).toEqualTypeOf<{ id: string }[]>();
  });

  it('sql returns a reusable SqlStatement', () => {
    const id = 'x';
    const statement = sql`select * from t where id = ${id}`;
    expectTypeOf(statement).toEqualTypeOf<SqlStatement>();
    expectTypeOf(statement.text).toEqualTypeOf<string>();
  });

  it('types the transaction executor and callback result', async () => {
    const db = createDatabase({ adapter });
    const value = await db.transaction(async (tx: QueryExecutor) => {
      const result = await tx.query<{ id: string }>('select 1', []);
      expectTypeOf(result.rows).toEqualTypeOf<{ id: string }[]>();
      return result.rows.length;
    });
    expectTypeOf(value).toEqualTypeOf<number>();
  });

  it('types batch options and results', async () => {
    const db = createDatabase({ adapter });
    const results = await db.batch([{ text: 'select 1' }], { atomic: true });
    expectTypeOf(results).toEqualTypeOf<QueryResult[]>();
  });

  it('accepts a fixture adapter as a DatabaseAdapter', () => {
    const fixture = createFixtureAdapter();
    const db = createDatabase({ adapter: fixture });
    expectTypeOf(db.raw.queries).toEqualTypeOf<
      readonly { text: string; params: readonly unknown[]; inTransaction: boolean }[]
    >();
  });

  it('is AsyncDisposable', () => {
    expectTypeOf<Database<Raw>>().toMatchTypeOf<AsyncDisposable>();
  });
});
