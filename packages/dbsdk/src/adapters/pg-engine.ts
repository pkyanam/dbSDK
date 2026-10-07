/**
 * Shared PostgreSQL engine built on node-postgres (`pg`).
 *
 * One code path for connection pooling, query dispatch, interactive
 * transactions and atomic batches. Provider adapters (`postgres`, `supabase`,
 * Neon's `postgres` transaction transport) configure it; they never fork SQL
 * logic.
 *
 * Design rules (from the build plan):
 * - Parameter binding only; values are always bound, never interpolated.
 * - No reusable *named* prepared statements are ever created (the pg `name`
 *   option is not used). Parameterless queries use the simple query protocol.
 * - Transactions and batches lease exactly one connection: BEGIN ... COMMIT,
 *   ROLLBACK on any failure, `release()` always runs.
 * - Driver errors are rethrown as-is (they carry `code`, `detail`, `cause`).
 *   No retries, no replay of writes.
 */

import type {
  DatabaseAdapter,
  DatabaseAdapterCapabilities,
  QueryExecutor,
  QueryResult,
  SqlStatement,
} from '../types.js';
import { DbError, markUncertainOutcome, sqlstateOf } from '../errors.js';

/**
 * Structural subset of the `pg` API the engine relies on. Real `pg.Pool` /
 * `pg.PoolClient` instances satisfy these interfaces, and so do test fixtures —
 * which is how transaction and failure behavior is tested without a live server.
 */
export type PgQueryOutput = {
  rows: unknown[];
  rowCount: number | null;
  command?: string;
};

export type PgClientLike = {
  query(config: { text: string; values?: unknown[]; name?: string }): Promise<PgQueryOutput>;
  release(): void;
};

export type PgPoolLike = {
  query(config: { text: string; values?: unknown[]; name?: string }): Promise<PgQueryOutput>;
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
};

/**
 * Structural subset of node:tls `ConnectionOptions` that `pg` accepts as its
 * `ssl` option, typed exactly like pg's own `ssl` (`Buffer` per node:tls; these
 * adapter option types are TCP/Node-only and pg's own d.ts already requires
 * `@types/node`). Deliberately no `node:tls`/`pg` import, so the type works
 * without new dependencies. Providing any of these objects keeps certificate
 * verification ON (node:tls defaults `rejectUnauthorized` to `true`); pass
 * `rejectUnauthorized: false` only to connect encrypted-but-unverified.
 */
export type PgSslOptions = {
  /** Trusted CA certificate(s) the server certificate is validated against. */
  ca?: string | Buffer | Array<string | Buffer>;
  /** Client certificate for cert-based auth. */
  cert?: string | Buffer | Array<string | Buffer>;
  /** Client private key for cert-based auth. */
  key?: string | Buffer | Array<string | Buffer>;
  /** Validate the server certificate. Default true; `false` disables validation. */
  rejectUnauthorized?: boolean;
  /** Other node:tls `ConnectionOptions` are forwarded to `pg` unchanged. */
  [key: string]: unknown;
};

export type PgPoolConfig = {
  connectionString?: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  ssl?: boolean | PgSslOptions;
  application_name?: string;
  statement_timeout?: number;
  [key: string]: unknown;
};

/** Normalize a `pg` result (or pg-shaped fixture output) to the SDK result shape. */
export function normalizePgResult<T>(result: {
  rows: T[];
  rowCount: number | null;
  command?: string;
}): QueryResult<T> {
  return {
    rows: result.rows,
    rowCount: typeof result.rowCount === 'number' ? result.rowCount : null,
    ...(result.command === undefined ? {} : { command: result.command }),
  };
}

function clientQueryConfig(text: string, params: readonly unknown[] | undefined) {
  // No `name`: we deliberately never create reusable named prepared statements.
  return params === undefined || params.length === 0
    ? { text }
    : { text, values: [...params] };
}

/** Executor view over a leased connection, used inside transactions and batches. */
function executorFor(client: PgClientLike, guard?: (text: string) => void): QueryExecutor {
  return {
    async query<Row = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<Row>> {
      guard?.(text);
      const result = await client.query(clientQueryConfig(text, params));
      return normalizePgResult(result as { rows: Row[]; rowCount: number | null; command?: string });
    },
  };
}

async function rollbackQuietly(client: PgClientLike): Promise<boolean> {
  try {
    await client.query({ text: 'ROLLBACK' });
    return true;
  } catch {
    // The transaction is already aborted or the connection is gone; the
    // original error is what matters. Release still happens in `finally`.
    return false;
  }
}

/**
 * Run an interactive transaction on a single leased client: BEGIN, the callback,
 * COMMIT — or ROLLBACK on any failure, with `release()` always attempted.
 * Shared by the pg engine and adapters that lease clients from other pools.
 *
 * If the transaction had begun and could not be proven rolled back or committed
 * (e.g. the connection dropped before COMMIT/ROLLBACK finished), the thrown error
 * is marked with an uncertain outcome — the core client turns that into
 * `DbError.indeterminate: true`. There is no replay of writes anywhere.
 *
 * A `release()` failure is cleanup, not an outcome: it is swallowed so it can
 * never mask the primary error, replace a proven rejection with an uncertain
 * outcome, or turn an acknowledged commit into a failure.
 */
export async function runLeasedTransaction<T>(
  client: PgClientLike,
  fn: (tx: QueryExecutor) => Promise<T>,
  guard?: ((text: string) => void) | undefined,
): Promise<T> {
  let committed = false;
  // `begin` failures mean nothing executed; `callback`/`commit` failures may not.
  let phase: 'begin' | 'callback' | 'commit' = 'begin';
  try {
    await client.query({ text: 'BEGIN' });
    phase = 'callback';
    const value = await fn(executorFor(client, guard));
    phase = 'commit';
    await client.query({ text: 'COMMIT' });
    committed = true;
    return value;
  } catch (error) {
    let rollbackConfirmed = false;
    if (!committed) {
      // Also covers COMMIT failing: the server has usually aborted the
      // transaction, so ROLLBACK is harmless and keeps the lease clean — but if
      // the connection is gone it cannot confirm the outcome.
      rollbackConfirmed = await rollbackQuietly(client);
    }
    if (phase !== 'begin' && !rollbackConfirmed && sqlstateOf(error) === undefined) {
      markUncertainOutcome(error);
    }
    throw error;
  } finally {
    // A release failure is pool-side cleanup, not a transaction outcome: it
    // must never mask the primary error (nor an acknowledged success), and it
    // must not replace a proven rejection with an uncertain outcome.
    try {
      client.release();
    } catch {
      /* ignored — the primary error (or successful result) already won */
    }
  }
}

export type PgEngineOptions = {
  /** Adapter id (e.g. `postgres`, `supabase`). */
  id: string;
  /** Factory for the underlying pool. Defaults to the real `pg.Pool`. */
  poolFactory: (config: PgPoolConfig) => PgPoolLike;
  /** Pool configuration; provider adapters translate their own options into this. */
  poolConfig: PgPoolConfig;
  /** Adapter capabilities; providers pass mode-specific values (e.g. session pooler state). */
  capabilities: DatabaseAdapterCapabilities;
  /**
   * Optional pre-dispatch guard for connection-mode-specific restrictions
   * (e.g. Supabase transaction-pooler session-state rules). Receives each
   * statement's SQL text before it is sent.
   */
  guard?: ((text: string) => void) | undefined;
};

/**
 * Create the shared engine. The pool is created lazily on first use so that
 * constructing an adapter has no side effects.
 */
export function createPgEngine(options: PgEngineOptions): DatabaseAdapter<PgPoolLike> {
  const { id, poolFactory, poolConfig, guard, capabilities } = options;
  let pool: PgPoolLike | undefined;
  let closed = false;

  function getPool(): PgPoolLike {
    if (closed) {
      throw new DbError(`${id}: adapter is closed. Create a new adapter to query again.`, {
        code: 'CONNECTION',
        adapterId: id,
        retryable: false,
        indeterminate: false,
      });
    }
    if (!pool) {
      pool = poolFactory(poolConfig);
    }
    return pool;
  }

  async function guardedQuery(
    client: PgClientLike,
    text: string,
    params: readonly unknown[] | undefined,
  ): Promise<QueryResult> {
    guard?.(text);
    const result = await client.query(clientQueryConfig(text, params));
    return normalizePgResult(result) as QueryResult<Record<string, unknown>>;
  }

  const adapter: DatabaseAdapter<PgPoolLike> = {
    id,
    engine: 'postgresql',

    capabilities,

    raw: undefined as unknown as PgPoolLike, // assigned below once the pool exists

    async query<Row = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<Row>> {
      guard?.(text);
      const result = await getPool().query(clientQueryConfig(text, params));
      return normalizePgResult(result as { rows: Row[]; rowCount: number | null; command?: string });
    },

    async transaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T> {
      return runLeasedTransaction(await getPool().connect(), fn, guard);
    },

    async batch(statements: readonly SqlStatement[]): Promise<QueryResult[]> {
      if (statements.length === 0) {
        return [];
      }
      const client = await getPool().connect();
      try {
        await client.query({ text: 'BEGIN' });
        const results: QueryResult[] = [];
        for (const statement of statements) {
          results.push(await guardedQuery(client, statement.text, statement.params));
        }
        await client.query({ text: 'COMMIT' });
        return results;
      } catch (error) {
        const rollbackConfirmed = await rollbackQuietly(client);
        if (!rollbackConfirmed && sqlstateOf(error) === undefined) {
          markUncertainOutcome(error);
        }
        throw error;
      } finally {
        // Same discipline as `runLeasedTransaction`: a release failure is
        // pool-side cleanup and must never mask the batch's primary error.
        try {
          client.release();
        } catch {
          /* ignored — the primary error (or successful result) already won */
        }
      }
    },

    async close(): Promise<void> {
      closed = true;
      if (pool) {
        await pool.end();
        pool = undefined;
      }
    },
  };

  // The raw escape hatch exposes the live pool. Assign through a lazy getter so
  // the pool is still created on first use, not at adapter construction.
  Object.defineProperty(adapter, 'raw', {
    enumerable: true,
    get() {
      return getPool();
    },
  });

  return adapter;
}
