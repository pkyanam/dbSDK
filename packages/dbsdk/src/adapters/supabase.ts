/**
 * Supabase adapter — PostgreSQL over the standard wire protocol, with explicit
 * connection modes.
 *
 * Supabase exposes four SQL connection paths (https://supabase.com/docs/guides/database/connecting-to-postgres).
 * The three TCP paths are supported here; the REST Data API is NOT part of this
 * SQL surface (no arbitrary SQL, no client-defined transactions) and is excluded.
 *
 * | mode          | endpoint                              | port | prepared stmts | session state |
 * |---------------|---------------------------------------|------|----------------|---------------|
 * | `direct`      | `db.<ref>.supabase.co`                | 5432 | yes            | yes           |
 * | `session`     | `aws-<i>-<region>.pooler.supabase.com`| 5432 | yes            | yes           |
 * | `transaction` | `aws-<i>-<region>.pooler.supabase.com`| 6543 | no             | no            |
 *
 * The adapter never guesses credentials or rewrites endpoints. In the default
 * strict mode it *validates* that the connection string matches the declared
 * mode and fails loudly on contradiction (e.g. `transaction` mode on port 5432),
 * because silent mismatch would silently break session state and transactions.
 */

import { Pool } from 'pg';

import {
  createPgEngine,
  type PgEngineOptions,
  type PgPoolConfig,
  type PgPoolLike,
  type PgSslOptions,
} from './pg-engine.js';
import { ConfigurationError } from './errors.js';
import {
  assertNoUrlSslOverride,
  collectUrlSslDirectives,
} from './pg-url-ssl.js';
import { createTransactionPoolerGuard } from './pg-sql.js';
import type { DatabaseAdapter, DatabaseAdapterCapabilities } from '../types.js';

export type SupabaseConnectionMode = 'direct' | 'session' | 'transaction';

export type SupabaseAdapterOptions = {
  /** Supabase Postgres connection string for the chosen mode (from the dashboard). */
  connectionString: string;
  /** Which documented connection path this string points at. */
  connectionMode: SupabaseConnectionMode;
  /** Max pool size. Default 10; Supabase recommends `max: 1` for serverless runtimes. */
  max?: number;
  /** Idle connection timeout in ms. */
  idleTimeoutMillis?: number;
  /** Connection acquisition timeout in ms. */
  connectionTimeoutMillis?: number;
  /**
   * SSL setting passed through to `pg`.
   *
   * Default for remote endpoints: certificate validation ON
   * (`{ rejectUnauthorized: true }`) — TLS without verification does not stop a
   * man-in-the-middle attack. Note that Supabase endpoints present certificates
   * chaining to Supabase's own root CA (not in the Node trust store), so with the
   * default you must supply that CA (e.g. `pool: { ssl: { ca: caCert } }`, from
   * the certificate Supabase publishes in the dashboard) or your connection fails
   * loudly with a certificate error. To connect without certificate validation
   * (encrypted but unverified), pass `ssl: { rejectUnauthorized: false }`
   * explicitly. Localhost defaults to no TLS.
   */
  ssl?: boolean | PgSslOptions;
  /** Statement timeout in ms. */
  statementTimeout?: number;
  /** Reject session-state statements on the transaction pooler before dispatch. Default true. */
  enforceSessionRestrictions?: boolean;
  /** Default false: fail loudly when the connection string contradicts the declared mode. */
  allowModeMismatch?: boolean;
  /** Escape hatch for additional `pg` Pool options (merged after the above). */
  pool?: PgPoolConfig;
  /** Injection point for tests: pool factory. Defaults to the real `pg.Pool`. */
  poolFactory?: PgEngineOptions['poolFactory'];
};

export type SupabaseResolvedConnection = {
  host: string;
  port: number;
  database: string | null;
  /** Project ref when it could be read unambiguously (pooler username or direct host). */
  projectRef: string | null;
};

export type SupabaseRaw = {
  pool: PgPoolLike;
  connectionMode: SupabaseConnectionMode;
  resolved: SupabaseResolvedConnection;
};

const MODE_PORTS: Record<SupabaseConnectionMode, number> = {
  direct: 5432,
  session: 5432,
  transaction: 6543,
};

// Session-state guarding on the transaction-pooler path is shared with the PlanetScale
// PgBouncer adapter: `createTransactionPoolerGuard` (src/adapters/pg-sql.ts) refuses the
// session-state statement classes AND multi-statement strings before dispatch, immune to
// leading comments, string literals and dollar-quoted bodies.
//
// Public compatibility: `assertNoSessionState` remains exported (re-exported from
// src/adapters/index.ts). It now delegates to the shared guard, which means it also
// rejects multi-statement strings — the pre-dispatch guarantee it exists for.
export function assertNoSessionState(text: string): void {
  createTransactionPoolerGuard({ adapterId: 'supabase', label: 'supabase (transaction mode)' })(text);
}

function parseConnectionString(connectionString: string, adapter: string) {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new ConfigurationError(adapter, `supabase: connectionString is not a valid URL`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new ConfigurationError(
      adapter,
      `supabase: connectionString must use the postgres:// or postgresql:// scheme (got ${url.protocol})`,
    );
  }
  const port = url.port ? Number(url.port) : 5432;
  const database = url.pathname.replace(/^\//, '') || null;
  let projectRef: string | null = null;
  const directMatch = /^db\.([a-z0-9]{20})\.supabase\.(co|com)$/i.exec(url.hostname);
  if (directMatch) {
    projectRef = directMatch[1]!;
  } else if (/\.pooler\.supabase\.(co|com)$/i.test(url.hostname)) {
    const user = decodeURIComponent(url.username);
    const userMatch = /^postgres\.([a-z0-9]{20})$/i.exec(user);
    if (userMatch) {
      projectRef = userMatch[1]!;
    }
  }
  return { url, host: url.hostname, port, database, projectRef, username: url.username };
}

export function supabase(options: SupabaseAdapterOptions): DatabaseAdapter<SupabaseRaw> {
  const id = 'supabase';
  if (!options.connectionString) {
    throw new ConfigurationError(id, 'supabase: connectionString is required');
  }
  const mode = options.connectionMode;
  if (!mode) {
    throw new ConfigurationError(id, 'supabase: connectionMode is required ("direct" | "session" | "transaction")');
  }

  const parsed = parseConnectionString(options.connectionString, id);

  // Validate (never rewrite): the declared mode must match the endpoint's port.
  if (!options.allowModeMismatch && parsed.port !== MODE_PORTS[mode]) {
    throw new ConfigurationError(
      id,
      `supabase: connectionMode "${mode}" requires port ${MODE_PORTS[mode]}, but the connectionString targets ${parsed.host}:${parsed.port}. ` +
        `The adapter does not rewrite endpoints — supply the connection string for the "${mode}" mode ` +
        `(transaction pooler :6543, session pooler :5432, direct db.<ref>.supabase.co:5432), ` +
        `or pass allowModeMismatch: true if this endpoint is intentional.`,
    );
  }

  // Pooler usernames must be `postgres.<project-ref>`; fail loudly rather than
  // authenticate against the wrong role shape.
  if (
    /\.pooler\.supabase\.(co|com)$/i.test(parsed.host) &&
    !/^postgres\./i.test(decodeURIComponent(parsed.username))
  ) {
    throw new ConfigurationError(
      id,
      `supabase: pooler connections use the username "postgres.<project-ref>", got "${decodeURIComponent(parsed.username)}". The adapter does not rewrite credentials.`,
    );
  }

  const enforceSessionRestrictions = options.enforceSessionRestrictions ?? true;
  const guard =
    mode === 'transaction' && enforceSessionRestrictions
      ? createTransactionPoolerGuard({ adapterId: id, label: 'supabase (transaction mode)' })
      : undefined;

  const isLocal =
    parsed.host === 'localhost' ||
    parsed.host === '127.0.0.1' ||
    parsed.host === '::1';
  const ssl =
    options.ssl !== undefined
      ? options.ssl
      : isLocal
        ? false
        : // Certificate validation ON by default. Supabase endpoints use a private
          // root CA, so users must supply it (via `pool: { ssl: { ca } }`) or opt
          // out explicitly — TLS that silently skips verification would not stop
          // a man-in-the-middle attack.
          { rejectUnauthorized: true };

  // Review finding F3 (narrow form for this adapter's pass-through TLS policy): when the
  // connection URL carries SSL directives AND an explicit ssl configuration exists, pg
  // would silently REPLACE the configured ssl object with whatever the URL says. Refuse
  // that ambiguity before pool construction; URL directives alone keep native pg parsing
  // (including the documented safe `sslmode=verify-full`).
  assertNoUrlSslOverride({
    adapter: id,
    directives: collectUrlSslDirectives(parsed.url),
    explicitSsl: options.ssl,
    poolSsl: options.pool?.ssl,
  });

  const poolConfig: PgPoolConfig = {
    connectionString: options.connectionString,
    max: options.max ?? 10,
    ...(options.idleTimeoutMillis !== undefined
      ? { idleTimeoutMillis: options.idleTimeoutMillis }
      : {}),
    ...(options.connectionTimeoutMillis !== undefined
      ? { connectionTimeoutMillis: options.connectionTimeoutMillis }
      : {}),
    ssl,
    ...(options.statementTimeout !== undefined
      ? { statement_timeout: options.statementTimeout }
      : {}),
    application_name: 'dbsdk',
    ...options.pool,
  };

  const engine = createPgEngine({
    id,
    poolFactory: options.poolFactory ?? ((config) => new Pool(config) as unknown as PgPoolLike),
    poolConfig,
    guard,
    capabilities: supabaseCapabilities(mode),
  });

  const resolved: SupabaseResolvedConnection = {
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    projectRef: parsed.projectRef,
  };

  return {
    id,
    engine: 'postgresql',
    capabilities: engine.capabilities,
    query: engine.query,
    transaction: engine.transaction!,
    batch: engine.batch!,
    close: () => engine.close(),
    raw: {
      get pool() {
        return engine.raw;
      },
      connectionMode: mode,
      resolved,
    },
  };
}

function supabaseCapabilities(mode: SupabaseConnectionMode): DatabaseAdapterCapabilities {
  return {
    // Interactive transactions work in every TCP mode: the adapter leases one
    // connection per transaction, which is exactly what transaction-mode
    // poolers require. Session state (mode !== 'transaction') means session
    // state works on a dedicated session — inside transaction() or a client
    // leased via raw. It does NOT persist between separate top-level queries:
    // the pool may use a different pooled connection (or pooler backend) per call.
    interactiveTransactions: true,
    atomicBatch: true,
    sessionState: mode !== 'transaction',
    transport: 'tcp',
    evidence: {
      interactiveTransactions: 'docs',
      atomicBatch: 'docs',
      sessionState: 'docs',
      transport: 'docs',
    },
  };
}
