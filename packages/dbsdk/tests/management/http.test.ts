/**
 * HTTP transport tests for the management plane — fully offline via injected fetch.
 * Covers: auth/URL/body construction, status→error mapping (including Neon's 423),
 * retryAfter parsing, indeterminate rules for mutations, timeouts, caller aborts,
 * and secret redaction.
 */

import { describe, expect, it } from 'vitest';

import { ManagementError } from '../../src/management/errors.js';
import {
  createManagementHttp,
  redactRecord,
  redactText,
  SECRET_KEYS,
} from '../../src/management/http.js';
import type { FetchLike } from '../../src/management/types.js';

const TOKEN = 'sbp_secret_token_value';
const BASE = 'https://api.example.com/v1';

function httpWith(fetchImpl: FetchLike, overrides: Partial<{ token: string }> = {}) {
  return createManagementHttp({
    baseUrl: BASE,
    token: overrides.token ?? TOKEN,
    adapterId: 'test',
    fetch: fetchImpl,
  });
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const init: ResponseInit = {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  };
  return new Response(JSON.stringify(body), init);
}

describe('management http transport', () => {
  it('sends the bearer credential, base URL, query params, and JSON body', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse(200, { ok: true });
    };
    const http = httpWith(fetchImpl);

    await http.request('/projects', {
      method: 'POST',
      body: { name: 'my-app' },
      query: { limit: 10, cursor: undefined },
    });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(`${BASE}/projects?limit=10`);
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('content-type')).toBe('application/json');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ name: 'my-app' }));
  });

  it('maps 401/403/404/409 to their codes without indeterminate', async () => {
    const cases: Array<[number, string]> = [
      [401, 'AUTH'],
      [403, 'PERMISSION'],
      [404, 'NOT_FOUND'],
      [409, 'CONFLICT'],
    ];
    for (const [status, code] of cases) {
      const http = httpWith(async () => jsonResponse(status, { message: 'nope' }));
      const error = await http.request('/projects', { method: 'POST', body: {} }).catch((e) => e);
      expect(error).toBeInstanceOf(ManagementError);
      expect((error as ManagementError).code).toBe(code);
      expect((error as ManagementError).indeterminate).toBe(false);
    }
  });

  it('maps 423 to a retryable CONFLICT and includes the provider message', async () => {
    const http = httpWith(async () =>
      jsonResponse(423, { message: 'another operation is running' }),
    );
    const error = await http
      .request('/projects/p/operations', { method: 'POST', body: {} })
      .catch((e) => e);
    expect((error as ManagementError).code).toBe('CONFLICT');
    expect((error as ManagementError).retryable).toBe(true);
    expect((error as ManagementError).message).toContain('another operation is running');
  });

  it('maps 429 to RATE_LIMIT with retryAfterMs from X-RateLimit-Reset and Retry-After', async () => {
    const httpReset = httpWith(async () =>
      jsonResponse(429, {}, { 'x-ratelimit-reset': '30' }),
    );
    const resetError = await httpReset.request('/projects').catch((e) => e);
    expect((resetError as ManagementError).code).toBe('RATE_LIMIT');
    expect((resetError as ManagementError).retryAfterMs).toBe(30_000);

    const httpRetryAfter = httpWith(async () =>
      jsonResponse(429, {}, { 'retry-after': '2' }),
    );
    const retryAfterError = await httpRetryAfter.request('/projects').catch((e) => e);
    expect((retryAfterError as ManagementError).retryAfterMs).toBe(2_000);
  });

  it('marks 5xx as indeterminate for mutations but not for GETs', async () => {
    const http = httpWith(async () => jsonResponse(500, { message: 'boom' }));
    const postError = await http.request('/projects', { method: 'POST', body: {} }).catch((e) => e);
    expect((postError as ManagementError).code).toBe('PROVIDER');
    expect((postError as ManagementError).retryable).toBe(true);
    expect((postError as ManagementError).indeterminate).toBe(true);

    const getError = await http.request('/projects').catch((e) => e);
    expect((getError as ManagementError).indeterminate).toBe(false);
  });

  it('marks transport failures as CONNECTION and indeterminate for mutations', async () => {
    const http = httpWith(async () => {
      throw new Error('ECONNRESET reading socket');
    });
    const postError = await http.request('/projects', { method: 'POST', body: {} }).catch((e) => e);
    expect((postError as ManagementError).code).toBe('CONNECTION');
    expect((postError as ManagementError).indeterminate).toBe(true);

    const getError = await http.request('/projects').catch((e) => e);
    expect((getError as ManagementError).indeterminate).toBe(false);
  });

  it('times out with TIMEOUT and indeterminate for mutations', async () => {
    const fetchImpl: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    const http = httpWith(fetchImpl);
    const error = await http
      .request('/projects', { method: 'POST', body: {}, timeoutMs: 20 })
      .catch((e) => e);
    expect((error as ManagementError).code).toBe('TIMEOUT');
    expect((error as ManagementError).indeterminate).toBe(true);
  });

  it('surfaces caller aborts as ABORTED, never indeterminate', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl: FetchLike = (_input, init) => {
      if (init?.signal?.aborted) {
        return Promise.reject(new DOMException('aborted', 'AbortError'));
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    };
    const http = httpWith(fetchImpl);
    const error = await http
      .request('/projects', { method: 'POST', body: {}, signal: controller.signal })
      .catch((e) => e);
    expect((error as ManagementError).code).toBe('ABORTED');
    expect((error as ManagementError).indeterminate).toBe(false);
  });

  it('never leaks the credential in error messages, including reflected provider text', async () => {
    const http = httpWith(async () => jsonResponse(401, { message: `bad key ${TOKEN} denied` }));
    const error = await http.request('/projects').catch((e) => e);
    expect((error as ManagementError).message).not.toContain(TOKEN);
    expect((error as ManagementError).message).toContain('[redacted]');
  });

  it('parses JSON bodies and lowercases headers on success', async () => {
    const http = httpWith(async () =>
      jsonResponse(200, { projects: [] }, { 'X-Request-Id': 'abc' }),
    );
    const response = await http.request('/projects');
    expect(response.body).toEqual({ projects: [] });
    expect(response.headers['x-request-id']).toBe('abc');
    expect(response.status).toBe(200);
  });
});

describe('redaction helpers', () => {
  it('redacts secret values from text', () => {
    expect(redactText('password is hunter2 ok', ['hunter2'])).toBe('password is [redacted] ok');
    expect(redactText('no secrets here', ['nothing'])).toBe('no secrets here');
  });

  it('redacts secrets registered at runtime from later error messages', async () => {
    // Simulates a credential returned by a create response (one-time secret) that a later
    // failing request must never echo back.
    let created = false;
    const http = httpWith(async () => {
      // First call succeeds; every later call fails with a message that echoes the secret.
      if (!created) {
        created = true;
        return jsonResponse(201, { ok: true });
      }
      return jsonResponse(500, { message: 'quoted value postgresql://u:one-time-pass@host/db in log' });
    });
    const first = await http.request('/projects', { method: 'POST', body: {} });
    expect(first.status).toBe(201);
    http.registerSecrets(['one-time-pass']);
    const error = await http.request('/projects', { method: 'POST', body: {} }).catch((e) => e);
    expect(error).toBeInstanceOf(ManagementError);
    expect((error as ManagementError).message).toContain('[redacted]');
    expect((error as ManagementError).message).not.toContain('one-time-pass');
  });

  it('ignores empty and duplicate registered secrets', async () => {
    const http = httpWith(async () => jsonResponse(500, { message: 'token dup leaked' }));
    http.registerSecrets(['', 'dup']);
    http.registerSecrets(['dup']);
    const error = await http.request('/x').catch((e) => e);
    expect(error).toBeInstanceOf(ManagementError);
    expect((error as ManagementError).message).not.toContain('dup');
  });

  it('redacts secret keys from records deeply', () => {
    const input = {
      project: {
        name: 'app',
        db_pass: 's3cret',
        connection_uris: [{ connection_uri: 'postgres://u:p@h/db' }],
        nested: { token: 't', keep: 1 },
      },
    };
    const output = redactRecord(input);
    expect(output.project.db_pass).toBe('[redacted]');
    expect(output.project.connection_uris[0]!.connection_uri).toBe('[redacted]');
    expect(output.project.nested.token).toBe('[redacted]');
    expect(output.project.nested.keep).toBe(1);
    expect(output.project.name).toBe('app');
  });

  it('SECRET_KEYS covers the baseline credential field names', () => {
    for (const key of ['password', 'db_pass', 'connection_uris', 'api_key', 'token']) {
      expect(SECRET_KEYS).toContain(key);
    }
  });
});
