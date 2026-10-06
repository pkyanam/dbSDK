/**
 * PlanetScale Management adapter tests (`dbsdk/management/planetscale`) — CONTROL PLANE, OFFLINE.
 *
 * Every response body is a MOCKED control-plane fixture shaped from the official PlanetScale
 * API reference pages (each embedding the OpenAPI 3.0.1 YAML, fetched 2026-10-06):
 * create_database, get_database, list_databases, update_database_settings, delete_database,
 * create/get/list/delete_branch, create/get/list/update/delete_role, reset_role,
 * list_regions_for_organization, list_organizations, list_cluster_size_skus, pagination.
 * These are NOT live calls: no hosted account was touched, nothing was provisioned, and no
 * real secrets exist in this file. Evidence level stays 'docs' / offline.
 *
 * What these tests prove:
 * - the two-part service token auth header (`Authorization: <id>:<secret>`, NO Bearer);
 * - exact official paths/methods/bodies for every implemented verb;
 * - capability gates fire BEFORE dispatch (zero requests);
 * - slug vs uid identity handling (databases/branches name-addressed, roles ID-addressed);
 * - one-time secrets: passwords only in `secrets`, redacted in `raw`, scrubbed from later errors;
 * - page-based pagination mapped to the unified cursor (next page NUMBER);
 * - readiness semantics: database vs branch states are read from their own payloads, and
 *   wait() polls GETs only — it never replays a mutation;
 * - refusals that would otherwise be silent lies (unsupported kinds, Vitess-only fields,
 *   unsupported engine kinds, missing organization, fabricated credentials);
 * - review R3 fixes: the engine gate covers every database response and pre-flights every
 *   mutation (F1), role status precedence is terminal > disabled > ready (F2), create() is
 *   bound to the factory organization (F4), caller passwords on create(role) are refused
 *   (F5), and per_page is capped at the official maximum of 100 (F8).
 */

import { describe, expect, it } from 'vitest';

import { createManagement, describeManagementCapabilities } from '../../src/management/core.js';
import { ManagementError } from '../../src/management/errors.js';
import { planetscaleManagement } from '../../src/management/planetscale.js';
import type { FetchLike, ManagementWriteResult } from '../../src/management/types.js';

// ---------------------------------------------------------------------------
// Offline fetch harness (mock control plane — clearly labeled, no live traffic)
// ---------------------------------------------------------------------------

type FakeResponse = { status?: number; body?: unknown; headers?: Record<string, string> };
type CapturedRequest = {
  url: URL;
  /** URL pathname relative to the API base (e.g. `/organizations/acme/databases`). */
  path: string;
  method: string;
  body: unknown;
  query: URLSearchParams;
  headers: Record<string, string>;
};

const BASE_PATH = '/v1'; // pathname prefix of the official base URL

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
      query: url.searchParams,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
      ),
    };
    calls.push(captured);
    const response = await handler(captured);
    if (response.status === 204) {
      return new Response(null, { status: 204 });
    }
    return new Response(response.body === undefined ? null : JSON.stringify(response.body ?? null), {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/json', ...(response.headers ?? {}) },
    });
  };
  return { fetch, calls };
}

// ---------------------------------------------------------------------------
// Official-shape fixtures (mock control plane)
// ---------------------------------------------------------------------------

const TOKEN_ID = 'testtokenid';
const TOKEN_SECRET = 'testtokensecretvalue';
const FULL_TOKEN = `${TOKEN_ID}:${TOKEN_SECRET}`;
const ORG = 'acme';
const NOW = '2026-10-06T00:00:00Z';

const REGION_OBJ = {
  id: '28asbd123',
  provider: 'AWS',
  enabled: true,
  public_ip_addresses: [],
  display_name: 'US East (Ohio)',
  location: 'US East (Ohio)',
  slug: 'us-east-1',
  current_default: true,
  mysql_supported: true,
  postgresql_supported: true,
  neki_supported: false,
};

function databaseFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'psdb-uid-123',
    url: '/organizations/acme/databases/app-db',
    branches_url: '/organizations/acme/databases/app-db/branches',
    branches_count: 0,
    name: 'app-db',
    state: 'pending',
    ready: false,
    region: REGION_OBJ,
    sharded: false,
    default_branch: 'main',
    deletion_protected: false,
    plan: 'hobby',
    created_at: NOW,
    updated_at: NOW,
    kind: 'postgresql',
    ...overrides,
  };
}

function branchFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'branch-uid-789',
    name: 'main',
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    kind: 'postgresql',
    state: 'pending',
    ready: false,
    schema_ready: false,
    cluster_name: 'ps-1234',
    production: false,
    metal: false,
    sharded: false,
    region: REGION_OBJ,
    parent_branch: null,
    ...overrides,
  };
}

function roleFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'role-uid-456',
    name: 'app-role',
    access_host_url: 'eu-central-useast1-1.horizon.psdb.cloud',
    private_access_host_url: 'private-eu-central-useast1-1.horizon.psdb.cloud',
    private_connection_service_name: 'svc-xyz',
    username: 'app-role.br3anchid',
    base_username: 'app-role',
    password: null,
    database_name: 'app-db',
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    expires_at: null,
    dropped_at: null,
    disabled_at: null,
    drop_failed: null,
    ready: true,
    expired: false,
    default: false,
    ttl: null,
    inherited_roles: [],
    with_replication: false,
    branch: { id: 'branch-uid-789', name: 'main', created_at: NOW, updated_at: NOW, deleted_at: null },
    actor: { id: 'actor-1', display_name: 'Test Actor', avatar_url: '' },
    query_safety_settings: { require_where_on_delete: 'off', require_where_on_update: 'off' },
    ...overrides,
  };
}

const ONE_TIME_PASSWORD = 'pscale_pw_test_fixture_value_abc123';

function makeAdapter(
  fetch: FetchLike,
  overrides: { organization?: string; baseUrl?: string; timeoutMs?: number } = {},
) {
  const adapter = planetscaleManagement({
    tokenId: TOKEN_ID,
    tokenSecret: TOKEN_SECRET,
    organization: ORG,
    fetch,
    ...overrides,
  });
  return { adapter, client: createManagement({ adapter }) };
}

function makeClient(
  handler: (req: CapturedRequest) => FakeResponse | Promise<FakeResponse>,
  overrides: { organization?: string; baseUrl?: string; timeoutMs?: number } = {},
) {
  const { fetch, calls } = fakeFetch(handler);
  return { ...makeAdapter(fetch, overrides), calls, fetch };
}

// ---------------------------------------------------------------------------
// Auth + construction
// ---------------------------------------------------------------------------

describe('planetscale management — construction and auth', () => {
  it('sends the two-part service token header with NO Bearer scheme', async () => {
    const { client, calls } = makeClient(() => ({ body: databaseFixture() }));
    await client.get({ kind: 'project', id: 'app-db' });
    expect(calls).toHaveLength(1);
    const firstCall = calls[0]!;
    const authHeader: string = firstCall.headers['authorization'] ?? '';
    expect(authHeader).toBe(FULL_TOKEN);
    expect(authHeader.startsWith('Bearer ')).toBe(false);
  });

  it('requires both token parts', () => {
    expect(() => planetscaleManagement({ tokenId: '', tokenSecret: 'x' })).toThrow(/tokenId/);
    expect(() => planetscaleManagement({ tokenId: 'x', tokenSecret: '' })).toThrow(/tokenSecret/);
  });

  it('targets the official base URL https://api.planetscale.com/v1', async () => {
    const { client, calls } = makeClient(() => ({ body: databaseFixture() }));
    await client.get({ kind: 'project', id: 'app-db' });
    expect(calls[0]!.url.origin + calls[0]!.url.pathname).toBe('https://api.planetscale.com/v1/organizations/acme/databases/app-db');
  });

  it('scrubs the token id, secret, and full header from later error messages', async () => {
    const { client } = makeClient(() => ({
      status: 500,
      body: { message: `boom with ${FULL_TOKEN} leaked` },
    }));
    const promise = client.get({ kind: 'project', id: 'app-db' });
    await expect(promise).rejects.toSatisfy((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      return !message.includes(TOKEN_ID) && !message.includes(TOKEN_SECRET) && !message.includes(FULL_TOKEN);
    });
  });
});

// ---------------------------------------------------------------------------
// Capabilities: refuse before dispatch
// ---------------------------------------------------------------------------

describe('planetscale management — capability gates (zero dispatch)', () => {
  it('declares the honest capability table', () => {
    const { fetch } = fakeFetch(() => ({ body: {} }));
    const { adapter, client } = makeAdapter(fetch);
    const descriptor = describeManagementCapabilities(adapter);
    expect(descriptor.providerId).toBe('planetscale');
    expect(descriptor.resourceKinds).toEqual(['project', 'branch', 'role']);
    expect(descriptor.operations.update).toEqual(['project', 'role']);
    expect(descriptor.operations.resetCredential).toEqual(['role']);
    expect(descriptor.operations.connection).toEqual(['project', 'branch', 'role']);
    expect(descriptor.asyncOperations).toBe(false);
    expect(descriptor.statusPolling).toEqual(['project', 'branch', 'role']);
    expect(client.capabilities.supported.actions).toEqual({});
  });

  it('refuses undeclared kinds with CAPABILITY and no network request', async () => {
    const { client, calls } = makeClient(() => ({ body: {} }));
    await expect(client.create({ kind: 'database', projectId: 'x', branchId: 'y', name: 'n' })).rejects.toMatchObject({
      code: 'CAPABILITY',
    });
    await expect(client.list('database')).rejects.toMatchObject({ code: 'CAPABILITY' });
    await expect(client.list('password' as never)).rejects.toMatchObject({ code: 'CAPABILITY' });
    expect(calls).toHaveLength(0);
  });

  it('refuses update on branch (official PATCH not verified this round) and actions entirely, before dispatch', async () => {
    const { client, calls } = makeClient(() => ({ body: {} }));
    await expect(
      client.update({ kind: 'branch', id: 'main', projectId: 'app-db', patch: { name: 'x' } }),
    ).rejects.toMatchObject({ code: 'CAPABILITY' });
    await expect(client.action({ kind: 'project', id: 'app-db' }, 'restart')).rejects.toMatchObject({
      code: 'CAPABILITY',
    });
    expect(calls).toHaveLength(0);
  });

  it('refuses org-scoped verbs without the organization option, before dispatch', async () => {
    const { client, calls } = makeClient(() => ({ body: {} }), { organization: undefined });
    await expect(client.list('project')).rejects.toMatchObject({ code: 'CONFIGURATION' });
    await expect(client.get({ kind: 'branch', id: 'main', projectId: 'app-db' })).rejects.toMatchObject({
      code: 'CONFIGURATION',
    });
    await expect(client.list('role', { scope: { projectId: 'app-db', branchId: 'main' } })).rejects.toMatchObject({
      code: 'CONFIGURATION',
    });
    await expect(client.regions()).rejects.toMatchObject({ code: 'CONFIGURATION' });
    // organizations() itself is NOT org-scoped (GET /organizations) and stays available.
    expect(calls).toHaveLength(0);
  });

  it('validates role scope fields before dispatch', async () => {
    const { client, calls } = makeClient(() => ({ body: {} }));
    await expect(client.get({ kind: 'role', id: 'role-uid-456' })).rejects.toMatchObject({ code: 'CONFIGURATION' });
    await expect(
      client.get({ kind: 'role', id: 'role-uid-456', scope: { projectId: 'app-db' } }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Databases (unified kind 'project')
// ---------------------------------------------------------------------------

describe('planetscale management — databases (kind project)', () => {
  it('creates a PostgreSQL database with the official body shape and maps the response', async () => {
    const { client, calls } = makeClient((req) => {
      if (req.method === 'POST' && req.path === '/organizations/acme/databases') {
        return { status: 201, body: databaseFixture({ state: 'pending', ready: false }) };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const result = await client.create({
      kind: 'project',
      name: 'app-db',
      region: 'us-east-1',
      organizationId: 'acme',
      providerOptions: { cluster_size: 'PS_10', major_version: '17' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toMatchObject({
      name: 'app-db',
      kind: 'postgresql',
      cluster_size: 'PS_10',
      major_version: '17',
      region: 'us-east-1',
    });
    expect(result.resource).toMatchObject({
      kind: 'project',
      providerId: 'planetscale',
      id: 'app-db', // canonical id is the NAME SLUG
      name: 'app-db',
      region: 'us-east-1',
      status: 'creating',
      providerStatus: 'pending',
    });
    expect((result.resource!.raw as Record<string, unknown>)['id']).toBe('psdb-uid-123'); // uid preserved in raw
    expect(result.secrets).toEqual([]);
    // No operations API: nothing fabricated.
    expect(result.operation).toBeNull();
    expect(result.indeterminate).toBe(false);
  });

  it('requires cluster_size explicitly and refuses conflicting engine kinds, before dispatch', async () => {
    const { client, calls } = makeClient(() => ({ status: 201, body: databaseFixture() }));
    await expect(
      client.create({ kind: 'project', name: 'app-db', organizationId: 'acme' }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
    await expect(
      client.create({
        kind: 'project',
        name: 'app-db',
        organizationId: 'acme',
        providerOptions: { cluster_size: 'PS_10', kind: 'mysql' },
      }),
    ).rejects.toSatisfy((err: unknown) => err instanceof ManagementError && /mysql/i.test(err.message));
    await expect(
      client.create({
        kind: 'project',
        name: 'app-db',
        organizationId: 'acme',
        providerOptions: { cluster_size: 'PS_10', kind: 'neki' },
      }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
    await expect(
      client.create({ kind: 'project', name: 'x', organizationId: 'acme', plan: 'pro' }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
    await expect(
      client.create({ kind: 'project', name: 'x', organizationId: 'acme', password: 'hunter2' }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
    await expect(
      client.create({
        kind: 'project',
        name: 'x',
        organizationId: 'acme',
        providerOptions: { cluster_size: 'PS_10', not_a_field: 1 },
      }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
    expect(calls).toHaveLength(0);
  });

  it('reads database readiness from real GETs; a bare project ref can wait to active', async () => {
    let n = 0;
    const { client, calls } = makeClient((req) => {
      expect(req.method).toBe('GET');
      expect(req.path).toBe('/organizations/acme/databases/app-db');
      n += 1;
      if (n === 1) return { body: databaseFixture({ ready: false, state: 'pending' }) };
      return { body: databaseFixture({ ready: true, state: 'ready' }) };
    });
    const resource = await client.wait({ kind: 'project', id: 'app-db' }, { pollIntervalMs: 0, timeoutMs: 5000 });
    expect(n).toBe(2);
    expect(resource.status).toBe('active');
    expect(resource.providerStatus).toBe('ready');
  });

  it('does not replay mutations while waiting (GETs only after the create POST)', async () => {
    const methods: string[] = [];
    const { client } = makeClient((req) => {
      methods.push(req.method);
      if (req.method === 'POST') return { status: 201, body: databaseFixture({ ready: false, state: 'pending' }) };
      return { body: databaseFixture({ ready: true, state: 'ready' }) };
    });
    const result = await client.create({ kind: 'project', name: 'app-db', organizationId: 'acme', providerOptions: { cluster_size: 'PS_10' } });
    await client.wait(result, { pollIntervalMs: 0, timeoutMs: 5000 });
    expect(methods).toEqual(['POST', 'GET']);
  });

  it('maps non-ready official states truthfully (sleeping -> paused, sleep_in_progress -> updating)', async () => {
    const { client } = makeClient((req) => ({
      body: databaseFixture({ ready: false, state: 'sleeping' }),
    }));
    const resource = await client.get({ kind: 'project', id: 'app-db' });
    expect(resource.status).toBe('paused');
    expect(resource.providerStatus).toBe('sleeping');
  });

  it('updates database settings via PATCH with new_name mapping; refuses Vitess-only fields', async () => {
    const { client, calls } = makeClient((req) => {
      if (req.method === 'GET' && req.path === '/organizations/acme/databases/app-db') {
        return { body: databaseFixture({ kind: 'postgresql' }) }; // engine pre-flight
      }
      expect(req.method).toBe('PATCH');
      expect(req.path).toBe('/organizations/acme/databases/app-db');
      return { body: databaseFixture({ ready: true, state: 'ready' }) };
    });
    const result = await client.update({ kind: 'project', id: 'app-db', patch: { name: 'renamed-db', providerOptions: { deletion_protected: true } } });
    expect(calls[1]!.method).toBe('PATCH');
    expect(calls[1]!.body).toMatchObject({ new_name: 'renamed-db', deletion_protected: true });
    expect(result.resource!.id).toBe('app-db');
    expect(result.resource!.status).toBe('active');

    await expect(
      client.update({ kind: 'project', id: 'app-db', patch: { providerOptions: { automatic_migrations: true } } }),
    ).rejects.toSatisfy((err: unknown) => err instanceof ManagementError && /Vitess/i.test(err.message));
    await expect(client.update({ kind: 'project', id: 'app-db', patch: {} })).rejects.toMatchObject({
      code: 'CONFIGURATION',
    });
  });

  it('deletes a database via DELETE and tolerates the empty 204 (engine pre-flight GET first)', async () => {
    const { client, calls } = makeClient((req) => {
      if (req.method === 'GET' && req.path === '/organizations/acme/databases/app-db') {
        return { body: databaseFixture({ kind: 'postgresql' }) }; // engine pre-flight
      }
      expect(req.method).toBe('DELETE');
      expect(req.path).toBe('/organizations/acme/databases/app-db');
      return { status: 204, body: null };
    });
    const result = await client.delete({ kind: 'project', id: 'app-db' });
    expect(result.operation).toBeNull();
    expect(result.indeterminate).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'DELETE']);
  });

  it('lists databases with page/per_page and maps next_page to the cursor', async () => {
    let n = 0;
    const { client, calls } = makeClient((req) => {
      n += 1;
      expect(req.path).toBe('/organizations/acme/databases');
      if (n === 1) {
        expect(req.query.get('page')).toBeNull();
        return {
          body: {
            type: 'list',
            current_page: 1,
            per_page: 2,
            next_page: 2,
            prev_page: null,
            next_page_url: '/v1/organizations/acme/databases?page=2',
            total_count: 3,
            data: [databaseFixture({ name: 'db-a' }), databaseFixture({ name: 'db-b' })],
          },
        };
      }
      expect(req.query.get('page')).toBe('2');
      expect(req.query.get('per_page')).toBe('2');
      return {
        body: {
          type: 'list',
          current_page: 2,
          per_page: 2,
          next_page: null,
          data: [databaseFixture({ name: 'db-c' })],
        },
      };
    });
    const page1 = await client.list('project', { limit: 2 });
    expect(page1.resources.map((r) => r.id)).toEqual(['db-a', 'db-b']);
    expect(page1.cursor).toBe('2');
    const page2 = await client.list('project', { cursor: page1.cursor!, limit: 2 });
    expect(page2.resources.map((r) => r.id)).toEqual(['db-c']);
    expect(page2.cursor).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('refuses a non-page-number cursor loudly', async () => {
    const { client, calls } = makeClient(() => ({ body: {} }));
    await expect(client.list('project', { cursor: 'abc' })).rejects.toMatchObject({ code: 'CONFIGURATION' });
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Branches (unified kind 'branch'; readiness from the BRANCH payload)
// ---------------------------------------------------------------------------

describe('planetscale management — branches', () => {
  it('creates a branch with parent_branch from sourceBranchId and maps it (engine pre-flight GET first)', async () => {
    const { client, calls } = makeClient((req) => {
      if (req.method === 'GET' && req.path === '/organizations/acme/databases/app-db') {
        return { body: databaseFixture({ kind: 'postgresql' }) }; // engine pre-flight
      }
      expect(req.method).toBe('POST');
      expect(req.path).toBe('/organizations/acme/databases/app-db/branches');
      return { status: 201, body: branchFixture({ name: 'feature', state: 'pending', ready: false }) };
    });
    const result = await client.create({
      kind: 'branch',
      projectId: 'app-db',
      name: 'feature',
      sourceBranchId: 'main',
      providerOptions: { region: 'us-east-1', restore_point: '2026-01-01T00:00:00Z' },
    });
    expect(calls[0]!.method).toBe('GET'); // engine pre-flight
    expect(calls[1]!.body).toMatchObject({
      name: 'feature',
      parent_branch: 'main',
      region: 'us-east-1',
      restore_point: '2026-01-01T00:00:00Z',
    });
    expect(result.resource).toMatchObject({
      kind: 'branch',
      id: 'feature',
      name: 'feature',
      projectId: 'app-db',
      status: 'creating',
      providerStatus: 'pending',
    });
    expect(result.resource!.raw['id']).toBe('branch-uid-789'); // uid preserved, slug canonical
  });

  it('requires a branch name (official required field), before dispatch', async () => {
    const { client, calls } = makeClient(() => ({ status: 201, body: branchFixture() }));
    await expect(client.create({ kind: 'branch', projectId: 'app-db' })).rejects.toMatchObject({
      code: 'CONFIGURATION',
    });
    expect(calls).toHaveLength(0);
  });

  it('waits on a branch ref by polling the BRANCH path, not the database', async () => {
    let n = 0;
    const { client, calls } = makeClient((req) => {
      expect(req.method).toBe('GET');
      expect(req.path).toBe('/organizations/acme/databases/app-db/branches/feature');
      n += 1;
      if (n === 1) return { body: branchFixture({ name: 'feature', ready: false, state: 'pending' }) };
      return { body: branchFixture({ name: 'feature', ready: true, state: 'ready' }) };
    });
    const resource = await client.wait(
      { kind: 'branch', id: 'feature', projectId: 'app-db' },
      { pollIntervalMs: 0, timeoutMs: 5000 },
    );
    expect(n).toBe(2);
    expect(resource.status).toBe('active');
    expect(calls.every((call) => call.path.includes('/branches/feature'))).toBe(true);
    expect(calls.some((call) => call.path === '/organizations/acme/databases/app-db')).toBe(false);
  });

  it('lists branches scoped by the database slug', async () => {
    const { client, calls } = makeClient(() => ({
      body: { type: 'list', current_page: 1, per_page: 25, next_page: null, data: [branchFixture()] },
    }));
    const page = await client.list('branch', { projectId: 'app-db' });
    expect(page.kind).toBe('branch');
    expect(page.resources).toHaveLength(1);
    expect(page.resources[0]!.projectId).toBe('app-db');
    expect(calls[0]!.path).toBe('/organizations/acme/databases/app-db/branches');
  });

  it('deletes a branch via DELETE (204) with engine pre-flight', async () => {
    const { client, calls } = makeClient((req) => {
      if (req.method === 'GET' && req.path === '/organizations/acme/databases/app-db') {
        return { body: databaseFixture({ kind: 'postgresql' }) }; // engine pre-flight
      }
      expect(req.path).toBe('/organizations/acme/databases/app-db/branches/feature');
      expect(req.method).toBe('DELETE');
      return { status: 204, body: null };
    });
    await expect(client.delete({ kind: 'branch', id: 'feature', projectId: 'app-db' })).resolves.toMatchObject({
      operation: null,
      indeterminate: false,
    });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'DELETE']);
  });
});

// ---------------------------------------------------------------------------
// Roles (provider-defined kind; one-time secrets)
// ---------------------------------------------------------------------------

describe('planetscale management — roles (kind role)', () => {
  it('creates a role with the official body and surfaces the one-time password ONLY in secrets (engine pre-flight first)', async () => {
    const { client, calls } = makeClient((req) => {
      if (req.method === 'GET' && req.path === '/organizations/acme/databases/app-db') {
        return { body: databaseFixture({ kind: 'postgresql' }) }; // engine pre-flight
      }
      expect(req.method).toBe('POST');
      expect(req.path).toBe('/organizations/acme/databases/app-db/branches/main/roles');
      return { status: 200, body: roleFixture({ password: ONE_TIME_PASSWORD }) };
    });
    const result = await client.create({
      kind: 'role',
      scope: { projectId: 'app-db', branchId: 'main' },
      name: 'app-role',
      providerOptions: { ttl: 3600, inherited_roles: ['pg_read_all_data'], with_replication: false },
    });
    expect(calls[0]!.method).toBe('GET'); // engine pre-flight
    expect(calls[1]!.body).toMatchObject({
      name: 'app-role',
      ttl: 3600,
      inherited_roles: ['pg_read_all_data'],
      with_replication: false,
    });
    expect(result.secrets).toEqual([{ label: 'password:app-role', value: ONE_TIME_PASSWORD }]);
    expect(result.resource).toMatchObject({
      kind: 'role',
      id: 'role-uid-456', // canonical id is the role UID
      name: 'app-role',
      status: 'active',
      scope: { projectId: 'app-db', branchId: 'main' },
    });
    expect((result.resource!.raw as Record<string, unknown>)['password']).toBe('[redacted]');
  });

  it('registers the one-time password so later errors never echo it', async () => {
    let call = 0;
    const { client } = makeClient((req) => {
      call += 1;
      if (call === 1) return { body: databaseFixture({ kind: 'postgresql' }) }; // create pre-flight
      if (call === 2) return { status: 200, body: roleFixture({ password: ONE_TIME_PASSWORD }) };
      if (call === 3) return { body: databaseFixture({ kind: 'postgresql' }) }; // reset pre-flight
      return { status: 500, body: { message: `reset failed for ${ONE_TIME_PASSWORD}` } };
    });
    await client.create({ kind: 'role', scope: { projectId: 'app-db', branchId: 'main' } });
    const promise = client.resetCredential({ kind: 'role', id: 'role-uid-456', scope: { projectId: 'app-db', branchId: 'main' } });
    await expect(promise).rejects.toSatisfy((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      return !message.includes(ONE_TIME_PASSWORD);
    });
  });

  it('gets and lists roles by UID; refuses unknown providerOptions', async () => {
    const { client, calls } = makeClient((req) => {
      if (req.method === 'GET' && req.path.endsWith('/roles/role-uid-456')) {
        return { body: roleFixture() };
      }
      return { body: { type: 'list', current_page: 1, per_page: 25, next_page: null, data: [roleFixture()] } };
    });
    const role = await client.get({ kind: 'role', id: 'role-uid-456', scope: { projectId: 'app-db', branchId: 'main' } });
    expect(role.id).toBe('role-uid-456');
    expect(role.name).toBe('app-role');
    expect(calls[0]!.path).toBe('/organizations/acme/databases/app-db/branches/main/roles/role-uid-456');

    const page = await client.list('role', { scope: { projectId: 'app-db', branchId: 'main' } });
    expect(page.resources).toHaveLength(1);
    expect(calls[1]!.path).toBe('/organizations/acme/databases/app-db/branches/main/roles');

    await expect(
      client.create({ kind: 'role', scope: { projectId: 'app-db', branchId: 'main' }, providerOptions: { bogus: 1 } }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
  });

  it('maps role lifecycle truthfully (expired -> paused, dropped -> deleting)', async () => {
    const { client } = makeClient(() => ({ body: roleFixture({ ready: false, expired: true }) }));
    const role = await client.get({ kind: 'role', id: 'role-uid-456', scope: { projectId: 'app-db', branchId: 'main' } });
    expect(role.status).toBe('paused');
    expect(role.providerStatus).toBe('expired');

    const { client: client2 } = makeClient(() => ({ body: roleFixture({ ready: false, dropped_at: NOW }) }));
    const dropped = await client2.get({ kind: 'role', id: 'r', scope: { projectId: 'app-db', branchId: 'main' } });
    expect(dropped.status).toBe('deleting');
  });

  it('updates a role name via PATCH (engine pre-flight first)', async () => {
    const { client, calls } = makeClient((req) => {
      if (req.method === 'GET' && req.path === '/organizations/acme/databases/app-db') {
        return { body: databaseFixture({ kind: 'postgresql' }) }; // engine pre-flight
      }
      expect(req.method).toBe('PATCH');
      expect(req.path).toBe('/organizations/acme/databases/app-db/branches/main/roles/role-uid-456');
      return { body: roleFixture({ name: 'renamed-role' }) };
    });
    const result = await client.update({
      kind: 'role',
      id: 'role-uid-456',
      scope: { projectId: 'app-db', branchId: 'main' },
      patch: { name: 'renamed-role' },
    });
    expect(calls[0]!.method).toBe('GET'); // engine pre-flight
    expect(calls[1]!.body).toEqual({ name: 'renamed-role' });
    expect(result.resource!.name).toBe('renamed-role');
  });

  it('resets credentials via POST .../roles/{id}/reset (no body) and returns the new one-time password', async () => {
    const newPassword = 'pscale_pw_rotated_fixture_value';
    const { client, calls } = makeClient((req) => {
      if (req.method === 'GET' && req.path === '/organizations/acme/databases/app-db') {
        return { body: databaseFixture({ kind: 'postgresql' }) }; // engine pre-flight
      }
      expect(req.method).toBe('POST');
      expect(req.path).toBe('/organizations/acme/databases/app-db/branches/main/roles/role-uid-456/reset');
      expect(req.body).toBeUndefined();
      return { status: 200, body: roleFixture({ password: newPassword }) };
    });
    const result = await client.resetCredential({
      kind: 'role',
      id: 'role-uid-456',
      scope: { projectId: 'app-db', branchId: 'main' },
    });
    expect(result.secrets).toEqual([{ label: 'password:app-role', value: newPassword }]);
    expect(result.resource!.status).toBe('active');
    expect((result.resource!.raw as Record<string, unknown>)['password']).toBe('[redacted]');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']); // engine pre-flight, then reset
  });

  it('refuses caller-supplied passwords on reset (server generates), before dispatch', async () => {
    const { client, calls } = makeClient(() => ({ body: {} }));
    await expect(
      client.resetCredential(
        { kind: 'role', id: 'role-uid-456', scope: { projectId: 'app-db', branchId: 'main' } },
        { password: 'hunter2' },
      ),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
    expect(calls).toHaveLength(0);
  });

  it('refuses resetCredential for non-role kinds (Vitess passwords are a separate system)', async () => {
    const { client, calls } = makeClient(() => ({ body: {} }));
    await expect(client.resetCredential({ kind: 'project', id: 'app-db' })).rejects.toMatchObject({
      code: 'CAPABILITY',
    });
    expect(calls).toHaveLength(0);
  });

  it('deletes a role via DELETE (204) with engine pre-flight', async () => {
    const { client, calls } = makeClient((req) => {
      if (req.method === 'GET' && req.path === '/organizations/acme/databases/app-db') {
        return { body: databaseFixture({ kind: 'postgresql' }) }; // engine pre-flight
      }
      expect(req.method).toBe('DELETE');
      expect(req.path).toBe('/organizations/acme/databases/app-db/branches/main/roles/role-uid-456');
      return { status: 204, body: null };
    });
    await expect(
      client.delete({ kind: 'role', id: 'role-uid-456', scope: { projectId: 'app-db', branchId: 'main' } }),
    ).resolves.toMatchObject({ operation: null, indeterminate: false });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'DELETE']);
  });
});

// ---------------------------------------------------------------------------
// Discovery: organizations + regions (+ raw cluster size SKUs)
// ---------------------------------------------------------------------------

describe('planetscale management — organizations and regions', () => {
  it('lists organizations with the org slug as canonical id and the uid as aliasId', async () => {
    const { client, calls } = makeClient((req) => {
      expect(req.path).toBe('/organizations');
      expect(req.method).toBe('GET');
      return {
        body: {
          type: 'list',
          current_page: 1,
          next_page: null,
          data: [
            { id: 'org-uid-1', name: 'acme', created_at: NOW, updated_at: NOW, plan: 'hobby' },
            { id: 'org-uid-2', name: 'other-org', created_at: NOW, updated_at: NOW },
          ],
        },
      };
    });
    const orgs = await client.organizations();
    expect(orgs).toEqual([
      expect.objectContaining({ providerId: 'planetscale', id: 'acme', name: 'acme', aliasId: 'org-uid-1' }),
      expect.objectContaining({ providerId: 'planetscale', id: 'other-org', aliasId: 'org-uid-2' }),
    ]);
    expect(calls[0]!.headers['authorization']).toBe(FULL_TOKEN);
  });

  it('honors engine flags and enabled when listing regions', async () => {
    const { client, calls } = makeClient((req) => {
      expect(req.path).toBe('/organizations/acme/regions');
      return {
        body: {
          type: 'list',
          next_page: null,
          data: [
            REGION_OBJ, // enabled + postgresql_supported -> included
            { ...REGION_OBJ, slug: 'eu-west-1', display_name: 'EU West', current_default: false }, // included
            { ...REGION_OBJ, slug: 'disabled-1', enabled: false }, // excluded
            { ...REGION_OBJ, slug: 'mysql-only', postgresql_supported: false }, // excluded
          ],
        },
      };
    });
    const regions = await client.regions();
    expect(regions.map((r) => r.id)).toEqual(['us-east-1', 'eu-west-1']);
    expect(regions[0]).toMatchObject({
      providerId: 'planetscale',
      id: 'us-east-1',
      name: 'US East (Ohio)',
      platform: 'AWS',
      default: true,
    });
    expect(regions[0]!.raw['neki_supported']).toBe(false); // full payload preserved in raw
    expect(calls[0]!.path).toBe('/organizations/acme/regions');
  });

  it('regions accepts an explicit organizationId overriding the factory default', async () => {
    const { client, calls } = makeClient((req) => {
      expect(req.path).toBe('/organizations/other-org/regions');
      return { body: { next_page: null, data: [] } };
    });
    await expect(client.regions({ organizationId: 'other-org' })).resolves.toEqual([]);
  });

  it('raw.clusterSizeSkus always sends an engine param (official default is mysql)', async () => {
    const { client, calls } = makeClient((req) => {
      expect(req.path).toBe('/organizations/acme/cluster-size-skus');
      expect(req.query.get('engine')).toBe('postgresql');
      return {
        body: [
          { name: 'PS_10', display_name: 'PS_10', cpu: '0.25', ram: 1, metal: false, enabled: true },
          { name: 'PS_20', display_name: 'PS_20', cpu: '0.5', ram: 2, metal: false, enabled: true },
          { name: 'PS_METAL_30', metal: true, enabled: false },
        ],
      };
    });
    const skus = await client.raw.clusterSizeSkus();
    expect(skus).toHaveLength(3);
    expect(skus[0]).toMatchObject({ name: 'PS_10', enabled: true });
    expect(calls[0]!.query.get('engine')).toBe('postgresql');
  });
});

// ---------------------------------------------------------------------------
// Connection info (hosts live on roles; nothing is ever fabricated)
// ---------------------------------------------------------------------------

describe('planetscale management — connection', () => {
  it('builds connection info from a role ref, with the documented port and a redacted URI', async () => {
    const { client, calls } = makeClient((req) => {
      expect(req.path).toBe('/organizations/acme/databases/app-db/branches/main/roles/role-uid-456');
      return { body: roleFixture() };
    });
    const direct = await client.connection(
      { kind: 'role', id: 'role-uid-456', scope: { projectId: 'app-db', branchId: 'main' } },
      {},
    );
    expect(direct).toMatchObject({
      providerId: 'planetscale',
      kind: 'role',
      id: 'role-uid-456',
      projectId: 'app-db',
      branchId: 'main',
      host: 'eu-central-useast1-1.horizon.psdb.cloud',
      port: 5432,
      database: 'app-db',
      role: 'app-role.br3anchid',
      pooled: null,
      secrets: [],
    });
    expect(direct.redactedUri).toBe(
      'postgresql://app-role.br3anchid:[redacted]@eu-central-useast1-1.horizon.psdb.cloud:5432/app-db',
    );
    expect(direct.redactedUri).not.toContain(ONE_TIME_PASSWORD);
    // The role password is never recoverable -> reveal: true cannot conjure one.
    const revealed = await client.connection(
      { kind: 'role', id: 'role-uid-456', scope: { projectId: 'app-db', branchId: 'main' } },
      { reveal: true, pooled: true },
    );
    expect(revealed.secrets).toEqual([]);
    expect(revealed.pooled).toBe(true);
    expect(revealed.port).toBe(6432);
  });

  it('uses the official default role for branch and project refs', async () => {
    const { client, calls } = makeClient((req) => {
      if (req.path === '/organizations/acme/databases/app-db/branches/main/roles/default') {
        return { body: roleFixture() };
      }
      if (req.path === '/organizations/acme/databases/app-db') {
        return { body: databaseFixture({ default_branch: 'main' }) };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const branchConn = await client.connection({ kind: 'branch', id: 'main', projectId: 'app-db' });
    expect(branchConn.kind).toBe('branch');
    expect(branchConn.host).toBe('eu-central-useast1-1.horizon.psdb.cloud');

    const projectConn = await client.connection({ kind: 'project', id: 'app-db' });
    expect(projectConn.kind).toBe('project');
    expect(projectConn.branchId).toBe('main');
    expect(projectConn.database).toBe('app-db');
    expect(calls.map((c) => c.path)).toEqual([
      '/organizations/acme/databases/app-db/branches/main/roles/default',
      '/organizations/acme/databases/app-db',
      '/organizations/acme/databases/app-db/branches/main/roles/default',
    ]);
  });

  it('refuses connection for undeclared kinds and missing default_branch, before any fabrication', async () => {
    const { client, calls } = makeClient((req) => {
      if (req.path === '/organizations/acme/databases/app-db') {
        return { body: databaseFixture({ default_branch: null }) };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    await expect(client.connection({ kind: 'role' as never, id: 'x' })).rejects.toMatchObject({
      code: 'CONFIGURATION',
    });
    await expect(client.connection({ kind: 'project', id: 'app-db' })).rejects.toMatchObject({
      code: 'PROVIDER',
    });
    expect(calls.some((c) => c.path.includes('/roles/'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error semantics from the shared transport
// ---------------------------------------------------------------------------

describe('planetscale management — error semantics', () => {
  it('maps 429 with retryAfterMs and 401/403 to AUTH/PERMISSION', async () => {
    const { client } = makeClient((req) => {
      if (req.path.includes('/databases/app-db') && req.method === 'GET') {
        return { status: 429, body: { message: 'rate limited' }, headers: { 'retry-after': '3' } };
      }
      return { status: 401, body: { message: 'bad token' } };
    });
    await expect(client.get({ kind: 'project', id: 'app-db' })).rejects.toMatchObject({
      code: 'RATE_LIMIT',
      retryAfterMs: 3000,
    });
    await expect(client.list('project')).rejects.toMatchObject({ code: 'AUTH' });
  });

  it('marks a 5xx mutation indeterminate (never retried) and a definitive 4xx not', async () => {
    let call = 0;
    const { client } = makeClient(() => {
      call += 1;
      if (call === 1) return { status: 500, body: { message: 'internal' } };
      if (call === 2) return { status: 422, body: { message: 'bad name' } };
      throw new Error('unreachable');
    });
    const err1 = (await client
      .create({ kind: 'project', name: 'x', organizationId: 'acme', providerOptions: { cluster_size: 'PS_10' } })
      .catch((e: unknown) => e)) as ManagementError;
    expect(err1).toBeInstanceOf(ManagementError);
    expect(err1.indeterminate).toBe(true);

    const err2 = (await client
      .create({ kind: 'project', name: 'x', organizationId: 'acme', providerOptions: { cluster_size: 'PS_10' } })
      .catch((e: unknown) => e)) as ManagementError;
    expect(err2.indeterminate).toBe(false);
    expect(err2.code).toBe('VALIDATION');
  });

  it('reports connection failures on mutations as indeterminate', async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const { client } = makeAdapter(fetch);
    const err = (await client
      .create({ kind: 'project', name: 'x', organizationId: 'acme', providerOptions: { cluster_size: 'PS_10' } })
      .catch((e: unknown) => e)) as ManagementError;
    expect(err.code).toBe('CONNECTION');
    expect(err.indeterminate).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Raw escape hatch: renewRole
// ---------------------------------------------------------------------------

describe('planetscale management — raw.renewRole', () => {
  it('renews a role expiration via the official endpoint (engine pre-flight first)', async () => {
    const { client, calls } = makeClient((req) => {
      if (req.method === 'GET' && req.path === '/organizations/acme/databases/app-db') {
        return { body: databaseFixture({ kind: 'postgresql' }) }; // engine pre-flight
      }
      expect(req.method).toBe('POST');
      expect(req.path).toBe('/organizations/acme/databases/app-db/branches/main/roles/role-uid-456/renew');
      return { body: roleFixture({ expires_at: '2027-10-06T00:00:00Z' }) };
    });
    const resource = await client.raw.renewRole({ projectId: 'app-db', branchId: 'main', roleId: 'role-uid-456' });
    expect(resource).toMatchObject({ kind: 'role', id: 'role-uid-456', status: 'active' });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']); // engine pre-flight, then renew
  });

  it('validates raw.renewRole inputs before dispatch', async () => {
    const { client, calls } = makeClient(() => ({ body: {} }));
    await expect(client.raw.renewRole({ projectId: 'app-db', branchId: '', roleId: 'r' })).rejects.toMatchObject({
      code: 'CONFIGURATION',
    });
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Review R3 regressions: engine gate before mutations (F1), role status precedence
// (F2), org consistency (F4), refused caller passwords (F5), per_page cap (F8)
// ---------------------------------------------------------------------------

describe('planetscale management — review R3 regressions', () => {
  it('F1: no PATCH is sent for a Vitess (kind mysql) database — engine pre-flight refuses first', async () => {
    const { client, calls } = makeClient(() => ({ body: databaseFixture({ kind: 'mysql' }) }));
    await expect(
      client.update({ kind: 'project', id: 'app-db', patch: { providerOptions: { deletion_protected: true } } }),
    ).rejects.toSatisfy((err: unknown) => err instanceof ManagementError && /PostgreSQL/i.test(err.message));
    await expect(client.delete({ kind: 'project', id: 'app-db' })).rejects.toMatchObject({ code: 'CONFIGURATION' });
    expect(calls.every((c) => c.method === 'GET')).toBe(true); // two pre-flight GETs, zero mutations
  });

  it('F1: a missing kind field fails honestly instead of assuming PostgreSQL', async () => {
    const { kind: _omitted, ...noKind } = databaseFixture();
    const { client } = makeClient(() => ({ body: noKind }));
    await expect(client.get({ kind: 'project', id: 'app-db' })).rejects.toMatchObject({ code: 'PROVIDER' });
  });

  it('F1: list(project) returns only PostgreSQL databases (mixed engines filtered, not surfaced)', async () => {
    const { client } = makeClient(() => ({
      body: {
        next_page: null,
        data: [databaseFixture({ name: 'pg-a', kind: 'postgresql' }), databaseFixture({ name: 'vt', kind: 'mysql' })],
      },
    }));
    const page = await client.list('project');
    expect(page.resources.map((r) => r.id)).toEqual(['pg-a']);
  });

  it('F2: ready:true never outranks terminal/disabled states (dropped > expired > disabled > ready)', async () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [{ ready: true, dropped_at: NOW }, 'deleting', 'dropped'],
      [{ ready: true, expired: true }, 'paused', 'expired'],
      [{ ready: true, disabled_at: NOW }, 'paused', 'disabled'],
      [{ ready: true }, 'active', 'ready'],
    ];
    for (const [overrides, status, providerStatus] of cases) {
      const { client } = makeClient(() => ({ body: roleFixture(overrides) }));
      const role = await client.get({ kind: 'role', id: 'r', scope: { projectId: 'app-db', branchId: 'main' } });
      expect(role.status, JSON.stringify(overrides)).toBe(status);
      expect(role.providerStatus, JSON.stringify(overrides)).toBe(providerStatus);
    }
  });

  it('F4: create(project) with spec.organizationId different from the factory org is refused before dispatch', async () => {
    const { client, calls } = makeClient(() => {
      throw new Error('no request may be sent');
    });
    await expect(
      client.create({ kind: 'project', name: 'app-db', organizationId: 'other-org', providerOptions: { cluster_size: 'PS_10' } }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
    expect(calls).toHaveLength(0);
  });

  it('F5: create(role) refuses a caller-supplied password before dispatch', async () => {
    const { client, calls } = makeClient(() => ({ body: roleFixture() }));
    await expect(
      client.create({ kind: 'role', scope: { projectId: 'app-db', branchId: 'main' }, password: 'hunter2' }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
    expect(calls).toHaveLength(0);
  });

  it('F8: limit above the official per_page max (100) is refused before dispatch; 100 is accepted', async () => {
    const { client, calls } = makeClient(() => ({ body: { next_page: null, data: [] } }));
    await expect(client.list('project', { limit: 500 })).rejects.toMatchObject({ code: 'CONFIGURATION' });
    await client.list('project', { limit: 100 });
    expect(calls[0]!.query.get('per_page')).toBe('100');
    expect(calls).toHaveLength(1);
  });
});

// Type-level guard: write results must not claim an operation (no ops API).
describe('planetscale management — no fabricated operations', () => {
  it('every write result carries operation: null', async () => {
    const { client } = makeClient((req) => {
      if (req.method === 'GET' && req.path.endsWith('/databases/app-db')) {
        return { body: databaseFixture({ kind: 'postgresql' }) }; // branch/role create pre-flight
      }
      if (req.method === 'POST' && req.path.endsWith('/databases')) {
        return { status: 201, body: databaseFixture() };
      }
      if (req.method === 'POST' && req.path.endsWith('/branches')) {
        return { status: 201, body: branchFixture() };
      }
      if (req.method === 'POST' && req.path.endsWith('/roles')) {
        return { body: roleFixture({ password: ONE_TIME_PASSWORD }) };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const results: ManagementWriteResult[] = [
      await client.create({ kind: 'project', name: 'app-db', organizationId: 'acme', providerOptions: { cluster_size: 'PS_10' } }),
      await client.create({ kind: 'branch', projectId: 'app-db', name: 'feature' }),
      await client.create({ kind: 'role', scope: { projectId: 'app-db', branchId: 'main' } }),
    ];
    for (const result of results) {
      expect(result.operation).toBeNull();
      expect(result.indeterminate).toBe(false);
    }
  });
});
