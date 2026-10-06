/**
 * Independent sync/data-fidelity ACCEPTANCE review R6 (reviewer-owned file).
 *
 * Scope: one-way resumable keyset transfer through the common source/target/
 * checkpoint interfaces — run fresh evidence against the REAL source code and the
 * authorized local PostgreSQL 17 test container (dbsdk-pg-test :15432), not the
 * author's R5 labels. All schemas used here are uniquely prefixed `r6acc*` per run
 * and dropped in `finally` — no shared/fixed table names, no hosted calls.
 *
 * R7 status: the two defects confirmed here (R6-A numeric-array precision loss,
 * R6-B silent drop of a post-snapshot column named exactly `__dbsdk_cursor_0`)
 * were fixed by the sync owner. The two sections that were labeled "BUG DEMO"
 * (pinning the buggy behavior) are now actual REGRESSIONS for the fixed
 * behavior, with assertions flipped to the faithful/loud expectations; all
 * other independent acceptance assertions are unchanged (only the scripted
 * catalog fixtures gained `repeat: true`, because reads after the first now
 * re-validate the cached schema snapshot with the same catalog query).
 */

import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { createDatabase, sql } from '../src/index.js';
import { postgres } from '../src/adapters/postgres.js';
import { createFixtureAdapter, type FixtureAdapterOptions } from '../src/testing.js';
import { createSqlSource, createSqlTarget } from '../src/sync/sql.js';
import { createMemoryCheckpointStore, runTransfer } from '../src/sync/core.js';
import { DbError } from '../src/errors.js';
import { SyncError } from '../src/sync/errors.js';
import type { Database } from '../src/types.js';
import type { CheckpointStore } from '../src/sync/types.js';

const LOCAL_URL = 'postgresql://postgres:dbsdk@localhost:15432/dbsdk';

function req<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value, got undefined');
  return value;
}

/* ------------------------------------------------------------------ */
/* Offline helpers (fixture adapter)                                    */
/* ------------------------------------------------------------------ */

function fixtureDb(
  fixtures: NonNullable<FixtureAdapterOptions['fixtures']>,
  options?: Omit<FixtureAdapterOptions, 'fixtures'>,
) {
  return createDatabase({ adapter: createFixtureAdapter({ ...options, fixtures }) });
}

/* ------------------------------------------------------------------ */
/* Live helpers (local PG) — unique per-run schema namespace            */
/* ------------------------------------------------------------------ */

const NS = `r6acc${Math.random().toString(36).slice(2, 8)}`;

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

/** Two independent dbSDK clients (like two providers) sharing one PG server. */
async function makeSideWithPool(tag: string): Promise<{ db: Database; schema: string; pool: Pool }> {
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

/** Full per-column `::text` snapshot of a table, keyed by an order column. */
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

/* ================================================================== */
/* 1. Identity / checkpoint-key contract (offline)                      */
/* ================================================================== */

describe('R6 acceptance: identity + injective checkpoint keys (offline)', () => {
  it('missing identity throws at construction — zero queries dispatched', async () => {
    const queries: unknown[] = [];
    const db = fixtureDb([], { onQuery: (q) => queries.push(q) });
    expect(() =>
      createSqlSource({ db, table: 'events', orderBy: ['id'] } as never),
    ).toThrow(/explicit, stable, secret-free identity/);
    expect(() =>
      createSqlTarget({ db, table: 'events', key: ['id'] } as never),
    ).toThrow(/explicit, stable, secret-free identity/);
    // No query left the client before the contract error.
    expect(queries).toHaveLength(0);
    // runTransfer-level structural check too (hand-rolled endpoints).
    await expect(
      runTransfer(
        { ordering: 'ordered', read: async () => ({ rows: [], cursor: null }) } as never,
        { writeMode: 'upsert', write: async () => ({ written: 0 }) } as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
  });

  it('default keys are injective over adversarial identity pairs; explicit keys stay verbatim', async () => {
    const captured: Array<{ key: string }> = [];
    const makeStore = (): CheckpointStore => {
      const map = new Map<string, string>();
      return {
        async get(key) {
          captured.push({ key });
          return map.get(key) ?? null;
        },
        async set(key) {
          map.set(key, 'cursor-x');
        },
      };
    };

    const pairs: Array<[string, string]> = [
      ['alpha', 'beta->gamma'],
      ['alpha->beta', 'gamma'],
      ['a"b', 'c[d]{e}'],
      ['ünïcodé→', '→ünïcodé'],
      ['a', 'a->b->c'],
      ['a->b->c', 'a'],
      ['', 'nonempty-not-constructible'],
    ].slice(0, 6) as Array<[string, string]>;

    const keys = new Set<string>();
    for (const [src, dst] of pairs) {
      const store = makeStore();
      await runTransfer(
        { identity: src, ordering: 'ordered', read: async () => ({ rows: [], cursor: null }) },
        { identity: dst, writeMode: 'upsert', write: async () => ({ written: 0 }) },
        { checkpointStore: store },
      );
      expect(captured.at(-1)).toBeDefined();
      const seen = captured.at(-1)!.key;
      keys.add(seen);
      expect(seen.startsWith('dbsdk.sync:v1:')).toBe(true);
    }
    // Every pair maps to a DISTINCT key (injective), including the ->-colliding pair.
    expect(keys.size).toBe(pairs.length);

    // Explicit checkpointKey keeps verbatim semantics.
    const store = makeStore();
    await runTransfer(
      { identity: 's', ordering: 'ordered', read: async () => ({ rows: [], cursor: null }) },
      { identity: 't', writeMode: 'upsert', write: async () => ({ written: 0 }) },
      { checkpointStore: store, checkpointKey: 'caller:owns:this-key' },
    );
    expect(captured.at(-1)!.key).toBe('caller:owns:this-key');
  });

  it('same store, two colliding-identity DB pairs, interleaved: each pair transfers its own rows', async () => {
    // Old-format collision: ("alpha","beta->gamma") vs ("alpha->beta","gamma").
    const mk = (rows: Array<Record<string, unknown>>, n: string) =>
      fixtureDb(
        [
          {
            match: /pg_attribute/,
            params: ['events', null, null],
            // repeat: reads after the first re-validate the cached schema
            // snapshot (per-read drift guard) with the same catalog query.
            repeat: true,
            rows: [
              { attname: 'id', attnotnull: true, basecategory: 'N', basetypname: 'int4', elemcategory: null, elemtypname: null },
            ],
          },
          { match: /^select/, rows },          // first page, single use
          { match: /^select/, rows: [], repeat: true }, // subsequent pages: exhausted
          { match: /^insert/, rowCount: rows.length, repeat: true },
        ],
      );
    const store = createMemoryCheckpointStore();
    const sourceA = createSqlSource({ db: mk([{ id: 1, v: 'A1', __dbsdk_cursor_0: '1' }], 'a'), table: 'events', orderBy: ['id'], identity: 'alpha', uniqueOrder: 'assume' });
    const targetA = createSqlTarget({ db: mk([{ id: 1, v: 'A1', __dbsdk_cursor_0: '1' }], 'a'), table: 'events', key: ['id'], identity: 'beta->gamma' });
    const sourceB = createSqlSource({ db: mk([{ id: 2, v: 'B2', __dbsdk_cursor_0: '2' }], 'b'), table: 'events', orderBy: ['id'], identity: 'alpha->beta', uniqueOrder: 'assume' });
    const targetB = createSqlTarget({ db: mk([{ id: 2, v: 'B2', __dbsdk_cursor_0: '2' }], 'b'), table: 'events', key: ['id'], identity: 'gamma' });

    const r1 = await runTransfer(sourceA, targetA, { checkpointStore: store, batchSize: 10 });
    const r2 = await runTransfer(sourceB, targetB, { checkpointStore: store, batchSize: 10 });
    expect(r1.status).toBe('completed');
    expect(r2.status).toBe('completed');
    expect(r1.rowsWritten).toBe(1);
    expect(r2.rowsWritten).toBe(1);
    // Two distinct keys, one per endpoint pair (the old format would share one).
    expect(r1.lastCursor).not.toEqual(r2.lastCursor);
  });

  it('old pre-v1 ambiguous keys are NEVER auto-adopted (fresh run re-copies)', async () => {
    // Seed a store with the old "src->dst" format holding a fake resume cursor.
    const seeded = createMemoryCheckpointStore({ 'oldsrc->olddst': '["9999999"]' });
    let readCursor: string | null | undefined;
    const db = fixtureDb(
      [
        {
          match: /pg_attribute/,
          params: ['events', null, null],
          repeat: true,
          rows: [{ attname: 'id', attnotnull: true, basecategory: 'N', basetypname: 'int4', elemcategory: null, elemtypname: null }],
        },
        {
          match: /^select/,
          rows: [{ id: 1, __dbsdk_cursor_0: '1' }],
        },
        { match: /^select/, rows: [], repeat: true },
        { match: /^insert/, rowCount: 1, repeat: true },
      ],
      {
        onQuery: (q) => {
          if (q.text.includes('where ("id") > ($1)')) readCursor = (q.params as unknown[])[0] as string;
        },
      },
    );
    const source = createSqlSource({ db, table: 'events', orderBy: ['id'], identity: 'oldsrc', uniqueOrder: 'assume' });
    const target = createSqlTarget({ db, table: 'events', key: ['id'], identity: 'olddst' });
    const result = await runTransfer(source, target, { checkpointStore: seeded, batchSize: 10 });
    expect(result.status).toBe('completed');
    expect(result.rowsWritten).toBe(1);
    // The old key was ignored: the fresh run started from the BEGINNING. The
    // first continuing read used the first page's cursor ('1'), never the
    // stale '9999999' from the pre-v1 key.
    expect(readCursor).toBe('1');
  });
});

/* ================================================================== */
/* 2. Offline failure shapes (recovery/receipt/errors)                  */
/* ================================================================== */

describe('R6 acceptance: failure shapes and honest counts (offline)', () => {
  const metaFixture = (cols: Array<Record<string, unknown>> = []): NonNullable<FixtureAdapterOptions['fixtures']>[number] => ({
    match: /pg_attribute/,
    params: ['events', null, null],
    // repeat: reads after the first re-validate the cached schema snapshot
    // (per-read drift guard) with the same catalog query.
    repeat: true,
    rows: [
      { attname: 'id', attnotnull: true, basecategory: 'N', basetypname: 'int4', elemcategory: null, elemtypname: null },
      ...cols,
    ],
  });

  it('store.get failure → failed result, zero reads, zero writes, zero dispatch', async () => {
    const queries: string[] = [];
    const boom = new Error('durable store unavailable');
    const store: CheckpointStore = {
      async get() {
        throw boom;
      },
      async set() {},
    };
    const db = fixtureDb([metaFixture(), { match: /^select/, rows: [{ id: 1, __dbsdk_cursor_0: '1' }] }, { match: /^insert/, rowCount: 1 }], {
      onQuery: (q) => queries.push(q.text),
    });
    const source = createSqlSource({ db, table: 'events', orderBy: ['id'], identity: 's', uniqueOrder: 'assume' });
    const target = createSqlTarget({ db, table: 'events', key: ['id'], identity: 'd' });
    const result = await runTransfer(source, target, { checkpointStore: store });
    expect(result.status).toBe('failed');
    expect(result.batches).toBe(0);
    expect(result.rowsRead).toBe(0);
    expect(result.rowsWritten).toBe(0);
    expect(result.lastCursor).toBeNull();
    expect(result.error).toBe(boom);
    expect(queries).toHaveLength(0); // no query left the client
  });

  it('invalid write receipt → named CONTRACT failure, checkpoint NOT advanced', async () => {
    const sets: string[] = [];
    const store: CheckpointStore = {
      async get() {
        return null;
      },
      async set(key) {
        sets.push(key);
      },
    };
    let inserted = 0;
    const db = fixtureDb(
      [
        metaFixture(),
        { match: /^select/, rows: [{ id: 1, __dbsdk_cursor_0: '1' }, { id: 2, __dbsdk_cursor_0: '2' }], repeat: true },
        { match: /^select/, rows: [], repeat: true },
        { match: /^insert/, rowCount: 99, repeat: true },
      ],
      { onQuery: (q) => { if (/^insert/.test(q.text)) inserted += 1; } },
    );
    const source = createSqlSource({ db, table: 'events', orderBy: ['id'], identity: 's', uniqueOrder: 'assume' });
    const target = createSqlTarget({ db, table: 'events', key: ['id'], identity: 'd' });
    const result = await runTransfer(source, target, { checkpointStore: store, batchSize: 2 });
    expect(result.status).toBe('failed');
    expect(result.error).toBeInstanceOf(SyncError);
    expect((result.error as SyncError).code).toBe('CONTRACT');
    expect(String(result.error)).toMatch(/invalid write receipt/);
    expect(result.lastCursor).toBeNull();
    expect(sets).toEqual([]); // checkpoint never advanced
  });

  it('oversized page → refused BEFORE any write; map throw → failed with original error', async () => {
    // Oversize
    let inserts = 0;
    const db1 = fixtureDb(
      [
        metaFixture(),
        { match: /^select/, rows: [
          { id: 1, __dbsdk_cursor_0: '1' },
          { id: 2, __dbsdk_cursor_0: '2' },
          { id: 3, __dbsdk_cursor_0: '3' },
        ] },
        { match: /^insert/, rowCount: 3, repeat: true },
      ],
      { onQuery: (q) => { if (/^insert/.test(q.text)) inserts += 1; } },
    );
    const s1 = createSqlSource({ db: db1, table: 'events', orderBy: ['id'], identity: 's', uniqueOrder: 'assume' });
    const t1 = createSqlTarget({ db: db1, table: 'events', key: ['id'], identity: 'd' });
    const r1 = await runTransfer(s1, t1, { batchSize: 2 });
    expect(r1.status).toBe('failed');
    expect((r1.error as SyncError).code).toBe('CONTRACT');
    expect(String(r1.error)).toMatch(/oversized|exceed|limit/i);
    expect(inserts).toBe(0);

    // Map throw
    const cause = new Error('map exploded');
    const db2 = fixtureDb(
      [
        metaFixture(),
        { match: /^select/, rows: [{ id: 1, __dbsdk_cursor_0: '1' }] },
        { match: /^insert/, rowCount: 1, repeat: true },
      ],
    );
    const s2 = createSqlSource({ db: db2, table: 'events', orderBy: ['id'], identity: 's', uniqueOrder: 'assume' });
    const t2 = createSqlTarget({ db: db2, table: 'events', key: ['id'], identity: 'd' });
    const r2 = await runTransfer(s2, t2, { map: () => { throw cause; } });
    expect(r2.status).toBe('failed');
    expect(r2.error).toBe(cause);
    expect(r2.rowsWritten).toBe(0);
  });

  it('store.set failure AFTER target commit → failed, lastCursor shows the committed cursor', async () => {
    const durable = createMemoryCheckpointStore();
    let setCalls = 0;
    const crashy: CheckpointStore = {
      async get(key) {
        return durable.get(key);
      },
      async set(key, value) {
        setCalls += 1;
        if (setCalls === 1) throw new Error('checkpoint store write failed');
        await durable.set(key, value);
      },
    };
    const db = fixtureDb(
      [
        metaFixture(),
        { match: /^select/, rows: [{ id: 1, __dbsdk_cursor_0: '1' }, { id: 2, __dbsdk_cursor_0: '2' }], repeat: true },
        { match: /^select/, rows: [], repeat: true },
        { match: /^insert/, rowCount: 2, repeat: true },
      ],
    );
    const source = createSqlSource({ db, table: 'events', orderBy: ['id'], identity: 's', uniqueOrder: 'assume' });
    const target = createSqlTarget({ db, table: 'events', key: ['id'], identity: 'd' });
    const result = await runTransfer(source, target, { checkpointStore: crashy, batchSize: 2 });
    expect(result.status).toBe('failed');
    expect(result.batches).toBe(1);
    expect(result.rowsWritten).toBe(2);
    expect(result.lastCursor).toBe(JSON.stringify(['2'])); // committed on target, honest lastCursor
  });

  it('maxBatches → completed, exhausted:false, resumable', async () => {
    const store = createMemoryCheckpointStore();
    const db = fixtureDb(
      [
        metaFixture(),
        { match: /^select/, rows: [{ id: 1, __dbsdk_cursor_0: '1' }, { id: 2, __dbsdk_cursor_0: '2' }] },
        { match: /^select/, rows: [], repeat: true },
        { match: /^insert/, rowCount: 2, repeat: true },
      ],
    );
    const source = createSqlSource({ db, table: 'events', orderBy: ['id'], identity: 's', uniqueOrder: 'assume' });
    const target = createSqlTarget({ db, table: 'events', key: ['id'], identity: 'd' });
    const first = await runTransfer(source, target, { checkpointStore: store, batchSize: 2, maxBatches: 1 });
    expect(first.status).toBe('completed');
    expect(first.exhausted).toBe(false);
    expect(first.rowsWritten).toBe(2);
    const second = await runTransfer(source, target, { checkpointStore: store, batchSize: 2 });
    expect(second.status).toBe('completed');
    expect(second.exhausted).toBe(true);
  });
});

/* ================================================================== */
/* 3. LIVE data fidelity on real PostgreSQL 17                          */
/* ================================================================== */

live('R6 acceptance: live JSON fidelity (real PG)', () => {
  it('json/jsonb []/[1,2]/nested/scalars/string/true/JSON-null vs SQL-null round-trip exactly', async () => {
    const a = await makeSideWithPool('fjson_a');
    const b = await makeSideWithPool('fjson_b');
    try {
      for (const side of [a, b]) {
        await side.db.query(
          sql`create table ${sql.identifier(side.schema)}.docs (id integer primary key, doc jsonb, jsn json)`,
        );
      }
      await a.db.query(
        sql`insert into ${sql.identifier(a.schema)}.docs values
          (1, '[]'::jsonb, '[]'::json),
          (2, '[1,2]'::jsonb, '[1,2]'::json),
          (3, '{"t":[[],[1,2]],"u":{"v":"w"}}'::jsonb, '{"t":[[],[1,2]]}'::json),
          (4, '"hello"'::jsonb, 'true'::json),
          (5, 'true'::jsonb, '42'::json),
          (6, 'null'::jsonb, 'null'::json)`,
      );
      // Row 7: SQL NULL in both columns (must stay SQL NULL, not JSON null).
      await a.db.query(sql`insert into ${sql.identifier(a.schema)}.docs (id) values (7)`);

      const result = await runTransfer(
        createSqlSource({ db: a.db, table: [a.schema, 'docs'], orderBy: ['id'], identity: `${NS}:src-json` }),
        createSqlTarget({ db: b.db, table: [b.schema, 'docs'], key: ['id'], identity: `${NS}:dst-json` }),
        { batchSize: 3, checkpointStore: createMemoryCheckpointStore() },
      );
      expect(result.status).toBe('completed');
      expect(result.rowsWritten).toBe(7);

      const cols = ['id', 'doc', 'jsn'] as const;
      const src = await textSnapshot(b.db, a.schema, 'docs', cols);
      const dst = await textSnapshot(b.db, b.schema, 'docs', cols);
      expect(dst).toEqual(src);
      expect(dst['1']!.doc).toBe('[]');           // never {}
      expect(dst['2']!.doc).toBe('[1, 2]');
      expect(dst['3']!.doc).toBe('{"t": [[], [1, 2]], "u": {"v": "w"}}');
      expect(dst['4']!.doc).toBe('"hello"');
      expect(dst['5']!.jsn).toBe('42');
      expect(dst['6']!.doc).toBe('null');          // JSON null ≠ SQL null
      expect(dst['7']!.doc).toBeNull();            // SQL null stays SQL null
      expect(dst['7']!.jsn).toBeNull();
    } finally {
      await cleanup(a);
      await cleanup(b);
    }
  });

  it('target encodes native-mapped JS arrays safely for json/jsonb columns (JSON.stringify path)', async () => {
    const b = await makeSideWithPool('fjsarr_b');
    try {
      await b.db.query(sql`create table ${sql.identifier(b.schema)}.dst (id integer primary key, doc jsonb)`);
      const target = createSqlTarget({ db: b.db, table: [b.schema, 'dst'], key: ['id'], identity: `${NS}:dst-jsonarr` });
      const written = await target.write([
        { id: 1, doc: [] as unknown[] },
        { id: 2, doc: [1, 2] },
        { id: 3, doc: [{ a: [1, 2] }] },
      ]);
      expect(written.written).toBe(3);
      const rows = await b.db.query<{ id: number; t: string }>(
        sql`select id, doc::text as t from ${sql.identifier(b.schema)}.dst order by id`,
      ).then((r) => r.rows);
      expect(rows[0]!.t).toBe('[]');
      expect(rows[1]!.t).toBe('[1, 2]');
      expect(rows[2]!.t).toBe('[{"a": [1, 2]}]');
    } finally {
      await cleanup(b);
    }
  });

  it('PG text[]/int8[] values with quotes/backslashes/commas/empty/NULL elements round-trip exactly', async () => {
    const a = await makeSideWithPool('fparr_a');
    const b = await makeSideWithPool('fparr_b');
    try {
      for (const side of [a, b]) {
        await side.db.query(
          sql`create table ${sql.identifier(side.schema)}.t (id integer primary key, tags text[], nums int8[])`,
        );
      }
      await a.db.query(
        sql`insert into ${sql.identifier(a.schema)}.t values
          (1, ARRAY['a"b', 'c\\d', 'e,f', '', NULL, 'g''h'], '{9007199254740993,-9007199254740993,0}'),
          (2, ARRAY[]::text[], NULL)`,
      );
      const result = await runTransfer(
        createSqlSource({ db: a.db, table: [a.schema, 't'], orderBy: ['id'], identity: `${NS}:src-parr` }),
        createSqlTarget({ db: b.db, table: [b.schema, 't'], key: ['id'], identity: `${NS}:dst-parr` }),
        { batchSize: 1, checkpointStore: createMemoryCheckpointStore() },
      );
      expect(result.status).toBe('completed');
      expect(result.rowsWritten).toBe(2);

      const cols = ['id', 'tags', 'nums'] as const;
      const src = await textSnapshot(b.db, a.schema, 't', cols);
      const dst = await textSnapshot(b.db, b.schema, 't', cols);
      expect(dst).toEqual(src);
      expect(dst['1']!.tags).toBe(`{"a\\"b","c\\\\d","e,f","",NULL,g'h}`);
      expect(dst['1']!.nums).toBe('{9007199254740993,-9007199254740993,0}');
      expect(dst['2']!.tags).toBe('{}');
      expect(dst['2']!.nums).toBeNull();
    } finally {
      await cleanup(a);
      await cleanup(b);
    }
  });

  it('R6-A regression: numeric[]/decimal[] (incl. domains and multidimensional arrays) transfer EXACTLY — no silent precision loss', async () => {
    const a = await makeSideWithPool('fnum_a');
    const b = await makeSideWithPool('fnum_b');
    try {
      // Domain over numeric: the element/domain walk must resolve it to the
      // `numeric` base type (OID 1700) — `decimal` is an alias of `numeric`.
      await a.db.query(sql`create domain ${sql.identifier(a.schema)}.dnum as numeric`);
      await a.db.query(
        sql`create table ${sql.identifier(a.schema)}.t (
          id integer primary key, na numeric[], da decimal[], nmd numeric[][],
          dna ${sql.identifier(a.schema)}.dnum[], scalar numeric, big bigint)`,
      );
      // The target keeps the plain base types (domain → base is the same storage).
      await b.db.query(
        sql`create table ${sql.identifier(b.schema)}.t (
          id integer primary key, na numeric[], da decimal[], nmd numeric[][],
          dna numeric[], scalar numeric, big bigint)`,
      );
      await a.db.query(
        sql`insert into ${sql.identifier(a.schema)}.t values
          (1,
           '{1.5000000000000000001,9007199254740993,123456789.123456789012345678901,NULL}',
           '{12345678901234567890.123456789}',
           '{{1.0000000000000000002,2.0},{9007199254740993,NULL}}',
           '{123456789.123456789012345678901,NULL}',
           9007199254740993::numeric,
           9007199254740995)`,
      );

      const source = createSqlSource({ db: a.db, table: [a.schema, 't'], orderBy: ['id'], identity: `${NS}:src-num` });
      const target = createSqlTarget({ db: b.db, table: [b.schema, 't'], key: ['id'], identity: `${NS}:dst-num` });
      const result = await runTransfer(source, target, { checkpointStore: createMemoryCheckpointStore() });
      expect(result.status).toBe('completed');
      expect(result.rowsWritten).toBe(1);

      const cols = ['id', 'na', 'da', 'nmd', 'dna', 'scalar', 'big'] as const;
      const src = await textSnapshot(b.db, a.schema, 't', cols);
      const dst = await textSnapshot(b.db, b.schema, 't', cols);
      // FIXED (was R6 finding A): the whole transfer is exact, digit for digit.
      expect(dst).toEqual(src);
      // Every value beyond double precision survives verbatim:
      expect(dst['1']!.na).toBe('{1.5000000000000000001,9007199254740993,123456789.123456789012345678901,NULL}');
      expect(dst['1']!.da).toBe('{12345678901234567890.123456789}');
      expect(dst['1']!.nmd).toBe('{{1.0000000000000000002,2.0},{9007199254740993,NULL}}');
      expect(dst['1']!.dna).toBe('{123456789.123456789012345678901,NULL}');
      // Controls that stay exact (scalar numeric keeps string transport; bigint exact):
      expect(dst['1']!.scalar).toBe('9007199254740993');
      expect(dst['1']!.big).toBe('9007199254740995');
    } finally {
      await cleanup(a);
      await cleanup(b);
    }
  });
});

live('R6 acceptance: live temporal/domain fidelity + exact cursors across resumes', () => {
  it('date/time/timestamp/timestamptz µs, interval, temporal arrays, domain-wrapped types: exact payload AND exact stored cursor', async () => {
    const a = await makeSideWithPool('ftemp_a');
    const b = await makeSideWithPool('ftemp_b');
    try {
      await a.db.query(sql`create domain ${sql.identifier(a.schema)}.ddom as date`);
      await a.db.query(sql`create domain ${sql.identifier(a.schema)}.tsdom as timestamptz`);
      await b.db.query(sql`create table ${sql.identifier(b.schema)}.t (
        id integer primary key, tstz timestamptz not null, ts timestamp, t6 time, d date,
        iv interval, tarr timestamptz[], ddom date, tsdom timestamptz,
        by bytea, num numeric(20,6), big bigint)`);
      await a.db.query(sql`create table ${sql.identifier(a.schema)}.t (
        id integer primary key, tstz timestamptz not null, ts timestamp, t6 time, d date,
        iv interval, tarr timestamptz[], ddom ${sql.identifier(a.schema)}.ddom, tsdom ${sql.identifier(a.schema)}.tsdom,
        by bytea, num numeric(20,6), big bigint)`);
      await a.db.query(
        sql`insert into ${sql.identifier(a.schema)}.t values
          (1, '2026-01-01 00:00:00.000001+00', '2026-01-01 00:00:00.000002', '03:04:05.000006',
           '2026-02-03', '1 mon 2 days 03:04:05.000006', ARRAY['2026-01-01 00:00:00.000003+00'::timestamptz],
           '2026-02-03'::date, '2026-01-01 00:00:00.000004+00'::timestamptz,
           decode('00ff01','hex'), 99999999.999999::numeric, 9007199254740995)`,
      );
      // Row 2: SQL NULLs in every nullable column, but tstz is NOT NULL (ordering column)
      // and sorts AFTER row 1 so batch 1 (limit 1) picks row 1.
      await a.db.query(
        sql`insert into ${sql.identifier(a.schema)}.t (id, tstz) values (2, '2026-01-02 03:04:05.999999+00')`,
      );

      const source = createSqlSource({
        db: a.db, table: [a.schema, 't'], orderBy: ['tstz', 'id'], identity: `${NS}:src-temp`,
      });
      const target = createSqlTarget({
        db: b.db, table: [b.schema, 't'], key: ['id'], identity: `${NS}:dst-temp`,
      });
      const store = createMemoryCheckpointStore();

      // batchSize 1, one batch at a time across separate runs (boundary resume).
      const r1 = await runTransfer(source, target, { batchSize: 1, checkpointStore: store, maxBatches: 1 });
      expect(r1.status).toBe('completed');
      expect(r1.exhausted).toBe(false);
      expect(r1.rowsWritten).toBe(1);
      // Stored cursor carries the FULL microsecond timestamp (exact text).
      const storedCursor = await store.get(`dbsdk.sync:v1:${JSON.stringify([`${NS}:src-temp`, `${NS}:dst-temp`])}`);
      expect(storedCursor).toBe(JSON.stringify(['2026-01-01 00:00:00.000001+00', '1']));

      const r2 = await runTransfer(source, target, { batchSize: 1, checkpointStore: store });
      expect(r2.status).toBe('completed');
      expect(r2.exhausted).toBe(true);
      expect(r2.rowsWritten).toBe(1);

      // Idle rerun: nothing read.
      const idle = await runTransfer(source, target, { batchSize: 1, checkpointStore: store });
      expect(idle.rowsRead).toBe(0);
      expect(idle.rowsWritten).toBe(0);

      // New incremental row with a later µs timestamp is picked up exactly.
      await a.db.query(
        sql`insert into ${sql.identifier(a.schema)}.t values
          (3, '2026-01-03 00:00:00.000005+00', '2026-01-01 00:00:00.000006', '03:04:05.000007',
           '2026-02-04', '03:04:05.000007', ARRAY['2026-01-01 00:00:00.000008+00'::timestamptz],
           '2026-02-04'::date, '2026-01-01 00:00:00.000009+00'::timestamptz,
           decode('deadbeef','hex'), 0.000001::numeric, -9007199254740995)`,
      );
      const inc = await runTransfer(source, target, { batchSize: 1, checkpointStore: store });
      expect(inc.rowsRead).toBe(1);
      expect(inc.rowsWritten).toBe(1);

      const cols = ['id', 'tstz', 'ts', 't6', 'd', 'iv', 'tarr', 'ddom', 'tsdom', 'by', 'num', 'big'] as const;
      const src = await textSnapshot(b.db, a.schema, 't', cols);
      const dst = await textSnapshot(b.db, b.schema, 't', cols);
      expect(dst).toEqual(src); // FULL source-vs-target per-column ::text equality
      expect(dst['1']!.tstz).toBe('2026-01-01 00:00:00.000001+00');
      expect(dst['1']!.ts).toBe('2026-01-01 00:00:00.000002');
      expect(dst['1']!.t6).toBe('03:04:05.000006');
      expect(dst['1']!.iv).toBe('1 mon 2 days 03:04:05.000006');
      expect(dst['1']!.tarr).toBe('{"2026-01-01 00:00:00.000003+00"}');
      expect(dst['1']!.ddom).toBe('2026-02-03');
      expect(dst['1']!.tsdom).toBe('2026-01-01 00:00:00.000004+00');
      expect(dst['3']!.by).toBe('\\xdeadbeef');
      expect(dst['2']!.tstz).toBe('2026-01-02 03:04:05.999999+00');
      expect(dst['2']!.ts).toBeNull();
      expect(dst['2']!.tarr).toBeNull();
    } finally {
      await cleanup(a);
      await cleanup(b);
    }
  });
});

/* ================================================================== */
/* 4. LIVE alias-collision guards + qualified ordering                  */
/* ================================================================== */

live('R6 acceptance: reserved-alias guards (verify + assume) and qualified ORDER BY', () => {
  async function makeReservedSide(tag: string, withColumn: boolean): Promise<{
    db: Database; schema: string; pool: Pool;
  }> {
    const side = await makeSideWithPool(tag);
    await side.db.query(
      sql`create table ${sql.identifier(side.schema)}.events (id integer primary key, value text not null${withColumn ? sql`, ${sql.identifier('__dbsdk_cursor_0')} text` : sql``})`,
    );
    return side;
  }

  it('wildcard real __dbsdk_cursor_0 column → CONTRACT before ANY data read or write (verify mode)', async () => {
    const a = await makeReservedSide('aresv_v', true);
    const b = await makeReservedSide('bresv_v', false);
    try {
      await a.db.query(sql`insert into ${sql.identifier(a.schema)}.events values (1, 'v1')`);
      const result = await runTransfer(
        createSqlSource({ db: a.db, table: [a.schema, 'events'], orderBy: ['id'], identity: `${NS}:src-resv` }),
        createSqlTarget({ db: b.db, table: [b.schema, 'events'], key: ['id'], identity: `${NS}:dst-resv` }),
        { checkpointStore: createMemoryCheckpointStore() },
      );
      expect(result.status).toBe('failed');
      expect(result.error).toBeInstanceOf(SyncError);
      expect((result.error as SyncError).code).toBe('CONTRACT');
      expect(String(result.error)).toMatch(/reserved/);
      expect(result.rowsRead).toBe(0);
      expect(result.rowsWritten).toBe(0);
      const count = await b.db.query<{ n: string }>(
        sql`select count(*)::text as n from ${sql.identifier(b.schema)}.events`,
      );
      expect(req(count.rows[0]).n).toBe('0'); // zero writes
    } finally {
      await cleanup(a);
      await cleanup(b);
    }
  });

  it('assume mode has no bypass: wildcard reserved column still refused before any read', async () => {
    const a = await makeReservedSide('aresv_a', true);
    const b = await makeReservedSide('bresv_a', false);
    try {
      await a.db.query(sql`insert into ${sql.identifier(a.schema)}.events values (1, 'v1')`);
      const result = await runTransfer(
        createSqlSource({ db: a.db, table: [a.schema, 'events'], orderBy: ['id'], identity: `${NS}:src-resv-a`, uniqueOrder: 'assume' }),
        createSqlTarget({ db: b.db, table: [b.schema, 'events'], key: ['id'], identity: `${NS}:dst-resv-a` }),
        { checkpointStore: createMemoryCheckpointStore() },
      );
      expect(result.status).toBe('failed');
      expect((result.error as SyncError).code).toBe('CONTRACT');
      expect(result.rowsWritten).toBe(0);
    } finally {
      await cleanup(a);
      await cleanup(b);
    }
  });

  it('explicit columns omitting the reserved real column is safe and copies the listed columns', async () => {
    const a = await makeReservedSide('aresv_ok', true);
    const b = await makeReservedSide('bresv_ok', false);
    try {
      await a.db.query(
        sql`insert into ${sql.identifier(a.schema)}.events (id, value, ${sql.identifier('__dbsdk_cursor_0')}) values (1, 'v1', 'ignored')`,
      );
      const result = await runTransfer(
        createSqlSource({
          db: a.db, table: [a.schema, 'events'], orderBy: ['id'],
          columns: ['id', 'value'], identity: `${NS}:src-resv-ok`,
        }),
        createSqlTarget({ db: b.db, table: [b.schema, 'events'], key: ['id'], identity: `${NS}:dst-resv-ok` }),
        { checkpointStore: createMemoryCheckpointStore() },
      );
      expect(result.status).toBe('completed');
      expect(result.rowsWritten).toBe(1);
      const rows = await b.db.query(sql`select id, value from ${sql.identifier(b.schema)}.events`).then((r) => r.rows);
      expect(rows).toEqual([{ id: 1, value: 'v1' }]);
    } finally {
      await cleanup(a);
      await cleanup(b);
    }
  });

  it('catalog cannot resolve the table (missing orderBy column) → honest CONTRACT, zero writes', async () => {
    const a = await makeReservedSide('aresv_ghost', false);
    const b = await makeReservedSide('bresv_ghost', false);
    try {
      const result = await runTransfer(
        createSqlSource({ db: a.db, table: [a.schema, 'events'], orderBy: ['ghost'], identity: `${NS}:src-ghost`, uniqueOrder: 'assume' }),
        createSqlTarget({ db: b.db, table: [b.schema, 'events'], key: ['id'], identity: `${NS}:dst-ghost` }),
        { checkpointStore: createMemoryCheckpointStore() },
      );
      expect(result.status).toBe('failed');
      expect((result.error as SyncError).code).toBe('CONTRACT');
      expect(String(result.error)).toMatch(/not found/);
      expect(result.rowsWritten).toBe(0);
    } finally {
      await cleanup(a);
      await cleanup(b);
    }
  });

  it('R6-B regression: schema changes after the cached preflight fail LOUDLY before any read/write — including a new temporal column and a column named exactly __dbsdk_cursor_0', async () => {
    const a = await makeReservedSide('aresv_dyn', false);
    const b = await makeReservedSide('bresv_dyn', true);
    try {
      const target = createSqlTarget({ db: b.db, table: [b.schema, 'events'], key: ['id'], identity: `${NS}:dst-dyn` });
      await a.db.query(sql`insert into ${sql.identifier(a.schema)}.events (id, value) values (1, 'one'), (2, 'two')`);
      const source = createSqlSource({ db: a.db, table: [a.schema, 'events'], orderBy: ['id'], identity: `${NS}:src-dyn` });
      // First read on the source instance caches the schema snapshot (no extra
      // columns yet).
      const page1 = await source.read(null, 1);
      expect(page1.rows).toEqual([{ id: 1, value: 'one' }]);

      // (1) An ORDINARY non-reserved TEMPORAL column added after the snapshot
      // must fail loudly: the frozen projection would have transported its
      // microsecond timestamps through the native Date parser (µs loss).
      await a.db.query(
        sql`alter table ${sql.identifier(a.schema)}.events add column evt_at timestamptz`,
      );
      await a.db.query(
        sql`update ${sql.identifier(a.schema)}.events set evt_at = ('2026-01-01 00:00:00.00000' || id::text)::timestamptz`,
      );
      await expect(source.read(page1.cursor!, 10)).rejects.toMatchObject({ code: 'CONTRACT' });

      // (2) The documented remedy: recreate the source (same identity) — the
      // new schema is re-cached and the new column arrives as exact µs text.
      const recreated = createSqlSource({ db: a.db, table: [a.schema, 'events'], orderBy: ['id'], identity: `${NS}:src-dyn` });
      const page2 = await recreated.read(null, 10);
      expect(page2.rows).toEqual([
        { id: 1, value: 'one', evt_at: '2026-01-01 00:00:00.000001+00' },
        { id: 2, value: 'two', evt_at: '2026-01-01 00:00:00.000002+00' },
      ]);

      // (3) Now add a real column named EXACTLY like the internal alias. The
      // old failure mode (alias overwrite + silent strip) is impossible with
      // the frozen explicit projection, and the drift guard refuses it loudly.
      await a.db.query(
        sql`alter table ${sql.identifier(a.schema)}.events add column ${sql.identifier('__dbsdk_cursor_0')} text`,
      );
      await a.db.query(
        sql`update ${sql.identifier(a.schema)}.events set ${sql.identifier('__dbsdk_cursor_0')} = 'PRECIOUS-' || id`,
      );
      await expect(recreated.read(page2.cursor!, 10)).rejects.toMatchObject({ code: 'CONTRACT' });

      // (4) End-to-end: the transfer fails with CONTRACT BEFORE the data read,
      // write, or checkpoint — the existing resume checkpoint stays exactly as
      // it was, and nothing reaches the target.
      const store = createMemoryCheckpointStore();
      const checkpointKey = `dbsdk.sync:v1:${JSON.stringify([`${NS}:src-dyn`, `${NS}:dst-dyn`])}`;
      await store.set(checkpointKey, page2.cursor!); // an existing resume checkpoint
      const result = await runTransfer(recreated, target, { checkpointStore: store });
      expect(result.status).toBe('failed');
      expect(result.error).toBeInstanceOf(SyncError);
      expect((result.error as SyncError).code).toBe('CONTRACT');
      expect(String(result.error)).toMatch(/schema changed after this instance cached/);
      expect(result.rowsRead).toBe(0);
      expect(result.rowsWritten).toBe(0);
      expect(result.batches).toBe(0);
      // The resume checkpoint is UNCHANGED (still the pre-existing cursor).
      expect(await store.get(checkpointKey)).toBe(page2.cursor!);
      // Zero writes: the target table is still empty.
      const count = await b.db.query<{ n: string }>(
        sql`select count(*)::text as n from ${sql.identifier(b.schema)}.events`,
      );
      expect(req(count.rows[0]).n).toBe('0');
    } finally {
      await cleanup(a);
      await cleanup(b);
    }
  });

  it('qualified ORDER BY uses the real source column order (not the text-alias lexical sort)', async () => {
    const a = await makeReservedSide('aord', false);
    const b = await makeReservedSide('bord', false);
    try {
      await a.db.query(sql`insert into ${sql.identifier(a.schema)}.events values (10, 'ten'), (2, 'two'), (1, 'one')`);
      const source = createSqlSource({
        db: a.db, table: [a.schema, 'events'], orderBy: ['id'], identity: `${NS}:src-ord`,
        columns: ['id', 'value'],
      });
      // A text-alias lexical sort would give [1, 10, 2]; the true column order is [1, 2, 10].
      const page = await source.read(null, 3);
      expect(page.rows.map((r) => r.id)).toEqual([1, 2, 10]);
      const result = await runTransfer(
        source,
        createSqlTarget({ db: b.db, table: [b.schema, 'events'], key: ['id'], identity: `${NS}:dst-ord` }),
        { batchSize: 2, checkpointStore: createMemoryCheckpointStore() },
      );
      expect(result.status).toBe('completed');
      expect(result.rowsWritten).toBe(3);
    } finally {
      await cleanup(a);
      await cleanup(b);
    }
  });

  it('metadata is schema-bound: same table name in two schemas classifies independently', async () => {
    const s1 = await makeSideWithPool('ameta1');
    const s2 = await makeSideWithPool('ameta2');
    try {
      await s1.db.query(sql`create table ${sql.identifier(s1.schema)}.events (id integer primary key, doc jsonb)`);
      await s2.db.query(sql`create table ${sql.identifier(s2.schema)}.events (id integer primary key, doc integer)`);
      await s1.db.query(sql`insert into ${sql.identifier(s1.schema)}.events values (1, '[1,2]'::jsonb)`);
      await s2.db.query(sql`insert into ${sql.identifier(s2.schema)}.events values (1, 42)`);
      const p1 = await createSqlSource({ db: s1.db, table: [s1.schema, 'events'], orderBy: ['id'], identity: `${NS}:src-m1`, uniqueOrder: 'assume' }).read(null, 5);
      const p2 = await createSqlSource({ db: s2.db, table: [s2.schema, 'events'], orderBy: ['id'], identity: `${NS}:src-m2`, uniqueOrder: 'assume' }).read(null, 5);
      // jsonb → exact text payload; int → native number. Proves the schema
      // parameter of the metadata query actually binds (no cross-schema bleed).
      expect(p1.rows[0]!.doc).toBe('[1, 2]');
      expect(p2.rows[0]!.doc).toBe(42);
    } finally {
      await cleanup(s1);
      await cleanup(s2);
    }
  });
});

/* ================================================================== */
/* 5. LIVE unique-order gates                                           */
/* ================================================================== */

live('R6 acceptance: uniqueOrder catalog gates on real PG', () => {
  async function makeGateSide(tag: string, seed = true): Promise<{ db: Database; schema: string; pool: Pool }> {
    const side = await makeSideWithPool(tag);
    await side.db.query(
      sql`create table ${sql.identifier(side.schema)}.events (
        id integer primary key, value text not null, extra text not null, nullable text)`,
    );
    if (seed) {
      await side.db.query(
        sql`insert into ${sql.identifier(side.schema)}.events (id, value, extra, nullable) values
          (1, 'a', 'x', NULL), (2, 'b', 'y', NULL), (3, 'c', 'z', NULL)`,
      );
    }
    return side;
  }

  it.each([
    {
      label: 'non-unique index only',
      ddl: (s: string) => sql`create index on ${sql.identifier(s)}.events (value)`,
      orderCol: 'value',
      match: /no unique index/,
    },
    {
      label: 'partial unique index only',
      ddl: (s: string) => sql`create unique index on ${sql.identifier(s)}.events (value) where id > 0`,
      orderCol: 'value',
      match: /no unique index/,
    },
    {
      label: 'expression unique index only',
      ddl: (s: string) => sql`create unique index on ${sql.identifier(s)}.events (lower(value))`,
      orderCol: 'value',
      match: /no unique index/,
    },
    {
      label: 'unique index on a non-orderBy column',
      ddl: null, // the primary key on id exists and is not a subset of orderBy
      orderCol: 'value',
      match: /no unique index/,
    },
    {
      label: 'nullable orderBy column with a matching unique index',
      ddl: (s: string) => sql`create unique index on ${sql.identifier(s)}.events (nullable)`,
      orderCol: 'nullable',
      match: /nullable/,
    },
  ])('$label → CONTRACT refusal, zero writes', async ({ ddl, orderCol, match }) => {
    const tag = orderCol === 'nullable' ? 'gatenull' : `gate${Math.random().toString(36).slice(2, 6)}`;
    const a = await makeGateSide(tag);
    const b = await makeGateSide(`${tag}_dst`, false);
    try {
      if (ddl) await a.db.query(ddl(a.schema));
      const result = await runTransfer(
        createSqlSource({
          db: a.db, table: [a.schema, 'events'], orderBy: [orderCol],
          identity: `${NS}:src-${a.schema}`,
        }),
        createSqlTarget({ db: b.db, table: [b.schema, 'events'], key: ['id'], identity: `${NS}:dst-${b.schema}` }),
        { checkpointStore: createMemoryCheckpointStore(), batchSize: 2 },
      );
      expect(result.status).toBe('failed');
      expect(result.error).toBeInstanceOf(SyncError);
      expect((result.error as SyncError).code).toBe('CONTRACT');
      expect(String(result.error)).toMatch(match);
      expect(result.rowsWritten).toBe(0);
      const count = await b.db.query<{ n: string }>(
        sql`select count(*)::text as n from ${sql.identifier(b.schema)}.events`,
      );
      expect(req(count.rows[0]).n).toBe('0');
    } finally {
      await cleanup(a);
      await cleanup(b);
    }
  });

  it('legit composite unique index passes and copies every row', async () => {
    const a = await makeGateSide('gate_ok');
    const b = await makeGateSide('gateok_dst', false);
    try {
      await a.db.query(sql`create unique index ${sql.identifier('uq')} on ${sql.identifier(a.schema)}.events (value, id)`);
      const result = await runTransfer(
        createSqlSource({ db: a.db, table: [a.schema, 'events'], orderBy: ['value', 'id'], identity: `${NS}:src-gateok` }),
        createSqlTarget({ db: b.db, table: [b.schema, 'events'], key: ['id'], identity: `${NS}:dst-gateok` }),
        { checkpointStore: createMemoryCheckpointStore(), batchSize: 2 },
      );
      expect(result.status).toBe('completed');
      expect(result.rowsWritten).toBe(3);
      expect(result.exhausted).toBe(true);
    } finally {
      await cleanup(a);
      await cleanup(b);
    }
  });

  it('key-subset positive case with an INCLUDE column still passes (indnkeyatts semantics)', async () => {
    const a = await makeGateSide('gate_inc');
    const b = await makeGateSide('gateinc_dst', false);
    try {
      // The unique KEY is (value); `extra` is only an INCLUDE column. The
      // ordering (value, extra) is covered by the key subset {value}.
      await a.db.query(sql`create unique index ${sql.identifier('uq_inc')} on ${sql.identifier(a.schema)}.events (value) include (extra)`);
      const result = await runTransfer(
        createSqlSource({ db: a.db, table: [a.schema, 'events'], orderBy: ['value', 'extra'], identity: `${NS}:src-gateinc` }),
        createSqlTarget({ db: b.db, table: [b.schema, 'events'], key: ['id'], identity: `${NS}:dst-gateinc` }),
        { checkpointStore: createMemoryCheckpointStore(), batchSize: 2 },
      );
      expect(result.status).toBe('completed');
      expect(result.rowsWritten).toBe(3);
    } finally {
      await cleanup(a);
      await cleanup(b);
    }
  });
});

/* ================================================================== */
/* 6. LIVE recovery / no-auto-retry / abort timing                      */
/* ================================================================== */

live('R6 acceptance: recovery, original errors, no auto-retry, abort timing (real PG)', () => {
  async function makeRecoverySides(tag: string): Promise<{
    a: { db: Database; schema: string; pool: Pool };
    b: { db: Database; schema: string; pool: Pool };
  }> {
    const a = await makeSideWithPool(`rec_${tag}_a`);
    const b = await makeSideWithPool(`rec_${tag}_b`);
    await a.db.query(sql`create table ${sql.identifier(a.schema)}.events (id integer primary key, value text not null)`);
    await b.db.query(sql`create table ${sql.identifier(b.schema)}.events (id integer primary key, value text not null)`);
    return { a, b };
  }

  it('write failure surfaces the ORIGINAL DbError (SQLSTATE preserved), no auto-retry; replay converges', async () => {
    const { a, b } = await makeRecoverySides('origerr');
    try {
      await a.db.query(sql`insert into ${sql.identifier(a.schema)}.events values (1, 'v1'), (2, 'v2'), (3, 'v3')`);
      await b.db.query(sql`alter table ${sql.identifier(b.schema)}.events add constraint chk check (value <> 'boom')`);
      const source = createSqlSource({ db: a.db, table: [a.schema, 'events'], orderBy: ['id'], identity: `${NS}:src-rec` });
      const target = createSqlTarget({ db: b.db, table: [b.schema, 'events'], key: ['id'], identity: `${NS}:dst-rec` });
      const store = createMemoryCheckpointStore();
      let insertAttempts = 0;
      const countingTarget = {
        identity: target.identity,
        writeMode: target.writeMode,
        write: async (rows: Record<string, unknown>[], options?: { signal?: AbortSignal }) => {
          if (rows.some((r) => r.value === 'boom')) insertAttempts += 1;
          return target.write(rows, options);
        },
      };
      await a.db.query(sql`insert into ${sql.identifier(a.schema)}.events values (4, 'boom')`);
      const failed = await runTransfer(source, countingTarget, { checkpointStore: store, batchSize: 2 });
      expect(failed.status).toBe('failed');
      expect(failed.error).toBeInstanceOf(DbError);
      expect((failed.error as DbError).code).toBe('CONSTRAINT');
      expect((failed.error as DbError).sqlstate).toBe('23514');
      expect(failed.lastCursor).toBe(JSON.stringify(['2'])); // batch 1 committed only
      expect(insertAttempts).toBe(1); // NO auto-retry of the failing batch

      // Caller decides: drop the constraint, rerun → converges with no duplicates.
      await b.db.query(sql`alter table ${sql.identifier(b.schema)}.events drop constraint chk`);
      const recovered = await runTransfer(source, target, { checkpointStore: store, batchSize: 2 });
      expect(recovered.status).toBe('completed');
      const final = await b.db.query<{ n: string; d: string }>(
        sql`select count(*)::text as n, count(distinct id)::text as d from ${sql.identifier(b.schema)}.events`,
      );
      expect(req(final.rows[0]).n).toBe('4');
      expect(req(final.rows[0]).d).toBe('4');
    } finally {
      await cleanup(a);
      await cleanup(b);
    }
  });

  it('abort between batches: counts honest, cursor persisted, resume completes without loss', async () => {
    const { a, b } = await makeRecoverySides('abort');
    try {
      for (const i of [1, 2, 3, 4, 5]) {
        await a.db.query(sql`insert into ${sql.identifier(a.schema)}.events values (${i}, ${'v' + i})`);
      }
      const source = createSqlSource({ db: a.db, table: [a.schema, 'events'], orderBy: ['id'], identity: `${NS}:src-abort` });
      const target = createSqlTarget({ db: b.db, table: [b.schema, 'events'], key: ['id'], identity: `${NS}:dst-abort` });
      const store = createMemoryCheckpointStore();
      const controller = new AbortController();
      const aborted = await runTransfer(source, target, {
        checkpointStore: store,
        batchSize: 2,
        signal: controller.signal,
        onProgress: (p) => {
          if (p.batches >= 2) controller.abort();
        },
      });
      expect(aborted.status).toBe('aborted');
      expect(aborted.batches).toBe(2);
      expect(aborted.rowsWritten).toBe(4);
      expect(aborted.lastCursor).toBe(JSON.stringify(['4']));
      // Cursor persisted durably before the abort return.
      const stored = await store.get(`dbsdk.sync:v1:${JSON.stringify([`${NS}:src-abort`, `${NS}:dst-abort`])}`);
      expect(stored).toBe(JSON.stringify(['4']));
      const resumed = await runTransfer(source, target, { checkpointStore: store, batchSize: 2 });
      expect(resumed.status).toBe('completed');
      expect(resumed.rowsWritten).toBe(1);
    } finally {
      await cleanup(a);
      await cleanup(b);
    }
  });
});
