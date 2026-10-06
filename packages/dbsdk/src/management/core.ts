/**
 * The management client: `createManagement`. Wraps a management adapter with validation,
 * capability and scope checks (BEFORE any network request), error normalization, and the
 * bounded, GET-only `wait()`. There is no automatic retry of mutations, no central dbSDK
 * backend, and no silent mapping between provider resource models.
 *
 * The same capability declaration feeds pre-dispatch checks and `describeManagementCapabilities`
 * — the single structured metadata source for generated docs and provider capability tables.
 */

import {
  ManagementError,
  normalizeManagementError,
  type ManagementErrorContext,
} from './errors.js';
import type { EvidenceLevel } from '../types.js';
import type {
  CreateBranchSpec,
  CreateDatabaseSpec,
  CreateProjectSpec,
  CreateResourceSpec,
  ManagementAdapter,
  ManagementAdapterCapabilities,
  ManagementCallOptions,
  ManagementClient,
  ManagementListQuery,
  ManagementOperation,
  ManagementProviderId,
  ManagementResource,
  ManagementResourceKind,
  ManagementScope,
  ManagementWriteResult,
  ResourceRef,
  UpdateResourceSpec,
  WaitOptions,
  WaitTarget,
} from './types.js';

/** The kinds with built-in scope rules in the core client. */
const KNOWN_KINDS = new Set<string>(['project', 'branch', 'database']);

function configurationError(
  message: string,
  context: ManagementErrorContext = {},
): ManagementError {
  return new ManagementError(message, { code: 'CONFIGURATION', ...context });
}

function capabilityError(message: string, context: ManagementErrorContext): ManagementError {
  return new ManagementError(message, {
    code: 'CAPABILITY',
    retryable: false,
    indeterminate: false,
    ...context,
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validateAdapter(adapter: unknown): asserts adapter is ManagementAdapter {
  const a = adapter as Partial<ManagementAdapter> | null | undefined;
  if (typeof a !== 'object' || a === null) {
    throw configurationError('createManagement requires an adapter object.');
  }
  if (typeof a.id !== 'string' || a.id.length === 0) {
    throw configurationError('Management adapter must have a non-empty string id.');
  }
  if (a.providerId !== a.id) {
    throw configurationError(
      `Management adapter "${a.id}" must declare providerId equal to its id.`,
    );
  }
  if (typeof a.create !== 'function' || typeof a.list !== 'function' || typeof a.get !== 'function') {
    throw configurationError(
      `Management adapter "${a.id}" must implement create(), list(), and get().`,
    );
  }
  if (typeof a.capabilities !== 'object' || a.capabilities === null) {
    throw configurationError(`Management adapter "${a.id}" must declare capabilities.`);
  }
  const capabilities = a.capabilities as Partial<ManagementAdapterCapabilities> | null;
  if (
    !Array.isArray(capabilities?.resourceKinds) ||
    capabilities.resourceKinds.length === 0 ||
    capabilities.resourceKinds.some((kind) => typeof kind !== 'string' || kind.length === 0)
  ) {
    throw configurationError(
      `Management adapter "${a.id}" has malformed capabilities: resourceKinds must be a ` +
        'non-empty array of non-empty kind strings.',
    );
  }
  const supported = capabilities?.supported;
  if (
    typeof supported !== 'object' ||
    supported === null ||
    !Array.isArray(supported.update) ||
    !Array.isArray(supported.delete) ||
    [...supported.update, ...supported.delete].some(
      (kind) => typeof kind !== 'string' || kind.length === 0,
    )
  ) {
    throw configurationError(
      `Management adapter "${a.id}" has malformed capabilities: supported must declare the ` +
        'kinds that support update and delete as arrays.',
    );
  }
  for (const flag of ['pagination', 'asyncOperations'] as const) {
    if (typeof capabilities?.[flag] !== 'boolean') {
      throw configurationError(
        `Management adapter "${a.id}" has malformed capabilities: ${flag} must be a boolean.`,
      );
    }
  }
  if (typeof capabilities?.evidence !== 'object' || capabilities.evidence === null) {
    throw configurationError(
      `Management adapter "${a.id}" has malformed capabilities: evidence must be an object.`,
    );
  }
  if (typeof capabilities?.prerequisites !== 'object' || capabilities.prerequisites === null) {
    throw configurationError(
      `Management adapter "${a.id}" has malformed capabilities: prerequisites must be an object.`,
    );
  }
  // A declared capability implies the implementing method exists (CONFIGURATION, not a late TypeError).
  if (supported.update.length > 0 && typeof a.update !== 'function') {
    throw configurationError(
      `Management adapter "${a.id}" declares updatable kinds but does not implement update().`,
    );
  }
  if (supported.delete.length > 0 && typeof a.delete !== 'function') {
    throw configurationError(
      `Management adapter "${a.id}" declares deletable kinds but does not implement delete().`,
    );
  }
  if (capabilities.asyncOperations === true && typeof a.getOperation !== 'function') {
    throw configurationError(
      `Management adapter "${a.id}" declares asyncOperations but does not implement getOperation().`,
    );
  }
  if (
    capabilities?.statusPolling !== undefined &&
    (!Array.isArray(capabilities.statusPolling) ||
      capabilities.statusPolling.some((kind) => typeof kind !== 'string' || kind.length === 0))
  ) {
    throw configurationError(
      `Management adapter "${a.id}" has malformed capabilities: statusPolling must be an array ` +
        'of non-empty kind strings when provided.',
    );
  }
  // A4 optional per-kind declarations (connection / resetCredential / actions).
  for (const flag of ['connection', 'resetCredential'] as const) {
    const kinds = capabilities?.supported?.[flag];
    if (kinds !== undefined) {
      if (!Array.isArray(kinds) || kinds.some((kind) => typeof kind !== 'string' || kind.length === 0)) {
        throw configurationError(
          `Management adapter "${a.id}" has malformed capabilities: supported.${flag} must be ` +
            'an array of non-empty kind strings when provided.',
        );
      }
      // A declared capability implies the implementing method exists (CONFIGURATION, not a late TypeError).
      if (kinds.length > 0 && typeof a[flag] !== 'function') {
        throw configurationError(
          `Management adapter "${a.id}" declares supported.${flag} kinds but does not implement ` +
            `${flag}().`,
        );
      }
    }
  }
  const actions = capabilities?.supported?.actions;
  if (actions !== undefined) {
    if (
      typeof actions !== 'object' ||
      actions === null ||
      Object.entries(actions).some(
        ([name, kinds]) =>
          typeof name !== 'string' ||
          name.length === 0 ||
          !Array.isArray(kinds) ||
          kinds.some((kind) => typeof kind !== 'string' || kind.length === 0),
      )
    ) {
      throw configurationError(
        `Management adapter "${a.id}" has malformed capabilities: supported.actions must be a ` +
          'record of action name -> array of non-empty kind strings when provided.',
      );
    }
    if (Object.keys(actions).length > 0 && typeof a.action !== 'function') {
      throw configurationError(
        `Management adapter "${a.id}" declares supported.actions but does not implement action().`,
      );
    }
  }
}

/**
 * Validate a resource reference's kind/scope coherence before dispatch. Built-in kinds have
 * fixed rules (`project`: no scope; `branch`: requires `projectId`; `database`: requires
 * `projectId` + `branchId`); provider-defined kinds use the adapter's `resourceScopes`
 * declaration, or pass through unvalidated when the adapter declares none.
 */
function validateRef(
  ref: ResourceRef,
  resourceScopes?: ManagementAdapterCapabilities['resourceScopes'],
): ManagementErrorContext {
  const context: ManagementErrorContext = { resourceKind: ref.kind, resourceId: ref.id };
  if (typeof ref.kind !== 'string' || ref.kind.length === 0) {
    throw configurationError('A resource reference requires a non-empty kind.');
  }
  if (typeof ref.id !== 'string' || ref.id.length === 0) {
    throw configurationError(`${ref.kind} references require a non-empty id.`, context);
  }
  if (ref.scope !== undefined) {
    if (!isPlainObject(ref.scope)) {
      throw configurationError('scope must be a plain object of string values.', context);
    }
    for (const [key, value] of Object.entries(ref.scope)) {
      if (typeof value !== 'string' || value.length === 0) {
        throw configurationError(`scope.${key} must be a non-empty string.`, context);
      }
    }
  }

  if (!KNOWN_KINDS.has(ref.kind)) {
    const required = resourceScopes?.[ref.kind];
    if (required !== undefined) {
      if (!Array.isArray(required) || required.some((f) => typeof f !== 'string' || f === '')) {
        throw configurationError(
          `resourceScopes['${ref.kind}'] must be an array of scope field names.`,
        );
      }
      // Provider-defined kinds carry their scope exclusively in `ref.scope`; the first-class
      // projectId/branchId fields belong to the known kinds only.
      for (const field of required) {
        const value = ref.scope?.[field];
        if (typeof value !== 'string' || value === '') {
          throw configurationError(
            `${ref.kind} references require the scope field '${field}'.`,
            context,
          );
        }
      }
    }
    return context;
  }

  switch (ref.kind) {
    case 'project':
      if (ref.projectId !== undefined || ref.branchId !== undefined || ref.scope !== undefined) {
        throw configurationError(
          'project references are global and must not carry projectId, branchId, or scope.',
          context,
        );
      }
      break;
    case 'branch':
      if (typeof ref.projectId !== 'string' || ref.projectId.length === 0) {
        throw configurationError('branch references require projectId.', context);
      }
      if (ref.branchId !== undefined || ref.scope !== undefined) {
        throw configurationError('branch references must not carry branchId or scope.', context);
      }
      break;
    case 'database':
      if (typeof ref.projectId !== 'string' || ref.projectId.length === 0) {
        throw configurationError('database references require projectId.', context);
      }
      if (typeof ref.branchId !== 'string' || ref.branchId.length === 0) {
        throw configurationError(
          'database references require branchId (e.g. Neon databases live on a branch).',
          context,
        );
      }
      if (ref.scope !== undefined) {
        throw configurationError('database references must not carry extra scope.', context);
      }
      break;
  }
  return context;
}

function checkProviderOptions(value: unknown, context: ManagementErrorContext): void {
  if (value !== undefined && !isPlainObject(value)) {
    throw configurationError('providerOptions must be a plain JSON object.', context);
  }
}

/**
 * Validate a list query's scope fields before dispatch, with the same rules as
 * {@link validateRef} (Amendment A3): known kinds carry first-class `projectId`/`branchId`
 * (`project`: none; `branch`: requires `projectId`; `database`: requires both), provider-defined
 * kinds read `scope` exclusively per the adapter's `resourceScopes` declaration.
 */
function validateListQuery(
  kind: ManagementResourceKind,
  query: ManagementListQuery,
  resourceScopes?: ManagementAdapterCapabilities['resourceScopes'],
): void {
  const context: ManagementErrorContext = { resourceKind: kind };
  if (!isPlainObject(query)) {
    throw configurationError('list query must be a plain object.', context);
  }
  if (query.scope !== undefined) {
    if (!isPlainObject(query.scope)) {
      throw configurationError('scope must be a plain object of string values.', context);
    }
    for (const [key, value] of Object.entries(query.scope)) {
      if (typeof value !== 'string' || value.length === 0) {
        throw configurationError(`scope.${key} must be a non-empty string.`, context);
      }
    }
  }
  if (!KNOWN_KINDS.has(kind)) {
    const required = resourceScopes?.[kind];
    if (required !== undefined) {
      if (!Array.isArray(required) || required.some((f) => typeof f !== 'string' || f === '')) {
        throw configurationError(
          `resourceScopes['${kind}'] must be an array of scope field names.`,
        );
      }
      for (const field of required) {
        const value = query.scope?.[field];
        if (typeof value !== 'string' || value === '') {
          throw configurationError(
            `list('${kind}') requires the scope field '${field}'.`,
            context,
          );
        }
      }
    }
    return;
  }
  switch (kind) {
    case 'project':
      if (query.projectId !== undefined || query.branchId !== undefined || query.scope !== undefined) {
        throw configurationError(
          "list('project') is global and must not carry projectId, branchId, or scope.",
          context,
        );
      }
      break;
    case 'branch':
      if (typeof query.projectId !== 'string' || query.projectId.length === 0) {
        throw configurationError(
          "list('branch') requires projectId (scoped lists are addressed by path, e.g. " +
            'GET /projects/{projectId}/branches).',
          context,
        );
      }
      if (query.branchId !== undefined || query.scope !== undefined) {
        throw configurationError(
          "list('branch') must not carry branchId or scope.",
          context,
        );
      }
      break;
    case 'database':
      if (typeof query.projectId !== 'string' || query.projectId.length === 0) {
        throw configurationError("list('database') requires projectId.", context);
      }
      if (typeof query.branchId !== 'string' || query.branchId.length === 0) {
        throw configurationError(
          "list('database') requires branchId (e.g. Neon databases live on a branch).",
          context,
        );
      }
      if (query.scope !== undefined) {
        throw configurationError(
          "list('database') must not carry extra scope.",
          context,
        );
      }
      break;
  }
}

function validateCreateSpec(spec: CreateResourceSpec): void {
  if (!isPlainObject(spec)) {
    throw configurationError('Management specs must be plain objects.');
  }
  switch (spec.kind) {
    case 'project': {
      const project = spec as CreateProjectSpec;
      const context: ManagementErrorContext = { resourceKind: 'project' };
      if (typeof project.name !== 'string' || project.name.length === 0) {
        throw configurationError('Project creation requires a non-empty name.', context);
      }
      checkProviderOptions(project.providerOptions, context);
      return;
    }
    case 'branch': {
      const branch = spec as CreateBranchSpec;
      const context: ManagementErrorContext = { resourceKind: 'branch' };
      if (typeof branch.projectId !== 'string' || branch.projectId.length === 0) {
        throw configurationError('Creating a branch requires projectId.', context);
      }
      if (branch.name !== undefined && (typeof branch.name !== 'string' || branch.name.length === 0)) {
        throw configurationError('Branch name must be a non-empty string when provided.', context);
      }
      checkProviderOptions(branch.providerOptions, context);
      return;
    }
    case 'database': {
      const database = spec as CreateDatabaseSpec;
      const context: ManagementErrorContext = { resourceKind: 'database' };
      if (typeof database.projectId !== 'string' || database.projectId.length === 0) {
        throw configurationError('Creating a database requires projectId.', context);
      }
      if (typeof database.branchId !== 'string' || database.branchId.length === 0) {
        throw configurationError(
          'Creating a database requires branchId (e.g. Neon databases live on a branch).',
          context,
        );
      }
      if (typeof database.name !== 'string' || database.name.length === 0) {
        throw configurationError('Database creation requires a non-empty name.', context);
      }
      checkProviderOptions(database.providerOptions, context);
      return;
    }
    default: {
      // Provider-defined kind: fields are provider-defined; the adapter validates them.
      const custom = spec as { kind: ManagementResourceKind; providerOptions?: unknown };
      const context: ManagementErrorContext = { resourceKind: custom.kind };
      checkProviderOptions(custom.providerOptions, context);
      return;
    }
  }
}

function validateUpdateSpec(
  spec: UpdateResourceSpec,
  resourceScopes?: ManagementAdapterCapabilities['resourceScopes'],
): void {
  if (!isPlainObject(spec)) {
    throw configurationError('Management specs must be plain objects.');
  }
  const context = validateRef(
    {
      kind: spec.kind,
      id: spec.id,
      projectId: spec.projectId,
      branchId: spec.branchId,
      scope: spec.scope,
    },
    resourceScopes,
  );
  if (!isPlainObject(spec.patch)) {
    throw configurationError('update patch must be a plain object.', context);
  }
  checkProviderOptions(spec.patch.providerOptions, context);
}

function isWriteResult(target: WaitTarget): target is ManagementWriteResult {
  return 'secrets' in (target as object);
}

function isOperation(target: WaitTarget): target is ManagementOperation {
  return 'action' in (target as object) && !('secrets' in (target as object));
}

function refFromResource(resource: ManagementResource): ResourceRef {
  return {
    kind: resource.kind,
    id: resource.id,
    ...(resource.projectId !== undefined ? { projectId: resource.projectId } : {}),
    ...(resource.branchId !== undefined ? { branchId: resource.branchId } : {}),
    ...(resource.scope !== undefined ? { scope: resource.scope } : {}),
  };
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const makeAbortError = () =>
      new ManagementError('wait() was aborted.', { code: 'ABORTED' });
    const onAbort = () => {
      cleanup();
      reject(makeAbortError());
    };
    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(makeAbortError());
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function createManagement<TAdapter extends ManagementAdapter>(options: {
  adapter: TAdapter;
}): ManagementClient<TAdapter['raw']> {
  validateAdapter(options.adapter);
  const adapter = options.adapter;
  const capabilities = adapter.capabilities;
  const adapterId: ManagementProviderId = adapter.id;

  function assertKind(kind: ManagementResourceKind, verb: string): ManagementErrorContext {
    const context: ManagementErrorContext = { adapterId, resourceKind: kind };
    if (!capabilities.resourceKinds.includes(kind)) {
      throw capabilityError(
        `${verb} is not supported for kind '${kind}' by the '${adapterId}' adapter. ` +
          `Declared kinds: ${capabilities.resourceKinds.map((k) => `'${k}'`).join(', ')}.`,
        context,
      );
    }
    return context;
  }

  function assertSupported(kind: ManagementResourceKind, verb: 'update' | 'delete'): void {
    if (!capabilities.supported[verb].includes(kind) || typeof adapter[verb] !== 'function') {
      throw capabilityError(
        `${verb} is not supported for kind '${kind}' by the '${adapterId}' adapter. ` +
          `Kinds supporting ${verb}: ` +
          (capabilities.supported[verb].length === 0
            ? 'none'
            : capabilities.supported[verb].map((k) => `'${k}'`).join(', ')) +
          '.',
        { adapterId, resourceKind: kind },
      );
    }
  }

  async function run<T>(context: ManagementErrorContext, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw normalizeManagementError(error, context);
    }
  }

  const client: ManagementClient<TAdapter['raw']> = {
    providerId: adapter.providerId,
    adapterId,
    capabilities,
    ...createA4Methods(adapter, capabilities, adapterId, run),

    async create(spec, callOptions) {
      validateCreateSpec(spec);
      const context: ManagementErrorContext = assertKind(spec.kind, 'create');
      return run(context, () => adapter.create(spec, callOptions));
    },

    async list(kind, query = {}, callOptions) {
      const context: ManagementErrorContext = assertKind(kind, 'list');
      validateListQuery(kind, query, capabilities.resourceScopes);
      if (!capabilities.pagination && (query.cursor !== undefined || query.limit !== undefined)) {
        throw capabilityError(
          `list('${kind}') was called with cursor/limit, but the '${adapterId}' provider does ` +
            'not paginate this list endpoint. Omit cursor and limit; the full list is returned.',
          context,
        );
      }
      if (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor === '')) {
        throw configurationError('list cursor must be a non-empty string when provided.', context);
      }
      if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1)) {
        throw configurationError('list limit must be a positive integer.', context);
      }
      return run(context, () => adapter.list(kind, query, callOptions));
    },

    async get(ref, callOptions) {
      const context: ManagementErrorContext = {
        ...validateRef(ref, capabilities.resourceScopes),
        ...assertKind(ref.kind, 'get'),
      };
      return run(context, () => adapter.get(ref, callOptions));
    },

    async update(spec, callOptions) {
      validateUpdateSpec(spec, capabilities.resourceScopes);
      const context: ManagementErrorContext = assertKind(spec.kind, 'update');
      assertSupported(spec.kind, 'update');
      return run(context, () => adapter.update!(spec, callOptions));
    },

    async delete(ref, callOptions) {
      const context: ManagementErrorContext = {
        ...validateRef(ref, capabilities.resourceScopes),
        ...assertKind(ref.kind, 'delete'),
      };
      assertSupported(ref.kind, 'delete');
      return run(context, () => adapter.delete!(ref, callOptions));
    },

    async wait(target, waitOptions = {}) {
      // Resolve the wait target into a pollable operation and/or a resource reference.
      let operation: ManagementOperation | null = null;
      let ref: ResourceRef | null = null;
      if (isWriteResult(target)) {
        operation = target.operation;
        ref = target.operation?.ref ?? (target.resource ? refFromResource(target.resource) : null);
      } else if (isOperation(target)) {
        operation = target;
        ref = target.ref;
      } else {
        ref = target;
      }
      if (ref) validateRef(ref, capabilities.resourceScopes);
      if (!operation && !ref) {
        throw configurationError(
          'wait() needs a write result, an operation, or a resource reference it can poll.',
        );
      }

      const canPollOperations =
        operation !== null && capabilities.asyncOperations && typeof adapter.getOperation === 'function';
      if (!canPollOperations && !ref) {
        throw configurationError(
          `The '${adapterId}' adapter has no operations API and the operation carries no ` +
            'resource reference to poll; pass a ResourceRef to wait().',
        );
      }
      // Honest readiness refusal (Amendment A3): when there is no operation to poll, wait() can
      // only poll the resource's status. If the adapter declares that this kind has no pollable
      // status (e.g. Neon projects and databases, whose readiness is operation-based), waiting
      // on a bare reference could only end in the timeout budget — refuse it up front instead.
      if (!canPollOperations && ref) {
        const statusPolling = capabilities.statusPolling;
        if (statusPolling !== undefined && !statusPolling.includes(ref.kind)) {
          throw capabilityError(
            `wait() cannot resolve a bare '${ref.kind}' reference with the '${adapterId}' adapter: ` +
              "that kind has no pollable status field, so polling would only end at the timeout " +
              'budget. Pass the create/update result or its operation so wait() can poll the ' +
              `provider's operations. Kinds with pollable status: ` +
              (statusPolling.length === 0 ? 'none' : statusPolling.map((k) => `'${k}'`).join(', ')) +
              '.',
            { adapterId, resourceKind: ref.kind, resourceId: ref.id },
          );
        }
      }

      const timeoutMs = waitOptions.timeoutMs ?? 300_000;
      const pollIntervalMs = waitOptions.pollIntervalMs ?? 2_000;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw configurationError('wait() timeoutMs must be a positive number.');
      }
      if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
        throw configurationError('wait() pollIntervalMs must be zero or a positive number.');
      }
      const deadline = Date.now() + timeoutMs;
      const callOptions: ManagementCallOptions = { signal: waitOptions.signal };

      for (;;) {
        try {
          if (canPollOperations) {
            const current = operation as ManagementOperation;
            const op = await run({ adapterId }, () => adapter.getOperation!(current, callOptions));
            if (op.ref) ref = op.ref; // keep the freshest scope for the final get()
            waitOptions.onStatus?.(op);
            if (op.status === 'failed') {
              throw new ManagementError(
                `The provider operation '${op.id}' failed${op.error ? `: ${op.error}` : '.'}`,
                {
                  code: 'PROVIDER',
                  adapterId,
                  providerStatus: op.providerStatus ?? undefined,
                  resourceKind: ref?.kind,
                  resourceId: ref?.id,
                },
              );
            }
            if (op.status === 'completed') {
              if (!ref) {
                throw configurationError(
                  'The operation completed but carries no resource reference; pass a ResourceRef to wait().',
                );
              }
              return await run(
                { adapterId, resourceKind: ref.kind, resourceId: ref.id },
                () => adapter.get(ref as ResourceRef, callOptions),
              );
            }
          } else {
            const pollRef = ref as ResourceRef;
            const resource = await run(
              { adapterId, resourceKind: pollRef.kind, resourceId: pollRef.id },
              () => adapter.get(pollRef, callOptions),
            );
            waitOptions.onStatus?.(resource);
            if (resource.status === 'active') return resource;
            if (resource.status === 'failed') {
              throw new ManagementError(
                `The resource '${resource.id}' reached a failed state` +
                  `${resource.providerStatus ? ` (${resource.providerStatus})` : '.'}`,
                {
                  code: 'PROVIDER',
                  adapterId,
                  providerStatus: resource.providerStatus ?? undefined,
                  resourceKind: pollRef.kind,
                  resourceId: pollRef.id,
                },
              );
            }
          }
        } catch (error) {
          // Rate-limited polls are retried after the provider's own hint — reads only, bounded
          // by the same overall budget. Every other poll error propagates immediately.
          if (
            error instanceof ManagementError &&
            error.code === 'RATE_LIMIT' &&
            error.retryAfterMs !== undefined &&
            Date.now() + error.retryAfterMs < deadline
          ) {
            await sleep(Math.min(error.retryAfterMs, deadline - Date.now()), waitOptions.signal);
            continue;
          }
          throw error;
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new ManagementError(
            `wait() exceeded its ${timeoutMs}ms budget without reaching a terminal state.`,
            { code: 'TIMEOUT', adapterId },
          );
        }
        await sleep(Math.min(pollIntervalMs, remaining), waitOptions.signal);
      }
    },

    raw: adapter.raw,
  };

  return client;
}

/**
 * A4 client members (discovery, connections, actions, credentials). Built as a factory over the
 * already-validated adapter so the gating closures share the capability table.
 */
function createA4Methods<TAdapter extends ManagementAdapter>(
  adapter: TAdapter,
  capabilities: ManagementAdapterCapabilities,
  adapterId: ManagementProviderId,
  run: <T>(context: ManagementErrorContext, fn: () => Promise<T>) => Promise<T>,
): Pick<ManagementClient<TAdapter['raw']>, 'organizations' | 'regions' | 'connection' | 'action' | 'resetCredential'> {
  return {
    async organizations(callOptions) {
      if (typeof adapter.organizations !== 'function') {
        throw capabilityError(
          `organizations is not supported by the '${adapterId}' adapter: the provider has no ` +
            'organization discovery endpoint implemented here. Use the adapter\'s raw escape ' +
            'hatch or its documented prerequisite fields instead.',
          { adapterId },
        );
      }
      return run({ adapterId }, () => adapter.organizations!(callOptions));
    },

    async regions(input = {}, callOptions) {
      if (typeof adapter.regions !== 'function') {
        throw capabilityError(
          `regions is not supported by the '${adapterId}' adapter: no region discovery endpoint ` +
            'is implemented here.',
          { adapterId },
        );
      }
      if (
        input.organizationId !== undefined &&
        (typeof input.organizationId !== 'string' || input.organizationId === '')
      ) {
        throw configurationError('regions input.organizationId must be a non-empty string when provided.');
      }
      return run({ adapterId }, () => adapter.regions!(input, callOptions));
    },

    async connection(ref, input = {}, callOptions) {
      const refContext = validateRef(ref, capabilities.resourceScopes);
      const supported = capabilities.supported.connection;
      if (supported === undefined || !supported.includes(ref.kind)) {
        throw capabilityError(
          `connection is not supported for kind '${ref.kind}' by the '${adapterId}' adapter.` +
            (supported === undefined
              ? ' The adapter declares no connection capability.'
              : ` Kinds supporting connection: ${supported.map((k) => `'${k}'`).join(', ')}.`),
          { adapterId, ...refContext },
        );
      }
      if (typeof adapter.connection !== 'function') {
        throw capabilityError(`connection is not implemented by the '${adapterId}' adapter.`, {
          adapterId,
          ...refContext,
        });
      }
      return run(refContext, () => adapter.connection!(ref, input, callOptions));
    },

    async action(ref, action, actionOptions = {}) {
      const refContext = validateRef(ref, capabilities.resourceScopes);
      const actions = capabilities.supported.actions;
      const kinds = actions?.[action];
      if (actions === undefined || kinds === undefined || !kinds.includes(ref.kind)) {
        const declared = actions === undefined ? [] : Object.keys(actions);
        throw capabilityError(
          `action '${action}' is not supported for kind '${ref.kind}' by the '${adapterId}' adapter.` +
            (declared.length === 0
              ? ' The adapter declares no lifecycle actions.'
              : ` Declared actions: ${declared.map((a) => `'${a}'`).join(', ')}.`),
          { adapterId, ...refContext },
        );
      }
      if (typeof adapter.action !== 'function') {
        throw capabilityError(`action is not implemented by the '${adapterId}' adapter.`, {
          adapterId,
          ...refContext,
        });
      }
      if (actionOptions.input !== undefined && !isPlainObject(actionOptions.input)) {
        throw configurationError('action input must be a plain object.', refContext);
      }
      return run(refContext, () =>
        adapter.action!(
          ref,
          action,
          {
            input: actionOptions.input,
            signal: actionOptions.signal,
            timeoutMs: actionOptions.timeoutMs,
          },
        ),
      );
    },

    async resetCredential(ref, resetOptions = {}) {
      const refContext = validateRef(ref, capabilities.resourceScopes);
      const supported = capabilities.supported.resetCredential;
      if (supported === undefined || !supported.includes(ref.kind)) {
        throw capabilityError(
          `resetCredential is not supported for kind '${ref.kind}' by the '${adapterId}' adapter.` +
            (supported === undefined
              ? ' The adapter declares no credential reset capability.'
              : ` Kinds supporting resetCredential: ${supported.map((k) => `'${k}'`).join(', ')}.`),
          { adapterId, ...refContext },
        );
      }
      if (typeof adapter.resetCredential !== 'function') {
        throw capabilityError(`resetCredential is not implemented by the '${adapterId}' adapter.`, {
          adapterId,
          ...refContext,
        });
      }
      if (resetOptions.password !== undefined && typeof resetOptions.password !== 'string') {
        throw configurationError('resetCredential password must be a string when provided.', refContext);
      }
      return run(refContext, () =>
        adapter.resetCredential!(
          ref,
          {
            password: resetOptions.password,
            signal: resetOptions.signal,
            timeoutMs: resetOptions.timeoutMs,
          },
        ),
      );
    },
  };
}

/** Structured capability description for one management adapter. */
export type ManagementCapabilityDescriptor = {
  providerId: ManagementProviderId;
  /** Kinds the adapter can create, list, and get. */
  resourceKinds: readonly ManagementResourceKind[];
  /** Per-operation kind availability (create/list/get cover every declared kind). */
  operations: {
    create: readonly ManagementResourceKind[];
    list: readonly ManagementResourceKind[];
    get: readonly ManagementResourceKind[];
    update: readonly ManagementResourceKind[];
    delete: readonly ManagementResourceKind[];
    /** (A4) Kinds supporting connection retrieval; empty when not declared. */
    connection: readonly ManagementResourceKind[];
    /** (A4) Kinds supporting credential reset; empty when not declared. */
    resetCredential: readonly ManagementResourceKind[];
  };
  /** (A4) Declared lifecycle actions and the kinds that support them. */
  actions: Readonly<Record<string, readonly ManagementResourceKind[]>>;
  pagination: boolean;
  asyncOperations: boolean;
  /** Kinds with a pollable status field; undefined when the adapter makes no declaration. */
  statusPolling: readonly ManagementResourceKind[] | undefined;
  /** Prerequisites per operation, e.g. `'create:project' -> ['organizationId', 'region', 'plan']`. */
  prerequisites: Readonly<Record<string, readonly string[]>>;
  /** Scope requirements per provider-defined kind. */
  resourceScopes: Readonly<Record<string, readonly string[]>>;
  /** Declared evidence levels per capability key ('docs' | 'tests' | 'live'). */
  evidence: Readonly<Record<string, EvidenceLevel>>;
};

/**
 * The single structured metadata source for a management adapter: docs, capability grids, and
 * tooling render from this instead of from scattered booleans. Availability here means
 * "implemented and declared" — it never certifies credentials, plan tier, or a successful live
 * request; that is what `evidence` and per-provider live tests are for.
 */
export function describeManagementCapabilities(
  adapter: ManagementAdapter,
): ManagementCapabilityDescriptor {
  return {
    providerId: adapter.id,
    resourceKinds: adapter.capabilities.resourceKinds,
    operations: {
      create: adapter.capabilities.resourceKinds,
      list: adapter.capabilities.resourceKinds,
      get: adapter.capabilities.resourceKinds,
      update: adapter.capabilities.supported.update,
      delete: adapter.capabilities.supported.delete,
      connection: adapter.capabilities.supported.connection ?? [],
      resetCredential: adapter.capabilities.supported.resetCredential ?? [],
    },
    actions: adapter.capabilities.supported.actions ?? {},
    pagination: adapter.capabilities.pagination,
    asyncOperations: adapter.capabilities.asyncOperations,
    statusPolling: adapter.capabilities.statusPolling,
    prerequisites: adapter.capabilities.prerequisites,
    resourceScopes: adapter.capabilities.resourceScopes ?? {},
    evidence: adapter.capabilities.evidence,
  };
}

export { createManagement };
export type { ManagementScope };
