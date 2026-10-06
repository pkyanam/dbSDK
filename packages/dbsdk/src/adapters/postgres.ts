/**
 * Generic PostgreSQL adapter — the engine layer every other TCP adapter builds on.
 *
 * Works with any standard PostgreSQL endpoint (local Postgres, RDS, Fly, Neon's
 * direct endpoint, etc.) via the official `pg` driver. `pg` is an *optional peer
 * dependency*: import this module only where you use the adapter.
 *
 * ```ts
 * import { postgres } from 'dbsdk/postgres';
 *
 * const db = postgres({ connectionString: process.env.DATABASE_URL! });
 * const { rows } = await db.query('select id, email from users where id = $1', [userId]);
 * await db.close();
 * ```
 */

import { Pool } from 'pg';

import {
  createPgEngine,
  type PgEngineOptions,
  type PgPoolConfig,
  type PgPoolLike,
  type PgSslOptions,
} from './pg-engine.js';
import type { DatabaseAdapter, DatabaseAdapterCapabilities } from '../types.js';

export type PostgresAdapterOptions = {
  /** PostgreSQL connection string, e.g. `postgres://user:pass@host:5432/db`. */
  connectionString: string;
  /** Max pool size. Default 10. */
  max?: number;
  /** Idle connection timeout in ms. */
  idleTimeoutMillis?: number;
  /** Connection acquisition timeout in ms. */
  connectionTimeoutMillis?: number;
  /** SSL setting passed through to `pg`. `false` for local development without TLS. */
  ssl?: boolean | PgSslOptions;
  /** Statement timeout in ms (server-side cancellation is NOT guaranteed by a client timeout). */
  statementTimeout?: number;
  /** Application name for `pg_stat_activity` identification. Default `dbsdk`. */
  applicationName?: string;
  /** Escape hatch for additional `pg` Pool options (merged after the above). */
  pool?: PgPoolConfig;
  /** Injection point for tests: pool factory. Defaults to the real `pg.Pool`. */
  poolFactory?: PgEngineOptions['poolFactory'];
};

const postgresCapabilities: DatabaseAdapterCapabilities = {
  interactiveTransactions: true,
  atomicBatch: true,
  // True means session state works on a dedicated session (inside transaction(),
  // which leases one connection, or a client leased via raw.pool.connect()). It
  // does NOT mean session state persists between separate top-level queries: a
  // pool may use a different connection per query.
  sessionState: true,
  transport: 'tcp',
  evidence: {
    interactiveTransactions: 'tests',
    atomicBatch: 'tests',
    sessionState: 'tests',
    transport: 'docs',
  },
};

export function postgres(options: PostgresAdapterOptions): DatabaseAdapter<PgPoolLike> {
  if (!options.connectionString) {
    throw new Error('postgres: connectionString is required');
  }

  const poolConfig: PgPoolConfig = {
    connectionString: options.connectionString,
    max: options.max ?? 10,
    ...(options.idleTimeoutMillis !== undefined
      ? { idleTimeoutMillis: options.idleTimeoutMillis }
      : {}),
    ...(options.connectionTimeoutMillis !== undefined
      ? { connectionTimeoutMillis: options.connectionTimeoutMillis }
      : {}),
    ...(options.ssl !== undefined ? { ssl: options.ssl } : {}),
    ...(options.statementTimeout !== undefined
      ? { statement_timeout: options.statementTimeout }
      : {}),
    application_name: options.applicationName ?? 'dbsdk',
    ...options.pool,
  };

  const poolFactory = options.poolFactory ?? ((config) => new Pool(config) as unknown as PgPoolLike);

  return createPgEngine({
    id: 'postgres',
    poolFactory,
    poolConfig,
    capabilities: postgresCapabilities,
  });
}

/** Structural type of the raw driver handle exposed by `postgres().raw`. */
export type PostgresRaw = PgPoolLike;
