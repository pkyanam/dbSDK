/**
 * Normalized error layer. Everything thrown by an adapter is normalized into `DbError`
 * by the core client. Original errors are preserved on `cause`; PostgreSQL SQLSTATE codes
 * are passed through. There is no automatic retry of writes anywhere in dbSDK.
 */

export type DbErrorCode =
  | 'CAPABILITY'
  | 'CONFIGURATION'
  | 'CONSTRAINT'
  | 'CONNECTION'
  | 'TIMEOUT'
  | 'PERMISSION'
  | 'SYNTAX'
  | 'TRANSACTION'
  | 'DATA'
  | 'UNKNOWN';

export type DbErrorOptions = {
  code: DbErrorCode;
  sqlstate?: string;
  adapterId?: string;
  capability?: string;
  retryable?: boolean;
  /** True means a write may or may not have committed. Never auto-retry such writes. */
  indeterminate?: boolean;
  cause?: unknown;
};

const DEFAULT_RETRYABLE: Partial<Record<DbErrorCode, boolean>> = {
  CONNECTION: true,
  TIMEOUT: true,
  TRANSACTION: true,
};

/** The single normalized error type of dbSDK. */
export class DbError extends Error {
  readonly code: DbErrorCode;
  readonly sqlstate: string | undefined;
  readonly adapterId: string | undefined;
  readonly capability: string | undefined;
  readonly retryable: boolean;
  readonly indeterminate: boolean;

  constructor(message: string, options: DbErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'DbError';
    this.code = options.code;
    this.sqlstate = options.sqlstate;
    this.adapterId = options.adapterId;
    this.capability = options.capability;
    this.retryable = options.retryable ?? (DEFAULT_RETRYABLE[options.code] ?? false);
    this.indeterminate = options.indeterminate ?? false;
  }
}

export function isDbError(value: unknown): value is DbError {
  return value instanceof DbError;
}

const SQLSTATE_RE = /^[0-9A-Z]{5}$/;

/**
 * Node/libuv system error codes all start with `E`. No SQL-standard or PostgreSQL
 * SQLSTATE class begins with `E` (PostgreSQL's classes are digit-led, or HV/FD/P0/XX),
 * so an `E`-prefixed uppercase code arriving on `error.code` is a system errno —
 * most importantly short socket errnos like `EPIPE`, `EBADF` and `E2BIG`, which are
 * exactly 5 uppercase characters and would otherwise satisfy SQLSTATE_RE and
 * masquerade as a server-reported SQLSTATE. Custom SQLSTATEs are still preserved:
 * the explicit `sqlstate` field is never errno-filtered (see {@link pickSqlstate}).
 */
const SYSTEM_ERRNO_RE = /^E[0-9A-Z]+$/;

/**
 * System errnos that describe a network/transport failure (socket write, connect,
 * DNS resolution). When such a code reaches normalization without a server
 * SQLSTATE, the failure is classified as CONNECTION rather than UNKNOWN — it is a
 * transport problem, not an application error. Errnos outside this list are still
 * never treated as SQLSTATEs; they simply stay UNKNOWN with no sqlstate.
 */
const TRANSPORT_ERRNOS = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTDOWN',
  'ENOTCONN',
  'EISCONN',
  'ESHUTDOWN',
  'EADDRINUSE',
  'EADDRNOTAVAIL',
  'EACCES', // permission denied binding/connecting a socket
  'EAFNOSUPPORT',
  'EPROTONOSUPPORT',
  'EPROTOTYPE',
  'ESOCKTNOSUPPORT',
  'EPFNOSUPPORT',
  'ENOBUFS',
  // getaddrinfo (DNS resolution) failures surfaced by Node as `code`
  'EAI_AGAIN',
  'EAI_FAIL',
  'EAI_NONAME',
  'EAI_NODATA',
  'EAI_SERVICE',
  'EAI_SOCKTYPE',
  'EAI_FAMILY',
  'EAI_OVERFLOW',
  'EAI_MEMORY',
]);

/** Map a PostgreSQL SQLSTATE to a dbSDK error code. */
function sqlstateToCode(sqlstate: string): DbErrorCode | undefined {
  // Explicit overrides first: SQLSTATE prefixes are not always the best signal.
  // 42501 (insufficient_privilege) sits in the 42 "syntax/access" class but is a
  // permission problem, not a syntax problem.
  if (sqlstate === '42501') return 'PERMISSION';
  const prefix = sqlstate.slice(0, 2);
  switch (prefix) {
    case '08':
      return 'CONNECTION';
    case '22':
      return 'DATA';
    case '23':
    case '27':
      return 'CONSTRAINT';
    case '28':
      return 'PERMISSION';
    case '3D':
    case '3F':
      return 'CONFIGURATION';
    case '25': // 25P01/25P02 invalid transaction state, 25P03 idle in transaction session timeout
    case '2D': // 2D000 invalid transaction termination
    case '40':
      return 'TRANSACTION';
    case '42':
      return 'SYNTAX';
    case '0A':
      return 'CAPABILITY';
    case '53': // 53300 too_many_connections, 53400 configuration_limit_exceeded
    case '57': // 57P01/57P02/57P03 admin shutdown / cannot connect now
      return sqlstate === '57014' ? 'TIMEOUT' : 'CONNECTION';
    default:
      return undefined;
  }
}

/**
 * Conservative heuristic keywords. WARNING: this is a heuristic, never proof that a
 * statement is read-only — it cannot see stored procedures, views with side effects,
 * triggers, or every side-effecting function. It is only used to flag `indeterminate`
 * more broadly on transport failures; it is never used to claim safety.
 *
 * `explain` is included because `EXPLAIN ANALYZE` (and `EXPLAIN (ANALYZE, ...)`)
 * actually executes the statement, so a transport failure during it can hide a
 * committed write. Plain `EXPLAIN SELECT` is therefore over-flagged as a write —
 * the conservative direction (this heuristic widens `indeterminate`, never narrows
 * it); it is not a statement parser, so distinguishing ANALYZE forms reliably would
 * be more fragile than over-flagging.
 */
const WRITE_KEYWORDS_RE =
  /^(with|insert|update|delete|merge|truncate|create|alter|drop|comment|grant|revoke|lock|call|do|copy|notify|vacuum|analyze|analyse|checkpoint|refresh|reindex|reassign|import|load|explain)\b/i;

/**
 * Strip leading whitespace and comments so the first SQL keyword can be read.
 * Returns the remaining text, or '' if the statement is only comments/whitespace.
 */
function stripLeadingComments(text: string): string {
  let rest = text.trimStart();
  for (;;) {
    if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/', 2);
      if (end === -1) return ''; // unterminated block comment: nothing parseable follows
      rest = rest.slice(end + 2).trimStart();
      continue;
    }
    if (rest.startsWith('--')) {
      const end = rest.indexOf('\n');
      if (end === -1) return '';
      rest = rest.slice(end + 1).trimStart();
      continue;
    }
    return rest;
  }
}

/**
 * Server functions that can take effect even inside an ordinary `SELECT`.
 * A transport failure during such a statement leaves the side effect unknown,
 * so it is treated like a write (conservative; may over-flag reads). This list
 * is not exhaustive — see the warning on {@link isWriteStatement}.
 */
const SELECT_SIDE_EFFECT_RE =
  /\b(setval|nextval|lo_import|lo_export|lo_create|lo_unlink|lo_write|lo_read|dblink|dblink_exec|dblink_send_query|pg_logical_emit|pg_replication_origin_advance|pg_create_logical_replication_slot|pg_create_physical_replication_slot|pg_drop_replication_slot|pg_terminate_backend|pg_cancel_backend|pg_advisory_lock|pg_advisory_xact_lock)\s*\(/i;

/**
 * Conservative heuristic: does this statement's first keyword indicate a write?
 * Leading comments are ignored; a statement consisting only of comments, a
 * multi-statement string (the parameterless path runs every statement after `;`),
 * and any `SELECT` that invokes known side-effect functions are conservatively
 * treated as writes. Read-only `WITH` CTEs are also treated as writes (safe
 * over-approximation).
 */
export function isWriteStatement(text: string): boolean {
  const stripped = stripLeadingComments(text);
  if (stripped === '') return true; // unparseable: assume the worst
  if (WRITE_KEYWORDS_RE.test(stripped)) return true;
  // Multi-statement simple-protocol strings: a second statement after `;` can be
  // anything, so a semicolon with content after it is conservatively a write.
  // (May over-flag reads containing `;` inside literals; that only widens the
  // `indeterminate` flag on transport failures, never narrows it.)
  const trimmed = stripped.replace(/\s+$/, '');
  const body = trimmed.endsWith(';') ? trimmed.slice(0, -1) : trimmed;
  if (body.includes(';')) return true;
  if (/^select\b/i.test(stripped) && SELECT_SIDE_EFFECT_RE.test(stripped)) return true;
  return false;
}

/**
 * Marker for errors whose outcome cannot be known: set by adapters when a
 * transaction failed in a way that leaves its writes neither committed nor
 * provably rolled back (e.g. the connection dropped before COMMIT finished).
 * The core client turns this into `DbError.indeterminate: true`.
 */
const UNCERTAIN_OUTCOME = Symbol('dbsdk.uncertainOutcome');

function asErrorRecord(error: unknown): Record<symbol, unknown> | undefined {
  return typeof error === 'object' && error !== null
    ? (error as Record<symbol, unknown>)
    : undefined;
}

/** Mark an error as having an unknowable outcome (see {@link hasUncertainOutcome}). */
export function markUncertainOutcome(error: unknown): void {
  const record = asErrorRecord(error);
  if (record) record[UNCERTAIN_OUTCOME] = true;
}

/** True if the error was marked as having an unknowable outcome. */
export function hasUncertainOutcome(error: unknown): boolean {
  return asErrorRecord(error)?.[UNCERTAIN_OUTCOME] === true;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as UnknownRecord) : undefined;
}

function pickSqlstate(error: UnknownRecord): string | undefined {
  const direct = error['sqlstate'];
  // An explicit `sqlstate` field is authoritative: drivers only set it from a
  // server report, so any 5-character code there — including custom classes —
  // is passed through untouched.
  if (typeof direct === 'string' && SQLSTATE_RE.test(direct)) return direct;
  const code = error['code'];
  // The `code` fallback must exclude Node system errnos (EPIPE, EBADF, E2BIG, ...).
  // Some are exactly 5 uppercase characters and would otherwise be mistaken for a
  // server-reported SQLSTATE — hiding a transport failure behind a fake sqlstate,
  // which suppressed the `indeterminate` flag on lost writes.
  if (typeof code === 'string' && SQLSTATE_RE.test(code) && !SYSTEM_ERRNO_RE.test(code)) {
    return code;
  }
  const source = asRecord(error['sourceError']); // @neondatabase/serverless wraps driver errors
  if (source) return pickSqlstate(source);
  return undefined;
}

/** The Node system errno on an error (or its `sourceError` chain), if any. */
function systemErrnoOf(error: UnknownRecord): string | undefined {
  const code = error['code'];
  if (typeof code === 'string' && SYSTEM_ERRNO_RE.test(code)) return code;
  const source = asRecord(error['sourceError']);
  if (source) return systemErrnoOf(source);
  return undefined;
}

/**
 * Extract a server-reported PostgreSQL SQLSTATE from an error (or its `sourceError`
 * chain), or `undefined` when the error is transport/application-level. Used by the
 * adapters to distinguish server outcomes from network failures.
 */
export function sqlstateOf(error: unknown): string | undefined {
  const record = asRecord(error);
  return record ? pickSqlstate(record) : undefined;
}

/**
 * Normalize any error thrown by an adapter into a `DbError`, preserving the original error
 * on `cause` and the server-reported SQLSTATE when present.
 */
export function normalizeError(
  error: unknown,
  context: { adapterId?: string; text?: string; uncertain?: boolean } = {},
): DbError {
  if (error instanceof DbError) return error;

  const record = asRecord(error);
  const message = typeof record?.['message'] === 'string' && record['message'] !== ''
    ? record['message']
    : String(error);
  const name = typeof record?.['name'] === 'string' ? record['name'] : undefined;
  const adapterId = context.adapterId;

  // Pre-dispatch adapter errors (CapabilityError / ConfigurationError from adapters, or any
  // DbError already normalized above): these never happened on the wire, so they can never
  // leave a write indeterminate.
  if (name === 'CapabilityError') {
    return new DbError(message, {
      code: 'CAPABILITY',
      adapterId: typeof record?.['adapter'] === 'string' ? record['adapter'] : adapterId,
      capability: typeof record?.['capability'] === 'string' ? record['capability'] : undefined,
      retryable: false,
      indeterminate: false,
      cause: error,
    });
  }
  if (name === 'ConfigurationError') {
    return new DbError(message, {
      code: 'CONFIGURATION',
      adapterId: typeof record?.['adapter'] === 'string' ? record['adapter'] : adapterId,
      retryable: false,
      indeterminate: false,
      cause: error,
    });
  }

  const sqlstate = sqlstateOf(error);
  let code: DbErrorCode = 'UNKNOWN';
  if (sqlstate) {
    code = sqlstateToCode(sqlstate) ?? 'UNKNOWN';
  } else {
    // No server SQLSTATE: a recognized system transport errno (EPIPE, ECONNRESET,
    // ETIMEDOUT, ...) is a connection-level failure, not an unknown application error.
    const errno = record ? systemErrnoOf(record) : undefined;
    if (errno !== undefined && TRANSPORT_ERRNOS.has(errno)) code = 'CONNECTION';
  }

  const retryable =
    code === 'CONNECTION' ||
    code === 'TIMEOUT' ||
    (code === 'TRANSACTION' && (sqlstate === '40001' || sqlstate === '40P01'));

  // Transport-level failure (no SQLSTATE from the server) or an explicit connection/timeout
  // failure during a write statement: the outcome of the write is unknown. We flag it so
  // callers can reconcile; we never replay the write ourselves. The adapter may also mark
  // the error directly (transaction failures where the outcome cannot be known). An empty
  // `text` means "no statement context" (e.g. transaction/close errors), not an unparseable
  // statement, so it does not trigger the write heuristic by itself.
  const indeterminate =
    context.uncertain === true ||
    hasUncertainOutcome(error) ||
    ((context.text ?? '') !== '' &&
      isWriteStatement(context.text ?? '') &&
      (sqlstate === undefined || code === 'CONNECTION' || code === 'TIMEOUT'));

  return new DbError(message, {
    code,
    sqlstate,
    adapterId,
    retryable,
    indeterminate,
    cause: error,
  });
}
