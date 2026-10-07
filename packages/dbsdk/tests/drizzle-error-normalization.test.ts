/**
 * Drizzle bridge error normalization — the R2 fix for the user critique:
 * "Queries run through Drizzle return Drizzle's native errors, not dbSDK's
 * normalized ones, so the indeterminate-write handling doesn't carry over."
 *
 * Every test pairs a drizzle-bridge call with the equivalent core call
 * (`db.sql` / `db.query` / `db.transaction`) over the SAME fixture, and
 * compares the PUBLIC error field-by-field using the existing DbError contract
 * (code / sqlstate / retryable / indeterminate / adapterId / cause). Before
 * this fix the drizzle path threw Drizzle's `DrizzleQueryError` with no
 * classification and no indeterminate-write marking at all.
 *
 * Offline suites use deterministic fixture drivers (a pool-shaped recorder
 * with injectable failures and an independent observer that records what the
 * "server" actually applied). Real-database cases (constraint violations,
 * success regressions) run against local PostgreSQL gated on
 * DBSDK_TEST_POSTGRES_URL:
 *
 *   DBSDK_TEST_POSTGRES_URL=postgresql://postgres:dbsdk@localhost:15432/dbsdk \
 *     npx vitest run tests/drizzle-error-normalization.test.ts
 *
 * Fault injection is fixture-only: no third-party service, no network faulting.
 */

import { Client, Pool } from 'pg';
import { eq, relations, sql as dsql } from 'drizzle-orm';
import { integer, pgSchema, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/core/database.js';
import { DbError, isDbError, isWriteStatement } from '../src/errors.js';
import type { Database, DatabaseAdapter, DatabaseAdapterCapabilities, QueryExecutor, QueryResult } from '../src/types.js';
import { postgres } from '../src/adapters/postgres.js';
import { neon, type NeonHttpQueryFn, type NeonRaw } from '../src/adapters/neon.js';
import type { PgPoolLike, PgQueryOutput } from '../src/adapters/pg-engine.js';
import { drizzleNeonHttp, drizzlePostgres } from '../src/drizzle-interop/index.js';

const LOCAL_URL = process.env.DBSDK_TEST_POSTGRES_URL ?? 'postgresql://postgres:dbsdk@localhost:15432/dbsdk';
const hasServer = Boolean(process.env.DBSDK_TEST_POSTGRES_URL);
const d = hasServer ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Fixtures: a pool recorder with injectable failures and a server-side observer
// ---------------------------------------------------------------------------

type TransportError = Error & { code: string };

/** A server-reported pg error (SQLSTATE on `code`, plus detail fields). */
type PgServerError = TransportError & {
  severity?: string;
  detail?: string;
  constraint?: string;
  table?: string;
};

function connectionReset(): TransportError {
  // Shape of a real node-postgres socket failure (no server SQLSTATE).
  return Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) as TransportError;
}

function serverConstraintError(constraint: string): PgServerError {
  // Shape of a real pg DatabaseError for a unique violation.
  const error = new Error(`duplicate key value violates unique constraint "${constraint}"`) as TransportError;
  Object.assign(error, {
    name: 'error',
    severity: 'ERROR',
    code: '23505',
    detail: 'Key (email)=(ada@example.com) already exists.',
    constraint,
    table: 'users',
  });
  return error;
}

/** True when the fake error is a server-reported SQLSTATE (proven outcome). */
function isServerRejection(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && !code.startsWith('E');
}

/** A server-reported FATAL admin shutdown (real pg shape: SQLSTATE 57P01). */
function adminShutdown(): PgServerError {
  const error = new Error('terminating connection due to administrator command') as TransportError;
  Object.assign(error, { name: 'error', severity: 'FATAL', code: '57P01' });
  return error;
}

/**
 * Pool recorder matching what the stable drizzle session calls
 * (`query(config, values)` with `rowMode`, `connect()` for transactions).
 * `behavior` runs where the server would: it can record an applied write in
 * the independent observer BEFORE throwing (simulating "executed, reply lost")
 * or reject with a server error.
 */
class FaultPool implements PgPoolLike {
  readonly dispatched: string[] = [];
  readonly appliedWrites: string[] = [];
  releaseCount = 0;
  /** When true, `release()` itself throws after recording the attempt (round 4). */
  failRelease = false;
  private ended = false;

  constructor(private readonly behavior: (text: string) => Error | undefined) {}

  async query(config: { text: string; values?: unknown[]; name?: string; rowMode?: string }): Promise<PgQueryOutput> {
    if (this.ended) throw new Error('Cannot use a pool after calling end on the pool');
    this.dispatched.push(config.text);
    const failure = this.behavior(config.text);
    if (failure) {
      // Server-side simulation: a write-shaped statement without a server
      // SQLSTATE means the statement ran and the reply was lost (applied);
      // a 5-digit SQLSTATE is a proven server rejection (nothing applied).
      if (isWriteStatement(config.text) && !isServerRejection(failure)) this.appliedWrites.push(config.text);
      throw failure;
    }
    if (/^select/i.test(config.text)) {
      return { rows: [[7, 'ada@example.com']], rowCount: 1, command: 'SELECT' };
    }
    return { rows: [], rowCount: 0, command: 'INSERT' };
  }

  async connect() {
    const pool = this;
    return {
      async query(config: { text: string; values?: unknown[] }): Promise<PgQueryOutput> {
        pool.dispatched.push(config.text);
        const failure = pool.behavior(config.text);
        if (failure) {
          // COMMIT applied server-side, then the reply was lost.
          if (/^COMMIT$/i.test(config.text)) pool.appliedWrites.push('COMMIT');
          if (isWriteStatement(config.text) && !isServerRejection(failure)) pool.appliedWrites.push(config.text);
          throw failure;
        }
        return { rows: [], rowCount: 0, command: 'BEGIN' };
      },
      release() {
        pool.releaseCount += 1;
        // The attempt is always recorded first, mirroring pg-pool's
        // throwOnDoubleRelease (state updated, then it throws).
        if (pool.failRelease) throw new Error('release() failed (socket already gone)');
      },
    };
  }

  async end() {
    this.ended = true;
  }
}

function adapterWithPool(pool: PgPoolLike, id = 'fault-pg'): DatabaseAdapter<PgPoolLike> {
  const capabilities: DatabaseAdapterCapabilities = {
    interactiveTransactions: true,
    atomicBatch: true,
    sessionState: true,
    transport: 'tcp',
    evidence: {},
  };
  // Fixture rows are untyped by nature; the cast only bridges the fixture's
  // unknown[] rows into the adapter contract's Row[] generic.
  return {
    id,
    engine: 'postgresql',
    capabilities,
    raw: pool,
    async query<Row>(text: string, params?: readonly unknown[]): Promise<QueryResult<Row>> {
      const result = await pool.query({ text, ...(params ? { values: [...params] } : {}) });
      return { rows: result.rows as Row[], rowCount: result.rowCount } as QueryResult<Row>;
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query({ text: 'BEGIN' });
        const value = await fn({
          query: async <Row>(text: string, params?: readonly unknown[]) => {
            const result = await client.query({ text, ...(params ? { values: [...params] } : {}) });
            return { rows: result.rows as Row[], rowCount: result.rowCount } as QueryResult<Row>;
          },
        });
        await client.query({ text: 'COMMIT' });
        return value;
      } catch (error) {
        await client.query({ text: 'ROLLBACK' }).catch(() => undefined);
        throw error;
      } finally {
        (client as { release: () => void }).release();
      }
    },
    async close() {},
  };
}

/** Field-by-field comparison of a public error against the DbError contract. */
function errorFields(error: unknown): {
  isDbError: boolean;
  code?: string;
  sqlstate?: string;
  retryable?: boolean;
  indeterminate?: boolean;
  adapterId?: string;
  messageHasParamsEcho: boolean;
  causeIsDrizzleQueryError: boolean;
  causeCode?: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  const causeRecord = (cause ?? {}) as { code?: unknown; query?: unknown; params?: unknown };
  return {
    isDbError: isDbError(error),
    ...(isDbError(error) ? { code: error.code } : {}),
    ...(isDbError(error) ? { sqlstate: error.sqlstate } : {}),
    ...(isDbError(error) ? { retryable: error.retryable } : {}),
    ...(isDbError(error) ? { indeterminate: error.indeterminate } : {}),
    ...(isDbError(error) ? { adapterId: error.adapterId } : {}),
    messageHasParamsEcho: /params:/.test(message),
    causeIsDrizzleQueryError: cause instanceof Error && typeof causeRecord.query === 'string',
    ...(typeof causeRecord.code === 'string' ? { causeCode: causeRecord.code } : {}),
  };
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the promise to reject');
    },
    (error: unknown) => error,
  );
}

// ---------------------------------------------------------------------------
// Statement-level normalization (offline fixtures)
// ---------------------------------------------------------------------------

describe('drizzle bridge — statement errors are normalized like db.sql (offline)', () => {
  const users = pgTable('users', {
    id: serial('id').primaryKey(),
    email: text('email').notNull().unique(),
  });

  it('transport failure after a possibly-committed write: indeterminate DbError, dispatched EXACTLY once', async () => {
    const pool = new FaultPool((text) => (/^insert/i.test(text) ? connectionReset() : undefined));
    const db = createDatabase({ adapter: adapterWithPool(pool) });
    const drizzleDb = await drizzlePostgres(db);

    const drizzleError = await errorOf(drizzleDb.insert(users).values({ email: 'ada@example.com' }));
    expect(errorFields(drizzleError)).toMatchObject({
      isDbError: true,
      code: 'CONNECTION',
      indeterminate: true,
      retryable: true,
      adapterId: 'fault-pg',
      messageHasParamsEcho: false,
      causeIsDrizzleQueryError: false,
    });
    // The native driver error is the cause (with its errno), never Drizzle's wrapper.
    expect((drizzleError as DbError).cause).toBeInstanceOf(Error);
    expect(((drizzleError as DbError).cause as TransportError).code).toBe('ECONNRESET');

    // Independent observer: the write WAS applied server-side, exactly once —
    // and the bridge never retried or replayed it (dispatch count 1).
    expect(pool.appliedWrites).toHaveLength(1);
    expect(pool.dispatched.filter((text) => /^insert/i.test(text))).toHaveLength(1);

    // The equivalent core call classifies identically (field-by-field).
    const pool2 = new FaultPool((text) => (/^insert/i.test(text) ? connectionReset() : undefined));
    const db2 = createDatabase({ adapter: adapterWithPool(pool2) });
    const coreError = await errorOf(db2.query({ text: 'insert into users (email) values ($1)', params: ['ada@example.com'] }));
    const drizzleFields = errorFields(drizzleError);
    const coreFields = errorFields(coreError);
    expect(drizzleFields.code).toBe(coreFields.code);
    expect(drizzleFields.sqlstate).toBe(coreFields.sqlstate);
    expect(drizzleFields.retryable).toBe(coreFields.retryable);
    expect(drizzleFields.indeterminate).toBe(coreFields.indeterminate);
    await db.close();
    await db2.close();
  });

  it('proven server rejection (unique violation): CONSTRAINT, indeterminate false, sqlstate preserved', async () => {
    const pool = new FaultPool((text) => (/^insert/i.test(text) ? serverConstraintError('users_email_key') : undefined));
    const db = createDatabase({ adapter: adapterWithPool(pool) });
    const drizzleDb = await drizzlePostgres(db);

    const drizzleError = await errorOf(drizzleDb.insert(users).values({ email: 'ada@example.com' }));
    expect(errorFields(drizzleError)).toMatchObject({
      isDbError: true,
      code: 'CONSTRAINT',
      sqlstate: '23505',
      indeterminate: false,
      retryable: false,
      messageHasParamsEcho: false,
    });
    const cause = (drizzleError as DbError).cause as PgServerError;
    expect(cause.constraint).toBe('users_email_key');
    expect(cause.detail).toContain('ada@example.com'); // native detail preserved
    // A proven rejection is NOT an unknown outcome: nothing was applied.
    expect(pool.appliedWrites).toHaveLength(0);
    await db.close();
  });

  it('transport failure on a read: not indeterminate (nothing written)', async () => {
    const pool = new FaultPool((text) => (/^select/i.test(text) ? connectionReset() : undefined));
    const db = createDatabase({ adapter: adapterWithPool(pool) });
    const drizzleDb = await drizzlePostgres(db);
    const error = await errorOf(drizzleDb.select().from(users));
    expect(errorFields(error)).toMatchObject({
      isDbError: true,
      code: 'CONNECTION',
      indeterminate: false,
      retryable: true,
    });
    await db.close();
  });

  it('redaction: no params echo and no DrizzleQueryError anywhere in the chain', async () => {
    const secret = 's3cret-value-in-param';
    const pool = new FaultPool((text) => (/^insert/i.test(text) ? connectionReset() : undefined));
    const db = createDatabase({ adapter: adapterWithPool(pool) });
    const drizzleDb = await drizzlePostgres(db);
    const error = await errorOf(drizzleDb.insert(users).values({ email: secret }));
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain('params:');
    // Walk the whole cause chain: no DrizzleQueryError-shaped error remains.
    let current: unknown = error;
    while (current instanceof Error) {
      const record = current as unknown as { query?: unknown; params?: unknown };
      expect(typeof record.query).not.toBe('string');
      current = current.cause;
    }
    await db.close();
  });

  it('pre-dispatch client-side failure: normalized UNKNOWN with no statement context, nothing dispatched', async () => {
    const pool = new FaultPool(() => undefined);
    const db = createDatabase({ adapter: adapterWithPool(pool) });
    const drizzleDb = await drizzlePostgres(db);
    // A placeholder that is never filled: drizzle throws before any dispatch.
    const error = await errorOf(drizzleDb.execute(dsql`select ${dsql.placeholder('missing')}`));
    expect(errorFields(error)).toMatchObject({
      isDbError: true,
      code: 'UNKNOWN',
      indeterminate: false,
      retryable: false,
    });
    expect(pool.dispatched).toHaveLength(0); // refused before any dispatch
    await db.close();
  });

  it('prepared statements and db.execute share the same normalization', async () => {
    const pool = new FaultPool((text) => (/^select/i.test(text) ? connectionReset() : undefined));
    const db = createDatabase({ adapter: adapterWithPool(pool) });
    const drizzleDb = await drizzlePostgres(db);

    const prepared = drizzleDb.select().from(users).prepare('stmt-error');
    const preparedError = await errorOf(prepared.execute());
    expect(errorFields(preparedError)).toMatchObject({ isDbError: true, code: 'CONNECTION', indeterminate: false });

    const executeError = await errorOf(drizzleDb.execute('select * from users'));
    expect(errorFields(executeError)).toMatchObject({ isDbError: true, code: 'CONNECTION', indeterminate: false });
    await db.close();
  });

  it('update and delete statement shapes carry the same write-outcome policy', async () => {
    // Update lost in transport: indeterminate (the update may have applied).
    const updatePool = new FaultPool((text) => (/^update/i.test(text) ? connectionReset() : undefined));
    const updateDb = createDatabase({ adapter: adapterWithPool(updatePool) });
    const drizzleUpdate = await drizzlePostgres(updateDb);
    const updateError = await errorOf(
      drizzleUpdate.update(users).set({ email: 'new@example.com' }).where(eq(users.id, 1)),
    );
    expect(errorFields(updateError)).toMatchObject({ isDbError: true, code: 'CONNECTION', indeterminate: true });
    expect(updatePool.dispatched.filter((text) => /^update/i.test(text))).toHaveLength(1);
    expect(updatePool.appliedWrites).toHaveLength(1);
    await updateDb.close();

    // Delete: proven server rejection (constraint from an ON DELETE rule) is
    // determinate; a lost reply after delete is indeterminate.
    const deletePool = new FaultPool((text) => (/^delete/i.test(text) ? connectionReset() : undefined));
    const deleteDb = createDatabase({ adapter: adapterWithPool(deletePool) });
    const drizzleDelete = await drizzlePostgres(deleteDb);
    const deleteError = await errorOf(drizzleDelete.delete(users).where(eq(users.id, 1)));
    expect(errorFields(deleteError)).toMatchObject({ isDbError: true, code: 'CONNECTION', indeterminate: true });
    expect(deletePool.dispatched.filter((text) => /^delete/i.test(text))).toHaveLength(1);
    await deleteDb.close();
  });
});

// ---------------------------------------------------------------------------
// Transaction normalization (offline fixtures)
// ---------------------------------------------------------------------------

describe('drizzle bridge — transactions carry dbSDK outcome semantics (offline)', () => {
  const users = pgTable('users', {
    id: serial('id').primaryKey(),
    email: text('email').notNull().unique(),
  });

  it('commit ack lost after applied writes: indeterminate TRUE, lease released once, no replay', async () => {
    const pool = new FaultPool((text) => (/^COMMIT$/i.test(text) ? connectionReset() : undefined));
    const db = createDatabase({ adapter: adapterWithPool(pool) });
    const drizzleDb = await drizzlePostgres(db);

    const error = await errorOf(
      drizzleDb.transaction(async (tx) => {
        await tx.insert(users).values({ email: 'ada@example.com' });
        return 'written';
      }),
    );
    expect(errorFields(error)).toMatchObject({
      isDbError: true,
      code: 'CONNECTION',
      indeterminate: true,
      retryable: true,
    });
    // Observer: the write AND the commit were applied server-side; the bridge
    // never retried anything.
    expect(pool.appliedWrites).toContain('COMMIT');
    expect(pool.dispatched.filter((text) => /^insert/i.test(text))).toHaveLength(1);
    expect(pool.releaseCount).toBe(1);
    await db.close();
  });

  it('statement failure inside the callback: rollback runs, original constraint error preserved', async () => {
    const pool = new FaultPool((text) => (/^insert/i.test(text) ? serverConstraintError('users_email_key') : undefined));
    const db = createDatabase({ adapter: adapterWithPool(pool) });
    const drizzleDb = await drizzlePostgres(db);

    const error = await errorOf(
      drizzleDb.transaction(async (tx) => {
        await tx.insert(users).values({ email: 'ada@example.com' });
        return 'unreachable';
      }),
    );
    expect(errorFields(error)).toMatchObject({
      isDbError: true,
      code: 'CONSTRAINT',
      sqlstate: '23505',
      indeterminate: false,
    });
    // Rollback was actually sent, and the lease was released exactly once.
    expect(pool.dispatched).toContain('ROLLBACK');
    expect(pool.releaseCount).toBe(1);
    await db.close();
  });

  it('rollback connection lost: primary error is NEVER masked by the rollback failure', async () => {
    let calls = 0;
    const pool = new FaultPool((text) => {
      calls += 1;
      if (/^insert/i.test(text)) return serverConstraintError('users_email_key');
      if (/^ROLLBACK$/i.test(text)) return connectionReset(); // rollback itself lost
      return undefined;
    });
    const db = createDatabase({ adapter: adapterWithPool(pool) });
    const drizzleDb = await drizzlePostgres(db);

    const error = await errorOf(
      drizzleDb.transaction(async (tx) => {
        await tx.insert(users).values({ email: 'ada@example.com' });
      }),
    );
    // The primary (constraint) error surfaces, not the rollback's ECONNRESET.
    expect(errorFields(error)).toMatchObject({
      isDbError: true,
      code: 'CONSTRAINT',
      sqlstate: '23505',
    });
    expect((error as Error).message).not.toContain('ECONNRESET');
    expect(pool.releaseCount).toBe(1);
    await db.close();
  });

  it('BEGIN failure: normalized, leased client still released (no leak)', async () => {
    const pool = new FaultPool((text) => (/^BEGIN$/i.test(text) ? connectionReset() : undefined));
    const db = createDatabase({ adapter: adapterWithPool(pool) });
    const drizzleDb = await drizzlePostgres(db);
    const error = await errorOf(drizzleDb.transaction(async () => 'never'));
    expect(errorFields(error)).toMatchObject({ isDbError: true, code: 'CONNECTION', indeterminate: true });
    expect(pool.releaseCount).toBe(1);
    await db.close();
  });

  it('user-thrown DbError passes through unchanged (core parity)', async () => {
    const pool = new FaultPool(() => undefined);
    const db = createDatabase({ adapter: adapterWithPool(pool) });
    const drizzleDb = await drizzlePostgres(db);
    const thrown = new DbError('business rule', { code: 'DATA', retryable: false, indeterminate: false });
    const error = await errorOf(
      drizzleDb.transaction(async () => {
        throw thrown;
      }),
    );
    expect(error).toBe(thrown);
    expect(pool.dispatched).toContain('ROLLBACK');
    await db.close();
  });

  it('user-thrown plain error: DbError UNKNOWN indeterminate true (core parity)', async () => {
    const pool = new FaultPool(() => undefined);
    const db = createDatabase({ adapter: adapterWithPool(pool) });
    const drizzleDb = await drizzlePostgres(db);
    const error = await errorOf(
      drizzleDb.transaction(async () => {
        throw new Error('business rule');
      }),
    );
    expect(errorFields(error)).toMatchObject({
      isDbError: true,
      code: 'UNKNOWN',
      indeterminate: true,
    });
    expect(((error as DbError).cause as Error).message).toBe('business rule');
    await db.close();
  });

  it('tx.rollback() keeps Drizzle control flow: TransactionRollbackError, data rolled back', async () => {
    const pool = new FaultPool(() => undefined);
    const db = createDatabase({ adapter: adapterWithPool(pool) });
    const drizzleDb = await drizzlePostgres(db);
    const error = await errorOf(
      drizzleDb.transaction(async (tx) => {
        await tx.insert(users).values({ email: 'ada@example.com' });
        tx.rollback();
        return 'unreachable';
      }),
    );
    expect((error as Error).message).toBe('Rollback');
    expect(isDbError(error)).toBe(false);
    expect(pool.dispatched).toContain('ROLLBACK');
    await db.close();
  });

  it('savepoints: stock SQL sequence, nested failure rolls back to savepoint with original error', async () => {
    const pool = new FaultPool((text) => (/^insert/i.test(text) ? serverConstraintError('users_email_key') : undefined));
    const db = createDatabase({ adapter: adapterWithPool(pool) });
    const drizzleDb = await drizzlePostgres(db);

    const error = await errorOf(
      drizzleDb.transaction(async (tx) => {
        await tx.transaction(async (inner) => {
          await inner.insert(users).values({ email: 'ada@example.com' });
        });
        return 'unreachable';
      }),
    );
    expect(pool.dispatched).toEqual(
      expect.arrayContaining(['savepoint sp1', 'rollback to savepoint sp1', 'ROLLBACK']),
    );
    expect(errorFields(error)).toMatchObject({ isDbError: true, code: 'CONSTRAINT', sqlstate: '23505' });
    await db.close();
  });

  it('savepoint release success and nested rollback-failure never masks the primary error', async () => {
    const pool = new FaultPool((text) => {
      if (/^rollback to savepoint/i.test(text)) return connectionReset();
      return undefined;
    });
    const db = createDatabase({ adapter: adapterWithPool(pool) });
    const drizzleDb = await drizzlePostgres(db);
    const thrown = new DbError('inner abort', { code: 'DATA', indeterminate: false });
    const error = await errorOf(
      drizzleDb.transaction(async (tx) => {
        await tx.transaction(async () => {
          throw thrown;
        });
        return 'unreachable';
      }),
    );
    expect(error).toBe(thrown); // primary error preserved through both layers
    await db.close();
  });

  it('transaction SQL is byte-identical to the accepted stock bridge', async () => {
    const pool = new FaultPool(() => undefined);
    const db = createDatabase({ adapter: adapterWithPool(pool) });
    const drizzleDb = await drizzlePostgres(db);
    await drizzleDb.transaction(async () => 'x');
    await drizzleDb.transaction(async () => 'x', { isolationLevel: 'serializable' });
    await drizzleDb.transaction(async () => 'x', {
      isolationLevel: 'read committed',
      accessMode: 'read only',
      deferrable: true,
    });
    const begins = pool.dispatched.filter((text) => text.startsWith('begin'));
    expect(begins).toEqual(['begin', 'begin isolation level serializable', 'begin isolation level read committed read only deferrable']);
    expect(pool.dispatched.filter((text) => text === 'commit')).toHaveLength(3);
    await db.close();
  });
});

// ---------------------------------------------------------------------------
// Release failures are quiet cleanup (round 4 regression — the R3 F-1 fix)
// ---------------------------------------------------------------------------

describe('drizzle bridge — release() failures never mask the primary outcome', () => {
  const users = pgTable('users', {
    id: serial('id').primaryKey(),
    email: text('email').notNull().unique(),
  });

  it('commit ack lost AND release() throws: primary DbError CONNECTION indeterminate TRUE, native cause EXACT, release attempted once', async () => {
    const primary = connectionReset();
    const pool = new FaultPool((text) => (/^COMMIT$/i.test(text) ? primary : undefined));
    pool.failRelease = true;
    const db = createDatabase({ adapter: adapterWithPool(pool) });
    const drizzleDb = await drizzlePostgres(db);

    const error = await errorOf(
      drizzleDb.transaction(async (tx) => {
        await tx.insert(users).values({ email: 'ada@example.com' });
      }),
    );
    // The commit was applied server-side but the acknowledgement was lost: the
    // outcome is unknowable and that classification must survive the failing
    // cleanup. Before the round-4 guard this surfaced the raw release error.
    expect(errorFields(error)).toMatchObject({
      isDbError: true,
      code: 'CONNECTION',
      indeterminate: true,
      retryable: true,
      messageHasParamsEcho: false,
    });
    expect((error as Error).message).not.toContain('release()');
    // The native cause is preserved EXACTLY (same object), not replaced by the
    // release failure and not re-wrapped.
    expect((error as DbError).cause).toBe(primary);
    // COMMIT applied server-side exactly once, INSERT dispatched exactly once —
    // the failing release triggered no replay.
    expect(pool.appliedWrites).toContain('COMMIT');
    expect(pool.dispatched.filter((text) => /^insert/i.test(text))).toHaveLength(1);
    expect(pool.releaseCount).toBe(1);
    await db.close();
  });

  it('constraint inside tx, ROLLBACK lost (57P01), release() throws: proven 23505 rejection preserved', async () => {
    const constraint = serverConstraintError('users_email_key');
    const pool = new FaultPool((text) => {
      if (/^insert/i.test(text)) return constraint;
      if (/^ROLLBACK$/i.test(text)) return adminShutdown();
      return undefined;
    });
    pool.failRelease = true;
    const db = createDatabase({ adapter: adapterWithPool(pool) });
    const drizzleDb = await drizzlePostgres(db);

    const error = await errorOf(
      drizzleDb.transaction(async (tx) => {
        await tx.insert(users).values({ email: 'ada@example.com' });
      }),
    );
    // Triple failure: the proven server rejection (23505) must win over both
    // the failed ROLLBACK and the failed release. Before the guard this was the
    // raw release error with no SQLSTATE at all.
    expect(errorFields(error)).toMatchObject({
      isDbError: true,
      code: 'CONSTRAINT',
      sqlstate: '23505',
      indeterminate: false,
    });
    expect((error as DbError).cause).toBe(constraint);
    expect(pool.releaseCount).toBe(1);
    await db.close();
  });

  it('BEGIN failure AND release() throws: primary preserved with its SQLSTATE, release attempted exactly once', async () => {
    const shutdown = adminShutdown();
    const pool = new FaultPool((text) => (/^begin$/i.test(text) ? shutdown : undefined));
    pool.failRelease = true;
    const db = createDatabase({ adapter: adapterWithPool(pool) });
    const drizzleDb = await drizzlePostgres(db);

    const error = await errorOf(drizzleDb.transaction(async () => 'never'));
    // Nothing was dispatched after BEGIN, so the outcome is proven (nothing
    // happened); the release failure must not overwrite the 57P01.
    expect(errorFields(error)).toMatchObject({
      isDbError: true,
      code: 'CONNECTION',
      sqlstate: '57P01',
      indeterminate: false,
    });
    expect((error as DbError).cause).toBe(shutdown);
    // The lease is still released (no leak) even though both BEGIN and the
    // release itself failed.
    expect(pool.releaseCount).toBe(1);
    await db.close();
  });

  it('explicit abort via tx.rollback() AND release() throws: TransactionRollbackError preserved', async () => {
    const pool = new FaultPool(() => undefined);
    pool.failRelease = true;
    const db = createDatabase({ adapter: adapterWithPool(pool) });
    const drizzleDb = await drizzlePostgres(db);

    const error = await errorOf(
      drizzleDb.transaction(async (tx) => {
        await tx.insert(users).values({ email: 'ada@example.com' });
        tx.rollback();
        return 'unreachable';
      }),
    );
    // Drizzle's deliberate-abort control flow is not a database failure: it
    // must survive the failing cleanup untouched.
    expect((error as Error).message).toBe('Rollback');
    expect(isDbError(error)).toBe(false);
    expect(pool.dispatched).toContain('ROLLBACK');
    expect(pool.releaseCount).toBe(1);
    await db.close();
  });

  it('acknowledged commit AND release() throws: the committed result is returned (quiet cleanup policy)', async () => {
    const pool = new FaultPool(() => undefined);
    pool.failRelease = true;
    const db = createDatabase({ adapter: adapterWithPool(pool) });
    const drizzleDb = await drizzlePostgres(db);

    // Policy: the COMMIT was acknowledged, so the transaction succeeded. The
    // release failure is pool-side cleanup — turning it into an error (or an
    // `indeterminate` claim) would deny a proven success. It is swallowed.
    const result = await drizzleDb.transaction(async (tx) => {
      await tx.insert(users).values({ email: 'ada@example.com' });
      return 'committed';
    });
    expect(result).toBe('committed');
    expect(pool.dispatched.filter((text) => /^insert/i.test(text))).toHaveLength(1);
    expect(pool.releaseCount).toBe(1);
    await db.close();
  });

  it('user-thrown DbError AND release() throws: the same reference propagates unchanged', async () => {
    const pool = new FaultPool(() => undefined);
    pool.failRelease = true;
    const db = createDatabase({ adapter: adapterWithPool(pool) });
    const drizzleDb = await drizzlePostgres(db);
    const thrown = new DbError('business rule', { code: 'DATA', retryable: false, indeterminate: false });

    const error = await errorOf(
      drizzleDb.transaction(async () => {
        throw thrown;
      }),
    );
    expect(error).toBe(thrown);
    expect(pool.dispatched).toContain('ROLLBACK');
    expect(pool.releaseCount).toBe(1);
    await db.close();
  });
});

// ---------------------------------------------------------------------------
// RQB and relational queries (offline fixture)
// ---------------------------------------------------------------------------

describe('drizzle bridge — relational queries normalize too (offline)', () => {
  const schemaSchema = pgSchema('r2_norm');
  const users = schemaSchema.table('users', {
    id: serial('id').primaryKey(),
    email: text('email').notNull(),
  });
  const posts = schemaSchema.table('posts', {
    id: serial('id').primaryKey(),
    authorId: integer('author_id').notNull(),
  });
  const usersRelations = relations(users, ({ many }) => ({ posts: many(posts) }));
  const postsRelations = relations(posts, ({ one }) => ({
    author: one(users, { fields: [posts.authorId], references: [users.id] }),
  }));
  const schema = { users, posts, usersRelations, postsRelations };

  it('db.query relational failure is a normalized DbError', async () => {
    const pool = new FaultPool((text) => (/^select/i.test(text) ? connectionReset() : undefined));
    const db = createDatabase({ adapter: adapterWithPool(pool) });
    const drizzleDb = await drizzlePostgres(db, { schema });
    const error = await errorOf(drizzleDb.query.users.findMany({ with: { posts: true } }));
    expect(errorFields(error)).toMatchObject({ isDbError: true, code: 'CONNECTION', indeterminate: false });
    await db.close();
  });

  it('db.$count failure is a normalized DbError', async () => {
    const pool = new FaultPool((text) => (/^select/i.test(text) ? connectionReset() : undefined));
    const db = createDatabase({ adapter: adapterWithPool(pool) });
    const drizzleDb = await drizzlePostgres(db);
    const error = await errorOf(drizzleDb.$count(users));
    expect(errorFields(error)).toMatchObject({ isDbError: true, code: 'CONNECTION' });
    await db.close();
  });

  it('success path still maps rows through the schema (typed select + RQB)', async () => {
    const pool = new FaultPool((text) => {
      if (/from "r2_norm"\."users"/.test(text) && !/join/.test(text)) {
        return undefined;
      }
      return undefined;
    });
    const db = createDatabase({ adapter: adapterWithPool(pool) });
    const drizzleDb = await drizzlePostgres(db, { schema });
    const rows = await drizzleDb.select({ id: users.id, email: users.email }).from(users);
    expect(rows).toEqual([{ id: 7, email: 'ada@example.com' }]);
    await db.close();
  });
});

// ---------------------------------------------------------------------------
// Neon HTTP bridge (mocked neon query function — documented fixture, not hosted Neon)
// ---------------------------------------------------------------------------

interface NeonCall {
  sql: string;
  params: unknown[];
}

function neonDbError(message: string, code?: string, sourceError?: unknown): Error {
  // Shape of @neondatabase/serverless NeonDbError (code carries the SQLSTATE
  // for HTTP 400 responses; sourceError wraps transport failures).
  const error = new Error(message) as Error & { name?: string; code?: string; sourceError?: unknown };
  error.name = 'NeonDbError';
  if (code !== undefined) error.code = code;
  if (sourceError !== undefined) error.sourceError = sourceError;
  return error;
}

function neonAdapter(fn: unknown): DatabaseAdapter<NeonRaw> {
  return neon({
    connectionString: 'postgres://user:pass@ep-r2-fake.neon.tech/neondb',
    neonFactory: () => fn as unknown as NeonHttpQueryFn,
  });
}

describe('drizzle neon-http bridge — errors normalized (mocked transport)', () => {
  function mockNeon(behavior: (sqlText: string) => Promise<unknown> | unknown) {
    const calls: NeonCall[] = [];
    /**
     * The real neon driver returns a lazy `NeonQueryPromise` per query (it is
     * only executed when awaited, or when its `queryData` is read for a batch).
     * The mock mirrors that laziness so rejected promises are never unhandled.
     */
    const makeQuery = (sqlText: string, params: unknown[], outcome: () => Promise<unknown>) => {
      let inner: Promise<unknown> | undefined;
      const run = (): Promise<unknown> => {
        inner ??= outcome();
        return inner;
      };
      const lazy = {
        queryData: { query: sqlText, params },
        then<T1, T2>(onFulfilled?: ((value: unknown) => T1 | PromiseLike<T1>) | undefined | null, onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | undefined | null) {
          return run().then(onFulfilled, onRejected);
        },
        catch<T2>(onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | undefined | null) {
          return run().then(undefined, onRejected);
        },
        finally(onFinally?: (() => void) | undefined | null) {
          return run().finally(onFinally);
        },
      };
      return lazy;
    };
    const fn = Object.assign(() => undefined, {
      query(sqlText: string, params?: unknown[], _opts?: Record<string, unknown>) {
        calls.push({ sql: sqlText, params: params ?? [] });
        return makeQuery(sqlText, params ?? [], () => Promise.resolve(behavior(sqlText)));
      },
      transaction(queries: unknown[], _opts?: Record<string, unknown>) {
        for (const query of queries) {
          const record = query as { queryData?: { query?: string; params?: unknown[] } };
          calls.push({ sql: record.queryData?.query ?? '', params: record.queryData?.params ?? [] });
        }
        return behavior(`batch:${queries.length}`);
      },
    });
    return { fn, calls };
  }

  it('execute: server constraint rejection → CONSTRAINT with sqlstate, native cause preserved', async () => {
    const mock = mockNeon((sqlText) =>
      sqlText.includes('insert')
        ? Promise.reject(neonDbError('duplicate key value violates unique constraint "users_email_key"', '23505'))
        : Promise.resolve({ rows: [[1]], rowCount: 1, command: 'SELECT', fields: [] }),
    );
    const db = createDatabase({ adapter: neonAdapter(mock.fn) });
    const drizzleDb = await drizzleNeonHttp(db);
    const error = await errorOf(drizzleDb.execute(dsql`insert into users (email) values ('ada@example.com')`));
    expect(errorFields(error)).toMatchObject({
      isDbError: true,
      code: 'CONSTRAINT',
      sqlstate: '23505',
      indeterminate: false,
      adapterId: 'neon',
    });
    const cause = (error as DbError).cause as Error & { name?: string };
    expect(cause.name).toBe('NeonDbError');
    await db.close();
  });

  it('execute: response lost after a write → indeterminate TRUE (same policy as db.sql)', async () => {
    const fetchLost = neonDbError('Error connecting to database: TypeError: fetch failed', undefined, connectionReset());
    const mock = mockNeon((sqlText) =>
      sqlText.includes('insert') ? Promise.reject(fetchLost) : Promise.resolve({ rows: [[1]], rowCount: 1, command: 'SELECT', fields: [] }),
    );
    const db = createDatabase({ adapter: neonAdapter(mock.fn) });
    const coreError = await errorOf(db.query({ text: 'insert into users (email) values ($1)', params: ['x'] }));
    expect(errorFields(coreError)).toMatchObject({ isDbError: true, indeterminate: true });

    const drizzleDb = await drizzleNeonHttp(db);
    const drizzleError = await errorOf(drizzleDb.execute(dsql`insert into users (email) values ('x')`));
    expect(errorFields(drizzleError)).toMatchObject({
      isDbError: true,
      code: 'CONNECTION',
      indeterminate: true,
      retryable: true,
      messageHasParamsEcho: false,
    });
    await db.close();
  });

  it('batch: transport lost with a write in the batch → indeterminate TRUE; all-read batch → FALSE', async () => {
    const fetchLost = neonDbError('Error connecting to database: TypeError: fetch failed', undefined, connectionReset());
    const table = pgTable('users', { id: serial('id').primaryKey(), email: text('email') });

    const writeBatch = mockNeon(() => Promise.reject(fetchLost));
    const dbWrite = createDatabase({ adapter: neonAdapter(writeBatch.fn) });
    const drizzleWrite = await drizzleNeonHttp(dbWrite);
    const writeError = await errorOf(
      drizzleWrite.batch([
        drizzleWrite.select().from(table),
        drizzleWrite.insert(table).values({ email: 'x' }),
      ] as const),
    );
    expect(errorFields(writeError)).toMatchObject({ isDbError: true, code: 'CONNECTION', indeterminate: true });

    const readBatch = mockNeon(() => Promise.reject(fetchLost));
    const dbRead = createDatabase({ adapter: neonAdapter(readBatch.fn) });
    const drizzleRead = await drizzleNeonHttp(dbRead);
    const readError = await errorOf(
      drizzleRead.batch([drizzleRead.select().from(table)] as const),
    );
    expect(errorFields(readError)).toMatchObject({ isDbError: true, indeterminate: false });
    await dbWrite.close();
    await dbRead.close();
  });

  it('batch: server rejection → CONSTRAINT, indeterminate false; success still maps results', async () => {
    const table = pgTable('users', { id: serial('id').primaryKey(), email: text('email') });
    const failing = mockNeon(() => Promise.reject(neonDbError('duplicate key', '23505')));
    const dbFailing = createDatabase({ adapter: neonAdapter(failing.fn) });
    const drizzleFailing = await drizzleNeonHttp(dbFailing);
    const constraintError = await errorOf(
      drizzleFailing.batch([drizzleFailing.insert(table).values({ email: 'x' })] as const),
    );
    expect(errorFields(constraintError)).toMatchObject({ isDbError: true, code: 'CONSTRAINT', sqlstate: '23505', indeterminate: false });
    await dbFailing.close();

    const succeeding = mockNeon((sqlText) =>
      sqlText.startsWith('batch:')
        ? [{ rows: [[1, 'a@example.com']], rowCount: 1, command: 'INSERT', fields: [] }]
        : { rows: [[1, 'a@example.com']], rowCount: 1, command: 'INSERT', fields: [] },
    );
    const dbOk = createDatabase({ adapter: neonAdapter(succeeding.fn) });
    const drizzleOk = await drizzleNeonHttp(dbOk);
    const results = await drizzleOk.batch([drizzleOk.insert(table).values({ email: 'a@example.com' })] as const);
    expect(results).toHaveLength(1);
    await dbOk.close();
  });

  it('transaction refusal is now a DbError CAPABILITY before any dispatch', async () => {
    const mock = mockNeon(() => Promise.resolve({ rows: [], rowCount: 0, command: 'SELECT', fields: [] }));
    const db = createDatabase({ adapter: neonAdapter(mock.fn) });
    const drizzleDb = await drizzleNeonHttp(db);
    const error = await errorOf(drizzleDb.transaction(async () => 'never'));
    expect(errorFields(error)).toMatchObject({
      isDbError: true,
      code: 'CAPABILITY',
      indeterminate: false,
      retryable: false,
      adapterId: 'neon',
    });
    expect(mock.calls).toHaveLength(0); // refused before dispatch
    await db.close();
  });
});

// ---------------------------------------------------------------------------
// Real local PostgreSQL — constraint parity and success regressions (gated)
// ---------------------------------------------------------------------------

const SCHEMA_NAME = 'dbsdk_drizzle_r2norm';
const custom = pgSchema(SCHEMA_NAME);
const users = custom.table('r2_users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  at: timestamp('at', { withTimezone: true }),
});
const posts = custom.table('r2_posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id').notNull(),
  title: text('title').notNull(),
});
const usersRelations = relations(users, ({ many }) => ({ posts: many(posts) }));
const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
}));
const schema = { users, posts, usersRelations, postsRelations };

d('drizzle bridge — real PostgreSQL', () => {
  let db: Database<PgPoolLike>;
  let drizzleDb: NodePgDatabase<typeof schema> & { $client: Pool };

  beforeAll(async () => {
    db = createDatabase({ adapter: postgres({ connectionString: LOCAL_URL }) });
    await db.query({ text: `drop schema if exists ${SCHEMA_NAME} cascade` });
    await db.query({ text: `create schema ${SCHEMA_NAME}` });
    await db.query({
      text: `create table ${SCHEMA_NAME}.r2_users (
        id serial primary key,
        email text not null unique,
        at timestamptz
      )`,
    });
    await db.query({
      text: `create table ${SCHEMA_NAME}.r2_posts (
        id serial primary key,
        author_id integer not null,
        title text not null
      )`,
    });
    drizzleDb = await drizzlePostgres(db, { schema });
  });

  afterAll(async () => {
    // No leftover fixture schema: clean up before closing the pool.
    await db.query({ text: `drop schema if exists ${SCHEMA_NAME} cascade` }).catch(() => undefined);
    await db.close();
  });

  it('constraint violation: drizzle path matches the core path field-by-field', async () => {
    await drizzleDb.insert(users).values({ email: 'ada@example.com', at: new Date() });
    const coreError = await errorOf(
      db.query({ text: `insert into ${SCHEMA_NAME}.r2_users (email) values ($1)`, params: ['ada@example.com'] }),
    );
    const drizzleError = await errorOf(drizzleDb.insert(users).values({ email: 'ada@example.com', at: new Date() }));

    const core = errorFields(coreError);
    const bridge = errorFields(drizzleError);
    expect(core).toMatchObject({ isDbError: true, code: 'CONSTRAINT', sqlstate: '23505', indeterminate: false, retryable: false });
    expect(bridge).toMatchObject({
      isDbError: true,
      code: core.code,
      sqlstate: core.sqlstate,
      indeterminate: core.indeterminate,
      retryable: core.retryable,
      adapterId: db.adapterId,
      messageHasParamsEcho: false,
      causeIsDrizzleQueryError: false,
    });
    // Native pg error preserved on cause with its server fields.
    const cause = (drizzleError as DbError).cause as Error & { constraint?: string; detail?: string };
    expect(cause.constraint).toContain('r2_users_email_key');
    expect(cause.detail).toContain('ada@example.com');
  });

  it('success regressions: typed select, insert returning, RQB with relations, transactions', async () => {
    const inserted = await drizzleDb
      .insert(users)
      .values({ email: 'grace@example.com', at: new Date() })
      .returning({ id: users.id, email: users.email });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.email).toBe('grace@example.com');

    const author = await drizzleDb.select().from(users).where(eq(users.email, 'grace@example.com'));
    expect(author).toHaveLength(1);
    expect(author[0]?.at).toBeInstanceOf(Date);

    const graceId = author[0]?.id;
    expect(graceId).toBeDefined();
    await drizzleDb.insert(posts).values({ authorId: graceId as number, title: 'Grace post' });

    const found = await drizzleDb.query.users.findFirst({
      where: eq(users.email, 'grace@example.com'),
      with: { posts: true },
    });
    expect(found?.email).toBe('grace@example.com');
    expect(found?.posts).toHaveLength(1);
    expect(found?.posts[0]?.title).toBe('Grace post');

    const rowCount = await drizzleDb.$count(posts);
    expect(rowCount).toBe(1);

    // Transaction writes and rollback semantics on real data.
    await drizzleDb.transaction(async (tx) => {
      await tx.insert(posts).values({ authorId: graceId as number, title: 'Tx post' });
    });
    expect(await drizzleDb.$count(posts)).toBe(2);

    await expect(
      drizzleDb.transaction(async (tx) => {
        await tx.insert(posts).values({ authorId: graceId as number, title: 'Rolled back post' });
        throw new Error('intentional rollback');
      }),
    ).rejects.toMatchObject({ code: 'UNKNOWN', indeterminate: true });
    expect(await drizzleDb.$count(posts)).toBe(2);

    // Nested savepoint rollback keeps the outer transaction usable.
    await drizzleDb.transaction(async (tx) => {
      await tx.insert(posts).values({ authorId: graceId as number, title: 'Kept post' });
      await expect(
        tx.transaction(async (inner) => {
          await inner.insert(posts).values({ authorId: graceId as number, title: 'Sp post' });
          throw new Error('abort savepoint');
        }),
      ).rejects.toMatchObject({ code: 'UNKNOWN', indeterminate: true });
    });
    const titles = await drizzleDb.select({ title: posts.title }).from(posts);
    expect(titles.map((row) => row.title).sort()).toEqual(['Grace post', 'Kept post', 'Tx post']);
  });

  it('constraint failure inside a real transaction rolls back and preserves the primary error', async () => {
    const error = await errorOf(
      drizzleDb.transaction(async (tx) => {
        await tx.insert(users).values({ email: 'ada@example.com' }); // duplicate
        return 'unreachable';
      }),
    );
    expect(errorFields(error)).toMatchObject({
      isDbError: true,
      code: 'CONSTRAINT',
      sqlstate: '23505',
      indeterminate: false,
    });
    const count = await drizzleDb.$count(users);
    expect(count).toBe(2); // ada + grace; nothing extra persisted
  });

  it('Supabase-style adapter pool and raw escapes still bypass normalization (documented boundary)', async () => {
    // The raw escape hatch ($client / db.raw) is intentionally NOT normalized.
    const poolError = await errorOf(
      (drizzleDb.$client as unknown as { query: (config: { text: string }) => Promise<unknown> }).query({
        text: `insert into ${SCHEMA_NAME}.r2_users (email) values ('ada@example.com')`,
      }),
    );
    expect(isDbError(poolError)).toBe(false); // raw pg error, documented raw boundary
  });
});

// ---------------------------------------------------------------------------
// Client compatibility: a real pg.Client (non-pool) still works like upstream
// ---------------------------------------------------------------------------

d('drizzle bridge — pg.Client-style handle (upstream-compatible single connection)', () => {
  it('runs transactions directly on the client without leasing', async () => {
    if (!hasServer) return;
    const client = new Client({ connectionString: LOCAL_URL });
    await client.connect();
    try {
      const capabilities: DatabaseAdapterCapabilities = {
        interactiveTransactions: true,
        atomicBatch: true,
        sessionState: true,
        transport: 'tcp',
        evidence: {},
      };
      const adapter: DatabaseAdapter<PgPoolLike> = {
        id: 'client-mode',
        engine: 'postgresql',
        capabilities,
        raw: client as unknown as PgPoolLike,
        async query<Row>(text: string): Promise<QueryResult<Row>> {
          const result = await (client as unknown as PgPoolLike).query({ text });
          return { rows: result.rows as Row[], rowCount: result.rowCount } as QueryResult<Row>;
        },
        async close() {
          await client.end();
        },
      };
      const localDb = createDatabase({ adapter });
      const localDrizzle = await drizzlePostgres(localDb);
      const result = await localDrizzle.execute<{ n: number }>('select 1 as n');
      expect(result.rows[0]).toEqual({ n: 1 });
      await localDb.close();
    } finally {
      // end() is idempotent enough for the fixture; close above already ended it.
      await client.end().catch(() => undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// Real pool + Pool instance detection (upstream isPool parity)
// ---------------------------------------------------------------------------

d('drizzle bridge — real pg.Pool transactions (gated)', () => {
  it('leases a client for transactions and releases it exactly once', async () => {
    const adapter = postgres({ connectionString: LOCAL_URL });
    const localDb = createDatabase({ adapter });
    const localDrizzle = await drizzlePostgres(localDb);
    const value = await localDrizzle.transaction(async (tx) => {
      const result = await tx.execute<{ n: number }>('select 41 + 1 as n');
      return result.rows[0]?.n;
    });
    expect(value).toBe(42);
    await localDb.close();
  });
});
