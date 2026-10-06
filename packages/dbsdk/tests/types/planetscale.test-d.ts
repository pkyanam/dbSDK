/**
 * Type-level checks for the accepted PlanetScale Postgres public surface:
 * factory option typing, adapter raw shapes, management spec/ref typing with
 * the provider-defined `role` scope, and the capability descriptor stability.
 * Runtime behavior lives in tests/planetscale*.test.ts and the integration
 * suite; this file only pins the public types a consumer compiles against.
 */

import { expectTypeOf, it } from 'vitest';

import type { DatabaseAdapter } from '../../src/types.js';
import {
  planetscale,
  type PlanetScaleAdapterOptions,
  type PlanetScaleConnectionMode,
  type PlanetScaleRaw,
} from '../../src/planetscale.js';
import {
  planetscaleManagement,
  type PlanetScaleManagementOptions,
  type PlanetScaleManagementRaw,
} from '../../src/management/planetscale.js';
import type {
  CreateResourceSpec,
  ManagementAdapter,
  ManagementListQuery,
  ManagementProviderId,
  ResourceRef,
} from '../../src/management/types.js';

it('requires the connection string and a literal connection mode', () => {
  expectTypeOf<PlanetScaleAdapterOptions['connectionString']>().toEqualTypeOf<string>();
  expectTypeOf<PlanetScaleAdapterOptions['connectionMode']>().toEqualTypeOf<PlanetScaleConnectionMode>();
  expectTypeOf<PlanetScaleConnectionMode>().toEqualTypeOf<'direct' | 'pooled'>();
});

it('exposes the documented raw shape: pool, connectionMode, resolved connection', () => {
  expectTypeOf<PlanetScaleRaw>().toHaveProperty('pool');
  expectTypeOf<PlanetScaleRaw['connectionMode']>().toEqualTypeOf<PlanetScaleConnectionMode>();
  expectTypeOf<PlanetScaleRaw['resolved']>().toHaveProperty('host');
  expectTypeOf<PlanetScaleRaw['resolved']>().toHaveProperty('username');
});

it('returns a DatabaseAdapter over PlanetScaleRaw (createDatabase-compatible)', () => {
  const adapter = planetscale({ connectionString: 'postgresql://u:p@localhost:5432/db', connectionMode: 'direct' });
  expectTypeOf(adapter).toExtend<DatabaseAdapter<PlanetScaleRaw>>();
  expectTypeOf(adapter.engine).toEqualTypeOf<'postgresql'>();
});

it('requires both service token parts and accepts the optional organization', () => {
  expectTypeOf<PlanetScaleManagementOptions['tokenId']>().toEqualTypeOf<string>();
  expectTypeOf<PlanetScaleManagementOptions['tokenSecret']>().toEqualTypeOf<string>();
  expectTypeOf<PlanetScaleManagementOptions['organization']>().toEqualTypeOf<string | undefined>();
});

it('types provider ids, the provider-defined role scope, and scoped list queries', () => {
  const providerId: ManagementProviderId = 'planetscale';
  expectTypeOf(providerId).toExtend<ManagementProviderId>();
  const ref: ResourceRef = {
    kind: 'role',
    id: 'role-uid',
    projectId: 'app-db',
    branchId: 'main',
  };
  expectTypeOf(ref.scope).toExtend<Record<string, string> | undefined>();
  const query: ManagementListQuery = { projectId: 'app-db', branchId: 'main' };
  expectTypeOf(query.projectId).toEqualTypeOf<string | undefined>();
});

it('accepts the cluster_size create spec through providerOptions', () => {
  const spec = {
    kind: 'project',
    name: 'app-db',
    providerOptions: { cluster_size: 'PS-10-GP' },
  } satisfies CreateResourceSpec;
  expectTypeOf(spec.kind).toEqualTypeOf<'project'>();
  expectTypeOf(spec.providerOptions).toExtend<Record<string, unknown> | undefined>();
});

it('keeps the management adapter and raw escape-hatch surface stable', () => {
  const adapter = planetscaleManagement({ tokenId: 'id', tokenSecret: 'secret' });
  expectTypeOf(adapter).toExtend<ManagementAdapter<PlanetScaleManagementRaw>>();
  expectTypeOf<PlanetScaleManagementRaw>().toHaveProperty('clusterSizeSkus');
  expectTypeOf<PlanetScaleManagementRaw>().toHaveProperty('renewRole');
  expectTypeOf(adapter.id).toEqualTypeOf<ManagementProviderId>();

  const queryAdapter = planetscale({ connectionString: 'postgresql://u:p@localhost:5432/db', connectionMode: 'direct' });
  expectTypeOf(queryAdapter.id).toEqualTypeOf<string>();
  expectTypeOf(adapter.providerId).toEqualTypeOf<ManagementProviderId>();
});
