/**
 * R4 independent release verification for `dbsdk/sync` — see
 * coordination/v3-sync-release-review-r4.md. Written against the PUBLIC consumer
 * surface (`createDatabase` + the sync entry), not against internals.
 *
 * This suite deliberately does NOT mirror the owner's statement-shape tests. It
 * verifies outcomes: rows on the TARGET compared with rows on the SOURCE, real
 * checkpoint store states, error OBJECT identity (never message matching), and
 * ordering guarantees via side effects (row counts, write counters, catalog state).
 *
 * Live tests run only against the local PostgreSQL 17 container (dbsdk-pg-test,
 * port 15432) and skip automatically when it is unreachable. No hosted provider
 * calls, no secrets. All live fixtures use dedicated `r4_*` schemas, dropped on
 * cleanup.
 */

import { describe, expect, it } from 'vitest';
import { createDatabase, sql, DbError, isDbError, type Database } from '../src/index.js';
import { postgres } from '../src/adapters/postgres.js';
import { createFixtureAdapter, type FixtureAdapterOptions } from '../src/testing.js';
import {
  runTransfer,
  createMemoryCheckpointStore,
  createSqlSource,
  createSqlTarget,
  SyncError,
  isSyncError,
  type SyncSource,
  type SyncTarget,
  type CheckpointStore,
} from '../src/sync/index.js';

const LOCAL_URL = 'postgresql://postgres:dbsdk@localhost:15432/dbsdk';

function req<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value, got undefined');
  return value;
}

function fixtureDb(
  fixtures: FixtureAdapterOptions['fixtures'],
  onQuery?: (q: { text: string }) => void,
) {
  return createDatabase({
    adapter: createFixtureAdapter({ fixtures, ...(onQuery ? { onQuery: onQuery as never } : {}) }),
  });
}

/** Recording checkpoint store: captures every get/set and can fail on demand. */
function recordingStore(initial?: Record<string, string>) {
  const inner = createMemoryCheckpointStore(initial);
  const log = { gets: [] as string[], sets: [] as { key: string; value: string }[] };
  let failSet = false;
  let failGet = false;
  const store: CheckpointStore = {
    async get(key) {
      log.gets.push(key);
      if (failGet) throw new Error('store get unavailable');
      return inner.get(key);
    },
    async set(key, value) {
      if (failSet) throw new Error('store set unavailable');
      log.sets.push({ key, value });
      await inner.set(key, value);
    },
  };
  return { store, log, setFailSet: (v: boolean) => (failSet = v), setFailGet: (v: boolean) => (failGet = v) };
}

/* ------------------------------------------------------------------------- */
/* Live infrastructure: local PostgreSQL 17 container.                        */
/* ------------------------------------------------------------------------- */

const { Pool } = await import('pg');

async function localServerAvailable(): Promise<boolean> {
  const pool = new Pool({ connectionString: LOCAL_URL, max: 1, connectionTimeoutMillis: 2000 });
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

const available = await localServerAvailable();
const live = available ? describe : describe.skip;

/** One side of a simulated provider pair: its own schema, its own Database client. */
async function makeSide(name: string): Promise<{ db: Database; cleanup: () => Promise<void> }> {
  const db = createDatabase({ adapter: postgres({ connectionString: LOCAL_URL, max: 3 }) });
  await db.query(sql`create schema if not exists ${sql.identifier(`r4_${name}`)}`);
  return {
    db,
    cleanup: async () => {
      await db.query(sql`drop schema if exists ${sql.identifier(`r4_${name}`)} cascade`);
      await db.close();
    },
  };
}

async function makeEventsTable(db: Database, schema: string): Promise<void> {
  await db.query(sql`create table ${sql.identifier([`r4_${schema}`, 'events'])} (
    id integer primary key,
    value text not null,
    updated_at timestamptz not null
  )`);
}

/** Full row comparison on the database, via exact text renderings of every column. */
async function tableContents(
  db: Database,
  schema: string,
  table: string,
  cols: readonly string[],
): Promise<Array<Record<string, string>>> {
  const result = await db.query<Record<string, string>>(
    sql`select ${sql.join(
      cols.map((c) => sql`${sql.identifier(c)}::text as ${sql.identifier(c)}`),
      ', ',
    )} from ${sql.identifier([`r4_${schema}`, table])} order by ${sql.identifier(cols[0]!)}`,
  );
  return result.rows as Array<Record<string, string>>;
}

/* ------------------------------------------------------------------------- */
/* 1. Identity / checkpoint-key isolation (R2-1 fix)                          */
/* ------------------------------------------------------------------------- */

describe('R4-1: explicit identity and checkpoint-key isolation', () => {
  it('refuses to build adapters without an explicit identity, and runTransfer refuses identity-less endpoints before any dispatch', async () => {
    const db = fixtureDb([]);
    expect(() => createSqlSource({ db, table: 't', orderBy: 'id' } as never)).toThrow(/explicit, stable, secret-free identity/);
    expect(() => createSqlTarget({ db, table: 't', key: 'id' } as never)).toThrow(/explicit, stable, secret-free identity/);

    // Generic engine path: an endpoint without identity is refused before any I/O.
    let reads = 0;
    const noIdentity = {
      ordering: 'ordered' as const,
      read: async () => {
        reads += 1;
        return { rows: [], cursor: null };
      },
    };
    await expect(runTransfer(noIdentity as never, noIdentity as never)).rejects.toThrow(/identity/);
    expect(reads).toBe(0); // refused before dispatch
  });

  it('delimiter-style identities are kept apart by the injective default key: "alpha"+"beta->gamma" and "alpha->beta"+"gamma" get DISTINCT keys and each transfers its own rows', async () => {
    let call = 0;
    const mkSource = (identity: string, rowsWhenFresh: number[]): SyncSource<{ id: number }> => ({
      identity,
      ordering: 'ordered',
      async read(cursor) {
        call += 1;
        if (cursor !== null) return { rows: [], cursor: null }; // nothing after a resumed cursor
        return { rows: rowsWhenFresh.map((id) => ({ id })), cursor: `c${rowsWhenFresh.length}` };
      },
    });
    const mkTarget = (identity: string, applied: number[]): SyncTarget<{ id: number }> => ({
      identity,
      writeMode: 'upsert',
      async write(rows) {
        applied.push(...rows.map((r) => r.id));
        return { written: rows.length };
      },
    });

    const applied1: number[] = [];
    const applied2: number[] = [];
    const { store, log } = recordingStore();

    // Pair 1: source "alpha" -> target "beta->gamma". Under the old `a->b`
    // delimiter key this collided with pair 2 (one key, second transfer did
    // nothing). The injective v1 JSON-array encoding keeps them apart.
    const r1 = await runTransfer(mkSource('alpha', [1, 2]), mkTarget('beta->gamma', applied1), {
      checkpointStore: store,
      batchSize: 10,
    });
    // Pair 2: source "alpha->beta" -> target "gamma" — previously the SAME key.
    const r2 = await runTransfer(mkSource('alpha->beta', [10, 20, 30]), mkTarget('gamma', applied2), {
      checkpointStore: store,
      batchSize: 10,
    });

    expect(r1.status).toBe('completed');
    expect(applied1).toEqual([1, 2]);
    // Fixed: pair 2 starts from ITS OWN (empty) checkpoint and transfers ALL of its rows.
    expect(r2.status).toBe('completed');
    expect(r2.rowsRead).toBe(3);
    expect(r2.exhausted).toBe(true);
    expect(applied2).toEqual([10, 20, 30]);
    // Two distinct keys in one shared store.
    expect(log.gets).toEqual([
      'dbsdk.sync:v1:["alpha","beta->gamma"]',
      'dbsdk.sync:v1:["alpha->beta","gamma"]',
    ]);
    expect(log.sets.map((s) => s.key)).toEqual([
      'dbsdk.sync:v1:["alpha","beta->gamma"]',
      'dbsdk.sync:v1:["alpha->beta","gamma"]',
    ]);
    // pair 1: read rows + exhaustion probe; pair 2: same.
    expect(call).toBe(4);
  });
});

/* ------------------------------------------------------------------------- */
/* 1b. Two different database pairs, shared checkpoint store (live real-PG)   */
/* ------------------------------------------------------------------------- */

live('R4-1b: two different database pairs share one checkpoint store without interference', () => {
  it('transfers pair 1 and pair 2 (same adapter, same table shape) through ONE store, interleaved, and each pair converges to its own data', async () => {
    const a1 = await makeSide('p1a');
    const b1 = await makeSide('p1b');
    const a2 = await makeSide('p2a');
    const b2 = await makeSide('p2b');
    try {
      await makeEventsTable(a1.db, 'p1a');
      await makeEventsTable(b1.db, 'p1b');
      await makeEventsTable(a2.db, 'p2a');
      await makeEventsTable(b2.db, 'p2b');
      for (let i = 1; i <= 5; i++) {
        await a1.db.query(sql`insert into r4_p1a.events (id, value, updated_at) values (${i}, ${'p1v' + i}, now() + (${i} * interval '1 second'))`);
      }
      for (const i of [11, 12, 13]) {
        await a2.db.query(sql`insert into r4_p2a.events (id, value, updated_at) values (${i}, ${'p2v' + i}, now() + (${i} * interval '1 second'))`);
      }
      const { store, log } = recordingStore();
      // Distinct explicit identities on every endpoint — deliberately similar
      // ("pair-1.src" vs "pair-2.src") to prove the key, not the name, isolates.
      const pair = (src: Database, dst: Database, n: string) =>
        runTransfer(
          createSqlSource({ db: src, table: ['r4_p' + n + 'a', 'events'], orderBy: ['id'], identity: `r4:pair-${n}.src` }),
          createSqlTarget({ db: dst, table: ['r4_p' + n + 'b', 'events'], key: ['id'], identity: `r4:pair-${n}.dst` }),
          { batchSize: 2, maxBatches: 1, checkpointStore: store }, // pair 1 paused mid-transfer
        );
      const pair1part1 = await pair(a1.db, b1.db, '1');
      const pair2full = await runTransfer(
        createSqlSource({ db: a2.db, table: ['r4_p2a', 'events'], orderBy: ['id'], identity: 'r4:pair-2.src' }),
        createSqlTarget({ db: b2.db, table: ['r4_p2b', 'events'], key: ['id'], identity: 'r4:pair-2.dst' }),
        { batchSize: 2, checkpointStore: store },
      );
      expect(pair2full.status).toBe('completed');
      expect(pair2full.exhausted).toBe(true);
      expect(pair1part1.status).toBe('completed');
      expect(pair1part1.exhausted).toBe(false); // bounded run of pair 1
      // Resume pair 1 through the SAME store to completion.
      const pair1part2 = await runTransfer(
        createSqlSource({ db: a1.db, table: ['r4_p1a', 'events'], orderBy: ['id'], identity: 'r4:pair-1.src' }),
        createSqlTarget({ db: b1.db, table: ['r4_p1b', 'events'], key: ['id'], identity: 'r4:pair-1.dst' }),
        { batchSize: 2, checkpointStore: store },
      );
      expect(pair1part2.status).toBe('completed');
      expect(pair1part2.exhausted).toBe(true);
      // Each pair's target holds EXACTLY its own source data — no cross-talk.
      const src1 = await tableContents(a1.db, 'p1a', 'events', ['id', 'value']);
      const dst1 = await tableContents(b1.db, 'p1b', 'events', ['id', 'value']);
      expect(dst1).toEqual(src1);
      const src2 = await tableContents(a2.db, 'p2a', 'events', ['id', 'value']);
      const dst2 = await tableContents(b2.db, 'p2b', 'events', ['id', 'value']);
      expect(dst2).toEqual(src2);
      expect(dst1.map((r) => r.id)).toEqual(['1', '2', '3', '4', '5']);
      expect(dst2.map((r) => r.id)).toEqual(['11', '12', '13']);
      // The store holds TWO distinct keys — isolation came from identity, not the store.
      const keys = log.sets.map((s) => s.key);
      expect(new Set(keys).size).toBe(2);
    } finally {
      await a1.cleanup();
      await b1.cleanup();
      await a2.cleanup();
      await b2.cleanup();
    }
  });
});

/* ------------------------------------------------------------------------- */
/* ------------------------------------------------------------------------- */

live('R4-2: uniqueOrder preflight — independent real-PG verification', () => {
  it('non-unique orderBy is REFUSED with CONTRACT before any write, at batchSize 2 AND batchSize 1', async () => {
    const a = await makeSide('pf_a');
    const b = await makeSide('pf_b');
    try {
      await makeEventsTable(a.db, 'pf_a');
      await makeEventsTable(b.db, 'pf_b');
      // Three rows share one timestamp; a unique index exists only on (id).
      await a.db.query(sql`insert into r4_pf_a.events (id, value, updated_at) values
        (1, 'v1', '2026-01-01T00:00:00Z'), (2, 'v2', '2026-01-01T00:00:00Z'),
        (3, 'v3', '2026-01-01T00:00:00Z'), (4, 'v4', '2026-01-02T00:00:00Z')`);

      for (const batchSize of [2, 1]) {
        const source = createSqlSource({
          db: a.db, table: ['r4_pf_a', 'events'], orderBy: ['updated_at'], identity: `r4:pf.src.${batchSize}`,
        });
        const target = createSqlTarget({ db: b.db, table: ['r4_pf_b', 'events'], key: ['id'], identity: 'r4:pf.dst' });
        const result = await runTransfer(source, target, { batchSize, checkpointStore: createMemoryCheckpointStore() });
        expect(result.status).toBe('failed');
        expect(result.rowsRead).toBe(0);
        expect(result.rowsWritten).toBe(0);
        expect(isSyncError(result.error)).toBe(true);
        expect((result.error as SyncError).code).toBe('CONTRACT');
        expect(String(result.error)).toMatch(/unique index/);
      }
      // Refusal happened BEFORE any write: the target table is still empty.
      const count = await b.db.query<{ n: string }>(sql`select count(*)::text as n from r4_pf_b.events`);
      expect(req(count.rows[0]).n).toBe('0');
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('a unique index whose INCLUDE column is NOT a key column is not trusted as making a non-unique orderBy unique', async () => {
    const a = await makeSide('pf_inc');
    try {
      await a.db.query(sql`create table r4_pf_inc.events (id integer primary key, value text not null, updated_at timestamptz not null)`);
      await a.db.query(sql`insert into r4_pf_inc.events (id, value, updated_at) values
        (1, 'v1', '2026-01-01T00:00:00Z'), (2, 'v2', '2026-01-01T00:00:00Z')`);
      // Unique on (id) only; `updated_at` is merely an INCLUDE column.
      await a.db.query(sql`create unique index r4_pf_inc_idx on r4_pf_inc.events (id) include (updated_at)`);
      const source = createSqlSource({ db: a.db, table: ['r4_pf_inc', 'events'], orderBy: ['updated_at'], identity: 'r4:pf.inc' });
      const result = await runTransfer(source, {
        identity: 'r4:pf.inc.dst', writeMode: 'upsert',
        write: async () => { throw new Error('write MUST NOT be dispatched'); },
      }, { batchSize: 2, checkpointStore: createMemoryCheckpointStore() });
      expect(result.status).toBe('failed');
      expect(isSyncError(result.error)).toBe(true);
      expect((result.error as SyncError).code).toBe('CONTRACT');
      // Conversely, the same index DOES satisfy orderBy ['id'] (INCLUDE cols are
      // excluded from the key set via indnkeyatts — no false rejection):
      const ok = createSqlSource({ db: a.db, table: ['r4_pf_inc', 'events'], orderBy: ['id'], identity: 'r4:pf.inc2' });
      const r2 = await runTransfer(ok, {
        identity: 'r4:pf.inc2.dst', writeMode: 'upsert',
        write: async (rows) => ({ written: rows.length }),
      }, { batchSize: 2, checkpointStore: createMemoryCheckpointStore() });
      expect(r2.status).toBe('completed');
      expect(r2.rowsRead).toBe(2);
    } finally {
      await a.cleanup();
    }
  });

  it('partial and expression unique indexes are rejected; nullable orderBy columns are refused (all before any write)', async () => {
    const a = await makeSide('pf_pe');
    try {
      // Partial index: unique only among rows with id > 2; rows 1,2 share a ts and
      // would be silently skipped. A preflight that ignores indpred accepts it.
      await a.db.query(sql`create table r4_pf_pe.events (id integer primary key, value text not null, updated_at timestamptz not null)`);
      await a.db.query(sql`insert into r4_pf_pe.events (id, value, updated_at) values
        (1, 'v1', '2026-01-01T00:00:00Z'), (2, 'v2', '2026-01-01T00:00:00Z'),
        (3, 'v3', '2026-01-02T00:00:00Z'), (4, 'v4', '2026-01-03T00:00:00Z')`);
      await a.db.query(sql`create unique index r4_pf_pe_partial on r4_pf_pe.events (updated_at) where id > 2`);
      const partial = await runTransfer(
        createSqlSource({ db: a.db, table: ['r4_pf_pe', 'events'], orderBy: ['updated_at'], identity: 'r4:pf.pe1' }),
        { identity: 'x', writeMode: 'upsert', write: async () => { throw new Error('MUST NOT BE CALLED'); } },
        { batchSize: 2, checkpointStore: createMemoryCheckpointStore() },
      );
      expect(partial.status).toBe('failed');
      expect((partial.error as SyncError).code).toBe('CONTRACT');

      // Expression index: unique on (value || id::text), raw `value` has duplicates.
      await a.db.query(sql`create table r4_pf_pe.expr (id integer primary key, value text not null)`);
      await a.db.query(sql`insert into r4_pf_pe.expr values (1,'ab'), (2,'ab'), (3,'cd')`);
      await a.db.query(sql`create unique index r4_pf_pe_expr on r4_pf_pe.expr ((value || id::text))`);
      const expr = await runTransfer(
        createSqlSource({ db: a.db, table: ['r4_pf_pe', 'expr'], orderBy: ['value'], identity: 'r4:pf.pe2' }),
        { identity: 'x', writeMode: 'upsert', write: async () => { throw new Error('MUST NOT BE CALLED'); } },
        { batchSize: 2, checkpointStore: createMemoryCheckpointStore() },
      );
      expect(expr.status).toBe('failed');
      expect((expr.error as SyncError).code).toBe('CONTRACT');

      // Nullable orderBy column: refused declaratively (catalog), even with all
      // current values non-NULL.
      await a.db.query(sql`create table r4_pf_pe.nullable (id integer primary key, updated_at timestamptz)`);
      await a.db.query(sql`insert into r4_pf_pe.nullable values (1,'2026-01-01T00:00:00Z'), (2,'2026-01-02T00:00:00Z')`);
      const nullable = await runTransfer(
        createSqlSource({ db: a.db, table: ['r4_pf_pe', 'nullable'], orderBy: ['updated_at'], identity: 'r4:pf.pe3' }),
        { identity: 'x', writeMode: 'upsert', write: async () => { throw new Error('MUST NOT BE CALLED'); } },
        { batchSize: 2, checkpointStore: createMemoryCheckpointStore() },
      );
      expect(nullable.status).toBe('failed');
      expect((nullable.error as SyncError).code).toBe('CONTRACT');
    } finally {
      await a.cleanup();
    }
  });

  it('legitimate composite order (dup timestamps + unique id tie-breaker) transfers COMPLETELY with no skips, even at batchSize 1', async () => {
    const a = await makeSide('pf_ok');
    const b = await makeSide('pf_ok_b');
    try {
      await makeEventsTable(a.db, 'pf_ok');
      await makeEventsTable(b.db, 'pf_ok_b');
      await a.db.query(sql`insert into r4_pf_ok.events (id, value, updated_at) values
        (1, 'v1', '2026-01-01T00:00:00Z'), (2, 'v2', '2026-01-01T00:00:00Z'),
        (3, 'v3', '2026-01-01T00:00:00Z'), (4, 'v4', '2026-01-02T00:00:00Z'),
        (5, 'v5', '2026-01-02T00:00:00Z')`);
      const result = await runTransfer(
        createSqlSource({ db: a.db, table: ['r4_pf_ok', 'events'], orderBy: ['updated_at', 'id'], identity: 'r4:pf.ok.src' }),
        createSqlTarget({ db: b.db, table: ['r4_pf_ok_b', 'events'], key: ['id'], identity: 'r4:pf.ok.dst' }),
        { batchSize: 1, checkpointStore: createMemoryCheckpointStore() }, // ties span every page boundary
      );
      expect(result.status).toBe('completed');
      expect(result.exhausted).toBe(true);
      expect(result.rowsWritten).toBe(5);
      const src = await tableContents(a.db, 'pf_ok', 'events', ['id', 'value']);
      const dst = await tableContents(b.db, 'pf_ok_b', 'events', ['id', 'value']);
      expect(dst).toEqual(src); // exact same rows, no skips, no duplicates
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('preflight runs once per source instance (cached), and a failed preflight is replayed honestly without re-querying', async () => {
    const seen: string[] = [];
    // Failure case: no valid unique index -> CONTRACT on every read, but the
    // catalog is queried only ONCE (the cached rejection is replayed).
    const failingDb = fixtureDb([{ match: /pg_index/, rows: [] }], (q) => seen.push(q.text));
    const failingSource = createSqlSource({ db: failingDb, table: 'events', orderBy: ['id'], identity: 'r4:cache.fail' });
    const dummyTarget: SyncTarget<Record<string, unknown>> = {
      identity: 'r4:cache.fail.dst',
      writeMode: 'upsert',
      write: async () => { throw new Error('MUST NOT BE CALLED'); },
    };
    const f1 = await runTransfer(failingSource, dummyTarget, { batchSize: 1, checkpointStore: createMemoryCheckpointStore() });
    expect(f1.status).toBe('failed');
    expect((f1.error as SyncError).code).toBe('CONTRACT');
    const queriesAfterFirstRead = seen.length;
    expect(queriesAfterFirstRead).toBeGreaterThan(0);
    const f2 = await runTransfer(failingSource, dummyTarget, { batchSize: 1, checkpointStore: createMemoryCheckpointStore() });
    expect(f2.status).toBe('failed');
    expect((f2.error as SyncError).code).toBe('CONTRACT'); // same honest failure
    expect(seen.length).toBe(queriesAfterFirstRead); // zero additional queries — cached, not re-run

    // Success case: the catalog checks also run only once for two reads.
    const seenOk: string[] = [];
    const okDb = fixtureDb(
      [
        { match: /pg_index/, rows: [{ ok: 1 }], repeat: true },
        { match: /pg_attribute/, rows: [{ attname: 'id', attnotnull: true }], repeat: true },
        { match: /select/, params: [1], rows: [{ id: 1, __dbsdk_cursor_0: '1' }], repeat: true },
        { match: /select/, params: ['1', 1], rows: [{ id: 2, __dbsdk_cursor_0: '2' }], repeat: true },
        { match: /select/, params: ['2', 1], rows: [], repeat: true }, // exhaustion probe
      ],
      (q) => seenOk.push(q.text),
    );
    const okSource = createSqlSource({ db: okDb, table: 'events', orderBy: ['id'], identity: 'r4:cache.ok' });
    const countingTarget: SyncTarget<Record<string, unknown>> = {
      identity: 'r4:cache.ok.dst',
      writeMode: 'upsert',
      write: async (rows) => ({ written: rows.length }),
    };
    const s1 = await runTransfer(okSource, countingTarget, { batchSize: 1, checkpointStore: createMemoryCheckpointStore() });
    expect(s1.status).toBe('completed');
    const s2 = await runTransfer(okSource, countingTarget, { batchSize: 1, checkpointStore: createMemoryCheckpointStore() });
    expect(s2.status).toBe('completed');
    expect(seenOk.filter((t) => t.includes('pg_index')).length).toBe(1); // cached preflight
  });
});

/* ------------------------------------------------------------------------- */
/* 3. Cursor exactness and PAYLOAD fidelity (R2-11 fix) — live real-PG        */
/* ------------------------------------------------------------------------- */

live('R4-3: exact cursors AND actual copied payload values (source-vs-target)', () => {
  it('transfers sub-millisecond timestamptz, bigint > 2^53, numeric, bytea and jsonb; cursors exact; payload fidelity recorded per column', async () => {
    const a = await makeSide('cur_a');
    const b = await makeSide('cur_b');
    try {
      await a.db.query(sql`create table r4_cur_a.events (
        id integer primary key,
        ts timestamptz not null,
        big bigint not null,
        num numeric(20,6) not null,
        payload bytea not null,
        doc jsonb not null,
        value text not null)`);
      await b.db.query(sql`create table r4_cur_b.events (like r4_cur_a.events including all)`);
      await a.db.query(sql`insert into r4_cur_a.events values
        (1, '2026-01-01 00:00:00.000001+00', 9007199254740995, 99999999.999999, decode('0001ff','hex'), '{"a":1,"b":[1,2]}'::jsonb, 'v1'),
        (2, '2026-01-01 00:00:00.000002+00', 9007199254740996, 0.000001, decode('cafe','hex'), '{"k":"v"}'::jsonb, 'v2'),
        (3, '2026-01-01 00:00:00.000003+00', 9007199254740997, 12.34, ''::bytea, '{"n":null}'::jsonb, 'v3'),
        (4, '2026-01-01 00:00:00.000003+00', 9007199254740998, 1.000000, decode('00','hex'), '[]'::jsonb, 'v4')`);

      const { store, log } = recordingStore();
      const cursors: (string | null)[] = [];
      // Split across runs with resume: batch 1 in run 1, remainder in run 2.
      const run1 = await runTransfer(
        createSqlSource({ db: a.db, table: ['r4_cur_a', 'events'], orderBy: ['ts', 'id'], identity: 'r4:cur.src' }),
        createSqlTarget({ db: b.db, table: ['r4_cur_b', 'events'], key: ['id'], identity: 'r4:cur.dst' }),
        { batchSize: 2, maxBatches: 1, checkpointStore: store, onProgress: (p) => cursors.push(p.cursor) },
      );
      expect(run1.status).toBe('completed');
      expect(run1.exhausted).toBe(false); // bounded run, not globally complete
      expect(run1.rowsWritten).toBe(2);

      const run2 = await runTransfer(
        createSqlSource({ db: a.db, table: ['r4_cur_a', 'events'], orderBy: ['ts', 'id'], identity: 'r4:cur.src' }),
        createSqlTarget({ db: b.db, table: ['r4_cur_b', 'events'], key: ['id'], identity: 'r4:cur.dst' }),
        { batchSize: 2, checkpointStore: store, onProgress: (p) => cursors.push(p.cursor) },
      );
      expect(run2.status).toBe('completed');
      expect(run2.exhausted).toBe(true);
      expect(run2.rowsWritten).toBe(2); // exactly the remainder, no re-read of run 1

      // Cursor exactness: PostgreSQL's full text rendering, incl. microseconds.
      expect(log.sets[0]?.value).toBe('["2026-01-01 00:00:00.000002+00","2"]');
      expect(log.sets.at(-1)?.value).toBe('["2026-01-01 00:00:00.000003+00","4"]');
      // Cursor progression across runs never repeats and never skips:
      const decoded = cursors.filter((c): c is string => c !== null).map((c) => JSON.parse(c) as [string, number]);
      for (let i = 1; i < decoded.length; i++) {
        const [tsPrev, idPrev] = decoded[i - 1]!;
        const [tsCurr, idCurr] = decoded[i]!;
        const strictlyAfter = tsCurr > tsPrev || (tsCurr === tsPrev && idCurr > idPrev);
        expect(strictlyAfter).toBe(true);
      }

      // PAYLOAD fidelity: compare actual source vs target column values (text).
      // Fixed in R5: the exact-payload projection delivers every lossy column
      // (including `doc`) as its exact text, and the target writes those strings
      // verbatim — so the FULL row is faithful now.
      const src = await tableContents(a.db, 'cur_a', 'events', ['id', 'ts', 'big', 'num', 'payload', 'doc', 'value']);
      const dst = await tableContents(b.db, 'cur_b', 'events', ['id', 'ts', 'big', 'num', 'payload', 'doc', 'value']);
      expect(dst).toEqual(src); // every column, including doc and ts, is faithful
      expect(src[0]!.big).toBe('9007199254740995'); // > 2^53 survived in the copied DATA
      expect(src[1]!.num).toBe('0.000001');
      // Nested arrays INSIDE objects survive exactly:
      expect(JSON.parse(req(src[0]!.doc))).toEqual({ a: 1, b: [1, 2] });
      expect(JSON.parse(req(dst[0]!.doc))).toEqual({ a: 1, b: [1, 2] });

      // FIXED (was the R4 timestamp-finding): sub-millisecond precision survives
      // the copy — the four source values keep their distinct microseconds.
      expect(src[0]!.ts).toBe('2026-01-01 00:00:00.000001+00');
      expect(dst[0]!.ts).toBe('2026-01-01 00:00:00.000001+00');
      const srcDistinctTs = new Set(src.map((r) => r.ts)).size;
      const dstDistinctTs = new Set(dst.map((r) => r.ts)).size;
      expect(srcDistinctTs).toBe(3); // rows 3 and 4 share .000003 (a page-boundary tie)
      expect(dstDistinctTs).toBe(3); // no collapse: distinct in, distinct out
      // FIXED (was the R4 JSON-array finding): the top-level JSON array `[]`
      // stays an array on the target (not `{}`).
      expect(src[3]!.doc).toBe('[]');
      expect(dst[3]!.doc).toBe('[]');
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('bigint and numeric as ORDER-BY columns: exact cursors, exact resume, exact payload', async () => {
    const a = await makeSide('cur_big');
    const b = await makeSide('cur_big_b');
    try {
      await a.db.query(sql`create table r4_cur_big.events (big bigint primary key, num numeric(20,6) not null)`);
      await b.db.query(sql`create table r4_cur_big_b.events (like r4_cur_big.events including all)`);
      await a.db.query(sql`insert into r4_cur_big.events values
        (9007199254740995, 99999999.999999), (9007199254740996, 0.000001), (9007199254740997, 12.34)`);
      const { store, log } = recordingStore();
      const run1 = await runTransfer(
        createSqlSource({ db: a.db, table: ['r4_cur_big', 'events'], orderBy: ['big'], identity: 'r4:big.src' }),
        createSqlTarget({ db: b.db, table: ['r4_cur_big_b', 'events'], key: ['big'], identity: 'r4:big.dst' }),
        { batchSize: 1, maxBatches: 2, checkpointStore: store },
      );
      expect(run1.status).toBe('completed');
      expect(run1.exhausted).toBe(false);
      const run2 = await runTransfer(
        createSqlSource({ db: a.db, table: ['r4_cur_big', 'events'], orderBy: ['big'], identity: 'r4:big.src' }),
        createSqlTarget({ db: b.db, table: ['r4_cur_big_b', 'events'], key: ['big'], identity: 'r4:big.dst' }),
        { batchSize: 1, checkpointStore: store },
      );
      expect(run2.status).toBe('completed');
      expect(run2.rowsWritten).toBe(1);
      expect(log.sets.map((s) => s.value)).toEqual([
        '["9007199254740995"]', '["9007199254740996"]', '["9007199254740997"]',
      ]);
      const src = await tableContents(a.db, 'cur_big', 'events', ['big', 'num']);
      const dst = await tableContents(b.db, 'cur_big_b', 'events', ['big', 'num']);
      expect(dst).toEqual(src); // full-precision data, not just cursor strings
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('incremental run picks up a later row with an exact new microsecond value; cursor never repeats or skips', async () => {
    const a = await makeSide('cur_inc');
    const b = await makeSide('cur_inc_b');
    try {
      await makeEventsTable(a.db, 'cur_inc');
      await makeEventsTable(b.db, 'cur_inc_b');
      await a.db.query(sql`insert into r4_cur_inc.events (id, value, updated_at) values
        (1, 'v1', '2026-01-01 00:00:00.000001+00'), (2, 'v2', '2026-01-01 00:00:00.000002+00')`);
      const source = createSqlSource({ db: a.db, table: ['r4_cur_inc', 'events'], orderBy: ['updated_at', 'id'], identity: 'r4:inc.src' });
      const target = createSqlTarget({ db: b.db, table: ['r4_cur_inc_b', 'events'], key: ['id'], identity: 'r4:inc.dst' });
      const { store, log } = recordingStore();
      const first = await runTransfer(source, target, { batchSize: 1, checkpointStore: store });
      expect(first.rowsWritten).toBe(2);
      const idle = await runTransfer(source, target, { batchSize: 1, checkpointStore: store });
      expect(idle.rowsRead).toBe(0); // exact resume: zero re-reads
      await a.db.query(sql`insert into r4_cur_inc.events (id, value, updated_at) values
        (3, 'v3', '2026-01-01 00:00:00.000003+00')`);
      const second = await runTransfer(source, target, { batchSize: 1, checkpointStore: store });
      expect(second.rowsRead).toBe(1);
      expect(second.rowsWritten).toBe(1);
      expect(log.sets.at(-1)?.value).toBe('["2026-01-01 00:00:00.000003+00","3"]');
      const src = await tableContents(a.db, 'cur_inc', 'events', ['id', 'value']);
      const dst = await tableContents(b.db, 'cur_inc_b', 'events', ['id', 'value']);
      expect(dst).toEqual(src);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });
});

live('R4-3b: FIXED — top-level JSON arrays survive the pg copy path exactly', () => {
  it('source jsonb `[]`, `[1,2]` and scalar JSON all round-trip faithfully through a real transfer', async () => {
    const a = await makeSide('json_a');
    const b = await makeSide('json_b');
    try {
      await a.db.query(sql`create table r4_json_a.events (id integer primary key, doc jsonb not null)`);
      await b.db.query(sql`create table r4_json_b.events (like r4_json_a.events including all)`);
      await a.db.query(sql`insert into r4_json_a.events values
        (1, '[]'::jsonb), (2, '{"ok":true}'::jsonb), (3, '[1,2]'::jsonb),
        (4, '"hello"'::jsonb), (5, 'null'::jsonb), (6, '{"t":[[],[1]]}'::jsonb)`);
      const source = createSqlSource({ db: a.db, table: ['r4_json_a', 'events'], orderBy: ['id'], identity: 'r4:json.src' });
      const target = createSqlTarget({ db: b.db, table: ['r4_json_b', 'events'], key: ['id'], identity: 'r4:json.dst' });
      const result = await runTransfer(source, target, { batchSize: 2, checkpointStore: createMemoryCheckpointStore() });
      // Fixed: the exact-payload projection delivers jsonb as its exact text and
      // the target writes that text verbatim — the whole transfer completes and
      // every JSON shape (including the previously corrupted/failing arrays,
      // JSON string scalars, and JSON null) is preserved.
      expect(result.status).toBe('completed');
      expect(result.exhausted).toBe(true);
      expect(result.rowsWritten).toBe(6);
      const dst = await tableContents(b.db, 'json_b', 'events', ['id', 'doc']);
      const src = await tableContents(a.db, 'json_a', 'events', ['id', 'doc']);
      expect(dst).toEqual(src); // full-fidelity comparison of every row
      expect(dst[0]!.doc).toBe('[]'); // stays an array, never became `{}`
      expect(dst[2]!.doc).toBe('[1, 2]'); // no more "invalid input syntax for type json"
      expect(dst[3]!.doc).toBe('"hello"'); // JSON string scalar preserved
      expect(dst[4]!.doc).toBe('null'); // JSON null ≠ SQL NULL (was silently lost before)
      expect(dst[5]!.doc).toBe('{"t": [[], [1]]}'); // nested arrays inside objects
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });
});

/* ------------------------------------------------------------------------- */
/* ------------------------------------------------------------------------- */

live('R4-4: internal `__dbsdk_cursor_*` alias collisions', () => {
  it('a REAL table column named __dbsdk_cursor_0 is REFUSED with CONTRACT and zero writes under the default wildcard projection (fixed)', async () => {
    const a = await makeSide('alias_a');
    const b = await makeSide('alias_b');
    try {
      await a.db.query(sql`create table r4_alias_a.events (id integer primary key, value text not null)`);
      await a.db.query(sql`alter table r4_alias_a.events add column ${sql.identifier('__dbsdk_cursor_0')} text`);
      await a.db.query(sql`insert into r4_alias_a.events (id, value, ${sql.identifier('__dbsdk_cursor_0')}) values
        (1, 'v1', 'REAL-1'), (2, 'v2', 'REAL-2'), (3, 'v3', 'REAL-3')`);
      await b.db.query(sql`create table r4_alias_b.events (id integer primary key, value text not null)`);
      await b.db.query(sql`alter table r4_alias_b.events add column ${sql.identifier('__dbsdk_cursor_0')} text`);

      const payloadKeys: string[][] = [];
      const result = await runTransfer(
        createSqlSource({ db: a.db, table: ['r4_alias_a', 'events'], orderBy: ['id'], identity: 'r4:alias.src' }),
        createSqlTarget({ db: b.db, table: ['r4_alias_b', 'events'], key: ['id'], identity: 'r4:alias.dst' }),
        {
          batchSize: 2,
          checkpointStore: createMemoryCheckpointStore(),
          map: (row) => {
            payloadKeys.push(Object.keys(row));
            return row;
          },
        },
      );
      // FIXED: the wildcard-projected reserved column is refused loudly at the
      // preflight, BEFORE any data read, map call, or write — no silent loss.
      expect(result.status).toBe('failed');
      expect(result.error).toBeInstanceOf(SyncError);
      expect((result.error as SyncError).code).toBe('CONTRACT');
      expect(String(result.error)).toMatch(/__dbsdk_cursor_0/);
      expect(result.rowsRead).toBe(0);
      expect(result.rowsWritten).toBe(0);
      expect(payloadKeys).toEqual([]); // refused before any row reached map
      // Zero writes: the target table is still empty.
      const count = await b.db.query<{ n: string }>(sql`select count(*)::text as n from r4_alias_b.events`);
      expect(req(count.rows[0]).n).toBe('0');
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('a reserved-named real column is allowed when an explicit columns list omits it (live)', async () => {
    const a = await makeSide('alias_exp');
    const b = await makeSide('alias_exp_b');
    try {
      await a.db.query(sql`create table r4_alias_exp.events (id integer primary key, value text not null)`);
      await a.db.query(sql`alter table r4_alias_exp.events add column ${sql.identifier('__dbsdk_cursor_0')} text`);
      await a.db.query(sql`insert into r4_alias_exp.events (id, value) values (1, 'v1'), (2, 'v2')`);
      await b.db.query(sql`create table r4_alias_exp_b.events (id integer primary key, value text not null)`);
      const result = await runTransfer(
        createSqlSource({
          db: a.db, table: ['r4_alias_exp', 'events'], orderBy: ['id'],
          columns: ['id', 'value'], identity: 'r4:alias.exp',
        }),
        createSqlTarget({ db: b.db, table: ['r4_alias_exp_b', 'events'], key: ['id'], identity: 'r4:alias.exp.dst' }),
        { batchSize: 2, checkpointStore: createMemoryCheckpointStore() },
      );
      expect(result.status).toBe('completed');
      expect(result.rowsWritten).toBe(2); // the non-reserved columns copy normally
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('explicit columns omitting the order columns: cursor still exact, continuation works, no internal aliases leak into the payload', async () => {
    const a = await makeSide('proj_a');
    const b = await makeSide('proj_b');
    try {
      await makeEventsTable(a.db, 'proj_a');
      // Target deliberately lacks the order columns and any reserved-prefix
      // column: a leaked alias would make the INSERT fail loudly (canary).
      await b.db.query(sql`create table r4_proj_b.events (id integer primary key, value text not null)`);
      await a.db.query(sql`insert into r4_proj_a.events (id, value, updated_at) values
        (1, 'v1', '2026-01-01 00:00:00.000001+00'), (2, 'v2', '2026-01-01 00:00:00.000002+00'),
        (3, 'v3', '2026-01-01 00:00:00.000003+00')`);
      const { store, log } = recordingStore();
      const payloadKeys: string[][] = [];
      const mkTransfer = (maxBatches?: number) => runTransfer(
        createSqlSource({
          db: a.db, table: ['r4_proj_a', 'events'], orderBy: ['updated_at', 'id'],
          columns: ['id', 'value'], identity: 'r4:proj.src',
        }),
        createSqlTarget({ db: b.db, table: ['r4_proj_b', 'events'], key: ['id'], identity: 'r4:proj.dst' }),
        {
          batchSize: 1, maxBatches, checkpointStore: store,
          map: (row) => { payloadKeys.push(Object.keys(row)); return row; },
        },
      );
      const part1 = await mkTransfer(2);
      expect(part1.status).toBe('completed');
      expect(part1.exhausted).toBe(false);
      const part2 = await mkTransfer();
      expect(part2.status).toBe('completed');
      expect(part2.exhausted).toBe(true);
      // Cursor exactness with a projected-away order column:
      expect(log.sets.at(-1)?.value).toBe('["2026-01-01 00:00:00.000003+00","3"]');
      // No internal alias ever appears in the payload (the canary target accepted all rows).
      for (const keys of payloadKeys) expect(keys.sort()).toEqual(['id', 'value']);
      const src = await tableContents(a.db, 'proj_a', 'events', ['id', 'value']);
      const dst = await tableContents(b.db, 'proj_b', 'events', ['id', 'value']);
      expect(dst).toEqual(src);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });
});

/* ------------------------------------------------------------------------- */
/* 5. Failure / recovery regressions                                          */
/* ------------------------------------------------------------------------- */

live('R4-5: failure and recovery semantics on real PostgreSQL', () => {
  it('checkpoint set fails AFTER the target committed: rerun re-applies idempotently and converges to the exact source data', async () => {
    const a = await makeSide('rec_set');
    const b = await makeSide('rec_set_b');
    try {
      await makeEventsTable(a.db, 'rec_set');
      await makeEventsTable(b.db, 'rec_set_b');
      for (let i = 1; i <= 6; i++) {
        await a.db.query(sql`insert into r4_rec_set.events (id, value, updated_at) values (${i}, ${'v' + i}, now() + (${i} * interval '1 second'))`);
      }
      const source = () => createSqlSource({ db: a.db, table: ['r4_rec_set', 'events'], orderBy: ['id'], identity: 'r4:rec.src' });
      const target = () => createSqlTarget({ db: b.db, table: ['r4_rec_set_b', 'events'], key: ['id'], identity: 'r4:rec.dst' });
      const { store, log, setFailSet } = recordingStore();

      setFailSet(true);
      const run1 = await runTransfer(source(), target(), { batchSize: 2, checkpointStore: store });
      expect(run1.status).toBe('failed');
      expect(log.sets.length).toBe(0); // the set failed; nothing persisted
      expect(run1.lastCursor).not.toBeNull(); // but lastCursor truthfully names the committed batch
      expect(run1.rowsWritten).toBe(2); // batch 1 IS on the target

      setFailSet(false);
      const run2 = await runTransfer(source(), target(), { batchSize: 2, checkpointStore: store });
      expect(run2.status).toBe('completed');
      expect(run2.exhausted).toBe(true);
      // Convergence: target holds EXACTLY the source rows — re-applied batch included, no duplicates.
      const src = await tableContents(a.db, 'rec_set', 'events', ['id', 'value']);
      const dst = await tableContents(b.db, 'rec_set_b', 'events', ['id', 'value']);
      expect(dst).toEqual(src);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('abort during a write that still commits: persists the known cursor, reports aborted, rerun converges', async () => {
    const a = await makeSide('rec_abort');
    const b = await makeSide('rec_abort_b');
    try {
      await makeEventsTable(a.db, 'rec_abort');
      await makeEventsTable(b.db, 'rec_abort_b');
      for (let i = 1; i <= 6; i++) {
        await a.db.query(sql`insert into r4_rec_abort.events (id, value, updated_at) values (${i}, ${'v' + i}, now() + (${i} * interval '1 second'))`);
      }
      const controller = new AbortController();
      const inner = createSqlTarget({ db: b.db, table: ['r4_rec_abort_b', 'events'], key: ['id'], identity: 'r4:abort.dst' });
      let writes = 0;
      const abortingTarget: SyncTarget<Record<string, unknown>> = {
        identity: inner.identity,
        writeMode: inner.writeMode,
        async write(rows, options) {
          writes += 1;
          const receipt = await inner.write(rows, options); // batch 1 COMMITS
          if (writes === 1) controller.abort(); // signal fires in the commit window, after the commit
          return receipt;
        },
      };
      const { store, log } = recordingStore();
      const run1 = await runTransfer(
        createSqlSource({ db: a.db, table: ['r4_rec_abort', 'events'], orderBy: ['id'], identity: 'r4:abort.src' }),
        abortingTarget,
        { batchSize: 2, checkpointStore: store, signal: controller.signal },
      );
      expect(run1.status).toBe('aborted');
      expect(run1.batches).toBe(1);
      expect(run1.lastCursor).not.toBeNull();
      expect(log.sets.length).toBe(1); // committed batch persisted
      expect(log.sets[0]!.value).toBe(run1.lastCursor);
      // Rerun with a live signal converges to the full data set.
      const run2 = await runTransfer(
        createSqlSource({ db: a.db, table: ['r4_rec_abort', 'events'], orderBy: ['id'], identity: 'r4:abort.src' }),
        createSqlTarget({ db: b.db, table: ['r4_rec_abort_b', 'events'], key: ['id'], identity: 'r4:abort.dst' }),
        { batchSize: 2, checkpointStore: store },
      );
      expect(run2.status).toBe('completed');
      const src = await tableContents(a.db, 'rec_abort', 'events', ['id', 'value']);
      const dst = await tableContents(b.db, 'rec_abort_b', 'events', ['id', 'value']);
      expect(dst).toEqual(src);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('write throws WHILE aborting: status aborted, the ORIGINAL error object preserved by identity, checkpoint not advanced; rerun converges', async () => {
    const a = await makeSide('rec_wabort');
    const b = await makeSide('rec_wabort_b');
    try {
      await makeEventsTable(a.db, 'rec_wabort');
      await makeEventsTable(b.db, 'rec_wabort_b');
      for (let i = 1; i <= 4; i++) {
        await a.db.query(sql`insert into r4_rec_wabort.events (id, value, updated_at) values (${i}, ${'v' + i}, now() + (${i} * interval '1 second'))`);
      }
      const controller = new AbortController();
      const originalError = new Error('connection died mid-write');
      const throwingTarget: SyncTarget<Record<string, unknown>> = {
        identity: 'r4:wabort.dst',
        writeMode: 'upsert',
        async write() {
          controller.abort();
          throw originalError;
        },
      };
      const { store, log } = recordingStore();
      const run1 = await runTransfer(
        createSqlSource({ db: a.db, table: ['r4_rec_wabort', 'events'], orderBy: ['id'], identity: 'r4:wabort.src' }),
        throwingTarget,
        { batchSize: 2, checkpointStore: store, signal: controller.signal },
      );
      expect(run1.status).toBe('aborted'); // NOT failed: the caller's abort wins the label
      expect(run1.error).toBe(originalError); // object identity, not message matching
      expect(log.sets.length).toBe(0); // checkpoint not advanced
      // Rerun converges.
      const run2 = await runTransfer(
        createSqlSource({ db: a.db, table: ['r4_rec_wabort', 'events'], orderBy: ['id'], identity: 'r4:wabort.src' }),
        createSqlTarget({ db: b.db, table: ['r4_rec_wabort_b', 'events'], key: ['id'], identity: 'r4:wabort.dst' }),
        { batchSize: 2, checkpointStore: store },
      );
      expect(run2.status).toBe('completed');
      const dst = await tableContents(b.db, 'rec_wabort_b', 'events', ['id', 'value']);
      expect(dst.length).toBe(4);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('a real PostgreSQL write error (no abort): failed with the ORIGINAL DbError preserved and inspectable (sqlstate), previous cursor checkpointed', async () => {
    const a = await makeSide('rec_werr');
    const b = await makeSide('rec_werr_b');
    try {
      await makeEventsTable(a.db, 'rec_werr');
      await b.db.query(sql`create table r4_rec_werr_b.events (id integer primary key, value varchar(2) not null, updated_at timestamptz not null)`);
      await a.db.query(sql`insert into r4_rec_werr.events (id, value, updated_at) values
        (1, 'ok', '2026-01-01T00:00:01Z'), (2, 'ok', '2026-01-01T00:00:02Z'),
        (3, 'way-too-long-for-varchar2', '2026-01-01T00:00:03Z'), (4, 'ok', '2026-01-01T00:00:04Z')`);
      const { store, log } = recordingStore();
      const result = await runTransfer(
        createSqlSource({ db: a.db, table: ['r4_rec_werr', 'events'], orderBy: ['id'], identity: 'r4:werr.src' }),
        createSqlTarget({ db: b.db, table: ['r4_rec_werr_b', 'events'], key: ['id'], identity: 'r4:werr.dst' }),
        { batchSize: 2, checkpointStore: store },
      );
      expect(result.status).toBe('failed');
      expect(isDbError(result.error)).toBe(true); // the original error type survives
      const err = result.error as DbError;
      expect(err.sqlstate).toBe('22001'); // inspectable field, not message matching
      expect(err.indeterminate).toBe(false); // deterministic failure, honestly not flagged uncertain
      expect(result.batches).toBe(1);
      expect(result.lastCursor).toBe(log.sets[0]!.value); // previous committed cursor preserved
      // No auto-retry happened: exactly one store.set for the one committed batch.
      expect(log.sets.length).toBe(1);
      const dstCount = await b.db.query<{ n: string }>(sql`select count(*)::text as n from r4_rec_werr_b.events`);
      expect(req(dstCount.rows[0]).n).toBe('2');
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });
});

describe('R4-6: engine failure shapes (offline, consumer-level custom endpoints)', () => {
  const rows3 = [1, 2].map((id) => ({ id }));
  const mkSource = (pageRows: unknown[], cursor = 'c1'): SyncSource<{ id: number }> => ({
    identity: 'r4:eng.src',
    ordering: 'ordered',
    read: async (current, limit) =>
      current === null
        ? { rows: (pageRows as { id: number }[]).slice(0, limit), cursor }
        : { rows: [], cursor: null },
  });
  const recordingTarget = (applied: unknown[] = [], written?: number | undefined) => ({
    identity: 'r4:eng.dst',
    writeMode: 'upsert' as const,
    write: async (rows: unknown[]) => {
      applied.push(...rows);
      // bad === undefined simulates a receipt object with no `written` field.
      return (written === undefined ? {} : { written }) as never;
    },
  });

  it('a DbError with indeterminate:true thrown by the target is preserved BY IDENTITY and its field stays inspectable', async () => {
    const original = new DbError('connection lost after write sent', {
      code: 'CONNECTION', adapterId: 'postgres', retryable: false, indeterminate: true,
    });
    const target: SyncTarget<{ id: number }> = {
      identity: 'r4:eng.dst',
      writeMode: 'upsert',
      write: async () => { throw original; },
    };
    const { store, log } = recordingStore();
    const result = await runTransfer(mkSource(rows3), target, { batchSize: 2, checkpointStore: store });
    expect(result.status).toBe('failed');
    expect(result.error).toBe(original); // identity — the engine never rewraps
    expect(isDbError(result.error)).toBe(true);
    expect((result.error as DbError).indeterminate).toBe(true); // field remains inspectable
    expect(log.sets.length).toBe(0); // checkpoint not advanced on indeterminate outcome
    expect(result.lastCursor).toBeNull();
  });

  it('invalid write receipts (undefined, -1, 1.5, length+1) are CONTRACT failures with an indeterminate outcome; a rerun with an honest target converges', async () => {
    for (const bad of [undefined, -1, 1.5, 3] as const) {
      const applied: unknown[] = [];
      const target = recordingTarget(applied, bad as number | undefined);
      const { store, log } = recordingStore();
      const result = await runTransfer(mkSource(rows3), target, { batchSize: 2, checkpointStore: store });
      expect(result.status).toBe('failed');
      expect(isSyncError(result.error)).toBe(true);
      expect((result.error as SyncError).code).toBe('CONTRACT');
      expect(String(result.error)).toMatch(/indeterminate/i);
      expect(result.rowsWritten).toBe(0); // an unverifiable receipt is never counted as success
      expect(log.sets.length).toBe(0); // checkpoint not advanced
      // Rerun with an honest target re-reads the batch (nothing was assumed committed) and converges.
      const honest: unknown[] = [];
      const honestTarget: SyncTarget<{ id: number }> = {
        identity: 'r4:eng.dst',
        writeMode: 'upsert',
        write: async (rows) => {
          honest.push(...rows);
          return { written: rows.length };
        },
      };
      const rerun = await runTransfer(mkSource(rows3), honestTarget, { batchSize: 2, checkpointStore: store });
      expect(rerun.status).toBe('completed');
      expect(honest.length).toBe(2);
    }
  });

  it('an oversized page (source ignores the limit) is refused with CONTRACT before mapping or writing', async () => {
    const source: SyncSource<{ id: number }> = {
      identity: 'r4:oversize.src',
      ordering: 'ordered',
      read: async (_cursor, limit) => ({ rows: Array.from({ length: 6 }, (_, i) => ({ id: i + 1 })), cursor: 'c' + String(limit) }),
    };
    let writes = 0;
    let mapped = 0;
    const target: SyncTarget<{ id: number }> = {
      identity: 'r4:oversize.dst',
      writeMode: 'upsert',
      write: async (r) => { writes += r.length; return { written: r.length }; },
    };
    const { store, log } = recordingStore();
    const result = await runTransfer(source, target, { batchSize: 2, checkpointStore: store, map: (row) => { mapped += 1; return row; } });
    expect(result.status).toBe('failed');
    expect((result.error as SyncError).code).toBe('CONTRACT');
    expect(String(result.error)).toMatch(/limit of 2/);
    expect(writes).toBe(0); // never reached the target
    expect(mapped).toBe(0); // never mapped
    expect(log.sets.length).toBe(0);
  });

  it('a throwing map() returns a failed result; rowsRead counts what was read; no write, no checkpoint advance', async () => {
    const marker = new Error('map exploded');
    let writes = 0;
    const target: SyncTarget<{ id: number }> = {
      identity: 'r4:eng.dst',
      writeMode: 'upsert',
      write: async (r) => { writes += r.length; return { written: r.length }; },
    };
    const { store, log } = recordingStore();
    const result = await runTransfer(mkSource(rows3), target, {
      batchSize: 3,
      checkpointStore: store,
      map: (row) => { if (row.id === 2) throw marker; return row; },
    });
    expect(result.status).toBe('failed');
    expect(result.error).toBe(marker);
    expect(result.rowsRead).toBe(2);
    expect(writes).toBe(0);
    expect(log.sets.length).toBe(0);
  });

  it('a throwing checkpointStore.get() returns a failed result with ZERO dispatch (no read, no write)', async () => {
    let reads = 0;
    let writes = 0;
    const source: SyncSource<{ id: number }> = {
      identity: 'r4:eng.src',
      ordering: 'ordered',
      read: async () => { reads += 1; return { rows: rows3, cursor: 'c1' }; },
    };
    const target: SyncTarget<{ id: number }> = {
      identity: 'r4:eng.dst',
      writeMode: 'upsert',
      write: async (r) => { writes += r.length; return { written: r.length }; },
    };
    const { store, setFailGet, log } = recordingStore();
    setFailGet(true);
    const result = await runTransfer(source, target, { batchSize: 2, checkpointStore: store });
    expect(result.status).toBe('failed');
    expect(String(result.error)).toMatch(/store get unavailable/);
    expect(reads).toBe(0);
    expect(writes).toBe(0);
    expect(log.sets.length).toBe(0);
  });

  it('a throwing onProgress() is best-effort and consistent: the run completes, counts are exact, the store holds the final cursor', async () => {
    const applied: { id: number }[] = [];
    const target: SyncTarget<{ id: number }> = {
      identity: 'r4:eng.dst',
      writeMode: 'upsert',
      write: async (rows) => { applied.push(...(rows as { id: number }[])); return { written: rows.length }; },
    };
    const { store, log } = recordingStore();
    let progressCalls = 0;
    // A source that pages one row at a time with an advancing cursor.
    const pagedSource: SyncSource<{ id: number }> = {
      identity: 'r4:eng.src',
      ordering: 'ordered',
      read: async (current) => {
        const nextId = current === null ? 1 : (JSON.parse(current) as number) + 1;
        return nextId <= 2 ? { rows: [{ id: nextId }], cursor: String(nextId) } : { rows: [], cursor: null };
      },
    };
    const result = await runTransfer(pagedSource, target, {
      batchSize: 1,
      checkpointStore: store,
      onProgress: () => { progressCalls += 1; throw new Error('observer bug'); },
    });
    expect(result.status).toBe('completed');
    expect(result.batches).toBe(2);
    expect(result.rowsWritten).toBe(2);
    expect(progressCalls).toBe(2); // called every batch, throws ignored every time
    expect(log.sets.length).toBe(2);
    expect(applied.map((r) => r.id)).toEqual([1, 2]);
  });

  it('maxBatches bounds a run: completed with exhausted FALSE (not a false global completed), resume finishes and sets exhausted true', async () => {
    let batch = 0;
    const source: SyncSource<{ id: number }> = {
      identity: 'r4:eng.src',
      ordering: 'ordered',
      read: async () => {
        batch += 1;
        return batch <= 3 ? { rows: [{ id: batch }], cursor: 'c' + batch } : { rows: [], cursor: null };
      },
    };
    const applied: { id: number }[] = [];
    const target: SyncTarget<{ id: number }> = {
      identity: 'r4:eng.dst',
      writeMode: 'upsert',
      write: async (rows) => { applied.push(...(rows as { id: number }[])); return { written: rows.length }; },
    };
    const { store } = recordingStore();
    const run1 = await runTransfer(source, target, { batchSize: 1, maxBatches: 2, checkpointStore: store });
    expect(run1.status).toBe('completed');
    expect(run1.exhausted).toBe(false); // honest: bounded, not globally complete
    expect(run1.lastCursor).toBe('c2');
    const run2 = await runTransfer(source, target, { batchSize: 1, checkpointStore: store });
    expect(run2.status).toBe('completed');
    expect(run2.exhausted).toBe(true);
    expect(applied.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('two different database pairs sharing ONE store do not interfere even when interleaved (engine level)', async () => {
    const { store, log } = recordingStore();
    const pair = (ids: number[]) => ({
      source: {
        identity: 'generic',
        ordering: 'ordered' as const,
        read: async (cursor: string | null, limit: number) =>
          cursor === null
            ? { rows: ids.slice(0, limit).map((id) => ({ id })), cursor: `c${ids.length}` }
            : { rows: [], cursor: null },
      },
      target: {
        identity: 'generic',
        writeMode: 'upsert' as const,
        write: async (rows: { id: number }[]) => ({ written: rows.length }),
      },
    });
    // Distinct identities give distinct keys — but the engine interleaving must hold.
    const p1 = pair([1, 2, 3]);
    const p2 = pair([7, 8]);
    const r1a = await runTransfer({ ...p1.source, identity: 'pair1.src' } as never, { ...p1.target, identity: 'pair1.dst' } as never, { batchSize: 2, maxBatches: 1, checkpointStore: store });
    const r2 = await runTransfer({ ...p2.source, identity: 'pair2.src' } as never, { ...p2.target, identity: 'pair2.dst' } as never, { batchSize: 2, checkpointStore: store });
    const r1b = await runTransfer({ ...p1.source, identity: 'pair1.src' } as never, { ...p1.target, identity: 'pair1.dst' } as never, { batchSize: 2, checkpointStore: store });
    expect(r1a.exhausted).toBe(false);
    expect(r2.exhausted).toBe(true);
    expect(r1b.exhausted).toBe(true);
    const keys = new Set(log.sets.map((s) => s.key));
    expect(keys.size).toBe(2); // isolated keys, no cross-talk
  });
});
