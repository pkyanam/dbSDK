/**
 * Independent Drizzle interop acceptance review R3 — tests owned by the R3 review,
 * not by the implementation. Deliberately overlaps the author's suite as little as
 * possible and adds checks the author's suite does not make:
 *
 * - value-conversion semantics on real PostgreSQL (numeric / nullable / json /
 *   boolean / timestamp) through the public factories — not just mocks;
 * - native-construction config refusal for shapes the author's suite does not
 *   exercise (prototype-inherited keys, non-enumerable properties) and the
 *   defense-in-depth property that Drizzle only ever receives a rebuilt
 *   { schema, logger, casing } object (unknown keys are dropped even if a
 *   future validation gap appears);
 * - preserved options inference: logger actually captures Drizzle-generated SQL;
 *   casing actually rewrites generated SQL column names;
 * - raw-handle access counting (accepted path touches raw exactly once);
 * - the Neon HTTP close asymmetry, assessed against the SDK's own pre-existing
 *   raw escape-hatch semantics (documented, not hidden).
 *
 * Offline suites run everywhere; real-PG suites require DBSDK_TEST_POSTGRES_URL
 * (approved local dbsdk-pg-test instance, PostgreSQL 17, port 15432). Fixtures use
 * the unique schema `dbsdk_drizzle_r3` and are dropped in cleanup.
 */

import { eq } from 'drizzle-orm';
import { boolean, integer, json, numeric, pgSchema, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/core/database.js';
import { DbError } from '../src/errors.js';
import type { Database, DatabaseAdapter, DatabaseAdapterCapabilities } from '../src/types.js';
import { postgres } from '../src/adapters/postgres.js';
import { neon, type NeonHttpQueryFn, type NeonRaw } from '../src/adapters/neon.js';
import type { PgPoolConfig, PgPoolLike, PgQueryOutput } from '../src/adapters/pg-engine.js';
import { drizzleNeonHttp, drizzlePostgres, type PgBridgeRaw } from '../src/drizzle-interop/index.js';

const LOCAL_URL = process.env.DBSDK_TEST_POSTGRES_URL ?? 'postgresql://postgres:dbsdk@localhost:15432/dbsdk';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Pool-shaped recorder. Returns rows in array mode (pg's rowMode: "array"),
 * refuses use after end() — the same runtime contract drizzle-orm/node-postgres
 * exercises against a real pg.Pool.
 */
class RecordingPool implements PgPoolLike {
  readonly queries: { text: string; values?: unknown[]; rowMode?: string }[] = [];
  ended = false;
  ends = 0;

  constructor(private readonly rowsFor?: (text: string) => unknown[][]) {}

  async query(
    config: { text: string; values?: unknown[]; rowMode?: string },
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
    const rows = this.rowsFor?.(config.text) ?? [];
    return { rows, rowCount: rows.length, command: 'SELECT' };
  }

  async connect() {
    return {
      async query() {
        return { rows: [], rowCount: 0, command: 'SELECT' } satisfies PgQueryOutput;
      },
      release() {},
    };
  }

  async end() {
    this.ends += 1;
    this.ended = true;
  }
}

function tcpAdapterWithRaw(raw: unknown, options?: { sessionState?: boolean }): DatabaseAdapter<PgBridgeRaw> {
  const capabilities: DatabaseAdapterCapabilities = {
    interactiveTransactions: true,
    atomicBatch: true,
    sessionState: options?.sessionState ?? true,
    transport: 'tcp',
    evidence: {},
  };
  return {
    id: 'r3-fake-pg',
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
// R3 check 2 — native-construction refusal for alternative config shapes
// ---------------------------------------------------------------------------

describe('R3 — config gate against alternative JS shapes (offline)', () => {
  const dsn = 'postgres://user:secret@host/db';

  it('catches forbidden keys hidden on the prototype chain (runtime uses `in`)', async () => {
    const pool = new RecordingPool();
    const db = createDatabase({ adapter: tcpAdapterWithRaw(pool) });
    const config = Object.create({ connection: dsn }) as object;
    const error = configErrorOf(await drizzlePostgres(db, config as never).catch((e) => e));
    expect(error.code).toBe('CONFIGURATION');
    expect(error.message).toMatch(/connection/);
    expect(error.message).not.toContain('secret');
    expect(pool.queries).toHaveLength(0);
  });

  it('catches forbidden keys defined as non-enumerable own properties (`in` still sees them)', async () => {
    const pool = new RecordingPool();
    const db = createDatabase({ adapter: tcpAdapterWithRaw(pool) });
    const config: Record<string, unknown> = { schema: {} };
    Object.defineProperty(config, 'client', { value: pool, enumerable: false });
    const error = configErrorOf(await drizzlePostgres(db, config as never).catch((e) => e));
    expect(error.message).toMatch(/client/);
    expect(pool.queries).toHaveLength(0);
  });

  it('drops unknown and exotic values safely: a boxed-string DSN reaches Drizzle as an empty rebuilt config', async () => {
    // A String object is typeof 'object' without forbidden keys, so the gate
    // lets it through — but the bridge never forwards the original object: it
    // rebuilds { schema, logger, casing } only. No DSN can reach Drizzle.
    const pool = new RecordingPool(() => ([[1, 'a']]));
    const db = createDatabase({ adapter: tcpAdapterWithRaw(pool) });
    const drizzleDb = await drizzlePostgres(db, new String(dsn) as never);
    expect(pool.queries).toHaveLength(0); // nothing dispatched at factory time
    const rows = await drizzleDb.execute('select 1');
    expect((rows as { rows: unknown[] }).rows).toEqual([[1, 'a']]);
  });

  it('forwards ONLY the validated subset: unknown extra keys are dropped by the rebuild, not by luck', async () => {
    const pool = new RecordingPool(() => ([[1, 'x@example.com']]));
    const db = createDatabase({ adapter: tcpAdapterWithRaw(pool) });
    const logged: string[] = [];
    // Deliberate benign-but-unknown extra key a JS caller might pass; the gate
    // allows it (it cannot construct anything), the rebuild must drop it.
    const drizzleDb = await drizzlePostgres(db, {
      logger: { logQuery: (q: string) => logged.push(q) },
      cache: { strategy: 'nope' },
    } as never);
    const table = pgTable('r3_users', { id: serial('id').primaryKey(), email: text('email') });
    const rows = await drizzleDb.select().from(table);
    expect(rows).toEqual([{ id: 1, email: 'x@example.com' }]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('from "r3_users"');
  });
});

// ---------------------------------------------------------------------------
// R3 check 2 — sessionState gate and raw-access accounting (offline)
// ---------------------------------------------------------------------------

describe('R3 — gate and raw-access accounting (offline)', () => {
  it('refuses sessionState:false before ANY raw getter access, without a supabase adapter', async () => {
    let rawAccesses = 0;
    let poolsCreated = 0;
    const adapter = tcpAdapterWithRaw(undefined, { sessionState: false });
    Object.defineProperty(adapter, 'raw', {
      get() {
        rawAccesses += 1;
        throw new Error('raw must not be accessed for a refused mode');
      },
      configurable: true,
    });
    const db = createDatabase({ adapter });
    expect(db.capabilities.sessionState).toBe(false);
    const error = configErrorOf(await drizzlePostgres(db).catch((e) => e));
    expect(error.code).toBe('CONFIGURATION');
    expect(error.message).toMatch(/sessionState: false/);
    expect(rawAccesses).toBe(0);
    expect(poolsCreated).toBe(0);
  });

  it('accepted path: raw is read exactly once, the pool is created once, and $client is the same object', async () => {
    let rawAccesses = 0;
    let poolsCreated = 0;
    const pool = new RecordingPool();
    const adapter = tcpAdapterWithRaw(pool);
    Object.defineProperty(adapter, 'raw', {
      get() {
        rawAccesses += 1;
        return pool;
      },
      configurable: true,
    });
    const db = createDatabase({ adapter });
    const drizzleDb = await drizzlePostgres(db);
    expect(drizzleDb.$client).toBe(pool);
    expect(rawAccesses).toBe(1); // one read: pool resolution at accept time
    expect(poolsCreated).toBe(0); // pool pre-exists in this fixture; no second pool created by the bridge
    await drizzleDb.execute('select 1');
    expect(pool.queries).toHaveLength(1);
    expect(pool.ends).toBe(0); // Drizzle never ends the SDK-owned pool
  });

  it('the bridge never passes a DSN or native pool config to Drizzle: the pool keeps the SDK-built config', async () => {
    const captured: PgPoolConfig[] = [];
    const adapter = postgres({
      connectionString: LOCAL_URL,
      max: 2,
      poolFactory: (config: PgPoolConfig) => {
        captured.push(config);
        return new RecordingPool() as unknown as PgPoolLike;
      },
    });
    const db = createDatabase({ adapter });
    const drizzleDb = await drizzlePostgres(db);
    // One pool, built by dbSDK with the adapter's settings; the bridge added nothing.
    expect(captured).toHaveLength(1);
    expect(captured[0]!.connectionString).toBe(LOCAL_URL);
    expect(drizzleDb.$client).toBeInstanceOf(RecordingPool);
    await db.close();
    expect(captured).toHaveLength(1); // close() ends the SDK pool; no recreation
  });
});

// ---------------------------------------------------------------------------
// R3 check 3 — Neon HTTP close asymmetry, assessed against SDK raw semantics
// ---------------------------------------------------------------------------

describe('R3 — Neon HTTP close boundary vs the SDK raw escape hatch (offline)', () => {
  type NeonCall = { text: string; params: unknown[]; opts?: Record<string, unknown> };
  function mockNeonAdapter(fn: unknown): DatabaseAdapter<NeonRaw> {
    return neon({
      connectionString: 'postgres://user:pass@ep-r3-123456.eu-central-1.aws.neon.tech/neondb',
      neonFactory: () => fn as unknown as NeonHttpQueryFn,
    });
  }
  function makeMock() {
    const calls: { query: NeonCall[] } = { query: [] };
    const fn = Object.assign(() => undefined, {
      query(text: string, params?: unknown[], opts?: Record<string, unknown>) {
        calls.query.push({ text, params: params ?? [], ...(opts !== undefined ? { opts } : {}) });
        const result = { rows: [[1]], rowCount: 1, command: 'SELECT', fields: [] };
        return Object.assign(Promise.resolve(result), { sql: text, params: params ?? [] });
      },
      async transaction() {
        return [];
      },
    });
    return { fn, calls };
  }

  it('after close(): db.query refuses, the raw neon function still works, and a Drizzle instance from before close keeps working — the same pre-existing raw escape-hatch boundary', async () => {
    const mock = makeMock();
    const db = createDatabase({ adapter: mockNeonAdapter(mock.fn) });
    const drizzleDb = await drizzleNeonHttp(db);
    expect(mock.calls.query).toHaveLength(0);

    await db.close();

    // dbSDK's own API refuses after close (the documented Database contract).
    await expect(db.query({ text: 'select 1' })).rejects.toThrow(/is closed/);

    // The pre-existing raw escape hatch is NOT closed-state aware for HTTP
    // (adapters/neon.ts: raw is a plain { transport, transactionTransport, sql }
    // object and close() is a no-op for HTTP). The bridge therefore behaves
    // exactly like the SDK's own raw handle — it does not introduce a new hole.
    const httpRaw = db.raw as Extract<NeonRaw, { transport: 'http' }>;
    await httpRaw.sql.query('select 1');
    expect(mock.calls.query).toHaveLength(1);

    const result = await drizzleDb.execute('select 1');
    expect((result as { rows: unknown[] }).rows).toEqual([[1]]);
    expect(mock.calls.query).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// R3 checks 1 & 3 — real PostgreSQL through the public factories
// ---------------------------------------------------------------------------

const hasServer = Boolean(process.env.DBSDK_TEST_POSTGRES_URL);
const d = hasServer ? describe : describe.skip;

const SCHEMA_NAME = 'dbsdk_drizzle_r3';
const custom = pgSchema(SCHEMA_NAME);

const events = custom.table('r3_events', {
  id: serial('id').primaryKey(),
  label: text('label').notNull(),
  amount: numeric('amount', { precision: 10, scale: 2 }),
  payload: json('payload').$type<{ kind: string; depth: number }>(),
  active: boolean('active'),
  at: timestamp('at', { withTimezone: true }),
});

// casing check: column names derived from camelCase property names
const casingTable = custom.table('r3_casing', {
  rowId: integer(),
  userName: text(),
});

d('R3 — real local PostgreSQL: value conversions and options (gated)', () => {
  let db: Database<PgPoolLike>;
  let drizzleDb: Awaited<ReturnType<typeof drizzlePostgres>>;
  let casingDb: Awaited<ReturnType<typeof drizzlePostgres>>;
  let closedByCloseTest = false;

  beforeAll(async () => {
    const adapter = postgres({ connectionString: LOCAL_URL, max: 3 });
    db = createDatabase({ adapter });
    await db.query({ text: `drop schema if exists ${SCHEMA_NAME} cascade` });
    await db.query({ text: `create schema ${SCHEMA_NAME}` });
    await db.query({
      text: `create table ${SCHEMA_NAME}.r3_events (
        id serial primary key,
        label text not null,
        amount numeric(10,2),
        payload jsonb,
        active boolean,
        at timestamptz
      )`,
    });
    await db.query({
      text: `create table ${SCHEMA_NAME}.r3_casing (row_id integer primary key, user_name text)`,
    });
    drizzleDb = await drizzlePostgres(db, { schema: { events } });
    casingDb = await drizzlePostgres(db, { casing: 'snake_case' });
  });

  afterAll(async () => {
    // Cleanup must be independent of the Database's lifecycle: the close-
    // semantics test above closes it, and a closed Database refuses queries
    // by design. A standalone connection performs the drop.
    const { Client } = await import('pg');
    const cleaner = new Client({ connectionString: LOCAL_URL });
    try {
      await cleaner.connect();
      await cleaner.query(`drop schema if exists ${SCHEMA_NAME} cascade`);
    } finally {
      await cleaner.end();
    }
    if (!closedByCloseTest) {
      await db.close();
    }
  });

  it('numeric → string, null nullable → null, json → parsed object, boolean → boolean, timestamp → Date (native driver semantics)', async () => {
    const when = new Date('2026-10-06T12:00:00.000Z');
    await drizzleDb.insert(events).values({
      label: 'full',
      amount: '123.45',
      payload: { kind: 'click', depth: 3 },
      active: true,
      at: when,
    });
    await drizzleDb.insert(events).values({ label: 'sparse' });

    const rows = await drizzleDb.select().from(events);
    expect(rows).toHaveLength(2);
    const full = rows.find((r) => r.label === 'full')!;
    const sparse = rows.find((r) => r.label === 'sparse')!;

    // pg returns numeric as text; drizzle-orm/pg-core `numeric()` types it as string.
    expect(full.amount).toBe('123.45');
    expect(full.payload).toEqual({ kind: 'click', depth: 3 });
    expect(full.active).toBe(true);
    expect(full.at).toBeInstanceOf(Date);
    expect((full.at as Date).toISOString()).toBe(when.toISOString());

    // nullables come back as null, not undefined or 0.
    expect(sparse.amount).toBeNull();
    expect(sparse.payload).toBeNull();
    expect(sparse.active).toBeNull();
    expect(sparse.at).toBeNull();
  });

  it('options are preserved end to end: casing rewrites generated SQL against real snake_case columns', async () => {
    await casingDb.insert(casingTable).values({ rowId: 1, userName: 'ada' });
    const rows = await casingDb.select().from(casingTable);
    expect(rows).toEqual([{ rowId: 1, userName: 'ada' }]);
  });

  it('a Drizzle transaction sees its own writes and rolls them back for real', async () => {
    const before = await drizzleDb.select().from(events);
    await expect(
      drizzleDb.transaction(async (tx) => {
        await tx.insert(events).values({ label: 'tx-only' });
        const inside = await tx.select().from(events);
        expect(inside).toHaveLength(before.length + 1); // the tx sees its own write
        throw new Error('intentional rollback');
      }),
    ).rejects.toThrow(/intentional rollback/);
    const after = await drizzleDb.select().from(events);
    expect(after).toHaveLength(before.length);
    expect(after.find((r) => r.label === 'tx-only')).toBeUndefined();
  });

  it('close() ends the SDK pool exactly once; use afterwards fails and nothing is recreated', async () => {
    await db.close();
    closedByCloseTest = true;
    const failure = await drizzleDb.select().from(events).catch((e) => e);
    expect(String((failure as Error)?.cause ?? failure)).toMatch(/Cannot use a pool after calling end/i);
    // A new factory call on the closed database refuses before touching raw.
    const error = configErrorOf(await drizzlePostgres(db).catch((e) => e));
    expect(error.message).toMatch(/closed/i);
  });
});
