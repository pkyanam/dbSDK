/**
 * pg-engine regressions (review round 1): uncertain outcomes on transaction/batch
 * failures, and closed-state errors surfaced through the `raw` escape hatch.
 */

import { describe, expect, it } from 'vitest';

import { createDatabase } from '../../src/core/database.js';
import { hasUncertainOutcome } from '../../src/errors.js';
import { runLeasedTransaction, type PgPoolConfig } from '../../src/adapters/pg-engine.js';
import { postgres } from '../../src/adapters/postgres.js';
import { FakePool, type FakeBehavior } from './helpers.js';

function engineWith(behavior?: FakeBehavior) {
  const pools: FakePool[] = [];
  const adapter = postgres({
    connectionString: 'postgres://user:pass@localhost:5432/db',
    poolFactory: (config: PgPoolConfig) => {
      const pool = new FakePool(config, behavior);
      pools.push(pool);
      return pool;
    },
  });
  return { adapter, pools };
}

describe('pg-engine uncertain outcomes', () => {
  it('marks a transaction as uncertain when the connection drops before COMMIT completes', async () => {
    const { adapter } = engineWith({
      fail: (text) =>
        text === 'COMMIT' || text === 'ROLLBACK' ? new Error('connection terminated') : undefined,
    });
    const db = createDatabase({ adapter });
    let caught: unknown;
    try {
      await db.transaction(async (tx) => {
        await tx.query('insert into t values ($1)', [1]);
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ indeterminate: true });
    // The write may or may not have committed; nothing is retried automatically.
    expect((caught as { retryable?: boolean }).retryable).toBe(false);
  });

  it('does not mark an application error with a confirmed rollback as uncertain', async () => {
    const { adapter, pools } = engineWith();
    const failure = new Error('rollback me');
    let thrown: unknown;
    try {
      await adapter.transaction!(async () => {
        throw failure;
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
    expect(hasUncertainOutcome(failure)).toBe(false);
    // BEGIN, ROLLBACK, and a clean client release.
    expect(pools[0]!.clientQueries(1).map((q) => q.text)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(pools[0]!.clients[0]!.released).toBe(true);
  });

  it('marks a batch as uncertain when the rollback cannot confirm the outcome', async () => {
    const { adapter } = engineWith({
      fail: (text) =>
        text === 'COMMIT' || text === 'ROLLBACK' ? new Error('connection terminated') : undefined,
    });
    const db = createDatabase({ adapter });
    let caught: unknown;
    try {
      await db.batch([
        { text: 'insert into t values ($1)', params: [1] },
        { text: 'update t set x = 1' },
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ indeterminate: true });
  });

  it('still marks server-side failures deterministically (rollback confirms the outcome)', async () => {
    const { adapter } = engineWith({
      fail: (text) =>
        text.startsWith('insert')
          ? Object.assign(new Error('null value in column violates not-null'), { code: '23502' })
          : undefined,
    });
    const db = createDatabase({ adapter });
    let caught: unknown;
    try {
      await db.transaction(async (tx) => {
        await tx.query('insert into t values ($1)', [1]);
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ sqlstate: '23502', indeterminate: false });
  });

  it('runLeasedTransaction marks a COMMIT-failure error directly on the leased client', async () => {
    const { adapter, pools } = engineWith({
      fail: (text) =>
        text === 'COMMIT' || text === 'ROLLBACK' ? new Error('connection terminated') : undefined,
    });
    await adapter.query('select 1'); // create the pool lazily
    const client = await pools[0]!.connect();
    let thrown: unknown;
    try {
      await runLeasedTransaction(client, async (tx) => {
        await tx.query('select 1');
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(hasUncertainOutcome(thrown)).toBe(true);
    expect(client.released).toBe(true);
  });
});

describe('pg-engine closed-state errors', () => {
  it('raw surfaces a DbError after close instead of a plain Error', async () => {
    const { adapter } = engineWith();
    const db = createDatabase({ adapter });
    await db.query({ text: 'select 1' });
    await db.close();
    expect(() => db.raw).toThrowError(/closed/);
    try {
      db.raw;
    } catch (error) {
      expect((error as { name?: string }).name).toBe('DbError');
      expect((error as { code?: string }).code).toBe('CONNECTION');
    }
    // Queries after close also fail cleanly.
    await expect(db.query({ text: 'select 1' })).rejects.toMatchObject({ code: 'CONNECTION' });
  });
});

describe('pg-engine system-errno regressions (round 3): EPIPE is transport, not a SQLSTATE', () => {
  function epipe(): Error {
    return Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  }

  it('a single-query write lost to EPIPE reports no sqlstate, CONNECTION, and indeterminate: true', async () => {
    const { adapter } = engineWith({ fail: () => epipe() });
    const db = createDatabase({ adapter });
    const error = await db.query({ text: 'update t set x = 1' }).catch((e) => e);
    expect(error).toMatchObject({
      code: 'CONNECTION',
      sqlstate: undefined,
      indeterminate: true,
      retryable: true,
    });
  });

  it('a read lost to EPIPE is CONNECTION but not indeterminate', async () => {
    const { adapter } = engineWith({ fail: () => epipe() });
    const db = createDatabase({ adapter });
    const error = await db.query({ text: 'select 1' }).catch((e) => e);
    expect(error).toMatchObject({ code: 'CONNECTION', sqlstate: undefined, indeterminate: false });
  });

  it('an atomic batch COMMIT transport loss with EPIPE and unconfirmable ROLLBACK is indeterminate', async () => {
    const { adapter } = engineWith({
      fail: (text) => (text === 'COMMIT' || text === 'ROLLBACK' ? epipe() : undefined),
    });
    const db = createDatabase({ adapter });
    const error = await db
      .batch([{ text: 'insert into t values ($1)', params: [1] }])
      .catch((e) => e);
    expect(error.sqlstate).toBeUndefined();
    expect(error.indeterminate).toBe(true);
    // The adapter itself marked the outcome unknown before normalization.
    expect(hasUncertainOutcome((error as { cause?: unknown }).cause)).toBe(true);
  });

  it('a server SQLSTATE still wins over a transport errno in the same error', async () => {
    // A driver that reports both (e.g. wrapped server error plus errno) must
    // keep the server classification — the SQLSTATE is the server's word.
    const { adapter } = engineWith({
      fail: () => Object.assign(new Error('db error'), { code: '23505' }),
    });
    const db = createDatabase({ adapter });
    const error = await db.query({ text: 'insert into t values (1)' }).catch((e) => e);
    expect(error).toMatchObject({ code: 'CONSTRAINT', sqlstate: '23505', indeterminate: false });
  });
});

// ---------------------------------------------------------------------------
// Release failures are quiet cleanup (round 4 regression — shared pg-engine)
// ---------------------------------------------------------------------------

describe('pg-engine release failures never mask the primary outcome', () => {
  it('commit ack lost AND release() throws: primary kept, indeterminate TRUE, native cause EXACT', async () => {
    const primary = Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' });
    const { adapter, pools } = engineWith({
      fail: (text) => (text === 'COMMIT' || text === 'ROLLBACK' ? primary : undefined),
      failRelease: true,
    });
    const db = createDatabase({ adapter });
    const error = await db
      .transaction(async (tx) => {
        await tx.query('insert into t values ($1)', [1]);
      })
      .catch((e) => e);
    // The commit was applied server-side but the reply was lost: the uncertain
    // classification must survive the failing cleanup. Before the guard the
    // raw release error replaced it (surfacing as UNKNOWN with no cause).
    expect(error).toMatchObject({ code: 'CONNECTION', indeterminate: true, retryable: true });
    expect((error as { cause?: Error }).cause).toBe(primary);
    expect((error as Error).message).not.toContain('release()');
    // The release was attempted exactly once and never retried/double-called.
    expect(pools[0]!.releasedCount).toBe(1);
    expect(pools[0]!.clients[0]!.released).toBe(true);
    // No write replay.
    expect(pools[0]!.clientQueries(1).filter((q) => q.text.startsWith('insert'))).toHaveLength(1);
  });

  it('constraint failure with confirmed rollback AND release() throws: proven rejection preserved', async () => {
    const primary = Object.assign(new Error('null value in column violates not-null'), { code: '23502' });
    const { adapter, pools } = engineWith({
      fail: (text) => (text.startsWith('insert') ? primary : undefined),
      failRelease: true,
    });
    const db = createDatabase({ adapter });
    const error = await db
      .transaction(async (tx) => {
        await tx.query('insert into t values ($1)', [1]);
      })
      .catch((e) => e);
    expect(error).toMatchObject({ code: 'CONSTRAINT', sqlstate: '23502', indeterminate: false });
    expect((error as { cause?: Error }).cause).toBe(primary);
    expect(pools[0]!.releasedCount).toBe(1);
  });

  it('BEGIN failure AND release() throws: primary preserved, release still attempted once', async () => {
    const primary = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
    });
    const { adapter, pools } = engineWith({
      fail: (text) => (text === 'BEGIN' ? primary : undefined),
      failRelease: true,
    });
    const db = createDatabase({ adapter });
    const error = await db.transaction(async () => 'never').catch((e) => e);
    // Nothing ran, so the outcome is proven; the release failure must not
    // overwrite the SQLSTATE.
    expect(error).toMatchObject({ code: 'CONNECTION', sqlstate: '57P01', indeterminate: false });
    expect((error as { cause?: Error }).cause).toBe(primary);
    expect(pools[0]!.releasedCount).toBe(1);
  });

  it('acknowledged commit AND release() throws: the committed result is returned (quiet cleanup policy)', async () => {
    const { adapter, pools } = engineWith({ failRelease: true });
    const db = createDatabase({ adapter });
    // The COMMIT was acknowledged, so the transaction succeeded; the release
    // failure is pool-side cleanup and must not deny a proven success.
    const result = await db.transaction(async (tx) => {
      await tx.query('insert into t values ($1)', [1]);
      return 'committed';
    });
    expect(result).toBe('committed');
    expect(pools[0]!.releasedCount).toBe(1);
  });

  it('batch constraint failure AND release() throws: proven rejection preserved (batch cleanup)', async () => {
    const primary = Object.assign(new Error('null value in column violates not-null'), { code: '23502' });
    const { adapter, pools } = engineWith({
      fail: (text) => (text.startsWith('insert') ? primary : undefined),
      failRelease: true,
    });
    const db = createDatabase({ adapter });
    const error = await db
      .batch([{ text: 'insert into t values ($1)', params: [1] }])
      .catch((e) => e);
    // Before the guard the raw release error replaced this and it surfaced as
    // UNKNOWN with indeterminate: true — a false uncertainty claim.
    expect(error).toMatchObject({ code: 'CONSTRAINT', sqlstate: '23502', indeterminate: false });
    expect((error as { cause?: Error }).cause).toBe(primary);
    expect(pools[0]!.releasedCount).toBe(1);
  });
});
