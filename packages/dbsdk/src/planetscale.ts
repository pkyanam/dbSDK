/**
 * PlanetScale Postgres adapter — thin query wrapper over the shared TCP engine.
 *
 * PlanetScale Postgres speaks the standard PostgreSQL wire protocol with standard drivers
 * (official quickstart names node-postgres `pg`), so this adapter reuses the same engine,
 * parameterized SQL, transaction, batch and error/result semantics as `dbsdk/postgres` and
 * `dbsdk/supabase` — no new SQL engine, no MySQL/Vitess semantics. **Vitess/MySQL is NOT
 * supported by this adapter** (different placeholders, backtick identifiers, no RETURNING —
 * that would be a separate engine and adapter family), and neither is Neki (platform preview).
 *
 * Official connection facts (https://planetscale.com/docs/postgres/connecting/quickstart,
 * verified 2026-10-06):
 * - Hosts look like `{id+region}.horizon.psdb.cloud`; usernames are `{role}.{branch_id}`;
 *   passwords begin `pscale_pw_` and come from a role's ONE-TIME secret (create/reset), never
 *   from the management API token.
 * - **TLS is mandatory**: `sslmode=verify-full` with the system CA store. This adapter's
 *   default for remote hosts is verified TLS (`{ rejectUnauthorized: true }`, Node's system
 *   trust store) and it refuses `ssl: false` on non-local hosts — TLS without verification
 *   would not stop a man-in-the-middle attack. Localhost defaults to no TLS for local testing.
 *   Connection-string SSL directives (`?sslmode=...` etc.) are canonicalized under the same
 *   policy and stripped from the URL before `pg` sees them (pg's URL parser would otherwise
 *   silently override the resolved policy — review finding F3, verified on pg 8.23.1).
 * - **Two ports**: direct `5432` (session semantics: DDL, session variables, temp tables,
 *   long transactions) and PgBouncer `6432` in transaction pooling mode. In pooled mode the
 *   same before-dispatch session-state guards the Supabase transaction pooler needs apply
 *   (shared `createTransactionPoolerGuard`): session-level state does not survive between
 *   transactions there, and multi-statement query strings are refused before dispatch.
 * - Replica routing (`|replica` username suffix) is NOT claimed or handled by this adapter.
 *
 * ```ts
 * import { planetscale } from 'dbsdk/planetscale'; // subpath added by the integration round
 *
 * const db = planetscale({ connectionString: process.env.DATABASE_URL!, connectionMode: 'direct' });
 * const { rows } = await db.query('select id from users where id = $1', [userId]);
 * ```
 */

import { Pool } from 'pg';

import {
  createPgEngine,
  type PgEngineOptions,
  type PgPoolConfig,
  type PgPoolLike,
  type PgSslOptions,
} from './adapters/pg-engine.js';
import { ConfigurationError } from './adapters/errors.js';
import {
  collectUrlSslDirectives,
  resolveVerifiedTlsFromUrl,
  stripUrlSslParams,
} from './adapters/pg-url-ssl.js';
import { createTransactionPoolerGuard } from './adapters/pg-sql.js';
import type { DatabaseAdapter, DatabaseAdapterCapabilities } from './types.js';

export type PlanetScaleConnectionMode = 'direct' | 'pooled';

export type PlanetScaleAdapterOptions = {
  /** PlanetScale Postgres connection string for the chosen mode (from a role's connection info). */
  connectionString: string;
  /**
   * Which documented connection path this string points at: `direct` (port 5432, full session
   * semantics) or `pooled` (PgBouncer port 6432, transaction pooling — no session state).
   */
  connectionMode: PlanetScaleConnectionMode;
  /** Max pool size. Default 10. */
  max?: number;
  /** Idle connection timeout in ms. */
  idleTimeoutMillis?: number;
  /** Connection acquisition timeout in ms. */
  connectionTimeoutMillis?: number;
  /**
   * SSL setting passed through to `pg`. Default for remote endpoints: VERIFIED TLS
   * (`{ rejectUnauthorized: true }` against Node's system CA store — PlanetScale Postgres
   * requires TLS with `verify-full` semantics). `ssl: false` is refused for non-local hosts.
   * Localhost defaults to no TLS (local testing only).
   *
   * Connection-string SSL directives (`?sslmode=...`, `?ssl=...`, `?sslcert=...`) are
   * canonicalized under this same policy BEFORE the pool is built and stripped from the
   * URL handed to `pg`, so they can never silently downgrade TLS or discard the
   * configured CA (pg's own URL parser would otherwise replace the ssl config). Accepted:
   * `sslmode=require|verify-full` (verified TLS), `sslmode=disable` / `ssl=false|0`
   * (plaintext, local hosts only), `ssl=true|1` (verified TLS). Refused with an
   * actionable error: `sslmode=prefer|allow|verify-ca` or unknown values, `sslcert`/
   * `sslkey`/`sslrootcert` file parameters, `sslnegotiation`, `uselibpqcompat`, and any
   * directive conflicting with the explicit `ssl` option.
   */
  ssl?: boolean | PgSslOptions;
  /** Statement timeout in ms. */
  statementTimeout?: number;
  /** Reject session-state statements on the pooled (PgBouncer) path before dispatch. Default true. */
  enforceSessionRestrictions?: boolean;
  /** Default false: fail loudly when the connection string contradicts the declared mode. */
  allowModeMismatch?: boolean;
  /** Escape hatch for additional `pg` Pool options (merged after the above). */
  pool?: PgPoolConfig;
  /** Injection point for tests: pool factory. Defaults to the real `pg.Pool`. */
  poolFactory?: PgEngineOptions['poolFactory'];
};

export type PlanetScaleResolvedConnection = {
  host: string;
  port: number;
  database: string | null;
  /** Role username exactly as it appears in the connection string (never rewritten). */
  username: string;
};

export type PlanetScaleRaw = {
  pool: PgPoolLike;
  connectionMode: PlanetScaleConnectionMode;
  resolved: PlanetScaleResolvedConnection;
};

/** Official documented ports: direct 5432, PgBouncer (transaction pooler) 6432. */
const MODE_PORTS: Record<PlanetScaleConnectionMode, number> = {
  direct: 5432,
  pooled: 6432,
};

// Session-state guarding on the pooled path is shared with the Supabase transaction
// pooler adapter: `createTransactionPoolerGuard` (src/adapters/pg-sql.ts) refuses
// session-state statements AND multi-statement strings before dispatch, immune to
// leading comments, string literals and dollar-quoted bodies.

function parseConnectionString(connectionString: string): {
  url: URL;
  host: string;
  port: number;
  database: string | null;
  username: string;
} {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new ConfigurationError('planetscale', 'planetscale: connectionString is not a valid URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new ConfigurationError(
      'planetscale',
      `planetscale: connectionString must use the postgres:// or postgresql:// scheme (got ${url.protocol})`,
    );
  }
  const port = url.port ? Number(url.port) : 5432;
  const database = url.pathname.replace(/^\//, '') || null;
  return { url, host: url.hostname, port, database, username: decodeURIComponent(url.username) };
}

const planetScaleCapabilities = (mode: PlanetScaleConnectionMode): DatabaseAdapterCapabilities => ({
  // Interactive transactions work in both modes: the adapter leases one connection per
  // transaction, which is exactly what a transaction-mode pooler requires. Session state
  // (mode !== 'pooled') means session state works on a dedicated session — inside
  // transaction() or a client leased via raw. It does NOT persist between separate top-level
  // queries: the pool may use a different connection per call.
  interactiveTransactions: true,
  atomicBatch: true,
  sessionState: mode !== 'pooled',
  transport: 'tcp',
  evidence: {
    interactiveTransactions: 'docs',
    atomicBatch: 'docs',
    sessionState: 'docs',
    transport: 'docs',
  },
});

export function planetscale(options: PlanetScaleAdapterOptions): DatabaseAdapter<PlanetScaleRaw> {
  const id = 'planetscale';
  if (!options.connectionString) {
    throw new ConfigurationError(id, 'planetscale: connectionString is required');
  }
  const mode = options.connectionMode;
  if (mode !== 'direct' && mode !== 'pooled') {
    throw new ConfigurationError(id, 'planetscale: connectionMode is required ("direct" | "pooled")');
  }

  const parsed = parseConnectionString(options.connectionString);

  // Validate (never rewrite): the declared mode must match the endpoint's port.
  if (!options.allowModeMismatch && parsed.port !== MODE_PORTS[mode]) {
    throw new ConfigurationError(
      id,
      `planetscale: connectionMode "${mode}" requires port ${MODE_PORTS[mode]}, but the connectionString targets ${parsed.host}:${parsed.port}. ` +
        `The adapter does not rewrite endpoints — supply the connection string for the "${mode}" mode ` +
        `(direct 5432, PgBouncer pooled 6432), or pass allowModeMismatch: true if this endpoint is intentional.`,
    );
  }

  const enforceSessionRestrictions = options.enforceSessionRestrictions ?? true;
  const guard =
    mode === 'pooled' && enforceSessionRestrictions
      ? createTransactionPoolerGuard({
          adapterId: id,
          label: 'planetscale (pooled, PgBouncer 6432)',
        })
      : undefined;

  const isLocal =
    parsed.host === 'localhost' ||
    parsed.host === '127.0.0.1' ||
    parsed.host === '::1' ||
    parsed.host.endsWith('.localhost');

  // Explicit plaintext stays refused for remote hosts (unchanged policy).
  if (options.ssl === false && !isLocal) {
    throw new ConfigurationError(
      id,
      'planetscale: ssl: false was explicitly requested for a non-local host. PlanetScale Postgres ' +
        'requires TLS (official sslmode=verify-full); refusing to connect unencrypted. Use localhost ' +
        'for local no-TLS testing, or pass a real ssl configuration.',
    );
  }

  /**
   * TLS policy (review finding F3): the policy must hold for the FINAL driver
   * configuration, so connection-string SSL directives are canonicalized here and
   * stripped from the URL handed to `pg` — otherwise pg's own URL parser would
   * replace `ssl` wholesale (verified empirically on the installed pg 8.23.1:
   * `?sslmode=disable` defeats verified TLS; `?sslmode=require` silently discards a
   * configured CA; `?sslcert=...` reads files from disk). The default for remote
   * hosts stays VERIFIED TLS (`{ rejectUnauthorized: true }`, Node's system trust
   * store — PlanetScale Postgres requires TLS with `verify-full` semantics).
   */
  const directives = collectUrlSslDirectives(parsed.url);
  const resolvedSsl = resolveVerifiedTlsFromUrl({
    adapter: id,
    isLocal,
    explicitSsl: options.ssl,
    directives,
  });
  const ssl =
    resolvedSsl !== undefined ? resolvedSsl : isLocal ? false : { rejectUnauthorized: true };

  const poolConfig: PgPoolConfig = {
    // Strip URL SSL parameters so pg cannot re-apply/override the resolved policy
    // (a no-op transformation of the original string when the URL carries none).
    connectionString: directives.all.length > 0 ? stripUrlSslParams(parsed.url) : options.connectionString,
    max: options.max ?? 10,
    ...(options.idleTimeoutMillis !== undefined ? { idleTimeoutMillis: options.idleTimeoutMillis } : {}),
    ...(options.connectionTimeoutMillis !== undefined
      ? { connectionTimeoutMillis: options.connectionTimeoutMillis }
      : {}),
    ssl,
    ...(options.statementTimeout !== undefined ? { statement_timeout: options.statementTimeout } : {}),
    application_name: 'dbsdk',
    ...options.pool,
  };
  // Final safety net for the verified-TLS policy: even the `pool` escape hatch may
  // not produce an unencrypted remote connection.
  if (poolConfig.ssl === false && !isLocal) {
    throw new ConfigurationError(
      id,
      'planetscale: the final pool configuration disables TLS (ssl: false) for a non-local host. ' +
        'PlanetScale Postgres requires TLS (official sslmode=verify-full); refusing to connect ' +
        'unencrypted. Use localhost for local no-TLS testing.',
    );
  }

  const engine = createPgEngine({
    id,
    poolFactory: options.poolFactory ?? ((config) => new Pool(config) as unknown as PgPoolLike),
    poolConfig,
    guard,
    capabilities: planetScaleCapabilities(mode),
  });

  const resolved: PlanetScaleResolvedConnection = {
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    username: parsed.username,
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
