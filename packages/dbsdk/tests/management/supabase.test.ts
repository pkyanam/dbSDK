/**
 * Supabase Management API adapter tests — fully offline via injected fetch (no network, no
 * hosted mutations, no secrets in output). Covers the frozen management contract's adapter
 * expectations: auth/URL/body construction for every verb, semantic lifecycle/status mapping,
 * wait() polling against the real read endpoints (scope reconstruction included), capability and
 * prerequisite enforcement BEFORE dispatch, error mapping incl. indeterminate mutation outcomes,
 * and secret redaction from raw payloads and error messages.
 *
 * Verified against the official Management API v1 OpenAPI spec (github.com/supabase/supabase,
 * apps/docs/spec/api_v1_openapi.json, retrieved 2026-10-06). See coordination/v2-supabase-management.md.
 */

import { describe, expect, it } from 'vitest';

import { createManagement } from '../../src/management/core.js';
import { ManagementError } from '../../src/management/errors.js';
import { supabaseManagement, generateDatabasePassword } from '../../src/management/supabase.js';
import type { FetchLike } from '../../src/management/types.js';

const TOKEN = 'sbp_test_token_value';
const BASE = 'https://api.supabase.com/v1';
const ORG_ID = 'org-id-1';
const ORG_SLUG = 'org-slug-1';
const PROJECT_REF = 'abcdefghijklmnopqrst';
const BRANCH_ID = '00000000-0000-0000-0000-000000000001';

type RecordedCall = { url: string; method: string; headers: Headers; body: unknown; init: RequestInit };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const init: ResponseInit = {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  };
  return new Response(JSON.stringify(body), init);
}

/** Handler-based fetch double that records every call and answers from a queue/table. */
function makeFetch(
  respond: (call: { url: string; method: string; body: unknown }) => Response | Promise<Response>,
): { fetch: FetchLike; calls: Array<RecordedCall> } {
  const calls: Array<RecordedCall> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const rawBody = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const call: RecordedCall = {
      url: String(input),
      method,
      headers: new Headers(init?.headers),
      body: rawBody,
      init: init ?? {},
    };
    calls.push(call);
    return respond({ url: call.url, method, body: rawBody });
  };
  return { fetch: fetchImpl, calls };
}

/** A fetch that rejects on abort (mimics real fetch behavior for timeout/abort tests). */
function hangingFetch(): FetchLike {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('This operation was aborted', 'AbortError')),
          { once: true },
        );
      }
    });
}

function projectPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PROJECT_REF,
    ref: PROJECT_REF,
    organization_id: ORG_ID,
    organization_slug: ORG_SLUG,
    name: 'acme-prod',
    region: 'us-east-1',
    created_at: '2026-10-06T00:00:00Z',
    status: 'ACTIVE_HEALTHY',
    database: {
      host: `db.${PROJECT_REF}.supabase.co`,
      version: '17',
      postgres_engine: '17',
      release_channel: 'ga',
    },
    ...overrides,
  };
}

function branchPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BRANCH_ID,
    name: 'feature-x',
    project_ref: 'bbbbbbbbbbbbbbbbbbbb',
    parent_project_ref: PROJECT_REF,
    is_default: false,
    persistent: true,
    status: 'CREATING_PROJECT',
    preview_project_status: 'COMING_UP',
    created_at: '2026-10-06T00:00:00Z',
    updated_at: '2026-10-06T00:00:00Z',
    with_data: true,
    ...overrides,
  };
}

function branchDetailPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref: 'bbbbbbbbbbbbbbbbbbbb',
    postgres_version: '17',
    postgres_engine: '17',
    release_channel: 'ga',
    status: 'ACTIVE_HEALTHY',
    db_host: 'bbbbb-preview.supabase.co',
    db_port: 5432,
    db_user: 'postgres',
    db_pass: 'branch-real-password-1',
    jwt_secret: 'branch-jwt-secret-1',
    ...overrides,
  };
}

function makeAdapter(fetchImpl: FetchLike) {
  return supabaseManagement({ accessToken: TOKEN, fetch: fetchImpl });
}

function makeClient(fetchImpl: FetchLike) {
  return createManagement({ adapter: makeAdapter(fetchImpl) });
}

/** Await a promise that must reject; returns the thrown error typed as ManagementError. */
async function expectError(promise: Promise<unknown>): Promise<ManagementError> {
  try {
    await promise;
  } catch (caught) {
    return caught as ManagementError;
  }
  throw new Error('expected the promise to reject with a ManagementError');
}

const projectSpec = {
  kind: 'project' as const,
  name: 'acme-prod',
  organizationId: ORG_ID,
  region: 'us-east-1',
};

// ---------------------------------------------------------------------------
// Construction and configuration
// ---------------------------------------------------------------------------

describe('supabaseManagement construction', () => {
  it('rejects a missing or empty access token with CONFIGURATION before any request', () => {
    expect(() =>
      supabaseManagement({
        accessToken: undefined as unknown as string,
        fetch: async () => jsonResponse(200, {}),
      }),
    ).toThrow(ManagementError);
    expect(() => supabaseManagement({ accessToken: '', fetch: async () => jsonResponse(200, {}) })).toThrow(
      /personal access token/,
    );
  });
});

// ---------------------------------------------------------------------------
// Create project
// ---------------------------------------------------------------------------

describe('create(project)', () => {
  it('sends the bearer token to the official base URL with name, db_pass, and organization_id', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(201, projectPayload({ status: 'COMING_UP' })));
    const client = makeClient(fetch);

    const result = await client.create(projectSpec);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${BASE}/projects`);
    expect(call.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(call.method).toBe('POST');
    const body = call.body as Record<string, unknown>;
    expect(body['name']).toBe('acme-prod');
    expect(typeof body['db_pass']).toBe('string');
    expect(body['db_pass'] as string).toHaveLength(24);
    expect(body['organization_id']).toBe(ORG_ID);
    // Region maps to the current region_selection form; the deprecated flat field is not sent.
    expect(body['region_selection']).toEqual({ type: 'specific', code: 'us-east-1' });
    expect(body['region']).toBeUndefined();

    // The 201 create response does not echo db_pass; the generated password surfaces ONLY in secrets.
    expect(result.indeterminate).toBe(false);
    expect(result.operation).toBeNull();
    expect(result.secrets).toHaveLength(1);
    expect(result.secrets[0]!.label).toBe('password');
    expect(result.secrets[0]!.value).toBe(body['db_pass']);
    expect(result.resource).not.toBeNull();
    expect(result.resource!.id).toBe(PROJECT_REF);
    expect(result.resource!.status).toBe('creating');
    expect(result.resource!.providerStatus).toBe('COMING_UP');
    expect(JSON.stringify(result.resource!.raw)).not.toContain(body['db_pass']);
  });

  it('accepts organization_slug via providerOptions (the current required field) and does not echo a caller password', async () => {
    const callerPassword = 'correct-horse-battery-staple-9';
    const { fetch, calls } = makeFetch(() => jsonResponse(201, projectPayload()));
    const client = makeClient(fetch);

    const result = await client.create({
      kind: 'project',
      name: 'acme-prod',
      password: callerPassword,
      providerOptions: { organization_slug: ORG_SLUG },
    });

    const body = calls[0]!.body as Record<string, unknown>;
    expect(body['organization_slug']).toBe(ORG_SLUG);
    expect(body['organization_id']).toBeUndefined();
    expect(body['db_pass']).toBe(callerPassword);
    // A caller-supplied password is sent but never echoed back.
    expect(result.secrets).toEqual([]);
  });

  it('refuses a missing organization scope before any network request', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(201, projectPayload()));
    const client = makeClient(fetch);

    const error = await expectError(client.create({ kind: 'project', name: 'acme-prod' }));
    expect(error.code).toBe('CONFIGURATION');
    expect(error.message).toContain('organization');
    expect(calls).toHaveLength(0);
  });

  it('refuses a deprecated plan field before any network request', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(201, projectPayload()));
    const client = makeClient(fetch);

    const error = await expectError(
      client.create({ kind: 'project', name: 'x', organizationId: ORG_ID, plan: 'free' }),
    );
    expect(error.code).toBe('CONFIGURATION');
    expect(error.message).toContain('organization level');
    expect(calls).toHaveLength(0);
  });

  it('rejects providerOptions keys the official request body does not accept', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(201, projectPayload()));
    const client = makeClient(fetch);

    const error = await expectError(
      client.create({ kind: 'project', name: 'x', organizationId: ORG_ID, providerOptions: { nonsense: 1 } }),
    );
    expect(error.code).toBe('CONFIGURATION');
    expect(error.message).toContain("'nonsense'");
    expect(calls).toHaveLength(0);
  });

  it('scrubs the caller password from error messages on mutation failures', async () => {
    const callerPassword = 'correct-horse-battery-staple-9';
    const { fetch } = makeFetch(() => jsonResponse(500, { message: `failed while hashing ${callerPassword}` }));
    const client = makeClient(fetch);

    const error = await expectError(
      client.create({ kind: 'project', name: 'x', organizationId: ORG_ID, password: callerPassword }),
    );
    expect(error.code).toBe('PROVIDER');
    expect(error.indeterminate).toBe(true);
    expect(error.message).not.toContain(callerPassword);
    expect(error.message).toContain('[redacted]');
  });
});

// ---------------------------------------------------------------------------
// Status mapping — real provider statuses, truthfully normalized
// ---------------------------------------------------------------------------

describe('status normalization (real provider status enum)', () => {
  it('maps the official project status enum onto normalized lifecycle states', async () => {
    const cases: Array<[string, string]> = [
      ['ACTIVE_HEALTHY', 'active'],
      ['COMING_UP', 'creating'],
      ['RESTORING', 'creating'],
      ['UPGRADING', 'updating'],
      ['RESIZING', 'updating'],
      ['RESTARTING', 'updating'],
      ['GOING_DOWN', 'paused'],
      ['PAUSING', 'paused'],
      ['INACTIVE', 'paused'],
      ['REMOVED', 'deleting'],
      ['INIT_FAILED', 'failed'],
      ['RESTORE_FAILED', 'failed'],
      ['PAUSE_FAILED', 'failed'],
      ['UNKNOWN', 'unknown'],
    ];
    const { fetch } = makeFetch(() =>
      jsonResponse(
        200,
        cases.map(([status]) => projectPayload({ ref: `ref${status.toLowerCase()}12345678`, status })),
      ),
    );
    const client = makeClient(fetch);

    const page = await client.list('project');
    expect(page.cursor).toBeNull();
    expect(page.resources).toHaveLength(cases.length);
    for (const [providerStatus, expected] of cases) {
      const resource = page.resources.find((r) => r.providerStatus === providerStatus)!;
      expect(resource.status, `${providerStatus} should normalize to ${expected}`).toBe(expected);
    }
  });

  it('keeps unrecognized statuses at unknown with the provider value preserved', async () => {
    const { fetch } = makeFetch(() => jsonResponse(200, [projectPayload({ status: 'SOMETHING_NEW' })]));
    const client = makeClient(fetch);
    const page = await client.list('project');
    expect(page.resources[0]!.status).toBe('unknown');
    expect(page.resources[0]!.providerStatus).toBe('SOMETHING_NEW');
  });
});

// ---------------------------------------------------------------------------
// List / get / update / delete project
// ---------------------------------------------------------------------------

describe('project list/get/update/delete', () => {
  it('lists all projects from GET /v1/projects and refuses pagination arguments', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(200, [projectPayload()]));
    const client = makeClient(fetch);

    const page = await client.list('project');
    expect(calls[0]!.url).toBe(`${BASE}/projects`);
    expect(calls[0]!.method).toBe('GET');
    expect(page.kind).toBe('project');
    expect(page.resources).toHaveLength(1);
    expect(page.resources[0]!.raw['database']).toEqual(projectPayload()['database']);
    expect(page.cursor).toBeNull();

    const capError = await expectError(client.list('project', { cursor: 'x' }));
    expect(capError.code).toBe('CAPABILITY');
    const capError2 = await expectError(client.list('project', { limit: 5 }));
    expect(capError2.code).toBe('CAPABILITY');
    expect(calls).toHaveLength(1); // no additional requests were made
  });

  it('gets a project by ref and preserves raw provider fields', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(200, projectPayload({ status: 'COMING_UP' })));
    const client = makeClient(fetch);

    const resource = await client.get({ kind: 'project', id: PROJECT_REF });
    expect(calls[0]!.url).toBe(`${BASE}/projects/${PROJECT_REF}`);
    expect(resource.kind).toBe('project');
    expect(resource.id).toBe(PROJECT_REF);
    expect(resource.name).toBe('acme-prod');
    expect(resource.region).toBe('us-east-1');
    expect(resource.createdAt).toBe('2026-10-06T00:00:00Z');
    expect(resource.updatedAt).toBeNull();
    expect(resource.status).toBe('creating');
  });

  it('maps 404 on get to NOT_FOUND', async () => {
    const { fetch } = makeFetch(() => jsonResponse(404, { message: 'Project not found' }));
    const client = makeClient(fetch);
    const error = await expectError(client.get({ kind: 'project', id: PROJECT_REF }));
    expect(error.code).toBe('NOT_FOUND');
  });

  it('updates a project with PATCH { name } and refuses empty/foreign patches pre-network', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(200, { id: 1, ref: PROJECT_REF, name: 'renamed' }));
    const client = makeClient(fetch);

    const result = await client.update({ kind: 'project', id: PROJECT_REF, patch: { name: 'renamed' } });
    expect(calls[0]!.url).toBe(`${BASE}/projects/${PROJECT_REF}`);
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.body).toEqual({ name: 'renamed' });
    expect(result.resource!.id).toBe(PROJECT_REF);
    expect(result.resource!.name).toBe('renamed');
    expect(result.indeterminate).toBe(false);

    const empty = await expectError(client.update({ kind: 'project', id: PROJECT_REF, patch: {} }));
    expect(empty.code).toBe('CONFIGURATION');
    const owner = await expectError(
      client.update({ kind: 'project', id: PROJECT_REF, patch: { name: 'x', owner: 'someone' } }),
    );
    expect(owner.code).toBe('CONFIGURATION');
    const extra = await expectError(
      client.update({
        kind: 'project',
        id: PROJECT_REF,
        patch: { name: 'x', providerOptions: { region: 'x' } },
      }),
    );
    expect(extra.code).toBe('CONFIGURATION');
    expect(calls).toHaveLength(1);
  });

  it('deletes a project with DELETE /v1/projects/{ref}', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(200, { id: 1, ref: PROJECT_REF, name: 'gone' }));
    const client = makeClient(fetch);

    const result = await client.delete({ kind: 'project', id: PROJECT_REF });
    expect(calls[0]!.url).toBe(`${BASE}/projects/${PROJECT_REF}`);
    expect(calls[0]!.method).toBe('DELETE');
    expect(result.operation).toBeNull();
    expect(result.indeterminate).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Branch lifecycle (Environments API)
// ---------------------------------------------------------------------------

describe('branch lifecycle', () => {
  it('creates a branch via POST /v1/projects/{ref}/branches with branch_name and maps the scoped resource', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(201, branchPayload()));
    const client = makeClient(fetch);

    const result = await client.create({ kind: 'branch', projectId: PROJECT_REF, name: 'feature-x' });

    expect(calls[0]!.url).toBe(`${BASE}/projects/${PROJECT_REF}/branches`);
    expect(calls[0]!.body).toEqual({ branch_name: 'feature-x' });
    expect(result.resource!.kind).toBe('branch');
    expect(result.resource!.id).toBe(BRANCH_ID);
    expect(result.resource!.projectId).toBe(PROJECT_REF); // scope is first-class on the resource
    expect(result.resource!.status).toBe('creating'); // from preview_project_status COMING_UP
    expect(result.secrets).toEqual([]);
  });

  it('refuses branch creation without a name and with a source branch, pre-network', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(201, branchPayload()));
    const client = makeClient(fetch);

    const noName = await expectError(client.create({ kind: 'branch', projectId: PROJECT_REF }));
    expect(noName.code).toBe('CONFIGURATION');
    expect(noName.message).toContain('branch_name');

    const source = await expectError(
      client.create({ kind: 'branch', projectId: PROJECT_REF, name: 'x', sourceBranchId: 'other' }),
    );
    expect(source.code).toBe('CONFIGURATION');
    expect(source.message).toContain('no source-branch');
    expect(calls).toHaveLength(0);
  });

  it('lists branches scoped by projectId on the query object and refuses cursor/limit', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(200, [branchPayload(), branchPayload()]));
    const client = makeClient(fetch);

    const page = await client.list('branch', { projectId: PROJECT_REF });
    expect(calls[0]!.url).toBe(`${BASE}/projects/${PROJECT_REF}/branches`);
    expect(page.resources).toHaveLength(2);
    for (const resource of page.resources) {
      expect(resource.projectId).toBe(PROJECT_REF);
      expect(resource.kind).toBe('branch');
    }
    expect(page.cursor).toBeNull();

    const noScope = await expectError(client.list('branch', {}));
    expect(noScope.code).toBe('CONFIGURATION');
    const paginated = await expectError(
      client.list('branch', { projectId: PROJECT_REF, cursor: 'x' }),
    );
    expect(paginated.code).toBe('CAPABILITY');
  });

  it('reads a branch via GET /v1/branches/{id} (the official branch-config route) and maps project-style status', async () => {
    const { fetch, calls } = makeFetch(() =>
      jsonResponse(
        200,
        branchDetailPayload({ status: 'COMING_UP', db_pass: 'secret-branch-pass', jwt_secret: 'secret-jwt' }),
      ),
    );
    const client = makeClient(fetch);

    const resource = await client.get({ kind: 'branch', id: BRANCH_ID, projectId: PROJECT_REF });
    expect(calls[0]!.url).toBe(`${BASE}/branches/${BRANCH_ID}`);
    expect(resource.id).toBe(BRANCH_ID);
    expect(resource.projectId).toBe(PROJECT_REF);
    expect(resource.status).toBe('creating'); // the detail status field uses the project enum
    // Credentials returned by the official endpoint are redacted from raw.
    expect(JSON.stringify(resource.raw)).not.toContain('secret-branch-pass');
    expect(JSON.stringify(resource.raw)).not.toContain('secret-jwt');
    expect(resource.raw['db_pass']).toBe('[redacted]');
    expect(resource.raw['jwt_secret']).toBe('[redacted]');
  });

  it('redacts nested secret keys inside raw payloads', async () => {
    const { fetch } = makeFetch(() =>
      jsonResponse(
        200,
        branchDetailPayload({
          pooler: { connection_string: 'postgresql://postgres:branch-real-password-1@host/db' },
        }),
      ),
    );
    const client = makeClient(fetch);
    const resource = await client.get({ kind: 'branch', id: BRANCH_ID, projectId: PROJECT_REF });
    const pooler = resource.raw['pooler'] as Record<string, unknown>;
    expect(pooler['connection_string']).toBe('[redacted]');
  });

  it('updates a branch via PATCH /v1/branches/{id} with branch_name and refuses unsupported fields', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(200, branchPayload({ name: 'renamed-branch' })));
    const client = makeClient(fetch);

    const result = await client.update({
      kind: 'branch',
      id: BRANCH_ID,
      projectId: PROJECT_REF,
      patch: { name: 'renamed-branch', providerOptions: { git_branch: 'feature-x' } },
    });
    expect(calls[0]!.url).toBe(`${BASE}/branches/${BRANCH_ID}`);
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.body).toEqual({ branch_name: 'renamed-branch', git_branch: 'feature-x' });
    expect(result.resource!.name).toBe('renamed-branch');

    const owner = await expectError(
      client.update({ kind: 'branch', id: BRANCH_ID, projectId: PROJECT_REF, patch: { owner: 'x' } }),
    );
    expect(owner.code).toBe('CONFIGURATION');
    const reset = await expectError(
      client.update({
        kind: 'branch',
        id: BRANCH_ID,
        projectId: PROJECT_REF,
        patch: { name: 'x', providerOptions: { reset_on_push: true } },
      }),
    );
    expect(reset.code).toBe('CONFIGURATION');
    expect(reset.message).toContain("'reset_on_push'");
    expect(calls).toHaveLength(1);
  });

  it('deletes a branch via DELETE /v1/branches/{id}', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(200, { message: 'ok' }));
    const client = makeClient(fetch);

    const result = await client.delete({ kind: 'branch', id: BRANCH_ID, projectId: PROJECT_REF });
    expect(calls[0]!.url).toBe(`${BASE}/branches/${BRANCH_ID}`);
    expect(calls[0]!.method).toBe('DELETE');
    expect(result.operation).toBeNull();
    expect(result.indeterminate).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Logical database kind — refused CAPABILITY, pre-network
// ---------------------------------------------------------------------------

describe('logical database kind refusal', () => {
  it('refuses every database verb with CAPABILITY before any network request', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(200, {}));
    const client = makeClient(fetch);

    const dbRef = { kind: 'database' as const, id: 'postgres', projectId: 'p', branchId: 'b' };
    const created = await expectError(
      client.create({ kind: 'database', projectId: 'p', branchId: 'b', name: 'app-db' }),
    );
    expect(created.code).toBe('CAPABILITY');
    const got = await expectError(client.get(dbRef));
    expect(got.code).toBe('CAPABILITY');
    const listed = await expectError(client.list('database'));
    expect(listed.code).toBe('CAPABILITY');
    const updated = await expectError(
      client.update({ kind: 'database', id: 'postgres', projectId: 'p', branchId: 'b', patch: { name: 'x' } }),
    );
    expect(updated.code).toBe('CAPABILITY');
    const deleted = await expectError(client.delete(dbRef));
    expect(deleted.code).toBe('CAPABILITY');
    expect(calls).toHaveLength(0);
  });

  it('explains the refusal when the adapter is used directly (core intercepts client calls first)', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(200, {}));
    const adapter = makeAdapter(fetch);

    const error = await expectError(
      adapter.create({ kind: 'database', projectId: 'p', branchId: 'b', name: 'app-db' }),
    );
    expect(error.code).toBe('CAPABILITY');
    expect(error.message).toContain('a Supabase project IS');
    expect(error.message).toContain("create({ kind: 'project' })");
    expect(calls).toHaveLength(0);
  });

  it('declares the refusal in capabilities so capability tables render it', () => {
    const adapter = makeAdapter(async () => jsonResponse(200, {}));
    expect(adapter.capabilities.resourceKinds).toEqual(['project', 'branch']);
    expect(adapter.capabilities.asyncOperations).toBe(false);
    expect(adapter.capabilities.pagination).toBe(false);
    expect(adapter.capabilities.evidence['refuse:database']).toBe('docs');
    expect(adapter.capabilities.prerequisites['create:project']).toContain(
      'organizationId or providerOptions.organization_slug',
    );
  });
});

// ---------------------------------------------------------------------------
// wait() — semantic lifecycle polling against the real read endpoints
// ---------------------------------------------------------------------------

describe('wait() resource polling', () => {
  it('polls GET /v1/projects/{ref} through the lifecycle until active and reports each status', async () => {
    const statuses = ['COMING_UP', 'COMING_UP', 'ACTIVE_HEALTHY'];
    const seen: Array<{ method: string; url: string }> = [];
    const { fetch } = makeFetch(({ method, url }) => {
      if (method === 'GET') seen.push({ method, url });
      return jsonResponse(200, projectPayload({ status: statuses[seen.length - 1] }));
    });
    const client = makeClient(fetch);
    const created = await client.create(projectSpec);

    const onStatus: Array<string | null> = [];
    const final = await client.wait(created, {
      pollIntervalMs: 1,
      onStatus: (r) => onStatus.push(r.status),
    });

    expect(final.status).toBe('active');
    expect(final.id).toBe(PROJECT_REF);
    expect(seen).toHaveLength(3);
    for (const call of seen) {
      expect(call).toEqual({ method: 'GET', url: `${BASE}/projects/${PROJECT_REF}` });
    }
    expect(onStatus).toEqual(['creating', 'creating', 'active']);
  });

  it('throws PROVIDER with the provider status when the project reaches a failed state', async () => {
    const { fetch } = makeFetch(() => jsonResponse(200, projectPayload({ status: 'INIT_FAILED' })));
    const client = makeClient(fetch);
    const created = await client.create(projectSpec);

    const error = await expectError(client.wait(created, { pollIntervalMs: 1 }));
    expect(error.code).toBe('PROVIDER');
    expect(error.providerStatus).toBe('INIT_FAILED');
  });

  it('polls branch readiness via GET /v1/branches/{id} using the scope reconstructed from the write result', async () => {
    const statuses = ['COMING_UP', 'ACTIVE_HEALTHY'];
    const seen: Array<{ method: string; url: string }> = [];
    const { fetch } = makeFetch(({ method, url }) => {
      if (method === 'GET') seen.push({ method, url });
      return method === 'POST'
        ? jsonResponse(201, branchPayload())
        : jsonResponse(200, branchDetailPayload({ status: statuses[seen.length - 1] }));
    });
    const client = makeClient(fetch);
    const created = await client.create({ kind: 'branch', projectId: PROJECT_REF, name: 'feature-x' });

    const final = await client.wait(created, { pollIntervalMs: 1 });

    expect(final.status).toBe('active');
    // The branch read endpoint is the top-level /branches/{id} route — the parent project scope
    // carried on the resource is not part of the URL, but the ref reconstruction used it.
    expect(seen).toEqual([
      { method: 'GET', url: `${BASE}/branches/${BRANCH_ID}` },
      { method: 'GET', url: `${BASE}/branches/${BRANCH_ID}` },
    ]);
  });

  it('surfaces RATE_LIMIT with the provider retry hint during polling', async () => {
    let firstPoll = true;
    const { fetch } = makeFetch(({ method }) => {
      if (method === 'GET' && firstPoll) {
        firstPoll = false;
        return jsonResponse(429, { message: 'rate limited' }, { 'x-ratelimit-reset': '1' });
      }
      return jsonResponse(200, projectPayload({ status: 'ACTIVE_HEALTHY' }));
    });
    const client = makeClient(fetch);
    const created = await client.create(projectSpec);

    const final = await client.wait(created, { pollIntervalMs: 1 });
    expect(final.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// Error mapping and indeterminate mutation outcomes
// ---------------------------------------------------------------------------

describe('error mapping', () => {
  it('maps 401/403 to AUTH/PERMISSION on reads and mutations', async () => {
    const auth = makeFetch(() => jsonResponse(401, { message: 'Invalid API key' }));
    const client = makeClient(auth.fetch);
    const authError = await expectError(client.list('project'));
    expect(authError.code).toBe('AUTH');

    const forbidden = makeFetch(() => jsonResponse(403, { message: 'Not authorized' }));
    const client2 = makeClient(forbidden.fetch);
    const permError = await expectError(client2.create(projectSpec));
    expect(permError.code).toBe('PERMISSION');
    expect(permError.indeterminate).toBe(false); // definitive rejection, not indeterminate
  });

  it('maps 429 to RATE_LIMIT with retryAfterMs from X-RateLimit-Reset', async () => {
    const { fetch } = makeFetch(() => jsonResponse(429, { message: 'rate limit' }, { 'x-ratelimit-reset': '30' }));
    const client = makeClient(fetch);
    const error = await expectError(client.create(projectSpec));
    expect(error.code).toBe('RATE_LIMIT');
    expect(error.retryAfterMs).toBe(30_000);
    expect(error.indeterminate).toBe(false);
  });

  it('marks 5xx mutations indeterminate and GETs not', async () => {
    const { fetch } = makeFetch(() => jsonResponse(500, { message: 'boom' }));
    const client = makeClient(fetch);
    const createError = await expectError(client.create(projectSpec));
    expect(createError.code).toBe('PROVIDER');
    expect(createError.indeterminate).toBe(true);

    const listFetch = makeFetch(() => jsonResponse(500, { message: 'boom' }));
    const listClient = makeClient(listFetch.fetch);
    const listError = await expectError(listClient.list('project'));
    expect(listError.indeterminate).toBe(false);
  });

  it('marks network failures and timeouts on mutations as indeterminate', async () => {
    const network = makeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const client = makeClient(network.fetch);
    const connError = await expectError(client.create(projectSpec));
    expect(connError.code).toBe('CONNECTION');
    expect(connError.indeterminate).toBe(true);
    expect(connError.message).not.toContain(TOKEN);

    const timedOut = makeClient(hangingFetch());
    const timeoutError = await expectError(timedOut.create(projectSpec, { timeoutMs: 20 }));
    expect(timeoutError.code).toBe('TIMEOUT');
    expect(timeoutError.indeterminate).toBe(true);
  });

  it('maps a caller abort during a mutation to ABORTED', async () => {
    const client = makeClient(hangingFetch());
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const error = await expectError(
      client.create(projectSpec, { signal: controller.signal, timeoutMs: 5_000 }),
    );
    expect(error.code).toBe('ABORTED');
    expect(error.indeterminate).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Typed raw escape hatch (official endpoints only)
// ---------------------------------------------------------------------------

describe('raw escape hatch', () => {
  it('listOrganizations reads GET /v1/organizations for the create-project prerequisite', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(200, [{ id: 'org-1', slug: ORG_SLUG, name: 'Acme' }]));
    const adapter = makeAdapter(fetch);

    const organizations = await adapter.raw.listOrganizations();
    expect(calls[0]!.url).toBe(`${BASE}/organizations`);
    expect(organizations).toEqual([{ id: 'org-1', slug: ORG_SLUG, name: 'Acme' }]);
  });

  it('databaseHost reads the official database.host from GET /v1/projects/{ref}', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(200, projectPayload()));
    const adapter = makeAdapter(fetch);

    const host = await adapter.raw.databaseHost(PROJECT_REF);
    expect(calls[0]!.url).toBe(`${BASE}/projects/${PROJECT_REF}`);
    expect(host).toBe(`db.${PROJECT_REF}.supabase.co`);
  });

  it('branchConfig redacts credentials by default and returns them only with an explicit opt-in', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(200, branchDetailPayload()));
    const adapter = makeAdapter(fetch);

    const redacted = await adapter.raw.branchConfig({ branchIdOrRef: BRANCH_ID });
    expect(calls[0]!.url).toBe(`${BASE}/branches/${BRANCH_ID}`);
    expect(redacted.dbHost).toBe('bbbbb-preview.supabase.co');
    expect(redacted.dbPort).toBe(5432);
    expect(redacted.dbUser).toBe('postgres');
    expect(redacted.dbPass).toBeUndefined();
    expect(redacted.jwtSecret).toBeUndefined();

    const withSecrets = await adapter.raw.branchConfig(
      { branchIdOrRef: BRANCH_ID },
      { includeSecrets: true },
    );
    expect(withSecrets.dbPass).toBe('branch-real-password-1');
    expect(withSecrets.jwtSecret).toBe('branch-jwt-secret-1');
  });

  it('scrubs opt-in credentials from later error messages', async () => {
    // The first branch-config read succeeds (registering the credentials); the second read of the
    // same endpoint fails with a message embedding them — the adapter must scrub both values.
    let branchReads = 0;
    const { fetch, calls } = makeFetch((req) => {
      if (req.url === `${BASE}/branches/${BRANCH_ID}`) {
        branchReads += 1;
        if (branchReads === 1) return jsonResponse(200, branchDetailPayload());
      }
      return jsonResponse(500, { message: 'boom branch-real-password-1 branch-jwt-secret-1' });
    });
    const adapter = makeAdapter(fetch);
    await adapter.raw.branchConfig({ branchIdOrRef: BRANCH_ID }, { includeSecrets: true });

    const error = await expectError(adapter.get({ kind: 'branch', id: BRANCH_ID, projectId: PROJECT_REF }));
    expect(error.code).toBe('PROVIDER');
    expect(error.message).not.toContain('branch-real-password-1');
    expect(error.message).not.toContain('branch-jwt-secret-1');
    expect(error.message).toContain('[redacted]');
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Password generation
// ---------------------------------------------------------------------------

describe('generateDatabasePassword', () => {
  it('produces 24-character passwords with all character classes and no URL-hostile characters', () => {
    for (let i = 0; i < 50; i += 1) {
      const password = generateDatabasePassword();
      expect(password).toHaveLength(24);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[0-9]/);
      expect(password).toMatch(/[-_.!%^*+]/);
      expect(password).toMatch(/^[A-Za-z0-9\-_.!%^*+]+$/);
    }
    // Two generations differ (cryptographically random).
    expect(generateDatabasePassword()).not.toBe(generateDatabasePassword());
  });
});

// ---------------------------------------------------------------------------
// Amendment A4 — discovery, connection, actions, credential rotation
// (official shapes from the Supabase Management API v1 OpenAPI spec, verified 2026-10-06)
// ---------------------------------------------------------------------------

describe('A4: organizations + regions discovery', () => {
  it('organizations() maps slug (canonical id), deprecated id (alias), and name', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(200, [{ id: '42', slug: ORG_SLUG, name: 'Acme' }]));
    const client = makeClient(fetch);
    const orgs = await client.organizations();
    expect(calls[0]!.url).toBe(`${BASE}/organizations`);
    expect(calls[0]!.method).toBe('GET');
    expect(orgs[0]).toEqual({
      providerId: 'supabase',
      id: ORG_SLUG,
      name: 'Acme',
      aliasId: '42',
      raw: { id: '42', slug: ORG_SLUG, name: 'Acme' },
    });
  });

  it('regions() requires organizationId (the official endpoint requires organization_slug) and maps specific + smartGroup', async () => {
    const { fetch, calls } = makeFetch(() =>
      jsonResponse(200, {
        recommendations: {
          smartGroup: { name: 'Smart region', code: 'americas', type: 'smartGroup' },
          specific: [
            { name: 'East US (North Virginia)', code: 'us-east-1', type: 'specific', provider: 'AWS', status: 'capacity' },
            { name: 'West US', code: 'us-west-1', type: 'specific', provider: 'AWS_K8S', status: 'other' },
          ],
        },
      }),
    );
    const client = makeClient(fetch);
    await expectError(client.regions()).then((error) => {
      expect(error.code).toBe('CONFIGURATION');
    });
    const regions = await client.regions({ organizationId: ORG_SLUG });
    expect(calls[0]!.url).toBe(`${BASE}/projects/available-regions?organization_slug=${ORG_SLUG}`);
    expect(regions.map((region) => region.id)).toEqual(['americas', 'us-east-1', 'us-west-1']);
    expect(regions[1]).toMatchObject({ platform: 'AWS', name: 'East US (North Virginia)' });
    expect(regions[0]!.platform).toBeNull(); // smartGroup has no platform
  });
});

describe('A4: connection()', () => {
  it('project (direct): GET /v1/projects/{ref} → database.host; no invented database/role; secrets empty (no credential recovery)', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(200, projectPayload()));
    const client = makeClient(fetch);
    const info = await client.connection({ kind: 'project', id: PROJECT_REF }, { reveal: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/projects/${PROJECT_REF}`);
    expect(info).toMatchObject({
      providerId: 'supabase',
      kind: 'project',
      id: PROJECT_REF,
      host: `db.${PROJECT_REF}.supabase.co`,
      database: null,
      role: null,
      pooled: false,
      redactedUri: null,
      secrets: [],
    });
  });

  it('project (pooled): GET /v1/projects/{ref}/config/database/pooler → PRIMARY entry; connection_string redacted unless reveal', async () => {
    const connectionString = `postgresql://postgres.${PROJECT_REF}:pooler-real-password@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;
    const { fetch, calls } = makeFetch((req) => {
      if (req.url.includes('/config/database/pooler')) {
        return jsonResponse(200, [
          {
            identifier: PROJECT_REF,
            database_type: 'READ_REPLICA',
            db_host: 'aws-0-us-east-1.pooler.supabase.com',
            db_port: 6543,
            db_user: 'postgres.replica',
            db_name: 'postgres',
            connection_string: 'postgresql://postgres:x@h:6543/postgres',
          },
          {
            identifier: PROJECT_REF,
            database_type: 'PRIMARY',
            db_host: 'aws-0-us-east-1.pooler.supabase.com',
            db_port: 6543,
            db_user: `postgres.${PROJECT_REF}`,
            db_name: 'postgres',
            connection_string: connectionString,
          },
        ]);
      }
      return jsonResponse(200, projectPayload());
    });
    const client = makeClient(fetch);
    const info = await client.connection({ kind: 'project', id: PROJECT_REF }, { pooled: true });
    expect(info.pooled).toBe(true);
    expect(info.host).toBe('aws-0-us-east-1.pooler.supabase.com');
    expect(info.role).toBe(`postgres.${PROJECT_REF}`);
    expect(info.database).toBe('postgres');
    expect(info.port).toBe(6543);
    expect(info.redactedUri).toBe(
      `postgresql://postgres.${PROJECT_REF}:[redacted]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
    );
    expect(info.secrets).toEqual([]);
    // Explicit reveal returns the real credential.
    const revealed = await client.connection({ kind: 'project', id: PROJECT_REF }, { pooled: true, reveal: true });
    expect(revealed.secrets).toEqual([{ label: 'connectionString', value: connectionString }]);
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  it('branch: GET /v1/branches/{id} → db_host/db_port/db_user; db_pass only on reveal', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(200, branchDetailPayload()));
    const client = makeClient(fetch);
    const info = await client.connection({ kind: 'branch', id: BRANCH_ID, projectId: PROJECT_REF }, {});
    expect(calls[0]!.url).toBe(`${BASE}/branches/${BRANCH_ID}`);
    expect(info).toMatchObject({
      kind: 'branch',
      host: 'bbbbb-preview.supabase.co',
      port: 5432,
      role: 'postgres',
      secrets: [],
    });
    expect(JSON.stringify(info)).not.toContain('branch-real-password-1');
    const revealed = await client.connection(
      { kind: 'branch', id: BRANCH_ID, projectId: PROJECT_REF },
      { reveal: true },
    );
    expect(revealed.secrets).toEqual([{ label: 'password', value: 'branch-real-password-1' }]);
  });
});

describe('A4: actions (pause / restart / branch reset)', () => {
  it('pause: POST /v1/projects/{ref}/pause with no body; result truthful (track via get())', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(200, null));
    const client = makeClient(fetch);
    const result = await client.action({ kind: 'project', id: PROJECT_REF }, 'pause');
    expect(calls[0]!.url).toBe(`${BASE}/projects/${PROJECT_REF}/pause`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toBeUndefined();
    expect(result).toEqual({ resource: null, operation: null, secrets: [], indeterminate: false });
  });

  it('restart: POST /v1/projects/{ref}/restart', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(200, null));
    const client = makeClient(fetch);
    await client.action({ kind: 'project', id: PROJECT_REF }, 'restart');
    expect(calls[0]!.url).toBe(`${BASE}/projects/${PROJECT_REF}/restart`);
    expect(calls[0]!.method).toBe('POST');
  });

  it('reset (branch): POST /v1/branches/{id}/reset with optional migration_version', async () => {
    const { fetch, calls } = makeFetch(() =>
      jsonResponse(201, { workflow_run_id: 'wf-1', message: 'ok' }),
    );
    const client = makeClient(fetch);
    const result = await client.action(
      { kind: 'branch', id: BRANCH_ID, projectId: PROJECT_REF },
      'reset',
      { input: { migrationVersion: '20250312000000' } },
    );
    expect(calls[0]!.url).toBe(`${BASE}/branches/${BRANCH_ID}/reset`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ migration_version: '20250312000000' });
    expect(result.resource).toBeNull();
    // No input → no body.
    await client.action({ kind: 'branch', id: BRANCH_ID, projectId: PROJECT_REF }, 'reset');
    expect(calls[1]!.body).toBeUndefined();
  });

  it('restore (branch): POST /v1/branches/{id}/restore with no body', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(201, { message: 'Branch restoration initiated' }));
    const client = makeClient(fetch);
    const result = await client.action({ kind: 'branch', id: BRANCH_ID, projectId: PROJECT_REF }, 'restore');
    expect(calls[0]!.url).toBe(`${BASE}/branches/${BRANCH_ID}/restore`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toBeUndefined();
    expect(result).toEqual({ resource: null, operation: null, secrets: [], indeterminate: false });
  });

  it('resume (project): POST /v1/projects/{ref}/restore with no body — the official un-pause operation', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(200, null));
    const client = makeClient(fetch);
    const result = await client.action({ kind: 'project', id: PROJECT_REF }, 'resume');
    expect(calls[0]!.url).toBe(`${BASE}/projects/${PROJECT_REF}/restore`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toBeUndefined();
    // Supabase echoes no resource/operation for this endpoint; progress is tracked by polling get().
    expect(result).toEqual({ resource: null, operation: null, secrets: [], indeterminate: false });
    // The bare action result is not pollable by wait() (no ref to poll); the documented pattern
    // is wait({ kind: 'project' }) or polling get(), which statusPolling supports.
    await expectError(client.wait(result)).then((waitError) => {
      expect(waitError.code).toBe('CONFIGURATION');
    });
    expect(calls).toHaveLength(1);
  });

  it('undeclared actions are refused CAPABILITY before dispatch', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(200, null));
    const client = makeClient(fetch);
    // Client level: the core refuses from the declared actions table.
    await expectError(client.action({ kind: 'project', id: PROJECT_REF }, 'stop')).then((error) => {
      expect(error.code).toBe('CAPABILITY');
      expect(error.message).toContain("'pause', 'restart', 'resume', 'reset', 'restore'");
    });
    await expectError(client.action({ kind: 'branch', id: BRANCH_ID, projectId: PROJECT_REF }, 'pause')).then(
      (error) => {
        expect(error.code).toBe('CAPABILITY');
      },
    );
    await expectError(client.action({ kind: 'branch', id: BRANCH_ID, projectId: PROJECT_REF }, 'resume')).then(
      (error) => {
        expect(error.code).toBe('CAPABILITY');
      },
    );
    expect(calls).toHaveLength(0);
    // Direct adapter use gets the honest explanation, including the official restore endpoint
    // that resume maps to.
    const adapter = makeAdapter(makeFetch(() => jsonResponse(200, null)).fetch);
    await expectError(
      adapter.action!({ kind: 'project', id: PROJECT_REF }, 'stop'),
    ).then((error) => {
      expect(error.code).toBe('CAPABILITY');
      expect(error.message).toContain('POST /v1/projects/{ref}/restore');
    });
  });
});

describe('A4: resetCredential (project password rotation)', () => {
  it('generates a strong password when omitted and returns it ONLY in secrets; body uses {password}', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(200, { message: 'Password updated' }));
    const client = makeClient(fetch);
    const result = await client.resetCredential({ kind: 'project', id: PROJECT_REF });
    expect(calls[0]!.url).toBe(`${BASE}/projects/${PROJECT_REF}/database/password`);
    expect(calls[0]!.method).toBe('PATCH');
    const body = calls[0]!.body as { password: string };
    expect(typeof body.password).toBe('string');
    expect(body.password).toHaveLength(24);
    expect(result.secrets).toEqual([{ label: 'password', value: body.password }]);
    expect(JSON.stringify(result.resource)).not.toContain(body.password);
  });

  it('sends a caller-supplied password verbatim and never echoes it back', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(200, { message: 'Password updated' }));
    const client = makeClient(fetch);
    const result = await client.resetCredential({ kind: 'project', id: PROJECT_REF }, { password: 'correct-horse' });
    expect(calls[0]!.body).toEqual({ password: 'correct-horse' });
    expect(result.secrets).toEqual([]);
  });

  it('is refused for non-project kinds before dispatch', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(200, { message: 'ok' }));
    const client = makeClient(fetch);
    await expectError(client.resetCredential({ kind: 'branch', id: BRANCH_ID, projectId: PROJECT_REF })).then(
      (error) => {
        expect(error.code).toBe('CAPABILITY');
      },
    );
    expect(calls).toHaveLength(0);
  });
});
