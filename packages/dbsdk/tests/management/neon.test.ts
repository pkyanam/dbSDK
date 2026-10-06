/**
 Neon Management adapter tests (`dbsdk/management/neon`).

 All tests are offline: fetch is injected and every response body is shaped from the official
 Neon API v2 OpenAPI spec (https://neon.com/api_spec/release/v2.json,
 verified 2026-10-06). No hosted requests, no credentials read.

 Beyond request/response shape mirroring, these tests prove the SEMANTICS of the lifecycle:

 - multi-operation truth: Neon returns several async operations per write; wait() must not
   resolve while ANY sibling operation is still running, and must fail as soon as any fails.
 - poll scope: wait() on a database write result must finish by fetching the DATABASE (the
   operation payload only carries branch_id; re-routing to the branch would be a silent loss).
 - status mapping honesty: branches map current_state; projects/databases have no status field
   and stay `unknown` (a bare project ResourceRef therefore can never resolve wait()).
 - redaction: credentials appear only in `secrets` (and `raw.connectionUri` with the explicit
   `reveal: true` opt-in), never in raw payloads or error messages.
 */

import { describe, expect, it } from 'vitest';

import { createManagement, describeManagementCapabilities } from '../../src/management/core.js';
import { ManagementError } from '../../src/management/errors.js';
import { neonManagement } from '../../src/management/neon.js';
import type { FetchLike, ManagementOperation } from '../../src/management/types.js';

// ---------------------------------------------------------------------------
// Offline fetch harness
// ---------------------------------------------------------------------------

type FakeResponse = { status?: number; body?: unknown; headers?: Record<string, string> };
type CapturedRequest = {
  url: URL;
  /** URL pathname relative to the API base (e.g. `/projects`), for readable assertions. */
  path: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
};

const BASE_PATH = '/api/v2'; // pathname prefix of the official base URL

function fakeFetch(
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
      // Normalize header keys to lowercase the way real Headers iteration does
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

const API_KEY = 'nk_secret_key_value';
const BASE = 'https://console.neon.tech/api/v2';
const NOW = '2026-10-06T00:00:00Z';
const SECRET_PW = 'supersecret-pw';
const SECRET_URI = `postgresql://app_owner:${SECRET_PW}@ep-cool-123.aws.neon.tech/neondb?sslmode=require`;

function makeAdapter(fetch: FetchLike, overrides: { baseUrl?: string; timeoutMs?: number } = {}) {
  const adapter = neonManagement({
    apiKey: API_KEY,
    fetch,
    baseUrl: overrides.baseUrl,
    timeoutMs: overrides.timeoutMs,
  });
  return { adapter, client: createManagement({ adapter }) };
}

/**
 * Assert that a promise rejects with a ManagementError of the given code and return it.
 * The lifecycle layer's contract: every failure is a typed, normalized ManagementError.
 */
async function expectManagementError(promise: Promise<unknown>, code: string): Promise<ManagementError> {
  const caught = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(caught).toBeInstanceOf(ManagementError);
  const err = caught as ManagementError;
  expect(err.code).toBe(code);
  return err;
}

/** Assert that a synchronous call throws a ManagementError of the given code. */
function expectSyncManagementError(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`expected a ${code} ManagementError, but nothing was thrown`);
  } catch (caught) {
    expect(caught).toBeInstanceOf(ManagementError);
    expect((caught as ManagementError).code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Fixtures shaped from the official spec
// ---------------------------------------------------------------------------

const opCreateTimeline = {
  id: 'op-create-timeline',
  project_id: 'p1',
  branch_id: 'b1',
  action: 'create_timeline',
  status: 'running',
  failures_count: 0,
  created_at: NOW,
  updated_at: NOW,
};
const opStartCompute = {
  id: 'op-start-compute',
  project_id: 'p1',
  branch_id: 'b1',
  action: 'start_compute',
  status: 'scheduling',
  failures_count: 0,
  created_at: NOW,
  updated_at: NOW,
};
const projectFixture = {
  id: 'p1',
  name: 'app',
  region_id: 'aws-us-east-1',
  org_id: 'org1',
  pg_version: 17,
  created_at: NOW,
  updated_at: NOW,
};
const branchFixture = {
  id: 'b1',
  project_id: 'p1',
  name: 'main',
  current_state: 'ready',
  created_at: NOW,
  updated_at: NOW,
};
const databaseFixture = {
  id: 876692,
  branch_id: 'b1',
  name: 'analytics',
  owner_name: 'app_owner',
  created_at: NOW,
  updated_at: NOW,
};
const createProjectResponse = {
  project: projectFixture,
  connection_uris: [
    {
      connection_uri: SECRET_URI,
      connection_parameters: {
        database: 'neondb',
        password: SECRET_PW,
        role: 'app_owner',
        host: 'ep-cool-123.aws.neon.tech',
        pooler_host: 'ep-cool-123-pooler.aws.neon.tech',
      },
    },
  ],
  roles: [
    {
      branch_id: 'b1',
      name: 'app_owner',
      password: SECRET_PW,
      protected: false,
      created_at: NOW,
      updated_at: NOW,
    },
  ],
  databases: [databaseFixture],
  operations: [opCreateTimeline, opStartCompute],
  branch: { ...branchFixture, current_state: 'init' },
  endpoints: [{ id: 'ep1', branch_id: 'b1', host: 'ep-cool-123.aws.neon.tech', type: 'read_write' }],
};
const createBranchResponse = {
  branch: {
    id: 'b2',
    project_id: 'p1',
    name: 'feature',
    parent_id: 'b1',
    current_state: 'init',
    created_at: NOW,
    updated_at: NOW,
  },
  endpoints: [{ id: 'ep2', branch_id: 'b2', host: 'ep-feature.aws.neon.tech', type: 'read_write' }],
  operations: [
    {
      id: 'op-branch-create',
      project_id: 'p1',
      branch_id: 'b2',
      action: 'create_branch',
      status: 'running',
      failures_count: 0,
      created_at: NOW,
      updated_at: NOW,
    },
  ],
  roles: [
    {
      branch_id: 'b2',
      name: 'feature_owner',
      password: 'branch-pw-secret',
      protected: false,
      created_at: NOW,
      updated_at: NOW,
    },
  ],
  databases: [],
  connection_uris: [
    {
      connection_uri: 'postgresql://feature_owner:branch-pw-secret@ep-feature.aws.neon.tech/neondb',
      connection_parameters: {
        database: 'neondb',
        password: 'branch-pw-secret',
        role: 'feature_owner',
        host: 'ep-feature.aws.neon.tech',
        pooler_host: 'ep-feature-pooler.aws.neon.tech',
      },
    },
  ],
};
const createDatabaseResponse = {
  database: databaseFixture,
  operations: [
    {
      id: 'op-db-config',
      project_id: 'p1',
      branch_id: 'b1',
      endpoint_id: 'ep1',
      action: 'apply_config',
      status: 'running',
      failures_count: 0,
      created_at: NOW,
      updated_at: NOW,
    },
  ],
};

// ---------------------------------------------------------------------------
// Factory and capabilities
// ---------------------------------------------------------------------------

describe('neonManagement factory', () => {
  it('refuses a missing or empty apiKey before any dispatch', () => {
    const neverFetch = (() => Promise.reject(new Error('network must not be reached'))) as typeof fetch;
    expectSyncManagementError(() => neonManagement({ apiKey: '', fetch: neverFetch }), 'CONFIGURATION');
    // @ts-expect-error deliberately missing apiKey
    expectSyncManagementError(() => neonManagement({ fetch: neverFetch }), 'CONFIGURATION');
  });

  it('declares the honest capability table', () => {
    const { adapter } = makeAdapter((() => Promise.reject(new Error('no calls'))) as typeof fetch);
    expect(adapter.id).toBe('neon');
    expect(adapter.providerId).toBe('neon');
    expect(adapter.capabilities.resourceKinds).toEqual(['project', 'branch', 'database']);
    expect(adapter.capabilities.supported.update).toEqual(['project', 'branch', 'database']);
    expect(adapter.capabilities.supported.delete).toEqual(['project', 'branch', 'database']);
    expect(adapter.capabilities.pagination).toBe(true);
    expect(adapter.capabilities.asyncOperations).toBe(true);
    for (const level of Object.values(adapter.capabilities.evidence)) {
      expect(level).toBe('docs');
    }
    expect(adapter.capabilities.prerequisites['create:database']).toEqual(['owner']);
  });

  it('feeds describeManagementCapabilities as the single metadata source', () => {
    const { adapter } = makeAdapter((() => Promise.reject(new Error('no calls'))) as typeof fetch);
    const descriptor = describeManagementCapabilities(adapter);
    expect(descriptor.providerId).toBe('neon');
    expect(descriptor.operations.create).toEqual(['project', 'branch', 'database']);
    expect(descriptor.operations.delete).toEqual(['project', 'branch', 'database']);
    expect(descriptor.pagination).toBe(true);
    expect(descriptor.asyncOperations).toBe(true);
    expect(descriptor.resourceScopes).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Create project
// ---------------------------------------------------------------------------

describe('create project', () => {
  it('sends the official request and returns normalized resources, secrets, and ALL operations', async () => {
    const { fetch, calls } = fakeFetch((req) => {
      if (req.method === 'POST' && req.path === '/projects') {
        return { status: 201, body: createProjectResponse };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const { client } = makeAdapter(fetch);
    const result = await client.create({
      kind: 'project',
      name: 'app',
      region: 'aws-us-east-1',
      organizationId: 'org1',
      providerOptions: { pg_version: 17 },
    });

    // Request shape
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.href).toBe(`${BASE}/projects`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers['authorization']).toBe(`Bearer ${API_KEY}`);
    expect(calls[0]!.headers['accept']).toBe('application/json');
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[0]!.body).toEqual({
      project: { name: 'app', region_id: 'aws-us-east-1', org_id: 'org1', pg_version: 17 },
    });

    // Normalized resource (projects are global: no scope fields)
    expect(result.resource).toMatchObject({
      kind: 'project',
      providerId: 'neon',
      id: 'p1',
      name: 'app',
      region: 'aws-us-east-1',
      status: 'unknown', // the official project object has no lifecycle status field
      providerStatus: null,
      createdAt: NOW,
    });
    expect(result.resource?.projectId).toBeUndefined();

    // Multi-operation truth: every operation from the response stays visible
    expect(result.operation?.id).toBe('op-create-timeline'); // first in-flight op
    expect(result.operation?.ref).toEqual({ kind: 'project', id: 'p1' });
    expect(result.operation?.status).toBe('running');
    const rawOperations = result.operation?.raw['operations'];
    expect(Array.isArray(rawOperations)).toBe(true);
    expect(rawOperations).toHaveLength(2);

    // Secrets surface ONLY in secrets; raw payloads are redacted
    expect(result.secrets).toEqual([
      { label: 'connectionString', value: SECRET_URI },
      { label: 'password', value: SECRET_PW },
    ]);
    const rawText = JSON.stringify(result.resource?.raw) + JSON.stringify(result.operation?.raw);
    expect(rawText).not.toContain(SECRET_PW);
    expect(rawText).not.toContain('postgresql://app_owner');
    expect(result.indeterminate).toBe(false);
  });

  it('refuses plan and password fields that the official Neon API does not accept (pre-dispatch)', async () => {
    const { fetch, calls } = fakeFetch(() => {
      throw new Error('must not be called');
    });
    const { client } = makeAdapter(fetch);
    await expectManagementError(
      client.create({ kind: 'project', name: 'app', plan: 'free' }),
      'CONFIGURATION',
    );
    await expectManagementError(
      client.create({ kind: 'project', name: 'app', password: 'nope' }),
      'CONFIGURATION',
    );
    expect(calls).toHaveLength(0);
  });

  it('honors a baseUrl override (tests/self-hosted gateways only)', async () => {
    const { fetch, calls } = fakeFetch((req) => {
      if (req.method === 'POST' && req.path === '/projects') {
        return { status: 201, body: createProjectResponse };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const { client } = makeAdapter(fetch, { baseUrl: 'https://gateway.internal/api/v2' });
    await client.create({ kind: 'project', name: 'app' });
    expect(calls[0]!.url.href).toBe('https://gateway.internal/api/v2/projects');
  });
});

// ---------------------------------------------------------------------------
// Create branch
// ---------------------------------------------------------------------------

describe('create branch', () => {
  it('defaults to one read_write endpoint and maps name/parent, scope, status, and secrets', async () => {
    const { fetch, calls } = fakeFetch((req) => {
      if (req.method === 'POST' && req.path === '/projects/p1/branches') {
        return { status: 201, body: createBranchResponse };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const { client } = makeAdapter(fetch);
    const result = await client.create({
      kind: 'branch',
      projectId: 'p1',
      name: 'feature',
      sourceBranchId: 'b1',
      providerOptions: { branch: { init_source: 'parent-schema' } },
    });

    expect(calls[0]!.url.href).toBe(`${BASE}/projects/p1/branches`);
    expect(calls[0]!.body).toEqual({
      branch: { name: 'feature', parent_id: 'b1', init_source: 'parent-schema' },
      endpoints: [{ type: 'read_write' }], // default: a branch you can connect to
    });
    expect(result.resource).toMatchObject({
      kind: 'branch',
      id: 'b2',
      name: 'feature',
      projectId: 'p1',
      status: 'creating', // current_state 'init'
      providerStatus: 'init',
    });
    expect(result.operation?.ref).toEqual({ kind: 'branch', id: 'b2', projectId: 'p1' });
    expect(result.secrets).toEqual([
      { label: 'connectionString', value: 'postgresql://feature_owner:branch-pw-secret@ep-feature.aws.neon.tech/neondb' },
      { label: 'password', value: 'branch-pw-secret' },
    ]);
    expect(JSON.stringify(result.resource?.raw)).not.toContain('branch-pw-secret');
  });

  it('lets providerOptions.endpoints override the default compute', async () => {
    const { fetch, calls } = fakeFetch((req) => {
      if (req.method === 'POST' && req.path === '/projects/p1/branches') {
        return { status: 201, body: createBranchResponse };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const { client } = makeAdapter(fetch);
    await client.create({
      kind: 'branch',
      projectId: 'p1',
      providerOptions: { endpoints: [] }, // schema-only branch, no compute
    });
    expect(calls[0]!.body).toMatchObject({ endpoints: [] });
  });

  it('rejects unknown providerOptions keys and empty providerOptions.endpoints type (pre-dispatch)', async () => {
    const { fetch, calls } = fakeFetch(() => {
      throw new Error('must not be called');
    });
    const { client } = makeAdapter(fetch);
    await expectManagementError(
      client.create({ kind: 'branch', projectId: 'p1', providerOptions: { nonsense: true } }),
      'CONFIGURATION',
    );
    await expectManagementError(
      client.create({ kind: 'branch', projectId: 'p1', providerOptions: { endpoints: 'nope' } }),
      'CONFIGURATION',
    );
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Create database + the provision -> wait -> query bridge
// ---------------------------------------------------------------------------

describe('create database and wait()', () => {
  it('refuses to create a database without an owner (official requirement, pre-dispatch)', async () => {
    const { fetch, calls } = fakeFetch(() => {
      throw new Error('must not be called');
    });
    const { client } = makeAdapter(fetch);
    await expectManagementError(
      client.create({ kind: 'database', projectId: 'p1', branchId: 'b1', name: 'analytics' }),
      'CONFIGURATION',
    );
    expect(calls).toHaveLength(0);
  });

  it('creates branch-scoped by name and wait() finishes on the DATABASE endpoint (poll scope)', async () => {
    const { fetch, calls } = fakeFetch((req) => {
      const path = req.path;
      if (req.method === 'POST' && path === '/projects/p1/branches/b1/databases') {
        return { status: 201, body: createDatabaseResponse };
      }
      if (req.method === 'GET' && path === '/projects/p1/operations/op-db-config') {
        return {
          body: {
            operation: { ...createDatabaseResponse.operations[0], status: 'finished' },
          },
        };
      }
      if (req.method === 'GET' && path === '/projects/p1/branches/b1/databases/analytics') {
        return { body: { database: databaseFixture } };
      }
      throw new Error(`unexpected ${req.method} ${path}`);
    });
    const { client } = makeAdapter(fetch);
    const created = await client.create({
      kind: 'database',
      projectId: 'p1',
      branchId: 'b1',
      name: 'analytics',
      owner: 'app_owner',
    });

    // Request body matches the official schema exactly
    expect(calls[0]!.url.href).toBe(`${BASE}/projects/p1/branches/b1/databases`);
    expect(calls[0]!.body).toEqual({ database: { name: 'analytics', owner_name: 'app_owner' } });

    // Resource scope round-trips (required for wait/get/update/delete)
    expect(created.resource).toMatchObject({
      kind: 'database',
      id: 'analytics', // Neon addresses databases by NAME
      name: 'analytics',
      projectId: 'p1',
      branchId: 'b1',
      status: 'unknown', // the database object has no status; the operation carries progress
    });
    expect(created.operation?.ref).toEqual({
      kind: 'database',
      id: 'analytics',
      projectId: 'p1',
      branchId: 'b1',
    });
    expect(created.operation?.status).toBe('running');

    // wait(): operation poll then the final resource GET — on the database, not the branch.
    // The operation payload only carries branch_id; if the adapter re-routed to the branch ref
    // this would silently fetch the branch instead of the created database.
    const resource = await client.wait(created, { pollIntervalMs: 0 });
    expect(resource.id).toBe('analytics');
    expect(resource.kind).toBe('database');
    const afterCreate = calls.slice(1);
    expect(afterCreate[0]!.method).toBe('GET');
    expect(afterCreate[0]!.path).toBe('/projects/p1/operations/op-db-config');
    expect(afterCreate[1]!.path).toBe('/projects/p1/branches/b1/databases/analytics');
    expect(afterCreate.some((c) => c.path === '/projects/p1/branches/b1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Lists (per-resource pagination honesty)
// ---------------------------------------------------------------------------

describe('list', () => {
  it('paginates projects with cursor/limit and returns the provider cursor verbatim', async () => {
    const { fetch, calls } = fakeFetch((req) => {
      if (req.method === 'GET' && req.path === '/projects') {
        const cursor = req.url.searchParams.get('cursor');
        if (cursor === null) {
          return {
            body: {
              projects: [projectFixture, { ...projectFixture, id: 'p2' }],
              pagination: { cursor: 'p2' },
            },
          };
        }
        return { body: { projects: [], pagination: { cursor: 'p3' } } };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const { client } = makeAdapter(fetch);
    const page1 = await client.list('project', { limit: 2 });
    expect(calls[0]!.url.searchParams.get('limit')).toBe('2');
    expect(page1.resources).toHaveLength(2);
    expect(page1.resources[0]).toMatchObject({ kind: 'project', id: 'p1', region: 'aws-us-east-1' });
    expect(page1.cursor).toBe('p2');

    const page2 = await client.list('project', { cursor: page1.cursor! });
    expect(calls[1]!.url.searchParams.get('cursor')).toBe('p2');
    expect(page2.resources).toHaveLength(0);
    expect(page2.cursor).toBe('p3');
  });

  it('paginates branches with a typed projectId scope and pagination.next cursor', async () => {
    const { fetch, calls } = fakeFetch((req) => {
      if (req.method === 'GET' && req.path === '/projects/p1/branches') {
        return {
          body: {
            branches: [branchFixture],
            pagination: { next: 'b1', sort_by: 'updated_at', sort_order: 'desc' },
          },
        };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const { client } = makeAdapter(fetch);
    const page = await client.list('branch', {
      projectId: 'p1',
      cursor: 'b0',
      limit: 10,
    });
    expect(calls[0]!.path).toBe('/projects/p1/branches');
    expect(calls[0]!.url.searchParams.get('cursor')).toBe('b0');
    expect(calls[0]!.url.searchParams.get('limit')).toBe('10');
    expect(page.cursor).toBe('b1'); // pagination.next, passed back verbatim
    expect(page.resources[0]).toMatchObject({
      kind: 'branch',
      id: 'b1',
      projectId: 'p1',
      status: 'active', // current_state 'ready'
      providerStatus: 'ready',
    });
  });

  it('refuses branch listing without a projectId scope before dispatch (A3 scope rules)', async () => {
    const { fetch, calls } = fakeFetch(() => {
      throw new Error('must not be called');
    });
    const { client } = makeAdapter(fetch);
    await expectManagementError(client.list('branch', {}), 'CONFIGURATION');
    expect(calls).toHaveLength(0);
  });

  it('refuses cursor/limit on the database list (Neon does not paginate it) and requires full scope', async () => {
    const { fetch, calls } = fakeFetch((req) => {
      if (req.method === 'GET' && req.path === '/projects/p1/branches/b1/databases') {
        return { body: { databases: [databaseFixture] } };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const { client } = makeAdapter(fetch);

    // Per-resource pagination refusal BEFORE dispatch — never silently ignored
    await expectManagementError(
      client.list('database', { projectId: 'p1', branchId: 'b1', cursor: 'x' }),
      'CAPABILITY',
    );
    await expectManagementError(
      client.list('database', { projectId: 'p1', branchId: 'b1', limit: 5 }),
      'CAPABILITY',
    );
    expect(calls).toHaveLength(0);

    // Missing scope is a CONFIGURATION error, not a request
    await expectManagementError(
      client.list('database', { projectId: 'p1' }),
      'CONFIGURATION',
    );
    expect(calls).toHaveLength(0);

    const page = await client.list('database', {
      projectId: 'p1',
      branchId: 'b1',
    });
    expect(calls[0]!.path).toBe('/projects/p1/branches/b1/databases');
    expect(calls[0]!.url.searchParams.get('cursor')).toBeNull();
    expect(page.kind).toBe('database');
    expect(page.resources[0]).toMatchObject({
      kind: 'database',
      id: 'analytics',
      projectId: 'p1',
      branchId: 'b1',
      status: 'unknown',
    });
    expect(page.cursor).toBeNull(); // truthful: this endpoint returns everything
  });
});

// ---------------------------------------------------------------------------
// Get
// ---------------------------------------------------------------------------

describe('get', () => {
  it('fetches each kind at its official path and maps provider status truthfully', async () => {
    const { fetch, calls } = fakeFetch((req) => {
      const path = req.path;
      if (req.method === 'GET' && path === '/projects/p1') return { body: { project: projectFixture } };
      if (req.method === 'GET' && path === '/projects/p1/branches/b1') return { body: { branch: branchFixture } };
      if (req.method === 'GET' && path === '/projects/p1/branches/b1/databases/analytics') {
        return { body: { database: databaseFixture } };
      }
      throw new Error(`unexpected ${req.method} ${path}`);
    });
    const { client } = makeAdapter(fetch);

    const project = await client.get({ kind: 'project', id: 'p1' });
    expect(project).toMatchObject({ kind: 'project', id: 'p1', status: 'unknown' });

    const branch = await client.get({ kind: 'branch', id: 'b1', projectId: 'p1' });
    expect(branch).toMatchObject({ kind: 'branch', id: 'b1', status: 'active', providerStatus: 'ready' });

    const database = await client.get({
      kind: 'database',
      id: 'analytics',
      projectId: 'p1',
      branchId: 'b1',
    });
    expect(database).toMatchObject({ kind: 'database', id: 'analytics', branchId: 'b1' });

    expect(calls.map((c) => c.path)).toEqual([
      '/projects/p1',
      '/projects/p1/branches/b1',
      '/projects/p1/branches/b1/databases/analytics',
    ]);
  });

  it('URL-encodes path segments (database names are caller-controlled)', async () => {
    const { fetch, calls } = fakeFetch((req) => {
      if (req.method === 'GET' && req.path === '/projects/p1/branches/b1/databases/my%20db%2Fx') {
        return { body: { database: { ...databaseFixture, name: 'my db/x' } } };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const { client } = makeAdapter(fetch);
    const resource = await client.get({
      kind: 'database',
      id: 'my db/x',
      projectId: 'p1',
      branchId: 'b1',
    });
    expect(resource.id).toBe('my db/x');
  });

  it('maps a 404 to NOT_FOUND with resource context (through the client)', async () => {
    const { fetch } = fakeFetch((req) => {
      if (req.method === 'GET' && req.path === '/projects/p1') {
        return { status: 404, body: { message: 'Project not found' } };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const { client } = makeAdapter(fetch);
    const err = await client.get({ kind: 'project', id: 'p1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManagementError);
    expect((err as ManagementError).code).toBe('NOT_FOUND');
    expect((err as ManagementError).status).toBe(404);
    expect((err as ManagementError).resourceKind).toBe('project');
    expect((err as ManagementError).resourceId).toBe('p1');
  });
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

describe('update', () => {
  it('PATCHes the project name and refuses owner/empty patches', async () => {
    const { fetch, calls } = fakeFetch((req) => {
      if (req.method === 'PATCH' && req.path === '/projects/p1') {
        return { body: { project: { ...projectFixture, name: 'renamed' }, operations: [] } };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const { client } = makeAdapter(fetch);
    const result = await client.update({ kind: 'project', id: 'p1', patch: { name: 'renamed' } });
    expect(calls[0]!.body).toEqual({ project: { name: 'renamed' } });
    expect(result.resource?.name).toBe('renamed');
    expect(result.operation).toBeNull(); // empty operations array in the response

    await expectManagementError(
      client.update({ kind: 'project', id: 'p1', patch: { owner: 'x' } }),
      'CONFIGURATION',
    );
    await expectManagementError(
      client.update({ kind: 'project', id: 'p1', patch: {} }),
      'CONFIGURATION',
    );
    expect(calls).toHaveLength(1);
  });

  it('PATCHes the branch name and surfaces the returned operation', async () => {
    const { fetch, calls } = fakeFetch((req) => {
      if (req.method === 'PATCH' && req.path === '/projects/p1/branches/b1') {
        return {
          body: {
            branch: branchFixture,
            operations: [
              {
                id: 'op-branch-config',
                project_id: 'p1',
                branch_id: 'b1',
                action: 'apply_config',
                status: 'running',
                failures_count: 0,
                created_at: NOW,
                updated_at: NOW,
              },
            ],
          },
        };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const { client } = makeAdapter(fetch);
    const result = await client.update({ kind: 'branch', id: 'b1', projectId: 'p1', patch: { name: 'renamed-branch' } });
    expect(calls[0]!.body).toEqual({ branch: { name: 'renamed-branch' } });
    expect(result.operation?.id).toBe('op-branch-config');
    expect(result.operation?.ref).toEqual({ kind: 'branch', id: 'b1', projectId: 'p1' });

    await expectManagementError(
      client.update({ kind: 'branch', id: 'b1', projectId: 'p1', patch: { owner: 'x' } }),
      'CONFIGURATION',
    );
  });

  it('PATCHes database name/owner and re-points identity to the NEW name', async () => {
    const { fetch, calls } = fakeFetch((req) => {
      if (
        req.method === 'PATCH' &&
        req.path === '/projects/p1/branches/b1/databases/analytics'
      ) {
        return {
          body: {
            database: { ...databaseFixture, name: 'analytics2' },
            operations: [
              {
                id: 'op-db-rename',
                project_id: 'p1',
                branch_id: 'b1',
                action: 'apply_config',
                status: 'finished',
                failures_count: 0,
                created_at: NOW,
                updated_at: NOW,
              },
            ],
          },
        };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const { client } = makeAdapter(fetch);
    const result = await client.update({
      kind: 'database',
      id: 'analytics',
      projectId: 'p1',
      branchId: 'b1',
      patch: { name: 'analytics2', owner: 'other_role' },
    });
    expect(calls[0]!.path).toBe('/projects/p1/branches/b1/databases/analytics');
    expect(calls[0]!.body).toEqual({ database: { name: 'analytics2', owner_name: 'other_role' } });
    expect(result.resource?.id).toBe('analytics2');
    expect(result.operation?.ref).toEqual({
      kind: 'database',
      id: 'analytics2',
      projectId: 'p1',
      branchId: 'b1',
    });

    await expectManagementError(
      client.update({ kind: 'database', id: 'analytics', projectId: 'p1', branchId: 'b1', patch: {} }),
      'CONFIGURATION',
    );
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe('delete', () => {
  it('deletes a project synchronously (no operations) and reports the truth', async () => {
    const { fetch, calls } = fakeFetch((req) => {
      if (req.method === 'DELETE' && req.path === '/projects/p1') {
        return { body: { project: projectFixture } };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const { client } = makeAdapter(fetch);
    const result = await client.delete({ kind: 'project', id: 'p1' });
    expect(calls[0]!.method).toBe('DELETE');
    expect(result.operation).toBeNull();
    expect(result.indeterminate).toBe(false);
  });

  it('deletes a branch and returns the operation for wait()-ing the async teardown', async () => {
    const { fetch } = fakeFetch((req) => {
      if (req.method === 'DELETE' && req.path === '/projects/p1/branches/b1') {
        return {
          body: {
            branch: branchFixture,
            operations: [
              {
                id: 'op-suspend',
                project_id: 'p1',
                branch_id: 'b1',
                action: 'suspend_compute',
                status: 'scheduling',
                failures_count: 0,
                created_at: NOW,
                updated_at: NOW,
              },
              {
                id: 'op-delete-timeline',
                project_id: 'p1',
                branch_id: 'b1',
                action: 'delete_timeline',
                status: 'running',
                failures_count: 0,
                created_at: NOW,
                updated_at: NOW,
              },
            ],
          },
        };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const { client } = makeAdapter(fetch);
    const result = await client.delete({ kind: 'branch', id: 'b1', projectId: 'p1' });
    expect(result.operation?.id).toBe('op-suspend'); // first in-flight operation
    expect(result.operation?.action).toBe('other'); // suspend_compute: tracked, no create/delete prefix
    expect(result.operation?.providerStatus).toBe('scheduling');
    expect(result.operation?.ref).toEqual({ kind: 'branch', id: 'b1', projectId: 'p1' });
    expect(result.indeterminate).toBe(false);
  });

  it('deletes a database by name with the branch scope in the path', async () => {
    const { fetch, calls } = fakeFetch((req) => {
      if (req.method === 'DELETE' && req.path === '/projects/p1/branches/b1/databases/analytics') {
        return {
          body: {
            database: databaseFixture,
            operations: [
              {
                id: 'op-db-delete',
                project_id: 'p1',
                branch_id: 'b1',
                action: 'apply_config',
                status: 'running',
                failures_count: 0,
                created_at: NOW,
                updated_at: NOW,
              },
            ],
          },
        };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const { client } = makeAdapter(fetch);
    const result = await client.delete({
      kind: 'database',
      id: 'analytics',
      projectId: 'p1',
      branchId: 'b1',
    });
    expect(result.operation?.id).toBe('op-db-delete');
    expect(result.operation?.ref).toEqual({
      kind: 'database',
      id: 'analytics',
      projectId: 'p1',
      branchId: 'b1',
    });
  });
});

// ---------------------------------------------------------------------------
// getOperation: statuses, aggregation of multiple operations, and wait semantics
// ---------------------------------------------------------------------------

describe('getOperation and multi-operation wait()', () => {
  it('maps official operation statuses truthfully', async () => {
    const { fetch } = fakeFetch((req) => {
      if (req.method === 'GET' && req.path === '/projects/p1/operations/op1') {
        return {
          body: {
            operation: {
              id: 'op1',
              project_id: 'p1',
              branch_id: 'b1',
              action: 'create_branch',
              status: 'finished',
              failures_count: 0,
              created_at: NOW,
              updated_at: '2026-10-06T00:01:00Z',
              total_duration_ms: 5,
            },
          },
        };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const { adapter } = makeAdapter(fetch);
    const op = await adapter.getOperation!({
      id: 'op1',
      providerId: 'neon',
      action: 'other',
      ref: { kind: 'project', id: 'p1' },
      status: 'running',
      providerStatus: 'running',
      createdAt: NOW,
      finishedAt: null,
      error: null,
      raw: {},
    });
    expect(op.status).toBe('completed');
    expect(op.providerStatus).toBe('finished');
    expect(op.finishedAt).toBe('2026-10-06T00:01:00Z');
    expect(op.action).toBe('create');
    expect(op.ref).toEqual({ kind: 'project', id: 'p1' });
  });

  it('requires a project scope to poll (CONFIGURATION before any request)', async () => {
    const { fetch, calls } = fakeFetch(() => {
      throw new Error('must not be called');
    });
    const { adapter } = makeAdapter(fetch);
    await expectManagementError(
      adapter.getOperation!({
        id: 'op1',
        providerId: 'neon',
        action: 'other',
        ref: null,
        status: 'running',
        providerStatus: null,
        createdAt: null,
        finishedAt: null,
        error: null,
        raw: {},
      }),
      'CONFIGURATION',
    );
    expect(calls).toHaveLength(0);
  });

  it('does NOT resolve wait() while any sibling operation is still running (multi-op truth)', async () => {
    let poll = 0;
    const onStatusUpdates: ManagementOperation[] = [];
    const { fetch, calls } = fakeFetch((req) => {
      const path = req.path;
      if (req.method === 'POST' && path === '/projects') return { status: 201, body: createProjectResponse };
      if (req.method === 'GET' && path === '/projects/p1/operations/op-create-timeline') {
        poll += 1;
        return { body: { operation: { ...opCreateTimeline, status: 'finished' } } };
      }
      if (req.method === 'GET' && path === '/projects/p1/operations/op-start-compute') {
        // Poll 1: the sibling compute start is still in flight even though the tracked
        // operation already finished. Poll 2: everything is terminal.
        return {
          body: { operation: { ...opStartCompute, status: poll === 1 ? 'running' : 'finished' } },
        };
      }
      if (req.method === 'GET' && path === '/projects/p1') return { body: { project: projectFixture } };
      throw new Error(`unexpected ${req.method} ${path}`);
    });
    const { client } = makeAdapter(fetch);
    const created = await client.create({ kind: 'project', name: 'app' });
    const resource = await client.wait(created, {
      pollIntervalMs: 0,
      onStatus: (update) => {
        if ('action' in update) onStatusUpdates.push(update);
      },
    });

    expect(poll).toBe(2); // two operation polls before the final get
    expect(onStatusUpdates[0]?.status).toBe('running'); // aggregate: sibling still in flight
    expect(onStatusUpdates[0]?.raw['operations']).toHaveLength(2); // both operations visible
    expect(onStatusUpdates[1]?.status).toBe('completed');
    expect(resource).toMatchObject({ kind: 'project', id: 'p1', status: 'unknown' });
    expect(calls.at(-1)!.path).toBe('/projects/p1');
  });

  it('fails wait() as soon as ANY sibling operation fails, with the provider error', async () => {
    const { fetch, calls } = fakeFetch((req) => {
      const path = req.path;
      if (req.method === 'POST' && path === '/projects') return { status: 201, body: createProjectResponse };
      if (req.method === 'GET' && path === '/projects/p1/operations/op-create-timeline') {
        return { body: { operation: { ...opCreateTimeline, status: 'finished' } } };
      }
      if (req.method === 'GET' && path === '/projects/p1/operations/op-start-compute') {
        return {
          body: {
            operation: {
              ...opStartCompute,
              status: 'failed',
              error: 'compute failed to start',
            },
          },
        };
      }
      throw new Error(`unexpected ${req.method} ${path}`);
    });
    const { client } = makeAdapter(fetch);
    const created = await client.create({ kind: 'project', name: 'app' });
    const err = await client
      .wait(created, { pollIntervalMs: 0 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManagementError);
    expect((err as ManagementError).code).toBe('PROVIDER');
    expect((err as ManagementError).providerStatus).toBe('failed');
    expect((err as ManagementError).message).toContain('compute failed to start');
    // Both operations were polled before the failure was aggregated
    const polled = calls.filter((c) => c.path.startsWith('/projects/p1/operations/'));
    expect(polled).toHaveLength(2);
  });

  it('honors a rate-limited poll by retrying after the provider hint (reads only)', async () => {
    let operationCalls = 0;
    const { fetch } = fakeFetch((req) => {
      const path = req.path;
      if (req.method === 'POST' && path === '/projects') return { status: 201, body: createProjectResponse };
      if (req.method === 'GET' && path === '/projects/p1/operations/op-create-timeline') {
        operationCalls += 1;
        if (operationCalls === 1) {
          return { status: 429, body: { message: 'rate limited' }, headers: { 'retry-after': '0' } };
        }
        return { body: { operation: { ...opCreateTimeline, status: 'finished' } } };
      }
      if (req.method === 'GET' && path === '/projects/p1/operations/op-start-compute') {
        return { body: { operation: { ...opStartCompute, status: 'finished' } } };
      }
      if (req.method === 'GET' && path === '/projects/p1') return { body: { project: projectFixture } };
      throw new Error(`unexpected ${req.method} ${path}`);
    });
    const { client } = makeAdapter(fetch);
    const created = await client.create({ kind: 'project', name: 'app' });
    const resource = await client.wait(created, { pollIntervalMs: 0 });
    expect(operationCalls).toBe(2);
    expect(resource.id).toBe('p1');
  });

  it('refuses wait() on a bare project ref up front: Neon projects have no status field (A3 statusPolling)', async () => {
    const { fetch, calls } = fakeFetch(() => {
      throw new Error('must not be called');
    });
    const { client } = makeAdapter(fetch);
    const err = await client
      .wait({ kind: 'project', id: 'p1' }, { pollIntervalMs: 0, timeoutMs: 50 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManagementError);
    expect((err as ManagementError).code).toBe('CAPABILITY');
    expect((err as ManagementError).message).toMatch(/no pollable status/);
    expect(calls).toHaveLength(0); // refused before any request, never hangs to the timeout
    // Documented limitation: pass the write result (operation-based) instead of a bare ref.
  });

  it('refuses wait() on a bare database ref for the same reason (no status field)', async () => {
    const { fetch, calls } = fakeFetch(() => {
      throw new Error('must not be called');
    });
    const { client } = makeAdapter(fetch);
    const err = await client
      .wait({ kind: 'database', id: 'analytics', projectId: 'p1', branchId: 'b1' })
      .catch((e: unknown) => e);
    expect((err as ManagementError).code).toBe('CAPABILITY');
    expect(calls).toHaveLength(0);
  });

  it('still polls a bare branch ref: branches expose a real status field', async () => {
    const { fetch, calls } = fakeFetch((req) => {
      if (req.method === 'GET' && req.path === '/projects/p1/branches/b1') {
        return { body: { branch: { ...branchFixture, current_state: 'ready' } } };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const { client } = makeAdapter(fetch);
    const resource = await client.wait({ kind: 'branch', id: 'b1', projectId: 'p1' });
    expect(resource.status).toBe('active');
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Error mapping, redaction, and indeterminate writes
// ---------------------------------------------------------------------------

describe('error mapping and redaction', () => {
  it('maps 401 to AUTH and never leaks the API key', async () => {
    const { fetch } = fakeFetch((req) => {
      if (req.method === 'POST' && req.path === '/projects') {
        return { status: 401, body: { message: 'Invalid API key' } };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const { client } = makeAdapter(fetch);
    const err = await client.create({ kind: 'project', name: 'app' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManagementError);
    expect((err as ManagementError).code).toBe('AUTH');
    expect((err as ManagementError).status).toBe(401);
    expect((err as ManagementError).retryable).toBe(false);
    expect((err as ManagementError).message).not.toContain(API_KEY);
  });

  it('maps 429 to RATE_LIMIT with retryAfterMs from Retry-After', async () => {
    const { fetch } = fakeFetch((req) => {
      if (req.method === 'GET' && req.path === '/projects') {
        return { status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '7' } };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const { client } = makeAdapter(fetch);
    const err = await client.list('project', {}).catch((e: unknown) => e);
    expect((err as ManagementError).code).toBe('RATE_LIMIT');
    expect((err as ManagementError).retryable).toBe(true);
    expect((err as ManagementError).retryAfterMs).toBe(7000);
  });

  it('maps 423 to retryable CONFLICT and plain 409 to non-retryable CONFLICT', async () => {
    const make = (status: number) => {
      const { fetch } = fakeFetch((req) => {
        if (req.method === 'POST' && req.path === '/projects') {
          return { status, body: { message: 'conflict' } };
        }
        throw new Error(`unexpected ${req.method} ${req.path}`);
      });
      return makeAdapter(fetch).client;
    };
    const locked = await make(423).create({ kind: 'project', name: 'app' }).catch((e: unknown) => e);
    expect((locked as ManagementError).code).toBe('CONFLICT');
    expect((locked as ManagementError).retryable).toBe(true);
    const conflict = await make(409).create({ kind: 'project', name: 'app' }).catch((e: unknown) => e);
    expect((conflict as ManagementError).code).toBe('CONFLICT');
    expect((conflict as ManagementError).retryable).toBe(false);
  });

  it('maps 400 to VALIDATION with the provider message', async () => {
    const { fetch } = fakeFetch((req) => {
      if (req.method === 'POST' && req.path === '/projects') {
        return { status: 400, body: { message: 'region_id is not supported' } };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const { client } = makeAdapter(fetch);
    const err = await client.create({ kind: 'project', name: 'app' }).catch((e: unknown) => e);
    expect((err as ManagementError).code).toBe('VALIDATION');
    expect((err as ManagementError).message).toContain('region_id is not supported');
  });

  it('marks a 5xx mutation as PROVIDER + indeterminate; a 5xx read is not indeterminate', async () => {
    const post = fakeFetch((req) => {
      if (req.method === 'POST' && req.path === '/projects') return { status: 502, body: {} };
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const postErr = await makeAdapter(post.fetch)
      .client.create({ kind: 'project', name: 'app' })
      .catch((e: unknown) => e);
    expect((postErr as ManagementError).code).toBe('PROVIDER');
    expect((postErr as ManagementError).indeterminate).toBe(true);

    const get = fakeFetch((req) => {
      if (req.method === 'GET' && req.path === '/projects/p1') return { status: 500, body: {} };
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const getErr = await makeAdapter(get.fetch)
      .client.get({ kind: 'project', id: 'p1' })
      .catch((e: unknown) => e);
    expect((getErr as ManagementError).code).toBe('PROVIDER');
    expect((getErr as ManagementError).indeterminate).toBe(false);
  });

  it('marks a network failure during a mutation as CONNECTION + indeterminate', async () => {
    const fetch: FetchLike = async () => {
      throw new Error("ECONNRESET");
    };
    const { client } = makeAdapter(fetch);
    const err = await client.create({ kind: 'project', name: 'app' }).catch((e: unknown) => e);
    expect((err as ManagementError).code).toBe('CONNECTION');
    expect((err as ManagementError).indeterminate).toBe(true);
  });

  it('marks a timed-out mutation as TIMEOUT + indeterminate', async () => {
    const fetch: FetchLike = (_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const abortError = new Error('The operation was aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        });
      });
    };
    const { client } = makeAdapter(fetch, { timeoutMs: 20 });
    const err = await client.create({ kind: 'project', name: 'app' }).catch((e: unknown) => e);
    expect((err as ManagementError).code).toBe('TIMEOUT');
    expect((err as ManagementError).indeterminate).toBe(true);
  });

  it('maps a caller abort during a mutation to ABORTED', async () => {
    const fetch: FetchLike = (_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const abortError = new Error('The operation was aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        });
      });
    };
    const { client } = makeAdapter(fetch);
    const controller = new AbortController();
    const pending = client.create({ kind: 'project', name: 'app' }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    const err = await pending.catch((e: unknown) => e);
    expect((err as ManagementError).code).toBe('ABORTED');
  });
});

// ---------------------------------------------------------------------------
// raw.connectionUri: official endpoint, redacted by default, secret opt-in
// ---------------------------------------------------------------------------

describe('raw.connectionUri', () => {
  const uriResponse = { uri: SECRET_URI };

  function connectionUriFetch(receivedQuery: { params: URLSearchParams | null }) {
    return fakeFetch((req) => {
      if (req.method === 'GET' && req.path === '/projects/p1/connection_uri') {
        receivedQuery.params = req.url.searchParams;
        return { body: uriResponse };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
  }

  it('queries the official endpoint and REDACTS the password by default', async () => {
    const received: { params: URLSearchParams | null } = { params: null };
    const { fetch, calls } = connectionUriFetch(received);
    const { adapter } = makeAdapter(fetch);
    const uri = await adapter.raw.connectionUri({
      projectId: 'p1',
      branchId: 'b1',
      databaseName: 'neondb',
      roleName: 'app_owner',
      pooled: true,
    });
    expect(received.params!.get('branch_id')).toBe('b1');
    expect(received.params!.get('database_name')).toBe('neondb');
    expect(received.params!.get('role_name')).toBe('app_owner');
    expect(received.params!.get('pooled')).toBe('true');
    expect(uri).toBe('postgresql://app_owner:[redacted]@ep-cool-123.aws.neon.tech/neondb?sslmode=require');
    expect(uri).not.toContain(SECRET_PW);
    expect(calls).toHaveLength(1);
  });

  it('omits optional params and reveals the real URI only on explicit opt-in', async () => {
    const received: { params: URLSearchParams | null } = { params: null };
    const { fetch } = connectionUriFetch(received);
    const { adapter } = makeAdapter(fetch);
    const redacted = await adapter.raw.connectionUri({
      projectId: 'p1',
      databaseName: 'neondb',
      roleName: 'app_owner',
    });
    expect(received.params!.get('branch_id')).toBeNull();
    expect(received.params!.get('pooled')).toBeNull();
    expect(redacted).toContain('[redacted]');

    const revealed = await adapter.raw.connectionUri({
      projectId: 'p1',
      databaseName: 'neondb',
      roleName: 'app_owner',
      reveal: true,
    });
    expect(revealed).toBe(SECRET_URI);
  });

  it('validates required inputs before dispatch', async () => {
    const { fetch, calls } = fakeFetch(() => {
      throw new Error('must not be called');
    });
    const { adapter } = makeAdapter(fetch);
    await expectManagementError(
      adapter.raw.connectionUri({ projectId: 'p1', roleName: 'app_owner' } as never),
      'CONFIGURATION',
    );
    await expectManagementError(
      adapter.raw.connectionUri({ projectId: 'p1', databaseName: 'neondb' } as never),
      'CONFIGURATION',
    );
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Open-kind refusals (A2): the adapter refuses kinds it does not manage
// ---------------------------------------------------------------------------

describe('custom kinds are refused before dispatch', () => {
  it('create/list/get refuse provider-defined kinds on direct adapter use', async () => {
    const { fetch, calls } = fakeFetch(() => {
      throw new Error('must not be called');
    });
    const { adapter, client } = makeAdapter(fetch);
    const custom = { kind: 'convex_deployment', name: 'x' } as never;
    await expectManagementError(adapter.create(custom), 'CAPABILITY');
    await expectManagementError(client.list('convex_deployment' as never, {}), 'CAPABILITY');
    await expectManagementError(
      client.get({ kind: 'convex_deployment', id: 'x' } as never),
      'CAPABILITY',
    );
    expect(calls).toHaveLength(0);
  });
});

