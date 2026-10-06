/**
 * `runTransfer` semantics — offline, fully deterministic in-memory sources/targets.
 *
 * These tests prove the crash-safety contract of coordination/v3-sync-workflows.md §1:
 *  - a cursor advances only after the target write resolves;
 *  - crash before commit → batch re-read and re-applied (nothing lost, cursor intact);
 *  - crash after commit before checkpoint → batch re-applied idempotently
 *    (no duplicates, no loss) and `lastCursor` reports the truth;
 *  - cursors are monotonic; stalls and null cursors on non-empty pages are errors;
 *  - cancellation is cooperative and leaves the checkpoint intact;
 *  - non-idempotent targets require explicit acknowledgement;
 *  - progress payloads carry counts only, never row data.
 */

import { describe, expect, it } from 'vitest';

import { createMemoryCheckpointStore, runTransfer } from '../../src/sync/core.js';
import { SyncError, isSyncError } from '../../src/sync/errors.js';
import type {
  CheckpointStore,
  SyncSource,
  SyncTarget,
  TransferProgress,
  TransferResult,
} from '../../src/sync/types.js';

type Row = { id: number };
type Page<RowType> = { rows: RowType[]; cursor: string | null };

/** A scripted source: returns the page for the given incoming cursor. */
function sourceFromPages<RowType>(
  pages: Record<string, Page<RowType>>,
  identity = 'src',
): SyncSource<RowType> & { seen: (string | null)[] } {
  const seen: (string | null)[] = [];
  return {
    identity,
    ordering: 'ordered',
    seen,
    async read(cursor) {
      seen.push(cursor);
      const page = pages[cursor ?? 'first'];
      if (!page) throw new Error(`no scripted page for cursor ${JSON.stringify(cursor)}`);
      return { rows: [...page.rows], cursor: page.cursor };
    },
  };
}

/** Upsert-style target: Map keyed by id, so re-applied batches converge. */
function upsertTarget<RowType extends { id: number }>(
  store = new Map<number, RowType>(),
  identity = 'dst',
): SyncTarget<RowType> & { writes: RowType[][] } {
  const writes: RowType[][] = [];
  return {
    identity,
    writeMode: 'upsert',
    writes,
    async write(rows) {
      writes.push(rows.map((row) => ({ ...row })));
      for (const row of rows) store.set(row.id, row);
      return { written: rows.length };
    },
  };
}

function spyStore(): CheckpointStore & { values: Map<string, string>; sets: string[] } {
  const values = new Map<string, string>();
  const sets: string[] = [];
  return {
    values,
    sets,
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      sets.push(value);
      values.set(key, value);
    },
  };
}

function expectFailed(result: TransferResult): void {
  expect(result.status).toBe('failed');
  expect(result.error).toBeDefined();
}

describe('runTransfer — basic transfer', () => {
  it('transfers all pages, advances cursors monotonically, reports counts', async () => {
    const source = sourceFromPages<Row>({
      first: { rows: [{ id: 1 }, { id: 2 }], cursor: 'c1' },
      c1: { rows: [{ id: 3 }], cursor: 'c2' },
      c2: { rows: [], cursor: null },
    });
    const target = upsertTarget<Row>();
    const progress: TransferProgress[] = [];

    const result = await runTransfer(source, target, {
      batchSize: 2,
      onProgress: (p) => progress.push(p),
    });

    expect(result.status).toBe('completed');
    expect(result.exhausted).toBe(true);
    expect(result.batches).toBe(2);
    expect(result.rowsRead).toBe(3);
    expect(result.rowsWritten).toBe(3);
    expect(result.rowsSkipped).toBe(0);
    expect(result.lastCursor).toBe('c2');
    // The source never saw a stale cursor: pages strictly advance.
    expect(source.seen).toEqual([null, 'c1', 'c2']);
    expect(target.writes.map((w) => w.map((r) => r.id))).toEqual([[1, 2], [3]]);
    expect(progress.map((p) => p.batches)).toEqual([1, 2]);
    // Progress carries counts only — never row data.
    expect(JSON.stringify(progress)).not.toContain('"id"');
  });

  it('map transforms rows and skips null mappings; empty mapped batches skip the write', async () => {
    const source = sourceFromPages<{
      a: number;
      b: string;
      drop: boolean;
    }>({
      first: {
        rows: [
          { a: 1, b: 'x', drop: true },
          { a: 2, b: 'y', drop: false },
        ],
        cursor: 'c1',
      },
      c1: { rows: [{ a: 3, b: 'z', drop: true }], cursor: 'c2' },
      c2: { rows: [], cursor: null },
    });
    const target = upsertTarget<{ id: number; value: string }>();

    const result = await runTransfer(source, target, {
      batchSize: 10,
      map: (row) => (row.drop ? null : { id: row.a, value: row.b }),
    });

    expect(result.status).toBe('completed');
    expect(result.rowsRead).toBe(3);
    expect(result.rowsWritten).toBe(1);
    expect(result.rowsSkipped).toBe(2);
    // The page whose rows all map to null: no write call at all, cursor still advances.
    expect(target.writes).toEqual([[{ id: 2, value: 'y' }]]);
    expect(source.seen).toEqual([null, 'c1', 'c2']);
    expect(result.lastCursor).toBe('c2');
  });

  it('an empty source completes without any write', async () => {
    const source = sourceFromPages<Row>({ first: { rows: [], cursor: null } });
    const target = upsertTarget<Row>();
    const result = await runTransfer(source, target);
    expect(result.status).toBe('completed');
    expect(result.exhausted).toBe(true);
    expect(result.batches).toBe(0);
    expect(target.writes.length).toBe(0);
    expect(result.lastCursor).toBe(null);
  });
});

describe('runTransfer — idempotency gate', () => {
  it('refuses a non-upsert target without explicit acknowledgement, before dispatch', async () => {
    const source = sourceFromPages<Row>({ first: { rows: [{ id: 1 }], cursor: 'c1' } });
    const target: SyncTarget<Row> = {
      identity: 'dst',
      writeMode: 'replace',
      async write(rows) {
        return { written: rows.length };
      },
    };
    await expect(runTransfer(source, target)).rejects.toMatchObject({
      name: 'SyncError',
      code: 'CONFIGURATION',
    });
    // Refused before dispatch: the source was never read.
    expect(source.seen).toEqual([]);
  });

  it('rejects a malformed target (missing writeMode) at construction', async () => {
    const source = sourceFromPages<Row>({ first: { rows: [], cursor: null } });
    const target = { identity: 'dst', write: async () => ({ written: 0 }) };
    await expect(runTransfer(source, target as unknown as SyncTarget<Row>)).rejects.toMatchObject({
      name: 'SyncError',
      code: 'CONFIGURATION',
    });
  });

  it('runs against a non-upsert target when acknowledged explicitly', async () => {
    const source = sourceFromPages<Row>({ first: { rows: [{ id: 1 }], cursor: 'c1' }, c1: { rows: [], cursor: null } });
    const target: SyncTarget<Row> = {
      identity: 'dst',
      writeMode: 'replace',
      async write(rows) {
        return { written: rows.length };
      },
    };
    const result = await runTransfer(source, target, { acknowledgeNonIdempotentTarget: true });
    expect(result.status).toBe('completed');
    expect(result.rowsWritten).toBe(1);
  });

  it('validates batchSize', async () => {
    const source = sourceFromPages<Row>({ first: { rows: [], cursor: null } });
    const target = upsertTarget<Row>();
    for (const batchSize of [0, -1, 1.5, 10_001]) {
      await expect(runTransfer(source, target, { batchSize })).rejects.toMatchObject({
        name: 'SyncError',
        code: 'CONFIGURATION',
      });
    }
  });
});

describe('runTransfer — crash semantics', () => {
  it('crash BEFORE target commit: cursor not advanced, rerun re-reads the same batch', async () => {
    const store = spyStore();
    const source = sourceFromPages<Row>({
      first: { rows: [{ id: 1 }, { id: 2 }], cursor: 'c1' },
      c1: { rows: [{ id: 3 }], cursor: 'c2' },
      c2: { rows: [], cursor: null },
    });
    let writesDone = 0;
    const target: SyncTarget<Row> & { written: Row[] } = {
      identity: 'dst',
      writeMode: 'upsert',
      written: [],
      async write(rows) {
        writesDone += 1;
        if (writesDone === 1) throw new Error('simulated crash before commit');
        target.written.push(...rows);
        return { written: rows.length };
      },
    };

    const first = await runTransfer(source, target, { batchSize: 2, checkpointStore: store });
    expectFailed(first);
    // Nothing committed, nothing checkpointed, resume point truthful.
    expect(store.values.size).toBe(0);
    expect(first.lastCursor).toBe(null);
    expect(source.seen).toEqual([null]);

    // Rerun resumes from the (absent) checkpoint → re-reads the SAME first batch.
    const second = await runTransfer(source, target, { batchSize: 2, checkpointStore: store });
    expect(second.status).toBe('completed');
    expect(second.rowsWritten).toBe(3);
    // The first batch was delivered exactly once, on the rerun — no loss, no gap.
    expect(target.written.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('crash AFTER commit BEFORE checkpoint: rerun re-applies the batch idempotently', async () => {
    const source = sourceFromPages<Row>({
      first: { rows: [{ id: 1 }, { id: 2 }], cursor: 'c1' },
      c1: { rows: [], cursor: null },
    });
    const backing = new Map<number, Row>();
    const target = upsertTarget<Row>(backing);

    // First run: the write succeeds, then checkpoint persistence crashes.
    let setAttempts = 0;
    const durableStore = spyStore();
    const failingStore: CheckpointStore = {
      async get() {
        return durableStore.get('k');
      },
      async set(key, value) {
        setAttempts += 1;
        if (setAttempts === 1) throw new Error('simulated crash after commit, before checkpoint');
        await durableStore.set(key, value);
      },
    };
    const first = await runTransfer(source, target, { batchSize: 10, checkpointStore: failingStore });
    expectFailed(first);
    expect(first.rowsWritten).toBe(2);
    expect(first.lastCursor).toBe('c1'); // truthful: the batch IS committed on the target
    expect(setAttempts).toBe(1);
    expect(durableStore.values.size).toBe(0); // the checkpoint never landed

    // Rerun from the (empty) durable store: the same batch is re-read and re-applied.
    const second = await runTransfer(source, target, { batchSize: 10, checkpointStore: durableStore });
    expect(second.status).toBe('completed');
    expect(target.writes.length).toBe(2); // batch applied twice...
    // ...but the upsert converges: same ids, no duplicates, no loss.
    expect(backing.size).toBe(2);
    expect([...backing.keys()].sort()).toEqual([1, 2]);
    expect(second.rowsWritten).toBe(2);
    expect(durableStore.values.get('dbsdk.sync:v1:["src","dst"]')).toBe('c1');
  });

  it('checkpoint failure reports the committed cursor; a later rerun stays safe', async () => {
    const source = sourceFromPages<Row>({
      first: { rows: [{ id: 1 }], cursor: 'c1' },
      c1: { rows: [], cursor: null },
    });
    let setCalls = 0;
    const flakyStore: CheckpointStore = {
      async get() {
        return null;
      },
      async set() {
        setCalls += 1;
        if (setCalls === 1) throw new Error('checkpoint backend down');
      },
    };
    const target = upsertTarget<Row>();
    const first = await runTransfer(source, target, { checkpointStore: flakyStore });
    expectFailed(first);
    expect(first.error).toBeInstanceOf(Error);
    expect(first.lastCursor).toBe('c1'); // committed; resume point is truthful
    expect(target.writes.length).toBe(1);

    // The crash happened after commit: a rerun (new store, still empty) re-applies
    // the same batch via upsert — idempotent, reported honestly.
    const second = await runTransfer(source, target, { checkpointStore: flakyStore });
    expect(second.status).toBe('completed');
    expect(target.writes.length).toBe(2);
  });
});

describe('runTransfer — source contract guards', () => {
  it('rejects rows with a null cursor instead of stopping silently', async () => {
    const source = sourceFromPages<Row>({ first: { rows: [{ id: 1 }], cursor: null } });
    const target = upsertTarget<Row>();
    const result = await runTransfer(source, target);
    expectFailed(result);
    expect(isSyncError(result.error)).toBe(true);
    expect((result.error as SyncError).code).toBe('CONTRACT');
    // Nothing was written on a contract violation.
    expect(target.writes.length).toBe(0);
  });

  it('detects a stalled cursor (same non-null cursor twice) instead of looping forever', async () => {
    let calls = 0;
    const source: SyncSource<Row> = {
      identity: 'src',
      ordering: 'ordered',
      async read(cursor) {
        calls += 1;
        void cursor;
        return { rows: [{ id: 1 }], cursor: 'stuck' }; // never advances
      },
    };
    const target = upsertTarget<Row>();
    const result = await runTransfer(source, target, { batchSize: 10 });
    expectFailed(result);
    expect(isSyncError(result.error)).toBe(true);
    expect((result.error as SyncError).code).toBe('CONTRACT');
    expect(calls).toBeLessThanOrEqual(2); // first page ok, second page detects the stall
    expect(target.writes.length).toBe(1); // the first batch was committed before the stall
  });

  it('rejects a source that returns a non-array rows field', async () => {
    const source: SyncSource<Row> = {
      identity: 'src',
      ordering: 'ordered',
      async read() {
        return { rows: undefined as never, cursor: 'c1' };
      },
    };
    const result = await runTransfer(source, upsertTarget<Row>());
    expectFailed(result);
    expect(isSyncError(result.error)).toBe(true);
  });

  it('propagates read failures as failed runs with the original error', async () => {
    const boom = new Error('source down');
    const source: SyncSource<Row> = {
      identity: 'src',
      ordering: 'ordered',
      async read() {
        throw boom;
      },
    };
    const result = await runTransfer(source, upsertTarget<Row>());
    expectFailed(result);
    expect(result.error).toBe(boom);
  });
});

describe('runTransfer — cancellation', () => {
  it('aborts between batches, keeps the checkpoint, and reports the resume point', async () => {
    const store = spyStore();
    const controller = new AbortController();
    const source = sourceFromPages<Row>({
      first: { rows: [{ id: 1 }], cursor: 'c1' },
      c1: { rows: [{ id: 2 }], cursor: 'c2' },
      c2: { rows: [{ id: 3 }], cursor: 'c3' },
      c3: { rows: [], cursor: null },
    });
    const target = upsertTarget<Row>();

    const result = await runTransfer(source, target, {
      batchSize: 1,
      checkpointStore: store,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.batches >= 1) controller.abort();
      },
    });

    expect(result.status).toBe('aborted');
    expect(result.batches).toBe(1);
    expect(result.rowsWritten).toBe(1);
    expect(result.lastCursor).toBe('c1');
    expect(store.values.get('dbsdk.sync:v1:["src","dst"]')).toBe('c1');
    // The abort is checked before the next read, so only the first page was read.
    expect(source.seen).toEqual([null]);
    expect(target.writes.map((w) => w.map((r) => r.id))).toEqual([[1]]);

    // Resuming (without the abort signal) completes the transfer with no loss.
    const resumed = await runTransfer(source, target, { batchSize: 1, checkpointStore: store });
    expect(resumed.status).toBe('completed');
    expect(resumed.rowsWritten).toBe(2);
    expect(target.writes.map((w) => w.map((r) => r.id))).toEqual([[1], [2], [3]]);
  });

  it('reports a write that throws during abort as aborted, not failed', async () => {
    const controller = new AbortController();
    const source = sourceFromPages<Row>({ first: { rows: [{ id: 1 }], cursor: 'c1' } });
    const target: SyncTarget<Row> = {
      identity: 'dst',
      writeMode: 'upsert',
      async write() {
        controller.abort();
        throw new Error('write cancelled mid-flight');
      },
    };
    const result = await runTransfer(source, target, { signal: controller.signal });
    expect(result.status).toBe('aborted');
    expect(result.lastCursor).toBe(null); // nothing committed
  });

  it('an already-aborted signal completes no work and returns aborted', async () => {
    const source = sourceFromPages<Row>({ first: { rows: [{ id: 1 }], cursor: 'c1' } });
    const target = upsertTarget<Row>();
    const controller = new AbortController();
    controller.abort();
    const result = await runTransfer(source, target, { signal: controller.signal });
    expect(result.status).toBe('aborted');
    expect(result.batches).toBe(0);
    expect(source.seen).toEqual([]);
    expect(target.writes.length).toBe(0);
  });
});

describe('runTransfer — failure-shape contract (R3 regressions)', () => {
  it('a throwing map() returns a failed result; batch not written, checkpoint not advanced', async () => {
    const source = sourceFromPages<Row>({
      first: { rows: [{ id: 1 }, { id: 2 }], cursor: 'c1' },
      c1: { rows: [], cursor: null },
    });
    const target = upsertTarget<Row>();
    const store = spyStore();
    const boom = new Error('bad transform');

    const result = await runTransfer(source, target, {
      checkpointStore: store,
      map: (row) => {
        if (row.id === 2) throw boom;
        return row;
      },
    });

    expectFailed(result);
    expect(result.error).toBe(boom);
    expect(result.rowsRead).toBe(2); // rows were read before the transform failed
    expect(result.rowsWritten).toBe(0);
    expect(target.writes.length).toBe(0);
    expect(store.values.size).toBe(0);
  });

  it('a throwing onProgress() is best-effort: the run completes', async () => {
    const source = sourceFromPages<Row>({
      first: { rows: [{ id: 1 }], cursor: 'c1' },
      c1: { rows: [], cursor: null },
    });
    const target = upsertTarget<Row>();
    const store = spyStore();
    const result = await runTransfer(source, target, {
      checkpointStore: store,
      onProgress: () => {
        throw new Error('observer crashed');
      },
    });
    expect(result.status).toBe('completed');
    expect(result.rowsWritten).toBe(1);
    expect(store.values.get('dbsdk.sync:v1:["src","dst"]')).toBe('c1');
  });

  it('a throwing checkpointStore.get() returns a failed result with zero dispatch', async () => {
    const source = sourceFromPages<Row>({ first: { rows: [{ id: 1 }], cursor: 'c1' } });
    const target = upsertTarget<Row>();
    const broken: CheckpointStore = {
      get: async () => {
        throw new Error('checkpoint backend unreachable');
      },
      set: async () => {},
    };
    const result = await runTransfer(source, target, { checkpointStore: broken });
    expectFailed(result);
    expect(String(result.error)).toMatch(/checkpoint backend unreachable/);
    expect(source.seen).toEqual([]); // no read dispatched
    expect(target.writes.length).toBe(0);
  });

  it('an invalid write receipt is a CONTRACT failure with the outcome left indeterminate', async () => {
    const source = sourceFromPages<Row>({
      first: { rows: [{ id: 1 }, { id: 2 }], cursor: 'c1' },
      c1: { rows: [], cursor: null },
    });
    const store = spyStore();
    const target: SyncTarget<Row> = {
      identity: 'dst',
      writeMode: 'upsert',
      write: async () => ({ written: 999 }), // inflated: violates 0..rows.length
    };
    const result = await runTransfer(source, target, { checkpointStore: store });
    expectFailed(result);
    expect(isSyncError(result.error)).toBe(true);
    expect((result.error as SyncError).code).toBe('CONTRACT');
    expect(String(result.error)).toMatch(/invalid write receipt/);
    expect(result.lastCursor).toBeNull(); // unknown committed outcome — not advanced
    expect(store.values.size).toBe(0);
    // An undefined receipt is also a violation (no silent fallback to mapped.length).
    const undefinedTarget: SyncTarget<Row> = {
      identity: 'dst',
      writeMode: 'upsert',
      write: async () => ({ written: undefined as unknown as number }),
    };
    const r2 = await runTransfer(source, undefinedTarget, { checkpointStore: spyStore() });
    expectFailed(r2);
    expect(isSyncError(r2.error)).toBe(true);
  });

  it('an oversized page (rows > limit) is refused with CONTRACT before mapping or writing', async () => {
    const source: SyncSource<Row> = {
      identity: 'src',
      ordering: 'ordered',
      async read() {
        return { rows: [{ id: 1 }, { id: 2 }, { id: 3 }], cursor: 'c1' }; // 3 > limit 2
      },
    };
    const target = upsertTarget<Row>();
    const result = await runTransfer(source, target, { batchSize: 2 });
    expectFailed(result);
    expect(isSyncError(result.error)).toBe(true);
    expect((result.error as SyncError).code).toBe('CONTRACT');
    expect(String(result.error)).toMatch(/limit of 2/);
    expect(target.writes.length).toBe(0);
  });

  it('valid receipts in 0..rows.length are accepted (partial receipt allowed)', async () => {
    const source = sourceFromPages<Row>({
      first: { rows: [{ id: 1 }, { id: 2 }], cursor: 'c1' },
      c1: { rows: [], cursor: null },
    });
    // e.g. an onConflict-do-nothing target may legitimately write fewer rows.
    const target: SyncTarget<Row> = {
      identity: 'dst',
      writeMode: 'upsert',
      write: async () => ({ written: 1 }),
    };
    const result = await runTransfer(source, target, { batchSize: 2 });
    expect(result.status).toBe('completed');
    expect(result.rowsWritten).toBe(1); // receipt trusted when within contract
  });
});

describe('runTransfer — resumability controls', () => {
  it('maxBatches pauses a run and a rerun resumes from the checkpoint', async () => {
    const store = spyStore();
    const source = sourceFromPages<Row>({
      first: { rows: [{ id: 1 }], cursor: 'c1' },
      c1: { rows: [{ id: 2 }], cursor: 'c2' },
      c2: { rows: [{ id: 3 }], cursor: 'c3' },
      c3: { rows: [], cursor: null },
    });
    const target = upsertTarget<Row>();

    const paused = await runTransfer(source, target, {
      batchSize: 1,
      maxBatches: 1,
      checkpointStore: store,
    });
    expect(paused.status).toBe('completed');
    expect(paused.exhausted).toBe(false); // source still has rows
    expect(paused.lastCursor).toBe('c1');

    const resumed = await runTransfer(source, target, {
      batchSize: 1,
      checkpointStore: store,
    });
    expect(resumed.status).toBe('completed');
    expect(resumed.exhausted).toBe(true);
    expect(resumed.rowsWritten).toBe(2);
    expect(target.writes.map((w) => w.map((r) => r.id))).toEqual([[1], [2], [3]]);
  });

  it('startFrom: beginning ignores the stored checkpoint', async () => {
    const store = spyStore();
    store.values.set('dbsdk.sync:v1:["src","dst"]', 'c1');
    const source = sourceFromPages<Row>({
      first: { rows: [{ id: 1 }], cursor: 'c1' },
      c1: { rows: [], cursor: null },
    });
    const target = upsertTarget<Row>();
    const result = await runTransfer(source, target, {
      batchSize: 10,
      checkpointStore: store,
      startFrom: 'beginning',
    });
    expect(result.status).toBe('completed');
    // First read starts at the beginning; the second read confirms exhaustion.
    expect(source.seen).toEqual([null, 'c1']);
  });

  it('checkpoint keys use an injective encoding of both identities (no delimiter collisions)', async () => {
    const source = sourceFromPages<Row>(
      {
        first: { rows: [{ id: 1 }], cursor: 'c1' },
        c1: { rows: [], cursor: null },
      },
      'supabase:p1.public.events',
    );
    const target = upsertTarget<Row>(new Map(), 'neon:br-frosty.public.events');
    const store = spyStore();
    await runTransfer(source, target, { checkpointStore: store });
    expect([...store.values.keys()]).toEqual([
      'dbsdk.sync:v1:["supabase:p1.public.events","neon:br-frosty.public.events"]',
    ]);
  });

  it('checkpoint keys do not collide when identities contain the delimiter or quotes', async () => {
    // The old `a->b` format collided: ("alpha","beta->gamma") and
    // ("alpha->beta","gamma") shared one key, so the second transfer silently
    // did nothing while reporting completed. The JSON-array encoding is
    // injective — every pair gets its own key.
    const keys = new Set<string>();
    const pairs: Array<[string, string]> = [
      ['alpha', 'beta->gamma'],
      ['alpha->beta', 'gamma'],
      ['alpha', 'beta'],
      ['->', '->'],
      ['a"b', 'c\\d'],
    ];
    for (const [srcId, dstId] of pairs) {
      const source = sourceFromPages<Row>(
        { first: { rows: [{ id: 1 }], cursor: 'c1' }, c1: { rows: [], cursor: null } },
        srcId,
      );
      const target = upsertTarget<Row>(new Map(), dstId);
      const store = spyStore();
      await runTransfer(source, target, { checkpointStore: store });
      const stored = [...store.values.keys()];
      expect(stored).toHaveLength(1);
      keys.add(stored[0]!);
    }
    expect(keys.size).toBe(pairs.length); // all distinct — injective
  });
});

describe('createMemoryCheckpointStore', () => {
  it('stores and retrieves cursors, isolated per instance', async () => {
    const a = createMemoryCheckpointStore({ 'k': 'v0' });
    const b = createMemoryCheckpointStore();
    expect(await a.get('k')).toBe('v0');
    expect(await b.get('k')).toBe(null);
    await a.set('k', 'v1');
    expect(await a.get('k')).toBe('v1');
    expect(await b.get('k')).toBe(null);
  });
});
