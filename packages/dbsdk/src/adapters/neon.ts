/**
 * Neon adapter.
 *
 * Two transports, honest about what each can do:
 *
 * - `http` (default): the official `@neondatabase/serverless` `neon()` function.
 *   One-shot parameterized queries and a native *non-interactive* atomic batch
 *   (`sql.transaction([...])` — a single HTTP round-trip, no callback logic).
 *   No session state, no interactive transactions. Works anywhere `fetch` works.
 * - `websocket`: the same driver's `Pool` (node-postgres-compatible over
 *   WebSockets). Full interactive transactions and session state; on pooled
 *   endpoints (`-pooler` hostnames) session state is reported as unavailable.
 *   In serverless runtimes the pool must live within a single request.
 *
 * Interactive transactions on a server backend can also opt into the standard
 * PostgreSQL transport (`transactionTransport: 'postgres'`) using the project's
 * direct endpoint connection string over TCP via `pg`.
 *
 * Peer dependencies: this adapter requires the optional peer
 * `@neondatabase/serverless` to be installed. npm installs optional peers
 * automatically; with pnpm add it explicitly (`pnpm add @neondatabase/serverless`).
 * The `postgres` transaction transport additionally uses `pg` over TCP, so install
 * `pg` as well when using that option.
 *
 * Docs: https://neon.com/docs/serverless/serverless-driver
 */

import {
  neon as neonDriver,
  Pool as NeonPool,
  type NeonQueryFunction,
} from '@neondatabase/serverless';

import {
  createPgEngine,
  runLeasedTransaction,
  type PgEngineOptions,
  type PgPoolConfig,
  type PgPoolLike,
  type PgSslOptions,
} from './pg-engine.js';
import { CapabilityError, ConfigurationError } from './errors.js';
import { isWriteStatement, markUncertainOutcome, sqlstateOf } from '../errors.js';
import type {
  DatabaseAdapter,
  DatabaseAdapterCapabilities,
  QueryExecutor,
  QueryResult,
  SqlStatement,
} from '../types.js';

export type NeonTransport = 'http' | 'websocket';
export type NeonTransactionTransport = 'none' | 'postgres' | 'websocket';

/** Result shape returned by the driver when `fullResults: true` (mirrors node-postgres). */
export type NeonFullResult = {
  rows: Record<string, unknown>[];
  rowCount: number;
  command: string;
};

/**
 * Structural view of the parts of `NeonQueryFunction<false, true>` the adapter
 * uses. The driver's real return value satisfies it; tests inject lookalikes.
 */
export type NeonHttpQueryFn = {
  query(text: string, params?: unknown[]): Promise<NeonFullResult>;
  transaction(
    queries: unknown[],
    opts?: { fullResults?: boolean },
  ): Promise<NeonFullResult[]>;
};

export type NeonHttpFactory = (
  connectionString: string,
  options?: Record<string, unknown>,
) => NeonHttpQueryFn;

export type NeonAdapterOptions = {
  /** Neon connection string (pooled or direct endpoint). */
  connectionString: string;
  /** Query transport. Default `http`. */
  transport?: NeonTransport;
  /**
   * How interactive `transaction()` is carried, if at all. Default `none`
   * (transaction() throws a CapabilityError before dispatch). `postgres` uses
   * the direct endpoint over TCP via `pg`; `websocket` opens a short-lived
   * Neon `Pool` per transaction.
   */
  transactionTransport?: NeonTransactionTransport;
  /** Required for `transactionTransport: 'postgres'`: the direct (non-pooled) TCP connection string. */
  postgresConnectionString?: string;
  /** Max pool size for TCP/WebSocket transports. Default 10. */
  max?: number;
  /** SSL for the `postgres` transaction transport. */
  ssl?: boolean | PgSslOptions;
  /** Statement timeout for TCP/WebSocket transports, in ms. */
  statementTimeout?: number;
  /** Extra options forwarded to `neon()`, e.g. `{ authToken }` or `{ fetchOptions }`. */
  neonOptions?: Record<string, unknown>;
  /** Injection point for tests: HTTP query factory. Defaults to the driver's `neon()`. */
  neonFactory?: NeonHttpFactory;
  /** Injection point for tests: pool factory for the `postgres` transaction transport. */
  poolFactory?: PgEngineOptions['poolFactory'];
  /** Injection point for tests: pool factory for WebSocket transport. Defaults to the driver's `Pool`. */
  websocketPoolFactory?: PgEngineOptions['poolFactory'];
};

export type NeonRaw =
  | {
      transport: 'http';
      transactionTransport: NeonTransactionTransport;
      /** The official `neon()` query function (created with `fullResults: true`). */
      sql: NeonQueryFunction<false, true>;
    }
  | {
      transport: 'websocket';
      /** The driver's node-postgres-compatible pool. */
      pool: PgPoolLike;
    };

function isPooledHostname(connectionString: string): boolean {
  try {
    return new URL(connectionString).hostname.includes('-pooler.');
  } catch {
    return false;
  }
}

function normalizeFullResult(result: NeonFullResult): QueryResult {
  return {
    rows: result.rows ?? [],
    rowCount: typeof result.rowCount === 'number' ? result.rowCount : null,
    ...(result.command === undefined ? {} : { command: result.command }),
  };
}

const NO_INTERACTIVE_TRANSACTIONS_MESSAGE =
  'neon (http transport): interactive transactions are not supported over HTTP. ' +
  'Use db.batch(statements) for an atomic non-interactive transaction, or configure ' +
  "transactionTransport: 'postgres' (direct endpoint over TCP) or 'websocket'.";

export function neon(options: NeonAdapterOptions): DatabaseAdapter<NeonRaw> {
  const id = 'neon';
  if (!options.connectionString) {
    throw new ConfigurationError(id, 'neon: connectionString is required');
  }
  const transport = options.transport ?? 'http';
  const transactionTransport = options.transactionTransport ?? 'none';

  if (transport === 'websocket') {
    return createWebsocketAdapter(options);
  }

  const neonFactory =
    options.neonFactory ??
    ((connectionString, neonOpts) =>
      neonDriver(connectionString, {
        ...neonOpts,
        fullResults: true,
      }) as unknown as NeonHttpQueryFn);

  const sql = neonFactory(options.connectionString, options.neonOptions);

  let pgEngine: DatabaseAdapter<PgPoolLike> | undefined;

  async function getPostgresEngine(): Promise<DatabaseAdapter<PgPoolLike>> {
    if (pgEngine) {
      return pgEngine;
    }
    if (!options.postgresConnectionString) {
      throw new ConfigurationError(
        id,
        "neon: transactionTransport 'postgres' requires postgresConnectionString — the direct endpoint connection string (TCP). The adapter never rewrites endpoints or guesses credentials.",
      );
    }
    const poolFactory =
      options.poolFactory ??
      (await (async () => {
        try {
          const pg = await import('pg');
          return ((config: PgPoolConfig) => new pg.Pool(config) as unknown as PgPoolLike);
        } catch {
          throw new ConfigurationError(
            id,
            "neon: transactionTransport 'postgres' requires the optional peer dependency 'pg'. Install it or supply poolFactory.",
          );
        }
      })());
    pgEngine = createPgEngine({
      id,
      poolFactory,
      poolConfig: {
        connectionString: options.postgresConnectionString,
        max: options.max ?? 10,
        ...(options.ssl !== undefined ? { ssl: options.ssl } : {}),
        ...(options.statementTimeout !== undefined
          ? { statement_timeout: options.statementTimeout }
          : {}),
        application_name: 'dbsdk',
      },
      capabilities: {
        interactiveTransactions: true,
        atomicBatch: true,
        sessionState: !isPooledHostname(options.postgresConnectionString),
        transport: 'tcp',
        evidence: { transport: 'docs' },
      },
    });
    return pgEngine;
  }

  const capabilities: DatabaseAdapterCapabilities = {
    interactiveTransactions: transactionTransport !== 'none',
    atomicBatch: true,
    sessionState: false,
    transport: 'http',
    evidence: {
      interactiveTransactions: 'docs',
      atomicBatch: 'docs',
      sessionState: 'docs',
      transport: 'docs',
    },
  };

  const base = {
    id,
    engine: 'postgresql' as const,
    capabilities,
    async query<Row = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<Row>> {
      const result = await sql.query(text, [...(params ?? [])]);
      return normalizeFullResult(result) as QueryResult<Row>;
    },
    async batch(statements: readonly SqlStatement[]): Promise<QueryResult[]> {
      if (statements.length === 0) {
        return [];
      }
      // Native Neon atomic batch: all statements in one HTTP transaction,
      // no per-statement round-trips. Non-interactive by design.
      const queries = statements.map((statement) => sql.query(statement.text, [...(statement.params ?? [])]));
      try {
        const results = await sql.transaction(queries, { fullResults: true });
        return results.map(normalizeFullResult);
      } catch (error) {
        // The batch is one HTTP round-trip: if the response is lost after the
        // server applied it, the outcome of any write in the batch is unknown.
        // Mark it so the core client reports `indeterminate` instead of a safe-looking
        // failure. Never retried or replayed here.
        if (sqlstateOf(error) === undefined && statements.some((s) => isWriteStatement(s.text))) {
          markUncertainOutcome(error);
        }
        throw error;
      }
    },
    async close(): Promise<void> {
      // HTTP transport holds no connections. The optional TCP engine, if used,
      // owns its own pool and is closed here.
      if (pgEngine) {
        await pgEngine.close();
        pgEngine = undefined;
      }
    },
  };

  const transactionMethod =
    transactionTransport === 'postgres'
      ? async <T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T> => {
          const engine = await getPostgresEngine();
          return engine.transaction!(fn);
        }
      : transactionTransport === 'websocket'
        ? async <T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T> => {
            // Serverless constraint: the WebSocket pool must be created, used
            // and closed within a single request/handler.
            const poolFactory =
              options.websocketPoolFactory ??
              ((config: PgPoolConfig) => new NeonPool(config) as unknown as PgPoolLike);
            const pool = poolFactory({
              connectionString: options.connectionString,
              max: 1,
              application_name: 'dbsdk',
            });
            const client = await pool.connect();
            try {
              return await runLeasedTransaction(client, fn);
            } finally {
              await pool.end();
            }
          }
        : async <T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T> => {
            // Unsupported: fail before dispatch, without ever invoking the callback.
            void fn;
            throw new CapabilityError('neon', 'interactiveTransactions', NO_INTERACTIVE_TRANSACTIONS_MESSAGE);
          };

  const raw: NeonRaw = {
    transport: 'http',
    transactionTransport,
    sql: sql as unknown as NeonQueryFunction<false, true>,
  };

  return {
    ...base,
    raw,
    transaction: transactionMethod,
  };
}

function createWebsocketAdapter(options: NeonAdapterOptions): DatabaseAdapter<NeonRaw> {
  const poolFactory =
    options.websocketPoolFactory ??
    ((config: PgPoolConfig) => new NeonPool(config) as unknown as PgPoolLike);

  const engine = createPgEngine({
    id: 'neon',
    poolFactory,
    poolConfig: {
      connectionString: options.connectionString,
      max: options.max ?? 10,
      ...(options.statementTimeout !== undefined
        ? { statement_timeout: options.statementTimeout }
        : {}),
      application_name: 'dbsdk',
    },
    capabilities: {
      interactiveTransactions: true,
      atomicBatch: true,
      // Session state is unavailable through the pooled endpoint (PgBouncer
      // transaction mode); available on the direct endpoint.
      sessionState: !isPooledHostname(options.connectionString),
      transport: 'websocket',
      evidence: {
        interactiveTransactions: 'docs',
        atomicBatch: 'docs',
        sessionState: 'docs',
        transport: 'docs',
      },
    },
  });

  return {
    id: 'neon',
    engine: 'postgresql',
    capabilities: engine.capabilities,
    query: (text, params) => engine.query(text, params),
    transaction: engine.transaction!,
    batch: engine.batch!,
    close: () => engine.close(),
    raw: {
      get transport() {
        return 'websocket' as const;
      },
      get pool() {
        return engine.raw;
      },
    } as NeonRaw & { transport: 'websocket' },
  };
}
