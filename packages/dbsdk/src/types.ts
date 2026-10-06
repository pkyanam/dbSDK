/**
 * dbSDK core contract — the shared vocabulary between the core client and every adapter.
 *
 * This file is the single source of truth (see coordination/core-contract.md). Adapters import
 * these types via a relative path (`../types.js`), never from `'dbsdk'`, so the package builds
 * each entry standalone.
 *
 * Design invariants:
 * - Parameter values are always bound, never interpolated into SQL text.
 * - Result and error shapes are identical across adapters and transports.
 * - Generics are caller assertions, not runtime schema verification.
 * - Capabilities are declared by the adapter and enforced by the core BEFORE dispatch.
 *   There is no silent fallback, no automatic retry of writes, no provider failover.
 */

/** A parameterized SQL statement. Values are bound, never interpolated. */
export type SqlStatement = {
  text: string;
  /** Optional; adapters may use the simple query protocol when omitted. */
  params?: readonly unknown[];
};

/** Normalized result shape returned by every adapter, for every transport. */
export type QueryResult<Row = Record<string, unknown>> = {
  rows: Row[];
  /** Affected-row count from the database, or `null` when the command does not report one. */
  rowCount: number | null;
  /** The command tag reported by PostgreSQL (e.g. `SELECT`, `INSERT`), when available. */
  command?: string;
};

/** The query surface handed to a `transaction()` callback. */
export type QueryExecutor = {
  query<Row = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
};

/** How a capability's status was established. Mirrors the Social-SDK honesty model. */
export type EvidenceLevel = 'docs' | 'tests' | 'live';

export type DatabaseAdapterCapabilities = {
  /** Interactive `transaction(callback)` with multi-round-trip logic on one session. */
  interactiveTransactions: boolean;
  /** Atomic multi-statement batch: all statements commit together or none do. */
  atomicBatch: boolean;
  /**
   * Session-level state (`SET`, temp objects, `LISTEN/NOTIFY`, session advisory
   * locks) works on a single dedicated session — inside `transaction()` (which
   * leases one connection) or on a client leased via `raw`. With connection-pool
   * adapters, consecutive top-level `query()`/`sql` calls may run on different
   * pooled sessions, so this flag does NOT mean session state persists between
   * separate top-level calls.
   */
  sessionState: boolean;
  /** Underlying transport used for queries. */
  transport: 'tcp' | 'http' | 'websocket';
  /** Evidence level per capability key (e.g. `{ interactiveTransactions: 'tests' }`). */
  evidence: Readonly<Record<string, EvidenceLevel>>;
};

/** The contract every dbSDK adapter implements. */
export type DatabaseAdapter<Raw = unknown> = {
  readonly id: string;
  readonly engine: 'postgresql';
  readonly capabilities: DatabaseAdapterCapabilities;
  /** Typed escape hatch to the underlying driver. Secrets must never appear here. */
  readonly raw: Raw;
  query<Row = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  transaction?<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T>;
  batch?(statements: readonly SqlStatement[]): Promise<QueryResult[]>;
  close(): Promise<void>;
};

/** Options for {@link Database.batch}. */
export type BatchOptions = {
  /**
   * All-or-nothing execution. Default `true`: uses the adapter's native atomic batch when
   * available, otherwise leases one interactive transaction. When neither capability exists
   * the call fails before dispatch. `false` runs the statements sequentially with no
   * transactional guarantee.
   */
  atomic?: boolean;
};

/** Options for {@link createDatabase}. */
export type DatabaseOptions<TAdapter extends DatabaseAdapter> = {
  adapter: TAdapter;
};

/** The dbSDK client returned by `createDatabase`. */
export type Database<Raw = unknown> = AsyncDisposable & {
  readonly engine: 'postgresql';
  readonly adapterId: string;
  readonly capabilities: DatabaseAdapterCapabilities;

  /**
   * Tagged-template query. Interpolated values become positional `$n` parameters —
   * they can never become identifiers or raw SQL fragments.
   */
  sql<Row = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<QueryResult<Row>>;

  /** Execute a reusable statement built with the exported `sql` tag. */
  query<Row = Record<string, unknown>>(statement: SqlStatement): Promise<QueryResult<Row>>;

  /** Execute multiple statements; atomic (all-or-nothing) by default. */
  batch(statements: readonly SqlStatement[], options?: BatchOptions): Promise<QueryResult[]>;

  /** Interactive transaction; fails before dispatch when the adapter does not support it. */
  transaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T>;

  /** Close the adapter. Idempotent. Operations after close fail before dispatch. */
  close(): Promise<void>;

  /** Typed native-driver escape hatch (e.g. the `pg.Pool`). Never contains secrets. */
  readonly raw: Raw;
};

/** The reusable SQL builder exported from the package root. */
export type SqlTag = {
  (
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): SqlStatement;
  /** Build a validated, double-quoted SQL identifier (`sql.identifier('user')` → `"user"`). */
  identifier(name: string | readonly string[]): SqlStatement;
  /** Join fragments with a separator (default a single space). */
  join(fragments: readonly SqlStatement[], separator?: string): SqlStatement;
};
