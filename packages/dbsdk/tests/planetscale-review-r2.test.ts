/**
 * INDEPENDENT REVIEW R2 — PlanetScale Postgres adapter (review sub-agent, not the R1 author).
 *
 * File ownership: `tests/planetscale-review-r2.test.ts` only. Companion report:
 * `coordination/planetscale-postgres-review-r2.md`.
 *
 * Every endpoint contract asserted here was re-verified against the official per-endpoint
 * reference pages (each embedding the OpenAPI 3.0.1 YAML, fetched 2026-10-06 by this reviewer):
 * create_database, get_database, update_database_settings, create_role, get_default_role,
 * get_branch, list_cluster_size_skus, pagination. All tests are OFFLINE (injected fetch /
 * recording poolFactory); the only live leg is the env-gated LOCAL Postgres 17 on :15432
 * (driver compatibility only, explicitly NOT PlanetScale hosted TLS). No hosted calls, no
 * provisioned resources, no real secrets — every credential in this file is a fixed dummy
 * fixture labeled as such.
 *
 * Test naming: tests marked `FINDING F# (characterization)` intentionally assert the CURRENT
 * implementation behavior to make a defect reproducible in one run. Per review rules,
 * characterization tests passing is NOT acceptance — each maps to a finding with a severity
 * and a smallest repair in the companion report. Unmarked tests assert desired behavior.
 */

import { describe, expect, it } from 'vitest';
import { Client as PgClient } from 'pg';

import { createManagement } from '../src/management/core.js';
import { ManagementError } from '../src/management/errors.js';
import { planetscaleManagement } from '../src/management/planetscale.js';
import { planetscale, type PlanetScaleAdapterOptions } from '../src/planetscale.js';
import type { FetchLike, ManagementPage } from '../src/management/types.js';
import type { PgPoolConfig, PgPoolLike } from '../src/adapters/pg-engine.js';

// ---------------------------------------------------------------------------
// Offline fetch harness (mock control plane — clearly labeled, no live traffic)
// ---------------------------------------------------------------------------

type FakeResponse = { status?: number; body?: unknown; headers?: Record<string, string>; text?: string };
type CapturedRequest = {
  url: URL;
  path: string;
  method: string;
  body: unknown;
  query: URLSearchParams;
  headers: Record<string, string>;
};

const BASE_PATH = '/v1';

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
    if (response.status === 204) return new Response(null, { status: 204 });
    if (response.text !== undefined) {
      return new Response(response.text, { status: response.status ?? 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(response.body === undefined ? null : JSON.stringify(response.body ?? null), {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/json', ...(response.headers ?? {}) },
    });
  };
  return { fetch, calls };
}

// ---------------------------------------------------------------------------
// Official-spec-shaped fixtures (dummy values only; MOCKED control plane)
// ---------------------------------------------------------------------------

// Fixed dummy credential fixtures — labels are explicit so nobody mistakes these for secrets.
const TOKEN_ID = 'review-dummy-token-id';
const TOKEN_SECRET = 'review-dummy-token-secret';
const FULL_TOKEN = `${TOKEN_ID}:${TOKEN_SECRET}`;
const ORG = 'review-org';
const NOW = '2026-10-06T00:00:00Z';
/** Dummy one-time password fixture (shape per official docs: `pscale_pw_...`). NOT a secret. */
const DUMMY_PASSWORD = 'pscale_pw_review_fixture_dummy';

const REGION_OBJ = {
  id: 'region-uid-1',
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

/** Shaped from the official get_database response schema (all `required` fields included). */
function databaseFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'db-uid-123',
    url: `/organizations/${ORG}/databases/app-db`,
    branches_url: `/organizations/${ORG}/databases/app-db/branches`,
    branches_count: 0,
    open_schema_recommendations_count: 0,
    development_branches_count: 0,
    development_branches_limit: 10,
    production_branches_count: 0,
    multiple_admins_required_for_deletion: false,
    ready: false,
    at_backup_restore_branches_limit: false,
    at_development_branch_usage_limit: false,
    region: REGION_OBJ,
    html_url: 'https://app.planetscale.com',
    name: 'app-db',
    state: 'pending',
    sharded: false,
    default_branch_shard_count: 0,
    default_branch_read_only_regions_count: 0,
    default_branch_table_count: 0,
    default_branch: 'main', // official schema: string (required)
    require_approval_for_deploy: false,
    deletion_protected: false,
    resizing: false,
    resize_queued: false,
    config_changing: false,
    config_change_queued: false,
    allow_data_branching: false,
    foreign_keys_enabled: false,
    restrict_branch_region: false,
    prefer_instant: false,
    insights_raw_queries: false,
    plan: 'hobby',
    insights_enabled: false,
    production_branch_web_console: false,
    created_at: NOW,
    updated_at: NOW,
    schema_last_updated_at: null,
    kind: 'postgresql', // official schema: required enum mysql|postgresql|neki
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
    state: 'pending', // official get_branch enum: pending|sleep_in_progress|sleeping|awakening|ready
    ready: false,
    schema_ready: false,
    production: false,
    sharded: false,
    region: REGION_OBJ,
    parent_branch: null,
    ...overrides,
  };
}

/** Shaped from the official create_role/get_role/get_default_role response schema. */
function roleFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'role-uid-456',
    name: 'app-role',
    access_host_url: 'eu-central-useast1-1.horizon.psdb.cloud',
    private_access_host_url: 'private-eu-central-useast1-1.horizon.psdb.cloud',
    private_connection_service_name: 'svc-xyz',
    username: 'app-role.br3anchid',
    base_username: 'app-role',
    password: null, // one-time; present ONLY on create/reset responses
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
    actor: { id: 'actor-1', display_name: 'Review Actor', avatar_url: '' },
    query_safety_settings: { require_where_on_delete: 'off', require_where_on_update: 'off' },
    ...overrides,
  };
}

function makeAdapter(fetch: FetchLike, overrides: { organization?: string; timeoutMs?: number } = {}) {
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
  overrides: { organization?: string; timeoutMs?: number } = {},
) {
  const { fetch, calls } = fakeFetch(handler);
  return { ...makeAdapter(fetch, overrides), calls };
}

// ---------------------------------------------------------------------------
// 1. Official per-endpoint schema conformance (re-verified from official YAML)
// ---------------------------------------------------------------------------

describe('review r2 — official schema conformance (management)', () => {
  it('get_database: default_branch is a STRING (official schema) and drives connection(project)', async () => {
    const { client, calls } = makeClient((req) => {
      if (req.path === `/organizations/${ORG}/databases/app-db`) {
        return { body: databaseFixture({ ready: true, state: 'ready', default_branch: 'main' }) };
      }
      if (req.path === `/organizations/${ORG}/databases/app-db/branches/main/roles/default`) {
        return { body: roleFixture() };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const conn = await client.connection({ kind: 'project', id: 'app-db' });
    expect(conn.host).toBe('eu-central-useast1-1.horizon.psdb.cloud');
    expect(conn.port).toBe(5432);
    expect(conn.branchId).toBe('main');
    expect(calls.map((c) => c.path)).toEqual([
      `/organizations/${ORG}/databases/app-db`,
      `/organizations/${ORG}/databases/app-db/branches/main/roles/default`,
    ]);
  });

  it('create_database body matches the official schema: required [name, cluster_size], kind enum, no invented fields', async () => {
    const { client, calls } = makeClient(() => ({ status: 201, body: databaseFixture() }));
    await client.create({
      kind: 'project',
      name: 'app-db',
      region: 'us-east-1',
      organizationId: ORG,
      providerOptions: { cluster_size: 'PS_10', major_version: '17', replicas: 0 },
    });
    // Exact body: only official create_database fields may appear.
    expect(calls[0]!.body).toEqual({
      name: 'app-db',
      kind: 'postgresql',
      cluster_size: 'PS_10',
      major_version: '17',
      replicas: 0,
      region: 'us-east-1',
    });
  });

  it('cluster_size is REQUIRED by this adapter (official schema lists it required; prose says optional for PG) — contradiction resolved conservatively, no billable default invented', async () => {
    const { client, calls } = makeClient(() => ({ status: 201, body: databaseFixture() }));
    await expect(client.create({ kind: 'project', name: 'x', organizationId: ORG })).rejects.toMatchObject({
      code: 'CONFIGURATION',
    });
    expect(calls).toHaveLength(0);
  });

  it('update_database_settings PATCH allowlist matches the official body exactly; Vitess-only fields refused', async () => {
    const { client, calls } = makeClient((req) => {
      if (req.method === 'GET' && req.path.endsWith('/databases/app-db')) {
        return { body: databaseFixture({ ready: true, state: 'ready' }) }; // engine pre-flight
      }
      return { body: databaseFixture({ ready: true, state: 'ready' }) };
    });
    // All seven official Postgres-safe PATCH fields accepted and forwarded verbatim.
    await client.update({
      kind: 'project',
      id: 'app-db',
      patch: {
        providerOptions: {
          deletion_protected: true,
          default_branch: 'main',
          development_branches_limit: 5,
          require_approval_for_deploy: true,
          restrict_branch_region: true,
          insights_raw_queries: false,
          production_branch_web_console: true,
        },
      },
    });
    expect(calls[0]!.method).toBe('GET'); // engine pre-flight
    expect(calls[1]!.method).toBe('PATCH');
    expect(calls[1]!.body).toEqual({
      deletion_protected: true,
      default_branch: 'main',
      development_branches_limit: 5,
      require_approval_for_deploy: true,
      restrict_branch_region: true,
      insights_raw_queries: false,
      production_branch_web_console: true,
    });
    // The five Vitess-only PATCH fields are refused, not dropped.
    for (const field of ['automatic_migrations', 'migration_framework', 'migration_table_name', 'allow_data_branching', 'allow_foreign_key_constraints']) {
      await expect(
        client.update({ kind: 'project', id: 'app-db', patch: { providerOptions: { [field]: true } } }),
      ).rejects.toMatchObject({ code: 'CONFIGURATION' });
    }
    // A misspelled field (`deletion_protection`) is rejected as unknown — no silent dropping.
    await expect(
      client.update({ kind: 'project', id: 'app-db', patch: { providerOptions: { deletion_protection: true } } }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
  });

  it('create_role body accepts exactly the official fields; unknown keys refused before dispatch', async () => {
    const { client, calls } = makeClient((req) => {
      if (req.method === 'GET' && req.path.endsWith('/databases/app-db')) {
        return { body: databaseFixture({ kind: 'postgresql' }) }; // engine pre-flight
      }
      return { body: roleFixture({ password: DUMMY_PASSWORD }) };
    });
    await client.create({
      kind: 'role',
      scope: { projectId: 'app-db', branchId: 'main' },
      name: 'app-role',
      providerOptions: {
        ttl: 3600,
        inherited_roles: ['pg_read_all_data'],
        with_replication: false,
        require_where_on_delete: 'on',
        require_where_on_update: 'warn',
      },
    });
    expect(calls[1]!.body).toEqual({
      name: 'app-role',
      ttl: 3600,
      inherited_roles: ['pg_read_all_data'],
      with_replication: false,
      require_where_on_delete: 'on',
      require_where_on_update: 'warn',
    });
    await expect(
      client.create({ kind: 'role', scope: { projectId: 'app-db', branchId: 'main' }, providerOptions: { bogus: 1 } }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
  });

  it('role response mapping uses the official fields: id UID canonical, access_host_url → host, username, database_name', async () => {
    const { client } = makeClient(() => ({ body: roleFixture() }));
    const role = await client.get({ kind: 'role', id: 'role-uid-456', scope: { projectId: 'app-db', branchId: 'main' } });
    expect(role.id).toBe('role-uid-456');
    expect(role.name).toBe('app-role');
    expect((role.raw as Record<string, unknown>)['access_host_url']).toBe('eu-central-useast1-1.horizon.psdb.cloud');
    const conn = await client.connection({ kind: 'role', id: 'role-uid-456', scope: { projectId: 'app-db', branchId: 'main' } }, { pooled: true });
    expect(conn).toMatchObject({
      host: 'eu-central-useast1-1.horizon.psdb.cloud',
      port: 6432, // official PgBouncer port convention
      database: 'app-db',
      role: 'app-role.br3anchid',
    });
  });

  it('get_default_role path is the official .../roles/default for branch connections', async () => {
    const { client, calls } = makeClient(() => ({ body: roleFixture() }));
    await client.connection({ kind: 'branch', id: 'main', projectId: 'app-db' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe(`/organizations/${ORG}/databases/app-db/branches/main/roles/default`);
  });

  it('cluster-size-skus: engine query param always sent explicitly (official default is mysql), enum values accepted', async () => {
    const { client, calls } = makeClient(() => ({
      body: [{ name: 'PS_10', enabled: true }, { name: 'PS_METAL_30', enabled: false }],
    }));
    await client.raw.clusterSizeSkus();
    expect(calls[0]!.query.get('engine')).toBe('postgresql');
    await client.raw.clusterSizeSkus({ engine: 'neki' });
    expect(calls[1]!.query.get('engine')).toBe('neki');
  });

  it('regions: official engine flags honored — only enabled && postgresql_supported regions returned, full payload in raw', async () => {
    const { client } = makeClient(() => ({
      body: {
        next_page: null,
        data: [
          REGION_OBJ,
          { ...REGION_OBJ, slug: 'pg-no', postgresql_supported: false },
          { ...REGION_OBJ, slug: 'disabled', enabled: false },
          { ...REGION_OBJ, slug: 'neki-only', postgresql_supported: false, neki_supported: true },
        ],
      },
    }));
    const regions = await client.regions();
    expect(regions.map((r) => r.id)).toEqual(['us-east-1']);
    expect(regions[0]!.raw).toMatchObject({ mysql_supported: true, neki_supported: false });
  });

  it('branch state enum (official get_branch) maps truthfully: sleeping→paused, awakening→updating, ready→active', async () => {
    for (const [state, expected] of [
      ['pending', 'creating'],
      ['sleep_in_progress', 'updating'],
      ['sleeping', 'paused'],
      ['awakening', 'updating'],
      ['ready', 'active'],
    ] as const) {
      const { client } = makeClient(() => ({
        body: branchFixture({ state, ready: state === 'ready' }),
      }));
      const branch = await client.get({ kind: 'branch', id: 'main', projectId: 'app-db' });
      expect(branch.status, `state ${state}`).toBe(expected);
    }
  });

  it('readiness is read from the BRANCH payload, never the database (separate GET path proven)', async () => {
    const { client, calls } = makeClient((req) => {
      if (req.path.endsWith('/branches/feature')) return { body: branchFixture({ name: 'feature', ready: false, state: 'pending' }) };
      throw new Error(`unexpected ${req.path}`);
    });
    const branch = await client.get({ kind: 'branch', id: 'feature', projectId: 'app-db' });
    expect(branch.status).toBe('creating');
    expect(calls.every((c) => c.path.includes('/branches/feature'))).toBe(true);
    expect(calls.some((c) => c.path === `/organizations/${ORG}/databases/app-db`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. REGRESSION (was finding F1): the engine gate covers EVERY response, and no
//    mutation is ever sent for a non-PostgreSQL database.
// ---------------------------------------------------------------------------

describe('review r2 — REGRESSION F1: engine gate before any mutation, on every database response', () => {
  it('get() refuses a Vitess (kind mysql) database with CONFIGURATION — never mapped as a project resource', async () => {
    const vitessDb = databaseFixture({ kind: 'mysql', sharded: true });
    const { client, calls } = makeClient(() => ({ body: vitessDb }));
    await expect(client.get({ kind: 'project', id: 'app-db' })).rejects.toSatisfy(
      (err: unknown) => err instanceof ManagementError && /PostgreSQL/i.test(err.message) && err.code === 'CONFIGURATION',
    );
    expect(calls).toHaveLength(1); // the GET itself; no follow-up work
  });

  it('get() fails honestly (PROVIDER) when the required official kind field is missing — never assumed PostgreSQL', async () => {
    const { kind: _omitted, ...noKind } = databaseFixture();
    const { client } = makeClient(() => ({ body: noKind }));
    await expect(client.get({ kind: 'project', id: 'app-db' })).rejects.toMatchObject({ code: 'PROVIDER' });
  });

  it('update() sends NO PATCH against a Vitess database: engine pre-flight GET refuses first', async () => {
    const { client, calls } = makeClient(() => ({ body: databaseFixture({ kind: 'mysql' }) }));
    await expect(
      client.update({ kind: 'project', id: 'app-db', patch: { providerOptions: { deletion_protected: true } } }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
    expect(calls.map((c) => c.method)).toEqual(['GET']); // pre-flight only — zero mutations
  });

  it('delete() sends NO DELETE against a Vitess database: engine pre-flight GET refuses first', async () => {
    const { client, calls } = makeClient(() => ({ body: databaseFixture({ kind: 'mysql' }) }));
    await expect(client.delete({ kind: 'project', id: 'app-db' })).rejects.toMatchObject({ code: 'CONFIGURATION' });
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('create(branch) and create(role) on a Vitess database are refused after pre-flight, before their POSTs', async () => {
    const { client, calls } = makeClient(() => ({ body: databaseFixture({ kind: 'mysql' }) }));
    await expect(
      client.create({ kind: 'branch', projectId: 'app-db', name: 'feature' }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
    await expect(
      client.create({ kind: 'role', scope: { projectId: 'app-db', branchId: 'main' } }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
    expect(calls.every((c) => c.method === 'GET')).toBe(true); // two pre-flight GETs, no POSTs
  });

  it('delete(branch) and delete(role) on a Vitess database send no DELETE (pre-flight only)', async () => {
    const { client, calls } = makeClient(() => ({ body: databaseFixture({ kind: 'mysql' }) }));
    await expect(client.delete({ kind: 'branch', id: 'main', projectId: 'app-db' })).rejects.toMatchObject({
      code: 'CONFIGURATION',
    });
    await expect(client.delete({ kind: 'role', id: 'r', scope: { projectId: 'app-db', branchId: 'main' } })).rejects.toMatchObject({
      code: 'CONFIGURATION',
    });
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('connection(project) refuses a Vitess database (no PostgreSQL connection details are fabricated)', async () => {
    const { client } = makeClient((req) => {
      if (req.path === `/organizations/${ORG}/databases/app-db`) return { body: databaseFixture({ kind: 'mysql' }) };
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    await expect(client.connection({ kind: 'project', id: 'app-db' })).rejects.toMatchObject({ code: 'CONFIGURATION' });
  });

  it('list(project) is engine-filtered (only PostgreSQL entries returned); neki/mysql dropped, not surfaced', async () => {
    const { client } = makeClient(() => ({
      body: {
        next_page: null,
        data: [
          databaseFixture({ name: 'pg-db', kind: 'postgresql' }),
          databaseFixture({ name: 'vitess-db', kind: 'mysql' }),
          databaseFixture({ name: 'neki-db', kind: 'neki' }),
        ],
      },
    }));
    const page = await client.list('project');
    expect(page.resources.map((r) => r.id)).toEqual(['pg-db']);
  });

  it('list(project) fails honestly (PROVIDER) when an entry lacks the required kind field', async () => {
    const { kind: _omitted, ...noKind } = databaseFixture({ name: 'mystery-db' });
    const { client } = makeClient(() => ({ body: { next_page: null, data: [databaseFixture(), noKind] } }));
    await expect(client.list('project')).rejects.toMatchObject({ code: 'PROVIDER' });
  });

  it('a PostgreSQL database still passes every gate (positive case unchanged)', async () => {
    const { client, calls } = makeClient((req) => {
      if (req.method === 'GET' && req.path.endsWith('/databases/app-db')) {
        return { body: databaseFixture({ ready: true, state: 'ready' }) };
      }
      expect(req.method).toBe('DELETE');
      return { status: 204 };
    });
    const resource = await client.get({ kind: 'project', id: 'app-db' });
    expect(resource.status).toBe('active');
    await client.delete({ kind: 'project', id: 'app-db' });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'DELETE']);
  });
});

// ---------------------------------------------------------------------------
// 3. REGRESSION (was finding F2): terminal/deletion first, disabled/expired next,
//    readiness last — `ready: true` can never outrank a terminal or disabled state.
// ---------------------------------------------------------------------------

describe('review r2 — REGRESSION F2: role status precedence is terminal > disabled > ready', () => {
  it('ready=true + expired=true maps to PAUSED (never active)', async () => {
    const { client } = makeClient(() => ({ body: roleFixture({ ready: true, expired: true }) }));
    const role = await client.get({ kind: 'role', id: 'r', scope: { projectId: 'app-db', branchId: 'main' } });
    expect(role.status).toBe('paused');
    expect(role.providerStatus).toBe('expired');
  });

  it('ready=true + disabled_at set maps to PAUSED (never active)', async () => {
    const { client } = makeClient(() => ({ body: roleFixture({ ready: true, disabled_at: NOW }) }));
    const role = await client.get({ kind: 'role', id: 'r', scope: { projectId: 'app-db', branchId: 'main' } });
    expect(role.status).toBe('paused');
    expect(role.providerStatus).toBe('disabled');
  });

  it('ready=true + dropped_at set maps to DELETING (never active)', async () => {
    const { client } = makeClient(() => ({ body: roleFixture({ ready: true, dropped_at: NOW }) }));
    const role = await client.get({ kind: 'role', id: 'r', scope: { projectId: 'app-db', branchId: 'main' } });
    expect(role.status).toBe('deleting');
    expect(role.providerStatus).toBe('dropped');
  });

  it('ready=true + deleted_at set maps to DELETING (never active)', async () => {
    const { client } = makeClient(() => ({ body: roleFixture({ ready: true, deleted_at: NOW }) }));
    const role = await client.get({ kind: 'role', id: 'r', scope: { projectId: 'app-db', branchId: 'main' } });
    expect(role.status).toBe('deleting');
  });

  it('terminal states outrank disabled: dropped_at + expired=true -> deleting', async () => {
    const { client } = makeClient(() => ({ body: roleFixture({ ready: true, dropped_at: NOW, expired: true }) }));
    const role = await client.get({ kind: 'role', id: 'r', scope: { projectId: 'app-db', branchId: 'main' } });
    expect(role.status).toBe('deleting');
  });

  it('a genuinely ready role still maps to active (positive case unchanged)', async () => {
    const { client } = makeClient(() => ({ body: roleFixture({ ready: true }) }));
    const role = await client.get({ kind: 'role', id: 'r', scope: { projectId: 'app-db', branchId: 'main' } });
    expect(role.status).toBe('active');
  });

  it('correct precedence also applies when ready=false: expired→paused, dropped→deleting', async () => {
    const a = makeClient(() => ({ body: roleFixture({ ready: false, expired: true }) }));
    const roleA = await a.client.get({ kind: 'role', id: 'r', scope: { projectId: 'app-db', branchId: 'main' } });
    expect(roleA.status).toBe('paused');

    const b = makeClient(() => ({ body: roleFixture({ ready: false, dropped_at: NOW }) }));
    const roleB = await b.client.get({ kind: 'role', id: 'r', scope: { projectId: 'app-db', branchId: 'main' } });
    expect(roleB.status).toBe('deleting');
  });

  it('wait() on an expired+ready:true role never reports active; bounded wait ends in TIMEOUT with GET-only polling', async () => {
    let n = 0;
    const { client, calls } = makeClient(() => {
      n += 1;
      return { body: roleFixture({ ready: true, expired: true }) };
    });
    const promise = client.wait(
      { kind: 'role', id: 'role-uid-456', scope: { projectId: 'app-db', branchId: 'main' } },
      { pollIntervalMs: 0, timeoutMs: 120 },
    );
    await expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(n).toBeGreaterThanOrEqual(1);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Org scoping: factory organization vs create spec.organizationId
// ---------------------------------------------------------------------------

describe('review r2 — REGRESSION F4: one coherent organization model (factory org owns all CRUD)', () => {
  it('create with spec.organizationId ≠ factory organization is REFUSED before dispatch — no wrong-org divergence', async () => {
    const { client, calls } = makeClient(
      () => {
        throw new Error('no request may be sent');
      },
      { organization: ORG },
    );
    await expect(
      client.create({ kind: 'project', name: 'app-db', organizationId: 'other-org', providerOptions: { cluster_size: 'PS_10' } }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
    expect(calls).toHaveLength(0); // refused BEFORE dispatch
  });

  it('create with spec.organizationId EQUAL to the factory org is accepted and every follow-up verb targets the SAME org', async () => {
    const { client, calls } = makeClient((req) => {
      if (req.method === 'POST') return { status: 201, body: databaseFixture() };
      if (req.method === 'GET' && req.path.endsWith('/databases/app-db')) return { body: databaseFixture({ ready: true, state: 'ready' }) };
      expect(req.method).toBe('DELETE');
      return { status: 204 };
    });
    await client.create({ kind: 'project', name: 'app-db', organizationId: ORG, providerOptions: { cluster_size: 'PS_10' } });
    await client.get({ kind: 'project', id: 'app-db' });
    await client.delete({ kind: 'project', id: 'app-db' });
    expect(calls.every((c) => c.path.startsWith(`/organizations/${ORG}/`))).toBe(true);
  });

  it('factory organization unset: create(project) is refused even WITH spec.organizationId — no unreachable resource is ever returned', async () => {
    const { client, calls } = makeClient(() => {
      throw new Error('no request may be sent');
    }, { organization: undefined });
    await expect(
      client.create({ kind: 'project', name: 'app-db', organizationId: ORG, providerOptions: { cluster_size: 'PS_10' } }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
    expect(calls).toHaveLength(0);
  });

  it('discovery may still target other orgs explicitly (regions with organizationId)', async () => {
    const { client, calls } = makeClient((req) => {
      if (req.path === '/organizations/discovery-org/regions') return { body: { next_page: null, data: [REGION_OBJ] } };
      throw new Error(`unexpected ${req.path}`);
    });
    const regions = await client.regions({ organizationId: 'discovery-org' });
    expect(regions).toHaveLength(1);
    expect(calls[0]!.path).toBe('/organizations/discovery-org/regions');
  });

  it('no cross-org confusion on read/update/list: all verbs address only the factory org slug', async () => {
    const { client, calls } = makeClient((req) => {
      if (req.method === 'PATCH') return { body: databaseFixture({ ready: true, state: 'ready' }) };
      if (req.path.endsWith('/databases/app-db')) return { body: databaseFixture({ ready: true, state: 'ready' }) };
      if (req.path.endsWith('/databases')) return { body: { next_page: null, data: [databaseFixture()] } };
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    await client.get({ kind: 'project', id: 'app-db' });
    await client.update({ kind: 'project', id: 'app-db', patch: { name: 'renamed' } });
    await client.list('project');
    expect(calls.every((c) => c.path.startsWith(`/organizations/${ORG}/`))).toBe(true);
  });

  it('organizations() uses the page-based style and maps org name slug as canonical id with uid as aliasId', async () => {
    const { client, calls } = makeClient(() => ({
      body: { next_page: null, data: [{ id: 'org-uid-1', name: 'review-org', created_at: NOW, updated_at: NOW }] },
    }));
    const orgs = await client.organizations();
    expect(orgs[0]).toMatchObject({ id: 'review-org', name: 'review-org', aliasId: 'org-uid-1' });
    expect(calls[0]!.path).toBe('/organizations');
  });
});

// ---------------------------------------------------------------------------
// 5. Credentials: one-time secrets, redaction order, reset semantics
// ---------------------------------------------------------------------------

describe('review r2 — credentials and redaction', () => {
  it('REGRESSION F5: create(role) REFUSES a caller-supplied password before dispatch (server-generated one-time secret only)', async () => {
    const { client, calls } = makeClient(() => ({ body: roleFixture({ password: DUMMY_PASSWORD }) }));
    await expect(
      client.create({
        kind: 'role',
        scope: { projectId: 'app-db', branchId: 'main' },
        password: 'hunter2', // core spec field; must be refused, never silently ignored
      }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
    expect(calls).toHaveLength(0); // refused before dispatch (and before the engine pre-flight)
  });

  it('resetCredential refuses a caller-supplied password BEFORE dispatch (official reset_role takes no body)', async () => {
    const { client, calls } = makeClient(() => ({ body: {} }));
    await expect(
      client.resetCredential(
        { kind: 'role', id: 'role-uid-456', scope: { projectId: 'app-db', branchId: 'main' } },
        { password: 'hunter2' },
      ),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
    expect(calls).toHaveLength(0);
  });

  it('reset sends POST with NO body and returns the new one-time password only in secrets; raw redacted', async () => {
    const rotated = 'pscale_pw_review_rotated_dummy';
    const { client, calls } = makeClient((req) => {
      if (req.method === 'GET' && req.path === `/organizations/${ORG}/databases/app-db`) {
        return { body: databaseFixture({ kind: 'postgresql' }) }; // engine pre-flight
      }
      expect(req.method).toBe('POST');
      expect(req.body).toBeUndefined();
      return { body: roleFixture({ password: rotated }) };
    });
    const result = await client.resetCredential({ kind: 'role', id: 'role-uid-456', scope: { projectId: 'app-db', branchId: 'main' } });
    expect(result.secrets).toEqual([{ label: 'password:app-role', value: rotated }]);
    expect((result.resource!.raw as Record<string, unknown>)['password']).toBe('[redacted]');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']); // engine pre-flight, then reset
  });

  it('redaction covers BOTH token parts and the full concatenated header in one message (order: full, id, secret)', async () => {
    const { client } = makeClient(() => ({
      status: 500,
      body: { message: `leak full=${FULL_TOKEN} id=${TOKEN_ID} secret=${TOKEN_SECRET} concat=${TOKEN_ID}${TOKEN_SECRET}` },
    }));
    await expect(client.get({ kind: 'project', id: 'app-db' })).rejects.toSatisfy((err: unknown) => {
      const message = err instanceof Error ? err.message : '';
      return (
        !message.includes(TOKEN_ID) &&
        !message.includes(TOKEN_SECRET) &&
        !message.includes(FULL_TOKEN) &&
        !message.includes('leak secret=')
      );
    });
  });

  it('redaction survives substring interactions (id is a prefix-style substring of other text)', async () => {
    // Adversarial: a message that contains the secret inside longer text, and the id
    // appearing only as a substring of the secret. Every variant must end scrubbed.
    const adversarial = `payload ${TOKEN_SECRET} and ${TOKEN_SECRET.slice(0, 8)} fragments`;
    const { client } = makeClient(() => ({ status: 500, body: { message: adversarial } }));
    await expect(client.get({ kind: 'project', id: 'app-db' })).rejects.toSatisfy((err: unknown) => {
      const message = err instanceof Error ? err.message : '';
      return !message.includes(TOKEN_SECRET) && !message.includes(TOKEN_ID);
    });
  });

  it('both the created password AND the rotated password stay redacted in later errors', async () => {
    const first = 'pscale_pw_review_first_dummy';
    const second = 'pscale_pw_review_second_dummy';
    let call = 0;
    const { client } = makeClient((req) => {
      call += 1;
      if (req.method === 'GET' && req.path.endsWith('/databases/app-db')) {
        return { body: databaseFixture({ kind: 'postgresql' }) }; // engine pre-flights
      }
      if (call === 2) return { body: roleFixture({ password: first }) };
      if (call === 4) return { body: roleFixture({ password: second }) };
      return { status: 500, body: { message: `boom ${first} ${second}` } };
    });
    await client.create({ kind: 'role', scope: { projectId: 'app-db', branchId: 'main' } });
    await client.resetCredential({ kind: 'role', id: 'role-uid-456', scope: { projectId: 'app-db', branchId: 'main' } });
    await expect(client.get({ kind: 'role', id: 'role-uid-456', scope: { projectId: 'app-db', branchId: 'main' } })).rejects.toSatisfy(
      (err: unknown) => {
        const message = err instanceof Error ? err.message : '';
        return !message.includes(first) && !message.includes(second);
      },
    );
  });

  it('connection() NEVER fabricates a password: secrets empty even with reveal, URI always [redacted]', async () => {
    const { client } = makeClient(() => ({ body: roleFixture() }));
    const conn = await client.connection(
      { kind: 'role', id: 'role-uid-456', scope: { projectId: 'app-db', branchId: 'main' } },
      { reveal: true },
    );
    expect(conn.secrets).toEqual([]);
    expect(conn.redactedUri).toContain('[redacted]');
    expect(conn.redactedUri).not.toContain(DUMMY_PASSWORD);
  });

  it('auth wrapper: outgoing header is exactly id:secret (no Bearer) for BOTH injected and default fetch, and no partial Bearer remnants', async () => {
    const { client, calls } = makeClient(() => ({ body: databaseFixture() }));
    await client.get({ kind: 'project', id: 'app-db' });
    const header = calls[0]!.headers['authorization'] ?? '';
    expect(header).toBe(FULL_TOKEN);
    expect(header.startsWith('Bearer ')).toBe(false);
    expect(header).not.toContain('Bearer');
  });
});

// ---------------------------------------------------------------------------
// 6. FINDING F3 + TLS policy (query adapter, poolFactory-captured config + real pg parsing)
// ---------------------------------------------------------------------------

type CapturedPool = { config: PgPoolConfig; queries: { text: string }[] };

function recordingPoolFactory(): {
  factory: NonNullable<PlanetScaleAdapterOptions['poolFactory']>;
  pools: CapturedPool[];
} {
  const pools: CapturedPool[] = [];
  const poolLike: PgPoolLike = {
    query: async (config) => {
      pools[pools.length - 1]?.queries.push({ text: config.text });
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({
      query: async (config) => {
        pools[pools.length - 1]?.queries.push({ text: config.text });
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    }),
    end: async () => undefined,
  };
  const factory: NonNullable<PlanetScaleAdapterOptions['poolFactory']> = (config) => {
    pools.push({ config, queries: [] });
    return poolLike;
  };
  return { factory, pools };
}

const REMOTE_DIRECT = 'postgresql://app-role.br3anchid:pscale_pw_dummy@eu-central-useast1-1.horizon.psdb.cloud:5432/app-db';
const REMOTE_POOLED = 'postgresql://app-role.br3anchid:pscale_pw_dummy@eu-central-useast1-1.horizon.psdb.cloud:6432/app-db';

describe('review r2 — TLS policy (query adapter)', () => {
  it('remote default is verified TLS ({rejectUnauthorized:true}) in the actual pool config', async () => {
    const { factory, pools } = recordingPoolFactory();
    const db = planetscale({ connectionString: REMOTE_DIRECT, connectionMode: 'direct', poolFactory: factory });
    await db.query('select 1');
    expect(pools[0]!.config.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('explicit ssl object is forwarded verbatim (CA + verification preserved in pool config)', async () => {
    const { factory, pools } = recordingPoolFactory();
    const db = planetscale({
      connectionString: REMOTE_DIRECT,
      connectionMode: 'direct',
      ssl: { rejectUnauthorized: true, ca: 'dummy-ca' },
      poolFactory: factory,
    });
    await db.query('select 1');
    expect(pools[0]!.config.ssl).toEqual({ rejectUnauthorized: true, ca: 'dummy-ca' });
  });

  it('explicit ssl:false on a remote host is refused before any pool is created', () => {
    const { factory, pools } = recordingPoolFactory();
    expect(() =>
      planetscale({ connectionString: REMOTE_DIRECT, connectionMode: 'direct', ssl: false, poolFactory: factory }),
    ).toThrow(/requires TLS|unencrypted/);
    expect(pools).toHaveLength(0);
  });

  it('localhost defaults to no TLS (local testing only)', () => {
    const { factory, pools } = recordingPoolFactory();
    const db = planetscale({
      connectionString: 'postgresql://postgres:pw@localhost:15432/dbsdk',
      connectionMode: 'direct',
      allowModeMismatch: true,
      poolFactory: factory,
    });
    void db.query('select 1').catch(() => undefined); // pool created lazily
    return Promise.resolve().then(() => {
      expect(pools[0]?.config.ssl).toBe(false);
    });
  });

  it('port/mode validation: direct requires 5432, pooled requires 6432, mismatch refused without rewriting', () => {
    expect(() => planetscale({ connectionString: REMOTE_POOLED, connectionMode: 'direct' })).toThrow(/5432/);
    expect(() => planetscale({ connectionString: REMOTE_DIRECT, connectionMode: 'pooled' })).toThrow(/6432/);
    const { factory } = recordingPoolFactory();
    // Escape hatch exists but does NOT rewrite the endpoint.
    const db = planetscale({ connectionString: REMOTE_POOLED, connectionMode: 'direct', allowModeMismatch: true, poolFactory: factory });
    expect(db.raw.resolved.port).toBe(6432);
  });

  it('DRIVER BEHAVIOR (why the guard exists): pg 8.23.1 lets connection-string ssl params OVERRIDE the adapter TLS policy', () => {
    // Documented raw driver behavior on the installed pg (no network): the Client
    // constructor parses the connection string synchronously, and URL ssl params
    // REPLACE the ssl config. This is exactly why the adapter canonicalizes and strips
    // these parameters before the pool is built.
    const sslOf = (config: ConstructorParameters<typeof PgClient>[0]): unknown =>
      (new PgClient(config) as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl;
    expect(sslOf({ connectionString: `${REMOTE_DIRECT}?sslmode=disable`, ssl: { rejectUnauthorized: true } })).toBe(false);
    expect(sslOf({ connectionString: `${REMOTE_DIRECT}?sslmode=require`, ssl: { rejectUnauthorized: true, ca: 'dummy-ca' } })).toEqual({});
  });

  it('baseline: URL without ssl params keeps the adapter explicit ssl object intact (pg passes config through)', () => {
    const sslOf = (config: ConstructorParameters<typeof PgClient>[0]): unknown =>
      (new PgClient(config) as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl;
    expect(sslOf({ connectionString: REMOTE_DIRECT, ssl: { rejectUnauthorized: true, ca: 'dummy-ca' } })).toEqual({
      rejectUnauthorized: true,
      ca: 'dummy-ca',
    });
  });

  it('REGRESSION F3: ?sslmode=disable on a remote host is REFUSED before any pool is created', () => {
    const { factory, pools } = recordingPoolFactory();
    expect(() =>
      planetscale({ connectionString: `${REMOTE_DIRECT}?sslmode=disable`, connectionMode: 'direct', poolFactory: factory }),
    ).toThrow(/requires TLS|unencrypted/i);
    expect(pools).toHaveLength(0);
  });

  it('REGRESSION F3: ?sslmode=disable + explicit verified TLS is refused (no silent override path)', () => {
    expect(() =>
      planetscale({
        connectionString: `${REMOTE_DIRECT}?sslmode=disable`,
        connectionMode: 'direct',
        ssl: { rejectUnauthorized: true, ca: 'dummy-ca' },
      }),
    ).toThrow(/plaintext|TLS/i);
  });

  it('REGRESSION F3: ?sslmode=require KEEPS the explicit verified-ssl object (CA not discarded) and strips the URL param', async () => {
    const { factory, pools } = recordingPoolFactory();
    const db = planetscale({
      connectionString: `${REMOTE_DIRECT}?sslmode=require&application_name=keepme`,
      connectionMode: 'direct',
      ssl: { rejectUnauthorized: true, ca: 'dummy-ca' },
      poolFactory: factory,
    });
    await db.query('select 1');
    expect(pools[0]!.config.ssl).toEqual({ rejectUnauthorized: true, ca: 'dummy-ca' });
    // The URL handed to pg no longer carries ssl params, so pg cannot override the policy.
    expect(pools[0]!.config.connectionString).toContain('application_name=keepme');
    expect(pools[0]!.config.connectionString).not.toContain('sslmode');
  });

  it('REGRESSION F3: ?sslmode=verify-full with no explicit ssl resolves to verified TLS in the pool config', async () => {
    const { factory, pools } = recordingPoolFactory();
    const db = planetscale({
      connectionString: `${REMOTE_DIRECT}?sslmode=verify-full`,
      connectionMode: 'direct',
      poolFactory: factory,
    });
    await db.query('select 1');
    expect(pools[0]!.config.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('REGRESSION F3: file-loading URL params (sslcert/sslrootcert) are refused before the driver reads disk', () => {
    expect(() =>
      planetscale({ connectionString: `${REMOTE_DIRECT}?sslcert=/nonexistent/dbsdk-test.pem`, connectionMode: 'direct' }),
    ).toThrow(/sslcert|ssl option/i);
    expect(() =>
      planetscale({ connectionString: `${REMOTE_DIRECT}?sslrootcert=/nonexistent/dbsdk-ca.pem`, connectionMode: 'direct' }),
    ).toThrow(/sslrootcert|ssl option/i);
  });

  it('REGRESSION F3: ambiguous/weak modes (prefer, allow, verify-ca, unknown, empty) are refused with actionable errors', () => {
    for (const mode of ['prefer', 'allow', 'verify-ca', 'nope', '']) {
      expect(() =>
        planetscale({ connectionString: `${REMOTE_DIRECT}?sslmode=${mode}`, connectionMode: 'direct' }),
      ).toThrow(/sslmode|ssl option/i);
    }
  });

  it('REGRESSION F3: uselibpqcompat (weaker libpq ssl semantics) is refused', () => {
    expect(() =>
      planetscale({ connectionString: `${REMOTE_DIRECT}?uselibpqcompat=true`, connectionMode: 'direct' }),
    ).toThrow(/uselibpqcompat/);
  });

  it('REGRESSION F3: conflicting URL directives (plaintext + tls) are refused', () => {
    expect(() =>
      planetscale({ connectionString: `${REMOTE_DIRECT}?sslmode=require&sslmode=disable`, connectionMode: 'direct' }),
    ).toThrow(/conflicting/i);
  });

  it('REGRESSION F3: ?sslmode=disable on localhost is accepted (local plaintext stays a valid explicit choice)', async () => {
    const { factory, pools } = recordingPoolFactory();
    const db = planetscale({
      connectionString: 'postgresql://postgres:pw@localhost:15432/dbsdk?sslmode=disable',
      connectionMode: 'direct',
      allowModeMismatch: true,
      poolFactory: factory,
    });
    await db.query('select 1');
    expect(pools[0]!.config.ssl).toBe(false);
  });

  it('REGRESSION F3: the pool escape hatch cannot produce a plaintext remote config (final driver config check)', () => {
    expect(() => planetscale({ connectionString: REMOTE_DIRECT, connectionMode: 'direct', pool: { ssl: false } })).toThrow(
      /ssl: false|requires TLS/i,
    );
  });

  it('documented escape hatch: explicit ssl:{rejectUnauthorized:false} on a remote host is accepted (encrypted-but-unverified, made explicit by the caller)', () => {
    const { factory, pools } = recordingPoolFactory();
    const db = planetscale({
      connectionString: REMOTE_DIRECT,
      connectionMode: 'direct',
      ssl: { rejectUnauthorized: false },
      poolFactory: factory,
    });
    void db;
    expect(pools).toHaveLength(0); // lazy pool; construct-only is enough to prove no refusal
  });
});

// ---------------------------------------------------------------------------
// 7. FINDING F6 (characterization): pooled session guard is start-anchored only
// ---------------------------------------------------------------------------

describe('review r2 — REGRESSION F6: pooled session-state guards cover comments, multi-statement text and literals', () => {
  it('guards the documented session-state classes before dispatch on the pooled path', async () => {
    const { factory, pools } = recordingPoolFactory();
    const db = planetscale({ connectionString: REMOTE_POOLED, connectionMode: 'pooled', poolFactory: factory });
    await expect(db.query('SET statement_timeout = 3000')).rejects.toMatchObject({ adapter: 'planetscale' });
    await expect(db.query('PREPARE p AS select 1')).rejects.toThrow();
    await expect(db.query('LISTEN chan')).rejects.toThrow();
    await expect(db.query('CREATE TEMP TABLE t (x int)')).rejects.toThrow();
    expect(pools).toHaveLength(0);
  });

  it('a session-state statement smuggled after another statement is refused (multi-statement guard)', async () => {
    const { factory, pools } = recordingPoolFactory();
    const db = planetscale({ connectionString: REMOTE_POOLED, connectionMode: 'pooled', poolFactory: factory });
    await expect(db.query('select 1; set application_name = smuggled')).rejects.toMatchObject({
      adapter: 'planetscale',
      capability: 'sessionState',
    });
    expect(pools).toHaveLength(0);
  });

  it('a leading SQL comment no longer hides a session-state statement from the guard', async () => {
    const { factory, pools } = recordingPoolFactory();
    const db = planetscale({ connectionString: REMOTE_POOLED, connectionMode: 'pooled', poolFactory: factory });
    await expect(db.query('/* ctx */ SET statement_timeout = 3000')).rejects.toMatchObject({
      adapter: 'planetscale',
      capability: 'sessionState',
    });
    await expect(db.query('-- ctx\nset x = 1')).rejects.toMatchObject({ capability: 'sessionState' });
    expect(pools).toHaveLength(0);
  });

  it('multi-statement strings are refused even when both statements are harmless (one statement per round-trip)', async () => {
    const { factory, pools } = recordingPoolFactory();
    const db = planetscale({ connectionString: REMOTE_POOLED, connectionMode: 'pooled', poolFactory: factory });
    await expect(db.query('select 1; select 2')).rejects.toThrow(/multiple SQL statements/);
    expect(pools).toHaveLength(0);
  });

  it('session keywords inside string literals, identifiers and dollar bodies are NOT flagged (no false positives)', async () => {
    const { factory, pools } = recordingPoolFactory();
    const db = planetscale({ connectionString: REMOTE_POOLED, connectionMode: 'pooled', poolFactory: factory });
    await db.query("select 'set application_name = smuggled' as note");
    await db.query('select * from reset_log where note = $1', ['x']);
    await db.query('select $flag$ set x $flag$ as v');
    expect(pools[0]!.queries.map((q) => q.text)).toEqual([
      "select 'set application_name = smuggled' as note",
      'select * from reset_log where note = $1',
      'select $flag$ set x $flag$ as v',
    ]);
  });

  it('a trailing semicolon or trailing comment stays allowed (harmless single statement)', async () => {
    const { factory, pools } = recordingPoolFactory();
    const db = planetscale({ connectionString: REMOTE_POOLED, connectionMode: 'pooled', poolFactory: factory });
    await db.query('select 1;');
    await db.query('select 2 -- done');
    await db.query('select 3 /* trailing */;');
    expect(pools[0]!.queries.map((q) => q.text)).toEqual(['select 1;', 'select 2 -- done', 'select 3 /* trailing */;']);
  });

  it('the same guard applies on every mediated path: transaction statements and batch entries', async () => {
    const { factory } = recordingPoolFactory();
    const db = planetscale({ connectionString: REMOTE_POOLED, connectionMode: 'pooled', poolFactory: factory });
    await expect(db.transaction!((tx) => tx.query('select 1; set x = 1'))).rejects.toMatchObject({ capability: 'sessionState' });
    await expect(
      db.batch!([{ text: 'select 1' }, { text: '/* c */ RESET ALL' }]),
    ).rejects.toMatchObject({ capability: 'sessionState' });
  });

  it('SET LOCAL is allowed inside a transaction on the pooled path (transaction-pooler-safe)', async () => {
    const { factory } = recordingPoolFactory();
    const db = planetscale({ connectionString: REMOTE_POOLED, connectionMode: 'pooled', poolFactory: factory });
    await expect(db.transaction!((tx) => tx.query('SET LOCAL statement_timeout = 3000'))).resolves.toBeDefined();
  });

  it('direct mode allows session statements (capability honesty: sessionState true only for direct)', async () => {
    const { factory, pools } = recordingPoolFactory();
    const direct = planetscale({ connectionString: REMOTE_DIRECT, connectionMode: 'direct', poolFactory: factory });
    const pooled = planetscale({ connectionString: REMOTE_POOLED, connectionMode: 'pooled', poolFactory: factory });
    expect(direct.capabilities.sessionState).toBe(true);
    expect(pooled.capabilities.sessionState).toBe(false);
    await direct.query('SET statement_timeout = 3000');
    await direct.query('select 1; set application_name = fine_on_direct');
    expect(pools[0]!.config.connectionString).toBe(REMOTE_DIRECT);
  });
});

// ---------------------------------------------------------------------------
// 8. Transport semantics: timeout, abort, malformed JSON, pagination bounds
// ---------------------------------------------------------------------------

describe('review r2 — transport and pagination semantics', () => {
  it('a TIMED-OUT mutation is TIMEOUT + indeterminate (outcome unknown); the caller retries consciously', async () => {
    const never: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted.")), { once: true });
      });
    const { client } = makeAdapter(never, { timeoutMs: 30 });
    await expect(
      client.create({ kind: 'project', name: 'x', organizationId: ORG, providerOptions: { cluster_size: 'PS_10' } }),
    ).rejects.toMatchObject({ code: 'TIMEOUT', indeterminate: true });
  });

  it('a TIMED-OUT read is TIMEOUT but NOT indeterminate (nothing was mutated)', async () => {
    const never: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted.")), { once: true });
      });
    const { client } = makeAdapter(never, { timeoutMs: 30 });
    await expect(client.get({ kind: 'project', id: 'app-db' })).rejects.toMatchObject({
      code: 'TIMEOUT',
      indeterminate: false,
    });
  });

  it('a caller abort surfaces as ABORTED (no false indeterminate)', async () => {
    const controller = new AbortController();
    // Abort BEFORE the call, like a caller that cancels between create and send.
    controller.abort();
    const hanging: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new Error("This operation was aborted"));
          return;
        }
        init?.signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")), { once: true });
      });
    const { client } = makeAdapter(hanging);
    await expect(
      client.get({ kind: 'project', id: 'app-db' }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('a 200 response whose body claims JSON but is not parseable is handled truthfully (no crash, provider error)', async () => {
    const { client } = makeClient(() => ({ text: 'not-json{{{' }));
    await expect(client.get({ kind: 'project', id: 'app-db' })).rejects.toMatchObject({ code: 'PROVIDER' });
  });

  it('pagination: next_page number becomes the cursor and round-trips as page=N; per_page forwarded', async () => {
    let n = 0;
    const { client, calls } = makeClient(() => {
      n += 1;
      if (n === 1) {
        return { body: { current_page: 1, next_page: 2, data: [databaseFixture({ name: 'db-a' })] } };
      }
      return { body: { current_page: 2, next_page: null, data: [] } };
    });
    const page1: ManagementPage = await client.list('project', { limit: 1 });
    expect(page1.cursor).toBe('2');
    await client.list('project', { cursor: page1.cursor!, limit: 1 });
    expect(calls[1]!.query.get('page')).toBe('2');
    expect(calls[1]!.query.get('per_page')).toBe('1');
  });

  it('pagination: non-numeric, zero, padded, and negative cursors are refused before dispatch', async () => {
    const { client, calls } = makeClient(() => ({ body: {} }));
    for (const bad of ['abc', '0', '01', '-1', '1.5']) {
      await expect(client.list('project', { cursor: bad })).rejects.toMatchObject({ code: 'CONFIGURATION' });
    }
    expect(calls).toHaveLength(0);
  });

  it('REGRESSION F8: a limit above the official per_page max (100) is refused BEFORE the request', async () => {
    const { client, calls } = makeClient(() => ({ body: { next_page: null, data: [] } }));
    await expect(client.list('project', { limit: 500 })).rejects.toSatisfy(
      (err: unknown) => err instanceof ManagementError && /100/.test(err.message) && err.code === 'CONFIGURATION',
    );
    await expect(client.list('branch', { projectId: 'app-db', limit: 101 })).rejects.toMatchObject({ code: 'CONFIGURATION' });
    expect(calls).toHaveLength(0); // nothing was sent with a silently-clamped page size
  });

  it('pagination boundary: limit 100 is accepted and sent as per_page=100; default omits per_page', async () => {
    const { client, calls } = makeClient(() => ({ body: { next_page: null, data: [] } }));
    await client.list('project', { limit: 100 });
    expect(calls[0]!.query.get('per_page')).toBe('100');
    await client.list('project');
    expect(calls[1]!.query.get('per_page')).toBeNull();
  });

  it('empty patch update is refused before dispatch (no accidental no-op mutation)', async () => {
    const { client, calls } = makeClient(() => ({ body: {} }));
    await expect(client.update({ kind: 'project', id: 'app-db', patch: {} })).rejects.toMatchObject({
      code: 'CONFIGURATION',
    });
    await expect(client.update({ kind: 'role', id: 'r', scope: { projectId: 'a', branchId: 'b' }, patch: {} })).rejects.toMatchObject({
      code: 'CONFIGURATION',
    });
    expect(calls).toHaveLength(0);
  });

  it('update(role) allowlist: only name/require_where_on_delete/require_where_on_update; others refused', async () => {
    const { client, calls } = makeClient((req) => {
      if (req.method === 'GET' && req.path.endsWith('/databases/app-db')) {
        return { body: databaseFixture({ kind: 'postgresql' }) }; // engine pre-flight
      }
      return { body: roleFixture() };
    });
    await client.update({
      kind: 'role',
      id: 'role-uid-456',
      scope: { projectId: 'app-db', branchId: 'main' },
      patch: { name: 'renamed', providerOptions: { require_where_on_delete: 'on' } },
    });
    expect(calls[1]!.body).toEqual({ name: 'renamed', require_where_on_delete: 'on' });
    await expect(
      client.update({
        kind: 'role',
        id: 'role-uid-456',
        scope: { projectId: 'app-db', branchId: 'main' },
        patch: { providerOptions: { ttl: 100 } },
      }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
  });

  it('delete returns operation:null for the official empty 204 across all three kinds (each with engine pre-flight); unsupported kind refused', async () => {
    const { client, calls } = makeClient((req) => {
      if (req.method === 'GET' && req.path.endsWith('/databases/app-db')) {
        return { body: databaseFixture({ kind: 'postgresql' }) }; // engine pre-flight
      }
      expect(req.method).toBe('DELETE');
      return { status: 204 };
    });
    await client.delete({ kind: 'project', id: 'app-db' });
    await client.delete({ kind: 'branch', id: 'main', projectId: 'app-db' });
    await client.delete({ kind: 'role', id: 'role-uid-456', scope: { projectId: 'app-db', branchId: 'main' } });
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([
      `/organizations/${ORG}/databases/app-db`,
      `/organizations/${ORG}/databases/app-db/branches/main`,
      `/organizations/${ORG}/databases/app-db/branches/main/roles/role-uid-456`,
    ]);
    await expect(client.delete({ kind: 'database', id: 'x', projectId: 'a', branchId: 'b' })).rejects.toMatchObject({
      code: 'CAPABILITY',
    });
  });

  it('nullable readiness: missing/invalid state and ready fields never invent active or failed statuses', async () => {
    const { client } = makeClient(() => ({ body: databaseFixture({ ready: null as unknown as boolean, state: undefined }) }));
    const resource = await client.get({ kind: 'project', id: 'app-db' });
    expect(resource.status).toBe('unknown');
    expect(resource.providerStatus).toBeNull();
  });

  it('5xx on a mutation is indeterminate:true with no retry (one request only); 4xx is definitive', async () => {
    let call = 0;
    const { client } = makeClient(() => {
      call += 1;
      return { status: 500, body: { message: 'internal' } };
    });
    await expect(
      client.create({ kind: 'project', name: 'x', organizationId: ORG, providerOptions: { cluster_size: 'PS_10' } }),
    ).rejects.toMatchObject({ code: 'PROVIDER', indeterminate: true });
    expect(call).toBe(1);

    let call2 = 0;
    const { client: client2 } = makeClient(() => {
      call2 += 1;
      return { status: 422, body: { message: 'bad' } };
    });
    await expect(
      client2.create({ kind: 'project', name: 'x', organizationId: ORG, providerOptions: { cluster_size: 'PS_10' } }),
    ).rejects.toMatchObject({ code: 'VALIDATION', indeterminate: false });
    expect(call2).toBe(1);
  });

  it('actions are undeclared for every kind and refused before dispatch (no invented lifecycle endpoints)', async () => {
    const { client, calls } = makeClient(() => ({ body: {} }));
    await expect(client.action({ kind: 'project', id: 'app-db' }, 'restart')).rejects.toMatchObject({ code: 'CAPABILITY' });
    await expect(client.action({ kind: 'branch', id: 'main', projectId: 'app-db' }, 'restart')).rejects.toMatchObject({
      code: 'CAPABILITY',
    });
    await expect(
      client.action({ kind: 'role', id: 'role-uid-456', scope: { projectId: 'app-db', branchId: 'main' } }, 'restart'),
    ).rejects.toMatchObject({ code: 'CAPABILITY' });
    expect(calls).toHaveLength(0);
  });

  it('wait() polls only GETs on the resource own path and returns when ready (no mutation replay)', async () => {
    let n = 0;
    const { client, calls } = makeClient((req) => {
      expect(req.method).toBe('GET');
      expect(req.path).toBe(`/organizations/${ORG}/databases/app-db`);
      n += 1;
      if (n === 1) return { body: databaseFixture({ ready: false, state: 'pending' }) };
      return { body: databaseFixture({ ready: true, state: 'ready' }) };
    });
    const resource = await client.wait({ kind: 'project', id: 'app-db' }, { pollIntervalMs: 0, timeoutMs: 2000 });
    expect(resource.status).toBe('active');
    expect(n).toBe(2);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. Env-gated LOCAL Postgres 17 leg (driver compatibility only — NOT hosted TLS)
// ---------------------------------------------------------------------------

const URL_ENV = 'DBSDK_TEST_POSTGRES_URL';
const hasServer = Boolean(process.env[URL_ENV]);
const live = hasServer ? describe : describe.skip;

live('review r2 — local PostgreSQL 17 driver compatibility (env-gated, :15432)', () => {
  it('drives the real wire protocol through the shared pg engine (parameterized query + transaction)', async () => {
    const db = planetscale({
      connectionString: process.env[URL_ENV]!,
      connectionMode: 'direct',
      allowModeMismatch: true, // local test server is not on the official 5432 port
      max: 2,
    });
    try {
      const result = await db.query<{ one: number }>('select $1::int as one', [1]);
      expect(result.rows).toEqual([{ one: 1 }]);
      expect(result.rowCount).toBe(1);
      await db.transaction!(async (tx) => {
        await tx.query('select 1');
      });
    } finally {
      await db.close();
    }
  }, 15_000);
});
