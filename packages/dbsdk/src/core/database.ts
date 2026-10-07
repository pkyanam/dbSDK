/**
 * The dbSDK client: `createDatabase`. Wraps an adapter with capability guards (checked BEFORE
 * dispatch), statement validation, error normalization, and idempotent lifecycle management.
 * There is no automatic retry of writes, no silent failover, and no capability fallback.
 */

import {
  DbError,
  normalizeError,
  hasUncertainOutcome,
  isWriteStatement,
  sqlstateOf,
} from '../errors.js';
import { missingCapabilityError } from '../capabilities.js';
import { buildSql, validateStatementParams } from '../sql.js';
import type {
  BatchOptions,
  Database,
  DatabaseAdapter,
  DatabaseOptions,
  QueryExecutor,
  QueryResult,
  SqlStatement,
} from '../types.js';

function configurationError(message: string): DbError {
  return new DbError(message, { code: 'CONFIGURATION', retryable: false, indeterminate: false });
}

function validateAdapter(adapter: unknown): asserts adapter is DatabaseAdapter {
  const a = adapter as Partial<DatabaseAdapter> | null | undefined;
  if (typeof a !== 'object' || a === null) {
    throw configurationError('createDatabase requires an adapter object.');
  }
  if (typeof a.id !== 'string' || a.id.length === 0) {
    throw configurationError('Adapter must have a non-empty string id.');
  }
  if (a.engine !== 'postgresql') {
    throw configurationError(`Adapter "${a.id}" must declare engine: 'postgresql'.`);
  }
  if (typeof a.query !== 'function') {
    throw configurationError(`Adapter "${a.id}" must implement query(text, params).`);
  }
  if (typeof a.close !== 'function') {
    throw configurationError(`Adapter "${a.id}" must implement close().`);
  }
  if (typeof a.capabilities !== 'object' || a.capabilities === null) {
    throw configurationError(`Adapter "${a.id}" must declare capabilities.`);
  }
  const capabilities = a.capabilities as Partial<DatabaseAdapter['capabilities']> | null;
  if (
    capabilities?.transport !== 'tcp' &&
    capabilities?.transport !== 'http' &&
    capabilities?.transport !== 'websocket'
  ) {
    throw configurationError(
      `Adapter "${a.id}" has malformed capabilities: transport must be 'tcp', 'http', or 'websocket'.`,
    );
  }
  if (
    typeof capabilities?.interactiveTransactions !== 'boolean' ||
    typeof capabilities?.atomicBatch !== 'boolean' ||
    typeof capabilities?.sessionState !== 'boolean' ||
    typeof capabilities?.evidence !== 'object' ||
    capabilities.evidence === null
  ) {
    throw configurationError(
      `Adapter "${a.id}" has malformed capabilities. Required: interactiveTransactions, ` +
        'atomicBatch, sessionState (booleans), transport, evidence.',
    );
  }
}

function validateStatement(statement: unknown, position?: number): asserts statement is SqlStatement {
  const s = statement as Partial<SqlStatement> | null | undefined;
  const where = position === undefined ? '' : ` at position ${position + 1}`;
  if (typeof s !== 'object' || s === null) {
    throw configurationError(`Batch statements must be objects${where}.`);
  }
  if (typeof s.text !== 'string' || s.text.length === 0) {
    throw configurationError(`Batch statement text must be a non-empty string${where}.`);
  }
  if (s.params !== undefined && !Array.isArray(s.params)) {
    throw configurationError(`Batch statement params must be an array${where}.`);
  }
  // Same parameter rules as the sql tag: undefined/functions/symbols rejected,
  // so `db.query`/`db.batch` cannot silently diverge from `db.sql`.
  if (Array.isArray(s.params)) {
    validateStatementParams(s.params);
  }
}

/**
 * Error context for an atomic batch failure. The batch as a whole is treated as a
 * write if ANY statement is a write — not just the first one — so a transport
 * failure during `[{ select ... }, { update ... }]` is still flagged as a
 * potentially-committed write.
 */
/**
 * Exported for the Drizzle bridge (`src/drizzle-interop`): it has no core client
 * in its call path, so it reuses this exact batch policy instead of a divergent
 * copy. The batch as a whole counts as a write if ANY statement is a write.
 */
export function batchErrorContext(
  adapterId: string,
  statements: readonly SqlStatement[],
  error: unknown,
): { adapterId: string; text?: string; uncertain?: boolean } {
  const writeIndex = statements.findIndex((statement) => isWriteStatement(statement.text));
  return {
    adapterId,
    ...(writeIndex >= 0 ? { text: statements[writeIndex]?.text } : {}),
    // Adapters (e.g. Neon HTTP) mark errors whose outcome they could not observe.
    ...(hasUncertainOutcome(error) ? { uncertain: true } : {}),
  };
}

/**
 * Error context for an interactive transaction failure. Core cannot know whether
 * the callback wrote, so the conservative rule applies: any error without a
 * server-reported SQLSTATE (transport-level or otherwise), or with CONNECTION /
 * TIMEOUT character, could hide a committed write — including a COMMIT the server
 * may have applied before the connection died. `indeterminate: true` tells the
 * caller to reconcile; dbSDK never replays the writes itself.
 */
/**
 * Exported for the Drizzle bridge (`src/drizzle-interop`): its transaction
 * implementation reuses this exact policy so bridge transactions classify
 * identically to core `db.transaction` (see finalizeTransactionError there).
 */
export function transactionErrorContext(
  adapterId: string,
  error: unknown,
): { adapterId: string; uncertain?: boolean } {
  const uncertain =
    hasUncertainOutcome(error) || sqlstateOf(error) === undefined || isTransportCode(error);
  return { adapterId, ...(uncertain ? { uncertain: true } : {}) };
}

function isTransportCode(error: unknown): boolean {
  const record = error as { code?: unknown } | null | undefined;
  return (
    record?.code === 'ECONNRESET' ||
    record?.code === 'ECONNREFUSED' ||
    record?.code === 'EPIPE' ||
    record?.code === 'ETIMEDOUT'
  );
}

function createDatabase<TAdapter extends DatabaseAdapter>(
  options: DatabaseOptions<TAdapter>,
): Database<TAdapter['raw']> {
  validateAdapter(options.adapter);
  const adapter = options.adapter;
  const { capabilities } = adapter;

  let closed = false;
  let closePromise: Promise<void> | null = null;

  function assertOpen(): void {
    if (closed) {
      throw new DbError(
        `The database (adapter "${adapter.id}") is closed. Create a new database to query again.`,
        { code: 'CONNECTION', adapterId: adapter.id, retryable: false, indeterminate: false },
      );
    }
  }

  async function run<Row>(
    text: string,
    params: readonly unknown[],
  ): Promise<QueryResult<Row>> {
    assertOpen();
    try {
      return await adapter.query<Row>(text, params);
    } catch (error) {
      throw normalizeError(error, { adapterId: adapter.id, text });
    }
  }

  const db: Database<TAdapter['raw']> = {
    engine: 'postgresql',
    adapterId: adapter.id,
    capabilities,

    sql<Row>(strings: TemplateStringsArray, ...values: readonly unknown[]) {
      const statement = buildSql(strings, values);
      return run<Row>(statement.text, statement.params ?? []);
    },

    async query<Row>(statement: SqlStatement) {
      validateStatement(statement);
      return run<Row>(statement.text, statement.params ?? []);
    },

    async batch(statements: readonly SqlStatement[], options?: BatchOptions) {
      assertOpen();
      const atomic = options?.atomic ?? true;
      statements.forEach((statement, index) => validateStatement(statement, index));
      if (statements.length === 0) return [];

      if (!atomic) {
        const results: QueryResult[] = [];
        for (const statement of statements) {
          // run() re-checks closed (close could happen mid-batch) and normalizes errors.
          results.push(await run(statement.text, statement.params ?? []));
        }
        return results;
      }

      // Atomic: prefer the adapter's native atomic batch.
      if (capabilities.atomicBatch) {
        if (typeof adapter.batch !== 'function') {
          throw configurationError(
            `Adapter "${adapter.id}" declares atomicBatch but does not implement batch().`,
          );
        }
        try {
          return await adapter.batch(statements);
        } catch (error) {
          throw normalizeError(error, batchErrorContext(adapter.id, statements, error));
        }
      }

      // Otherwise lease one interactive transaction, if the adapter supports it.
      if (capabilities.interactiveTransactions) {
        if (typeof adapter.transaction !== 'function') {
          throw configurationError(
            `Adapter "${adapter.id}" declares interactiveTransactions but does not implement transaction().`,
          );
        }
        try {
          return await adapter.transaction(async (tx: QueryExecutor) => {
            const results: QueryResult[] = [];
            for (const statement of statements) {
              results.push(await tx.query(statement.text, statement.params ?? []));
            }
            return results;
          });
        } catch (error) {
          throw normalizeError(error, transactionErrorContext(adapter.id, error));
        }
      }

      throw missingCapabilityError('atomicBatch', adapter);
    },

    async transaction<T>(fn: (tx: QueryExecutor) => Promise<T>) {
      assertOpen();
      if (!capabilities.interactiveTransactions) {
        throw missingCapabilityError('interactiveTransactions', adapter);
      }
      if (typeof adapter.transaction !== 'function') {
        throw configurationError(
          `Adapter "${adapter.id}" declares interactiveTransactions but does not implement transaction().`,
        );
      }
      try {
        return await adapter.transaction(fn);
      } catch (error) {
        throw normalizeError(error, transactionErrorContext(adapter.id, error));
      }
    },

    close(): Promise<void> {
      if (closePromise) {
        // Idempotent: the first caller gets the outcome (including a close
        // failure); later callers just need the adapter to be closed, so a
        // failed close is reported once and never re-thrown.
        return closePromise.then(() => {}, () => {});
      }
      closed = true;
      closePromise = (async () => {
        try {
          await adapter.close();
        } catch (error) {
          // Even on failure the database stays closed; state is unknown, never reused.
          throw normalizeError(error, { adapterId: adapter.id });
        }
      })();
      return closePromise;
    },

    get raw() {
      // Lazy: accessing raw must not create the underlying pool, and after
      // close() it surfaces the adapter's closed state instead of returning a
      // stale ended pool.
      return adapter.raw;
    },

    [Symbol.asyncDispose]() {
      return db.close();
    },
  };

  return db;
}

export { createDatabase };
