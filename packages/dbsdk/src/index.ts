/**
 * dbSDK — one typed PostgreSQL client for Supabase and Neon.
 *
 * This entry exports the core client, the SQL builder, the contract types, and the normalized
 * error type. Adapter implementations stay behind their own subpaths (`dbsdk/postgres`,
 * `dbsdk/supabase`, `dbsdk/neon`) so no driver is pulled in unless you import it.
 *
 * @example
 * ```ts
 * import { createDatabase } from 'dbsdk';
 * import { neon } from 'dbsdk/neon';
 *
 * const db = createDatabase({ adapter: neon({ connectionString: process.env.DATABASE_URL! }) });
 * const { rows } = await db.sql<{ id: string }>`select id from users where id = ${userId}`;
 * await db.close();
 * ```
 */

export { createDatabase } from './core/database.js';
export { sql } from './sql.js';
export { DbError, isDbError, normalizeError, isWriteStatement } from './errors.js';
export type { DbErrorOptions, DbErrorCode } from './errors.js';
export { capabilityMatrix, describeCapabilities, missingCapabilityError } from './capabilities.js';
export type { CapabilityFeature } from './capabilities.js';
export type {
  BatchOptions,
  Database,
  DatabaseAdapter,
  DatabaseAdapterCapabilities,
  DatabaseOptions,
  EvidenceLevel,
  QueryExecutor,
  QueryResult,
  SqlStatement,
  SqlTag,
} from './types.js';
