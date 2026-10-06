/**
 * Type-level checks for the management contract: known kinds keep autocomplete,
 * provider-defined kinds and scopes are accepted, and the client shape is stable.
 */

import { expectTypeOf, it } from 'vitest';

import type {
  CreateCustomSpec,
  CreateResourceSpec,
  ManagementAdapterCapabilities,
  ManagementClient,
  ManagementListQuery,
  ManagementResourceKind,
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
