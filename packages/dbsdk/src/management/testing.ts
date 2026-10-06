/**
 * Fixture testing adapter for the management plane (`dbsdk/management/testing`).
 *
 * Deterministic handler-based scaffolding — NOT a simulator of any provider. It proves what the
 * core client does with the results, errors, and capabilities an adapter declares; it cannot
 * prove that a real provider API behaves a certain way (that is the job of each adapter's
 * recorded-HTTP tests and its read-only live checks).
 *
 * - Handlers are optional; unscripted verbs fail loudly (`NOT_FOUND` for get, empty page for
 *   list, `VALIDATION` for mutations) so accidental double-execution or forgotten scripts are
 *   caught instead of silently passing.
 * - Every call is recorded on `raw.calls` and forwarded to `onCall`.
 */

import { createManagement } from './core.js';
import { ManagementError } from './errors.js';
import type {
  CreateResourceSpec,
  ManagementActionOptions,
  ManagementAdapter,
  ManagementAdapterCapabilities,
  ManagementCallOptions,
  ManagementClient,
  ManagementConnectionInfo,
  ManagementConnectionInput,
  ManagementListQuery,
  ManagementOperation,
  ManagementOrganization,
  ManagementPage,
  ManagementProviderId,
  ManagementRegion,
  ManagementResource,
  ManagementResourceKind,
  ManagementWriteResult,
  ResetCredentialOptions,
  ResourceRef,
  UpdateResourceSpec,
} from './types.js';

export type RecordedManagementCall =
  | { verb: 'create'; spec: CreateResourceSpec }
  | { verb: 'list'; kind: ManagementResourceKind; query: ManagementListQuery }
  | { verb: 'get'; ref: ResourceRef }
  | { verb: 'update'; spec: UpdateResourceSpec }
  | { verb: 'delete'; ref: ResourceRef }
  | { verb: 'getOperation'; operation: ManagementOperation }
  // A4 verbs (recorded when exercised)
  | { verb: 'organizations' }
  | { verb: 'regions'; input: { organizationId?: string } }
  | { verb: 'connection'; ref: ResourceRef; input: ManagementConnectionInput }
  | { verb: 'action'; ref: ResourceRef; action: string; input: Record<string, unknown> | undefined }
  | { verb: 'resetCredential'; ref: ResourceRef; password: string | undefined };

export type ManagementFixtureHandlers = {
  create?: (spec: CreateResourceSpec, options?: ManagementCallOptions) => Promise<ManagementWriteResult>;
  list?: (
    kind: ManagementResourceKind,
    query: ManagementListQuery,
    options?: ManagementCallOptions,
  ) => Promise<ManagementPage>;
  get?: (ref: ResourceRef, options?: ManagementCallOptions) => Promise<ManagementResource>;
  update?: (spec: UpdateResourceSpec, options?: ManagementCallOptions) => Promise<ManagementWriteResult>;
  delete?: (ref: ResourceRef, options?: ManagementCallOptions) => Promise<ManagementDeleteResultFixture>;
  getOperation?: (
    operation: ManagementOperation,
    options?: ManagementCallOptions,
  ) => Promise<ManagementOperation>;
  // A4 handlers (optional; unscripted A4 verbs fail loudly like the others)
  organizations?: (options?: ManagementCallOptions) => Promise<readonly ManagementOrganization[]>;
  regions?: (
    input: { organizationId?: string },
    options?: ManagementCallOptions,
  ) => Promise<readonly ManagementRegion[]>;
  connection?: (
    ref: ResourceRef,
    input: ManagementConnectionInput,
    options?: ManagementCallOptions,
  ) => Promise<ManagementConnectionInfo>;
  action?: (
    ref: ResourceRef,
    action: string,
    options?: ManagementActionOptions,
  ) => Promise<ManagementWriteResult>;
  resetCredential?: (
    ref: ResourceRef,
    options?: ResetCredentialOptions,
  ) => Promise<ManagementWriteResult>;
};

// Re-exported alias so tests can name the delete handler result without importing two types.
export type ManagementDeleteResultFixture = {
  operation: ManagementOperation | null;
  indeterminate: boolean;
};

export type ManagementFixtureOptions = {
  /** Adapter/provider id. Defaults to `'test'` (the id is an open string by design). */
  id?: ManagementProviderId;
  /** Override declared capabilities. Merged over sensible defaults. */
  capabilities?: Partial<Omit<ManagementAdapterCapabilities, 'evidence' | 'prerequisites'>>;
  evidence?: Readonly<Record<string, ManagementAdapterCapabilities['evidence'][string]>>;
  prerequisites?: Readonly<Record<string, readonly string[]>>;
  handlers?: ManagementFixtureHandlers;
  onCall?: (call: RecordedManagementCall) => void;
};

export type ManagementFixture = {
  adapter: ManagementAdapter<{ calls: RecordedManagementCall[] }>;
  client: ManagementClient<{ calls: RecordedManagementCall[] }>;
};

const DEFAULT_CAPABILITIES: ManagementAdapterCapabilities = {
  resourceKinds: ['project', 'branch', 'database'],
  supported: { update: ['project', 'branch', 'database'], delete: ['project', 'branch', 'database'] },
  pagination: true,
  asyncOperations: true,
  // Fixture resources carry meaningful statuses by default (tests script them); an adapter can
  // override statusPolling to model providers whose kinds have no status field.
  statusPolling: ['project', 'branch', 'database'],
  evidence: { resourceKinds: 'tests' },
  prerequisites: {},
};

function unscriptedError(verb: string, detail: string): ManagementError {
  return new ManagementError(
    `management fixture: no handler scripted for ${verb} (${detail}). ` +
      'Unscripted behavior fails loudly so tests cannot pass by accident.',
    { code: 'VALIDATION', adapterId: 'test' },
  );
}

export function createManagementFixture(options: ManagementFixtureOptions = {}): ManagementFixture {
  const id = options.id ?? 'test';
  const calls: RecordedManagementCall[] = [];
  const record = (call: RecordedManagementCall): void => {
    calls.push(call);
    options.onCall?.(call);
  };
  const handlers = options.handlers ?? {};

  const adapter: ManagementAdapter<{ calls: RecordedManagementCall[] }> = {
    id,
    providerId: id,
    capabilities: {
      ...DEFAULT_CAPABILITIES,
      ...options.capabilities,
      evidence: { ...DEFAULT_CAPABILITIES.evidence, ...(options.evidence ?? {}) },
      prerequisites: { ...(options.prerequisites ?? {}) },
    },
    async create(spec, callOptions) {
      record({ verb: 'create', spec });
      if (!handlers.create) {
        throw unscriptedError('create', JSON.stringify(spec.kind));
      }
      return handlers.create(spec, callOptions);
    },
    async list(kind, query, callOptions) {
      record({ verb: 'list', kind, query });
      if (!handlers.list) {
        return { kind, resources: [], cursor: null };
      }
      return handlers.list(kind, query, callOptions);
    },
    async get(ref, callOptions) {
      record({ verb: 'get', ref });
      if (!handlers.get) {
        throw new ManagementError(
          `management fixture: no handler scripted for get (${JSON.stringify(ref)}).`,
          { code: 'NOT_FOUND', adapterId: id, resourceKind: ref.kind, resourceId: ref.id },
        );
      }
      return handlers.get(ref, callOptions);
    },
    async update(spec, callOptions) {
      record({ verb: 'update', spec });
      if (!handlers.update) {
        throw unscriptedError('update', JSON.stringify(spec.kind));
      }
      return handlers.update(spec, callOptions);
    },
    async delete(ref, callOptions) {
      record({ verb: 'delete', ref });
      if (!handlers.delete) {
        throw unscriptedError('delete', JSON.stringify(ref));
      }
      return handlers.delete(ref, callOptions);
    },
    async getOperation(operation, callOptions) {
      record({ verb: 'getOperation', operation });
      if (!handlers.getOperation) {
        throw unscriptedError('getOperation', operation.id);
      }
      return handlers.getOperation(operation, callOptions);
    },
    // A4 verbs: same recorded/handler pattern. Unscripted ones fail loudly like the others.
    async organizations(callOptions) {
      record({ verb: 'organizations' });
      if (!handlers.organizations) {
        throw unscriptedError('organizations', 'no handler');
      }
      return handlers.organizations(callOptions);
    },
    async regions(input, callOptions) {
      record({ verb: 'regions', input });
      if (!handlers.regions) {
        throw unscriptedError('regions', 'no handler');
      }
      return handlers.regions(input, callOptions);
    },
    async connection(ref, input, callOptions) {
      record({ verb: 'connection', ref, input });
      if (!handlers.connection) {
        throw unscriptedError('connection', JSON.stringify(ref));
      }
      return handlers.connection(ref, input, callOptions);
    },
    async action(ref, action, callOptions) {
      record({ verb: 'action', ref, action, input: callOptions?.input });
      if (!handlers.action) {
        throw unscriptedError('action', `${action} ${JSON.stringify(ref)}`);
      }
      return handlers.action(ref, action, callOptions);
    },
    async resetCredential(ref, callOptions) {
      record({ verb: 'resetCredential', ref, password: callOptions?.password });
      if (!handlers.resetCredential) {
        throw unscriptedError('resetCredential', JSON.stringify(ref));
      }
      return handlers.resetCredential(ref, callOptions);
    },
    raw: { get calls() { return calls; } },
  };

  return { adapter, client: createManagement({ adapter }) };
}
