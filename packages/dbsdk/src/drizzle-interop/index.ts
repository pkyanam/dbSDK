/**
 * `dbsdk/drizzle` — Drizzle ORM interoperability over dbSDK-owned connections.
 *
 * Two async factories hand a validated, dbSDK-owned driver handle to Drizzle's
 * stable node-postgres / neon-http drivers:
 *
 * - `drizzlePostgres(db, config?)` — for `dbsdk/postgres` and `dbsdk/supabase`
 *   in `direct`/`session` mode (any `sessionState: true` TCP database).
 * - `drizzleNeonHttp(db, config?)` — for `dbsdk/neon` with the HTTP transport.
 *
 * Hard rules (see coordination/drizzle-research-r1.md §D.2 and the R2 contract):
 *
 * 1. Only dbSDK-owned handles. Drizzle's `drizzle()` also accepts a DSN or a
 *    `{ connection: ... }` config and would construct its own `pg.Pool` /
 *    `neon()` client, silently bypassing dbSDK's TLS posture (certificate
 *    verification ON by default, CA pinning) and lifetime ownership. This
 *    bridge rejects those fields at compile time (the config type has no such
 *    keys) AND at runtime (JS callers), before any dispatch.
 * 2. Guarded poolers are refused. dbSDK's pre-dispatch guards (e.g. Supabase
 *    transaction-pooler session-state rules) live in dbSDK's query functions,
 *    not in the pool. Drizzle executes through the pool directly and would
 *    bypass them, so a `sessionState: false` transaction pooler is refused
 *    BEFORE the raw handle is touched or the pool is created. Neon HTTP is a
 *    separate explicit factory (no session state to guard, no pool at all).
 * 3. Lifetime stays with the caller's `db.close()`. Drizzle never ends the
 *    pool it is given. After `db.close()`, using the returned Drizzle instance
 *    fails (the pool was ended) and no pool is ever recreated.
 * 4. Error boundary is honest. Only pre-execution validation in this module
 *    uses dbSDK error conventions (`DbError`, code `CONFIGURATION`). Query,
 *    transaction and batch execution through the returned Drizzle instance
 *    surface native Drizzle / driver errors — they are NOT normalized into
 *    `DbError`, and dbSDK's indeterminate-write semantics do not extend to
 *    Drizzle's executor.
 *
 * Types are imported only here, in the optional entry. `dbsdk` root imports
 * never reference Drizzle, and importing this entry without calling a factory
 * has no side effects (no pool, no client, no network).
 */

import { DbError } from '../errors.js';
import type { Database } from '../types.js';
import type { PgPoolLike } from '../adapters/pg-engine.js';
import type { SupabaseRaw } from '../adapters/supabase.js';
import type { NeonRaw } from '../adapters/neon.js';

/** Drizzle's node-postgres client type (from the stable driver's own contract). */
import type { Pool } from 'pg';
/** Root re-exports `DrizzleConfig` in stable 0.45.x (src/index.ts re-exports ./utils). */
import type { DrizzleConfig } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import type { NeonQueryFunction } from '@neondatabase/serverless';

/** Version constraint this bridge is written and verified against (stable line, not 1.0 RC). */
const DRIZZLE_PEER_RANGE = '^0.45.3';

/**
 * Bridge configuration — a subset of Drizzle's stable `DrizzleConfig<TSchema>`
 * (schema for relational queries, logger, casing). Deliberately omits
 * `connection`/`client` (native construction) and `cache` (not offered yet):
 * unknown keys are rejected by TypeScript and by the runtime check below.
 */
export type DrizzleInteropConfig<TSchema extends Record<string, unknown> = Record<string, never>> =
  Pick<DrizzleConfig<TSchema>, 'schema' | 'logger' | 'casing'>;

/** Raw handles accepted by {@link drizzlePostgres}: a bare pg pool or the Supabase wrapper. */
export type PgBridgeRaw = PgPoolLike | SupabaseRaw;

function configurationError(message: string, cause?: unknown): DbError {
  return new DbError(message, {
    code: 'CONFIGURATION',
    retryable: false,
    indeterminate: false,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function missingPeerError(cause: unknown): DbError {
  return configurationError(
    `The optional peer dependency "drizzle-orm" (${DRIZZLE_PEER_RANGE}) is required by dbsdk/drizzle ` +
      'but is not installed in this project. Install it with ' +
      `"npm i drizzle-orm@${DRIZZLE_PEER_RANGE}" or "pnpm add drizzle-orm@${DRIZZLE_PEER_RANGE}", ` +
      'then retry. (dbsdk itself stays dependency-free: the Drizzle entry is lazy.)',
    cause,
  );
}

/** Keys that would make Drizzle construct its OWN pool/client, bypassing dbSDK. */
const FORBIDDEN_CONFIG_KEYS = ['connection', 'client', 'connectionString'] as const;

function assertNoNativeConstructionConfig(config: unknown): void {
  if (typeof config === 'string') {
    throw configurationError(
      'dbsdk/drizzle: do not pass a connection string / DSN to the Drizzle bridge. ' +
        'Pass the Database you built with createDatabase({ adapter: ... }); the bridge hands Drizzle ' +
        'the already-validated, dbSDK-owned driver handle so TLS and lifetime settings cannot be bypassed.',
    );
  }
  if (config === null || config === undefined) return;
  if (typeof config !== 'object') {
    throw configurationError('dbsdk/drizzle: config must be an object.');
  }
  for (const key of FORBIDDEN_CONFIG_KEYS) {
    if (key in config) {
      throw configurationError(
        `dbsdk/drizzle: config.${key} is not accepted. Drizzle would use it to construct its own ` +
          'pool/client, bypassing dbSDK\'s validated TLS posture and connection lifetime. ' +
          'Pass only { schema, logger, casing }.',
      );
    }
  }
}

/** Structural checks that the input is a genuine dbSDK `Database` client. */
function assertDatabaseClient(db: unknown): asserts db is Database<PgBridgeRaw | NeonRaw> {
  if (typeof db !== 'object' || db === null) {
    throw configurationError(
      'dbsdk/drizzle: expected a Database created by createDatabase({ adapter: ... }). ' +
        'The bridge does not build connections itself — provision or connect first (dbsdk/management, dbsdk/postgres, ...).',
    );
  }
  const record = db as Record<string, unknown>;
  if (record['engine'] !== 'postgresql') {
    throw configurationError(
      `dbsdk/drizzle: expected a dbSDK PostgreSQL database (engine "postgresql"), got ${String(record['engine'])}.`,
    );
  }
  if (typeof record['adapterId'] !== 'string' || record['adapterId'].length === 0) {
    throw configurationError('dbsdk/drizzle: the object does not look like a dbSDK Database (missing adapterId).');
  }
  const capabilities = record['capabilities'];
  if (typeof capabilities !== 'object' || capabilities === null) {
    throw configurationError('dbsdk/drizzle: the object does not look like a dbSDK Database (missing capabilities).');
  }
  const transport = (capabilities as Record<string, unknown>)['transport'];
  if (transport !== 'tcp' && transport !== 'http' && transport !== 'websocket') {
    throw configurationError('dbsdk/drizzle: the object does not look like a dbSDK Database (bad capabilities).');
  }
  for (const method of ['sql', 'query', 'batch', 'transaction', 'close'] as const) {
    if (typeof record[method] !== 'function') {
      throw configurationError(`dbsdk/drizzle: the object does not look like a dbSDK Database (missing ${method}()).`);
    }
  }
  if (typeof (record as unknown as AsyncDisposable)[Symbol.asyncDispose] !== 'function') {
    throw configurationError(
      'dbsdk/drizzle: the object does not look like a dbSDK Database (not AsyncDisposable).',
    );
  }
}

/**
 * PG bridge mode gates — checked BEFORE the raw handle is read, so a refused
 * database never has its pool created (pg engines create the pool lazily on
 * first `raw` access).
 */
function assertPgBridgeMode(db: Database<PgBridgeRaw | NeonRaw>): void {
  const { capabilities } = db;
  if (capabilities.transport === 'http') {
    throw configurationError(
      `dbsdk/drizzle: database "${db.adapterId}" uses the HTTP transport. ` +
        'For a Neon HTTP database use drizzleNeonHttp(db) instead — it hands Drizzle the neon query function, not a pool.',
    );
  }
  if (capabilities.transport === 'websocket') {
    throw configurationError(
      `dbsdk/drizzle: database "${db.adapterId}" uses the websocket transport, which is not a verified ` +
        'supported mode of this bridge. Use a TCP adapter (dbsdk/postgres, or dbsdk/supabase in ' +
        '"direct" or "session" mode).',
    );
  }
  // transport === 'tcp' here. A transaction-mode pooler (Supabase "transaction",
  // Neon pooled endpoints) reports sessionState: false, and dbSDK's per-statement
  // guards live outside the pool — Drizzle through the pool would bypass them.
  if (!capabilities.sessionState) {
    throw configurationError(
      `dbsdk/drizzle: refusing database "${db.adapterId}" (sessionState: false). ` +
        'Transaction-mode poolers are not safe to hand to Drizzle: dbSDK\'s pre-dispatch session-state ' +
        'guards live in its query functions, not in the pool, so Drizzle execution would bypass them. ' +
        'Use dbsdk/supabase with connectionMode "direct" or "session", or an ordinary PostgreSQL endpoint.',
    );
  }
}

function assertPoolLike(pool: unknown, origin: string): asserts pool is PgPoolLike {
  if (typeof pool !== 'object' || pool === null) {
    throw configurationError(`dbsdk/drizzle: ${origin} is not a usable pg pool object.`);
  }
  for (const method of ['query', 'connect', 'end'] as const) {
    if (typeof (pool as Record<string, unknown>)[method] !== 'function') {
      throw configurationError(
        `dbsdk/drizzle: ${origin} does not implement ${method}() — not a pg pool-shaped handle. ` +
          'The bridge accepts only the dbSDK-owned raw pool (Database.raw).',
      );
    }
  }
}

/**
 * Resolve the pool to hand to Drizzle. Called only after the mode gates pass,
 * so the lazy pool is created at most once, here, for an accepted mode. For a
 * closed database the adapter's own raw getter throws its closed error, which
 * propagates unchanged (dbSDK error conventions).
 */
function resolvePgPool(raw: PgBridgeRaw): PgPoolLike {
  // Supabase exposes { pool, connectionMode, resolved }; the pool getter is
  // lazy, so accessing it here (post-gate) is the intended first creation.
  const pool = 'pool' in raw ? raw.pool : raw;
  assertPoolLike(pool, 'Database.raw');
  return pool;
}

/**
 * Hand a dbSDK-owned PostgreSQL pool to Drizzle's stable node-postgres driver.
 *
 * ```ts
 * import { createDatabase } from "dbsdk";
 * import { postgres } from "dbsdk/postgres";
 * import { drizzlePostgres } from "dbsdk/drizzle";
 * import * as schema from "./schema"; // your drizzle-orm/pg-core tables
 *
 * const db = createDatabase({ adapter: postgres({ connectionString: process.env.DATABASE_URL! }) });
 * const drizzleDb = await drizzlePostgres(db, { schema });
 * const rows = await drizzleDb.select().from(schema.users);
 * await db.close(); // YOU still own the lifetime; Drizzle never ends the pool
 * ```
 *
 * Supported: `dbsdk/postgres`, `dbsdk/supabase` in `direct`/`session` mode —
 * any TCP database reporting `sessionState: true`. Refused before the pool is
 * created: HTTP/websocket transports and every `sessionState: false`
 * transaction-mode pooler. Creating the instance materializes the lazy pool
 * (Drizzle needs the live handle); afterwards `db.close()` ends it, and the
 * returned instance fails on use — the pool is never recreated.
 */
export async function drizzlePostgres<
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: Database<PgBridgeRaw>,
  config?: DrizzleInteropConfig<TSchema>,
): Promise<NodePgDatabase<TSchema> & { $client: Pool }> {
  assertDatabaseClient(db);
  assertPgBridgeMode(db);
  assertNoNativeConstructionConfig(config);
  const pool = resolvePgPool(db.raw);

  let drizzle: typeof import('drizzle-orm/node-postgres')['drizzle'];
  try {
    ({ drizzle } = await import('drizzle-orm/node-postgres'));
  } catch (cause) {
    throw missingPeerError(cause);
  }
  // The pool is structurally validated above; the `Pool` cast is TypeScript
  // bookkeeping to satisfy the driver's declared client type (pg.Pool has a
  // wider surface than the structural PgPoolLike dbSDK guarantees). No config
  // path exists here that could make Drizzle build its own pool: the DSN /
  // `connection` / `client` inputs are rejected above, at compile time and at
  // runtime, before this call.
  return drizzle<TSchema, Pool>(
    pool as unknown as Pool,
    rebuildDrizzleConfig(config),
  ) as NodePgDatabase<TSchema> & { $client: Pool };
}

/**
 * Copy the validated subset into a fresh `DrizzleConfig` object. This is the
 * ONLY object handed to Drizzle — it cannot carry `connection`, `client`, or a
 * DSN (those keys were rejected above and are not part of
 * `DrizzleInteropConfig` in the first place).
 */
function rebuildDrizzleConfig<TSchema extends Record<string, unknown>>(
  config: DrizzleInteropConfig<TSchema> | undefined,
): DrizzleConfig<TSchema> {
  return {
    ...(config?.schema !== undefined ? { schema: config.schema } : {}),
    ...(config?.logger !== undefined ? { logger: config.logger } : {}),
    ...(config?.casing !== undefined ? { casing: config.casing } : {}),
  };
}

/**
 * Hand the dbSDK-owned Neon HTTP query function to Drizzle's stable neon-http
 * driver.
 *
 * ```ts
 * import { createDatabase } from "dbsdk";
 * import { neon } from "dbsdk/neon";
 * import { drizzleNeonHttp } from "dbsdk/drizzle";
 * import * as schema from "./schema";
 *
 * const db = createDatabase({ adapter: neon({ connectionString: process.env.NEON_DB_URL! }) });
 * const drizzleDb = await drizzleNeonHttp(db, { schema });
 * ```
 *
 * Verified against the stable driver: it calls `client.query(sql, params,
 * { arrayMode, fullResults: true })` per query and `client.transaction(...)`
 * for batch — exactly the real `neon()` function exposed on `db.raw.sql`
 * (dbSDK creates it with `fullResults: true`; the driver re-specifies both
 * per call, so no wrapper or re-derivation happens here).
 *
 * Honest limits (the driver's, unchanged): `drizzleDb.transaction(...)`
 * throws "No transactions support in neon-http driver" — use dbSDK's
 * `db.batch` for atomic multi-statement writes, or configure a transaction
 * transport on the adapter for dbSDK-level transactions. No interactive
 * transactions, no session state, no automatic WebSocket fallback, no retry.
 * There is no pool: `db.close()` has nothing to end for the HTTP path, so a
 * previously returned Drizzle instance keeps working after close (it holds no
 * connection) — lifetime matters for the TCP bridge above.
 */
export async function drizzleNeonHttp<
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: Database<NeonRaw>,
  config?: DrizzleInteropConfig<TSchema>,
): Promise<NeonHttpDatabase<TSchema> & { $client: NeonQueryFunction<false, true> }> {
  assertDatabaseClient(db);
  const { capabilities } = db;
  if (capabilities.transport !== 'http') {
    throw configurationError(
      `dbsdk/drizzle: database "${db.adapterId}" does not use the HTTP transport (got ${capabilities.transport}). ` +
        'For TCP databases (postgres, Supabase direct/session) use drizzlePostgres(db). ' +
        'Neon websocket transport is not a verified supported mode of this bridge.',
    );
  }
  assertNoNativeConstructionConfig(config);

  const raw = db.raw;
  if (typeof raw !== 'object' || raw === null || (raw as { transport?: unknown }).transport !== 'http') {
    throw configurationError(
      'dbsdk/drizzle: Database.raw does not look like a Neon HTTP handle (raw.transport !== "http").',
    );
  }
  const sql = (raw as { sql?: unknown }).sql;
  if (typeof sql !== 'function') {
    throw configurationError(
      'dbsdk/drizzle: Database.raw.sql is not the neon query function. The bridge accepts only the ' +
        'dbSDK-owned raw handle from dbsdk/neon with transport "http".',
    );
  }
  // The stable neon-http session resolves `client.query ?? client`; per-call
  // options carry arrayMode/fullResults. Require the v1.0+ `.query` method
  // rather than silently relying on the fallback.
  if (typeof (sql as { query?: unknown }).query !== 'function') {
    throw configurationError(
      'dbsdk/drizzle: the neon query function does not expose .query() — drizzle-orm/neon-http requires ' +
        '@neondatabase/serverless v1.0.0 or newer. Upgrade the driver and rebuild the database.',
    );
  }

  let drizzle: typeof import('drizzle-orm/neon-http')['drizzle'];
  try {
    ({ drizzle } = await import('drizzle-orm/neon-http'));
  } catch (cause) {
    throw missingPeerError(cause);
  }
  // Pass the actual raw.sql handle straight through (no wrapper, no
  // re-derivation): the stable driver passes { arrayMode, fullResults: true }
  // per call, so dbSDK's fullResults:true instance behaves identically. The
  // cast is type bookkeeping against the driver's generic client parameter —
  // the runtime object is the dbSDK-owned neon function, not a construction
  // input (DSN/connection/client paths are rejected above).
  return drizzle<TSchema, NeonQueryFunction<false, true>>(
    sql as unknown as NeonQueryFunction<false, true>,
    rebuildDrizzleConfig(config),
  ) as NeonHttpDatabase<TSchema> & {
    $client: NeonQueryFunction<false, true>;
  };
}
