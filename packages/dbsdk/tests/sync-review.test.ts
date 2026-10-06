/**
 * INDEPENDENT REVIEW TESTS (R2) — owned by the review agent, NOT by the sync owner.
 *
 * Consumer-level worst-case tests for the one-way resumable transfer primitive
 * (`runTransfer` + `createSqlSource`/`createSqlTarget`). These are deliberately NOT a
 * mirror of tests/sync (the owner's implementation tests); they probe the seams the
 * owner's suite does not cover.
 *
 * R3 status: the owner applied the fixes for R2-1/3/4/5/6/7/9/11. The tests labeled
 * `FINDING R2-nn` were converted from pinned buggy behavior into REGRESSIONS for the
 * fixed behavior (none deleted), per the R2 review's disposition (§3.4 of
 * coordination/v3-sync-review-r2.md). R2-2, R2-8 and R2-10 were fixed as
 * documentation-only contract statements; their tests remain truthful
 * characterizations of current behavior with references to the new documentation.
 *
 * Layers:
 * 1. Offline fake-backed tests: deterministic fake sources/targets/checkpoint stores
 *    (durable fake state, no randomness) for engine-level semantics.
 * 2. Live tests against the local PostgreSQL 17 container (dbsdk-pg-test, port 15432),
 *    skipped automatically when unreachable. No hosted Supabase/Neon calls, no secrets.
 */

import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { createDatabase, sql } from '../src/index.js';
import { postgres } from '../src/adapters/postgres.js';
import { createFixtureAdapter, type FixtureAdapterOptions } from '../src/testing.js';
import { createSqlSource, createSqlTarget } from '../src/sync/sql.js';
import { createMemoryCheckpointStore, runTransfer } from '../src/sync/core.js';
import { SyncError } from '../src/sync/errors.js';
import type { CheckpointStore, SyncSource, SyncTarget } from '../src/sync/types.js';
import type { Database } from '../src/types.js';

const LOCAL_URL = 'postgresql://postgres:dbsdk@localhost:15432/dbsdk';

type Row = { id: number };
type Page = { rows: Row[]; cursor: string | null };

function req<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value, got undefined');
  return value;
}

/* ------------------------------------------------------------------------- */
/* Fake-backed building blocks (deterministic, no randomness)                 */
/* ------------------------------------------------------------------------- */

/** Scripted source: `read(cursor)` looks up `pages[cursor ?? null]`. */
function scriptedSource(
  pages: ReadonlyMap<string | null, Page>,
  hooks?: {
    beforeRead?: () => Promise<void> | void;
    afterRead?: (cursor: string | null) => void;
  },
): SyncSource<Row> & { reads: (string | null)[] } {
  const reads: (string | null)[] = [];
  return {
    identity: 'fake-src',
    ordering: 'ordered',
    reads,
    async read(cursor) {
      reads.push(cursor);
      await hooks?.beforeRead?.();
      const page = pages.get(cursor ?? null);
      if (!page) throw new Error(`scripted source: no page for cursor ${String(cursor)}`);
      hooks?.afterRead?.(cursor);
      return { rows: [...page.rows], cursor: page.cursor };
    },
  };
}

/** Upsert target: Map keyed by id (re-application converges). */
function fakeUpsertTarget(store = new Map<number, Row>()): SyncTarget<Row> & { writes: number } {
  let writeCount = 0;
  const target: SyncTarget<Row> & { writes: number } = {
    identity: 'fake-tgt',
    writeMode: 'upsert',
    get writes() {
      return writeCount;
    },
    async write(rows) {
      writeCount += 1;
      for (const row of rows) store.set(row.id, row);
      return { written: rows.length };
    },
  };
  return target;
}

/** In-flight tracker to assert one-batch-at-a-time backpressure. */
function concurrencyTracker() {
  let reads = 0;
  let writes = 0;
  let maxReads = 0;
  let maxWrites = 0;
  return {
    async trackRead<T>(fn: () => Promise<T>): Promise<T> {
      reads += 1;
      maxReads = Math.max(maxReads, reads);
      try {
        return await fn();
      } finally {
        reads -= 1;
      }
    },
    async trackWrite<T>(fn: () => Promise<T>): Promise<T> {
      writes += 1;
      maxWrites = Math.max(maxWrites, writes);
      try {
        return await fn();
      } finally {
        writes -= 1;
      }
    },
    get observed() {
      return { maxReads, maxWrites };
    },
  };
}

function fixtureDb(
  fixtures: NonNullable<FixtureAdapterOptions['fixtures']>,
  options?: Omit<FixtureAdapterOptions, 'fixtures'>,
): Database {
  return createDatabase({ adapter: createFixtureAdapter({ ...options, fixtures }) });
}

const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------------- */
/* 1. Engine semantics the owner's suite does not cover                       */
/* ------------------------------------------------------------------------- */

describe('engine: backpressure is strictly one batch in flight', () => {
  it('never overlaps source.read calls or target.write calls', async () => {
    const tracker = concurrencyTracker();
    const pages = new Map<string | null, Page>([
      [null, { rows: [{ id: 1 }, { id: 2 }], cursor: 'c1' }],
      ['c1', { rows: [{ id: 3 }, { id: 4 }], cursor: 'c2' }],
      ['c2', { rows: [{ id: 5 }], cursor: 'c3' }],
      ['c3', { rows: [], cursor: null }],
    ]);
    const source = scriptedSource(pages, {
      beforeRead: () => tracker.trackRead(() => sleep(2)),
    });
    const target = fakeUpsertTarget();
    const baseWrite = target.write.bind(target);
    target.write = (rows, options) => tracker.trackWrite(() => baseWrite(rows, options));

    const result = await runTransfer(source, target, { batchSize: 2 });

    expect(result.status).toBe('completed');
    expect(result.exhausted).toBe(true);
    expect(tracker.observed.maxReads).toBe(1);
    expect(tracker.observed.maxWrites).toBe(1);
  });
});

describe('engine: abort after a committed write does not lose the batch', () => {
  it('persists the checkpoint for a write that committed, then reports aborted', async () => {
    const controller = new AbortController();
    const pages = new Map<string | null, Page>([
      [null, { rows: [{ id: 1 }, { id: 2 }], cursor: 'c1' }],
      ['c1', { rows: [], cursor: null }],
    ]);
    const source = scriptedSource(pages);
    const target = fakeUpsertTarget();
    const baseWrite = target.write.bind(target);
    target.write = async (rows, options) => {
      const out = await baseWrite(rows, options); // commit first...
      controller.abort(); // ...signal fires only after the target commit
      return out;
    };

    const store = createMemoryCheckpointStore();
    const result = await runTransfer(source, target, {
      checkpointStore: store,
      checkpointKey: 'k',
      signal: controller.signal,
    });

    // The batch IS on the target and the checkpoint IS saved — no silent data loss.
    expect(result.status).toBe('aborted');
    expect(result.batches).toBe(1);
    expect(result.rowsWritten).toBe(2);
    expect(result.lastCursor).toBe('c1');
    expect(result.error).toBeUndefined();
    expect(await store.get('k')).toBe('c1');
  });

  it('a write that throws while aborting reports aborted AND preserves the original error', async () => {
    const controller = new AbortController();
    const pages = new Map<string | null, Page>([
      [null, { rows: [{ id: 1 }], cursor: 'c1' }],
    ]);
    const source = scriptedSource(pages);
    const target = fakeUpsertTarget();
    const original = new Error('indeterminate write outcome during abort');
    target.write = async () => {
      controller.abort();
      throw original;
    };

    const store = createMemoryCheckpointStore();
    const result = await runTransfer(source, target, {
      checkpointStore: store,
      checkpointKey: 'k',
      signal: controller.signal,
    });

    expect(result.status).toBe('aborted');
    expect(result.error).toBe(original); // the cause is never swallowed
    expect(result.lastCursor).toBeNull();
    expect(await store.get('k')).toBeNull();
  });
});

describe('engine: failures return the documented TransferResult shape (R2-3/4/5 fixed)', () => {
  it('REGRESSION R2-3: a throwing map() returns a failed result; no write, no checkpoint advance', async () => {
    const pages = new Map<string | null, Page>([
      [null, { rows: [{ id: 1 }, { id: 2 }], cursor: 'c1' }],
    ]);
    const source = scriptedSource(pages);
    const target = fakeUpsertTarget();
    const store = createMemoryCheckpointStore();

    const boom = new Error('bad transform');
    const result = await runTransfer(source, target, {
      checkpointStore: store,
      checkpointKey: 'k',
      map: (row) => {
        if (row.id === 2) throw boom;
        return row;
      },
    });

    // Same failed-result shape as every other mid-run failure.
    expect(result.status).toBe('failed');
    expect(result.error).toBe(boom); // original error preserved
    expect(result.batches).toBe(0);
    expect(result.rowsRead).toBe(2); // the rows WERE read
    expect(result.rowsWritten).toBe(0);
    expect(result.lastCursor).toBeNull();
    expect(await store.get('k')).toBeNull();
    expect(target.writes).toBe(0);
  });

  it('REGRESSION R2-4: a throwing onProgress() is best-effort — run completes, batch committed+persisted', async () => {
    const pages = new Map<string | null, Page>([
      [null, { rows: [{ id: 1 }], cursor: 'c1' }],
      ['c1', { rows: [], cursor: null }],
    ]);
    const source = scriptedSource(pages);
    const target = fakeUpsertTarget();
    const store = createMemoryCheckpointStore();

    const result = await runTransfer(source, target, {
      checkpointStore: store,
      checkpointKey: 'k',
      onProgress: () => {
        throw new Error('observer crashed');
      },
    });

    // Documented best-effort: the observer cannot fail a committed batch.
    expect(result.status).toBe('completed');
    expect(result.exhausted).toBe(true);
    expect(result.batches).toBe(1);
    expect(result.rowsWritten).toBe(1);
    expect(result.lastCursor).toBe('c1');
    expect(await store.get('k')).toBe('c1');
  });

  it('REGRESSION R2-5: a throwing checkpointStore.get() returns a failed result with zero dispatch', async () => {
    const pages = new Map<string | null, Page>([[null, { rows: [{ id: 1 }], cursor: 'c1' }]]);
    const source = scriptedSource(pages);
    const target = fakeUpsertTarget();
    const broken: CheckpointStore = {
      get: async () => {
        throw new Error('checkpoint backend unreachable');
      },
      set: async () => {},
    };
    const result = await runTransfer(source, target, { checkpointStore: broken });
    expect(result.status).toBe('failed');
    expect(result.error).toBeInstanceOf(Error);
    expect(String(result.error)).toMatch(/checkpoint backend unreachable/);
    // Zero dispatch: no read, no write.
    expect(result.batches).toBe(0);
    expect(result.rowsRead).toBe(0);
    expect(source.reads).toEqual([]);
    expect(target.writes).toBe(0);
  });
});

describe('engine: concurrent jobs sharing a checkpoint key (R2-2: documented single-writer contract)', () => {
  it('R2-2 (characterization, now documented): a slower job overwrites a faster job\u2019s advanced cursor — caller must enforce one writer per key', async () => {
    // The CheckpointStore interface has no CAS/locking; this remains truthful
    // current behavior. The contract is now stated in the CheckpointStore TSDoc
    // and coordination/v3-sync-workflows.md §1: at most one concurrent writer per
    // checkpoint key; overlap is safe-but-wasteful for upsert targets and NOT
    // universally harmless (transforms / non-idempotent targets may not converge).
    const store = createMemoryCheckpointStore();

    const fastPages = new Map<string | null, Page>([
      [null, { rows: [{ id: 1 }], cursor: 'b1' }],
      ['b1', { rows: [{ id: 2 }], cursor: 'b2' }],
      ['b2', { rows: [{ id: 3 }], cursor: 'b3' }],
      ['b3', { rows: [], cursor: null }],
    ]);
    const slowPages = new Map<string | null, Page>([
      [null, { rows: [{ id: 1 }], cursor: 'a1' }],
      ['a1', { rows: [{ id: 2 }], cursor: 'a2' }],
      ['a2', { rows: [], cursor: null }],
    ]);
    const slowSource = scriptedSource(slowPages, { beforeRead: () => sleep(30) });
    const fastSource = scriptedSource(fastPages);

    const [slow, fast] = await Promise.all([
      runTransfer(slowSource, fakeUpsertTarget(), { checkpointStore: store, checkpointKey: 'shared' }),
      runTransfer(fastSource, fakeUpsertTarget(), { checkpointStore: store, checkpointKey: 'shared' }),
    ]);

    expect(fast.status).toBe('completed');
    expect(slow.status).toBe('completed');
    // The slower job finished last and its stale cursor won the store. The faster
    // job's progress (b3) is lost — a rerun re-copies from a2. Safe (upsert), and
    // the single-writer requirement is now an explicit part of the contract.
    expect(await store.get('shared')).toBe('a2');
  });

  it('jobs with distinct checkpoint keys do not interfere', async () => {
    const store = createMemoryCheckpointStore();
    const pagesOf = (a: string, b: string, c: string) =>
      new Map<string | null, Page>([
        [null, { rows: [{ id: 1 }], cursor: a }],
        [a, { rows: [{ id: 2 }], cursor: b }],
        [b, { rows: [], cursor: null }],
      ]);
    const [r1, r2] = await Promise.all([
      runTransfer(scriptedSource(pagesOf('x1', 'x2', 'x3')), fakeUpsertTarget(), {
        checkpointStore: store,
        checkpointKey: 'k1',
      }),
      runTransfer(scriptedSource(pagesOf('y1', 'y2', 'y3')), fakeUpsertTarget(), {
        checkpointStore: store,
        checkpointKey: 'k2',
      }),
    ]);
    expect(r1.status).toBe('completed');
    expect(r2.status).toBe('completed');
    expect(await store.get('k1')).toBe('x2');
    expect(await store.get('k2')).toBe('y2');
  });
});

describe('engine: target write receipts are validated (R2-6 fixed)', () => {
  it('REGRESSION R2-6: an undefined or inflated receipt is a CONTRACT failure with an indeterminate outcome', async () => {
    const pages = new Map<string | null, Page>([
      [null, { rows: [{ id: 1 }, { id: 2 }], cursor: 'c1' }],
      ['c1', { rows: [], cursor: null }],
    ]);
    const source = scriptedSource(pages);
    const store = createMemoryCheckpointStore();

    const undefinedTarget: SyncTarget<Row> = {
      identity: 'tgt',
      writeMode: 'upsert',
      write: async () => ({ written: undefined as unknown as number }),
    };
    const r1 = await runTransfer(source, undefinedTarget, {
      checkpointStore: store,
      checkpointKey: 'k1',
    });
    expect(r1.status).toBe('failed');
    expect(r1.error).toBeInstanceOf(SyncError);
    expect((r1.error as SyncError).code).toBe('CONTRACT');
    expect(String(r1.error)).toMatch(/invalid write receipt/);
    // The commit outcome is UNKNOWN — the checkpoint is NOT advanced.
    expect(r1.lastCursor).toBeNull();
    expect(await store.get('k1')).toBeNull();

    const inflatedTarget: SyncTarget<Row> = {
      identity: 'tgt',
      writeMode: 'upsert',
      write: async () => ({ written: 999 }),
    };
    const r2 = await runTransfer(source, inflatedTarget, {
      checkpointStore: store,
      checkpointKey: 'k2',
    });
    expect(r2.status).toBe('failed');
    expect((r2.error as SyncError).code).toBe('CONTRACT');
    expect(r2.lastCursor).toBeNull();
    expect(await store.get('k2')).toBeNull();
  });
});

describe('engine: the read limit is enforced on sources (R2-7 fixed)', () => {
  it('REGRESSION R2-7: a source returning more rows than the requested limit fails with CONTRACT before any write', async () => {
    // Source ignores `limit` and returns 6 rows when asked for 2.
    const oversized: SyncSource<Row> = {
      identity: 'oversized-src',
      ordering: 'ordered',
      read: async (cursor) => {
        if (cursor === null) {
          return {
            rows: Array.from({ length: 6 }, (_, i) => ({ id: i + 1 })),
            cursor: 'c1',
          };
        }
        return { rows: [], cursor: null };
      },
    };
    const target = fakeUpsertTarget();
    const result = await runTransfer(oversized, target, { batchSize: 2 });

    // Refused BEFORE mapping or writing — the backpressure contract holds.
    expect(result.status).toBe('failed');
    expect(result.error).toBeInstanceOf(SyncError);
    expect((result.error as SyncError).code).toBe('CONTRACT');
    expect(String(result.error)).toMatch(/oversized|honor the read limit|limit of 2|for a limit/i);
    expect(result.rowsWritten).toBe(0);
    expect(target.writes).toBe(0);
  });
});

describe('engine: maxBatches, exhaustion and checkpoint stability', () => {
  const pageSet = () =>
    new Map<string | null, Page>([
      [null, { rows: [{ id: 1 }, { id: 2 }], cursor: 'c2' }],
      ['c2', { rows: [{ id: 3 }, { id: 4 }], cursor: 'c4' }],
      ['c4', { rows: [{ id: 5 }], cursor: 'c5' }],
      ['c5', { rows: [], cursor: null }],
    ]);

  it('maxBatches reports completed/exhausted:false and resumes from the checkpoint', async () => {
    const store = createMemoryCheckpointStore();
    const target = fakeUpsertTarget();
    const first = await runTransfer(scriptedSource(pageSet()), target, {
      checkpointStore: store,
      checkpointKey: 'k',
      batchSize: 2,
      maxBatches: 2,
    });
    expect(first.status).toBe('completed'); // not exhausted — callers must check `exhausted`
    expect(first.exhausted).toBe(false);
    expect(first.batches).toBe(2);
    expect(first.lastCursor).toBe('c4');
    expect(await store.get('k')).toBe('c4');

    const resumed = await runTransfer(scriptedSource(pageSet()), target, {
      checkpointStore: store,
      checkpointKey: 'k',
      batchSize: 2,
    });
    expect(resumed.status).toBe('completed');
    expect(resumed.exhausted).toBe(true);
    expect(resumed.rowsWritten).toBe(1);
  });

  it('an exhausted run leaves the stored checkpoint untouched', async () => {
    const store = createMemoryCheckpointStore({ k: 'c5' });
    const result = await runTransfer(scriptedSource(pageSet()), fakeUpsertTarget(), {
      checkpointStore: store,
      checkpointKey: 'k',
      batchSize: 2,
    });
    expect(result.status).toBe('completed');
    expect(result.exhausted).toBe(true);
    expect(result.rowsRead).toBe(0);
    expect(await store.get('k')).toBe('c5'); // unchanged — safe for scheduled reruns
  });

  it('a pre-aborted run reports the stored cursor without touching the store', async () => {
    const controller = new AbortController();
    controller.abort();
    const store = createMemoryCheckpointStore({ k: 'cX' });
    const result = await runTransfer(scriptedSource(pageSet()), fakeUpsertTarget(), {
      checkpointStore: store,
      checkpointKey: 'k',
      signal: controller.signal,
    });
    expect(result.status).toBe('aborted');
    expect(result.lastCursor).toBe('cX');
    expect(await store.get('k')).toBe('cX');
  });
});

describe('engine: cursor regression across DISTINCT cursors is unverifiable (R2-8: documented source responsibility)', () => {
  it('R2-8 (characterization, now documented): a source cycling distinct cursors is bounded only by maxBatches', async () => {
    // Opaque cursors cannot be compared by the engine; monotonicity across
    // DISTINCT cursor values is the source's responsibility. This remains
    // truthful current behavior, now stated in the SyncSource.read TSDoc and
    // coordination/v3-sync-workflows.md §1 (maxBatches is the only guard; cursors
    // are never compared lexicographically by dbSDK).
    const pages = new Map<string | null, Page>([
      [null, { rows: [{ id: 1 }], cursor: 'cA' }],
      ['cA', { rows: [{ id: 2 }], cursor: 'cB' }],
      ['cB', { rows: [{ id: 3 }], cursor: 'cA' }], // goes BACK to cA
    ]);
    const target = fakeUpsertTarget();
    const result = await runTransfer(scriptedSource(pages), target, {
      checkpointStore: createMemoryCheckpointStore(),
      checkpointKey: 'k',
      maxBatches: 4,
    });
    // CURRENT behavior: completes after 4 batches, no contract error.
    expect(result.status).toBe('completed');
    expect(result.batches).toBe(4);
    expect(result.rowsRead).toBe(4);
  });
});

/* ------------------------------------------------------------------------- */
/* 2. Explicit identities isolate jobs across different databases (R2-1 fixed) */
/* ------------------------------------------------------------------------- */

describe('REGRESSION R2-1: no default checkpoint identity; explicit identities isolate jobs', () => {
  it('construction fails without an explicit identity (the unsafe adapterId:table default is gone)', () => {
    const sourceDb = fixtureDb([]);
    const targetDb = fixtureDb([]);
    expect(() =>
      createSqlSource({ db: sourceDb, table: ['public', 'events'], orderBy: ['id'] } as never),
    ).toThrow(/explicit, stable, secret-free identity/);
    expect(() =>
      createSqlTarget({ db: targetDb, table: ['public', 'events'], key: ['id'] } as never),
    ).toThrow(/explicit, stable, secret-free identity/);
  });

  it('two different database pairs, same table names, one shared store: distinct identities transfer everything', async () => {
    // Pair 1 and pair 2 are DIFFERENT databases (independent fixture adapters) with
    // the same table shape. Distinct explicit identities give each job its own
    // checkpoint — pair 2 must transfer ALL of its own rows, never pair 1's cursor.
    const store = createMemoryCheckpointStore();

    const source1 = fixtureDb(
      [
        { match: /pg_attribute/, params: ['events', 'public', 'public'], repeat: true, rows: [{ attname: 'id', attnotnull: true, basecategory: 'N', basetypname: 'int4', elemcategory: null, elemtypname: null }] },
        { match: /^select/, params: [100], rows: [{ id: 1, __dbsdk_cursor_0: '1' }, { id: 2, __dbsdk_cursor_0: '2' }, { id: 3, __dbsdk_cursor_0: '3' }] },
        { match: /^select/, params: ['3', 100], rows: [] },
      ],
    );
    const source2 = fixtureDb(
      [
        { match: /pg_attribute/, params: ['events', 'public', 'public'], repeat: true, rows: [{ attname: 'id', attnotnull: true, basecategory: 'N', basetypname: 'int4', elemcategory: null, elemtypname: null }] },
        { match: /^select/, params: [100], rows: [{ id: 1, __dbsdk_cursor_0: '1' }, { id: 2, __dbsdk_cursor_0: '2' }] },
        { match: /^select/, params: ['2', 100], rows: [] },
      ],
    );
    const targetFixtures = (rowCount: number): NonNullable<FixtureAdapterOptions['fixtures']> => [
      { match: /^insert/, rowCount, repeat: true },
    ];
    const target1 = fixtureDb(targetFixtures(3));
    const target2 = fixtureDb(targetFixtures(2));

    const src1 = createSqlSource({ db: source1, table: ['public', 'events'], orderBy: ['id'], identity: 'pair1:src', uniqueOrder: 'assume' });
    const tgt1 = createSqlTarget({ db: target1, table: ['public', 'events'], key: ['id'], identity: 'pair1:dst' });
    const src2 = createSqlSource({ db: source2, table: ['public', 'events'], orderBy: ['id'], identity: 'pair2:src', uniqueOrder: 'assume' });
    const tgt2 = createSqlTarget({ db: target2, table: ['public', 'events'], key: ['id'], identity: 'pair2:dst' });

    // Distinct identities by construction — and distinct checkpoint keys.
    expect(src1.identity).not.toBe(src2.identity);

    const first = await runTransfer(src1, tgt1, { checkpointStore: store, batchSize: 100 });
    expect(first.status).toBe('completed');
    expect(first.rowsWritten).toBe(3);

    // Pair 2 resumes from ITS OWN (empty) checkpoint and transfers ALL of its rows.
    const second = await runTransfer(src2, tgt2, { checkpointStore: store, batchSize: 100 });
    expect(second.status).toBe('completed');
    expect(second.exhausted).toBe(true);
    expect(second.rowsRead).toBe(2);
    expect(second.rowsWritten).toBe(2);

    // Both jobs persisted progress under their own keys — the injective v1
    // encoding of the identity pair.
    expect(await store.get('dbsdk.sync:v1:["pair1:src","pair1:dst"]')).toBe(JSON.stringify(['3']));
    expect(await store.get('dbsdk.sync:v1:["pair2:src","pair2:dst"]')).toBe(JSON.stringify(['2']));
  });
});

/* ------------------------------------------------------------------------- */
/* 3. Live tests — local PostgreSQL 17 container (skipped when unreachable)   */
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

live('live: keyset cursor honesty against real PostgreSQL 17', () => {
  async function makeSide(name: string): Promise<{ db: Database; cleanup: () => Promise<void> }> {
    const db = createDatabase({ adapter: postgres({ connectionString: LOCAL_URL, max: 4 }) });
    await db.query(sql`create schema if not exists ${sql.identifier(`r2_${name}`)}`);
    await db.query(
      sql`create table if not exists ${sql.identifier(`r2_${name}`)}.${sql.identifier('events')} (
        id integer primary key,
        value text not null,
        updated_at timestamptz not null default now()
      )`,
    );
    return {
      db,
      cleanup: async () => {
        await db.query(sql`drop schema if exists ${sql.identifier(`r2_${name}`)} cascade`);
        await db.close();
      },
    };
  }

  async function targetIds(db: Database, schema: string): Promise<number[]> {
    const rows = await db.query<{ id: number }>(
      sql`select id from ${sql.identifier(`r2_${schema}`)}.events order by id`,
    );
    return rows.rows.map((r) => r.id);
  }

  it('REGRESSION R2-9: a NON-UNIQUE orderBy fails with CONTRACT BEFORE any write (batch 2 AND batch 1, page-boundary ties)', async () => {
    const a = await makeSide('nonuni_a');
    const b = await makeSide('nonuni_b');
    try {
      // Three rows share the same updated_at; page boundaries fall inside the
      // duplicate group — including with batchSize 1, where no within-page
      // duplicate can ever be observed. The preflight must refuse this.
      await a.db.query(
        sql`insert into r2_nonuni_a.events (id, value, updated_at) values
          (1, 'v1', '2026-01-01T00:00:01Z'),
          (2, 'v2', '2026-01-01T00:00:01Z'),
          (3, 'v3', '2026-01-01T00:00:01Z'),
          (4, 'v4', '2026-01-01T00:00:02Z')`,
      );

      for (const batchSize of [2, 1]) {
        const source = createSqlSource({
          db: a.db, table: ['r2_nonuni_a', 'events'], orderBy: ['updated_at'], identity: 'r2:src.nonuni',
        });
        const target = createSqlTarget({ db: b.db, table: ['r2_nonuni_b', 'events'], key: ['id'], identity: 'r2:dst.nonuni' });
        const result = await runTransfer(source, target, { batchSize });

        // Fixed behavior: clear failure before any unsafe write — no silent skip.
        expect(result.status).toBe('failed');
        expect(result.error).toBeInstanceOf(SyncError);
        expect((result.error as SyncError).code).toBe('CONTRACT');
        expect(String(result.error)).toMatch(/no unique index/);
        expect(result.rowsWritten).toBe(0);
        expect(await targetIds(b.db, 'nonuni_b')).toEqual([]); // nothing written
      }

      // Adding the unique tie-breaker (the PK) makes the same table transfer fully.
      const source = createSqlSource({
        db: a.db, table: ['r2_nonuni_a', 'events'], orderBy: ['updated_at', 'id'], identity: 'r2:src.nonuni',
      });
      const target = createSqlTarget({ db: b.db, table: ['r2_nonuni_b', 'events'], key: ['id'], identity: 'r2:dst.nonuni' });
      const ok = await runTransfer(source, target, { batchSize: 1 });
      expect(ok.status).toBe('completed');
      expect(ok.rowsWritten).toBe(4);
      expect(await targetIds(b.db, 'nonuni_b')).toEqual([1, 2, 3, 4]);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('R2-10 (characterization, now documented): incremental sync misses late commits with an older updated_at', async () => {
    // This remains truthful current behavior — it is an honest LIMIT of
    // cursor-based incremental sync, now stated in coordination/v3-sync-workflows.md
    // §1 and the sync types header: rows that become visible AFTER a run read past
    // their position (late commits, backfills, clock-skewed writers) are
    // permanently missed by later incremental runs; repair with a full re-copy
    // (startFrom: 'beginning' into an upsert target) or CDC (not implemented).
    const a = await makeSide('late_a');
    const b = await makeSide('late_b');
    try {
      await a.db.query(
        sql`insert into r2_late_a.events (id, value, updated_at) values
          (1, 'v1', '2026-01-01T00:00:01Z'),
          (2, 'v2', '2026-01-01T00:00:02Z'),
          (3, 'v3', '2026-01-01T00:00:03Z')`,
      );
      const source = createSqlSource({
        db: a.db,
        table: ['r2_late_a', 'events'],
        orderBy: ['updated_at', 'id'], // the report's recommended incremental shape
        identity: 'r2:src.late',
      });
      const target = createSqlTarget({ db: b.db, table: ['r2_late_b', 'events'], key: ['id'], identity: 'r2:dst.late' });
      const store = createMemoryCheckpointStore();

      const first = await runTransfer(source, target, { batchSize: 10, checkpointStore: store });
      expect(first.rowsWritten).toBe(3);

      // A transaction that committed late (or a backfill) lands a row whose
      // updated_at is OLDER than the stored cursor.
      await a.db.query(
        sql`insert into r2_late_a.events (id, value, updated_at) values (4, 'v4', '2026-01-01T00:00:02Z')`,
      );

      const second = await runTransfer(source, target, { batchSize: 10, checkpointStore: store });
      expect(second.rowsRead).toBe(0);
      expect(await targetIds(b.db, 'late_b')).toEqual([1, 2, 3]);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('REGRESSION R2-11: sub-millisecond timestamps get an EXACT cursor — the run completes and resumes precisely', async () => {
    const a = await makeSide('subms_a');
    const b = await makeSide('subms_b');
    try {
      await a.db.query(
        sql`insert into r2_subms_a.events (id, value, updated_at) values
          (1, 'v1', '2026-01-01 00:00:00.000001+00'),
          (2, 'v2', '2026-01-01 00:00:00.000002+00'),
          (3, 'v3', '2026-01-01 00:00:00.000003+00')`,
      );
      const source = createSqlSource({
        db: a.db,
        table: ['r2_subms_a', 'events'],
        orderBy: ['updated_at', 'id'],
        identity: 'r2:src.subms',
      });
      const target = createSqlTarget({ db: b.db, table: ['r2_subms_b', 'events'], key: ['id'], identity: 'r2:dst.subms' });
      const store = createMemoryCheckpointStore();

      // Fixed behavior: the cursor preserves FULL microsecond precision
      // (exact SQL projection), so no stall and no failed resume.
      const first = await runTransfer(source, target, { batchSize: 10, checkpointStore: store });
      expect(first.status).toBe('completed');
      expect(first.exhausted).toBe(true);
      expect(first.batches).toBe(1);
      expect(first.rowsWritten).toBe(3);
      expect(first.lastCursor).toBe(JSON.stringify(['2026-01-01 00:00:00.000003+00', '3']));
      expect(await store.get('dbsdk.sync:v1:["r2:src.subms","r2:dst.subms"]')).toBe(
        JSON.stringify(['2026-01-01 00:00:00.000003+00', '3']),
      );

      // Resume from the exact cursor: 0 rows re-read (no oscillation, no stall).
      const second = await runTransfer(source, target, { batchSize: 10, checkpointStore: store });
      expect(second.status).toBe('completed');
      expect(second.exhausted).toBe(true);
      expect(second.rowsRead).toBe(0);
      expect(second.batches).toBe(0);

      // A later row with a LATER microsecond timestamp is picked up incrementally.
      await a.db.query(
        sql`insert into r2_subms_a.events (id, value, updated_at) values (4, 'v4', '2026-01-01 00:00:00.000004+00')`,
      );
      const third = await runTransfer(source, target, { batchSize: 10, checkpointStore: store });
      expect(third.rowsRead).toBe(1);
      expect(third.rowsWritten).toBe(1);
      expect(await targetIds(b.db, 'subms_b')).toEqual([1, 2, 3, 4]);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('invalid restored checkpoints fail loudly into a TransferResult with zero writes', async () => {
    const a = await makeSide('restore_a');
    const b = await makeSide('restore_b');
    try {
      await a.db.query(
        sql`insert into r2_restore_a.events (id, value) values (1, 'v1'), (2, 'v2'), (3, 'v3'), (4, 'v4'), (5, 'v5')`,
      );
      const source = createSqlSource({ db: a.db, table: ['r2_restore_a', 'events'], orderBy: ['id'], identity: 'r2:src.restore' });
      const target = createSqlTarget({ db: b.db, table: ['r2_restore_b', 'events'], key: ['id'], identity: 'r2:dst.restore' });

      // Shape-invalid checkpoints: rejected by cursor decoding, before any SQL.
      for (const bad of ['not json at all', '[1,2]', '[null]']) {
        const store = createMemoryCheckpointStore({ 'r2-review-key': bad });
        const result = await runTransfer(source, target, {
          checkpointStore: store,
          checkpointKey: 'r2-review-key',
          batchSize: 2,
        });
        expect(result.status).toBe('failed');
        expect(result.error).toBeInstanceOf(SyncError);
        expect((result.error as SyncError).code).toBe('CONFIGURATION');
        expect(result.rowsWritten).toBe(0);
      }

      // A shape-VALID cursor with a nonsensical value passes decode (it is just a
      // JSON string) and becomes a bound parameter — the database itself rejects
      // it, and the underlying DbError is surfaced as-is (not rewritten).
      const store = createMemoryCheckpointStore({ 'r2-review-key': '["2026-13-99"]' });
      const result = await runTransfer(source, target, {
        checkpointStore: store,
        checkpointKey: 'r2-review-key',
        batchSize: 2,
      });
      expect(result.status).toBe('failed');
      expect(result.error).not.toBeInstanceOf(SyncError); // provider error passed through
      expect(String(result.error)).toMatch(/invalid input syntax/i);
      expect(result.rowsWritten).toBe(0);

      expect(await targetIds(b.db, 'restore_b')).toEqual([]); // nothing written on bad checkpoints
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('a valid restored checkpoint resumes exactly (no re-read of committed rows)', async () => {
    const a = await makeSide('resume_a');
    const b = await makeSide('resume_b');
    try {
      await a.db.query(
        sql`insert into r2_resume_a.events (id, value) values (1, 'v1'), (2, 'v2'), (3, 'v3'), (4, 'v4'), (5, 'v5')`,
      );
      const source = createSqlSource({ db: a.db, table: ['r2_resume_a', 'events'], orderBy: ['id'], identity: 'r2:src.resume' });
      const target = createSqlTarget({ db: b.db, table: ['r2_resume_b', 'events'], key: ['id'], identity: 'r2:dst.resume' });
      const store = createMemoryCheckpointStore({ 'r2-review-key': JSON.stringify([2]) });

      const result = await runTransfer(source, target, {
        checkpointStore: store,
        checkpointKey: 'r2-review-key',
        batchSize: 2,
      });
      expect(result.status).toBe('completed');
      expect(result.exhausted).toBe(true);
      expect(result.rowsWritten).toBe(3);
      expect(await targetIds(b.db, 'resume_b')).toEqual([3, 4, 5]);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('duplicate keys within one batch fail loudly on real PostgreSQL (no silent rewrite)', async () => {
    const b = await makeSide('dupkey_b');
    try {
      const target = createSqlTarget({ db: b.db, table: ['r2_dupkey_b', 'events'], key: ['id'], identity: 'r2:dst.dupkey' });
      await expect(
        target.write([
          { id: 1, value: 'a' },
          { id: 1, value: 'b' },
        ]),
      ).rejects.toThrow(/affect row a second time|on conflict/i);
      expect(await targetIds(b.db, 'dupkey_b')).toEqual([]);
    } finally {
      await b.cleanup();
    }
  });
});
