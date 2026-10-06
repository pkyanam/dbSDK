/**
 * Core management client tests — validation before dispatch, capability/scope gating,
 * error normalization, and the bounded GET-only wait() loop. All offline via the
 * fixture adapter; no network, no hosted mutations.
 */

import { describe, expect, it, vi } from 'vitest';

import { createManagement, describeManagementCapabilities } from '../../src/management/core.js';
import { ManagementError } from '../../src/management/errors.js';
import { createManagementFixture } from '../../src/management/testing.js';
import type {
  ManagementAdapter,
  ManagementOperation,
  ManagementResource,
  ResourceRef,
} from '../../src/management/types.js';

function projectResource(overrides: Partial<ManagementResource> = {}): ManagementResource {
  return {
    kind: 'project',
    providerId: 'test',
    id: 'p-123',
    name: 'my-app',
    region: 'us-east-1',
    status: 'active',
    providerStatus: 'ready',
    createdAt: '2026-10-06T00:00:00Z',
    updatedAt: null,
    raw: {},
    ...overrides,
  };
}

describe('adapter validation', () => {
  it('rejects adapters with mismatched id/providerId', () => {
    const { adapter } = createManagementFixture({ id: 'neon' });
    expect(() => createManagement({ adapter: { ...adapter, id: 'supabase' } })).toThrow(
      /providerId equal to its id/,
    );
  });

  it('rejects adapters missing required methods', () => {
    const { adapter } = createManagementFixture();
    const broken = { ...adapter, get: undefined } as unknown as typeof adapter;
    expect(() => createManagement({ adapter: broken })).toThrow(/implement create\(\), list\(\), and get\(\)/);
  });

  it('rejects declared capabilities without the implementing method', () => {
    const { adapter } = createManagementFixture();
    const broken = { ...adapter, delete: undefined } as unknown as typeof adapter;
    expect(() => createManagement({ adapter: broken })).toThrow(/does not implement delete\(\)/);
  });
});

describe('capability gating before dispatch', () => {
  it('refuses undeclared kinds without calling the adapter', async () => {
    const onCall = vi.fn();
    const { client } = createManagementFixture({
      capabilities: { resourceKinds: ['project'] },
      onCall,
    });
    const ref: ResourceRef = { kind: 'database', id: 'db', projectId: 'p', branchId: 'b' };
    const error = await client.get(ref).catch((e) => e);
    expect(error).toBeInstanceOf(ManagementError);
    expect((error as ManagementError).code).toBe('CAPABILITY');
    expect((error as ManagementError).message).toMatch(/'project'/);
    expect(onCall).not.toHaveBeenCalled();
  });

  it('refuses update/delete for kinds missing from the per-kind availability list', async () => {
    const { client } = createManagementFixture({
      capabilities: {
        resourceKinds: ['project', 'database'],
        supported: { update: ['project'], delete: ['project'] },
      },
    });
    const ref: ResourceRef = { kind: 'database', id: 'db', projectId: 'p', branchId: 'b' };
    const updateError = await client
      .update({ kind: 'database', id: 'db', projectId: 'p', branchId: 'b', patch: { name: 'x' } })
      .catch((e) => e);
    expect((updateError as ManagementError).code).toBe('CAPABILITY');
    const deleteError = await client.delete(ref).catch((e) => e);
    expect((deleteError as ManagementError).code).toBe('CAPABILITY');
  });

  it('refuses pagination arguments when the provider does not paginate', async () => {
    const { client } = createManagementFixture({
      capabilities: { pagination: false },
    });
    const error = await client.list('project', { limit: 10 }).catch((e) => e);
    expect((error as ManagementError).code).toBe('CAPABILITY');
    expect((error as ManagementError).message).toMatch(/does not paginate/);
  });

  it('validates list query values before dispatch', async () => {
    const { client } = createManagementFixture();
    await expect(client.list('project', { limit: 0 })).rejects.toMatchObject({ code: 'CONFIGURATION' });
    await expect(client.list('project', { cursor: '' })).rejects.toMatchObject({ code: 'CONFIGURATION' });
  });
});

describe('list query scope validation (A3)', () => {
  it('enforces the built-in scope rules for known kinds before dispatch', async () => {
    const { client } = createManagementFixture();
    // branch lists require projectId
    await expect(client.list('branch', {})).rejects.toMatchObject({ code: 'CONFIGURATION' });
    // database lists require projectId and branchId
    await expect(client.list('database', { projectId: 'p' })).rejects.toMatchObject({
      code: 'CONFIGURATION',
    });
    await expect(client.list('database', {})).rejects.toMatchObject({ code: 'CONFIGURATION' });
    // project lists are global and must not carry scope
    await expect(client.list('project', { projectId: 'p' })).rejects.toMatchObject({
      code: 'CONFIGURATION',
    });
    await expect(client.list('project', { scope: { org: 'o' } })).rejects.toMatchObject({
      code: 'CONFIGURATION',
    });
  });

  it('enforces resourceScopes for provider-defined kinds and passes valid queries through', async () => {
    const onCall = vi.fn();
    const { client } = createManagementFixture({
      capabilities: {
        resourceKinds: ['project', 'deployment'],
        resourceScopes: { deployment: ['organization', 'cluster'] },
      },
      onCall,
    });
    // missing declared scope fields -> CONFIGURATION before dispatch
    await expect(client.list('deployment', { scope: { organization: 'o' } })).rejects.toMatchObject({
      code: 'CONFIGURATION',
    });
    await expect(client.list('deployment', {})).rejects.toMatchObject({ code: 'CONFIGURATION' });
    // invalid scope values are refused
    await expect(
      client.list('deployment', { scope: { organization: 'o', cluster: '' } }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
    // valid query reaches the adapter verbatim
    const page = await client.list('deployment', { scope: { organization: 'o', cluster: 'c' } });
    expect(page.kind).toBe('deployment');
    expect(onCall).toHaveBeenCalledTimes(1);
    const call = onCall.mock.calls[0]![0] as { verb: string; query: unknown };
    expect(call.verb).toBe('list');
    expect(call.query).toEqual({ scope: { organization: 'o', cluster: 'c' } });
  });

  it('rejects scope on known-kind lists that must not carry it', async () => {
    const { client } = createManagementFixture();
    await expect(client.list('branch', { projectId: 'p', scope: { org: 'o' } })).rejects.toMatchObject(
      { code: 'CONFIGURATION' },
    );
    await expect(
      client.list('branch', { projectId: 'p', branchId: 'b' }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
    await expect(
      client.list('database', { projectId: 'p', branchId: 'b', scope: { extra: 'x' } }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
  });
});

describe('wait() readiness honesty (A3 statusPolling)', () => {
  it('refuses a bare ref of a kind without a pollable status, before any request', async () => {
    const onCall = vi.fn();
    const { client } = createManagementFixture({
      capabilities: { statusPolling: ['branch'] },
      onCall,
    });
    const error = await client
      .wait({ kind: 'project', id: 'p-1' }, { timeoutMs: 100, pollIntervalMs: 1 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ManagementError);
    expect((error as ManagementError).code).toBe('CAPABILITY');
    expect((error as ManagementError).message).toMatch(/no pollable status/);
    expect((error as ManagementError).message).toMatch(/'branch'/); // names the pollable kinds
    expect(onCall).not.toHaveBeenCalled();
  });

  it('still polls bare refs of kinds the adapter declares status-pollable', async () => {
    let polls = 0;
    const { client } = createManagementFixture({
      capabilities: { statusPolling: ['project'] },
      handlers: {
        get: async () =>
          projectResource({ status: polls++ === 0 ? 'creating' : 'active' }),
      },
    });
    const resource = await client.wait({ kind: 'project', id: 'p-123' }, {
      timeoutMs: 1_000,
      pollIntervalMs: 1,
    });
    expect(resource.status).toBe('active');
    expect(polls).toBe(2);
  });

  it('prefers operation polling: statusPolling refusal never blocks wait(writeResult)', async () => {
    const { client } = createManagementFixture({
      capabilities: { statusPolling: [] }, // no status anywhere; operations only
      handlers: {
        create: async () => ({
          resource: projectResource({ status: 'unknown' }),
          operation: {
            id: 'op-1',
            providerId: 'test',
            action: 'create',
            ref: { kind: 'project', id: 'p-123' },
            status: 'running',
            providerStatus: null,
            createdAt: null,
            finishedAt: null,
            error: null,
            raw: {},
          },
          secrets: [],
          indeterminate: false,
        }),
        getOperation: async () => ({
          id: 'op-1',
          providerId: 'test',
          action: 'create',
          ref: { kind: 'project', id: 'p-123' },
          status: 'completed',
          providerStatus: 'finished',
          createdAt: null,
          finishedAt: null,
          error: null,
          raw: {},
        }),
        get: async () => projectResource(),
      },
    });
    const created = await client.create({ kind: 'project', name: 'my-app' });
    const resource = await client.wait(created, { pollIntervalMs: 1 });
    expect(resource.status).toBe('active');
  });

  it('refuses malformed statusPolling declarations at construction', () => {
    expect(() =>
      createManagementFixture({ capabilities: { statusPolling: ['project', ''] } }),
    ).toThrow(/statusPolling must be an array/);
  });
});

describe('scope validation', () => {
  it('enforces the built-in scope rules for known kinds', async () => {
    const { client } = createManagementFixture();
    await expect(client.get({ kind: 'database', id: 'db' })).rejects.toMatchObject({
      code: 'CONFIGURATION',
    });
    await expect(
      client.get({ kind: 'database', id: 'db', projectId: 'p' }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
    await expect(
      client.get({ kind: 'branch', id: 'b', projectId: 'p', branchId: 'x' }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
    await expect(
      client.get({ kind: 'project', id: 'p', projectId: 'other' }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
    await expect(
      client.get({ kind: 'database', id: 'db', projectId: 'p', branchId: 'b' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' }); // passed validation, reached the adapter
  });

  it('enforces declared scopes for provider-defined kinds', async () => {
    const { client } = createManagementFixture({
      capabilities: {
        resourceKinds: ['project', 'deployment'],
        supported: { update: [], delete: [] },
        resourceScopes: { deployment: ['projectId'] },
      } as never,
    });
    await expect(client.get({ kind: 'deployment', id: 'd' })).rejects.toMatchObject({
      code: 'CONFIGURATION',
    });
    await expect(
      client.get({ kind: 'deployment', id: 'd', scope: { projectId: 'p' } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' }); // passed validation, reached the adapter
  });

  it('validates create specs, including custom kinds and providerOptions shape', async () => {
    const { client } = createManagementFixture();
    await expect(client.create({ kind: 'project', name: '' })).rejects.toMatchObject({
      code: 'CONFIGURATION',
    });
    await expect(
      client.create({ kind: 'branch', projectId: '', name: 'b' }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
    await expect(
      client.create({
        kind: 'database',
        projectId: 'p',
        name: 'db',
      } as never),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
    await expect(
      client.create({ kind: 'project', name: 'ok', providerOptions: ['bad'] } as never),
    ).rejects.toMatchObject({ code: 'CONFIGURATION' });
    await expect(
      client.create({ kind: 'deployment', region: 'r1' } as never),
    ).rejects.toMatchObject({ code: 'CAPABILITY' }); // kind not declared by this fixture
    // A custom kind the adapter DOES declare reaches the adapter (unscripted fixture mutation).
    const custom = createManagementFixture({
      capabilities: { resourceKinds: ['deployment'], supported: { update: [], delete: [] } },
    });
    await expect(custom.client.create({ kind: 'deployment', region: 'r1' } as never)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });
});

describe('error normalization', () => {
  it('wraps unknown adapter errors into ManagementError with context', async () => {
    const { client } = createManagementFixture({
      handlers: {
        get: async () => {
          throw new Error('socket exploded');
        },
      },
    });
    const error = await client.get({ kind: 'project', id: 'p' }).catch((e) => e);
    expect(error).toBeInstanceOf(ManagementError);
    expect((error as ManagementError).code).toBe('UNKNOWN');
    expect((error as ManagementError).message).toMatch(/socket exploded/);
    expect((error as ManagementError).resourceKind).toBe('project');
    expect((error as ManagementError).resourceId).toBe('p');
  });

  it('preserves normalized errors and fills in missing context', async () => {
    const { client } = createManagementFixture({
      handlers: {
        get: async () => {
          throw new ManagementError('rate limited', { code: 'RATE_LIMIT', retryAfterMs: 5000 });
        },
      },
    });
    const error = await client.get({ kind: 'project', id: 'p' }).catch((e) => e);
    expect((error as ManagementError).code).toBe('RATE_LIMIT');
    expect((error as ManagementError).adapterId).toBe('test');
    expect((error as ManagementError).retryAfterMs).toBe(5000);
  });
});

describe('wait()', () => {
  function runningOperation(ref: ResourceRef | null): ManagementOperation {
    return {
      id: 'op-1',
      providerId: 'test',
      action: 'create',
      ref,
      status: 'running',
      providerStatus: 'running',
      createdAt: null,
      finishedAt: null,
      error: null,
      raw: {},
    };
  }

  it('polls operations to completion then fetches the final resource (Neon-style)', async () => {
    let polls = 0;
    const ref: ResourceRef = { kind: 'project', id: 'p-123' };
    const { client } = createManagementFixture({
      handlers: {
        getOperation: async () => {
          polls += 1;
          const status = polls < 3 ? 'running' : 'completed';
          return {
            id: 'op-1',
            providerId: 'test',
            action: 'create',
            ref,
            status,
            providerStatus: status === 'completed' ? 'finished' : 'running',
            createdAt: null,
            finishedAt: null,
            error: null,
            raw: {},
          } satisfies ManagementOperation;
        },
        get: async () => projectResource(),
      },
    });
    const resource = await client.wait(runningOperation(ref), {
      timeoutMs: 2_000,
      pollIntervalMs: 1,
    });
    expect(polls).toBe(3);
    expect(resource.status).toBe('active');
    expect(resource.id).toBe('p-123');
  });

  it('throws PROVIDER with the operation error when an operation fails', async () => {
    const { client } = createManagementFixture({
      handlers: {
        getOperation: async () => ({
          id: 'op-1',
          providerId: 'test',
          action: 'create',
          ref: { kind: 'project', id: 'p' },
          status: 'failed',
          providerStatus: 'failed',
          createdAt: null,
          finishedAt: null,
          error: 'quota exceeded',
          raw: {},
        }),
      },
    });
    const error = await client
      .wait(runningOperation({ kind: 'project', id: 'p' }), { pollIntervalMs: 1 })
      .catch((e) => e);
    expect((error as ManagementError).code).toBe('PROVIDER');
    expect((error as ManagementError).message).toMatch(/quota exceeded/);
  });

  it('polls resource status when the provider has no operations API (Supabase-style)', async () => {
    const statuses: ManagementResource['status'][] = ['creating', 'creating', 'active'];
    const seen: Array<ManagementResource | ManagementOperation> = [];
    const { client } = createManagementFixture({
      capabilities: { asyncOperations: false },
      handlers: {
        get: async () => {
          const status = statuses.shift() ?? 'active';
          return projectResource({ status, providerStatus: status });
        },
      },
    });
    const resource = await client.wait(
      { kind: 'project', id: 'p-123' },
      { timeoutMs: 2_000, pollIntervalMs: 1, onStatus: (s) => seen.push(s) },
    );
    expect(resource.status).toBe('active');
    expect(seen).toHaveLength(3); // onStatus fires after every poll, including the terminal one
  });

  it('throws PROVIDER when a polled resource reaches failed state', async () => {
    const { client } = createManagementFixture({
      capabilities: { asyncOperations: false },
      handlers: {
        get: async () => projectResource({ status: 'failed', providerStatus: 'RESTORE_FAILED' }),
      },
    });
    const error = await client.wait({ kind: 'project', id: 'p-123' }, { pollIntervalMs: 1 }).catch(
      (e) => e,
    );
    expect((error as ManagementError).code).toBe('PROVIDER');
    expect((error as ManagementError).providerStatus).toBe('RESTORE_FAILED');
  });

  it('times out within the budget when nothing terminates', async () => {
    const { client } = createManagementFixture({
      handlers: {
        getOperation: async () => ({
          id: 'op-1',
          providerId: 'test',
          action: 'create',
          ref: null,
          status: 'running',
          providerStatus: 'running',
          createdAt: null,
          finishedAt: null,
          error: null,
          raw: {},
        }),
      },
    });
    const error = await client
      .wait(runningOperation(null), { timeoutMs: 30, pollIntervalMs: 5 })
      .catch((e) => e);
    expect((error as ManagementError).code).toBe('TIMEOUT');
  });

  it('honors caller aborts with ABORTED', async () => {
    const controller = new AbortController();
    let polls = 0;
    const { client } = createManagementFixture({
      handlers: {
        getOperation: async () => {
          polls += 1;
          if (polls >= 2) controller.abort();
          return {
            id: 'op-1',
            providerId: 'test',
            action: 'create',
            ref: null,
            status: 'running',
            providerStatus: 'running',
            createdAt: null,
            finishedAt: null,
            error: null,
            raw: {},
          };
        },
      },
    });
    const error = await client
      .wait(runningOperation(null), {
        timeoutMs: 5_000,
        pollIntervalMs: 5,
        signal: controller.signal,
      })
      .catch((e) => e);
    expect((error as ManagementError).code).toBe('ABORTED');
  });

  it('backs off on rate-limited polls using retryAfterMs and still completes', async () => {
    let attempts = 0;
    const { client } = createManagementFixture({
      handlers: {
        getOperation: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new ManagementError('slow down', { code: 'RATE_LIMIT', retryAfterMs: 5 });
          }
          return {
            id: 'op-1',
            providerId: 'test',
            action: 'create',
            ref: { kind: 'project', id: 'p-123' },
            status: 'completed',
            providerStatus: 'finished',
            createdAt: null,
            finishedAt: null,
            error: null,
            raw: {},
          };
        },
        get: async () => projectResource(),
      },
    });
    const resource = await client.wait(runningOperation({ kind: 'project', id: 'p-123' }), {
      timeoutMs: 2_000,
      pollIntervalMs: 1,
    });
    expect(attempts).toBe(2);
    expect(resource.status).toBe('active');
  });

  it('accepts a write result and never resubmits the mutation', async () => {
    const onCall = vi.fn();
    const { client } = createManagementFixture({
      handlers: {
        create: async () => ({
          resource: projectResource({ status: 'creating' }),
          operation: null,
          secrets: [{ label: 'password', value: 'generated' }],
          indeterminate: false,
        }),
        get: async () => projectResource(),
      },
      onCall,
    });
    const created = await client.create({ kind: 'project', name: 'my-app' });
    const resource = await client.wait(created, { timeoutMs: 2_000, pollIntervalMs: 1 });
    expect(resource.status).toBe('active');
    const verbs = onCall.mock.calls.map((call) => (call[0] as { verb: string }).verb);
    expect(verbs).toEqual(['create', 'get']); // wait() only issued a GET
  });
});

describe('results and metadata', () => {
  it('passes write results through, including indeterminate and secrets', async () => {
    const { client } = createManagementFixture({
      handlers: {
        create: async () => ({
          resource: projectResource(),
          operation: null,
          secrets: [{ label: 'password', value: 's3cret' }],
          indeterminate: true,
        }),
      },
    });
    const result = await client.create({ kind: 'project', name: 'my-app' });
    expect(result.indeterminate).toBe(true);
    expect(result.secrets[0]).toEqual({ label: 'password', value: 's3cret' });
    expect(result.resource?.id).toBe('p-123');
  });

  it('passes delete results through', async () => {
    const { client } = createManagementFixture({
      handlers: {
        delete: async () => ({ operation: null, indeterminate: false }),
      },
    });
    const result = await client.delete({ kind: 'project', id: 'p-123' });
    expect(result).toEqual({ operation: null, indeterminate: false });
  });

  it('describes capabilities from one structured source', () => {
    const { adapter } = createManagementFixture({
      capabilities: {
        resourceKinds: ['project', 'database'],
        supported: { update: ['project'], delete: [] },
        pagination: true,
        asyncOperations: false,
      },
      prerequisites: { 'create:project': ['organizationId'] },
    });
    const descriptor = describeManagementCapabilities(adapter);
    expect(descriptor.providerId).toBe('test');
    expect(descriptor.operations.create).toEqual(['project', 'database']);
    expect(descriptor.operations.update).toEqual(['project']);
    expect(descriptor.operations.delete).toEqual([]);
    expect(descriptor.asyncOperations).toBe(false);
    expect(descriptor.prerequisites['create:project']).toEqual(['organizationId']);
  });

  it('exposes the adapter statusPolling declaration (undefined when not declared)', () => {
    const declared = createManagementFixture({
      capabilities: { statusPolling: ['project'] },
    });
    expect(describeManagementCapabilities(declared.adapter).statusPolling).toEqual(['project']);
    // An adapter that declares nothing (no statusPolling key) keeps descriptor.statusPolling
    // undefined, so docs grids can distinguish "declared" from "not declared".
    const undeclaredAdapter = {
      id: 'bare',
      providerId: 'bare',
      capabilities: {
        resourceKinds: ['project'],
        supported: { update: [], delete: [] },
        pagination: false,
        asyncOperations: false,
        evidence: {},
        prerequisites: {},
      },
      create: async () => {
        throw new Error('not used');
      },
      list: async () => {
        throw new Error('not used');
      },
      get: async () => {
        throw new Error('not used');
      },
      raw: {},
    } satisfies ManagementAdapter;
    expect(describeManagementCapabilities(undeclaredAdapter).statusPolling).toBeUndefined();
  });
});
