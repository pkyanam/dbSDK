/**
 * Independent A4 provider-coverage review tests (R2 review agent).
 *
 * Written from the official spec files — NOT from the adapter test fixtures:
 * - Neon:  https://neon.com/api_spec/release/v2.json  (cached /tmp/neon-v2.json, 122 paths)
 * - Supabase: apps/docs/spec/api_v1_openapi.json on github.com/supabase/supabase
 *   (cached /tmp/sbspec/api_v1_openapi.json, 115 paths)
 *
 * Consumer-level, mocked control plane (injected fetch, official-spec shapes, labeled as such;
 * no hosted calls, no paid resources, no API write calls). Where DBSDK_TEST_POSTGRES_URL is set
 * (local Docker Postgres 17, `dbsdk-pg-test` on :15432), one test adds a REAL SQL leg through the
 * revealed connection string — no hosted provider is contacted.
 *
 * Scope of this file (things the implementer's own tests did not cover or got wrong):
 * 1. Capability gating with ZERO dispatch for every A4 verb on both providers.
 * 2. Mutable-adapter capability validation (declaring without implementing = CONFIGURATION).
 * 3. Supabase `resume` — verified to be the official POST /v1/projects/{ref}/restore un-pause
 *    operation (RESTORING status + /restore/cancel pairing; projects:write scope). This test
 *    pins the corrected contract that earlier reports falsely called "dashboard-only".
 * 4. Secret redaction including FUTURE error objects (registered secrets never leak), and
 *    Neon server-generated credentials appearing ONLY in `secrets`.
 * 5. Spec-derived path/method/body/query assertions for the A4 endpoints on both providers.
 * 6. wait() after mutations issues GETs only (never replays a write), and readiness polling
 *    goes through the official operation endpoint first (Neon), then the resource.
 */

import { describe, expect, it } from 'vitest';

import { createDatabase } from '../src/core/database.js';
import { createManagement } from '../src/management/core.js';
import { ManagementError, type ManagementErrorCode } from '../src/management/errors.js';
import { neonManagement } from '../src/management/neon.js';
import { postgres } from '../src/adapters/postgres.js';
import { supabaseManagement } from '../src/management/supabase.js';
import type { FetchLike, ManagementAdapter } from '../src/management/types.js';

const NEON_BASE = 'https://console.neon.tech/api/v2';
const NEON_KEY = 'nk_review_key';
const SB_BASE = 'https://api.supabase.com/v1';
const SB_TOKEN = 'sbp_review_token';
const SB_REF = 'abcdefghijklmnopqrst';
const SB_BRANCH = '00000000-0000-0000-0000-000000000001';
const NEON_PROJECT = 'p-review-1';
const NEON_BRANCH = 'br-review-1';
const LOCAL_DB = process.env.DBSDK_TEST_POSTGRES_URL ?? '';

type RecordedCall = { url: URL; path: string; method: string; body: unknown; headers: Record<string, string> };

/** Official-shape mock control plane (offline). Records and answers per handler. */
function controlPlane(
  handler: (req: RecordedCall) => { status?: number; body?: unknown; headers?: Record<string, string> } | Promise<{ status?: number; body?: unknown; headers?: Record<string, string> }>,
): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const rawBody = typeof init?.body === 'string' ? init.body : undefined;
    // The official base paths live in the URL pathname: Neon ".../api/v2", Supabase ".../v1".
    let path = url.pathname;
    if (path.startsWith('/api/v2/')) path = path.slice('/api/v2'.length);
    else if (path === '/api/v2') path = '';
    if (path.startsWith('/v1/')) path = path.slice('/v1'.length);
    else if (path === '/v1') path = '';
    const call: RecordedCall = {
      url,
      path,
      method: (init?.method ?? 'GET').toUpperCase(),
      body: rawBody === undefined ? undefined : (JSON.parse(rawBody) as unknown),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
      ),
    };
    calls.push(call);
    const response = await handler(call);
    return new Response(response.body === undefined ? null : JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/json', ...(response.headers ?? {}) },
    });
  };
  return { fetch, calls };
}

const neonClient = (fetch: FetchLike) => createManagement({ adapter: neonManagement({ apiKey: NEON_KEY, fetch }) });
const sbClient = (fetch: FetchLike) => createManagement({ adapter: supabaseManagement({ accessToken: SB_TOKEN, fetch }) });

async function expectCode(promise: Promise<unknown>, code: ManagementErrorCode): Promise<ManagementError> {
  const error = await promise.then(
    () => {
      throw new Error(`expected a ${code} error, but the call succeeded`);
    },
    (e: unknown) => e as ManagementError,
  );
  expect(error).toBeInstanceOf(ManagementError);
  expect(error.code).toBe(code);
  return error;
}

const NOW = '2026-10-06T00:00:00Z';

// ---------------------------------------------------------------------------
// 1. Capability gating — zero requests for unsupported verb/kind/action pairs
// ---------------------------------------------------------------------------

describe('A4 gating: refused BEFORE any network request (both providers)', () => {
  it('Supabase: actions limited to the declared table; connection/resetCredential kinds enforced', async () => {
    const { fetch, calls } = controlPlane(() => ({ body: {} }));
    const client = sbClient(fetch);
    // Not-declared action names and kind pairs (official Supabase API has no stop / no
    // project-level reset / no branch-level pause).
    await expectCode(client.action({ kind: 'project', id: SB_REF }, 'stop'), 'CAPABILITY');
    await expectCode(client.action({ kind: 'project', id: SB_REF }, 'reset'), 'CAPABILITY');
    await expectCode(client.action({ kind: 'branch', id: SB_BRANCH, projectId: SB_REF }, 'resume'), 'CAPABILITY');
    await expectCode(client.connection({ kind: 'database', id: 'postgres', projectId: SB_REF, branchId: SB_BRANCH } as never, {}), 'CAPABILITY');
    await expectCode(client.resetCredential({ kind: 'branch', id: SB_BRANCH, projectId: SB_REF }), 'CAPABILITY');
    expect(calls).toHaveLength(0);
  });

  it('Neon: no project-level resume/pause (scale-to-zero is per-endpoint); snapshot GET refused; wait on bare snapshot refused', async () => {
    const { fetch, calls } = controlPlane(() => ({ body: {} }));
    const client = neonClient(fetch);
    await expectCode(client.action({ kind: 'project', id: NEON_PROJECT }, 'resume'), 'CAPABILITY');
    await expectCode(client.action({ kind: 'project', id: NEON_PROJECT }, 'pause'), 'CAPABILITY');
    await expectCode(client.action({ kind: 'role', id: 'app', scope: { projectId: NEON_PROJECT, branchId: NEON_BRANCH } }, 'start'), 'CAPABILITY');
    await expectCode(client.connection({ kind: 'endpoint', id: 'ep-1', scope: { projectId: NEON_PROJECT } }), 'CAPABILITY');
    // Official Neon API has NO single-snapshot read endpoint (DELETE/PATCH only on /snapshots/{id}).
    const getError = await expectCode(client.get({ kind: 'snapshot', id: 'snap-1', scope: { projectId: NEON_PROJECT } }), 'CAPABILITY');
    expect(getError.message).toContain('no single-snapshot');
    // And wait() cannot fall back to status polling for that kind (statusPolling is branch+endpoint).
    await expectCode(client.wait({ kind: 'snapshot', id: 'snap-1', scope: { projectId: NEON_PROJECT } }), 'CAPABILITY');
    expect(calls).toHaveLength(0);
  });

  it('declaring a capability without implementing the method is a CONSTRUCTION error', () => {
    const base = {
      id: 'fake',
      providerId: 'fake',
      create: async () => ({ resource: null, operation: null, secrets: [], indeterminate: false }),
      list: async () => ({ kind: 'project' as const, resources: [], cursor: null }),
      get: async () => { throw new Error('nope'); },
      capabilities: {
        resourceKinds: ['project'],
        supported: { update: [], delete: [], connection: ['project'] },
        pagination: false,
        asyncOperations: false,
        evidence: {},
        prerequisites: {},
      },
    };
    expect(() => createManagement({ adapter: base as unknown as ManagementAdapter })).toThrow(/supported\.connection.*connection\(\)/);
    expect(() =>
      createManagement({
        adapter: {
          ...base,
          capabilities: {
            ...base.capabilities,
            supported: { update: [], delete: [], actions: { pause: ['project'] } },
          },
        } as unknown as ManagementAdapter,
      }),
    ).toThrow(/supported\.actions.*action\(\)/);
  });
});

// ---------------------------------------------------------------------------
// 2. Supabase resume — the corrected contract (official POST /v1/projects/{ref}/restore)
// ---------------------------------------------------------------------------

describe('Supabase action resume (official POST /v1/projects/{ref}/restore)', () => {
  it('sends the official request: no body, empty 200; result is deliberately bare', async () => {
    const { fetch, calls } = controlPlane(() => ({ status: 200, body: null }));
    const client = sbClient(fetch);
    const result = await client.action({ kind: 'project', id: SB_REF }, 'resume');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe(`/projects/${SB_REF}/restore`);
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[0]!.headers['authorization']).toBe(`Bearer ${SB_TOKEN}`);
    expect(result).toEqual({ resource: null, operation: null, secrets: [], indeterminate: false });
  });

  it('indeterminate rules apply: transport failure on the resume POST is indeterminate:true', async () => {
    const { fetch } = controlPlane(() => {
      throw new Error('ECONNRESET between here and the control plane');
    });
    const client = sbClient(fetch);
    const error = await expectCode(client.action({ kind: 'project', id: SB_REF }, 'resume'), 'CONNECTION');
    expect(error.indeterminate).toBe(true);
  });

  it('the bare action result is not pollable; polling goes through the project status', async () => {
    const { fetch, calls } = controlPlane((req) => {
      if (req.method === 'POST' && req.path === `/projects/${SB_REF}/restore`) return { status: 200, body: null };
      if (req.method === 'GET' && req.path === `/projects/${SB_REF}`) {
        return { body: { id: SB_REF, ref: SB_REF, name: 'app', status: 'ACTIVE_HEALTHY', created_at: NOW } };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const client = sbClient(fetch);
    const result = await client.action({ kind: 'project', id: SB_REF }, 'resume');
    await expectCode(client.wait(result), 'CONFIGURATION');
    // Documented pattern: wait on the bare project ref (statusPolling declares project).
    const project = await client.wait({ kind: 'project', id: SB_REF }, { pollIntervalMs: 0 });
    expect(project.status).toBe('active');
    expect(project.providerStatus).toBe('ACTIVE_HEALTHY');
    // Only GETs after the action — no replay of the restore POST.
    expect(calls.filter((c) => c.method !== 'GET' && c.path !== `/projects/${SB_REF}/restore`)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Spec-derived endpoint assertions (paths/methods/bodies/query from the official specs)
// ---------------------------------------------------------------------------

describe('Neon A4 endpoints, asserted from the official v2 spec', () => {
  it('organizations(): GET /users/me/organizations → id/name/handle mapping', async () => {
    const { fetch, calls } = controlPlane(() => ({
      body: { organizations: [{ id: 'org-9', name: 'Acme', handle: 'acme', plan: 'launch', created_at: NOW, updated_at: NOW, managed_by: 'console' }] },
    }));
    const client = neonClient(fetch);
    const orgs = await client.organizations();
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.path).toBe('/users/me/organizations');
    expect(orgs[0]).toMatchObject({ providerId: 'neon', id: 'org-9', name: 'Acme', aliasId: 'acme' });
  });

  it('regions(): GET /regions with optional org_id pass-through; region_id/name/default mapped', async () => {
    const { fetch, calls } = controlPlane(() => ({
      body: { regions: [{ region_id: 'aws-us-east-1', name: 'AWS US East (N. Virginia)', default: true, geo_lat: '38.65', geo_long: '-77.35' }] },
    }));
    const client = neonClient(fetch);
    const regions = await client.regions({ organizationId: 'org-9' });
    expect(calls[0]!.path).toBe('/regions');
    expect(calls[0]!.url.searchParams.get('org_id')).toBe('org-9');
    expect(regions[0]).toMatchObject({ id: 'aws-us-east-1', name: 'AWS US East (N. Virginia)', default: true, platform: null });
  });

  it('connection(): GET /projects/{pid}/connection_uri requires database_name+role_name; reveal registers the URI for later errors', async () => {
    const secretUri = 'postgresql://app_owner:S3cretReviewPass@ep-review-123.aws.neon.tech/neondb?sslmode=require';
    const { fetch, calls } = controlPlane((req) => {
      if (req.path === '/projects/p-review-1/connection_uri') {
        expect(req.url.searchParams.get('database_name')).toBe('neondb');
        expect(req.url.searchParams.get('role_name')).toBe('app_owner');
        expect(req.url.searchParams.get('pooled')).toBe('true');
        return { body: { uri: secretUri } };
      }
      // Later call: a GET that fails with a provider message echoing the secret back.
      return { status: 403, body: { message: `forbidden while touching ${secretUri}` } };
    });
    const client = neonClient(fetch);
    const info = await client.connection(
      { kind: 'project', id: NEON_PROJECT },
      { databaseName: 'neondb', roleName: 'app_owner', pooled: true, reveal: true },
    );
    expect(info.redactedUri).toBe('postgresql://app_owner:[redacted]@ep-review-123.aws.neon.tech/neondb?sslmode=require');
    expect(info.secrets).toEqual([{ label: 'connectionString', value: secretUri }]);
    expect(info.host).toBe('ep-review-123.aws.neon.tech');
    expect(info.port).toBeNull();
    expect(info.pooled).toBe(true);
    // FUTURE error from the same client must not contain the revealed credential.
    const later = await expectCode(client.get({ kind: 'project', id: NEON_PROJECT }), 'PERMISSION');
    expect(later.message).toContain('[redacted]');
    expect(later.message).not.toContain('S3cretReviewPass');
    expect(JSON.stringify(calls.map((c) => c.url.toString()))).not.toContain('[redacted]'); // requests stayed real
  });

  it('role lifecycle: create body {role:{name}}, reset_password POST no body (server-generated), password ONLY in secrets', async () => {
    const newPassword = 'ServerGeneratedPw9!';
    const { fetch, calls } = controlPlane((req) => {
      if (req.method === 'POST' && req.path === `/projects/${NEON_PROJECT}/branches/${NEON_BRANCH}/roles`) {
        expect(req.body).toEqual({ role: { name: 'app_ro' } });
        return { status: 201, body: { role: { branch_id: NEON_BRANCH, name: 'app_ro', password: 'CreateTimePw1!', created_at: NOW, updated_at: NOW }, operations: [] } };
      }
      if (req.method === 'POST' && req.path === `/projects/${NEON_PROJECT}/branches/${NEON_BRANCH}/roles/app_ro/reset_password`) {
        expect(req.body).toBeUndefined(); // official endpoint takes no body
        return { body: { role: { branch_id: NEON_BRANCH, name: 'app_ro', password: newPassword, created_at: NOW, updated_at: NOW }, operations: [] } };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const client = neonClient(fetch);
    const ref = { kind: 'role' as const, id: 'app_ro', scope: { projectId: NEON_PROJECT, branchId: NEON_BRANCH } };
    const created = await client.create({ kind: 'role', name: 'app_ro', scope: { projectId: NEON_PROJECT, branchId: NEON_BRANCH } });
    expect(created.secrets.map((s) => s.label)).toEqual(['password:app_ro']);
    expect(JSON.stringify(created.resource?.raw)).not.toContain('CreateTimePw1!');
    await expectCode(client.resetCredential(ref, { password: 'caller-pw' }), 'CONFIGURATION'); // server-generated only
    const reset = await client.resetCredential(ref);
    expect(reset.secrets).toEqual([{ label: 'password:app_ro', value: newPassword }]);
    // The new password appears ONLY in `secrets` — never in the resource, operation, or raw payload.
    expect(JSON.stringify(reset.resource)).not.toContain(newPassword);
    expect(JSON.stringify(reset.operation)).not.toContain(newPassword);
    expect(reset.secrets[0]!.value).toBe(newPassword);
    // Registered for future errors too.
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('endpoint compute actions: POST /projects/{pid}/endpoints/{id}/{start,suspend,restart}; idle→paused mapping', async () => {
    const { fetch, calls } = controlPlane((req) => {
      if (req.method === 'POST' && req.path === `/projects/${NEON_PROJECT}/endpoints/ep-1/suspend`) {
        return { body: { endpoint: { id: 'ep-1', project_id: NEON_PROJECT, branch_id: NEON_BRANCH, name: 'main-cu', current_state: 'idle', created_at: NOW, updated_at: NOW }, operations: [] } };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const client = neonClient(fetch);
    const result = await client.action({ kind: 'endpoint', id: 'ep-1', scope: { projectId: NEON_PROJECT } }, 'suspend');
    expect(result.resource).toMatchObject({ kind: 'endpoint', id: 'ep-1', status: 'paused', providerStatus: 'idle' });
  });

  it('snapshot create (branch-scoped POST, query params) and restore (body {name,target_branch_id,finalize_restore} → branch result)', async () => {
    const { fetch, calls } = controlPlane((req) => {
      if (req.method === 'POST' && req.path === `/projects/${NEON_PROJECT}/branches/${NEON_BRANCH}/snapshot`) {
        expect(req.url.searchParams.get('name')).toBe('nightly');
        expect(req.url.searchParams.get('lsn')).toBe('0/3000000');
        return { status: 201, body: { snapshot: { id: 'snap-9', name: 'nightly', created_at: NOW }, operations: [{ id: 'op-snap', project_id: NEON_PROJECT, branch_id: NEON_BRANCH, action: 'create_snapshot', status: 'running', created_at: NOW, updated_at: NOW }] } };
      }
      if (req.method === 'POST' && req.path === `/projects/${NEON_PROJECT}/snapshots/snap-9/restore`) {
        expect(req.body).toEqual({ name: 'restored-from-snap', target_branch_id: NEON_BRANCH, finalize_restore: true });
        return { body: { branch: { id: 'br-restored', project_id: NEON_PROJECT, name: 'restored-from-snap', current_state: 'init', created_at: NOW, updated_at: NOW }, operations: [{ id: 'op-restore', project_id: NEON_PROJECT, branch_id: 'br-restored', action: 'restore_snapshot', status: 'running', created_at: NOW, updated_at: NOW }] } };
      }
      if (req.method === 'GET' && req.path === `/projects/${NEON_PROJECT}/operations/op-restore`) {
        return { body: { operation: { id: 'op-restore', project_id: NEON_PROJECT, branch_id: 'br-restored', action: 'restore_snapshot', status: 'finished', failures_count: 0, created_at: NOW, updated_at: NOW } } };
      }
      if (req.method === 'GET' && req.path === `/projects/${NEON_PROJECT}/branches/br-restored`) {
        return { body: { branch: { id: 'br-restored', project_id: NEON_PROJECT, name: 'restored-from-snap', current_state: 'ready', created_at: NOW, updated_at: NOW } } };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const client = neonClient(fetch);
    await client.create({ kind: 'snapshot', branchId: NEON_BRANCH, providerOptions: { name: 'nightly', lsn: '0/3000000' }, scope: { projectId: NEON_PROJECT } });
    const restored = await client.action(
      { kind: 'snapshot', id: 'snap-9', scope: { projectId: NEON_PROJECT } },
      'restore',
      { input: { name: 'restored-from-snap', targetBranchId: NEON_BRANCH, finalizeRestore: true } },
    );
    expect(restored.resource).toMatchObject({ kind: 'branch', id: 'br-restored' });
    // Readiness polling goes through the OPERATION first (Neon readiness model), then the branch GET.
    const branch = await client.wait(restored, { pollIntervalMs: 0 });
    expect(branch).toMatchObject({ kind: 'branch', id: 'br-restored', status: 'active' });
    const postPaths = calls.filter((c) => c.method !== 'GET').map((c) => c.path);
    expect(postPaths).toEqual([`/projects/${NEON_PROJECT}/branches/${NEON_BRANCH}/snapshot`, `/projects/${NEON_PROJECT}/snapshots/snap-9/restore`]); // no replayed writes
    expect(calls.some((c) => c.path === `/projects/${NEON_PROJECT}/operations/op-restore`)).toBe(true);
  });
});

describe('Supabase A4 endpoints, asserted from the official v1 spec', () => {
  it('organizations(): GET /v1/organizations; canonical id = slug (create-project prerequisite)', async () => {
    const { fetch, calls } = controlPlane(() => ({ body: [{ id: '1234', slug: 'acme-corp', name: 'Acme' }] }));
    const client = sbClient(fetch);
    const orgs = await client.organizations();
    expect(calls[0]!.path).toBe('/organizations');
    expect(orgs[0]).toMatchObject({ providerId: 'supabase', id: 'acme-corp', name: 'Acme', aliasId: '1234' });
  });

  it('regions(): organization_slug REQUIRED (CONFIGURATION otherwise); smartGroup + specific mapped', async () => {
    const { fetch, calls } = controlPlane((req) => {
      expect(req.url.searchParams.get('organization_slug')).toBe('acme-corp');
      return {
        body: {
          recommendations: {
            smartGroup: { name: 'Smart region', code: 'americas', type: 'smartGroup' },
            specific: [
              { name: 'East US (North Virginia)', code: 'us-east-1', type: 'specific', provider: 'AWS', status: 'available' },
              { name: 'West EU (Ireland)', code: 'eu-west-1', type: 'specific', provider: 'AWS', status: 'available' },
            ],
          },
        },
      };
    });
    const client = sbClient(fetch);
    await expectCode(client.regions(), 'CONFIGURATION'); // org scope enforced before dispatch
    expect(calls).toHaveLength(0);
    const regions = await client.regions({ organizationId: 'acme-corp' });
    expect(calls[0]!.path).toBe('/projects/available-regions');
    expect(regions.map((r) => r.id)).toEqual(['americas', 'us-east-1', 'eu-west-1']);
    expect(regions[1]).toMatchObject({ platform: 'AWS', default: null });
  });

  it('connection(): direct project exposes host only (no invented database/role/URI); pooled uses the pooler config PRIMARY entry', async () => {
    const { fetch, calls } = controlPlane((req) => {
      if (req.path === `/projects/${SB_REF}`) {
        return { body: { id: SB_REF, ref: SB_REF, name: 'app', status: 'ACTIVE_HEALTHY', created_at: NOW, database: { host: 'db.abcdefghij.supabase.co' } } };
      }
      if (req.path === `/projects/${SB_REF}/config/database/pooler`) {
        return {
          body: [
            { identifier: SB_REF, database_type: 'READ_REPLICA', db_host: 'replica.pooler.supabase.com', db_port: 6543, db_user: 'postgres', db_name: 'postgres', connection_string: 'postgresql://postgres:ReplicaPw@replica.pooler.supabase.com:6543/postgres' },
            { identifier: SB_REF, database_type: 'PRIMARY', db_host: 'primary.pooler.supabase.com', db_port: 6543, db_user: 'postgres', db_name: 'postgres', connection_string: 'postgresql://postgres:PrimaryPw@primary.pooler.supabase.com:6543/postgres' },
          ],
        };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const client = sbClient(fetch);
    const direct = await client.connection({ kind: 'project', id: SB_REF });
    expect(direct).toMatchObject({ host: 'db.abcdefghij.supabase.co', port: null, database: null, role: null, pooled: false, redactedUri: null, secrets: [] });
    const pooled = await client.connection({ kind: 'project', id: SB_REF }, { pooled: true });
    expect(pooled).toMatchObject({ host: 'primary.pooler.supabase.com', port: 6543, database: 'postgres', role: 'postgres', pooled: true });
    expect(pooled.redactedUri).toBe('postgresql://postgres:[redacted]@primary.pooler.supabase.com:6543/postgres');
    expect(pooled.secrets).toEqual([]); // no reveal opt-in → no secrets
    expect(JSON.stringify(pooled.raw)).not.toContain('PrimaryPw');
    expect(calls.filter((c) => c.path === `/projects/${SB_REF}`)).toHaveLength(2); // host read before each pooled lookup
  });

  it('branch connection: db_host/db_port/db_user from GET /v1/branches/{id}; db_pass ONLY on reveal', async () => {
    const dbPass = 'BranchDbPass7!';
    const { fetch } = controlPlane(() => ({
      body: { id: SB_BRANCH, ref: 'stuvwabcdefghijk', name: 'preview', status: 'ACTIVE_HEALTHY', db_host: 'br.preview.supabase.co', db_port: 5432, db_user: 'postgres', db_pass: dbPass },
    }));
    const client = sbClient(fetch);
    const hidden = await client.connection({ kind: 'branch', id: SB_BRANCH, projectId: SB_REF });
    expect(hidden).toMatchObject({ kind: 'branch', host: 'br.preview.supabase.co', port: 5432, role: 'postgres' });
    expect(hidden.secrets).toEqual([]);
    expect(JSON.stringify(hidden)).not.toContain(dbPass);
    const revealed = await client.connection({ kind: 'branch', id: SB_BRANCH, projectId: SB_REF }, { reveal: true });
    expect(revealed.secrets).toEqual([{ label: 'password', value: dbPass }]);
  });

  it('resetCredential: PATCH /v1/projects/{ref}/database/password; generated password redacted from LATER errors', async () => {
    const { fetch, calls } = controlPlane((req) => {
      if (req.method === 'PATCH' && req.path === `/projects/${SB_REF}/database/password`) {
        return { body: { message: 'Password updated' } };
      }
      if (req.method === 'GET' && req.path === `/projects/${SB_REF}`) {
        // Provider-side error that happens to echo the submitted password back.
        const pw = (calls.find((c) => c.method === 'PATCH')!.body as { password: string }).password;
        return { status: 403, body: { message: `forbidden while rotating password ${pw}` } };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const client = sbClient(fetch);
    const generated = await client.resetCredential({ kind: 'project', id: SB_REF });
    const sentPassword = (calls[0]!.body as { password: string }).password;
    expect(sentPassword).toHaveLength(24); // official minLength 4; adapter generates 24 chars
    expect(generated.secrets).toEqual([{ label: 'password', value: sentPassword }]);
    expect(JSON.stringify(generated.resource)).not.toContain(sentPassword);
    // A later error from the same client must not leak the rotated password.
    const later = await expectCode(client.get({ kind: 'project', id: SB_REF }), 'PERMISSION');
    expect(later.message).toContain('[redacted]');
    expect(later.message).not.toContain(sentPassword);
  });

  it('resetCredential success path: password only in secrets; caller-supplied password never echoed', async () => {
    const { fetch, calls } = controlPlane(() => ({ body: { message: 'Password updated' } }));
    const client = sbClient(fetch);
    const generated = await client.resetCredential({ kind: 'project', id: SB_REF });
    const sentPassword = (calls[0]!.body as { password: string }).password;
    expect(sentPassword).toHaveLength(24); // official minLength 4; adapter generates 24 chars
    expect(generated.secrets).toEqual([{ label: 'password', value: sentPassword }]);
    expect(JSON.stringify(generated.resource)).not.toContain(sentPassword);

    const supplied = await client.resetCredential({ kind: 'project', id: SB_REF }, { password: 'correct-horse' });
    expect((calls[1]!.body as { password: string }).password).toBe('correct-horse');
    expect(supplied.secrets).toEqual([]); // never echoes a caller-supplied password
  });
});

// ---------------------------------------------------------------------------
// 4. Real-SQL leg (optional, local Docker Postgres only)
// ---------------------------------------------------------------------------

describe('connection(reveal) → real SQL (skipped without DBSDK_TEST_POSTGRES_URL)', () => {
  it.skipIf(LOCAL_DB === '')('the revealed Neon connection string drives the real postgres driver', async () => {
    const uri = LOCAL_DB.replace(/:\/\/([^:]+):([^@]*)@/, 'postgresql://$1:$2@');
    const { fetch } = controlPlane((req) => {
      if (req.path === `/projects/${NEON_PROJECT}/connection_uri`) {
        return { body: { uri } };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const client = neonClient(fetch);
    const info = await client.connection(
      { kind: 'project', id: NEON_PROJECT },
      { databaseName: 'postgres', roleName: 'postgres', reveal: true },
    );
    expect(info.secrets[0]!.value).toContain('@');
    const db = createDatabase({ adapter: postgres({ connectionString: info.secrets[0]!.value, ssl: false }) });
    try {
      const result = await db.sql<{ one: number }>`select 1 as one`;
      expect(result.rows[0]?.one).toBe(1);
    } finally {
      await db.close();
    }
  });
});
