/**
 * SQL sync adapters — three layers of evidence:
 *
 * 1. Offline statement-shape tests using the fixture adapter: the exact
 *    parameterized keyset SELECT (with the internal exact-cursor projection) and
 *    upsert INSERT ... ON CONFLICT shapes, cursor encoding/decoding, identifier
 *    validation, and the required-identity contract.
 *
 * 2. Offline uniqueness-preflight tests: the catalog checks behind
 *    `uniqueOrder: 'verify'` (unique index covering a subset of the orderBy
 *    columns, NOT NULL ordering columns), with scripted catalog fixtures.
 *
 * 3. Live tests against the local PostgreSQL 17 test container (dbsdk-pg-test,
 *    port 15432). Two *separate* createDatabase clients play "provider A" and
 *    "provider B" — the same shape as a real Supabase ⇄ Neon copy, without any
 *    hosted calls. Skipped automatically when the container is unreachable.
 *
 * No secrets are used or logged anywhere in this file.
 */

import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { createDatabase, sql } from '../../src/index.js';
import { postgres } from '../../src/adapters/postgres.js';
import { createFixtureAdapter, type FixtureAdapterOptions } from '../../src/testing.js';
import { createSqlSource, createSqlTarget } from '../../src/sync/sql.js';
import { createMemoryCheckpointStore, runTransfer } from '../../src/sync/core.js';
import { SyncError } from '../../src/sync/errors.js';
import type { Database } from '../../src/types.js';

const LOCAL_URL = 'postgresql://postgres:dbsdk@localhost:15432/dbsdk';

/** Assert a value is present (strict-mode helper for indexed access in tests). */
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
/* Catalog metadata fixtures                                                  */
/*                                                                           */
/* The shared column-metadata query (pg_attribute, both uniqueOrder modes)   */
/* returns every real column with its domain/element-resolved type. Metadata */
/* fixtures must be listed BEFORE any bare /^select/ data fixture, or the    */
/* data fixture will swallow the catalog query.                              */
/* ------------------------------------------------------------------------- */

type ColType = {
  category: string;
  typname: string;
  oid?: number;
  elemCategory?: string;
  elemTypname?: string;
  elemOid?: number;
};

const CT = {
  int4: { category: 'N', typname: 'int4' },
  int8: { category: 'N', typname: 'int8' },
  text: { category: 'S', typname: 'text' },
  timestamptz: { category: 'D', typname: 'timestamptz' },
  jsonb: { category: 'U', typname: 'jsonb' },
  textArray: { category: 'A', typname: '_text', elemCategory: 'S', elemTypname: 'text' },
  int8Array: { category: 'A', typname: '_int8', elemCategory: 'N', elemTypname: 'int8', elemOid: 20 },
  numericArray: { category: 'A', typname: '_numeric', elemCategory: 'N', elemTypname: 'numeric', elemOid: 1700 },
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

/** Answer for the shared column-metadata query (relname + schema bound twice). */
function metaFixture(
  cols: ReturnType<typeof colMeta>[],
  relname = 'events',
  schema: string | null = null,
  repeat = true,
): NonNullable<FixtureAdapterOptions['fixtures']>[number] {
  return {
    match: /pg_attribute/,
    params: [relname, schema, schema],
    // repeat by default: reads after the first re-validate the schema snapshot
    // with the same query (per-read schema-drift guard), so the answer must
    // persist. Pass `false` to script a one-shot snapshot answer (drift tests).
    repeat,
    rows: cols,
  };
}

describe('createSqlSource — identity contract', () => {
  it('requires an explicit identity at construction (no adapterId:table default)', () => {
    const db = fixtureDb([]);
    expect(() =>
      createSqlSource({ db, table: 'events', orderBy: 'id' } as never),
    ).toThrow(/explicit, stable, secret-free identity/);
    expect(() =>
      createSqlSource({ db, table: 'events', orderBy: 'id', identity: '' } as never),
    ).toThrow(/explicit, stable, secret-free identity/);
  });

  it('rejects reserved internal cursor-alias names in columns and orderBy', () => {
    const db = fixtureDb([]);
    expect(() =>
      createSqlSource({ db, table: 'events', orderBy: ['id'], identity: 's', columns: ['__dbsdk_cursor_0'] }),
    ).toThrow(/reserved/);
    expect(() =>
      createSqlSource({ db, table: 'events', orderBy: ['__dbsdk_cursor_0'], identity: 's' }),
    ).toThrow(/reserved/);
  });
});

describe('createSqlSource — statement shape (offline, uniqueOrder: assume)', () => {
  it('builds a parameterized keyset query with the exact-cursor projection', async () => {
    const queries: { text: string; params: readonly unknown[] }[] = [];
    const db = fixtureDb(
      [
        metaFixture([colMeta('id', CT.int4)], 'events', 'public'),
        {
          match: /^select/,
          rows: [
            { id: 1, __dbsdk_cursor_0: '1' },
            { id: 2, __dbsdk_cursor_0: '2' },
          ],
        },
      ],
      {
        onQuery: (q) => queries.push({ text: q.text, params: q.params }),
      },
    );
    const source = createSqlSource({
      db,
      table: ['public', 'events'],
      orderBy: ['id'],
      identity: 'test:src',
      uniqueOrder: 'assume',
    });

    const page = await source.read(null, 2);
    // The internal cursor aliases are stripped from the returned rows.
    expect(page.rows).toEqual([{ id: 1 }, { id: 2 }]);
    // Cursor values are the exact text projections (strings).
    expect(page.cursor).toBe(JSON.stringify(['2']));

    expect(queries).toHaveLength(2);
    expect(req(queries[0]).text).toContain('pg_attribute'); // metadata runs in BOTH modes
    expect(req(queries[1]).text).toContain(
      // Explicit, table-qualified projection from the cached snapshot — never
      // `SELECT *` (a real column added later can no longer collide with the
      // internal alias or be silently dropped/overwritten).
      'select "events"."id", "events"."id"::text as "__dbsdk_cursor_0" from "public"."events"',
    );
    // ORDER BY is table-qualified: it always resolves to the source column,
    // never to an output name.
    expect(req(queries[1]).text).toContain('order by "events"."id"');
    expect(req(queries[1]).text).toContain('limit $1');
    expect(req(queries[1]).params).toEqual([2]);
    // First page: no keyset predicate.
    expect(req(queries[1]).text).not.toContain('>');
  });

  it('continues after the cursor with a row-comparison predicate and bound values', async () => {
    const queries: { text: string; params: readonly unknown[] }[] = [];
    const db = fixtureDb(
      [
        metaFixture([colMeta('id', CT.int4)]),
        { match: /^select/, rows: [{ id: 3, __dbsdk_cursor_0: '3' }] },
      ],
      {
        onQuery: (q) => queries.push({ text: q.text, params: q.params }),
      },
    );
    const source = createSqlSource({
      db,
      table: 'events',
      orderBy: ['id'],
      identity: 'test:src',
      uniqueOrder: 'assume',
    });

    const page = await source.read(JSON.stringify(['2']), 2);
    expect(page.cursor).toBe(JSON.stringify(['3']));

    expect(queries).toHaveLength(2);
    expect(req(queries[1]).text).toContain('where ("id") > ($1) order by "events"."id" limit $2');
    // The decoded cursor value is bound as a string; the limit stays a number.
    expect(req(queries[1]).params).toEqual(['2', 2]);
  });

  it('uses a composite cursor for multi-column ordering', async () => {
    const queries: { text: string; params: readonly unknown[] }[] = [];
    const db = fixtureDb(
      [
        metaFixture([colMeta('id', CT.int4), colMeta('updated_at', CT.timestamptz)]),
        {
          match: /^select/,
          rows: [
            {
              id: 7,
              updated_at: '2026-01-01 00:00:00+00',
              __dbsdk_cursor_0: '2026-01-01 00:00:00+00',
              __dbsdk_cursor_1: '7',
            },
          ],
        },
      ],
      { onQuery: (q) => queries.push({ text: q.text, params: q.params }) },
    );
    const source = createSqlSource({
      db,
      table: 'events',
      orderBy: ['updated_at', 'id'],
      columns: ['id', 'updated_at'],
      identity: 'test:src',
      uniqueOrder: 'assume',
    });

    const page = await source.read(null, 10);
    expect(page.cursor).toBe(JSON.stringify(['2026-01-01 00:00:00+00', '7']));
    // Exact-payload projection: the temporal column is rendered as its exact
    // text in the row payload, plus the cursor aliases. Every projected column
    // is explicit and table-qualified (frozen from the metadata snapshot).
    expect(req(queries[1]).text).toContain(
      'select "events"."id", "events"."updated_at"::text as "updated_at", ' +
        '"events"."updated_at"::text as "__dbsdk_cursor_0", "events"."id"::text as "__dbsdk_cursor_1" from "events"',
    );
    // The temporal payload column arrives as its exact text rendering.
    expect(page.rows[0]).toEqual({ id: 7, updated_at: '2026-01-01 00:00:00+00' });
    // First page: no keyset predicate yet; cursor is encoded from the last row.
    expect(req(queries[1]).text).not.toContain('>');
  });

  it('ANDs a caller-supplied where fragment with the keyset predicate', async () => {
    const queries: { text: string; params: readonly unknown[] }[] = [];
    const db = fixtureDb(
      [
        metaFixture([colMeta('id', CT.int4)]),
        { match: /^select/, rows: [] },
      ],
      {
        onQuery: (q) => queries.push({ text: q.text, params: q.params }),
      },
    );
    const source = createSqlSource({
      db,
      table: 'events',
      orderBy: ['id'],
      where: sql`tenant_id = ${'t-1'}`,
      identity: 'test:src',
      uniqueOrder: 'assume',
    });

    await source.read(JSON.stringify(['5']), 10);
    expect(queries).toHaveLength(2);
    expect(req(queries[1]).text).toContain('where tenant_id = $1 and ("id") > ($2)');
    expect(req(queries[1]).text).toContain('order by "events"."id" limit $3');
    expect(req(queries[1]).params).toEqual(['t-1', '5', 10]);
  });

  it('refuses an empty page with cursor null (exhausted) correctly', async () => {
    const db = fixtureDb([
      metaFixture([colMeta('id', CT.int4)]),
      { match: /^select/, rows: [] },
    ]);
    const source = createSqlSource({
      db,
      table: 'events',
      orderBy: ['id'],
      identity: 'test:src',
      uniqueOrder: 'assume',
    });
    const page = await source.read(null, 10);
    expect(page.rows).toEqual([]);
    expect(page.cursor).toBe(null);
  });

  it('rejects invalid identifiers at construction, before any query', () => {
    const db = fixtureDb([]);
    expect(() =>
      createSqlSource({ db, table: 'events; drop table x', orderBy: 'id', identity: 's' }),
    ).toThrow(SyncError);
    expect(() =>
      createSqlSource({ db, table: 'events', orderBy: 'id); --', identity: 's' }),
    ).toThrow(SyncError);
  });

  it('rejects NULL cursor values at read time with a contract error', async () => {
    const db = fixtureDb([
      metaFixture([colMeta('id', CT.int4)]),
      { match: /^select/, rows: [{ id: 1, __dbsdk_cursor_0: '1' }, { id: null, __dbsdk_cursor_0: null }] },
    ]);
    const source = createSqlSource({
      db,
      table: 'events',
      orderBy: ['id'],
      identity: 'test:src',
      uniqueOrder: 'assume',
    });
    await expect(source.read(null, 10)).rejects.toMatchObject({
      name: 'SyncError',
      code: 'CONTRACT',
    });
  });

  it('rejects non-primitive cursor values (e.g. json columns) with a contract error', async () => {
    const db = fixtureDb([
      metaFixture([colMeta('id', CT.int4)]),
      { match: /^select/, rows: [{ id: 1, __dbsdk_cursor_0: { nested: true } }] },
    ]);
    const source = createSqlSource({
      db,
      table: 'events',
      orderBy: ['id'],
      identity: 'test:src',
      uniqueOrder: 'assume',
    });
    await expect(source.read(null, 10)).rejects.toMatchObject({
      name: 'SyncError',
      code: 'CONTRACT',
    });
  });

  it('rejects rows missing the internal cursor projection (stripped upstream)', async () => {
    const db = fixtureDb([
      metaFixture([colMeta('id', CT.int4)]),
      { match: /^select/, rows: [{ id: 1 }] },
    ]);
    const source = createSqlSource({
      db,
      table: 'events',
      orderBy: ['id'],
      identity: 'test:src',
      uniqueOrder: 'assume',
    });
    await expect(source.read(null, 10)).rejects.toMatchObject({
      name: 'SyncError',
      code: 'CONTRACT',
    });
  });

  it('detects duplicate cursor tuples within one page (non-unique ordering)', async () => {
    // Defense in depth for uniqueOrder: 'assume' — a duplicate cursor tuple within
    // one page is impossible under a truly unique ordering.
    const db = fixtureDb([
      metaFixture([colMeta('id', CT.int4)]),
      {
        match: /^select/,
        rows: [
          { id: 1, __dbsdk_cursor_0: '5' },
          { id: 2, __dbsdk_cursor_0: '5' },
        ],
      },
    ]);
    const source = createSqlSource({
      db,
      table: 'events',
      orderBy: ['id'],
      identity: 'test:src',
      uniqueOrder: 'assume',
    });
    await expect(source.read(null, 10)).rejects.toMatchObject({
      name: 'SyncError',
      code: 'CONTRACT',
    });
  });

  it('refuses a REAL wildcard-projected column named __dbsdk_cursor_0 before any data read (assume mode has no bypass)', async () => {
    const queries: string[] = [];
    const db = fixtureDb(
      [
        metaFixture([
          colMeta('id', CT.int4),
          colMeta('__dbsdk_cursor_0', CT.text),
        ]),
        { match: /^select/, rows: [{ id: 1, value: 'should never be read' }] },
      ],
      { onQuery: (q) => queries.push(q.text) },
    );
    const source = createSqlSource({
      db,
      table: 'events',
      orderBy: ['id'],
      identity: 'test:src',
      uniqueOrder: 'assume', // no bypass: the reserved-alias guard runs in both modes
    });
    await expect(source.read(null, 10)).rejects.toMatchObject({
      name: 'SyncError',
      code: 'CONTRACT',
    });
    // Refused before the data query was ever sent.
    expect(queries.some((t) => /from "events"/.test(t))).toBe(false);
  });

  it('permits a reserved-named real column when an explicit columns list omits it', async () => {
    const db = fixtureDb([
      metaFixture([
        colMeta('id', CT.int4),
        colMeta('__dbsdk_cursor_0', CT.text),
      ]),
      // Only the explicitly listed columns are projected; the reserved real
      // column is simply not copied (safe, not silently dropped).
      { match: /^select/, rows: [{ id: 1, __dbsdk_cursor_0: '1' }] },
    ]);
    const source = createSqlSource({
      db,
      table: 'events',
      orderBy: ['id'],
      columns: ['id'],
      identity: 'test:src',
      uniqueOrder: 'assume',
    });
    const page = await source.read(null, 10);
    expect(page.rows).toEqual([{ id: 1 }]);
  });

  it('refuses a missing orderBy column before any data read (catalog-derived, not assumed)', async () => {
    const db = fixtureDb([
      metaFixture([colMeta('id', CT.int4)]),
      { match: /^select/, rows: [{ id: 1 }] },
    ]);
    const source = createSqlSource({
      db,
      table: 'events',
      orderBy: ['ghost'],
      identity: 'test:src',
      uniqueOrder: 'assume',
    });
    await expect(source.read(null, 10)).rejects.toMatchObject({
      name: 'SyncError',
      code: 'CONTRACT',
    });
  });

  it('surfaces a failing catalog metadata query honestly in assume mode (no hidden bypass, no data read)', async () => {
    const queries: string[] = [];
    const boom = new Error('permission denied for pg_attribute');
    const db = fixtureDb([{ match: /pg_attribute/, error: boom }], {
      onQuery: (q) => queries.push(q.text),
    });
    const source = createSqlSource({
      db,
      table: 'events',
      orderBy: ['id'],
      identity: 'test:src',
      uniqueOrder: 'assume',
    });
    await expect(source.read(null, 10)).rejects.toThrow(/permission denied for pg_attribute/);
    expect(queries.some((t) => /from "events"/.test(t))).toBe(false);
  });

  it('projects an unresolvable column type as exact text (preserve-first default)', async () => {
    const queries: string[] = [];
    const db = fixtureDb(
      [
        // basecategory/basetypname absent: the catalog could not resolve the type.
        { match: /pg_attribute/, params: ['events', null, null], rows: [colMeta('id', CT.int4), { attname: 'payload', attnotnull: true, basecategory: null, basetypname: null, elemcategory: null, elemtypname: null }] },
        { match: /^select/, rows: [{ payload: 'x', __dbsdk_cursor_0: '1' }] },
      ],
      { onQuery: (q) => queries.push(q.text) },
    );
    const source = createSqlSource({
      db,
      table: 'events',
      orderBy: ['id'],
      columns: ['payload'],
      identity: 'test:src',
      uniqueOrder: 'assume',
    });
    const page = await source.read(null, 10);
    expect(queries[1]).toContain('"payload"::text as "payload"');
    expect(page.rows[0]).toEqual({ payload: 'x' });
  });

  it('keeps native JS values for lossless columns (numbers, text, bytea, text[]) in the payload', async () => {
    const queries: string[] = [];
    const db = fixtureDb(
      [
        metaFixture([
          colMeta('id', CT.int4),
          colMeta('label', CT.text),
          colMeta('big', CT.int8),
          colMeta('tags', CT.textArray),
        ]),
        { match: /^select/, rows: [{ id: 1, label: 'x', big: '9007199254740995', tags: ['a', 'b'], __dbsdk_cursor_0: '1' }] },
      ],
      { onQuery: (q) => queries.push(q.text) },
    );
    const source = createSqlSource({
      db,
      table: 'events',
      orderBy: ['id'],
      identity: 'test:src',
      uniqueOrder: 'assume',
    });
    const page = await source.read(null, 10);
    // No exact-text re-projection for lossless native transport — but the
    // projection is still an explicit qualified list (never `SELECT *`).
    expect(queries[1]).toBe(
      'select "events"."id", "events"."label", "events"."big", "events"."tags", ' +
        '"events"."id"::text as "__dbsdk_cursor_0" from "events" order by "events"."id" limit $1',
    );
    expect(page.rows[0]).toEqual({ id: 1, label: 'x', big: '9007199254740995', tags: ['a', 'b'] });
  });

  it('projects numeric/decimal arrays as exact text (elements arrive as lossy JS numbers natively)', async () => {
    const queries: string[] = [];
    const db = fixtureDb(
      [
        metaFixture([
          colMeta('id', CT.int4),
          colMeta('na', CT.numericArray),
          // A domain over a numeric array (element walk resolves to numeric).
          colMeta('dna', { category: 'A', typname: '_dom_num_arr', elemCategory: 'N', elemTypname: 'numeric', elemOid: 1700 }),
        ]),
        { match: /^select/, rows: [{ id: 1, na: '{1.5}', dna: '{2.5}' , __dbsdk_cursor_0: '1' }] },
      ],
      { onQuery: (q) => queries.push(q.text) },
    );
    const source = createSqlSource({
      db,
      table: 'events',
      orderBy: ['id'],
      identity: 'test:src',
      uniqueOrder: 'assume',
    });
    const page = await source.read(null, 10);
    // The numeric-family array columns are re-projected as their exact text.
    expect(queries[1]).toContain('"events"."na"::text as "na"');
    expect(queries[1]).toContain('"events"."dna"::text as "dna"');
    expect(page.rows[0]).toEqual({ id: 1, na: '{1.5}', dna: '{2.5}' });
  });

  it('classifies numeric arrays by element NAME too (catalog answers without OIDs) but keeps int8[]/text[] native', async () => {
    const queries: string[] = [];
    const db = fixtureDb(
      [
        metaFixture([
          colMeta('id', CT.int4),
          // No OIDs provided: classification falls back to the element type name.
          colMeta('na', { category: 'A', typname: '_numeric', elemCategory: 'N', elemTypname: 'numeric' }),
          colMeta('nums', CT.int8Array),
          colMeta('tags', CT.textArray),
        ]),
        { match: /^select/, rows: [{ id: 1, na: '{1.5}', nums: '{1,2}', tags: '{a}' , __dbsdk_cursor_0: '1' }] },
      ],
      { onQuery: (q) => queries.push(q.text) },
    );
    const source = createSqlSource({
      db,
      table: 'events',
      orderBy: ['id'],
      identity: 'test:src',
      uniqueOrder: 'assume',
    });
    const page = await source.read(null, 10);
    expect(queries[1]).toContain('"events"."na"::text as "na"');
    // int8[]/text[] keep their lossless native transport (no re-projection).
    expect(queries[1]).not.toContain('"nums"::text');
    expect(queries[1]).not.toContain('"tags"::text');
    expect(page.rows[0]).toEqual({ id: 1, na: '{1.5}', nums: '{1,2}', tags: '{a}' });
  });
});

/* ------------------------------------------------------------------------- */
/* Schema snapshot drift guard (offline)                                      */
/*                                                                            */
/* The first read caches the column metadata (the snapshot) and projects an   */
/* explicit qualified column list from it. Every later read re-queries the    */
/* catalog BEFORE the data query and refuses added/removed/retyped columns    */
/* with CONTRACT — nothing is read, written, or checkpointed.                 */
/* ------------------------------------------------------------------------- */

describe('createSqlSource — schema snapshot drift guard (offline)', () => {
  const snapshotMeta = (extra: ReturnType<typeof colMeta>[] = []) =>
    metaFixture([colMeta('id', CT.int4), colMeta('value', CT.text), ...extra], 'events', null, false);

  it('wildcard: a column ADDED after the snapshot fails CONTRACT before the data read', async () => {
    const texts: string[] = [];
    const db = fixtureDb(
      [
        snapshotMeta(), // consumed by the first read (the snapshot)
        // Drift answer on the second read's re-validation: a new column exists.
        metaFixture([colMeta('id', CT.int4), colMeta('value', CT.text), colMeta('extra', CT.timestamptz)], 'events', null, false),
        { match: /^select/, rows: [{ id: 1, value: 'x', __dbsdk_cursor_0: '1' }] },
      ],
      { onQuery: (q) => texts.push(q.text) },
    );
    const source = createSqlSource({
      db, table: 'events', orderBy: ['id'], identity: 'test:src', uniqueOrder: 'assume',
    });
    await source.read(null, 10); // caches the snapshot
    await expect(source.read(JSON.stringify(['1']), 10)).rejects.toMatchObject({
      name: 'SyncError',
      code: 'CONTRACT',
    });
    // The re-validation ran, but the data query was NOT dispatched.
    expect(texts.filter((t) => /pg_attribute/.test(t))).toHaveLength(2);
    expect(texts.filter((t) => /^select\b/.test(t) && !/pg_attribute/.test(t))).toHaveLength(1);
  });

  it('wildcard: a REMOVED column and a RETYPED column each fail CONTRACT before the data read', async () => {
    // Removed
    const db1 = fixtureDb([
      snapshotMeta(),
      metaFixture([colMeta('id', CT.int4)], 'events', null, false), // "value" is gone
      { match: /^select/, rows: [{ id: 1, value: 'x', __dbsdk_cursor_0: '1' }] },
    ]);
    const s1 = createSqlSource({ db: db1, table: 'events', orderBy: ['id'], identity: 'test:src', uniqueOrder: 'assume' });
    await s1.read(null, 10);
    await expect(s1.read(JSON.stringify(['1']), 10)).rejects.toMatchObject({ code: 'CONTRACT' });

    // Retyped (text -> timestamptz changes the classification-relevant metadata)
    const db2 = fixtureDb([
      snapshotMeta(),
      metaFixture([colMeta('id', CT.int4), colMeta('value', CT.timestamptz)], 'events', null, false),
      { match: /^select/, rows: [{ id: 1, value: 'x', __dbsdk_cursor_0: '1' }] },
    ]);
    const s2 = createSqlSource({ db: db2, table: 'events', orderBy: ['id'], identity: 'test:src', uniqueOrder: 'assume' });
    await s2.read(null, 10);
    await expect(s2.read(JSON.stringify(['1']), 10)).rejects.toMatchObject({ code: 'CONTRACT' });
  });

  it('explicit columns: unselected added columns are ignored (fixed projection), even reserved-named ones', async () => {
    const db = fixtureDb(
      [
        metaFixture([colMeta('id', CT.int4)], 'events', null, false),
        // Second read's re-validation: two new UNSELECTED columns appeared,
        // one of them named exactly like an internal cursor alias. Explicit
        // columns may ignore them; the projection stays frozen and safe.
        metaFixture([colMeta('id', CT.int4), colMeta('extra', CT.text), colMeta('__dbsdk_cursor_0', CT.text)], 'events', null, false),
        { match: /^select/, rows: [{ id: 1, __dbsdk_cursor_0: '1' }] },
        { match: /^select/, rows: [{ id: 2, __dbsdk_cursor_0: '2' }] },
      ],
    );
    const source = createSqlSource({
      db, table: 'events', orderBy: ['id'], columns: ['id'], identity: 'test:src', uniqueOrder: 'assume',
    });
    const page1 = await source.read(null, 10);
    expect(page1.rows).toEqual([{ id: 1 }]);
    const page2 = await source.read(page1.cursor!, 10);
    expect(page2.rows).toEqual([{ id: 2 }]);
  });

  it('explicit columns: a SELECTED column that is removed or retyped fails CONTRACT', async () => {
    // Removed selected column
    const db1 = fixtureDb([
      metaFixture([colMeta('id', CT.int4), colMeta('value', CT.text)], 'events', null, false),
      metaFixture([colMeta('id', CT.int4)], 'events', null, false),
      { match: /^select/, rows: [{ id: 1, value: 'x', __dbsdk_cursor_0: '1' }] },
    ]);
    const s1 = createSqlSource({
      db: db1, table: 'events', orderBy: ['id'], columns: ['id', 'value'], identity: 'test:src', uniqueOrder: 'assume',
    });
    await s1.read(null, 10);
    await expect(s1.read(JSON.stringify(['1']), 10)).rejects.toMatchObject({ code: 'CONTRACT' });

    // Retyped selected column
    const db2 = fixtureDb([
      metaFixture([colMeta('id', CT.int4), colMeta('value', CT.text)], 'events', null, false),
      metaFixture([colMeta('id', CT.int4), colMeta('value', CT.timestamptz)], 'events', null, false),
      { match: /^select/, rows: [{ id: 1, value: 'x', __dbsdk_cursor_0: '1' }] },
    ]);
    const s2 = createSqlSource({
      db: db2, table: 'events', orderBy: ['id'], columns: ['id', 'value'], identity: 'test:src', uniqueOrder: 'assume',
    });
    await s2.read(null, 10);
    await expect(s2.read(JSON.stringify(['1']), 10)).rejects.toMatchObject({ code: 'CONTRACT' });
  });

  it('a failing preflight is replayed without issuing drift-check queries (no new catalog reads)', async () => {
    const texts: string[] = [];
    const db = fixtureDb([{ match: /pg_attribute/, error: new Error('no catalog') }], {
      onQuery: (q) => texts.push(q.text),
    });
    const source = createSqlSource({ db, table: 'events', orderBy: ['id'], identity: 'test:src', uniqueOrder: 'assume' });
    await expect(source.read(null, 10)).rejects.toThrow(/no catalog/);
    await expect(source.read(null, 10)).rejects.toThrow(/no catalog/);
    // One cached failed preflight; the drift guard never ran.
    expect(texts).toHaveLength(1);
  });
});

describe('createSqlSource — uniqueness preflight (offline, uniqueOrder: verify)', () => {
  // Catalog fixtures for the preflight queries (the schema param is bound
  // twice in each statement), then the data query. The column-metadata query
  // now returns every real column with resolved types (the shared query).
  const catalogOk = (orderCols: string[]): NonNullable<FixtureAdapterOptions['fixtures']> => [
    { match: /pg_index/, params: ['events', null, null, orderCols], rows: [{ ok: 1 }] },
    {
      match: /pg_attribute/,
      params: ['events', null, null],
      // repeat: later reads re-validate the schema snapshot with the same query.
      repeat: true,
      rows: [
        colMeta('id', CT.int4),
        colMeta('value', CT.text),
        colMeta('updated_at', CT.timestamptz),
      ],
    },
  ];

  it('passes when a unique index covers a subset of the orderBy columns', async () => {
    const queries: string[] = [];
    const db = fixtureDb(
      [...catalogOk(['updated_at', 'id']), { match: /^select/, rows: [{ id: 1, __dbsdk_cursor_0: '1', __dbsdk_cursor_1: '1' }] }],
      { onQuery: (q) => queries.push(q.text) },
    );
    const source = createSqlSource({
      db,
      table: 'events',
      orderBy: ['updated_at', 'id'],
      identity: 'test:src',
    });
    const page = await source.read(null, 10);
    expect(page.cursor).toBe(JSON.stringify(['1', '1']));
    // The preflight ran BEFORE the data query.
    expect(queries[0]).toContain('pg_index');
    expect(queries[1]).toContain('pg_attribute');
    expect(queries[2]).toMatch(/^select/);
  });

  it('fails with a CONTRACT error before any data query when no unique index exists', async () => {
    const queries: string[] = [];
    const db = fixtureDb(
      [
        { match: /pg_index/, params: ['events', null, null, ['id']], rows: [] },
        { match: /^select/, rows: [{ id: 1, __dbsdk_cursor_0: '1' }] },
      ],
      { onQuery: (q) => queries.push(q.text) },
    );
    const source = createSqlSource({ db, table: 'events', orderBy: ['id'], identity: 'test:src' });
    await expect(source.read(null, 10)).rejects.toMatchObject({
      name: 'SyncError',
      code: 'CONTRACT',
    });
    // Refused before dispatch: no data query was ever sent.
    expect(queries.some((t) => /from "events"/.test(t))).toBe(false);
  });

  it('fails with a CONTRACT error when an orderBy column is nullable', async () => {
    const db = fixtureDb([
      { match: /pg_index/, params: ['events', null, null, ['id']], rows: [{ ok: 1 }] },
      { match: /pg_attribute/, params: ['events', null, null], rows: [{ attname: 'id', attnotnull: false, basecategory: 'N', basetypname: 'int4', elemcategory: null, elemtypname: null }] },
    ]);
    const source = createSqlSource({ db, table: 'events', orderBy: ['id'], identity: 'test:src' });
    await expect(source.read(null, 10)).rejects.toMatchObject({
      name: 'SyncError',
      code: 'CONTRACT',
    });
  });

  it('runs the preflight once per source instance (cached across reads); later reads re-validate the schema snapshot', async () => {
    let queries = 0;
    let catalogQueries = 0;
    const db = fixtureDb(
      [
        ...catalogOk(['id']),
        { match: /^select/, rows: [{ id: 1, __dbsdk_cursor_0: '1' }], repeat: true },
      ],
      {
        onQuery: (q) => {
          queries += 1;
          if (/pg_(attribute|index)/.test(q.text)) catalogQueries += 1;
        },
      },
    );
    const source = createSqlSource({ db, table: 'events', orderBy: ['id'], identity: 'test:src' });
    await source.read(null, 10);
    await source.read(JSON.stringify(['1']), 10);
    // First read: unique-index check + column metadata + data (3). Second read:
    // the schema snapshot is RE-VALIDATED against the catalog (1 extra
    // read-only query, part of the per-read drift guard) + data (2). The
    // unique-index preflight itself is NOT repeated.
    expect(queries).toBe(5);
    expect(catalogQueries).toBe(3); // pg_index once + pg_attribute twice (preflight, drift check)
  });

  it('passes the preflight through a schema-qualified table name', async () => {
    const queries: { text: string; params: readonly unknown[] }[] = [];
    const db = fixtureDb(
      [
        { match: /pg_index/, params: ['events', 'public', 'public', ['id']], rows: [{ ok: 1 }] },
        { match: /pg_attribute/, params: ['events', 'public', 'public'], rows: [colMeta('id', CT.int4)] },
        { match: /^select/, rows: [] },
      ],
      { onQuery: (q) => queries.push({ text: q.text, params: q.params }) },
    );
    const source = createSqlSource({
      db,
      table: ['public', 'events'],
      orderBy: ['id'],
      identity: 'test:src',
    });
    await source.read(null, 10);
    expect(req(queries[0]).params).toEqual(['events', 'public', 'public', ['id']]);
    expect(req(queries[1]).params).toEqual(['events', 'public', 'public']);
  });

  it('surfaces catalog query failures as-is (honest pass-through)', async () => {
    const boom = new Error('permission denied for pg_index');
    const db = fixtureDb([{ match: /pg_index/, error: boom }]);
    const source = createSqlSource({ db, table: 'events', orderBy: ['id'], identity: 'test:src' });
    await expect(source.read(null, 10)).rejects.toThrow(/permission denied for pg_index/);
  });
});

describe('createSqlTarget — statement shape (offline)', () => {
  it('builds a multi-row upsert with excluded.* updates and bound values', async () => {
    const queries: { text: string; params: readonly unknown[] }[] = [];
    const db = fixtureDb([{ match: /^insert/, rowCount: 2 }], {
      onQuery: (q) => queries.push({ text: q.text, params: q.params }),
    });
    const target = createSqlTarget({ db, table: ['public', 'events'], key: ['id'], identity: 'test:dst' });

    const written = await target.write([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ]);
    expect(written.written).toBe(2);

    expect(req(queries[0]).text).toContain(
      'insert into "public"."events" ("id", "name") values ($1, $2), ($3, $4)',
    );
    expect(req(queries[0]).text).toContain(
      'on conflict ("id") do update set "id" = excluded."id", "name" = excluded."name"',
    );
    expect(req(queries[0]).params).toEqual([1, 'a', 2, 'b']);
  });

  it('requires an explicit identity at construction', () => {
    const db = fixtureDb([]);
    expect(() =>
      createSqlTarget({ db, table: 'events', key: ['id'] } as never),
    ).toThrow(/explicit, stable, secret-free identity/);
  });

  it('supports onConflict: nothing and explicit column lists', async () => {
    const queries: { text: string; params: readonly unknown[] }[] = [];
    const db = fixtureDb([{ match: /^insert/, rowCount: 0 }], {
      onQuery: (q) => queries.push({ text: q.text, params: q.params }),
    });
    const target = createSqlTarget({
      db,
      table: 'events',
      key: ['id'],
      identity: 'test:dst',
      columns: ['id', 'name'],
      onConflict: 'nothing',
    });

    await target.write([{ id: 1, name: 'a', extra: 'ignored' }]);
    expect(req(queries[0]).text).toContain('insert into "events" ("id", "name") values ($1, $2)');
    expect(req(queries[0]).text).toContain('on conflict ("id") do nothing');
    expect(req(queries[0]).params).toEqual([1, 'a']);
  });

  it('splits large batches to respect the bind-parameter limit', async () => {
    const queries: { text: string; params: readonly unknown[] }[] = [];
    const db = fixtureDb([{ match: /^insert/, rowCount: 1, repeat: true }], {
      onQuery: (q) => queries.push({ text: q.text, params: q.params }),
    });
    // 3 columns → ~20 000 rows per statement; 20 001 rows must split into two statements.
    const target = createSqlTarget({ db, table: 'events', key: ['id'], identity: 'test:dst' });
    const rows = Array.from({ length: 20_001 }, (_, i) => ({ id: i, a: 1, b: 2 }));
    await target.write(rows);
    expect(queries).toHaveLength(2);
    expect(req(queries[0]).params).toHaveLength(3 * 20_000);
    expect(req(queries[1]).params).toHaveLength(3);
  });

  it('rejects rows with missing columns and invalid identifiers', async () => {
    const db = fixtureDb([]);
    const target = createSqlTarget({ db, table: 'events', key: ['id'], identity: 'test:dst' });
    await expect(target.write([{ id: 1 } as Record<string, unknown>, { name: 'x' }])).rejects.toMatchObject(
      { name: 'SyncError', code: 'CONFIGURATION' },
    );
    expect(() => createSqlTarget({ db, table: 'events', key: ['id; drop'], identity: 'test:dst' })).toThrow(SyncError);
  });

  it('requires key columns to be present in the written columns', () => {
    const db = fixtureDb([]);
    expect(() =>
      createSqlTarget({ db, table: 'events', key: ['org_id'], identity: 'test:dst', columns: ['id', 'name'] }),
    ).toThrow(/key column "org_id"/);
  });

  it('encodes a top-level JS array as JSON text for a json/jsonb column (R4 finding A fix)', async () => {
    const queries: { text: string; params: readonly unknown[] }[] = [];
    const db = fixtureDb(
      [
        metaFixture([colMeta('id', CT.int4), colMeta('doc', CT.jsonb)]),
        { match: /^insert/, rowCount: 3, repeat: true },
      ],
      { onQuery: (q) => queries.push({ text: q.text, params: q.params }) },
    );
    const target = createSqlTarget({ db, table: 'events', key: ['id'], identity: 'test:dst' });
    await target.write([
      { id: 1, doc: [] },
      { id: 2, doc: [1, 2] },
      { id: 3, doc: [{ a: [1, 2] }] },
    ]);
    expect(req(queries[1]).params[1]).toBe('[]'); // NOT the pg array literal `{}`
    expect(req(queries[1]).params[3]).toBe('[1,2]');
    expect(req(queries[1]).params[5]).toBe('[{"a":[1,2]}]');
  });

  it('passes a JS array through natively for a PostgreSQL array column', async () => {
    const queries: { text: string; params: readonly unknown[] }[] = [];
    const db = fixtureDb(
      [
        metaFixture([colMeta('id', CT.int4), colMeta('tags', CT.textArray)]),
        { match: /^insert/, rowCount: 1, repeat: true },
      ],
      { onQuery: (q) => queries.push({ text: q.text, params: q.params }) },
    );
    const target = createSqlTarget({ db, table: 'events', key: ['id'], identity: 'test:dst' });
    await target.write([{ id: 1, tags: ['a', 'b'] }]);
    // Native: the driver's array-literal encoding is correct for array columns.
    expect(req(queries[1]).params[1]).toEqual(['a', 'b']);
  });

  it('refuses a JS array for a column whose type is not array/json (CONTRACT, before any write)', async () => {
    const queries: string[] = [];
    const db = fixtureDb(
      [
        metaFixture([colMeta('id', CT.int4), colMeta('count', CT.int4)]),
        { match: /^insert/, rowCount: 1 },
      ],
      { onQuery: (q) => queries.push(q.text) },
    );
    const target = createSqlTarget({ db, table: 'events', key: ['id'], identity: 'test:dst' });
    await expect(target.write([{ id: 1, count: [1, 2] }])).rejects.toMatchObject({
      name: 'SyncError',
      code: 'CONTRACT',
    });
    expect(queries.some((t) => /^insert/.test(t))).toBe(false); // refused before any write
  });

  it('refuses a JS array for a json[] column (the driver cannot encode JSON array elements safely)', async () => {
    const queries: string[] = [];
    const db = fixtureDb(
      [
        metaFixture([colMeta('id', CT.int4), colMeta('docs', { category: 'A', typname: '_jsonb', elemCategory: 'U', elemTypname: 'jsonb' })]),
        { match: /^insert/, rowCount: 1 },
      ],
      { onQuery: (q) => queries.push(q.text) },
    );
    const target = createSqlTarget({ db, table: 'events', key: ['id'], identity: 'test:dst' });
    await expect(target.write([{ id: 1, docs: [{ a: 1 }] }])).rejects.toMatchObject({
      name: 'SyncError',
      code: 'CONTRACT',
    });
    expect(queries.some((t) => /^insert/.test(t))).toBe(false);
  });

  it('refuses a JS array when the column type cannot be resolved from the catalog (loud, not guessed)', async () => {
    const queries: string[] = [];
    const db = fixtureDb(
      [
        // Column absent from the metadata answer: unresolvable.
        metaFixture([colMeta('id', CT.int4)]),
        { match: /^insert/, rowCount: 1 },
      ],
      { onQuery: (q) => queries.push(q.text) },
    );
    const target = createSqlTarget({ db, table: 'events', key: ['id'], identity: 'test:dst' });
    await expect(target.write([{ id: 1, mystery: [1, 2] }])).rejects.toMatchObject({
      name: 'SyncError',
      code: 'CONTRACT',
    });
    expect(queries.some((t) => /^insert/.test(t))).toBe(false);
  });

  it('resolves column types lazily: no catalog query at all when a batch has no JS arrays', async () => {
    const texts: string[] = [];
    const db = fixtureDb([{ match: /^insert/, rowCount: 1, repeat: true }], {
      onQuery: (q) => texts.push(q.text),
    });
    const target = createSqlTarget({ db, table: 'events', key: ['id'], identity: 'test:dst' });
    await target.write([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
    expect(texts.filter((t) => t.includes('pg_attribute'))).toHaveLength(0);
  });

  it('resolves array encodings for the WHOLE batch before any chunk commits', async () => {
    const queries: string[] = [];
    const db = fixtureDb(
      [
        metaFixture([colMeta('id', CT.int4), colMeta('count', CT.int4)]),
        { match: /^insert/, rowCount: 2 },
      ],
      { onQuery: (q) => queries.push(q.text) },
    );
    const target = createSqlTarget({ db, table: 'events', key: ['id'], identity: 'test:dst' });
    // Second row has the unencodable value; the refusal must happen before the
    // first chunk is ever sent (batch > rowsPerStatement: 2 cols → 30000 rows
    // per statement, so use a small explicit batch via many rows).
    const rows = [
      { id: 1, count: 1 },
      { id: 2, count: [1] },
    ];
    await expect(target.write(rows)).rejects.toMatchObject({ code: 'CONTRACT' });
    expect(queries.some((t) => /^insert/.test(t))).toBe(false);
  });
});

describe('full transfer over SQL clients (offline wiring)', () => {
  it('moves fixture rows through runTransfer with correct batch boundaries', async () => {
    const srcQueries: { text: string; params: readonly unknown[] }[] = [];
    const dstQueries: { text: string; params: readonly unknown[] }[] = [];
    const sourceDb = fixtureDb(
      [
        metaFixture([colMeta('id', CT.int4), colMeta('v', CT.text)]),
        {
          match: /^select/,
          rows: [
            { id: 1, v: 'a', __dbsdk_cursor_0: '1' },
            { id: 2, v: 'b', __dbsdk_cursor_0: '2' },
          ],
        },
        { match: /^select/, rows: [] }, // second page: exhausted
      ],
      { onQuery: (q) => srcQueries.push({ text: q.text, params: q.params }) },
    );
    const targetDb = fixtureDb([{ match: /^insert/, rowCount: 2 }], {
      onQuery: (q) => dstQueries.push({ text: q.text, params: q.params }),
    });

    const result = await runTransfer(
      createSqlSource({ db: sourceDb, table: 'events', orderBy: ['id'], identity: 'test:src', uniqueOrder: 'assume' }),
      createSqlTarget({ db: targetDb, table: 'events', key: ['id'], identity: 'test:dst' }),
      { batchSize: 2 },
    );

    expect(result.status).toBe('completed');
    expect(result.rowsWritten).toBe(2);
    expect(req(srcQueries[1]).text).toContain('order by "events"."id" limit $1');
    expect(req(dstQueries[0]).text).toContain('on conflict ("id") do update');
  });
});

/* ------------------------------------------------------------------------- */
/* Live tests — local PostgreSQL 17 container; skipped when unreachable.      */
/* ------------------------------------------------------------------------- */

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

live('live: provider-to-provider copy on local PostgreSQL 17', () => {
  // Two independent clients + two schemas simulate two providers.
  async function makeSide(name: string): Promise<{ db: Database; cleanup: () => Promise<void> }> {
    const db = createDatabase({ adapter: postgres({ connectionString: LOCAL_URL, max: 4 }) });
    await db.query(sql`create schema if not exists ${sql.identifier(`sync_${name}`)}`);
    await db.query(
      sql`create table if not exists ${sql.identifier(`sync_${name}`)}.${sql.identifier('events')} (
        id integer primary key,
        value text not null,
        updated_at timestamptz not null default now()
      )`,
    );
    return {
      db,
      cleanup: async () => {
        await db.query(sql`drop schema if exists ${sql.identifier(`sync_${name}`)} cascade`);
        await db.close();
      },
    };
  }

  it('copies all rows from one client to another (initial copy)', async () => {
    const a = await makeSide('a_live');
    const b = await makeSide('b_live');
    try {
      const ids = Array.from({ length: 25 }, (_, i) => i + 1);
      for (const id of ids) {
        await a.db.query(sql`insert into sync_a_live.events (id, value) values (${id}, ${'v' + id})`);
      }

      const result = await runTransfer(
        createSqlSource({ db: a.db, table: ['sync_a_live', 'events'], orderBy: ['id'], identity: 'live:src.a_live' }),
        createSqlTarget({ db: b.db, table: ['sync_b_live', 'events'], key: ['id'], identity: 'live:dst.b_live' }),
        { batchSize: 10 },
      );

      expect(result.status).toBe('completed');
      expect(result.exhausted).toBe(true);
      expect(result.batches).toBe(3);
      expect(result.rowsWritten).toBe(25);

      const count = await b.db.query<{ n: string }>(sql`select count(*)::text as n from sync_b_live.events`);
      expect(req(count.rows[0]).n).toBe('25');
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('incremental rerun transfers only new and changed rows; idempotent rerun reads nothing', async () => {
    const a = await makeSide('a_inc');
    const b = await makeSide('b_inc');
    try {
      // Deterministic timestamps (whole seconds, distinct) so the cursor counts are exact.
      await a.db.query(
        sql`insert into sync_a_inc.events (id, value, updated_at) values
          (1, 'v1', '2026-01-01T00:00:01Z'), (2, 'v2', '2026-01-01T00:00:02Z')`,
      );

      const source = createSqlSource({
        db: a.db,
        table: ['sync_a_inc', 'events'],
        orderBy: ['updated_at', 'id'],
        identity: 'live:src.a_inc',
      });
      const target = createSqlTarget({ db: b.db, table: ['sync_b_inc', 'events'], key: ['id'], identity: 'live:dst.b_inc' });
      const store = createMemoryCheckpointStore();

      const first = await runTransfer(source, target, { batchSize: 10, checkpointStore: store });
      expect(first.rowsWritten).toBe(2);

      // Idempotent rerun with no changes: nothing read, nothing written.
      const rerun = await runTransfer(source, target, { batchSize: 10, checkpointStore: store });
      expect(rerun.rowsRead).toBe(0);
      expect(rerun.rowsWritten).toBe(0);
      expect(rerun.exhausted).toBe(true);

      // New insert + in-place update are picked up by the incremental cursor.
      await a.db.query(
        sql`insert into sync_a_inc.events (id, value, updated_at) values (3, 'v3', '2026-01-01T00:00:04Z')`,
      );
      await a.db.query(
        sql`update sync_a_inc.events set value = 'v2-updated', updated_at = '2026-01-01T00:00:05Z' where id = 2`,
      );

      const second = await runTransfer(source, target, { batchSize: 10, checkpointStore: store });
      expect(second.rowsRead).toBe(2);
      expect(second.rowsWritten).toBe(2);

      const check = await b.db.query<{ value: string }>(
        sql`select value from sync_b_inc.events where id = 2`,
      );
      expect(req(check.rows[0]).value).toBe('v2-updated');
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('crash before target commit: rerun re-applies the batch with no loss or duplicates', async () => {
    const a = await makeSide('a_crash');
    const b = await makeSide('b_crash');
    try {
      const ids = Array.from({ length: 12 }, (_, i) => i + 1);
      for (const id of ids) {
        await a.db.query(sql`insert into sync_a_crash.events (id, value) values (${id}, ${'v' + id})`);
      }

      const source = createSqlSource({ db: a.db, table: ['sync_a_crash', 'events'], orderBy: ['id'], identity: 'live:src.a_crash' });
      let writes = 0;
      const target = createSqlTarget({ db: b.db, table: ['sync_b_crash', 'events'], key: ['id'], identity: 'live:dst.b_crash' });
      const failingTarget = {
        identity: target.identity,
        writeMode: target.writeMode,
        write: async (rows: Record<string, unknown>[], options?: { signal?: AbortSignal }) => {
          writes += 1;
          if (writes === 2) throw new Error('simulated crash before commit (batch 2)');
          return target.write(rows, options);
        },
      };

      const store = createMemoryCheckpointStore();
      const failed = await runTransfer(source, failingTarget, {
        batchSize: 5,
        checkpointStore: store,
      });
      expect(failed.status).toBe('failed');
      expect(failed.lastCursor).toBe(JSON.stringify(['5'])); // batch 1 committed only

      const afterCrash = await b.db.query<{ n: string }>(
        sql`select count(*)::text as n from sync_b_crash.events`,
      );
      expect(req(afterCrash.rows[0]).n).toBe('5');

      // Rerun: resumes from the checkpoint, re-applies batch 2 onward, converges.
      const recovered = await runTransfer(source, target, {
        batchSize: 5,
        checkpointStore: store,
      });
      expect(recovered.status).toBe('completed');
      expect(recovered.rowsWritten).toBe(7);

      const final = await b.db.query<{ n: string; distinct: string }>(
        sql`select count(*)::text as n, count(distinct id)::text as distinct from sync_b_crash.events`,
      );
      expect(req(final.rows[0]).n).toBe('12');
      expect(req(final.rows[0]).distinct).toBe('12'); // no duplicates, no loss
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('crash AFTER target commit BEFORE checkpoint: rerun re-applies idempotently on real PG', async () => {
    const a = await makeSide('a_cc');
    const b = await makeSide('b_cc');
    try {
      const ids = Array.from({ length: 6 }, (_, i) => i + 1);
      for (const id of ids) {
        await a.db.query(sql`insert into sync_a_cc.events (id, value) values (${id}, ${'v' + id})`);
      }

      const source = createSqlSource({ db: a.db, table: ['sync_a_cc', 'events'], orderBy: ['id'], identity: 'live:src.a_cc' });
      const target = createSqlTarget({ db: b.db, table: ['sync_b_cc', 'events'], key: ['id'], identity: 'live:dst.b_cc' });
      const durable = createMemoryCheckpointStore();
      let setCalls = 0;
      const crashyStore = {
        async get(key: string) {
          return durable.get(key);
        },
        async set(key: string, value: string) {
          setCalls += 1;
          if (setCalls === 1) throw new Error('simulated crash after commit, before checkpoint');
          await durable.set(key, value);
        },
      };

      const first = await runTransfer(source, target, { batchSize: 2, checkpointStore: crashyStore });
      expect(first.status).toBe('failed');
      expect(first.batches).toBe(1);
      expect(first.rowsWritten).toBe(2);
      expect(first.lastCursor).toBe(JSON.stringify(['2'])); // the batch IS on the target

      const afterCrash = await b.db.query<{ n: string; distinct: string }>(
        sql`select count(*)::text as n, count(distinct id)::text as distinct from sync_b_cc.events`,
      );
      expect(req(afterCrash.rows[0]).n).toBe('2');
      expect(req(afterCrash.rows[0]).distinct).toBe('2');

      // Rerun from the durable store: batch 1 re-applied via upsert, then the rest.
      const second = await runTransfer(source, target, { batchSize: 2, checkpointStore: durable });
      expect(second.status).toBe('completed');
      expect(second.rowsWritten).toBe(6);

      const final = await b.db.query<{ n: string; distinct: string }>(
        sql`select count(*)::text as n, count(distinct id)::text as distinct from sync_b_cc.events`,
      );
      expect(req(final.rows[0]).n).toBe('6');
      expect(req(final.rows[0]).distinct).toBe('6'); // upsert converged, no duplicates
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('cancellation between batches stops cleanly and resumes without loss', async () => {
    const a = await makeSide('a_cancel');
    const b = await makeSide('b_cancel');
    try {
      const ids = Array.from({ length: 10 }, (_, i) => i + 1);
      for (const id of ids) {
        await a.db.query(sql`insert into sync_a_cancel.events (id, value) values (${id}, ${'v' + id})`);
      }

      const controller = new AbortController();
      const source = createSqlSource({ db: a.db, table: ['sync_a_cancel', 'events'], orderBy: ['id'], identity: 'live:src.a_cancel' });
      const target = createSqlTarget({ db: b.db, table: ['sync_b_cancel', 'events'], key: ['id'], identity: 'live:dst.b_cancel' });
      const store = createMemoryCheckpointStore();

      const aborted = await runTransfer(source, target, {
        batchSize: 4,
        checkpointStore: store,
        signal: controller.signal,
        onProgress: (p) => {
          if (p.batches >= 2) controller.abort();
        },
      });
      expect(aborted.status).toBe('aborted');
      expect(aborted.batches).toBe(2);
      expect(aborted.lastCursor).toBe(JSON.stringify(['8']));

      const resumed = await runTransfer(source, target, {
        batchSize: 4,
        checkpointStore: store,
      });
      expect(resumed.status).toBe('completed');
      expect(resumed.rowsWritten).toBe(2);

      const count = await b.db.query<{ n: string }>(
        sql`select count(*)::text as n from sync_b_cancel.events`,
      );
      expect(req(count.rows[0]).n).toBe('10');
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('missing unique index on the target fails loudly (no silent rewrite)', async () => {
    const a = await makeSide('a_idx');
    const b = await makeSide('b_idx');
    try {
      await b.db.query(
        sql`create table if not exists sync_b_idx.nokey (id integer, value text, updated_at timestamptz)`,
      );
      await a.db.query(sql`insert into sync_a_idx.events (id, value) values (1, 'v1')`);

      const result = await runTransfer(
        createSqlSource({ db: a.db, table: ['sync_a_idx', 'events'], orderBy: ['id'], identity: 'live:src.a_idx' }),
        createSqlTarget({ db: b.db, table: ['sync_b_idx', 'nokey'], key: ['id'], identity: 'live:dst.b_idx' }),
        { batchSize: 10 },
      );
      expect(result.status).toBe('failed');
      // PostgreSQL rejects the upsert: there is no unique or exclusion constraint.
      expect(String(result.error)).toMatch(/unique|constraint|exclusion/i);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('R5 payload fidelity: JSON arrays/scalars, PG arrays, temporal arrays, domains, intervals, dates and NULLs round-trip exactly (source vs target ::text)', async () => {
    const a = await makeSide('a_fid');
    const b = await makeSide('b_fid');
    try {
      // A domain-wrapped temporal type on the source.
      await a.db.query(sql`create domain sync_a_fid.tsdom as timestamptz`);
      await a.db.query(
        sql`create table sync_a_fid.docs (
          id integer primary key,
          doc jsonb,
          jsn json,
          tags text[],
          nums int8[],
          stamps timestamptz[],
          tsdom sync_a_fid.tsdom,
          dur interval,
          day date,
          by bytea,
          num numeric(20,6),
          big bigint
        )`,
      );
      // The target keeps the plain base type (domain → base is the same storage).
      await b.db.query(
        sql`create table sync_b_fid.docs (
          id integer primary key,
          doc jsonb,
          jsn json,
          tags text[],
          nums int8[],
          stamps timestamptz[],
          tsdom timestamptz,
          dur interval,
          day date,
          by bytea,
          num numeric(20,6),
          big bigint
        )`,
      );

      await a.db.query(
        sql`insert into sync_a_fid.docs values
          (1, '[1,2]'::jsonb, '"hello"'::json, ARRAY['a','b"q'], '{1,9007199254740993}',
           '{2026-01-01 00:00:00.000001+00}', '2026-01-01 00:00:00.000002+00'::timestamptz,
           '01:02:03'::interval, '2026-02-03'::date, decode('00ff01','hex'),
           99999999.999999::numeric, 9007199254740995::bigint)`,
      );
      // Row 2: NULLs in every nullable column (incl. JSON null which must stay JSON null).
      await a.db.query(
        sql`insert into sync_a_fid.docs (id, doc) values (2, 'null'::jsonb)`,
      );

      const source = createSqlSource({
        db: a.db,
        table: ['sync_a_fid', 'docs'],
        orderBy: ['id'],
        identity: 'live:src.a_fid',
      });
      const target = createSqlTarget({
        db: b.db,
        table: ['sync_b_fid', 'docs'],
        key: ['id'],
        identity: 'live:dst.b_fid',
      });
      const result = await runTransfer(source, target, { batchSize: 1, checkpointStore: createMemoryCheckpointStore() });
      expect(result.status).toBe('completed');
      expect(result.rowsWritten).toBe(2);

      const cols = ['id', 'doc', 'jsn', 'tags', 'nums', 'stamps', 'tsdom', 'dur', 'day', 'by', 'num', 'big'] as const;
      const src = await b.db.query<Record<string, string>>(
        sql`select ${sql.join(cols.map((c) => sql`${sql.identifier(c)}::text as ${sql.identifier(c)}`), ', ')} from sync_a_fid.docs order by id`,
      ).then((r) => r.rows);
      const dst = await b.db.query<Record<string, string>>(
        sql`select ${sql.join(cols.map((c) => sql`${sql.identifier(c)}::text as ${sql.identifier(c)}`), ', ')} from sync_b_fid.docs order by id`,
      ).then((r) => r.rows);
      // FULL source-vs-target equality, every column via exact text.
      expect(dst).toEqual(src);
      // Spot-check the previously-broken shapes:
      expect(dst[0]!.doc).toBe('[1, 2]');           // top-level JSON array survives
      expect(dst[0]!.jsn).toBe('"hello"');           // JSON string scalar survives
      expect(dst[0]!.tags).toBe('{a,"b\\"q"}');      // text[] native round-trip exact
      expect(dst[0]!.nums).toContain('9007199254740993'); // int8 array exact
      expect(dst[0]!.stamps).toBe('{"2026-01-01 00:00:00.000001+00"}'); // temporal array exact
      expect(dst[0]!.tsdom).toBe('2026-01-01 00:00:00.000002+00'); // domain-wrapped temporal exact
      expect(dst[0]!.dur).toBe('01:02:03');
      expect(dst[1]!.doc).toBe('null');              // JSON null ≠ SQL NULL
      expect(dst[1]!.tags).toBeNull();               // SQL NULL stays SQL NULL
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('exact microsecond timestamptz cursor: full transfer, precise resume, no oscillation', async () => {    const a = await makeSide('a_us');
    const b = await makeSide('b_us');
    try {
      // Sub-millisecond timestamps — the case that made every pre-R3 run fail
      // permanently on the stalled-cursor guard.
      await a.db.query(
        sql`insert into sync_a_us.events (id, value, updated_at) values
          (1, 'v1', '2026-01-01 00:00:00.000001+00'),
          (2, 'v2', '2026-01-01 00:00:00.000002+00'),
          (3, 'v3', '2026-01-01 00:00:00.000003+00')`,
      );

      const source = createSqlSource({
        db: a.db,
        table: ['sync_a_us', 'events'],
        orderBy: ['updated_at', 'id'],
        identity: 'live:src.a_us',
      });
      const target = createSqlTarget({ db: b.db, table: ['sync_b_us', 'events'], key: ['id'], identity: 'live:dst.b_us' });
      const store = createMemoryCheckpointStore();

      const first = await runTransfer(source, target, { batchSize: 2, checkpointStore: store });
      expect(first.status).toBe('completed');
      expect(first.exhausted).toBe(true);
      expect(first.rowsWritten).toBe(3);
      // The cursor carries the FULL microsecond timestamp, not a truncated Date.
      expect(first.lastCursor).toBe(JSON.stringify(['2026-01-01 00:00:00.000003+00', '3']));

      // Idempotent rerun reads NOTHING — no oscillation, no stall, no re-reads.
      const rerun = await runTransfer(source, target, { batchSize: 2, checkpointStore: store });
      expect(rerun.status).toBe('completed');
      expect(rerun.exhausted).toBe(true);
      expect(rerun.rowsRead).toBe(0);

      // A new row with a later microsecond timestamp is picked up incrementally.
      await a.db.query(
        sql`insert into sync_a_us.events (id, value, updated_at) values (4, 'v4', '2026-01-01 00:00:00.000004+00')`,
      );
      const second = await runTransfer(source, target, { batchSize: 2, checkpointStore: store });
      expect(second.rowsRead).toBe(1);
      expect(second.rowsWritten).toBe(1);

      const count = await b.db.query<{ n: string; distinct: string }>(
        sql`select count(*)::text as n, count(distinct id)::text as distinct from sync_b_us.events`,
      );
      expect(req(count.rows[0]).n).toBe('4');
      expect(req(count.rows[0]).distinct).toBe('4');
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('non-unique orderBy is refused by the preflight BEFORE any write (batch 2 and batch 1)', async () => {
    const a = await makeSide('a_nonuni');
    const b = await makeSide('b_nonuni');
    try {
      // Three rows share one updated_at; page boundaries (batch 2 AND batch 1)
      // would fall inside the duplicate group.
      await a.db.query(
        sql`insert into sync_a_nonuni.events (id, value, updated_at) values
          (1, 'v1', '2026-01-01T00:00:01Z'),
          (2, 'v2', '2026-01-01T00:00:01Z'),
          (3, 'v3', '2026-01-01T00:00:01Z'),
          (4, 'v4', '2026-01-01T00:00:02Z')`,
      );

      for (const batchSize of [2, 1]) {
        const source = createSqlSource({
          db: a.db,
          table: ['sync_a_nonuni', 'events'],
          orderBy: ['updated_at'],
          identity: 'live:src.a_nonuni',
        });
        const target = createSqlTarget({ db: b.db, table: ['sync_b_nonuni', 'events'], key: ['id'], identity: 'live:dst.b_nonuni' });
        const result = await runTransfer(source, target, { batchSize });
        expect(result.status).toBe('failed');
        expect(result.error).toBeInstanceOf(SyncError);
        expect((result.error as SyncError).code).toBe('CONTRACT');
        expect(String(result.error)).toMatch(/no unique index/);
        expect(result.rowsWritten).toBe(0);
        // Nothing was written, no matter the batch size or where ties fall.
        const count = await b.db.query<{ n: string }>(
          sql`select count(*)::text as n from sync_b_nonuni.events`,
        );
        expect(req(count.rows[0]).n).toBe('0');
      }

      // With the tie-breaker added, the same table transfers completely.
      const source = createSqlSource({
        db: a.db,
        table: ['sync_a_nonuni', 'events'],
        orderBy: ['updated_at', 'id'],
        identity: 'live:src.a_nonuni',
      });
      const target = createSqlTarget({ db: b.db, table: ['sync_b_nonuni', 'events'], key: ['id'], identity: 'live:dst.b_nonuni' });
      const ok = await runTransfer(source, target, { batchSize: 1 });
      expect(ok.status).toBe('completed');
      expect(ok.rowsWritten).toBe(4);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('bigint and numeric cursor values keep full precision', async () => {
    const a = await makeSide('a_big');
    const b = await makeSide('b_big');
    try {
      await a.db.query(
        sql`create table if not exists sync_a_big.seq (
          seq_id bigint primary key,
          amount numeric not null
        )`,
      );
      await b.db.query(
        sql`create table if not exists sync_b_big.seq (
          seq_id bigint primary key,
          amount numeric not null
        )`,
      );
      // Values beyond double precision and with full decimal scale.
      await a.db.query(
        sql`insert into sync_a_big.seq (seq_id, amount) values
          (9007199254740993, '12.340000'),
          (9007199254740994, '0.000001'),
          (9007199254740995, '99999999.999999')`,
      );

      const source = createSqlSource({
        db: a.db,
        table: ['sync_a_big', 'seq'],
        orderBy: ['seq_id', 'amount'],
        identity: 'live:src.a_big',
      });
      const target = createSqlTarget({ db: b.db, table: ['sync_b_big', 'seq'], key: ['seq_id'], identity: 'live:dst.b_big' });
      const store = createMemoryCheckpointStore();

      const first = await runTransfer(source, target, { batchSize: 2, checkpointStore: store });
      expect(first.status).toBe('completed');
      expect(first.rowsWritten).toBe(3);
      // Exact bigint (beyond 2^53) and exact numeric digits in the cursor.
      expect(first.lastCursor).toBe(
        JSON.stringify(['9007199254740995', '99999999.999999']),
      );

      const rerun = await runTransfer(source, target, { batchSize: 2, checkpointStore: store });
      expect(rerun.rowsRead).toBe(0); // precise resume, no oscillation

      const check = await b.db.query<{ n: string }>(
        sql`select count(*)::text as n from sync_b_big.seq`,
      );
      expect(req(check.rows[0]).n).toBe('3');
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('distinct clients, same table name, shared store: explicit identities isolate jobs', async () => {
    const a1 = await makeSide('a_iso1');
    const a2 = await makeSide('a_iso2');
    const b = await makeSide('b_iso');
    try {
      await a1.db.query(sql`insert into sync_a_iso1.events (id, value) values (1, 'one'), (2, 'two')`);
      await a2.db.query(sql`insert into sync_a_iso2.events (id, value) values (10, 'ten'), (20, 'twenty'), (30, 'thirty')`);

      const store = createMemoryCheckpointStore();

      const first = await runTransfer(
        createSqlSource({ db: a1.db, table: ['sync_a_iso1', 'events'], orderBy: ['id'], identity: 'live:src.iso1' }),
        createSqlTarget({ db: b.db, table: ['sync_b_iso', 'events'], key: ['id'], identity: 'live:dst.iso' }),
        { batchSize: 10, checkpointStore: store },
      );
      expect(first.rowsWritten).toBe(2);

      // A DIFFERENT database pair (schema a_iso2), same adapter + table shape,
      // explicit distinct identity → its own checkpoint, transfers ALL its rows.
      const second = await runTransfer(
        createSqlSource({ db: a2.db, table: ['sync_a_iso2', 'events'], orderBy: ['id'], identity: 'live:src.iso2' }),
        createSqlTarget({ db: b.db, table: ['sync_b_iso', 'events'], key: ['id'], identity: 'live:dst.iso' }),
        { batchSize: 10, checkpointStore: store },
      );
      expect(second.status).toBe('completed');
      expect(second.rowsRead).toBe(3);
      expect(second.rowsWritten).toBe(3);

      const check = await b.db.query<{ n: string }>(
        sql`select count(*)::text as n from sync_b_iso.events`,
      );
      expect(req(check.rows[0]).n).toBe('5');
    } finally {
      await a1.cleanup();
      await a2.cleanup();
      await b.cleanup();
    }
  });
});
