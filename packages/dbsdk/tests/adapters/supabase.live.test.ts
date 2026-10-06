/**
 * Supabase adapter live check against local Postgres.
 *
 * The Supabase adapter is the shared pg engine plus config validation, so a
 * local Postgres exercises the full query/transaction path (with
 * `allowModeMismatch: true` because localhost is not a real Supabase host).
 * Gated on DBSDK_TEST_POSTGRES_URL like the other live tests.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { supabase } from '../../src/adapters/supabase.js';

const hasServer = Boolean(process.env.DBSDK_TEST_POSTGRES_URL);
const d = hasServer ? describe : describe.skip;

d('supabase adapter — live local PostgreSQL (transaction mode declared)', () => {
  let db: ReturnType<typeof supabase>;

  beforeAll(() => {
    db = supabase({
      connectionString: process.env.DBSDK_TEST_POSTGRES_URL!,
      connectionMode: 'transaction',
      allowModeMismatch: true,
      ssl: false,
      max: 2,
    });
  });

  afterAll(async () => {
    await db.close();
  });

  it('reports transaction-pooler capabilities honestly', () => {
    expect(db.capabilities).toMatchObject({
      interactiveTransactions: true,
      atomicBatch: true,
      sessionState: false,
      transport: 'tcp',
    });
  });

  it('queries, commits, and rolls back', async () => {
    const q = await db.query<{ one: number }>('select $1::int as one', [1]);
    expect(q.rows[0]!.one).toBe(1);

    const v = await db.transaction!(async (tx) => {
      await tx.query('select 1');
      return 'ok';
    });
    expect(v).toBe('ok');

    const err = new Error('rollback me');
    await expect(
      db.transaction!(async (tx) => {
        await tx.query('select 1');
        throw err;
      }),
    ).rejects.toBe(err);
  });

  it('enforces transaction-pooler session restrictions before dispatch', async () => {
    await expect(db.query('listen test_channel')).rejects.toThrow(/session-level state/);
    // SET LOCAL is allowed even in transaction mode (it is transaction-scoped).
    const setting = await db.transaction!(async (tx) => {
      await tx.query("set local application_name = 'dbsdk_supabase_live'");
      const shown = await tx.query<{ application_name: string }>('show application_name');
      return shown.rows[0]!.application_name;
    });
    expect(setting).toBe('dbsdk_supabase_live');
  });

  it('rejects an empty listen statement pattern but allows plain reads in batch', async () => {
    const results = await db.batch!([
      { text: 'select 1 as a' },
      { text: 'select 2 as b' },
    ]);
    expect(results).toHaveLength(2);
  });
});
