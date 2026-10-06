/**
 * `dbsdk/sync` — provider-agnostic, resumable data transfer between databases.
 *
 * Nothing here is SQL-specific except the adapters in `./sql.js`, which wrap the
 * existing `Database` client (local Postgres, Supabase, Neon — any transport).
 * See coordination/v3-sync-workflows.md for the contract and the honest limits.
 */

export { SyncError, isSyncError, type SyncErrorCode } from './errors.js';
export { runTransfer, createMemoryCheckpointStore } from './core.js';
export { createSqlSource, createSqlTarget } from './sql.js';
export type {
  SqlSourceOptions,
  SqlTargetOptions,
} from './sql.js';
export type {
  CheckpointStore,
  SyncSource,
  SyncTarget,
  SyncReadOptions,
  SyncWriteOptions,
  TransferOptions,
  TransferProgress,
  TransferResult,
} from './types.js';
