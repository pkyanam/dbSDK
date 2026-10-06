/**
 * Sync layer error type — separate from the SQL `DbError` and the management
 * `ManagementError`, because this layer's failures are workflow-contract failures
 * (bad source/target shapes, stalled cursors, cancellation), not database or
 * provider-API failures. Underlying read/write errors are passed through as-is:
 * the job never rewrites or swallows the cause.
 */

export type SyncErrorCode = 'CONFIGURATION' | 'CONTRACT' | 'ABORTED';

export class SyncError extends Error {
  readonly code: SyncErrorCode;

  constructor(message: string, code: SyncErrorCode) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
  }
}

export function isSyncError(value: unknown): value is SyncError {
  return value instanceof SyncError;
}
