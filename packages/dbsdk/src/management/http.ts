/**
 * Shared HTTP transport for management adapters. One place for: the bearer credential, official
 * base URL handling, timeouts, caller aborts, JSON bodies, status→error mapping, and — critically
 * — secret redaction. The credential and every registered secret value are scrubbed from error
 * messages; headers are never included in messages.
 *
 * Indeterminate rule (coordination/v2-management-contract.md §7): for non-GET requests, a
 * transport failure (network error, timeout) or a received 5xx response leaves the mutation's
 * outcome unknown — `indeterminate: true`. Definitive 4xx rejections are not. The SDK never
 * retries; callers reconcile.
 */

import { ManagementError } from './errors.js';
import type { FetchLike } from './types.js';

export type ManagementHttpConfig = {
  /** Official provider base URL (no trailing slash), e.g. `https://api.supabase.com/v1`. */
  baseUrl: string;
  /** Bearer credential. Sent only as the Authorization header; never in messages or errors. */
  token: string;
  adapterId: string;
  /** Injectable fetch for tests and offline examples. Default `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Default per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
  /**
   * Secret values (in addition to the token) to scrub from error messages — pass generated
   * passwords, returned connection strings, etc.
   */
  redactValues?: readonly string[];
};

export type ManagementHttpRequest = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** JSON-serializable request body. */
  body?: unknown;
  /** Query parameters; `undefined` values are skipped. */
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
  /** Per-request timeout in milliseconds (overrides the config default). */
  timeoutMs?: number;
};

export type ManagementHttpResponse = {
  status: number;
  /** Parsed JSON body, or the raw text when the body is not JSON, or null when empty. */
  body: unknown;
  headers: Record<string, string>;
};

export type ManagementHttp = {
  request(path: string, request?: ManagementHttpRequest): Promise<ManagementHttpResponse>;
  /**
   * Register additional secret values (e.g. passwords and connection strings returned by a
   * create response) to scrub from all later error messages. Values already returned in results
   * must never leak through a subsequent failure message.
   */
  registerSecrets(values: readonly string[]): void;
  readonly config: ManagementHttpConfig;
};

const DEFAULT_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Secret-bearing key names that must not survive into `raw` payloads. This list is the shared
 * baseline; adapters redact their payloads with `redactRecord(value, keys)` before returning.
 */
export const SECRET_KEYS: readonly string[] = [
  'password',
  'db_pass',
  'connection_uri',
  'connection_uris',
  'connection_string',
  'connectionString',
  'api_key',
  'apiKey',
  'anon_key',
  'service_role_key',
  'secret',
  'token',
  'access_token',
  'refresh_token',
];

/** Replace every occurrence of a secret value in `text` with a redaction marker. */
export function redactText(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) {
    if (value !== '' && out.includes(value)) {
      out = out.split(value).join('[redacted]');
    }
  }
  return out;
}

/** Deep-clone a JSON value, replacing string/number values under secret keys with a marker. */
export function redactRecord<T>(value: T, keys: readonly string[] = SECRET_KEYS): T {
  const keySet = new Set(keys);
  const walk = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(walk);
    if (isRecord(input)) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(input)) {
        out[key] =
          keySet.has(key) && (typeof item === 'string' || typeof item === 'number')
            ? '[redacted]'
            : walk(item);
      }
      return out;
    }
    return input;
  };
  return walk(value) as T;
}

/** Extract a provider error message/code from the common response body shapes. */
function describeProviderError(body: unknown): { message?: string; code?: string } {
  if (typeof body === 'string' && body.trim() !== '') {
    return { message: body.length > 300 ? `${body.slice(0, 300)}…` : body };
  }
  if (!isRecord(body)) return {};
  const directMessage = body['message'] ?? body['error_description'] ?? body['msg'] ?? body['error'];
  const directCode = body['error_code'] ?? body['code'];
  if (typeof directMessage === 'string' && directMessage !== '') {
    return {
      message: directMessage,
      ...(typeof directCode === 'string' ? { code: directCode } : {}),
    };
  }
  if (isRecord(directMessage)) {
    const nested = directMessage['message'];
    const nestedCode = directMessage['code'] ?? directMessage['error_code'];
    return {
      ...(typeof nested === 'string' ? { message: nested } : {}),
      ...(typeof nestedCode === 'string' ? { code: nestedCode } : {}),
    };
  }
  return {};
}

function parseRetryAfterMs(headers: Record<string, string>): number | undefined {
  const retryAfter = headers['retry-after'];
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  }
  // Supabase: X-RateLimit-Reset is seconds remaining in the window.
  const reset = headers['x-ratelimit-reset'];
  if (reset !== undefined) {
    const seconds = Number(reset);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  }
  return undefined;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers) out[key.toLowerCase()] = value;
  return out;
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return null;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text; // truthful: the body claimed JSON but is not parseable
    }
  }
  return text;
}

function errorFromStatus(
  status: number,
  provider: { message?: string; code?: string },
  options: { method: string; path: string; retryAfterMs?: number },
): ManagementError {
  const mutating = options.method !== 'GET';
  const base = `${options.method} ${options.path} failed with status ${status}`;
  const detail = provider.message ? `: ${provider.message}` : '';
  const common = {
    status,
    ...(provider.code !== undefined ? { providerErrorCode: provider.code } : {}),
    ...(options.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {}),
  };
  switch (status) {
    case 401:
      return new ManagementError(
        `${base}. The credential was rejected (401). Check that it is valid and not revoked.${detail}`,
        { code: 'AUTH', ...common },
      );
    case 403:
      return new ManagementError(
        `${base}. The credential is valid but not allowed to perform this operation (403).${detail}`,
        { code: 'PERMISSION', ...common },
      );
    case 404:
      return new ManagementError(`${base}: resource not found (404).${detail}`, {
        code: 'NOT_FOUND',
        ...common,
      });
    case 409:
      return new ManagementError(`${base}: conflict with the current state (409).${detail}`, {
        code: 'CONFLICT',
        ...common,
      });
    case 423:
      // Neon: overlapping operations lock the project; retryable with backoff.
      return new ManagementError(
        `${base}: the resource is temporarily locked by another operation (423).${detail}`,
        { code: 'CONFLICT', retryable: true, ...common },
      );
    case 429:
      return new ManagementError(
        `${base}: rate limit exceeded (429). Retry after the indicated window.${detail}`,
        { code: 'RATE_LIMIT', retryable: true, ...common },
      );
    case 400:
    case 422:
      return new ManagementError(`${base}: the request was rejected (400/422).${detail}`, {
        code: 'VALIDATION',
        ...common,
      });
    default:
      if (status >= 500) {
        return new ManagementError(
          `${base}: the provider reported a server error (${status}). The request may or may not have been applied.${detail}`,
          { code: 'PROVIDER', ...(mutating ? { indeterminate: true } : {}), ...common },
        );
      }
      return new ManagementError(`${base}. ${detail}`, { code: 'PROVIDER', ...common });
  }
}

export function createManagementHttp(config: ManagementHttpConfig): ManagementHttp {
  const fetchImpl: FetchLike = config.fetch ?? ((input, init) => fetch(input, init));
  const defaultTimeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Mutable registry: the bearer token plus any values registered later (e.g. one-time
  // passwords extracted from a create response). Every error message passes through redactText.
  const redactValues: string[] = [config.token, ...(config.redactValues ?? [])];

  function throwTransportError(
    error: unknown,
    context: { method: string; path: string; abortedByTimeout: boolean; abortedByCaller: boolean },
  ): never {
    if (context.abortedByCaller || (error instanceof Error && error.name === 'AbortError' && !context.abortedByTimeout)) {
      throw new ManagementError(
        `${context.method} ${context.path} was aborted before completion.`,
        { code: 'ABORTED', adapterId: config.adapterId },
      );
    }
    if (context.abortedByTimeout) {
      throw new ManagementError(
        `${context.method} ${context.path} timed out.`,
        {
          code: 'TIMEOUT',
          adapterId: config.adapterId,
          // A timed-out mutation may still have been applied by the provider.
          ...(context.method !== 'GET' ? { indeterminate: true } : {}),
        },
      );
    }
    const message = error instanceof Error && error.message !== '' ? error.message : String(error);
    throw new ManagementError(
      `${context.method} ${context.path} failed: ${redactText(message, redactValues)}`,
      {
        code: 'CONNECTION',
        adapterId: config.adapterId,
        ...(context.method !== 'GET' ? { indeterminate: true } : {}),
        cause: error,
      },
    );
  }

  async function request(path: string, req: ManagementHttpRequest = {}): Promise<ManagementHttpResponse> {
    const method = req.method ?? 'GET';
    if (req.body !== undefined && method === 'GET') {
      throw new ManagementError(
        `${config.adapterId}: GET requests must not carry a body.`,
        { code: 'CONFIGURATION', adapterId: config.adapterId },
      );
    }
    const url = new URL(`${config.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(req.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const timeoutMs = req.timeoutMs ?? defaultTimeoutMs;
    const controller = new AbortController();
    let abortedByTimeout = false;
    const timer = setTimeout(() => {
      abortedByTimeout = true;
      controller.abort();
    }, timeoutMs);
    const externalSignal = req.signal;
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) onExternalAbort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${config.token}`,
          Accept: 'application/json',
          ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      throwTransportError(error, {
        method,
        path,
        abortedByTimeout,
        abortedByCaller: externalSignal?.aborted === true,
      });
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }

    const headers = headersToRecord(response.headers);
    const body = await parseBody(response);
    if (!response.ok) {
      const provider = describeProviderError(body);
      const message = redactText(provider.message ?? '', redactValues);
      throw errorFromStatus(response.status, { ...provider, ...(message ? { message } : {}) }, {
        method,
        path,
        retryAfterMs: parseRetryAfterMs(headers),
      });
    }
    return { status: response.status, body, headers };
  }

  function registerSecrets(values: readonly string[]): void {
    for (const value of values) {
      if (typeof value === 'string' && value !== '' && !redactValues.includes(value)) {
        redactValues.push(value);
      }
    }
  }

  return { request, registerSecrets, config };
}
