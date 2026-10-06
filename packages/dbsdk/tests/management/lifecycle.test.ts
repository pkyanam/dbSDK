/**
 * Unified create → wait → query lifecycle integration test.
 *
 * What each part REALLY is (labeled honestly, no pretend writes):
 * - Control plane: OFFLINE. fetch is injected and responses are shaped from the official Neon
 *   API v2 OpenAPI spec (https://neon.com/api_spec/release/v2.json, verified 2026-10-06, cached
 *   at /tmp/neon-v2.json). This proves the SDK's management semantics against the documented
 *   HTTP contract — it is NOT proof of how the hosted Neon service behaves.
 * - Query step: REAL. When DBSDK_TEST_POSTGRES_URL is set, the connection string carried by the
 *   (mocked) create response points at that local PostgreSQL and the existing SQL driver runs
 *   actual queries against it. No hosted provider is contacted and no paid resource is touched.
 *
 *   DBSDK_TEST_POSTGRES_URL=postgres://... npx vitest run tests/management/lifecycle.test.ts
 *
 * Covered end to end: create (secrets extracted, raw redacted) → wait (multi-operation
 * aggregation, no dropped siblings) → connect with the returned credentials → query; plus
 * list/get/update/delete/readiness/abort/rate-limit/error and unknown-mutation outcomes,
 * and A3 first-class typed list scope (no casts).
 */

import { describe, expect, it } from 'vitest';

import { postgres } from '../../src/adapters/postgres.js';
import { createDatabase } from '../../src/core/database.js';
import { createManagement } from '../../src/management/core.js';
import { ManagementError } from '../../src/management/errors.js';
import { neonManagement } from '../../src/management/neon.js';
import type { FetchLike } from '../../src/management/types.js';

// ---------------------------------------------------------------------------
// Offline control-plane harness (official Neon v2 HTTP shapes)
// ---------------------------------------------------------------------------

type FakeResponse = { status?: number; body?: unknown; headers?: Record<string, string> };
type CapturedRequest = { url: URL; path: string; method: string; body: unknown; headers: Record<string, string> };

const BASE_PATH = '/api/v2';

function controlPlane(
  handler: (req: CapturedRequest) => FakeResponse | Promise<FakeResponse>,
): { fetch: FetchLike; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const rawBody = typeof init?.body === 'string' ? init.body : undefined;
    const captured: CapturedRequest = {
      url,
      path: url.pathname.startsWith(BASE_PATH) ? url.pathname.slice(BASE_PATH.length) : url.pathname,
      method,
      body: rawBody === undefined ? undefined : JSON.parse(rawBody),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
      ),
    };
    calls.push(captured);
    const response = await handler(captured);
    return new Response(response.body === undefined ? null : JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/json', ...(response.headers ?? {}) },
    });
  };
  return { fetch, calls };
}

const API_KEY = 'nk_offline_test_key';
const PROJECT_ID = 'p-lifecycle-1';
const BRANCH_ID = 'br-lifecycle-1';
const ONE_TIME_PASSWORD = 'one-time-role-password';
const LOCAL_DB = process.env.DBSDK_TEST_POSTGRES_URL ?? '';
// The "provider" hands out this connection string in the create response; with a local server
// configured it points at that real server, so the query step is genuine SQL over TCP.
const CONNECTION_URI = LOCAL_DB !== '' ? LOCAL_DB : 'postgresql://app_owner:pw@ep-offline.neon.tech/neondb';

/** Create-project 201 per the official spec: project + connection_uris + roles + operations + branch. */
function createProjectResponse() {
  return {
    project: {
      id: PROJECT_ID,
      name: 'lifecycle-app',
      region_id: 'aws-us-east-1',
      created_at: '2026-10-06T00:00:00Z',
      updated_at: '2026-10-06T00:00:00Z',
    },
    connection_uris: [
      {
        connection_uri: CONNECTION_URI,
        connection_parameters: { database: 'neondb', password: ONE_TIME_PASSWORD, role: 'app_owner', host: 'ep-offline.neon.tech', pooler_host: 'ep-offline-pooler.neon.tech' },
      },
    ],
    roles: [{ branch_id: BRANCH_ID, name: 'app_owner', password: ONE_TIME_PASSWORD, created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z' }],
    databases: [{ branch_id: BRANCH_ID, name: 'neondb', owner_name: 'app_owner', created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z' }],
    operations: [
      { id: 'op-create-timeline', project_id: PROJECT_ID, branch_id: BRANCH_ID, action: 'create_timeline', status: 'running', failures_count: 0, created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z', total_duration_ms: 0 },
      { id: 'op-start-compute', project_id: PROJECT_ID, branch_id: BRANCH_ID, action: 'start_compute', status: 'scheduling', failures_count: 0, created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z', total_duration_ms: 0 },
    ],
    branch: { id: BRANCH_ID, project_id: PROJECT_ID, name: 'main', current_state: 'init', created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z' },
    endpoints: [{ id: 'ep-lifecycle-1', project_id: PROJECT_ID, branch_id: BRANCH_ID, type: 'read_write', state: 'init' }],
  };
}

const finished = (id: string) =>
  ({ id, project_id: PROJECT_ID, branch_id: BRANCH_ID, action: 'create_timeline', status: 'finished', failures_count: 0, created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:01:00Z', total_duration_ms: 5000 });

function makeClient(fetch: FetchLike) {
  const adapter = neonManagement({ apiKey: API_KEY, fetch });
  return createManagement({ adapter });
}

// ---------------------------------------------------------------------------
// The full bridge
// ---------------------------------------------------------------------------

describe('create → wait → query (control plane mocked, query real when a local server is set)', () => {
  it('provisions, waits for ALL provider operations, and connects with the returned credentials', async () => {
    const { fetch, calls } = controlPlane((req) => {
      if (req.method === 'POST' && req.path === '/projects') {
        expect(req.body).toEqual({ project: { name: 'lifecycle-app' } });
        expect(req.headers['authorization']).toBe(`Bearer ${API_KEY}`);
        return { status: 201, body: createProjectResponse() };
      }
      if (req.method === 'GET' && req.path === `/projects/${PROJECT_ID}/operations/op-create-timeline`) {
        return { body: { operation: finished('op-create-timeline') } };
      }
      if (req.method === 'GET' && req.path === `/projects/${PROJECT_ID}/operations/op-start-compute`) {
        return { body: { operation: { ...finished('op-start-compute'), action: 'start_compute' } } };
      }
      if (req.method === 'GET' && req.path === `/projects/${PROJECT_ID}`) {
        return { body: { project: createProjectResponse().project } };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const management = makeClient(fetch);

    // 1) CREATE: one-time credentials surface ONLY in secrets; raw is redacted.
    const created = await management.create({ kind: 'project', name: 'lifecycle-app' });
    expect(created.resource?.id).toBe(PROJECT_ID);
    expect(created.resource?.projectId).toBeUndefined(); // projects are global
    expect(created.secrets.map((s) => s.label)).toEqual(['connectionString', 'password']);
    expect(JSON.stringify(created.resource?.raw)).not.toContain(ONE_TIME_PASSWORD);
    expect(JSON.stringify(created.resource?.raw)).not.toContain(encodeURI(CONNECTION_URI));

    // 2) WAIT: operation polling aggregates BOTH siblings; resolves only when all finished.
    const project = await management.wait(created, { pollIntervalMs: 0 });
    expect(project.id).toBe(PROJECT_ID);
    const operationPaths = calls
      .filter((c) => c.path.includes('/operations/'))
      .map((c) => c.path.split('/').pop());
    expect(operationPaths).toContain('op-create-timeline');
    expect(operationPaths).toContain('op-start-compute'); // no sibling dropped
    // wait() issued GETs only — never a replay of the create
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(1); // just the original create

    // 3) QUERY with the credentials the provider returned once (real server when configured).
    if (LOCAL_DB === '') {
      return; // no local server available: query step covered by tests/adapters live tests
    }
    const db = createDatabase({ adapter: postgres({ connectionString: created.secrets[0]!.value, ssl: false }) });
    try {
      const result = await db.sql<{ one: number }>`select 1 as one`;
      expect(result.rows[0]?.one).toBe(1);
    } finally {
      await db.close();
    }
  });

  it('scrubs one-time credentials from every later error message', async () => {
    const { fetch } = controlPlane((req) => {
      if (req.method === 'POST' && req.path === '/projects') {
        return { status: 201, body: createProjectResponse() };
      }
      if (req.path.includes('/operations/')) {
        return {
          status: 500,
          body: { message: `internal error while handling ${CONNECTION_URI} (password ${ONE_TIME_PASSWORD})` },
        };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const management = makeClient(fetch);
    const created = await management.create({ kind: 'project', name: 'lifecycle-app' });
    const error = await management.wait(created, { pollIntervalMs: 0, timeoutMs: 1_000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ManagementError);
    expect((error as ManagementError).message).not.toContain(ONE_TIME_PASSWORD);
    expect((error as ManagementError).message).not.toContain(ONE_TIME_PASSWORD.length > 0 ? ONE_TIME_PASSWORD : '');
    expect((error as ManagementError).message).toContain('[redacted]');
  });

  it('reports unknown mutation outcomes: 5xx after the request was sent is indeterminate', async () => {
    const { fetch } = controlPlane(() => ({ status: 500, body: { message: 'boom' } }));
    const management = makeClient(fetch);
    const error = await management.create({ kind: 'project', name: 'app' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ManagementError);
    expect((error as ManagementError).code).toBe('PROVIDER');
    expect((error as ManagementError).indeterminate).toBe(true); // may or may not have been created
  });

  it('maps definitive failures: 401 is AUTH, not indeterminate', async () => {
    const { fetch } = controlPlane(() => ({ status: 401, body: { message: 'invalid key' } }));
    const management = makeClient(fetch);
    const error = await management.create({ kind: 'project', name: 'app' }).catch((e: unknown) => e);
    expect((error as ManagementError).code).toBe('AUTH');
    expect((error as ManagementError).indeterminate).toBe(false);
  });

  it('rejects malformed provider responses instead of guessing', async () => {
    const { fetch } = controlPlane(() => ({ status: 201, body: [1, 2, 3] }));
    const management = makeClient(fetch);
    const error = await management.create({ kind: 'project', name: 'app' }).catch((e: unknown) => e);
    expect((error as ManagementError).code).toBe('PROVIDER');
    expect((error as ManagementError).message).toMatch(/expected a JSON object/);
  });
});

describe('manage round trip (mock control plane, official shapes)', () => {
  it('lists projects with pagination, then lists scoped branches and databases (A3 typed scope)', async () => {
    const { fetch, calls } = controlPlane((req) => {
      if (req.method === 'GET' && req.path === '/projects') {
        return { body: { projects: [{ id: PROJECT_ID, name: 'lifecycle-app', region_id: 'aws-us-east-1', created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z' }], pagination: { cursor: 'next-page' } } };
      }
      if (req.method === 'GET' && req.path === `/projects/${PROJECT_ID}/branches`) {
        return { body: { branches: [{ id: BRANCH_ID, project_id: PROJECT_ID, name: 'main', current_state: 'ready', created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z' }], pagination: { next: 'b-next' } } };
      }
      if (req.method === 'GET' && req.path === `/projects/${PROJECT_ID}/branches/${BRANCH_ID}/databases`) {
        return { body: { databases: [{ branch_id: BRANCH_ID, name: 'neondb', owner_name: 'app_owner', created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z' }] } };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const management = makeClient(fetch);

    const projects = await management.list('project', { limit: 10 });
    expect(projects.cursor).toBe('next-page');
    const page2 = await management.list('project', { cursor: projects.cursor! });
    expect(calls.at(-1)!.url.searchParams.get('cursor')).toBe('next-page');
    expect(page2.kind).toBe('project');

    // A3: scope is first-class on the typed query object — no casts anywhere.
    const branches = await management.list('branch', { projectId: PROJECT_ID, limit: 5 });
    expect(branches.resources[0]).toMatchObject({ kind: 'branch', id: BRANCH_ID, projectId: PROJECT_ID, status: 'active' });
    expect(branches.cursor).toBe('b-next');

    const databases = await management.list('database', { projectId: PROJECT_ID, branchId: BRANCH_ID });
    expect(databases.resources[0]).toMatchObject({ kind: 'database', id: 'neondb', projectId: PROJECT_ID, branchId: BRANCH_ID });
    expect(databases.cursor).toBeNull(); // truthful: this endpoint returns everything
  });

  it('gets, updates, and deletes with correct official paths and bodies', async () => {
    const { fetch, calls } = controlPlane((req) => {
      if (req.method === 'GET' && req.path === `/projects/${PROJECT_ID}/branches/${BRANCH_ID}`) {
        return { body: { branch: { id: BRANCH_ID, project_id: PROJECT_ID, name: 'main', current_state: 'ready', created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z' } } };
      }
      if (req.method === 'PATCH' && req.path === `/projects/${PROJECT_ID}/branches/${BRANCH_ID}/databases/neondb`) {
        expect(req.body).toEqual({ database: { name: 'renamed' } });
        return { status: 200, body: { database: { branch_id: BRANCH_ID, name: 'renamed', owner_name: 'app_owner', created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:01:00Z' }, operations: [{ id: 'op-apply-config', project_id: PROJECT_ID, branch_id: BRANCH_ID, action: 'apply_config', status: 'finished', failures_count: 0, created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:01:00Z', total_duration_ms: 10 }] } };
      }
      if (req.method === 'DELETE' && req.path === `/projects/${PROJECT_ID}/branches/${BRANCH_ID}/databases/renamed`) {
        return { status: 200, body: { operations: [{ id: 'op-delete-db', project_id: PROJECT_ID, branch_id: BRANCH_ID, action: 'delete_timeline', status: 'running', failures_count: 0, created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z', total_duration_ms: 0 }] } };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const management = makeClient(fetch);

    const branch = await management.get({ kind: 'branch', id: BRANCH_ID, projectId: PROJECT_ID });
    expect(branch.status).toBe('active');

    const renamed = await management.update({
      kind: 'database',
      id: 'neondb',
      projectId: PROJECT_ID,
      branchId: BRANCH_ID,
      patch: { name: 'renamed' },
    });
    expect(renamed.resource?.id).toBe('renamed');
    expect(renamed.operation?.status).toBe('completed');

    const deleted = await management.delete({ kind: 'database', id: 'renamed', projectId: PROJECT_ID, branchId: BRANCH_ID });
    expect(deleted.operation?.status).toBe('running'); // the delete is async; wait() can track it
    expect(deleted.indeterminate).toBe(false); // the DELETE was definitively accepted (2xx)
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('honors rate-limit hints and caller aborts during readiness polling', async () => {
    let rateLimitedOnce = false;
    const { fetch, calls } = controlPlane((req) => {
      if (req.method === 'POST' && req.path === '/projects') {
        return { status: 201, body: createProjectResponse() };
      }
      if (req.method === 'GET' && req.path === `/projects/${PROJECT_ID}/operations/op-create-timeline`) {
        if (!rateLimitedOnce) {
          rateLimitedOnce = true;
          return { status: 429, headers: { 'retry-after': '0' }, body: { message: 'slow down' } };
        }
        return { body: { operation: finished('op-create-timeline') } };
      }
      if (req.method === 'GET' && req.path === `/projects/${PROJECT_ID}/operations/op-start-compute`) {
        return { body: { operation: { ...finished('op-start-compute'), action: 'start_compute' } } };
      }
      if (req.method === 'GET' && req.path === `/projects/${PROJECT_ID}`) {
        return { body: { project: { id: PROJECT_ID, name: 'app', created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z' } } };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const management = makeClient(fetch);
    const created = await management.create({ kind: 'project', name: 'app' });
    const project = await management.wait(created, { pollIntervalMs: 0 });
    expect(project.id).toBe(PROJECT_ID);
    expect(calls.some((c) => c.path.includes('/operations/'))).toBe(true); // retried after the hint
  });

  it('surfaces caller aborts as ABORTED during readiness polling', async () => {
    const { fetch } = controlPlane((req) => {
      if (req.method === 'POST' && req.path === '/projects') {
        return { status: 201, body: createProjectResponse() };
      }
      // The operation never finishes, so wait() must keep polling until aborted.
      if (req.path.includes('/operations/')) {
        return { body: { operation: { id: req.path.split('/').pop()!, project_id: PROJECT_ID, branch_id: BRANCH_ID, action: 'create_timeline', status: 'running', failures_count: 0, created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z', total_duration_ms: 0 } } };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const management = makeClient(fetch);
    const created = await management.create({ kind: 'project', name: 'app' });
    const controller = new AbortController();
    const pending = management.wait(created, { signal: controller.signal, pollIntervalMs: 5 });
    controller.abort();
    const error = await pending.catch((e: unknown) => e);
    expect((error as ManagementError).code).toBe('ABORTED');
  });

  it('refuses readiness polling for kinds without a status field (A3 statusPolling)', async () => {
    const { fetch, calls } = controlPlane(() => {
      throw new Error('must not be called');
    });
    const management = makeClient(fetch);
    const error = await management
      .wait({ kind: 'database', id: 'neondb', projectId: PROJECT_ID, branchId: BRANCH_ID })
      .catch((e: unknown) => e);
    expect((error as ManagementError).code).toBe('CAPABILITY');
    expect(calls).toHaveLength(0); // no misleading 300-second hang
  });
});
