/**
 * Adapter exports. Keep drivers behind these modules — the SDK core must not
 * import them, so applications only pull in the driver of the adapter they use.
 */

export {
  ConfigurationError,
  CapabilityError,
} from './errors.js';
export type {
  DatabaseAdapter,
  DatabaseAdapterCapabilities,
  EvidenceLevel,
  QueryExecutor,
  QueryResult,
  SqlStatement,
} from '../types.js';
export {
  createPgEngine,
  normalizePgResult,
  runLeasedTransaction,
  type PgClientLike,
  type PgPoolConfig,
  type PgPoolLike,
  type PgQueryOutput,
} from './pg-engine.js';
export { postgres, type PostgresAdapterOptions, type PostgresRaw } from './postgres.js';
export {
  supabase,
  assertNoSessionState,
  type SupabaseAdapterOptions,
  type SupabaseConnectionMode,
  type SupabaseRaw,
  type SupabaseResolvedConnection,
} from './supabase.js';
export {
  neon,
  type NeonAdapterOptions,
  type NeonHttpFactory,
  type NeonHttpQueryFn,
  type NeonRaw,
  type NeonTransactionTransport,
  type NeonTransport,
} from './neon.js';
