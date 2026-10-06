/**
 * Independent sync ACCEPTANCE review R8 (reviewer-owned file — NOT implementation).
 *
 * Fresh, independent acceptance evidence for the R7 repair of the two R6 HIGH
 * findings, run against the real frozen source (`src/sync/sql.ts`,
 * sha-256 f68195d7dec31e32c6ff1221d15bcfa7b1325dbe9edf82f16d4ce47775ce3600)
 * and the authorized local PostgreSQL 17 container (`dbsdk-pg-test` :15432).
 * All live schemas are uniquely prefixed `r8acc*` per run and dropped in
 * `finally`. No hosted calls, no secrets, no source/metadata/docs edits.
 *
 * What this file independently verifies (beyond the author's R7 counts):
 *  1. numeric-family arrays (incl. domains, multidimensional, typmod'd, NULLs)
 *     transfer digit-exact through a REAL full copy — batched, resumed, idle —
 *     while native controls (scalar numeric/bigint, int8[], text[]) stay native.
 *  2. A column named exactly `__dbsdk_cursor_0` added after the cached snapshot
 *     fails CONTRACT before any read/write/checkpoint; checkpoint byte-identical;
 *     target untouched. An ordinary new µs-temporal column behaves the same, and
 *     the documented remedy (recreate the source, same identity/key) copies only
 *     NEW rows — old target rows are NOT backfilled (docs must not claim that).
 *  3. The drift guard issues exactly one extra `pg_attribute` read per later read,
 *     BEFORE the data query (incl. empty/idle pages, both verify and assume);
 *     a failed preflight replays with zero new queries; original DbErrors on the
 *     catalog/data paths are passed through unmasked; catalogs without OIDs
 *     classify conservatively (text transport).
 *  4. Explicit `columns`: selected dropped/retyped columns are refused; an
 *     unselected added column is determinately ignored and the requested fields
 *     (incl. the cursor) still come back.
 */

import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { createDatabase, sql } from '../src/index.js';
import { postgres } from '../src/adapters/postgres.js';
import { createSqlSource, createSqlTarget } from '../src/sync/sql.js';
import { createMemoryCheckpointStore, runTransfer } from '../src/sync/core.js';
import { DbError } from '../src/errors.js';
import { SyncError } from '../src/sync/errors.js';
import type { Database } from '../src/types.js';
import type { SqlStatement } from '../src/types.js';

const LOCAL_URL = 'postgresql://postgres:dbsdk@localhost:15432/dbsdk';

function req<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value, got undefined');
  return value;
}

/* ------------------------------------------------------------------ */
/* Offline: a minimal scripted Database fake with an ordered query log  */
/* ------------------------------------------------------------------ */

type Responder = {
  match: RegExp;
  rows?: Record<string, unknown>[];
  rowCount?: number;
  error?: unknown;
  repeat?: boolean;
  /** Set internally once a one-shot responder has been used. */
  consumed?: boolean;
};

/**
 * Ordered responder list: each dispatched query is matched against the FIRST
 * unconsumed (or `repeat`ing) responder; the log records a coarse query kind so
 * tests can assert the exact dispatch ORDER (catalog-before-data), not just counts.
 */
function fakeDb(responders: Responder[]) {
  const log: string[] = [];
  const remaining = [...responders];
  const db = {
    query: async <Row>(statement: SqlStatement): Promise<{ rows: Row[]; rowCount: number | null }> => {
      const text = String((statement as { text?: string }).text ?? statement);
      // pg_index FIRST: the unique-index query's subquery also mentions
      // pg_attribute, so the check order matters.
      const kind = /pg_index/.test(text)
        ? 'index'
        : /pg_attribute/.test(text)
          ? 'attr'
          : /^insert/i.test(text)
            ? 'insert'
            : 'data';
      log.push(kind);
      // Scripted (non-repeat) responders are consumed in order; a `repeat`
      // responder answers forever but never shadows a scripted one.
      let idx = remaining.findIndex(
        (r) => r.match.test(text) && r.repeat !== true && r.consumed !== true,
      );
      if (idx < 0) idx = remaining.findIndex((r) => r.match.test(text) && r.repeat === true);
      const responder = idx >= 0 ? remaining[idx] : undefined;
      if (responder) {
        if (!responder.repeat) responder.consumed = true;
        if ('error' in responder && responder.error !== undefined) throw responder.error;
        return { rows: (responder.rows ?? []) as Row[], rowCount: responder.rowCount ?? responder.rows?.length ?? 0 };
      }
      throw new Error(`fakeDb: no responder for query: ${text.slice(0, 120)}`);
    },
  };
  return { db: db as unknown as Database, log };
}

function catalogRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    attname: 'id',
    attnotnull: true,
    basecategory: 'N',
    basetypname: 'int4',
    baseoid: '26',
    elemcategory: null,
    elemtypname: null,
    elemoid: null,
    ...overrides,
  };
}

/* ================================================================== */
/* 1. Drift-guard dispatch order and cost (offline, both modes)         */
/* ================================================================== */

describe('R8: per-read drift guard dispatch order and cost (offline)', () => {
  it('verify mode: [index, attr, data] on read 1, then exactly [attr, data] before EVERY later read — including an empty idle page', async () => {
    const { db, log } = fakeDb([
      { match: /pg_index/, rows: [{ ok: 1 }] },
      { match: /pg_attribute/, repeat: true, rows: [catalogRow({ attname: 'id' })] },
      { match: /^select/, rows: [{ id: 1, __dbsdk_cursor_0: '1' }] },
      { match: /^select/, rows: [{ id: 2, __dbsdk_cursor_0: '2' }] },
      { match: /^select/, rows: [] }, // idle page: empty result
    ]);
    const source = createSqlSource({ db, table: ['public', 'events'], orderBy: ['id'], identity: 'r8:src' });

    const page1 = await source.read(null, 1);
    expect(page1.rows).toEqual([{ id: 1 }]);
    const page2 = await source.read(page1.cursor!, 1);
    expect(page2.rows).toEqual([{ id: 2 }]);
    const idle = await source.read(page2.cursor!, 1);

    expect(idle).toEqual({ rows: [], cursor: null });
    // Exact dispatch order across all three reads.
    expect(log).toEqual(['index', 'attr', 'data', 'attr', 'data', 'attr', 'data']);
  });

  it('assume mode: no unique-index query ever; the drift check still precedes each later data read', async () => {
    const { db, log } = fakeDb([
      { match: /pg_index/, rows: [{ ok: 1 }] },
      { match: /pg_attribute/, repeat: true, rows: [catalogRow({ attname: 'id' })] },
      { match: /^select/, rows: [{ id: 1, __dbsdk_cursor_0: '1' }] },
      { match: /^select/, rows: [{ id: 2, __dbsdk_cursor_0: '2' }] },
    ]);
    const source = createSqlSource({
      db, table: 'events', orderBy: ['id'], identity: 'r8:src', uniqueOrder: 'assume',
    });

    const q1 = await source.read(null, 1);
    expect(q1.rows).toEqual([{ id: 1 }]);
    const q2 = await source.read(q1.cursor!, 1);
    expect(q2.rows).toEqual([{ id: 2 }]);

    expect(log).toEqual(['attr', 'data', 'attr', 'data']);
    expect(log.filter((k) => k === 'index')).toHaveLength(0);
  });

  it('a failed preflight is memoized: replaying the read issues ZERO additional queries and the same CONTRACT error', async () => {
    const { db, log } = fakeDb([
      { match: /pg_index/, rows: [] }, // no unique index → CONTRACT on read 1
      { match: /pg_attribute/, repeat: true, rows: [catalogRow({ attname: 'id' })] },
      { match: /^select/, repeat: true, rows: [{ id: 1, __dbsdk_cursor_0: '1' }] },
    ]);
    const source = createSqlSource({ db, table: 'events', orderBy: ['id'], identity: 'r8:src' });

    const first = await source.read(null, 1).then(
      () => 'unexpected success',
      (e) => e,
    );
    expect(first).toBeInstanceOf(SyncError);
    expect((first as SyncError).code).toBe('CONTRACT');
    expect(log).toEqual(['index']); // failed BEFORE the metadata query

    const second = await source.read(null, 1).then(
      () => 'unexpected success',
      (e) => e,
    );
    expect(second).toBeInstanceOf(SyncError);
    expect((second as SyncError).code).toBe('CONTRACT');
    expect(log).toEqual(['index']); // replay: no new catalog IO at all
  });

  it('drift failure (scripted added column named exactly __dbsdk_cursor_0) fires BEFORE the data query, with the exact detail', async () => {
    const { db, log } = fakeDb([
      { match: /pg_index/, rows: [{ ok: 1 }] },
      { match: /pg_attribute/, repeat: false, rows: [catalogRow({ attname: 'id' })] },
      { match: /^select/, repeat: true, rows: [{ id: 1, __dbsdk_cursor_0: '1' }] },
      // Drift re-validation on the SECOND read sees the added reserved column:
      { match: /pg_attribute/, repeat: false, rows: [
        catalogRow({ attname: 'id' }),
        catalogRow({ attname: '__dbsdk_cursor_0', basecategory: 'S', basetypname: 'text', baseoid: '25' }),
      ] },
    ]);
    const source = createSqlSource({ db, table: 'events', orderBy: ['id'], identity: 'r8:src' });

    await source.read(null, 1);
    const second = await source.read('["1"]', 1).then(
      () => 'unexpected success',
      (e) => e,
    );
    expect(second).toBeInstanceOf(SyncError);
    expect((second as SyncError).code).toBe('CONTRACT');
    expect(String(second)).toMatch(/added column\(s\)\s*"__dbsdk_cursor_0"/);
    expect(String(second)).toMatch(/schema changed after this instance cached/);
    expect(String(second)).toMatch(/recreate the source/);
    // The data query for read 2 was NEVER dispatched (only read 1's data query ran).
    expect(log).toEqual(['index', 'attr', 'data', 'attr']);
  });
});

/* ================================================================== */
/* 2. Error fidelity on the NEW catalog/data paths (offline)            */
/* ================================================================== */

describe('R8: original DbError is not converted on the new paths (offline)', () => {
  const catalogDbError = new DbError('permission denied for table pg_attribute', {
    code: 'PERMISSION',
    sqlstate: '42501',
    adapterId: 'test',
  });
  const dataDbError = new DbError('connection failure during data read', {
    code: 'CONNECTION',
    adapterId: 'test',
  });

  it('a DbError thrown by the drift catalog query is surfaced AS-IS (not CONTRACT)', async () => {
    const { db } = fakeDb([
      { match: /pg_index/, rows: [{ ok: 1 }] },
      { match: /pg_attribute/, repeat: false, rows: [catalogRow({ attname: 'id' })] },
      { match: /^select/, repeat: true, rows: [{ id: 1, __dbsdk_cursor_0: '1' }] },
      { match: /pg_attribute/, repeat: false, error: catalogDbError },
    ]);
    const source = createSqlSource({ db, table: 'events', orderBy: ['id'], identity: 'r8:src' });
    await source.read(null, 1);
    const second = await source.read('["1"]', 1).then(
      () => 'unexpected success',
      (e) => e,
    );
    expect(second).toBe(catalogDbError); // the original instance, unmasked
  });

  it('a DbError thrown by the data query is surfaced AS-IS, and runTransfer reports it without conversion', async () => {
    const { db } = fakeDb([
      { match: /pg_index/, rows: [{ ok: 1 }] },
      { match: /pg_attribute/, repeat: true, rows: [catalogRow({ attname: 'id' })] },
      { match: /^select/, repeat: false, rows: [{ id: 1, __dbsdk_cursor_0: '1' }] },
      { match: /^select/, repeat: false, error: dataDbError },
    ]);
    const source = createSqlSource({ db, table: 'events', orderBy: ['id'], identity: 'r8:src' });
    const target = {
      identity: 'r8:dst',
      writeMode: 'upsert' as const,
      write: async () => ({ written: 1 }),
    };
    const store = createMemoryCheckpointStore();
    const result = await runTransfer(source, target, { checkpointStore: store, batchSize: 1, maxBatches: 2 });
    expect(result.status).toBe('failed');
    expect(result.error).toBe(dataDbError);
    expect((result.error as DbError).sqlstate).toBeUndefined();
    // One failed attempt only — no auto-retry of the data path.
    expect(result.rowsRead).toBe(1); // first batch succeeded
    expect(result.batches).toBe(1);
  });
});

/* ================================================================== */
/* 3. Conservative classification when the catalog answer lacks OIDs    */
/* ================================================================== */

describe('R8: conservative classification without catalog OIDs (offline)', () => {
  it('numeric-family array classified by NAME (no OIDs) is re-projected as ::text; int8[] control stays native; unresolvable category → text', async () => {
    const queries: string[] = [];
    const { db } = fakeDb([
      { match: /pg_attribute/, repeat: true, rows: [
        catalogRow({ attname: 'id' }),
        catalogRow({ attname: 'na', basecategory: 'A', basetypname: '_numeric', elemcategory: 'N', elemtypname: 'numeric', baseoid: null, elemoid: null }),
        catalogRow({ attname: 'i8', basecategory: 'A', basetypname: '_int8', elemcategory: 'N', elemtypname: 'int8', baseoid: null, elemoid: '20' }),
        catalogRow({ attname: 'mystery', basecategory: null, basetypname: null, baseoid: null }),
      ] },
      { match: /^select/, repeat: true, rows: [{ id: 1, na: '{1}', i8: '{2}', mystery: 'x', __dbsdk_cursor_0: '1' }] },
    ]);
    // The fake above has no onQuery hook; wrap to capture the data query text.
    const wrapped = {
      query: async (statement: SqlStatement) => {
        queries.push(String((statement as { text?: string }).text ?? statement));
        return (db as unknown as { query: (s: SqlStatement) => Promise<unknown> }).query(statement);
      },
    } as unknown as Database;
    const source = createSqlSource({
      db: wrapped, table: 'events', orderBy: ['id'], identity: 'r8:src', uniqueOrder: 'assume',
    });
    const page = await source.read(null, 1);
    expect(page.rows).toEqual([{ id: 1, na: '{1}', i8: '{2}', mystery: 'x' }]);

    const dataQuery = req(queries.find((q) => /^select/.test(q)));
    // Structural guarantee: the read path never emits SELECT *.
    expect(dataQuery).toMatch(/^select\s+"events"\./);
    expect(dataQuery).not.toContain(' * ');
    // numeric-family array (name fallback, no OIDs): exact text transport.
    expect(dataQuery).toContain('"events"."na"::text as "na"');
    // int8[] with a real element OID: native transport is unchanged.
    expect(dataQuery).toContain('"events"."i8"');
    expect(dataQuery).not.toContain('"i8"::text');
    // Unresolvable base type: conservative text transport.
    expect(dataQuery).toContain('"events"."mystery"::text as "mystery"');
    // The `id` control stays native.
    expect(dataQuery).toContain('"events"."id"');
  });
});

/* ------------------------------------------------------------------ */
/* Live helpers (local PG)                                              */
/* ------------------------------------------------------------------ */

const NS = `r8acc${Math.random().toString(36).slice(2, 8)}`;

async function localServerAvailable(): Promise<boolean> {
  try {
    const pool = new Pool({ connectionString: LOCAL_URL, max: 1, connectionTimeoutMillis: 2000 });
    await pool.query('select 1');
    await pool.end();
    return true;
  } catch {
    return false;
  }
}

const available = await localServerAvailable();
const live = available ? describe : describe.skip;

async function makeSide(tag: string): Promise<{ db: Database; schema: string; pool: Pool }> {
  const schema = `${NS}_${tag}`;
  const pool = new Pool({ connectionString: LOCAL_URL, max: 3 });
  await pool.query(`create schema ${schema}`);
  const db = createDatabase({ adapter: postgres({ connectionString: LOCAL_URL, max: 3 }) });
  return { db, schema, pool };
}

async function cleanup(side: { db: Database; schema: string; pool: Pool }): Promise<void> {
  await side.pool.query(`drop schema if exists ${side.schema} cascade`);
  await side.db.close();
  await side.pool.end();
}

/** Per-column `::text` snapshot of a table keyed by its `id` column. */
async function textSnapshot(
  db: Database,
  schema: string,
  table: string,
  cols: readonly string[],
): Promise<Record<string, Record<string, string | null>>> {
  const proj = cols.map((c) => sql`${sql.identifier(c)}::text as ${sql.identifier(c)}`);
  const rows = await db
    .query<Record<string, string | null>>(
      sql`select ${sql.join(proj, ', ')} from ${sql.identifier(schema)}.${sql.identifier(table)} order by 1`,
    )
    .then((r) => r.rows);
  const out: Record<string, Record<string, string | null>> = {};
  for (const row of rows) out[row['id'] as string] = row;
  return out;
}

function checkpointKey(srcIdentity: string, dstIdentity: string): string {
  return `dbsdk.sync:v1:${JSON.stringify([srcIdentity, dstIdentity])}`;
}

/* ================================================================== */
/* 4. Independent live numeric-family fidelity (real full copy)         */
/* ================================================================== */

live('R8: numeric-family arrays digit-exact through a real full copy (live)', () => {
  it('numeric[]/decimal[]/numeric(20,6)[]/multidim/domain-over-numeric/domain[] transfer exactly — batched, resumed, idle; native controls unchanged', async () => {
    const a = await makeSide('num_a');
    const b = await makeSide('num_b');
    try {
      await a.db.query(sql`create domain ${sql.identifier(a.schema)}.dnum as numeric`);
      await a.db.query(
        sql`create table ${sql.identifier(a.schema)}.t (
          id integer primary key, na numeric[], da decimal[], nmd numeric[][],
          tm numeric(20,6)[], dn ${sql.identifier(a.schema)}.dnum,
          dna ${sql.identifier(a.schema)}.dnum[],
          scalar numeric, big bigint, ta text[], i8 int8[])`,
      );
      await b.db.query(
        sql`create table ${sql.identifier(b.schema)}.t (
          id integer primary key, na numeric[], da decimal[], nmd numeric[][],
          tm numeric(20,6)[], dn numeric, dna numeric[],
          scalar numeric, big bigint, ta text[], i8 int8[])`,
      );
      // Two rows, parameterized inserts, crossing the batch boundary; values beyond
      // float64 precision, NULLs inside and AS whole arrays, empty arrays, and
      // adversarial text[] elements.
      await a.db.query(
        sql`insert into ${sql.identifier(a.schema)}.t values
          (1,
           '{1.5000000000000000001,9007199254740993,123456789.123456789012345678901,NULL}',
           '{12345678901234567890.123456789}',
           '{{1.0000000000000000002,2.0},{9007199254740993,NULL}}',
           '{1234567890.123456, -98765.432101}',
           9007199254740993::numeric,
           '{123456789.123456789012345678901,NULL}',
           0.000000000000000001, 9007199254740995,
           '{"he said \\"hi\\"","a,b","back\\\\slash","",NULL}',
           '{9007199254740993,-1,0,NULL}')`,
      );
      await a.db.query(
        sql`insert into ${sql.identifier(a.schema)}.t values
          (2, '{}', NULL, NULL, '{}', NULL, '{}', NULL, -9007199254740995, NULL, '{}')`,
      );

      const srcId = `${NS}:src-num`;
      const dstId = `${NS}:dst-num`;
      const source = createSqlSource({ db: a.db, table: [a.schema, 't'], orderBy: ['id'], identity: srcId });
      const target = createSqlTarget({ db: b.db, table: [b.schema, 't'], key: ['id'], identity: dstId });
      const store = createMemoryCheckpointStore();

      // Batched (batchSize 1) and split across separate runs (resumable).
      const r1 = await runTransfer(source, target, { checkpointStore: store, batchSize: 1, maxBatches: 1 });
      expect(r1.status).toBe('completed');
      expect(r1.exhausted).toBe(false);
      expect(r1.rowsWritten).toBe(1);
      const r2 = await runTransfer(source, target, { checkpointStore: store });
      expect(r2.status).toBe('completed');
      expect(r2.exhausted).toBe(true);
      expect(r2.rowsWritten).toBe(1);
      const idle = await runTransfer(source, target, { checkpointStore: store });
      expect(idle.rowsRead).toBe(0);
      expect(idle.rowsWritten).toBe(0);

      const cols = ['id', 'na', 'da', 'nmd', 'tm', 'dn', 'dna', 'scalar', 'big', 'ta', 'i8'] as const;
      const src = await textSnapshot(a.db, a.schema, 't', cols);
      const dst = await textSnapshot(b.db, b.schema, 't', cols);
      expect(dst).toEqual(src); // full digit-exact source-vs-target equality
      // Spot-check the values that MUST survive beyond double precision:
      expect(dst['1']!.na).toBe('{1.5000000000000000001,9007199254740993,123456789.123456789012345678901,NULL}');
      expect(dst['1']!.da).toBe('{12345678901234567890.123456789}');
      expect(dst['1']!.nmd).toBe('{{1.0000000000000000002,2.0},{9007199254740993,NULL}}');
      expect(dst['1']!.tm).toBe('{1234567890.123456,-98765.432101}');
      expect(dst['1']!.dn).toBe('9007199254740993');
      expect(dst['1']!.dna).toBe('{123456789.123456789012345678901,NULL}');
      expect(dst['1']!.scalar).toBe('0.000000000000000001');
      // Native controls unchanged:
      expect(dst['1']!.big).toBe('9007199254740995');
      expect(dst['1']!.ta).toBe('{"he said \\"hi\\"","a,b","back\\\\slash","",NULL}');
      expect(dst['1']!.i8).toBe('{9007199254740993,-1,0,NULL}');
      // NULLs/empty arrays preserved exactly (never mangled):
      expect(dst['2']!.na).toBe('{}');
      expect(dst['2']!.da).toBeNull();
      expect(dst['2']!.scalar).toBeNull();
    } finally {
      await cleanup(a);
      await cleanup(b);
    }
  });
});

/* ================================================================== */
/* 5. Live exact-alias + temporal drift, checkpoint integrity           */
/* ================================================================== */

live('R8: post-snapshot drift fails loudly before any read/write/checkpoint (live)', () => {
  it('a column named exactly __dbsdk_cursor_0 added after the snapshot → CONTRACT; counts 0; checkpoint byte-identical; target untouched', async () => {
    const a = await makeSide('alias_a');
    const b = await makeSide('alias_b');
    try {
      await a.db.query(sql`create table ${sql.identifier(a.schema)}.events (id integer primary key, value text)`);
      await b.db.query(sql`create table ${sql.identifier(b.schema)}.events (id integer primary key, value text)`);
      await a.db.query(sql`insert into ${sql.identifier(a.schema)}.events values (1, 'one'), (2, 'two')`);

      const srcId = `${NS}:src-alias`;
      const dstId = `${NS}:dst-alias`;
      const source = createSqlSource({ db: a.db, table: [a.schema, 'events'], orderBy: ['id'], identity: srcId });
      const target = createSqlTarget({ db: b.db, table: [b.schema, 'events'], key: ['id'], identity: dstId });
      const store = createMemoryCheckpointStore();
      const key = checkpointKey(srcId, dstId);

      // First read caches the snapshot (before the DDL).
      const page1 = await source.read(null, 1);
      expect(page1.rows).toEqual([{ id: 1, value: 'one' }]);
      const priorCheckpoint = page1.cursor!;
      await store.set(key, priorCheckpoint);

      // Add a real column named EXACTLY like the internal alias, with real data.
      await a.db.query(
        sql`alter table ${sql.identifier(a.schema)}.events add column ${sql.identifier('__dbsdk_cursor_0')} text`,
      );
      await a.db.query(
        sql`update ${sql.identifier(a.schema)}.events set ${sql.identifier('__dbsdk_cursor_0')} = 'PRECIOUS-' || id`,
      );

      const result = await runTransfer(source, target, { checkpointStore: store });
      expect(result.status).toBe('failed');
      expect(result.error).toBeInstanceOf(SyncError);
      expect((result.error as SyncError).code).toBe('CONTRACT');
      expect(String(result.error)).toMatch(/added column\(s\)\s*"__dbsdk_cursor_0"/);
      expect(result.rowsRead).toBe(0);
      expect(result.rowsWritten).toBe(0);
      expect(result.batches).toBe(0);
      // Checkpoint is byte-identical to the pre-existing cursor.
      expect(await store.get(key)).toBe(priorCheckpoint);
      // Zero writes: the target is still empty.
      const count = await b.db.query<{ n: string }>(
        sql`select count(*)::text as n from ${sql.identifier(b.schema)}.events`,
      );
      expect(req(count.rows[0]).n).toBe('0');
    } finally {
      await cleanup(a);
      await cleanup(b);
    }
  });

  it('an ordinary new µs-temporal column → CONTRACT; recreating the source with the SAME identity/key resumes and copies only NEW rows with exact µs — old target rows are NOT backfilled', async () => {
    const a = await makeSide('temp_a');
    const b = await makeSide('temp_b');
    try {
      await a.db.query(sql`create table ${sql.identifier(a.schema)}.events (id integer primary key, value text)`);
      // Target HAS the future column from the start (schema migrated ahead).
      await b.db.query(
        sql`create table ${sql.identifier(b.schema)}.events (id integer primary key, value text, evt_at timestamptz)`,
      );
      await a.db.query(sql`insert into ${sql.identifier(a.schema)}.events values (1, 'one'), (2, 'two')`);

      const srcId = `${NS}:src-temp`;
      const dstId = `${NS}:dst-temp`;
      const source = createSqlSource({ db: a.db, table: [a.schema, 'events'], orderBy: ['id'], identity: srcId });
      const target = createSqlTarget({ db: b.db, table: [b.schema, 'events'], key: ['id'], identity: dstId });
      const store = createMemoryCheckpointStore();
      const key = checkpointKey(srcId, dstId);

      // Initial full copy completes BEFORE the migration; both rows land with
      // evt_at NULL in the target, and the checkpoint advances past id 2.
      const initial = await runTransfer(source, target, { checkpointStore: store });
      expect(initial.status).toBe('completed');
      expect(initial.rowsWritten).toBe(2);

      // A NEW source instance caches its snapshot (schema still without evt_at)…
      const staleSource = createSqlSource({ db: a.db, table: [a.schema, 'events'], orderBy: ['id'], identity: srcId });
      const page1 = await staleSource.read(null, 1);
      expect(page1.rows).toEqual([{ id: 1, value: 'one' }]);
      // …and then the migration lands.
      await a.db.query(sql`alter table ${sql.identifier(a.schema)}.events add column evt_at timestamptz`);
      await a.db.query(
        sql`update ${sql.identifier(a.schema)}.events set evt_at = ('2026-01-01 00:00:00.00000' || id::text)::timestamptz`,
      );

      const stale = await staleSource.read(page1.cursor!, 10).then(
        () => 'unexpected success',
        (e) => e,
      );
      expect(stale).toBeInstanceOf(SyncError);
      expect((stale as SyncError).code).toBe('CONTRACT');
      expect(String(stale)).toMatch(/added column\(s\)\s*"evt_at"/);

      // Documented remedy: recreate the source with the SAME identity; the
      // existing checkpoint key remains valid and the transfer resumes.
      await a.db.query(
        sql`insert into ${sql.identifier(a.schema)}.events (id, value, evt_at) values (3, 'three', '2026-01-03 00:00:00.000003+00')`,
      );
      const recreated = createSqlSource({ db: a.db, table: [a.schema, 'events'], orderBy: ['id'], identity: srcId });
      const resume = await runTransfer(recreated, target, { checkpointStore: store });
      expect(resume.status).toBe('completed');
      expect(resume.rowsWritten).toBe(1); // only the NEW row (id 3) is copied

      const snap = await textSnapshot(b.db, b.schema, 'events', ['id', 'value', 'evt_at']);
      // Old rows: copied before the migration; their evt_at stays NULL —
      // high-water resume does NOT backfill old target rows (docs contract).
      expect(snap['1']!.evt_at).toBeNull();
      expect(snap['1']!.value).toBe('one');
      expect(snap['2']!.evt_at).toBeNull();
      // New row: exact microsecond text, no precision loss.
      expect(snap['3']!.evt_at).toBe('2026-01-03 00:00:00.000003+00');
      expect(snap['3']!.value).toBe('three');
    } finally {
      await cleanup(a);
      await cleanup(b);
    }
  });
});

/* ================================================================== */
/* 6. Live explicit-columns drift semantics                             */
/* ================================================================== */

live('R8: explicit columns — selected dropped/retyped refused; unselected added ignored (live)', () => {
  it('dropped or retyped SELECTED columns → CONTRACT; an UNSELECTED added column is ignored and requested fields incl. cursor still return', async () => {
    const a = await makeSide('col_a');
    try {
      await a.db.query(sql`create table ${sql.identifier(a.schema)}.events (id integer primary key, value text)`);
      await a.db.query(sql`insert into ${sql.identifier(a.schema)}.events values (1, 'one'), (2, 'two')`);

      const srcId = `${NS}:src-cols`;

      // (1) selected column dropped → CONTRACT naming it.
      const s1 = createSqlSource({
        db: a.db, table: [a.schema, 'events'], orderBy: ['id'], identity: srcId, columns: ['id', 'value'],
      });
      const p1 = await s1.read(null, 10);
      expect(p1.rows).toEqual([{ id: 1, value: 'one' }, { id: 2, value: 'two' }]);
      await a.db.query(sql`alter table ${sql.identifier(a.schema)}.events drop column value`);
      const dropErr = await s1.read(p1.cursor!, 10).then(() => 'ok', (e) => e);
      expect(dropErr).toBeInstanceOf(SyncError);
      expect((dropErr as SyncError).code).toBe('CONTRACT');
      expect(String(dropErr)).toMatch(/"value" no longer exists/);

      // (2) selected column retyped → CONTRACT naming it.
      await a.db.query(sql`alter table ${sql.identifier(a.schema)}.events add column value text`);
      await a.db.query(sql`update ${sql.identifier(a.schema)}.events set value = 'x' || id`);
      const s2 = createSqlSource({
        db: a.db, table: [a.schema, 'events'], orderBy: ['id'], identity: srcId, columns: ['id', 'value'],
      });
      const p2 = await s2.read(null, 10);
      await a.db.query(
        sql`alter table ${sql.identifier(a.schema)}.events alter column value type integer USING length(value)`,
      );
      const retypeErr = await s2.read(p2.cursor!, 10).then(() => 'ok', (e) => e);
      expect(retypeErr).toBeInstanceOf(SyncError);
      expect((retypeErr as SyncError).code).toBe('CONTRACT');
      expect(String(retypeErr)).toMatch(/"value" changed type/);

      // (3) unselected column added after the snapshot: determinately ignored;
      // the requested fields and the exact cursor still come back.
      const s3 = createSqlSource({
        db: a.db, table: [a.schema, 'events'], orderBy: ['id'], identity: srcId, columns: ['id'],
      });
      const p3 = await s3.read(null, 10);
      expect(p3.rows).toEqual([{ id: 1 }, { id: 2 }]);
      await a.db.query(sql`alter table ${sql.identifier(a.schema)}.events add column extra text`);
      await a.db.query(sql`update ${sql.identifier(a.schema)}.events set extra = 'E' || id`);
      const p4 = await s3.read(p3.cursor!, 10);
      expect(p4.rows).toEqual([]); // id 2 was already consumed; idle page still succeeds
      const s4 = createSqlSource({
        db: a.db, table: [a.schema, 'events'], orderBy: ['id'], identity: srcId, columns: ['id'],
      });
      const p5 = await s4.read(null, 10);
      expect(p5.rows).toEqual([{ id: 1 }, { id: 2 }]); // `extra` is NOT in the payload
      expect(p5.cursor).toBe(JSON.stringify(['2']));
    } finally {
      await cleanup(a);
    }
  });
});

/* ================================================================== */
/* 7. Live per-read catalog cost observed through a query wrapper       */
/* ================================================================== */

live('R8: live dispatch counting through a query wrapper (live)', () => {
  it('exactly one pg_attribute read per later read, BEFORE the data query; drift fires with no data query; assume mode has zero pg_index', async () => {
    const a = await makeSide('cnt_a');
    try {
      await a.db.query(sql`create table ${sql.identifier(a.schema)}.events (id integer primary key, value text)`);
      await a.db.query(sql`insert into ${sql.identifier(a.schema)}.events values (1, 'one'), (2, 'two')`);

      const kinds: string[] = [];
      const inner = a.db;
      const countingDb = {
        query: (statement: SqlStatement) => {
          const text = String((statement as { text?: string }).text ?? statement);
          // pg_index FIRST: the unique-index query's subquery also mentions
          // pg_attribute, so the check order matters.
          kinds.push(
            /pg_index/.test(text) ? 'index' : /pg_attribute/.test(text) ? 'attr' : 'data',
          );
          return inner.query(statement);
        },
      } as unknown as Database;

      const source = createSqlSource({
        db: countingDb, table: [a.schema, 'events'], orderBy: ['id'], identity: `${NS}:src-cnt`,
      });
      const p1 = await source.read(null, 1);
      expect(p1.rows).toEqual([{ id: 1, value: 'one' }]);
      expect(kinds).toEqual(['index', 'attr', 'data']);

      kinds.length = 0;
      const p2 = await source.read(p1.cursor!, 1);
      expect(p2.rows).toEqual([{ id: 2, value: 'two' }]);
      expect(kinds).toEqual(['attr', 'data']); // exactly one extra catalog read, first

      // assume mode: no pg_index query at all, drift check still per-read.
      kinds.length = 0;
      const assumeSource = createSqlSource({
        db: countingDb, table: [a.schema, 'events'], orderBy: ['id'],
        identity: `${NS}:src-cnt2`, uniqueOrder: 'assume',
      });
      const q1 = await assumeSource.read(null, 1);
      expect(q1.rows).toEqual([{ id: 1, value: 'one' }]);
      expect(kinds).toEqual(['attr', 'data']);
      kinds.length = 0;
      const q2 = await assumeSource.read(q1.cursor!, 1);
      expect(q2.rows).toEqual([{ id: 2, value: 'two' }]);
      expect(kinds).toEqual(['attr', 'data']);

      // Drift: after the DDL, the catalog check fires and the data query does NOT.
      await a.db.query(sql`alter table ${sql.identifier(a.schema)}.events add column evt_at timestamptz`);
      kinds.length = 0;
      const driftErr = await source.read(p2.cursor!, 1).then(() => 'ok', (e) => e);
      expect(driftErr).toBeInstanceOf(SyncError);
      expect((driftErr as SyncError).code).toBe('CONTRACT');
      expect(kinds).toEqual(['attr']); // no data query was dispatched
    } finally {
      await cleanup(a);
    }
  });
});
