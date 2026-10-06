/**
 * Normalized error layer for the management (control-plane) plane. Everything thrown by a
 * management adapter is normalized into `ManagementError` by the core client. HTTP status
 * mapping, retryability, and the `indeterminate` rule live here; secret redaction happens in
 * `http.ts` before any message is constructed.
 *
 * There is no automatic retry of mutations anywhere: `retryable` is an honest hint, never a
 * behavior.
 */

import type { ManagementCallOptions } from './types.js';
import type { ManagementProviderId, ManagementResourceKind } from './types.js';

export type ManagementErrorCode =
  | 'CAPABILITY' // kind/verb/pagination not declared by the adapter — checked before dispatch
  | 'CONFIGURATION' // bad adapter shape, missing prerequisites, malformed options
  | 'AUTH' // 401: credential missing, invalid, or revoked
  | 'PERMISSION' // 403: credential valid but not allowed (e.g. project-scoped key creating projects)
  | 'NOT_FOUND' // 404
  | 'CONFLICT' // 409; also 423 (Neon overlapping operations) with retryable: true
  | 'RATE_LIMIT' // 429 (retryAfterMs from Retry-After / X-RateLimit-Reset)
  | 'VALIDATION' // 400/422: the provider rejected the request body
  | 'ABORTED' // caller aborted via AbortSignal
  | 'CONNECTION' // network/transport failure
  | 'TIMEOUT' // per-request timeout or wait() budget exceeded
  | 'PROVIDER' // provider-reported error we can't classify further (incl. 5xx and other 4xx)
  | 'UNKNOWN';

export type ManagementErrorOptions = {
  code: ManagementErrorCode;
  /** HTTP status when a response was actually received. */
  status?: number;
  adapterId?: ManagementProviderId;
  resourceKind?: ManagementResourceKind;
  resourceId?: string;
  /** Provider's own error code/identifier from the response body, when present. */
  providerErrorCode?: string;
  /** Provider's own lifecycle status string (e.g. `RESTORE_FAILED`, `cancelled`). */
  providerStatus?: string;
  retryable?: boolean;
  /**
   * True means a MUTATION may or may not have taken effect (transport failure or 5xx after the
   * request was sent). Never set for GETs, pre-dispatch errors, or definitive 4xx rejections.
   * The SDK never retries such operations; callers reconcile.
   */
  indeterminate?: boolean;
  retryAfterMs?: number;
  cause?: unknown;
};

const DEFAULT_RETRYABLE: Partial<Record<ManagementErrorCode, boolean>> = {
  CONNECTION: true,
  TIMEOUT: true,
  PROVIDER: true,
  RATE_LIMIT: true,
};

/** The single normalized error type of the management plane. */
export class ManagementError extends Error {
  readonly code: ManagementErrorCode;
  readonly status: number | undefined;
  readonly adapterId: ManagementProviderId | undefined;
  readonly resourceKind: ManagementResourceKind | undefined;
  readonly resourceId: string | undefined;
  readonly providerErrorCode: string | undefined;
  readonly providerStatus: string | undefined;
  readonly retryable: boolean;
  readonly indeterminate: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: ManagementErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ManagementError';
    this.code = options.code;
    this.status = options.status;
    this.adapterId = options.adapterId;
    this.resourceKind = options.resourceKind;
    this.resourceId = options.resourceId;
    this.providerErrorCode = options.providerErrorCode;
    this.providerStatus = options.providerStatus;
    this.retryable = options.retryable ?? (DEFAULT_RETRYABLE[options.code] ?? false);
    this.indeterminate = options.indeterminate ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function isManagementError(value: unknown): value is ManagementError {
  return value instanceof ManagementError;
}

/** Context attached by the core client when normalizing an adapter error. */
export type ManagementErrorContext = {
  adapterId?: ManagementProviderId;
  resourceKind?: ManagementResourceKind;
  resourceId?: string;
  /** Extra call context used in messages; never contains secrets. */
  call?: ManagementCallOptions;
};

/**
 * Normalize anything thrown by an adapter into a `ManagementError`. Already-normalized errors
 * pass through with context filled in; unknown errors become `UNKNOWN` with the original error
 * as `cause`. Adapters are responsible for constructing messages without secrets (see
 * `redactText` in `http.ts`).
 */
export function normalizeManagementError(
  error: unknown,
  context: ManagementErrorContext = {},
): ManagementError {
  if (error instanceof ManagementError) {
    return new ManagementError(error.message, {
      code: error.code,
      status: error.status,
      adapterId: error.adapterId ?? context.adapterId,
      resourceKind: error.resourceKind ?? context.resourceKind,
      resourceId: error.resourceId ?? context.resourceId,
      providerErrorCode: error.providerErrorCode,
      providerStatus: error.providerStatus,
      retryable: error.retryable,
      indeterminate: error.indeterminate,
      retryAfterMs: error.retryAfterMs,
      cause: error,
    });
  }
  const message =
    typeof error === 'object' && error !== null && 'message' in error && typeof (error as { message: unknown }).message === 'string'
      ? (error as { message: string }).message
      : String(error);
  return new ManagementError(message, {
    code: 'UNKNOWN',
    adapterId: context.adapterId,
    resourceKind: context.resourceKind,
    resourceId: context.resourceId,
    indeterminate: false,
    cause: error,
  });
}
