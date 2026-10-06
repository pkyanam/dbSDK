/**
 * R7 sync fidelity fixes — regression tests for the two R6 HIGH findings and
 * the schema-drift contract introduced with them.
 *
 * R6-A: numeric-family arrays (`numeric[]`/`decimal[]`, domains over numeric,
 * multidimensional arrays) must transfer EXACTLY. The pg driver parses numeric
 * ARRAY ELEMENTS as binary doubles (silent rounding beyond double precision),
 * so the source projects such columns as their exact `col::text` rendering.
 * Scalar `numeric`, `int8[]` and `text[]` keep their lossless native transport.
 *
 * R6-B: every read after the first re-validates the cached schema snapshot
 * against the catalog BEFORE the data query. Added/removed/retyped columns
 * fail with CONTRACT (nothing read, written, or checkpointed); the projection
 * is an explicit, table-qualified column list frozen from the snapshot (never
 * `SELECT *`), so a new column can neither collide with an internal cursor
 * alias nor silently lose precision. Explicit `columns` lists may ignore
 * UNSELECTED schema changes but still guard the selected columns.
 *
 * Offline tests use typed catalog fixtures (real OIDs). Live tests run only
 * against the local PostgreSQL 17 container (dbsdk-pg-test, port 15432),
 * isolated `r7f*` schemas, dropped in `finally`. No hosted calls, no secrets.
 */

import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { createDatabase, sql } from '../src/index.js';
import { postgres } from '../src/adapters/postgres.js';
import { createFixtureAdapter, type FixtureAdapterOptions } from '../src/testing.js';
import { createSqlSource, createSqlTarget } from '../src/sync/sql.js';
import { createMemoryCheckpointStore, runTransfer } from '../src/sync/core.js';
import { SyncError } from '../src/sync/errors.js';
import type { Database } from '../src/types.js';

const LOCAL_URL = 'postgresql://postgres:dbsdk@localhost:15432/dbsdk';

function req<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value, got undefined');
  return value;
}

function fixtureDb(
  fixtures: NonNullable<FixtureAdapterOptions['fixtures']>,
  options?: Omit<FixtureAdapterOptions, 'fixtures'>,
) {
  return createDatabase({ adapter: createFixtureAdapter({ ...options, fixtures }) });
}

/* ------------------------------------------------------------------------- */
/* Typed catalog fixtures — same shape the real catalog query returns.        */
/* ------------------------------------------------------------------------- */

type ColType = {
  category: string;
  typname: string;
  oid?: number;
  elemCategory?: string;
  elemTypname?: string;
  elemOid?: number;
};

// Real PostgreSQL type OIDs for the classification-relevant types.
const OID = {
  int4: 23,
  int8: 20,
  text: 25,
  timestamptz: 1184,
  numeric: 1700, // `decimal` is an alias of the same type
} as const;

const CT = {
  int4: { category: 'N', typname: 'int4', oid: OID.int4 },
  int8: { category: 'N', typname: 'int8', oid: OID.int8 },
  text: { category: 'S', typname: 'text', oid: OID.text },
  timestamptz: { category: 'D', typname: 'timestamptz', oid: OID.timestamptz },
  numericArray: { category: 'A', typname: '_numeric', elemCategory: 'N', elemTypname: 'numeric', elemOid: OID.numeric },
  int8Array: { category: 'A', typname: '_int8', elemCategory: 'N', elemTypname: 'int8', elemOid: OID.int8 },
} satisfies Record<string, ColType>;

function colMeta(name: string, type: ColType, notnull = true) {
  return {
    attname: name,
    attnotnull: notnull,
    basecategory: type.category,
    basetypname: type.typname,
    ...(type.oid === undefined ? {} : { baseoid: type.oid }),
    elemcategory: type.elemCategory ?? null,
    elemtypname: type.elemTypname ?? null,
    ...(type.elemOid === undefined ? {} : { elemoid: type.elemOid }),
  };
}

function metaFixture(
  cols: ReturnType<typeof colMeta>[],
  relname = 'events',
  schema: string | null = null,
  repeat = true,
): NonNullable<FixtureAdapterOptions['fixtures']>[number] {
  return { match: /pg_attribute/, params: [relname, schema, schema], repeat, rows: cols };
}

/* ------------------------------------------------------------------------- */
/* Offline: schema snapshot re-validation per read                            */
/* ------------------------------------------------------------------------- */

describe('R7: per-read schema snapshot re-validation (offline, typed fixtures)', () => {
  it('second read issues exactly ONE fresh catalog read for re-validation (not the unique-index gate)', async () => {
    const texts: string[] = [];
    const db = fixtureDb(
      [
        metaFixture([colMeta('id', CT.int4), colMeta('value', CT.text)]),
        { match: /^select/, rows: [{ id: 1, value: 'v1', __dbsdk_cursor_0: '1' }], repeat: true },
      ],
      { onQuery: (q) => texts.push(q.text) },
    );
    const source = createSqlSource({ db, table: 'events', orderBy: ['id'], identity: 'r7:src', uniqueOrder: 'assume' });
    await source.read(null, 10);
    await source.read(JSON.stringify(['1']), 10);
    // Catalog reads: 1 preflight metadata + 1 re-validation. No pg_index query
    // (the unique gate is a first-read-only preflight; drift uses the same
    // column-metadata query, and no data read happens without it).
    const catalog = texts.filter((t) => /pg_(attribute|index)/.test(t));
    expect(catalog).toHaveLength(2);
    expect(catalog.some((t) => /pg_index/.test(t))).toBe(false);
    expect(texts.filter((t) => /pg_attribute/.test(t))).toHaveLength(2);
  });

  it('wildcard: drift (added / removed / retyped) is detected BEFORE the data query — nothing read or written', async () => {
    // Added column (typed catalog answers, OIDs included)
    const db1 = fixtureDb([
      metaFixture([colMeta('id', CT.int4), colMeta('value', CT.text)], 'events', null, false),
      metaFixture([colMeta('id', CT.int4), colMeta('value', CT.text), colMeta('later', CT.timestamptz)], 'events', null, false),
      { match: /^select/, rows: [{ id: 1, value: 'v1', __dbsdk_cursor_0: '1' }] },
    ]);
    const s1 = createSqlSource({ db: db1, table: 'events', orderBy: ['id'], identity: 'r7:src', uniqueOrder: 'assume' });
    await s1.read(null, 10);
    let err: unknown;
    try {
      await s1.read(JSON.stringify(['1']), 10);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).code).toBe('CONTRACT');
    expect(String(err)).toMatch(/schema changed after this instance cached/);
    expect(String(err)).toMatch(/added column\(s\) "later"/);
    expect(String(err)).toMatch(/recreate the source/);

    // Removed + retyped variants share the same guard.
    const db2 = fixtureDb([
      metaFixture([colMeta('id', CT.int4), colMeta('value', CT.text)], 'events', null, false),
      metaFixture([colMeta('id', CT.int4)], 'events', null, false),
      { match: /^select/, rows: [{ id: 1, value: 'v1', __dbsdk_cursor_0: '1' }] },
    ]);
    const s2 = createSqlSource({ db: db2, table: 'events', orderBy: ['id'], identity: 'r7:src', uniqueOrder: 'assume' });
    await s2.read(null, 10);
    await expect(s2.read(JSON.stringify(['1']), 10)).rejects.toMatchObject({ code: 'CONTRACT' });

    const db3 = fixtureDb([
      metaFixture([colMeta('id', CT.int4), colMeta('value', CT.text)], 'events', null, false),
      metaFixture([colMeta('id', CT.int4), colMeta('value', CT.timestamptz)], 'events', null, false),
      { match: /^select/, rows: [{ id: 1, value: 'v1', __dbsdk_cursor_0: '1' }] },
    ]);
    const s3 = createSqlSource({ db: db3, table: 'events', orderBy: ['id'], identity: 'r7:src', uniqueOrder: 'assume' });
    await s3.read(null, 10);
    await expect(s3.read(JSON.stringify(['1']), 10)).rejects.toMatchObject({ code: 'CONTRACT' });
  });

  it('a new column named exactly like an internal alias cannot collide or drop data (offline mirror of R6-B)', async () => {
    const db = fixtureDb([
      metaFixture([colMeta('id', CT.int4), colMeta('value', CT.text)], 'events', null, false),
      // The new column's name is exactly the generated alias: with the frozen
      // explicit projection it simply appears as an ADDED column (CONTRACT);
      // the projection it would have collided with no longer exists.
      metaFixture([colMeta('id', CT.int4), colMeta('value', CT.text), colMeta('__dbsdk_cursor_0', CT.text)], 'events', null, false),
      { match: /^select/, rows: [{ id: 1, value: 'v1', __dbsdk_cursor_0: '1' }] },
    ]);
    const source = createSqlSource({ db, table: 'events', orderBy: ['id'], identity: 'r7:src', uniqueOrder: 'assume' });
    await source.read(null, 10);
    await expect(source.read(JSON.stringify(['1']), 10)).rejects.toMatchObject({
      code: 'CONTRACT',
    });
  });

  it('explicit columns ignore unselected drift but refuse a selected column that changed', async () => {
    // Unselected additions (incl. reserved-named) are ignored; selected drift refused.
    const db = fixtureDb([
      metaFixture([colMeta('id', CT.int4)], 'events', null, false),
      metaFixture([colMeta('id', CT.int4), colMeta('new_col', CT.text)], 'events', null, false),
      { match: /^select/, rows: [{ id: 1, __dbsdk_cursor_0: '1' }], repeat: true },
    ]);
    const source = createSqlSource({
      db, table: 'events', orderBy: ['id'], columns: ['id'], identity: 'r7:src', uniqueOrder: 'assume',
    });
    await source.read(null, 10);
    await expect(source.read(JSON.stringify(['1']), 10)).resolves.toMatchObject({
      rows: [{ id: 1 }],
    });

    const db2 = fixtureDb([
      metaFixture([colMeta('id', CT.int4), colMeta('value', CT.text)], 'events', null, false),
      metaFixture([colMeta('id', CT.int4), colMeta('value', CT.timestamptz)], 'events', null, false),
      { match: /^select/, rows: [{ id: 1, value: 'v1', __dbsdk_cursor_0: '1' }] },
    ]);
    const source2 = createSqlSource({
      db: db2, table: 'events', orderBy: ['id'], columns: ['id', 'value'], identity: 'r7:src', uniqueOrder: 'assume',
    });
    await source2.read(null, 10);
    await expect(source2.read(JSON.stringify(['1']), 10)).rejects.toMatchObject({ code: 'CONTRACT' });
  });

  it('runTransfer surfaces drift as a failed result with zero rows read/written and no checkpoint write', async () => {
    const sets: string[] = [];
    const db = fixtureDb([
      metaFixture([colMeta('id', CT.int4)], 'events', null, false),
      metaFixture([colMeta('id', CT.int4), colMeta('value', CT.text)], 'events', null, false),
      { match: /^select/, rows: [{ id: 1, __dbsdk_cursor_0: '1' }] },
      { match: /^insert/, rowCount: 1, repeat: true },
    ]);
    const store = { async get() { return null; }, async set(key: string) { sets.push(key); } };
    const source = createSqlSource({ db, table: 'events', orderBy: ['id'], identity: 'r7:src', uniqueOrder: 'assume' });
    // The snapshot is cached by an initial read outside the transfer...
    await source.read(null, 1);
    // ...then the schema "changes" (different catalog answer), so the
    // transfer's first read fails the drift guard BEFORE any data read.
    const target = createSqlTarget({ db, table: 'events', key: ['id'], identity: 'r7:dst' });
    const result = await runTransfer(source, target, { checkpointStore: store, batchSize: 1 });
    expect(result.status).toBe('failed');
    expect((result.error as SyncError).code).toBe('CONTRACT');
    expect(result.rowsRead).toBe(0);
    expect(result.rowsWritten).toBe(0);
    expect(result.batches).toBe(0);
    expect(sets).toEqual([]); // no checkpoint write at all
  });
});

/* ------------------------------------------------------------------------- */
/* Offline: numeric-family array classification (typed fixtures)              */
/* ------------------------------------------------------------------------- */

describe('R7: numeric-family arrays ride the exact-text path (offline)', () => {
  it('numeric[] (elem OID 1700) is re-projected as exact text; int8[] stays native', async () => {
    const texts: string[] = [];
    const db = fixtureDb(
      [
        metaFixture([colMeta('id', CT.int4), colMeta('na', CT.numericArray), colMeta('nums', CT.int8Array)]),
        { match: /^select/, rows: [{ id: 1, na: '{1.5}', nums: '{9007199254740993}', __dbsdk_cursor_0: '1' }] },
      ],
      { onQuery: (q) => texts.push(q.text) },
    );
    const source = createSqlSource({ db, table: 'events', orderBy: ['id'], identity: 'r7:src', uniqueOrder: 'assume' });
    const page = await source.read(null, 10);
    expect(texts[1]).toContain('"events"."na"::text as "na"');
    expect(texts[1]).not.toContain('"nums"::text');
    expect(page.rows[0]).toEqual({ id: 1, na: '{1.5}', nums: '{9007199254740993}' });
  });

  it('the target receives the numeric[] array-literal STRING as a bound parameter (no JS array guessing)', async () => {
    const params: unknown[] = [];
    const db = fixtureDb([{ match: /^insert/, rowCount: 1, repeat: true }], {
      onQuery: (q) => params.push(...q.params),
    });
    const target = createSqlTarget({ db, table: 'events', key: ['id'], identity: 'r7:dst' });
    await target.write([{ id: 1, na: '{1.5000000000000000001,9007199254740993,NULL}' }]);
    // The exact PG array-literal text is bound verbatim; PostgreSQL parses it
    // into the typed column. No array re-encoding, no lossy JS numbers.
    expect(params).toEqual([1, '{1.5000000000000000001,9007199254740993,NULL}']);
  });
});

/* ------------------------------------------------------------------------- */
/* Live: real-PostgreSQL drift and numeric-array behavior                     */
/* ------------------------------------------------------------------------- */

const NS = `r7f${Math.random().toString(36).slice(2, 8)}`;

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

live('R7: live schema-drift guard on real PostgreSQL', () => {
  it('an added column fails CONTRACT on later reads; recreation picks it up with exact values', async () => {
    const a = await makeSide('drift');
    try {
      await a.db.query(
        sql`create table ${sql.identifier(a.schema)}.events (id integer primary key, value text not null)`,
      );
      await a.db.query(sql`insert into ${sql.identifier(a.schema)}.events (id, value) values (1, 'one'), (2, 'two')`);
      const source = createSqlSource({
        db: a.db, table: [a.schema, 'events'], orderBy: ['id'], identity: `${NS}:src-drift`,
      });
      const page1 = await source.read(null, 1);
      expect(page1.rows).toEqual([{ id: 1, value: 'one' }]);

      // DDL after the snapshot: a new microsecond-precision timestamp column.
      await a.db.query(
        sql`alter table ${sql.identifier(a.schema)}.events add column evt timestamptz`,
      );
      await a.db.query(
        sql`update ${sql.identifier(a.schema)}.events set evt = ('2026-01-01 00:00:00.00000' || id::text)::timestamptz`,
      );
      // The cached snapshot no longer matches: loud CONTRACT before the data read.
      await expect(source.read(page1.cursor!, 10)).rejects.toMatchObject({ code: 'CONTRACT' });

      // Remedy: recreate the source (same identity). The new schema is
      // re-cached; the new column arrives as exact µs text — no precision loss.
      const recreated = createSqlSource({
        db: a.db, table: [a.schema, 'events'], orderBy: ['id'], identity: `${NS}:src-drift`,
      });
      const page2 = await recreated.read(null, 10);
      expect(page2.rows).toEqual([
        { id: 1, value: 'one', evt: '2026-01-01 00:00:00.000001+00' },
        { id: 2, value: 'two', evt: '2026-01-01 00:00:00.000002+00' },
      ]);
    } finally {
      await cleanup(a);
    }
  });

  it('dropped and retyped columns each fail CONTRACT before the data read', async () => {
    const a = await makeSide('drop');
    try {
      await a.db.query(
        sql`create table ${sql.identifier(a.schema)}.events (id integer primary key, value text not null)`,
      );
      await a.db.query(sql`insert into ${sql.identifier(a.schema)}.events (id, value) values (1, 'one'), (2, 'two')`);
      const source = createSqlSource({
        db: a.db, table: [a.schema, 'events'], orderBy: ['id'], identity: `${NS}:src-drop`,
      });
      const page1 = await source.read(null, 1);
      await a.db.query(sql`alter table ${sql.identifier(a.schema)}.events drop column value`);
      await expect(source.read(page1.cursor!, 10)).rejects.toMatchObject({ code: 'CONTRACT' });
      expect(String((await source.read(page1.cursor!, 10).catch((e) => e)) as SyncError)).toMatch(
        /removed column\(s\) "value"/,
      );
    } finally {
      await cleanup(a);
    }

    const b = await makeSide('retype');
    try {
      await b.db.query(
        sql`create table ${sql.identifier(b.schema)}.events (id integer primary key, qty integer not null)`,
      );
      await b.db.query(sql`insert into ${sql.identifier(b.schema)}.events (id, qty) values (1, 1), (2, 2)`);
      const source = createSqlSource({
        db: b.db, table: [b.schema, 'events'], orderBy: ['id'], identity: `${NS}:src-retype`,
      });
      const page1 = await source.read(null, 1);
      await b.db.query(sql`alter table ${sql.identifier(b.schema)}.events alter column qty type numeric`);
      await expect(source.read(page1.cursor!, 10)).rejects.toMatchObject({ code: 'CONTRACT' });
      expect(String((await source.read(page1.cursor!, 10).catch((e) => e)) as SyncError)).toMatch(
        /changed type of column\(s\) "qty"/,
      );
    } finally {
      await cleanup(b);
    }
  });

  it('explicit columns: a reserved-named column added after the snapshot is determinately ignored', async () => {
    const a = await makeSide('explicit');
    const b = await makeSide('explicit_dst');
    try {
      for (const side of [a, b]) {
        await side.db.query(
          sql`create table ${sql.identifier(side.schema)}.events (id integer primary key, value text not null)`,
        );
      }
      await a.db.query(sql`insert into ${sql.identifier(a.schema)}.events (id, value) values (1, 'one'), (2, 'two')`);
      const source = createSqlSource({
        db: a.db, table: [a.schema, 'events'], orderBy: ['id'], columns: ['id', 'value'], identity: `${NS}:src-explicit`,
      });
      const page1 = await source.read(null, 1);
      // DDL after the snapshot: a column named exactly like the internal alias.
      await a.db.query(
        sql`alter table ${sql.identifier(a.schema)}.events add column ${sql.identifier('__dbsdk_cursor_0')} text`,
      );
      await a.db.query(
        sql`update ${sql.identifier(a.schema)}.events set ${sql.identifier('__dbsdk_cursor_0')} = 'PRECIOUS-' || id`,
      );
      // The explicit projection is frozen and does not include the new column:
      // it is determinately NOT copied (documented contract), never silently
      // mis-mapped, and the reads continue to work.
      const page2 = await source.read(page1.cursor!, 10);
      expect(page2.rows).toEqual([{ id: 2, value: 'two' }]);
      const result = await runTransfer(
        source,
        createSqlTarget({ db: b.db, table: [b.schema, 'events'], key: ['id'], identity: `${NS}:dst-explicit` }),
        { checkpointStore: createMemoryCheckpointStore() },
      );
      expect(result.status).toBe('completed');
      expect(result.rowsWritten).toBe(2);
      const rows = await b.db.query(sql`select id, value from ${sql.identifier(b.schema)}.events order by id`);
      expect(rows.rows).toEqual([
        { id: 1, value: 'one' },
        { id: 2, value: 'two' },
      ]);
    } finally {
      await cleanup(a);
      await cleanup(b);
    }
  });
});
