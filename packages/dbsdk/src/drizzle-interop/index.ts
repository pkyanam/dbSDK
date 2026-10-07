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
 * 4. Error boundary is normalized at every execution boundary. Only
 *    pre-execution validation uses `DbError` code `CONFIGURATION`. Query,
 *    transaction and batch execution through the returned Drizzle instance
 *    IS normalized into dbSDK's `DbError` — same classification
 *    (`code`, `sqlstate`, `retryable`) and the same indeterminate-write policy
 *    as `db.sql` / `db.query` / `db.transaction`, with the native driver error
 *    preserved on `cause`. Drizzle's own `DrizzleQueryError` wrapper (whose
 *    message echoes raw SQL parameters) is unwrapped at the bridge boundary;
 *    no automatic retries or replay of writes are ever performed.
 * 5. Raw escapes remain raw. `drizzleDb.$client` is the dbSDK-owned pool (TCP)
 *    or neon query function (HTTP) — calls made directly through it (or
 *    through `db.raw`) bypass this normalization layer, exactly like `db.raw`.
 *
 * Types are imported only here, in the optional entry. `dbsdk` root imports
 * never reference Drizzle, and importing this entry without calling a factory
 * has no side effects (no pool, no client, no network).
 *
 * Type boundary: this entry's declaration file never names the
 * `@neondatabase/serverless` peer, so a consumer running only the PostgreSQL
 * bridge (pg + drizzle-orm installed) typechecks it cleanly even with
 * `skipLibCheck: false`. The Neon-specific parts of the surface are described by the
 * dbSDK-owned structural contracts below — including a peer-free,
 * member-for-member mirror of the official `neon()` client
 * (`NeonHttpNativeClientContract`) that keeps explicit-schema calls
 * (`drizzleNeonHttp<MySchema>(db, …)`) on the full official `$client` surface.
 * The driver-typed declaration of `drizzleNeonHttp` (for consumers who name
 * `NeonHttpDatabase` / `NeonQueryFunction` directly) is the separate
 * `dbsdk/drizzle/neon-http` type entry over the same runtime module.
 */

import { DbError } from '../errors.js';
import type { Database } from '../types.js';
import type { PgPoolLike } from '../adapters/pg-engine.js';
import type { SupabaseRaw } from '../adapters/supabase.js';
import type { NeonRaw } from '../adapters/neon.js';
import { loadNeonHttpBridge, loadPgBridge, type NeonHttpBridge, type PgBridge } from './sessions.js';
import type { NeonHttpClient } from 'drizzle-orm/neon-http';

/** Drizzle's node-postgres client type (from the stable driver's own contract). */
import type { Pool } from 'pg';
/** Root re-exports `DrizzleConfig` in stable 0.45.x (src/index.ts re-exports ./utils). */
import type { DrizzleConfig } from 'drizzle-orm';
import type { BatchItem, BatchResponse } from 'drizzle-orm/batch';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

/*
 * Implementation-internal driver types. These appear ONLY inside function
 * bodies and non-exported asserts predicates below — never in an exported
 * signature — so the emitted `index.d.ts` stays free of
 * `@neondatabase/serverless` and pg-only consumers can typecheck this entry.
 * `scripts/drizzle-peer-types-fence.mjs` guards that invariant on every build.
 */

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

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * Peer-free Neon HTTP driver contracts.
 *
 * TypeScript resolves every type named in a declaration file eagerly, so the
 * shared `dbsdk/drizzle` entry may not reference `@neondatabase/serverless` —
 * not even in the signature of {@link drizzleNeonHttp}, which a PostgreSQL-only
 * consumer never calls (a single peer-typed name here makes `tsc
 * --skipLibCheck:false` fail for every pg-only consumer of this entry, and drags
 * `drizzle-orm/neon-http`'s own peer-typed declarations into their build too).
 *
 * These mirrors describe, with dbSDK-owned types, exactly the parts of the Neon
 * HTTP driver surface the bridge and its consumers use. They are structural
 * contracts, not weaker replacements:
 *
 * - A database built by `dbsdk/neon` satisfies `NeonRawContract`, and
 *   {@link drizzleNeonHttp} still infers the driver's own
 *   `NeonQueryFunction<false, true>` for `$client` on such databases.
 * - Result shapes are exact mirrors of the driver's, so select / insert /
 *   update / delete / execute / RQB types are identical to the driver-typed
 *   path (proven in tests/types/drizzle-neon-contract.test-d.ts).
 * - The database contract cannot be a structural stand-in for the driver's
 *   `NeonHttpDatabase` in the reverse direction (it is a class with protected
 *   members, so nothing can be assigned *to* it). Code that must name the
 *   driver's exact types — or call `db.raw.sql.transaction` on a contract-typed
 *   client — imports `dbsdk/drizzle/neon-http`, the driver-typed declaration of
 *   the same runtime function, which therefore requires the Neon peer.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Result row metadata, mirroring the driver's `FieldDef`. */
interface NeonFieldDefContract {
  name: string;
  tableID: number;
  columnID: number;
  dataTypeID: number;
  dataTypeSize: number;
  dataTypeModifier: number;
  format: string;
}

/** Rows as the driver returns them, mirroring the driver's `QueryRows`. */
type NeonQueryRowsContract<ArrayMode extends boolean> = ArrayMode extends true
  ? unknown[][]
  : Record<string, unknown>[];

/** Full result envelope, mirroring the driver's `FullQueryResults`. */
interface NeonFullQueryResultsContract<ArrayMode extends boolean> {
  fields: NeonFieldDefContract[];
  command: string;
  rowCount: number;
  rows: NeonQueryRowsContract<ArrayMode>;
  rowAsArray: ArrayMode;
}

/**
 * Query result as Drizzle's neon-http driver maps it — an exact structural
 * mirror of `NeonHttpQueryResult<T>` from `drizzle-orm/neon-http`, rebuilt
 * without the driver's types.
 */
export type NeonHttpQueryResultContract<T> = Omit<NeonFullQueryResultsContract<false>, 'rows'> & {
  rows: T[];
};

/**
 * The Neon HTTP query function as the bridge and its consumers use it: callable
 * with template literals and with `query(text, params)`. This is the shape
 * `Database<NeonRaw>['raw']['sql']` exposes; when the database was built by
 * `dbsdk/neon` (driver installed), {@link drizzleNeonHttp} infers `$client` as
 * the driver's own `NeonQueryFunction<false, true>` instead of this contract.
 * This permissive contract is also what the second overload of
 * {@link drizzleNeonHttp} uses as its default, so calls with a custom,
 * narrower `sql` are never claimed to have the official client's full surface.
 */
export interface NeonHttpClientContract {
  (strings: TemplateStringsArray, ...params: any[]): Promise<NeonHttpQueryResultContract<Record<string, unknown>>>;
  query(text: string, params?: any[]): Promise<NeonHttpQueryResultContract<Record<string, unknown>>>;
}

/**
 * Mirrors the Neon adapter's `NeonTransactionTransport` union (kept in sync by
 * tests/types/drizzle-neon-contract.test-d.ts).
 */
export type NeonTransactionTransportContract = 'none' | 'postgres' | 'websocket';

/**
 * Structural contract for the Neon adapter's raw handle — mirrors `NeonRaw`
 * from `dbsdk/neon` without referencing the driver. Databases built by
 * `dbsdk/neon` satisfy it; the transport gates are unchanged and still checked
 * at runtime (HTTP only for this factory).
 */
export type NeonRawContract =
  | {
      transport: 'http';
      transactionTransport: NeonTransactionTransportContract;
      sql: NeonHttpClientContract;
    }
  | {
      transport: 'websocket';
      pool: PgPoolLike;
    };

/** Drizzle's result-kind mapping for the neon-http driver, rebuilt peer-free. */
export interface NeonHttpQueryResultHKTContract extends PgQueryResultHKT {
  type: NeonHttpQueryResultContract<this['row']>;
}

/** The members the neon-http driver adds on top of `PgDatabase` (mirrors `NeonHttpDatabase.batch` and `$withAuth`). */
export interface NeonHttpDatabaseExtras {
  batch<U extends BatchItem<'pg'>, T extends Readonly<[U, ...U[]]>>(batch: T): Promise<BatchResponse<T>>;
  /** Log in with an auth token for subsequent queries (mirrors `NeonHttpDatabase.$withAuth`). */
  $withAuth(token: string | (() => Promise<string> | string)): Omit<this, Exclude<keyof this, '$count' | 'delete' | 'select' | 'selectDistinct' | 'selectDistinctOn' | 'update' | 'insert' | 'with' | 'query' | 'execute' | 'refreshMaterializedView'>>;
}

/**
 * The database {@link drizzleNeonHttp} returns, described without the driver's
 * types. Every query surface behaves identically to Drizzle's
 * `NeonHttpDatabase<TSchema>` (proven identical in the type tests); what is
 * absent is the driver-nominal framing (the `NeonHttpDatabase` class itself and
 * the internal `_` session accessor). `$client` is generic so callers whose raw
 * handle is strongly typed get the driver's own client type via
 * {@link NeonHttpClientOf}.
 */
export type NeonHttpDatabaseContract<
  TSchema extends Record<string, unknown> = Record<string, never>,
  TClient extends NeonHttpClientContract = NeonHttpClientContract,
> = Omit<PgDatabase<NeonHttpQueryResultHKTContract, TSchema>, '_'> &
  NeonHttpDatabaseExtras & {
    $client: TClient;
  };

/**
 * The query-function type a given raw handle exposes — for a database built by
 * `dbsdk/neon` this is the driver's own `NeonQueryFunction<false, true>`.
 */
export type NeonHttpClientOf<TRaw extends NeonRawContract> = TRaw extends {
  transport: 'http';
  sql: infer S;
}
  ? S
  : never;

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * Native-shaped Neon client contract (the explicit-schema-call default).
 *
 * Why a second default exists: when a caller supplies an explicit schema type
 * argument (`drizzleNeonHttp<MySchema>(db, …)`), TypeScript does not infer a
 * defaulted type parameter from the arguments — it uses the default (verified
 * against TS 5.9.3; a non-defaulted trailing type parameter is not allowed
 * after a defaulted one either — TS2706 — and dropping the default makes every
 * such call a hard TS2558 "Expected 2 type arguments"). The R1 design's
 * default (`NeonRawContract`) therefore silently downgraded `$client` to the
 * permissive contract for exactly that pre-existing call form.
 *
 * The default is now `NeonHttpNativeRawContract` below: a peer-free,
 * member-for-member mirror of the official `neon()` query function as the
 * `dbsdk/neon` adapter creates it (`fullResults: true`, `arrayMode` off), so
 * the explicit-schema form keeps the full official `$client` surface
 * (`.query()` with options and array/full-result modes, `.unsafe()`,
 * `.transaction()`, inspectable query-promise metadata). A second overload of
 * {@link drizzleNeonHttp} keeps the R1 default (`NeonRawContract`) for raw
 * handles that are not assignable to the native shape, so custom, narrower
 * `sql` types are never claimed to have the official client's full surface.
 *
 * Provenance: the mirrors below are re-derived structural descriptions of
 * `@neondatabase/serverless` 1.2.0 declarations (MIT — see
 * THIRD_PARTY_NOTICES.md), not imports and not copies of source code; the
 * file never names the peer. Honesty is enforced bidirectionally in
 * tests/types/drizzle-neon-contract.test-d.ts:
 * `NeonQueryFunction<false, true>` and `NeonHttpNativeClientContract` must
 * remain assignable in BOTH directions. They are deliberately NOT claimed to
 * be alias-identical to the peer's types — structural equivalence is what
 * every call, member access and assignment needs, and it keeps the shared
 * declaration peer-free.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Connection-style parameters, mirroring the peer's (private) `ConnectionParams`. */
type NeonConnectionParamsContract = {
  [K in 'connectionString' | 'user' | 'username' | 'password' | 'host' | 'hostname' | 'port' | 'database']?: K extends 'port'
    ? string | number | (() => string | number | Promise<string | number>)
    : string | (() => string | Promise<string>);
};

/** Custom type parsers, mirroring the peer's `CustomTypesConfig`. */
interface NeonCustomTypesContract {
  getTypeParser: (id: number, format?: 'text' | 'binary') => any;
}

/**
 * Per-query options, mirroring the peer's `HTTPQueryOptions<ArrayMode,
 * FullResults>`; `arrayMode`/`fullResults` are typed by the surrounding
 * generics exactly as in the peer.
 */
interface NeonHttpQueryOptionsContract<ArrayMode extends boolean, FullResults extends boolean>
  extends NeonConnectionParamsContract {
  arrayMode?: ArrayMode;
  fullResults?: FullResults;
  fetchOptions?: Record<string, any>;
  authToken?: string | (() => Promise<string> | string);
  types?: NeonCustomTypesContract;
  disableWarningInBrowsers?: boolean;
}

/**
 * Transaction-level options, mirroring the peer's
 * `HTTPTransactionOptions<ArrayMode, FullResults>`.
 */
interface NeonHttpTransactionOptionsContract<ArrayMode extends boolean, FullResults extends boolean>
  extends NeonHttpQueryOptionsContract<ArrayMode, FullResults> {
  isolationLevel?: 'ReadUncommitted' | 'ReadCommitted' | 'RepeatableRead' | 'Serializable';
  readOnly?: boolean;
  deferrable?: boolean;
}

/** Tagged-template payload, mirroring the peer's `SqlTemplate` class instance. */
interface NeonSqlTemplateContract {
  strings: ReadonlyArray<string>;
  values: any[];
  toParameterizedQuery(result?: { query: string; params: any[] }): { query: string; params: any[] };
}

/** A prepared statement, mirroring the peer's `ParameterizedQuery`. */
interface NeonParameterizedQueryContract {
  query: string;
  params: any[];
}

/** Raw SQL fragment marker, mirroring the peer's `UnsafeRawSql` class instance. */
interface NeonUnsafeRawSqlContract {
  sql: string;
}

/**
 * The awaited-yet-inspectable query promise, mirroring the peer's
 * `NeonQueryPromise<ArrayMode, FullResults, T>` — an interface extending
 * `Promise<T>` merged with the class's instance members (`execute`,
 * `queryData`, `opts`). This is what a call or `.query()` returns BEFORE
 * awaiting, so callers can inspect the payload/metadata without any runtime
 * change (it is the same object the driver produced).
 */
export interface NeonHttpQueryPromiseContract<ArrayMode extends boolean, FullResults extends boolean, T = any>
  extends Promise<T> {
  execute: (
    queryData: NeonSqlTemplateContract | NeonParameterizedQueryContract | (NeonSqlTemplateContract | NeonParameterizedQueryContract)[],
    opts?: NeonHttpQueryOptionsContract<ArrayMode, FullResults> | NeonHttpQueryOptionsContract<ArrayMode, FullResults>[],
  ) => Promise<T>;
  queryData: NeonSqlTemplateContract | NeonParameterizedQueryContract;
  opts?: NeonHttpQueryOptionsContract<ArrayMode, FullResults> | undefined;
}

/** Mirrors the peer's `NeonQueryInTransaction`. */
interface NeonHttpQueryInTransactionContract {
  queryData: NeonSqlTemplateContract | NeonParameterizedQueryContract;
}

/** The per-transaction query function, mirroring the peer's `NeonQueryFunctionInTransaction`. */
interface NeonHttpInTransactionClientContract<ArrayMode extends boolean, FullResults extends boolean> {
  (strings: TemplateStringsArray, ...params: any[]): NeonHttpQueryPromiseContract<
    ArrayMode,
    FullResults,
    FullResults extends true ? NeonFullQueryResultsContract<ArrayMode> : NeonQueryRowsContract<ArrayMode>
  >;
  query(queryWithPlaceholders: string, params?: any[]): NeonHttpQueryPromiseContract<
    ArrayMode,
    FullResults,
    FullResults extends true ? NeonFullQueryResultsContract<ArrayMode> : NeonQueryRowsContract<ArrayMode>
  >;
  unsafe(rawSQL: string): NeonUnsafeRawSqlContract;
}

/**
 * The official `neon()` query function as the `dbsdk/neon` adapter creates it
 * (`fullResults: true`), described without importing
 * `@neondatabase/serverless`. Member-for-member mirror of the peer's
 * `NeonQueryFunction<false, true>`: bidirectionally assignable to it (tested),
 * so `$client` from an explicit-schema call produces and accepts exactly what
 * the pre-contract signature exposed. `.transaction()` is typed as the peer
 * types it, and the peer's own runtime implements it (an HTTP round-trip,
 * non-interactive atomic batch). What throws at runtime is Drizzle's
 * ORM-level interactive `db.transaction(...)` on the returned instance —
 * documented below; the mirror describes the client exactly as the peer does.
 */
export interface NeonHttpNativeClientContract {
  (strings: TemplateStringsArray, ...params: any[]): NeonHttpQueryPromiseContract<false, true, NeonFullQueryResultsContract<false>>;
  query<ArrayModeOverride extends boolean = false, FullResultsOverride extends boolean = true>(
    queryWithPlaceholders: string,
    params?: any[],
    queryOpts?: NeonHttpQueryOptionsContract<ArrayModeOverride, FullResultsOverride>,
  ): NeonHttpQueryPromiseContract<
    ArrayModeOverride,
    FullResultsOverride,
    FullResultsOverride extends true ? NeonFullQueryResultsContract<ArrayModeOverride> : NeonQueryRowsContract<ArrayModeOverride>
  >;
  unsafe(rawSQL: string): NeonUnsafeRawSqlContract;
  transaction: <ArrayModeOverride extends boolean = false, FullResultsOverride extends boolean = true>(
    queriesOrFn:
      | NeonHttpQueryPromiseContract<false, true>[]
      | ((sql: NeonHttpInTransactionClientContract<ArrayModeOverride, FullResultsOverride>) => NeonHttpQueryInTransactionContract[]),
    opts?: NeonHttpTransactionOptionsContract<ArrayModeOverride, FullResultsOverride>,
  ) => Promise<FullResultsOverride extends true ? NeonFullQueryResultsContract<ArrayModeOverride>[] : NeonQueryRowsContract<ArrayModeOverride>[]>;
}

/**
 * The raw handle the `dbsdk/neon` adapter creates for the HTTP transport,
 * described without importing the peer — the default of {@link drizzleNeonHttp}'s
 * second type parameter (first overload), so an explicit-schema call keeps the
 * official client's full surface on `$client`. A database built by `dbsdk/neon`
 * satisfies it; a custom raw handle with a narrower `sql` does not, and for
 * those the second overload (default {@link NeonRawContract}) applies — pass
 * the raw type as the second type argument or omit the schema argument to stay
 * on the permissive contract typing.
 */
export type NeonHttpNativeRawContract =
  | {
      transport: 'http';
      transactionTransport: NeonTransactionTransportContract;
      sql: NeonHttpNativeClientContract;
    }
  | {
      transport: 'websocket';
      pool: PgPoolLike;
    };

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

  let bridge: PgBridge;
  try {
    bridge = await loadPgBridge();
  } catch (cause) {
    throw missingPeerError(cause);
  }
  // The pool is structurally validated above; the `Pool` cast is TypeScript
  // bookkeeping to satisfy the driver's declared client type (pg.Pool has a
  // wider surface than the structural PgPoolLike dbSDK guarantees). No config
  // path exists here that could make Drizzle build its own pool: the DSN /
  // `connection` / `client` inputs are rejected above, at compile time and at
  // runtime, before this call.
  return bridge.buildNodePgDatabase(pool as unknown as Pool, rebuildDrizzleConfig(config), db.adapterId);
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
 * Types: this signature is peer-free — it is written against the dbSDK-owned
 * structural contracts above so that PostgreSQL-only consumers (pg +
 * drizzle-orm installed, no `@neondatabase/serverless`) can typecheck this
 * entry. It is not a weaker surface, and the explicit-schema call form is
 * preserved (R4):
 *
 * - Inferred generics, `drizzleNeonHttp(db, { schema })`: for a database built
 *   by `dbsdk/neon` the returned `$client` is exactly the driver's own
 *   `NeonQueryFunction<false, true>`.
 * - Explicit schema argument, `drizzleNeonHttp<MySchema>(db, …)`: TypeScript
 *   uses a defaulted type parameter's default instead of inferring it, so the
 *   default is `NeonHttpNativeRawContract` — a peer-free, member-for-member
 *   mirror of the official client — and `$client` keeps the full official
 *   surface (`.query()` with per-call options and array/full-result modes,
 *   `.unsafe()`, `.transaction()`, inspectable query-promise metadata) and is
 *   bidirectionally assignable to `NeonQueryFunction<false, true>`.
 * - Custom raw handles with a narrower `sql`: pass the raw type as the second
 *   type argument (`drizzleNeonHttp<MySchema, MyRaw>(db, …)`) or omit the
 *   schema argument. The second overload (default `NeonRawContract`) keeps
 *   those calls on the permissive {@link NeonHttpClientContract} — a custom
 *   `sql` is never claimed to have the official client's full surface.
 * - To name the driver's exact `NeonHttpDatabase` / `NeonQueryFunction`
 *   classes, import the same function from `dbsdk/drizzle/neon-http` (requires
 *   the Neon peer, like the driver itself).
 *
 * Every query result type is identical to the driver-typed path
 * (tests/types/drizzle-neon-contract.test-d.ts).
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
export function drizzleNeonHttp<
  TSchema extends Record<string, unknown> = Record<string, never>,
  TRaw extends NeonRawContract = NeonHttpNativeRawContract,
>(
  db: Database<TRaw>,
  config?: DrizzleInteropConfig<TSchema>,
): Promise<NeonHttpDatabaseContract<TSchema, NeonHttpClientOf<TRaw>>>;
export function drizzleNeonHttp<
  TSchema extends Record<string, unknown> = Record<string, never>,
  TRaw extends NeonRawContract = NeonRawContract,
>(
  db: Database<TRaw>,
  config?: DrizzleInteropConfig<TSchema>,
): Promise<NeonHttpDatabaseContract<TSchema, NeonHttpClientOf<TRaw>>>;
export async function drizzleNeonHttp<
  TSchema extends Record<string, unknown>,
  TRaw extends NeonRawContract,
>(
  db: Database<TRaw>,
  config?: DrizzleInteropConfig<TSchema>,
): Promise<NeonHttpDatabaseContract<TSchema, NeonHttpClientOf<TRaw>>> {
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

  let bridge: NeonHttpBridge;
  try {
    bridge = await loadNeonHttpBridge();
  } catch (cause) {
    throw missingPeerError(cause);
  }
  // Pass the actual raw.sql handle straight through (no wrapper, no
  // re-derivation): the stable driver passes { arrayMode, fullResults: true }
  // per call, so dbSDK's fullResults:true instance behaves identically. The
  // runtime object is the dbSDK-owned neon function, not a construction input
  // (DSN/connection/client paths are rejected above).
  //
  // The `as unknown as` below only re-frames the SAME runtime object the driver
  // returned into the peer-free contract this entry exports: the instance
  // satisfies `NeonHttpDatabaseContract` (proven in
  // tests/types/drizzle-neon-contract.test-d.ts), and for callers whose raw handle
  // is strongly typed `$client` is exactly the driver's own
  // `NeonQueryFunction<false, true>` via `NeonHttpClientOf<TRaw>`. The
  // per-caller refinement cannot be re-verified at this cast site because the
  // caller's raw type is abstracted behind the generic `TRaw`.
  return bridge.buildNeonHttpDatabase(
    sql as unknown as NeonHttpClient,
    rebuildDrizzleConfig(config),
    db.adapterId,
  ) as unknown as NeonHttpDatabaseContract<TSchema, NeonHttpClientOf<TRaw>>;
}
