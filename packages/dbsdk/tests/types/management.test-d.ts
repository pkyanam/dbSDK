/**
 * Type-level checks for the management contract: known kinds keep autocomplete,
 * provider-defined kinds and scopes are accepted, and the client shape is stable.
 */

import { expectTypeOf, it } from 'vitest';

import type {
  CreateCustomSpec,
  CreateResourceSpec,
  ManagementAdapter,
  ManagementAdapterCapabilities,
  ManagementClient,
  ManagementConnectionInfo,
  ManagementListQuery,
  ManagementProviderId,
  ManagementResourceKind,
  ManagementSecret,
  ResourceRef,
} from '../../src/management/types.js';

it('accepts known create specs with literal kind typing', () => {
  const spec = { kind: 'project', name: 'app', region: 'us-east-1' } satisfies CreateResourceSpec;
  expectTypeOf(spec.kind).toEqualTypeOf<'project'>();
});

it('accepts provider-defined kinds and generic scopes', () => {
  const kind = 'deployment' as const;
  const custom = {
    kind,
    scope: { organization: 'org-1' },
    region: 'r1',
  } satisfies CreateCustomSpec;
  expectTypeOf(custom.kind).toEqualTypeOf<'deployment'>();
  const ref: ResourceRef = { kind: 'deployment', id: 'd-1', scope: { organization: 'org-1' } };
  expectTypeOf(ref.scope).toExtend<Record<string, string> | undefined>();
});

it('keeps known resource kinds assignable to the open kind type', () => {
  const known: ManagementResourceKind = 'database';
  const open: ManagementResourceKind = 'anything-provider-defined';
  expectTypeOf(known).toExtend<ManagementResourceKind>();
  expectTypeOf(open).toExtend<ManagementResourceKind>();
});

it('keeps the client verb surface stable', () => {
  type Client = ManagementClient<{ calls: unknown[] }>;
  expectTypeOf<Client['wait']>().toBeFunction();
  expectTypeOf<Client['raw']>().toEqualTypeOf<{ calls: unknown[] }>();
});

it('types list query scope first-class (A3): no runtime casts for scoped providers', () => {
  type Client = ManagementClient;
  // Branch and database lists take projectId/branchId directly on the typed query object.
  expectTypeOf<Client['list']>().parameter(1).toEqualTypeOf<ManagementListQuery | undefined>();
  const branchQuery: ManagementListQuery = { projectId: 'p-1', cursor: 'c', limit: 10 };
  expectTypeOf(branchQuery.projectId).toEqualTypeOf<string | undefined>();
  const databaseQuery: ManagementListQuery = { projectId: 'p-1', branchId: 'b-1' };
  expectTypeOf(databaseQuery.branchId).toEqualTypeOf<string | undefined>();
  const customQuery: ManagementListQuery = { scope: { organization: 'org-1' } };
  expectTypeOf(customQuery.scope).toExtend<Record<string, string> | undefined>();
});

it('declares statusPolling as optional per-kind lists on capabilities', () => {
  const capabilities: ManagementAdapterCapabilities = {
    resourceKinds: ['project', 'branch', 'database'],
    supported: { update: ['project'], delete: ['project'] },
    pagination: true,
    asyncOperations: false,
    statusPolling: ['project'],
    evidence: {},
    prerequisites: {},
  };
  expectTypeOf(capabilities.statusPolling).toEqualTypeOf<readonly ManagementResourceKind[] | undefined>();
});

// ---------------------------------------------------------------------------
// Amendment A4 — discovery, connection, actions, credentials
// ---------------------------------------------------------------------------

it('adds the A4 methods to the client surface as required members', () => {
  type Client = ManagementClient;
  expectTypeOf<Client['organizations']>().toBeFunction();
  expectTypeOf<Client['regions']>().toBeFunction();
  expectTypeOf<Client['connection']>().toBeFunction();
  expectTypeOf<Client['action']>().toBeFunction();
  expectTypeOf<Client['resetCredential']>().toBeFunction();
});

it('types connection() results as provider-selected-or-null with redacted URIs and opt-in secrets', async () => {
  type Client = ManagementClient;
  const fake = { connection: async () => null as unknown as ManagementConnectionInfo } as unknown as Client;
  const info = await fake.connection(
    { kind: 'project', id: 'p-1' },
    { databaseName: 'neondb', roleName: 'app_owner', pooled: true, reveal: true },
  );
  expectTypeOf(info.host).toEqualTypeOf<string | null>();
  expectTypeOf(info.port).toEqualTypeOf<number | null>();
  expectTypeOf(info.database).toEqualTypeOf<string | null>();
  expectTypeOf(info.role).toEqualTypeOf<string | null>();
  expectTypeOf(info.pooled).toEqualTypeOf<boolean | null>();
  expectTypeOf(info.redactedUri).toEqualTypeOf<string | null>();
  expectTypeOf(info.secrets).toEqualTypeOf<readonly ManagementSecret[]>();
  // Callers can narrow the credential out of secrets only after the explicit reveal opt-in.
  const credential = info.secrets[0];
  if (credential) expectTypeOf(credential.value).toEqualTypeOf<string>();
});

it('types A4 capability declarations as optional per-kind tables', () => {
  const capabilities: ManagementAdapterCapabilities = {
    resourceKinds: ['project', 'role'],
    supported: {
      update: ['project'],
      delete: ['project', 'role'],
      connection: ['project'],
      resetCredential: ['role'],
      actions: { pause: ['project'], restore: ['snapshot'] },
    },
    pagination: false,
    asyncOperations: false,
    evidence: {},
    prerequisites: {},
  };
  expectTypeOf(capabilities.supported.connection).toEqualTypeOf<readonly ManagementResourceKind[] | undefined>();
  expectTypeOf(capabilities.supported.resetCredential).toEqualTypeOf<readonly ManagementResourceKind[] | undefined>();
  expectTypeOf(capabilities.supported.actions).toEqualTypeOf<
    Readonly<Record<string, readonly ManagementResourceKind[]>> | undefined
  >();
});

it('keeps the A4 adapter methods optional so pre-A4 adapters still typecheck', () => {
  type Adapter = ManagementAdapter;
  expectTypeOf<Adapter['organizations']>().toEqualTypeOf<ManagementAdapter['organizations']>();
  // Absent is still valid: optional members.
  const partial: Pick<ManagementAdapter, 'id' | 'providerId' | 'capabilities' | 'create' | 'list' | 'get' | 'raw'> & {
    raw: Record<string, never>;
  } = {
    id: 'x',
    providerId: 'x',
    capabilities: {
      resourceKinds: ['project'],
      supported: { update: [], delete: [] },
      pagination: false,
      asyncOperations: false,
      evidence: {},
      prerequisites: {},
    },
    create: async () => ({ resource: null, operation: null, secrets: [], indeterminate: false }),
    list: async () => ({ kind: 'project', resources: [], cursor: null }),
    get: async () => ({ kind: 'project', providerId: 'x', id: 'p', name: null, region: null, status: 'unknown', providerStatus: null, createdAt: null, updatedAt: null, raw: {} }),
    raw: {},
  };
  expectTypeOf(partial.id).toEqualTypeOf<ManagementProviderId>();
});
