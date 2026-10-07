/**
 * Error normalization for the Drizzle execution bridge.
 *
 * Drizzle's stable 0.45.x runtime wraps every driver rejection in its own
 * `DrizzleQueryError` ("Failed query: ...\nparams: ...", with the raw driver
 * error only on `cause`). Left as-is, that breaks two dbSDK promises:
 *
 * 1. **Normalized errors.** Everything a dbSDK path throws is a `DbError` with
 *    `code` / `sqlstate` / `retryable` / `indeterminate`. Through the bridge it
 *    used to be a Drizzle error with the classification buried or missing.
 * 2. **Indeterminate-write policy.** A transport failure during a write leaves
 *    the write's outcome unknown; core flags that on the `DbError`. The bridge
 *    now applies the same policy at its own dispatch boundaries (statement,
 *    transaction, batch) by reusing core's normalization instead of a divergent
 *    heuristic.
 *
 * What is deliberately NOT done here:
 *
 * - No automatic retry or replay of writes, ever (same as core).
 * - No `DrizzleQueryError` is kept in the public surface: its message embeds
 *   raw SQL parameter values (`params: ...`), which conflicts with core's
 *   no-credentials/no-params error messages. The native driver error is
 *   preserved on `DbError.cause` exactly like every other dbSDK path, so
 *   nothing is lost except the params echo.
 * - Errors thrown by Drizzle's own query *building* (e.g. placeholder
 *   mismatches) or result *mapping* (schema/data mismatch) never reached the
 *   database; they are normalized as `UNKNOWN` with no statement context, so
 *   they never claim an indeterminate write. `DrizzleQueryError`-shaped errors
 *   are the only ones given statement context, because that shape is produced
 *   exclusively around the driver call.
 */

import {
  DbError,
  hasUncertainOutcome,
  isWriteStatement,
  normalizeError,
  sqlstateOf,
} from '../errors.js';
import { batchErrorContext, transactionErrorContext } from '../core/database.js';
import type { SqlStatement } from '../types.js';

/**
 * Marks `DbError`s created by this bridge so the transaction boundary can
 * distinguish them from user-thrown `DbError`s (which must pass through
 * unchanged, exactly as core documents). Internal symbol, never serialized.
 */
const BRIDGE_NORMALIZED = Symbol('dbsdk.drizzleBridgeNormalized');

function asSymbolRecord(error: unknown): Record<symbol, unknown> | undefined {
  return typeof error === 'object' && error !== null ? (error as Record<symbol, unknown>) : undefined;
}

function markBridgeNormalized(error: DbError): DbError {
  const record = asSymbolRecord(error);
  if (record) record[BRIDGE_NORMALIZED] = true;
  return error;
}

/** True if this `DbError` was created by the bridge's own normalization. */
export function isBridgeNormalizedDbError(error: unknown): error is DbError {
  return error instanceof DbError && asSymbolRecord(error)?.[BRIDGE_NORMALIZED] === true;
}

/**
 * Drizzle's `DrizzleQueryError` has no stable exported runtime check in the
 * stable line's public API usage here (it does not even set `name`), so the
 * bridge recognizes it structurally: an `Error` carrying drizzle's `query`
 * string and `params` array. That shape is only produced around the driver
 * call, which is exactly the dispatch boundary we normalize at.
 */
export function isDrizzleQueryErrorShape(error: unknown): error is Error & { query: unknown; params: unknown; cause?: unknown } {
  if (!(error instanceof Error)) return false;
  const candidate = error as { query?: unknown; params?: unknown };
  return typeof candidate.query === 'string' && Array.isArray(candidate.params);
}

/**
 * Normalize a statement-level failure observed at the bridge's driver
 * boundary (prepared query `execute` / `all` / `values`).
 *
 * - `DrizzleQueryError`-shaped: unwrap to the native driver error and classify
 *   it with the statement text, exactly like core's `db.sql` / `db.query` path
 *   (`normalizeError` with `text`). The native error lands on `DbError.cause`.
 * - Already a `DbError`: pass through unchanged (defense in depth; the bridge
 *   itself never produces one at this layer).
 * - Anything else: a client-side failure — query building (e.g. placeholder
 *   mismatch) before dispatch, or result mapping after a successful dispatch.
 *   By default it is classified with NO statement context so it can never
 *   claim an indeterminate write. Set `textOnUnshaped` for methods that are
 *   pure dispatch with no client-side mapping (`all` / `values`), where an
 *   unshaped error can only come from the driver itself.
 */
export function normalizeStatementFailure(
  error: unknown,
  text: string,
  adapterId: string,
  options: { textOnUnshaped?: boolean } = {},
): DbError {
  if (error instanceof DbError) return error;
  const shaped = isDrizzleQueryErrorShape(error);
  const native = shaped ? ((error as { cause?: unknown }).cause ?? error) : error;
  if (native instanceof DbError) return native;
  const applyText = shaped || options.textOnUnshaped === true;
  const uncertain = hasUncertainOutcome(native);
  return markBridgeNormalized(
    normalizeError(native, {
      adapterId,
      ...(applyText ? { text } : {}),
      ...(uncertain ? { uncertain: true } : {}),
    }),
  );
}

/**
 * Normalize a failed bridge transaction with EXACTLY core's
 * `db.transaction` semantics (see `transactionErrorContext` in
 * `core/database.ts`):
 *
 * - Bridge-normalized statement errors are unwrapped back to their native
 *   cause and re-normalized once with the transaction context, so the result
 *   is identical to what core produces for the same raw failure.
 * - User-thrown `DbError`s pass through unchanged (core's documented behavior:
 *   "user-thrown DbErrors pass through unchanged, keeping their code and
 *   `indeterminate: false`").
 * - Any other error (user business exceptions, unexpected non-`Error` values)
 *   is normalized with the transaction context: no server SQLSTATE means the
 *   outcome of the callback's writes cannot be proven, so `indeterminate: true`.
 *
 * `DrizzleRollbackError`-style control-flow errors are handled by the caller
 * (they must never reach this function).
 */
export function finalizeTransactionError(error: unknown, adapterId: string): DbError {
  if (isBridgeNormalizedDbError(error)) {
    const native = error.cause;
    return normalizeError(native ?? error, transactionErrorContext(adapterId, native ?? error));
  }
  if (error instanceof DbError) return error;
  return normalizeError(error, transactionErrorContext(adapterId, error));
}

/**
 * Normalize a failed Neon HTTP batch with core's batch policy
 * (`batchErrorContext`) plus the Neon adapter's own transport rule (a lost
 * response in the single-round-trip batch leaves the outcome of any write in
 * it unknown). Batch failures are never wrapped by drizzle, so `error` is the
 * raw driver error and is normalized exactly once, like core's `db.batch`.
 */
export function finalizeBatchError(error: unknown, texts: readonly string[], adapterId: string): DbError {
  if (error instanceof DbError) return error;
  const statements: SqlStatement[] = texts.map((text) => ({ text }));
  const context = batchErrorContext(adapterId, statements, error);
  const anyWrite = texts.some((text) => isWriteStatement(text));
  const transportLost = sqlstateOf(error) === undefined && anyWrite;
  return normalizeError(error, {
    adapterId,
    ...(context.text !== undefined ? { text: context.text } : {}),
    ...(context.uncertain === true || transportLost ? { uncertain: true } : {}),
  });
}
