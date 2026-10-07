/**
 * `dbsdk/drizzle` interop tests.
 *
 * Offline suites use deterministic fixtures (a pool-shaped recorder, a mock
 * neon query function) to verify the bridge's own contract: what is accepted,
 * what is refused BEFORE any pool creation or dispatch, and what handle is
 * actually handed to Drizzle. Real database behavior (schema queries, joins,
 * transactions, close semantics) runs against a local PostgreSQL and is gated
 * on DBSDK_TEST_POSTGRES_URL, like the other live suites:
 *
 *   DBSDK_TEST_POSTGRES_URL=postgresql://postgres:dbsdk@localhost:15432/dbsdk \
 *     npx vitest run tests/drizzle-interop.test.ts
 */

import { Client, Pool } from 'pg';
import { eq, relations } from 'drizzle-orm';
import { pgSchema, pgTable, integer, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/core/database.js';
import { DbError } from '../src/errors.js';
import type { Database, DatabaseAdapter, DatabaseAdapterCapabilities } from '../src/types.js';
import { postgres } from '../src/adapters/postgres.js';
import { supabase } from '../src/adapters/supabase.js';
import { neon, type NeonHttpQueryFn, type NeonRaw } from '../src/adapters/neon.js';
import type { PgPoolConfig, PgPoolLike, PgQueryOutput } from '../src/adapters/pg-engine.js';
import { drizzleNeonHttp, drizzlePostgres, type PgBridgeRaw } from '../src/drizzle-interop/index.js';

const LOCAL_URL = process.env.DBSDK_TEST_POSTGRES_URL ?? 'postgresql://postgres:dbsdk@localhost:15432/dbsdk';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Pool-shaped recorder matching what the stable drizzle-orm/node-postgres
 * session actually calls at runtime: `query(config, values)` (pg merges the
 * second argument into the config) and `connect()` for transactions. Rows are
 * returned in array mode, as pg does with `rowMode: "array"`. After `end()`
 * the pool refuses use, exactly like a real pg pool.
 */
class DrizzleFakePool implements PgPoolLike {
  readonly queries: { text: string; values?: unknown[]; rowMode?: string }[] = [];
  readonly clients: { queries: { text: string; values?: unknown[] }[]; released: boolean }[] = [];
  ended = false;

  constructor(private readonly behavior?: (text: string, values?: unknown[]) => unknown[][]) {}

  async query(
    config: { text: string; values?: unknown[]; name?: string; rowMode?: string },
    values?: unknown[],
  ): Promise<PgQueryOutput> {
    if (this.ended) {
      throw new Error('Cannot use a pool after calling end on the pool');
    }
    const merged = values ?? config.values;
    this.queries.push({
      text: config.text,
      ...(merged !== undefined ? { values: merged as unknown[] } : {}),
      ...(config.rowMode !== undefined ? { rowMode: config.rowMode } : {}),
    });
    const rows = this.behavior?.(config.text, values);
    return { rows: rows ?? [], rowCount: rows?.length ?? 0, command: 'SELECT' };
  }

  async connect() {
    const client = { queries: [] as { text: string; values?: unknown[] }[], released: false };
    this.clients.push(client);
    return {
      async query(config: { text: string; values?: unknown[] }) {
        client.queries.push({ text: config.text, ...(config.values !== undefined ? { values: config.values } : {}) });
        return { rows: [], rowCount: 0, command: 'SELECT' } satisfies PgQueryOutput;
      },
      release() {
        client.released = true;
      },
    };
  }

  async end() {
    this.ended = true;
  }
}

/** A minimal well-formed adapter for raw-shape validation tests. */
function adapterWithRaw(raw: unknown): DatabaseAdapter<PgBridgeRaw> {
  const capabilities: DatabaseAdapterCapabilities = {
    interactiveTransactions: true,
    atomicBatch: true,
    sessionState: true,
    transport: 'tcp',
    evidence: {},
  };
  return {
    id: 'fake-pg',
    engine: 'postgresql',
    capabilities,
    raw: raw as never,
    async query() {
      return { rows: [], rowCount: 0 };
    },
    async close() {},
  };
}

function configErrorOf(error: unknown): DbError {
  expect(error).toBeInstanceOf(DbError);
  return error as DbError;
}

// ---------------------------------------------------------------------------
// Refusals — all before dispatch, all DbError code CONFIGURATION
// ---------------------------------------------------------------------------

describe('drizzlePostgres — refusals before dispatch', () => {
  it('rejects non-Database inputs without touching anything', async () => {
    for (const bad of [undefined, null, {}, { raw: { query: () => {} } }, 'postgres://u:p@h/db']) {
      const error = configErrorOf(await drizzlePostgres(bad as never).catch((e) => e));
      expect(error.code).toBe('CONFIGURATION');
      expect(error.message).toMatch(/createDatabase|Database/i);
    }
  });

  it('rejects a Database whose raw handle is not pool-shaped', async () => {
    const db = createDatabase({ adapter: adapterWithRaw({ query: 'not a function' }) });
    const error = configErrorOf(await drizzlePostgres(db).catch((e) => e));
    expect(error.code).toBe('CONFIGURATION');
    expect(error.message).toMatch(/does not implement/);
  });

  it('rejects DSN and native-construction config fields from JS callers, with zero dispatch', async () => {
    const pool = new DrizzleFakePool();
    const db = createDatabase({ adapter: adapterWithRaw(pool) });
    const dsn = 'postgres://user:secret@host/db';

    for (const config of [
      dsn, // a DSN passed as config
      { connection: dsn },
      { connection: { connectionString: dsn } },
      { client: pool },
      { connectionString: dsn },
    ]) {
      const error = configErrorOf(await drizzlePostgres(db, config as never).catch((e) => e));
      expect(error.code).toBe('CONFIGURATION');
      expect(error.message).not.toContain('secret'); // DSNs never appear in bridge errors
    }
    expect(pool.queries).toHaveLength(0); // nothing dispatched
  });

  it('refuses a sessionState:false transaction pooler BEFORE the pool is created or raw is accessed', async () => {
    let poolsCreated = 0;
    let rawAccessed = false;
    const adapter = supabase({
      // The local server does not run on Supabase's ports; allowModeMismatch is
      // the existing explicit option that makes a fixture endpoint constructible.
      connectionString: LOCAL_URL,
      connectionMode: 'transaction',
      allowModeMismatch: true,
      poolFactory: (config) => {
        poolsCreated += 1;
        return new Pool(config) as unknown as PgPoolLike;
      },
    });
    Object.defineProperty(adapter, 'raw', {
      get() {
        rawAccessed = true;
        throw new Error('raw must not be accessed for a refused mode');
      },
      configurable: true,
    });
    const db = createDatabase({ adapter });
    expect(db.capabilities.sessionState).toBe(false);

    const error = configErrorOf(await drizzlePostgres(db).catch((e) => e));
    expect(error.code).toBe('CONFIGURATION');
    expect(error.message).toMatch(/sessionState: false/);
    expect(error.message).toMatch(/direct|session/i);
    expect(poolsCreated).toBe(0); // refused BEFORE any pool creation
    expect(rawAccessed).toBe(false);
  });

  it('refuses HTTP and websocket transports with pointers to the right mode', async () => {
    const httpAdapter: DatabaseAdapter<PgBridgeRaw> = {
      ...adapterWithRaw(new DrizzleFakePool()),
      capabilities: { ...adapterWithRaw(null).capabilities, transport: 'http', sessionState: false },
    };
    const httpError = configErrorOf(
      await drizzlePostgres(createDatabase({ adapter: httpAdapter })).catch((e) => e),
    );
    expect(httpError.message).toMatch(/drizzleNeonHttp/);

    const wsAdapter: DatabaseAdapter<PgBridgeRaw> = {
      ...adapterWithRaw(new DrizzleFakePool()),
      capabilities: { ...adapterWithRaw(null).capabilities, transport: 'websocket', sessionState: true },
    };
    const wsError = configErrorOf(
      await drizzlePostgres(createDatabase({ adapter: wsAdapter })).catch((e) => e),
    );
    expect(wsError.message).toMatch(/websocket/);
  });

  it('refuses an already-closed database with its closed error, never recreating the pool', async () => {
    const pools: DrizzleFakePool[] = [];
    const adapter = postgres({
      connectionString: LOCAL_URL,
      poolFactory: (config: PgPoolConfig) => {
        void config;
        const pool = new DrizzleFakePool();
        pools.push(pool);
        return pool as unknown as PgPoolLike;
      },
    });
    const db = createDatabase({ adapter });
    const drizzleDb = await drizzlePostgres(db);
    expect(pools).toHaveLength(1); // factory call materialized the lazy pool
    await db.close();

    // The previously returned Drizzle instance holds the ended pool: use fails
    // with a normalized DbError (R2: the bridge no longer surfaces raw
    // Drizzle/driver errors) whose cause is the pool's "Cannot use a pool
    // after calling end" error.
    const failure = await drizzleDb.execute('select 1').catch((e) => e);
    expect(failure).toBeInstanceOf(DbError);
    expect(String((failure as Error)?.cause ?? failure)).toMatch(/Cannot use a pool after calling end/i);
    expect(pools).toHaveLength(1); // no pool recreation

    // A NEW factory call on the closed database is refused before dispatch.
    const error = configErrorOf(await drizzlePostgres(db).catch((e) => e));
    expect(error.message).toMatch(/closed/i);
    expect(pools).toHaveLength(1);
  });
});

describe('drizzlePostgres — accepted wiring (offline)', () => {
  const table = pgTable('users', {
    id: serial('id').primaryKey(),
    email: text('email').notNull(),
  });

  it('hands the SAME dbSDK-owned pool to Drizzle as $client, with no extra pool', async () => {
    const pool = new DrizzleFakePool((text) =>
      text.includes('"users"') ? [[7, 'ada@example.com']] : [],
    );
    const db = createDatabase({ adapter: adapterWithRaw(pool) });
    const drizzleDb = await drizzlePostgres(db);

    // Drizzle's $client is the exact pool object dbSDK owns — no copy, no
    // second pool, no independent connection lifecycle.
    expect(drizzleDb.$client).toBe(pool);

    // A fielded select: drizzle sends rowMode 'array' and maps the arrays.
    const rows = await drizzleDb.select().from(table);
    expect(rows).toEqual([{ id: 7, email: 'ada@example.com' }]);
    expect(pool.queries[0]).toMatchObject({ text: expect.stringContaining('from "users"'), rowMode: 'array' });

    // Values are bound, never interpolated into the SQL text.
    const sneaky = "x'); drop table users; --";
    await drizzleDb.select().from(table).where(eq(table.email, sneaky));
    const whereCall = pool.queries[1]!;
    expect(whereCall.values).toEqual([sneaky]);
    expect(whereCall.text).not.toContain('drop table');
  });

  it('transaction on the drizzle instance leases ONE connection: BEGIN, work, COMMIT, release', async () => {
    const pool = new DrizzleFakePool();
    const db = createDatabase({ adapter: adapterWithRaw(pool) });
    const drizzleDb = await drizzlePostgres(db);

    await drizzleDb.transaction(async (tx) => {
      await tx.insert(table).values({ email: 'tx@example.com' });
    });

    const client = pool.clients[0]!;
    const texts = client.queries.map((q) => q.text);
    expect(texts[0]).toMatch(/begin/i);
    expect(texts).toContainEqual(expect.stringContaining('insert into "users"'));
    expect(texts[0]!.length).toBeGreaterThan(0);
    expect(texts[texts.length - 1]).toMatch(/commit/i);
    expect(client.released).toBe(true);
  });

  it('transaction rolls back and releases when the callback throws', async () => {
    const pool = new DrizzleFakePool();
    const db = createDatabase({ adapter: adapterWithRaw(pool) });
    const drizzleDb = await drizzlePostgres(db);

    await expect(
      drizzleDb.transaction(async (tx) => {
        await tx.insert(table).values({ email: 'boom@example.com' });
        throw new Error('intentional rollback');
      }),
    ).rejects.toThrow(/intentional rollback/);

    const client = pool.clients[0]!;
    const texts = client.queries.map((q) => q.text);
    expect(texts[texts.length - 1]).toMatch(/rollback/i);
    expect(client.released).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// drizzleNeonHttp — refusals
// ---------------------------------------------------------------------------

describe('drizzleNeonHttp — refusals before dispatch', () => {
  function httpDbWithRaw(raw: unknown): Database<NeonRaw> {
    const adapter: DatabaseAdapter<NeonRaw> = {
      ...adapterWithRaw(raw),
      capabilities: { ...adapterWithRaw(null).capabilities, transport: 'http', sessionState: false },
      raw: raw as never,
    };
    return createDatabase({ adapter });
  }

  it('rejects non-HTTP databases with a pointer to drizzlePostgres', async () => {
    const pool = new DrizzleFakePool();
    const tcpDb = createDatabase({ adapter: adapterWithRaw(pool) });
    const error = configErrorOf(
      await drizzleNeonHttp(tcpDb as unknown as Database<NeonRaw>).catch((e) => e),
    );
    expect(error.message).toMatch(/drizzlePostgres/);
    expect(pool.queries).toHaveLength(0);
  });

  it('rejects wrong raw shapes: no neon function, no .query method', async () => {
    const notNeon = httpDbWithRaw({ transport: 'http', sql: 'not-a-function' });
    const error = configErrorOf(await drizzleNeonHttp(notNeon).catch((e) => e));
    expect(error.message).toMatch(/raw\.sql/);

    const oldStyle = httpDbWithRaw({ transport: 'http', sql: Object.assign(() => {}, {}) });
    const error2 = configErrorOf(await drizzleNeonHttp(oldStyle).catch((e) => e));
    expect(error2.message).toMatch(/\.query/);
  });

  it('rejects DSN and native-construction config fields', async () => {
    const mock = createMockNeon();
    const db = createDatabase({ adapter: mockNeonAdapter(mock) });
    const error = configErrorOf(
      await drizzleNeonHttp(db, { connection: 'postgres://u:p@h/db' } as never).catch((e) => e),
    );
    expect(error.message).toMatch(/connection/);
    expect(mock.calls.query).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// drizzleNeonHttp — actual Drizzle runtime on a controlled mock transport
// ---------------------------------------------------------------------------

type NeonCall = { text: string; params: unknown[]; opts?: Record<string, unknown> };

type NeonHttpQueryFnLike = ((...args: unknown[]) => unknown) & {
  query(text: string, params?: unknown[], opts?: Record<string, unknown>): Promise<unknown>;
  transaction(queries: unknown[], opts?: Record<string, unknown>): Promise<unknown>;
};

type MockNeon = {
  fn: NeonHttpQueryFnLike;
  calls: { query: NeonCall[]; transaction: NeonCall[][] };
};

function createMockNeon(rows?: (text: string) => unknown[][]): MockNeon {
  const calls: MockNeon['calls'] = { query: [], transaction: [] };
  const fn = Object.assign(() => undefined, {
    query(text: string, params?: unknown[], opts?: Record<string, unknown>) {
      calls.query.push({ text, params: params ?? [], ...(opts !== undefined ? { opts } : {}) });
      const resultRows = rows?.(text) ?? [];
      const result = { rows: resultRows, rowCount: resultRows.length, command: 'SELECT', fields: [] };
      // The real neon() function returns a NeonQueryPromise (a thenable that
      // also carries the query). Drizzle passes those objects to .transaction()
      // for batch, so the mock's thenable exposes the built SQL for assertions.
      return Object.assign(Promise.resolve(result), { sql: text, params: params ?? [] });
    },
    async transaction(queries: unknown[], opts?: Record<string, unknown>) {
      calls.transaction.push(queries as NeonCall[]);
      return queries.map(() => ({ rows: [], rowCount: 0, command: 'SELECT', fields: [] }));
    },
  }) as unknown as NeonHttpQueryFnLike;
  return { fn, calls };
}

function mockNeonAdapter(mock: MockNeon): DatabaseAdapter<NeonRaw> {
  return neon({
    connectionString: 'postgres://user:pass@ep-cool-name-123456.eu-central-1.aws.neon.tech/neondb',
    neonFactory: () => mock.fn as unknown as NeonHttpQueryFn,
  });
}

describe('drizzleNeonHttp — actual Drizzle runtime on a mock transport (offline)', () => {
  const mockSchema = {
    users: pgTable('users', {
      id: serial('id').primaryKey(),
      email: text('email').notNull(),
    }),
  };

  it('runs a fielded select through raw.sql with per-call arrayMode/fullResults and typed row mapping', async () => {
    const mock = createMockNeon((text) => (text.includes('"users"') ? [[7, 'ada@example.com']] : []));
    const db = createDatabase({ adapter: mockNeonAdapter(mock) });
    const drizzleDb = await drizzleNeonHttp(db, { schema: mockSchema });

    const allUsers = await drizzleDb.select().from(mockSchema.users);
    expect(allUsers).toEqual([{ id: 7, email: 'ada@example.com' }]);

    expect(mock.calls.query).toHaveLength(1);
    const call = mock.calls.query[0]!;
    expect(call.text).toContain('from "users"');
    expect(call.params).toEqual([]);
    expect(call.opts).toMatchObject({ arrayMode: true, fullResults: true });

    // dbSDK's own query path on the same database still works — no wrapper was
    // installed; drizzle holds the actual raw.sql handle.
    await db.query({ text: 'select 1' });
    expect(mock.calls.query).toHaveLength(2);
    expect(mock.calls.query[1]!.opts).toBeUndefined(); // dbSDK's adapter passes no per-call opts
  });

  it('binds parameters: values go through as query params, never into the SQL text', async () => {
    const sneaky = "x'); drop table users; --";
    const mock = createMockNeon((text) => (text.includes('where') ? [[1, sneaky]] : []));
    const db = createDatabase({ adapter: mockNeonAdapter(mock) });
    const drizzleDb = await drizzleNeonHttp(db, { schema: mockSchema });

    const found = await drizzleDb.select().from(mockSchema.users).where(eq(mockSchema.users.email, sneaky));
    expect(found).toEqual([{ id: 1, email: sneaky }]);
    const call = mock.calls.query[0]!;
    expect(call.params).toEqual([sneaky]);
    expect(call.text).not.toContain('drop table');
  });

  it('execute() uses the raw fullResults shape (arrayMode false)', async () => {
    const mock = createMockNeon(() => [[1]]);
    const db = createDatabase({ adapter: mockNeonAdapter(mock) });
    const drizzleDb = await drizzleNeonHttp(db);

    const result = await drizzleDb.execute('select 1');
    expect((result as { rows: unknown[] }).rows).toEqual([[1]]);
    expect(mock.calls.query[0]!.opts).toMatchObject({ arrayMode: false, fullResults: true });
  });

  it('rejects interactive transactions without any network call', async () => {
    const mock = createMockNeon();
    const db = createDatabase({ adapter: mockNeonAdapter(mock) });
    const drizzleDb = await drizzleNeonHttp(db, { schema: mockSchema });

    await expect(
      drizzleDb.transaction(async () => {
        throw new Error('callback must never run');
      }),
    ).rejects.toThrow(/No transactions support in neon-http driver/);

    expect(mock.calls.query).toHaveLength(0);
    expect(mock.calls.transaction).toHaveLength(0);
  });

  it('batch builds all statements and hands them to client.transaction with fullResults', async () => {
    const mock = createMockNeon();
    const db = createDatabase({ adapter: mockNeonAdapter(mock) });
    const drizzleDb = await drizzleNeonHttp(db, { schema: mockSchema });

    await drizzleDb.batch([
      drizzleDb.insert(mockSchema.users).values({ email: 'a@example.com' }),
      drizzleDb.insert(mockSchema.users).values({ email: 'b@example.com' }),
    ]);

    expect(mock.calls.transaction).toHaveLength(1);
    expect(mock.calls.transaction[0]).toHaveLength(2);
    const built = mock.calls.transaction[0]!.map((q) => q as unknown as { sql: string; params: unknown[] });
    for (const item of built) {
      expect(item.sql).toMatch(/insert into "users"/);
      expect(item.params[0]).toMatch(/example\.com/);
    }
  });
});

// ---------------------------------------------------------------------------
// Real local PostgreSQL — actual driver behavior end to end
// ---------------------------------------------------------------------------

const hasServer = Boolean(process.env.DBSDK_TEST_POSTGRES_URL);
const d = hasServer ? describe : describe.skip;

const SCHEMA_NAME = 'dbsdk_drizzle_r2'; // unique fixture schema; dropped in cleanup

const custom = pgSchema(SCHEMA_NAME);
const users = custom.table('drizzle_users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  age: integer('age'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
const posts = custom.table('drizzle_posts', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  title: text('title').notNull(),
});
const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}));
const postsRelations = relations(posts, ({ one }) => ({
  user: one(users, { fields: [posts.userId], references: [users.id] }),
}));
const appSchema = { users, posts, usersRelations, postsRelations };

d('drizzlePostgres — real local PostgreSQL', () => {
  let db: Database<PgPoolLike>;
  let drizzleDb: Awaited<ReturnType<typeof drizzlePostgres<typeof appSchema>>>;
  let poolsCreated = 0;
  let closedByCloseTest = false;

  beforeAll(async () => {
    const adapter = postgres({
      connectionString: LOCAL_URL,
      max: 3,
      poolFactory: (config: PgPoolConfig) => {
        poolsCreated += 1;
        return new Pool(config) as unknown as PgPoolLike;
      },
    });
    db = createDatabase({ adapter });
    await db.query({ text: `drop schema if exists ${SCHEMA_NAME} cascade` });
    await db.query({ text: `create schema ${SCHEMA_NAME}` });
    await db.query({
      text: `create table ${SCHEMA_NAME}.drizzle_users (id serial primary key, email text not null unique, age integer, created_at timestamptz not null default now())`,
    });
    await db.query({
      text: `create table ${SCHEMA_NAME}.drizzle_posts (id serial primary key, user_id integer not null references ${SCHEMA_NAME}.drizzle_users(id), title text not null)`,
    });
    drizzleDb = await drizzlePostgres(db, { schema: appSchema });
  });

  afterAll(async () => {
    // The close-semantics test closes the database; after close, dbSDK
    // refuses further queries by design. The fixture schema is therefore
    // dropped through an independent connection that does not belong to the
    // closed pool (acceptance F1: the schema must never leak, on any path).
    try {
      if (!closedByCloseTest) {
        await db.query({ text: `drop schema if exists ${SCHEMA_NAME} cascade` });
      } else {
        const cleaner = new Client({ connectionString: LOCAL_URL });
        try {
          await cleaner.connect();
          await cleaner.query(`drop schema if exists ${SCHEMA_NAME} cascade`);
        } finally {
          await cleaner.end();
        }
      }
    } finally {
      await db.close();
    }
  });

  it('inserts, selects, updates through the shared dbSDK pool', async () => {
    const inserted = await drizzleDb
      .insert(users)
      .values({ email: 'ada@example.com', age: 36 })
      .returning({ id: users.id });
    expect(inserted).toEqual([{ id: expect.any(Number) }]);

    const rows = await drizzleDb.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe('ada@example.com');
    expect(rows[0]!.age).toBe(36);
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);

    await drizzleDb.update(users).set({ age: 37 }).where(eq(users.email, 'ada@example.com'));
    const after = await drizzleDb.select({ age: users.age }).from(users);
    expect(after).toEqual([{ age: 37 }]);
  });

  it('joins across two tables with typed results and relational queries', async () => {
    const ada = await drizzleDb.select().from(users);
    const adaId = ada[0]!.id;
    await drizzleDb.insert(posts).values({ userId: adaId, title: 'First post' });
    await drizzleDb.insert(posts).values({ userId: adaId, title: 'Second post' });

    const joined = await drizzleDb
      .select({ email: users.email, title: posts.title })
      .from(users)
      .innerJoin(posts, eq(posts.userId, users.id))
      .orderBy(posts.id);
    expect(joined).toEqual([
      { email: 'ada@example.com', title: 'First post' },
      { email: 'ada@example.com', title: 'Second post' },
    ]);

    const withPosts = await drizzleDb.query.users.findMany({ with: { posts: true } });
    expect(withPosts).toHaveLength(1);
    expect(withPosts[0]!.posts).toHaveLength(2);
  });

  it('commits a real Drizzle transaction', async () => {
    await drizzleDb.transaction(async (tx) => {
      const [grace] = await tx
        .insert(users)
        .values({ email: 'grace@example.com', age: 45 })
        .returning({ id: users.id });
      await tx.insert(posts).values({ userId: grace!.id, title: 'Grace post' });
    });
    const grace = await drizzleDb.select().from(users).where(eq(users.email, 'grace@example.com'));
    expect(grace).toHaveLength(1);
    const titles = await drizzleDb.select({ title: posts.title }).from(posts);
    expect(titles.map((p) => p.title)).toContain('Grace post');
  });

  it('rolls back a real Drizzle transaction on failure', async () => {
    const before = await drizzleDb.select().from(users);
    await expect(
      drizzleDb.transaction(async (tx) => {
        await tx.insert(users).values({ email: 'rollback@example.com', age: 1 });
        throw new Error('intentional rollback');
      }),
    ).rejects.toThrow(/intentional rollback/);
    const after = await drizzleDb.select().from(users);
    expect(after).toHaveLength(before.length);
    expect(after.find((u) => u.email === 'rollback@example.com')).toBeUndefined();
  });

  it('binds values (injection text stays literal data)', async () => {
    const sneaky = "x'); drop table drizzle_users; --";
    await drizzleDb.insert(users).values({ email: sneaky });
    const found = await drizzleDb.select().from(users).where(eq(users.email, sneaky));
    expect(found).toHaveLength(1);
    const stillThere = await db.query<{ t: string | null }>({
      text: `select to_regclass('${SCHEMA_NAME}.drizzle_users') as t`,
    });
    expect(String(stillThere.rows[0]!.t)).toContain('drizzle_users');
    // Clean this row so reruns stay deterministic (unique email).
    await drizzleDb.delete(users).where(eq(users.email, sneaky));
  });

  it('close() ends the shared pool once; the Drizzle instance fails and no pool is recreated', async () => {
    expect(poolsCreated).toBe(1);
    await db.close();
    closedByCloseTest = true;
    expect(poolsCreated).toBe(1);
    // R2: use fails with a normalized DbError whose cause is the pool's own
    // "Cannot use a pool after calling end" error (previously this surfaced as
    // Drizzle's raw DrizzleQueryError wrapper).
    const failure = await drizzleDb.select().from(users).catch((e) => e);
    expect(failure).toBeInstanceOf(DbError);
    expect(String((failure as Error)?.cause ?? failure)).toMatch(/Cannot use a pool after calling end/i);
    expect(poolsCreated).toBe(1);
  });
});

d('drizzlePostgres — Supabase session mode over local PostgreSQL (compatibility)', () => {
  it('works through the supabase adapter in session mode', async () => {
    const adapter = supabase({
      connectionString: LOCAL_URL,
      connectionMode: 'session',
      allowModeMismatch: true, // local server does not run on Supabase's pooler port
      max: 2,
      poolFactory: (config) => new Pool(config) as unknown as PgPoolLike,
    });
    const db = createDatabase({ adapter });
    expect(db.capabilities.sessionState).toBe(true);
    const drizzleDb = await drizzlePostgres(db);
    const rows = await drizzleDb.execute<{ n: number }>('select 1 as n');
    expect(rows.rows[0]).toEqual({ n: 1 });
    await db.close();
  });
});
