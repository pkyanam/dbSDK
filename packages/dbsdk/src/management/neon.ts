/**
 * Neon Management API adapter (`dbsdk/management/neon`).
 *
 * Implements the frozen management contract (coordination/v2-management-contract.md) against the
 * official Neon API v2 (base URL `https://console.neon.tech/api/v2`; OpenAPI spec
 * https://neon.com/api_spec/release/v2.json, verified 2026-10-06). Endpoint notes and open gaps:
 * coordination/v2-neon-management.md.
 *
 * Honest capability notes (also stated in `capabilities` and coordination/v2-neon-management.md):
 * - `project`, `branch`, and `database` all support real CRUD against official endpoints. Neon
 *   databases are branch-scoped and addressed by NAME; the adapter never pretends otherwise.
 * - Pagination is per-resource: `GET /projects` and `GET /projects/{projectId}/branches` accept
 *   `cursor`/`limit`; the branch database list does NOT paginate (Neon caps it at 500 per branch),
 *   so `list('database')` refuses cursor/limit with `CAPABILITY` instead of silently dropping them.
 * - Project and branch writes return MULTIPLE async operations (e.g. `create_timeline` plus
 *   `start_compute`). The frozen contract models one operation per write, so the adapter keeps
 *   every operation visible in the returned operation's `raw.operations` and `getOperation`
 *   aggregates them by polling each official `GET /projects/{projectId}/operations/{id}`:
 *   `wait()` resolves only when ALL operations finished, and reports failure as soon as any
 *   operation fails. No operation is silently dropped.
 * - Neon projects and databases expose NO lifecycle status field; their normalized status is
 *   `unknown` and readiness comes from operations (`wait()` on a write result), not from a status
 *   field. Branches expose `current_state`, mapped init→creating, resetting→updating, ready→active,
 *   archived→paused. Per the A3 `statusPolling` declaration, `wait()` on a bare project or
 *   database `ResourceRef` is refused with `CAPABILITY` before any request (it could never
 *   resolve); pass the write result or an operation instead. Bare branch refs poll normally.
 * - Initial credentials: create-project and create-branch responses carry `connection_uris` and
 *   role passwords (shown once). They are returned ONLY via `secrets` and are redacted from every
 *   `raw` payload and error message. `raw.connectionUri(...)` retrieves an official connection URI
 *   on demand (GET /projects/{projectId}/connection_uri); its output is REDACTED unless the caller
 *   passes `reveal: true` (explicit secret opt-in). The adapter never stores or logs secrets.
 * - List scope (Amendment A3): Neon addresses branch and database lists by path segments, so
 *   `ManagementListQuery` carries first-class `projectId`/`branchId` scope fields validated by
 *   the core client before dispatch.
 */

import { ManagementError } from './errors.js';
import { createManagementHttp, redactRecord, redactText } from './http.js';
import type {
  CreateBranchSpec,
  CreateDatabaseSpec,
  CreateProjectSpec,
  CreateResourceSpec,
  ManagementAdapter,
  ManagementAdapterCapabilities,
  ManagementCallOptions,
  ManagementDeleteResult,
  FetchLike,
  ManagementListQuery,
  ManagementOperation,
  ManagementPage,
  ManagementProviderId,
  ManagementResource,
  ManagementResourceKind,
  ManagementSecret,
  ManagementStatus,
  ManagementWriteResult,
  ResourceRef,
  UpdateResourceSpec,
} from './types.js';

const PROVIDER_ID: ManagementProviderId = 'neon';
const DEFAULT_BASE_URL = 'https://console.neon.tech/api/v2';

/** Neon operation statuses that are still in flight (non-terminal per the official spec). */
const RUNNING_STATUSES = new Set(['scheduling', 'running', 'cancelling']);
/** Terminal-success operation statuses. */
const OK_STATUSES = new Set(['finished', 'skipped']);
/** Terminal-failure operation statuses. */
const FAILED_STATUSES = new Set(['failed', 'error', 'cancelled']);

export type NeonManagementOptions = {
  /** Neon API key (`Authorization: Bearer ...`). Never logged, never echoed. */
  apiKey: string;
  /** Default: the official `https://console.neon.tech/api/v2`. Override only for tests/self-hosted gateways. */
  baseUrl?: string;
  /** Injectable fetch (tests, offline examples). Default `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Per-request timeout in ms. Default 30_000. */
  timeoutMs?: number;
};

/**
 * Typed escape hatch. Its only member retrieves an official connection URI
 * (`GET /projects/{projectId}/connection_uri`, verified against the official API spec).
 *
 * The URI embeds the role password, so by default the result is REDACTED (the password segment
 * is replaced). Passing `reveal: true` is the explicit secret opt-in that returns the real,
 * credential-bearing URI for connecting. Either way the adapter never stores or logs the value.
 */
export type NeonManagementRaw = {
  connectionUri(input: NeonConnectionUriInput, callOptions?: ManagementCallOptions): Promise<string>;
};

export type NeonConnectionUriInput = {
  projectId: string;
  /** Omit for the project's default branch. */
  branchId?: string;
  /** Required by the official endpoint. */
  databaseName: string;
  /** Required by the official endpoint. */
  roleName: string;
  /** `true` returns the PgBouncer `-pooler` URI. */
  pooled?: boolean;
  /**
   * Explicit secret opt-in. `false`/omitted: the returned URI has its password redacted.
   * `true`: the real credential-bearing URI is returned — treat it like a password.
   */
  reveal?: boolean;
};

/**
 * Replace the password segment of a `postgresql://user:password@host/db` URI with a redaction
 * marker. Only the password is touched; everything else passes through unchanged.
 */
function redactConnectionUri(uri: string): string {
  return uri.replace(/^(postgres(?:ql)?:\/\/[^:/@]+:)([^@]*)@/, '$1[redacted]@');
}

/**
 * List scope. Neon addresses its branch and database list endpoints by `projectId`/`branchId`
 * path segments; `ManagementListQuery` carries these as first-class fields (Amendment A3),
 * validated by the core client before dispatch. This check remains for direct adapter use.
 */
type ScopedListQuery = ManagementListQuery;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function error(
  message: string,
  code: 'CONFIGURATION' | 'CAPABILITY' | 'PROVIDER',
  context: { resourceKind?: ManagementResourceKind; resourceId?: string } = {},
): ManagementError {
  return new ManagementError(message, { code, adapterId: PROVIDER_ID, ...context });
}

function bodyRecord(body: unknown, what: string): Record<string, unknown> {
  if (!isRecord(body)) {
    throw error(`Neon returned an unexpected response for ${what}: expected a JSON object.`, 'PROVIDER');
  }
  return body;
}

function recordField(payload: Record<string, unknown>, key: string, what: string): Record<string, unknown> {
  const value = payload[key];
  if (!isRecord(value)) {
    throw error(`Neon's ${what} response is missing the '${key}' object.`, 'PROVIDER');
  }
  return value;
}

function arrayOf(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isEmptyRecord(value: Record<string, unknown> | undefined): boolean {
  return value === undefined || Object.keys(value).length === 0;
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

/** Merge optional spec fields into a request object, skipping `undefined` values. */
function assignDefined(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) target[key] = value;
  }
}

const httpOptions = (options?: ManagementCallOptions) =>
  ({ signal: options?.signal, timeoutMs: options?.timeoutMs }) as const;

// ---------------------------------------------------------------------------
// Payload → normalized resource mapping
// ---------------------------------------------------------------------------

function branchStatus(currentState: unknown): { status: ManagementStatus; providerStatus: string | null } {
  switch (currentState) {
    case 'init':
      return { status: 'creating', providerStatus: 'init' };
    case 'resetting':
      return { status: 'updating', providerStatus: 'resetting' };
    case 'ready':
      return { status: 'active', providerStatus: 'ready' };
    case 'archived':
      return { status: 'paused', providerStatus: 'archived' };
    default:
      return { status: 'unknown', providerStatus: asString(currentState) };
  }
}

function mapProject(project: Record<string, unknown>, raw: Record<string, unknown>): ManagementResource {
  const id = asString(project['id']);
  if (id === null) throw error("Neon's project payload is missing an 'id'.", 'PROVIDER', { resourceKind: 'project' });
  // The official project schema has no lifecycle status field. A `deleted_at` value only appears
  // on recoverable (recently deleted) projects; everything else reports `unknown`.
  const deletedAt = asString(project['deleted_at']);
  return {
    kind: 'project',
    providerId: PROVIDER_ID,
    id,
    name: asString(project['name']),
    region: asString(project['region_id']),
    status: deletedAt !== null ? 'deleting' : 'unknown',
    providerStatus: deletedAt !== null ? 'deleted' : null,
    createdAt: asString(project['created_at']),
    updatedAt: asString(project['updated_at']),
    raw,
  };
}

function mapBranch(
  branch: Record<string, unknown>,
  raw: Record<string, unknown>,
  fallbackProjectId: string | undefined,
): ManagementResource {
  const id = asString(branch['id']);
  if (id === null) throw error("Neon's branch payload is missing an 'id'.", 'PROVIDER', { resourceKind: 'branch' });
  const { status, providerStatus } = branchStatus(branch['current_state']);
  return {
    kind: 'branch',
    providerId: PROVIDER_ID,
    id,
    name: asString(branch['name']),
    region: null,
    status,
    providerStatus,
    createdAt: asString(branch['created_at']),
    updatedAt: asString(branch['updated_at']),
    projectId: asString(branch['project_id']) ?? fallbackProjectId,
    raw,
  };
}

function mapDatabase(
  database: Record<string, unknown>,
  raw: Record<string, unknown>,
  scope: { projectId?: string; branchId?: string },
): ManagementResource {
  // Neon addresses databases by NAME; the object's numeric `id` is not the API identifier.
  const name = asString(database['name']);
  if (name === null) throw error("Neon's database payload is missing a 'name'.", 'PROVIDER', { resourceKind: 'database' });
  return {
    kind: 'database',
    providerId: PROVIDER_ID,
    id: name,
    name,
    region: null,
    // The database object has no status field. A create response reports operations in flight,
    // which the caller sees via the returned operation; later reads stay truthful at `unknown`.
    status: 'unknown',
    providerStatus: null,
    createdAt: asString(database['created_at']),
    updatedAt: asString(database['updated_at']),
    projectId: scope.projectId,
    branchId: asString(database['branch_id']) ?? scope.branchId,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function operationAction(action: unknown): ManagementOperation['action'] {
  if (typeof action !== 'string') return 'other';
  if (action.startsWith('create_')) return 'create';
  if (action.startsWith('delete_')) return 'delete';
  if (action.startsWith('apply_') || action.startsWith('update_')) return 'update';
  return 'other';
}

function operationStatus(status: unknown): ManagementOperation['status'] {
  const value = asString(status);
  if (value === null) return 'unknown';
  if (RUNNING_STATUSES.has(value)) return 'running';
  if (OK_STATUSES.has(value)) return 'completed';
  if (FAILED_STATUSES.has(value)) return 'failed';
  return 'unknown';
}

function pickPrimaryOperation(operations: readonly Record<string, unknown>[]): Record<string, unknown> | null {
  if (operations.length === 0) return null;
  const inFlight = operations.find((o) => {
    const status = asString(o['status']);
    return status === null || (!OK_STATUSES.has(status) && !FAILED_STATUSES.has(status));
  });
  if (inFlight !== undefined) return inFlight;
  const failed = operations.find((o) => FAILED_STATUSES.has(asString(o['status']) ?? ''));
  return failed ?? operations[0]!;
}

/**
 * Keep the caller's `ref` when the polled operation payload is still consistent with it, so a
 * `wait()` on a database write result resolves the DATABASE (the operation payload only carries
 * `branch_id`, which would otherwise re-route the final get to the branch). Otherwise derive the
 * ref from the payload: branch-scoped when `branch_id` is present, project-scoped otherwise.
 */
function refForOperation(
  payload: Record<string, unknown>,
  existingRef: ResourceRef | null,
): ResourceRef | null {
  const projectId = asString(payload['project_id']);
  const branchId = asString(payload['branch_id']);
  if (existingRef !== null && projectId !== null) {
    const consistent =
      (existingRef.kind === 'project' && existingRef.id === projectId) ||
      (existingRef.kind === 'branch' &&
        branchId !== null &&
        existingRef.id === branchId &&
        existingRef.projectId === projectId) ||
      (existingRef.kind === 'database' &&
        branchId !== null &&
        existingRef.projectId === projectId &&
        existingRef.branchId === branchId);
    if (consistent) return existingRef;
  }
  if (branchId !== null && projectId !== null) {
    return { kind: 'branch', id: branchId, projectId };
  }
  if (projectId !== null) return { kind: 'project', id: projectId };
  return null;
}

function sanitizeOperationError(value: unknown, redactValues: readonly string[]): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return redactText(value, redactValues);
}

function latestFinish(payloads: readonly Record<string, unknown>[]): string | null {
  let latest: string | null = null;
  for (const payload of payloads) {
    const updatedAt = asString(payload['updated_at']);
    if (updatedAt !== null && (latest === null || updatedAt > latest)) latest = updatedAt;
  }
  return latest;
}

/**
 * Map one-or-more operation payloads into a single truthful `ManagementOperation`. With multiple
 * payloads (Neon returns several operations per write), the aggregate is `failed` as soon as any
 * payload failed, `completed` only when every payload finished successfully, and `running`
 * otherwise. Every payload stays visible under `raw.operations`.
 */
function aggregateOperations(
  payloads: readonly Record<string, unknown>[],
  existingRef: ResourceRef | null,
  redactValues: readonly string[],
): ManagementOperation {
  const primary = payloads[0]!;
  const failed = payloads.find((p) => FAILED_STATUSES.has(asString(p['status']) ?? ''));
  const allCompleted = payloads.every((p) => OK_STATUSES.has(asString(p['status']) ?? ''));
  const anyRunning = payloads.some((p) => RUNNING_STATUSES.has(asString(p['status']) ?? ''));

  const source = failed ?? primary;
  const id = asString(source['id']);
  if (id === null) {
    throw error("Neon's operation payload is missing an 'id'.", 'PROVIDER');
  }
  const singleStatus = operationStatus(source['status']);
  const status: ManagementOperation['status'] = failed
    ? 'failed'
    : allCompleted
      ? 'completed'
      : anyRunning || payloads.length > 1
        ? 'running'
        : singleStatus;

  const raw: Record<string, unknown> =
    payloads.length > 1 ? { operations: payloads.map((p) => redactRecord(p)) } : redactRecord(source);

  return {
    id,
    providerId: PROVIDER_ID,
    action: operationAction(source['action']),
    ref: refForOperation(source, existingRef),
    status,
    providerStatus: asString(source['status']),
    createdAt: asString(source['created_at']),
    finishedAt: status === 'completed' ? latestFinish(payloads) : null,
    error:
      status === 'failed'
        ? (sanitizeOperationError(source['error'], redactValues) ??
          `operation ${id} ended with provider status '${asString(source['status']) ?? 'unknown'}'.`)
        : null,
    raw,
  };
}

/** Sibling operation ids carried on the initial write's operation raw (from the same response). */
function siblingOperationIds(operation: ManagementOperation, primaryId: string): string[] {
  const operations = operation.raw?.['operations'];
  if (!Array.isArray(operations)) return [];
  const ids = new Set<string>();
  for (const entry of operations) {
    if (!isRecord(entry)) continue;
    const id = asString(entry['id']);
    if (id !== null && id !== '' && id !== primaryId) ids.add(id);
  }
  return [...ids];
}

function operationProjectId(operation: ManagementOperation): string | null {
  const ref = operation.ref;
  if (ref) {
    if (ref.kind === 'project' && ref.id !== '') return ref.id;
    if (typeof ref.projectId === 'string' && ref.projectId !== '') return ref.projectId;
  }
  const rawProjectId = operation.raw?.['project_id'];
  return typeof rawProjectId === 'string' && rawProjectId !== '' ? rawProjectId : null;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/**
 * Extract credentials from a create response BEFORE redaction. Connection URIs embed the role
 * password; role passwords are shown exactly once by Neon. Labels are disambiguated only when
 * there is more than one of the same kind.
 */
function extractSecrets(payload: Record<string, unknown>): ManagementSecret[] {
  const secrets: ManagementSecret[] = [];

  const connectionUris = arrayOf(payload['connection_uris']);
  connectionUris.forEach((entry, index) => {
    const uri = entry['connection_uri'];
    if (typeof uri !== 'string' || uri === '') return;
    const parameters = entry['connection_parameters'];
    const database = isRecord(parameters) ? asString(parameters['database']) : null;
    const label =
      connectionUris.length === 1
        ? 'connectionString'
        : database !== null
          ? `connectionString:${database}`
          : `connectionString:${index + 1}`;
    secrets.push({ label, value: uri });
  });

  const rolesWithPassword = arrayOf(payload['roles']).filter((role) => {
    const password = role['password'];
    return typeof password === 'string' && password !== '';
  });
  rolesWithPassword.forEach((role, index) => {
    const name = asString(role['name']);
    const label = rolesWithPassword.length === 1 ? 'password' : name !== null ? `password:${name}` : `password:${index + 1}`;
    secrets.push({ label, value: role['password'] as string });
  });

  return secrets;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function neonManagement(options: NeonManagementOptions): ManagementAdapter<NeonManagementRaw> {
  if (typeof options?.apiKey !== 'string' || options.apiKey === '') {
    throw error('neonManagement requires a Neon API key (apiKey).', 'CONFIGURATION');
  }
  if (options.baseUrl !== undefined && options.baseUrl === '') {
    throw error('neonManagement baseUrl must be a non-empty string when provided.', 'CONFIGURATION');
  }

  const http = createManagementHttp({
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    token: options.apiKey,
    adapterId: PROVIDER_ID,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
    redactValues: [options.apiKey],
  });
  /**
   * Secret values scrubbed from every error message: the API key plus every one-time credential
   * extracted from a create response (connection strings, role passwords). Values are registered
   * with the shared HTTP helper so later failures can never echo them.
   */
  const redactValues: string[] = [options.apiKey];
  const registerSecrets = (values: readonly string[]): void => {
    for (const value of values) {
      if (value !== '' && !redactValues.includes(value)) {
        redactValues.push(value);
        http.registerSecrets([value]);
      }
    }
  };
  /** Extract one-time credentials from a create response and register them for redaction. */
  const registerCreateSecrets = (payload: Record<string, unknown>): ManagementSecret[] => {
    const secrets = extractSecrets(payload);
    registerSecrets(secrets.map((secret) => secret.value));
    return secrets;
  };

  const capabilities: ManagementAdapterCapabilities = {
    resourceKinds: ['project', 'branch', 'database'],
    // Per-kind operation availability (A2): Neon supports real update and delete for every kind
    // it manages; there are no provider-defined custom kinds, so nothing else is listed.
    supported: {
      update: ['project', 'branch', 'database'],
      delete: ['project', 'branch', 'database'],
    },
    // Per-resource truth (coordination/v2-neon-management.md §12): /projects and branch lists
    // paginate server-side; the database list does NOT. `pagination: true` covers project/branch,
    // and list('database') refuses cursor/limit with CAPABILITY before dispatch.
    pagination: true,
    asyncOperations: true,
    // Status truth (A3): only branches expose a lifecycle status (`current_state`). Projects and
    // databases have no status field, so wait() on a bare reference of those kinds is refused
    // with CAPABILITY instead of hanging until the timeout budget; pass the write result or the
    // operation so wait() polls Neon's operations endpoint.
    statusPolling: ['branch'],
    evidence: {
      resourceKinds: 'docs',
      'create:project': 'docs',
      'list:project': 'docs',
      'get:project': 'docs',
      'update:project': 'docs',
      'delete:project': 'docs',
      'create:branch': 'docs',
      'list:branch': 'docs',
      'get:branch': 'docs',
      'update:branch': 'docs',
      'delete:branch': 'docs',
      'create:database': 'docs',
      'list:database': 'docs',
      'get:database': 'docs',
      'update:database': 'docs',
      'delete:database': 'docs',
      asyncOperations: 'docs',
      'pagination:project': 'docs',
      'pagination:branch': 'docs',
      connectionUri: 'docs',
    },
    prerequisites: {
      'create:database': ['owner'],
      'list:branch': ['projectId'],
      'list:database': ['projectId', 'branchId'],
    },
  };

  // ---- operations over HTTP ------------------------------------------------

  async function fetchOperationPayload(
    projectId: string,
    operationId: string,
    callOptions?: ManagementCallOptions,
  ): Promise<Record<string, unknown>> {
    const response = await http.request(
      `/projects/${encodeSegment(projectId)}/operations/${encodeSegment(operationId)}`,
      { ...httpOptions(callOptions) },
    );
    const payload = bodyRecord(response.body, 'get-operation');
    return recordField(payload, 'operation', 'get-operation');
  }

  async function getOperation(
    operation: ManagementOperation,
    callOptions?: ManagementCallOptions,
  ): Promise<ManagementOperation> {
    const projectId = operationProjectId(operation);
    if (projectId === null) {
      throw error(
        "getOperation cannot determine the Neon project scope for this operation. Provide an operation whose ref carries projectId (or kind 'project'), or raw.project_id.",
        'CONFIGURATION',
      );
    }
    const primary = await fetchOperationPayload(projectId, operation.id, callOptions);
    const primaryId = asString(primary['id']);
    if (primaryId === null) {
      throw error("Neon's operation payload is missing an 'id'.", 'PROVIDER');
    }
    const payloads: Record<string, unknown>[] = [primary];
    for (const siblingId of siblingOperationIds(operation, primaryId)) {
      payloads.push(await fetchOperationPayload(projectId, siblingId, callOptions));
    }
    return aggregateOperations(payloads, operation.ref ?? null, redactValues);
  }

  // ---- create ---------------------------------------------------------------

  function operationFromCreateResponse(
    payload: Record<string, unknown>,
    ref: ResourceRef,
  ): ManagementOperation | null {
    const operations = arrayOf(payload['operations']);
    const primary = pickPrimaryOperation(operations);
    if (primary === null) return null;
    const mapped = aggregateOperations([primary], ref, redactValues);
    // Keep the FULL operations array from the same response on the operation raw so getOperation
    // can aggregate every sibling; no async operation from the response is dropped.
    return { ...mapped, raw: { ...mapped.raw, operations: operations.map((o) => redactRecord(o)) } };
  }

  async function createProject(
    spec: CreateProjectSpec,
    callOptions?: ManagementCallOptions,
  ): Promise<ManagementWriteResult> {
    if (spec.plan !== undefined) {
      throw error(
        "Neon projects do not take a 'plan' field: Neon plans are account-level, chosen in the Neon console. Remove 'plan' or move provider-specific fields into providerOptions.",
        'CONFIGURATION',
        { resourceKind: 'project' },
      );
    }
    if (spec.password !== undefined) {
      throw error(
        'Neon generates role passwords server-side and returns them exactly once in the create-project response (as secrets). The official API does not accept a caller-supplied password at project creation.',
        'CONFIGURATION',
        { resourceKind: 'project' },
      );
    }
    const project: Record<string, unknown> = { name: spec.name };
    if (spec.region !== undefined) project['region_id'] = spec.region;
    if (spec.organizationId !== undefined) project['org_id'] = spec.organizationId;
    assignDefined(project, spec.providerOptions ?? {});

    const response = await http.request('/projects', {
      method: 'POST',
      body: { project },
      ...httpOptions(callOptions),
    });
    const payload = bodyRecord(response.body, 'create-project');
    const projectPayload = recordField(payload, 'project', 'create-project');
    const resource = mapProject(projectPayload, redactRecord(payload));
    return {
      resource,
      operation: operationFromCreateResponse(payload, { kind: 'project', id: resource.id }),
      secrets: registerCreateSecrets(payload),
      indeterminate: false,
    };
  }

  async function createBranch(
    spec: CreateBranchSpec,
    callOptions?: ManagementCallOptions,
  ): Promise<ManagementWriteResult> {
    const providerOptions = spec.providerOptions ?? {};
    for (const key of Object.keys(providerOptions)) {
      if (key !== 'branch' && key !== 'endpoints') {
        throw error(
          `create('branch') providerOptions only accepts 'branch' (extra Branch fields, e.g. parent_lsn, parent_timestamp, protected, init_source) and 'endpoints' (compute endpoints array). Got '${key}'.`,
          'CONFIGURATION',
          { resourceKind: 'branch' },
        );
      }
    }
    const branch: Record<string, unknown> = {};
    if (spec.name !== undefined) branch['name'] = spec.name;
    if (spec.sourceBranchId !== undefined) branch['parent_id'] = spec.sourceBranchId;
    if (isRecord(providerOptions['branch'])) assignDefined(branch, providerOptions['branch']);
    // A branch without a compute endpoint cannot accept connections. The official docs pattern
    // creates one read_write endpoint with the branch; callers can override or pass [] to skip.
    const endpoints = providerOptions['endpoints'] ?? [{ type: 'read_write' }];
    if (!Array.isArray(endpoints)) {
      throw error("create('branch') providerOptions.endpoints must be an array.", 'CONFIGURATION', {
        resourceKind: 'branch',
      });
    }

    const response = await http.request(`/projects/${encodeSegment(spec.projectId)}/branches`, {
      method: 'POST',
      body: { branch, endpoints },
      ...httpOptions(callOptions),
    });
    const payload = bodyRecord(response.body, 'create-branch');
    const branchPayload = recordField(payload, 'branch', 'create-branch');
    const branchId = asString(branchPayload['id']);
    if (branchId === null) {
      throw error("Neon's create-branch response is missing branch.id.", 'PROVIDER', { resourceKind: 'branch' });
    }
    return {
      resource: mapBranch(branchPayload, redactRecord(payload), spec.projectId),
      operation: operationFromCreateResponse(payload, {
        kind: 'branch',
        id: branchId,
        projectId: spec.projectId,
      }),
      secrets: registerCreateSecrets(payload),
      indeterminate: false,
    };
  }

  async function createDatabase(
    spec: CreateDatabaseSpec,
    callOptions?: ManagementCallOptions,
  ): Promise<ManagementWriteResult> {
    if (typeof spec.owner !== 'string' || spec.owner === '') {
      throw error(
        "Neon requires the owning role (owner_name) when creating a database. Pass owner (e.g. the branch's default role, '<database>_owner').",
        'CONFIGURATION',
        { resourceKind: 'database' },
      );
    }
    const database: Record<string, unknown> = { name: spec.name, owner_name: spec.owner };
    assignDefined(database, spec.providerOptions ?? {});

    const response = await http.request(
      `/projects/${encodeSegment(spec.projectId)}/branches/${encodeSegment(spec.branchId)}/databases`,
      { method: 'POST', body: { database }, ...httpOptions(callOptions) },
    );
    const payload = bodyRecord(response.body, 'create-database');
    const databasePayload = recordField(payload, 'database', 'create-database');
    const name = asString(databasePayload['name']);
    if (name === null) {
      throw error("Neon's create-database response is missing database.name.", 'PROVIDER', {
        resourceKind: 'database',
      });
    }
    return {
      resource: mapDatabase(databasePayload, redactRecord(payload), {
        projectId: spec.projectId,
        branchId: spec.branchId,
      }),
      operation: operationFromCreateResponse(payload, {
        kind: 'database',
        id: name,
        projectId: spec.projectId,
        branchId: spec.branchId,
      }),
      secrets: [],
      indeterminate: false,
    };
  }

  // ---- list -----------------------------------------------------------------

  function requireListScope(
    query: ManagementListQuery,
    kind: 'branch' | 'database',
  ): { projectId: string; branchId?: string } {
    const scoped = query as ScopedListQuery;
    const projectId =
      typeof scoped.projectId === 'string' && scoped.projectId !== '' ? scoped.projectId : undefined;
    const branchId =
      typeof scoped.branchId === 'string' && scoped.branchId !== '' ? scoped.branchId : undefined;
    const needsBranch = kind === 'database';
    const missing: string[] = [];
    if (projectId === undefined) missing.push('projectId');
    if (needsBranch && branchId === undefined) missing.push('branchId');
    if (missing.length > 0) {
      throw error(
        `list('${kind}') on Neon requires ${missing.join(' and ')} on the query object: Neon addresses ` +
          `this list by path (GET /projects/{projectId}${needsBranch ? '/branches/{branchId}' : ''}/...).`,
        'CONFIGURATION',
        { resourceKind: kind },
      );
    }
    return { projectId: projectId!, ...(needsBranch ? { branchId: branchId! } : {}) };
  }

  function pageCursor(payload: Record<string, unknown>): string | null {
    const pagination = payload['pagination'];
    if (!isRecord(pagination)) return null;
    // GET /projects embeds { pagination: { cursor } }; branch lists embed { pagination: { next } }.
    return asString(pagination['cursor']) ?? asString(pagination['next']);
  }

  async function listProjects(query: ManagementListQuery, callOptions?: ManagementCallOptions): Promise<ManagementPage> {
    const response = await http.request('/projects', {
      query: { cursor: query.cursor, limit: query.limit },
      ...httpOptions(callOptions),
    });
    const payload = bodyRecord(response.body, 'list-projects');
    const resources = arrayOf(payload['projects']).map((project) =>
      mapProject(project, redactRecord(project)),
    );
    return { kind: 'project', resources, cursor: pageCursor(payload) };
  }

  async function listBranches(query: ManagementListQuery, callOptions?: ManagementCallOptions): Promise<ManagementPage> {
    const scope = requireListScope(query, 'branch');
    const response = await http.request(`/projects/${encodeSegment(scope.projectId)}/branches`, {
      query: { cursor: query.cursor, limit: query.limit },
      ...httpOptions(callOptions),
    });
    const payload = bodyRecord(response.body, 'list-branches');
    const resources = arrayOf(payload['branches']).map((branch) =>
      mapBranch(branch, redactRecord(branch), scope.projectId),
    );
    return { kind: 'branch', resources, cursor: pageCursor(payload) };
  }

  async function listDatabases(query: ManagementListQuery, callOptions?: ManagementCallOptions): Promise<ManagementPage> {
    if (query.cursor !== undefined || query.limit !== undefined) {
      throw error(
        "list('database') was called with cursor/limit, but Neon's branch database list endpoint " +
          '(GET /projects/{projectId}/branches/{branchId}/databases) is not paginated; Neon caps it at ' +
          "500 databases per branch and returns the full list. Omit cursor and limit. This adapter declares " +
          'pagination for project and branch lists only.',
        'CAPABILITY',
        { resourceKind: 'database' },
      );
    }
    const scope = requireListScope(query, 'database');
    const response = await http.request(
      `/projects/${encodeSegment(scope.projectId)}/branches/${encodeSegment(scope.branchId!)}/databases`,
      { ...httpOptions(callOptions) },
    );
    const payload = bodyRecord(response.body, 'list-databases');
    const resources = arrayOf(payload['databases']).map((database) =>
      mapDatabase(database, redactRecord(database), {
        projectId: scope.projectId,
        branchId: scope.branchId,
      }),
    );
    // Truthful: this Neon endpoint returns everything; there is no next page.
    return { kind: 'database', resources, cursor: null };
  }

  // ---- get / update / delete ------------------------------------------------

  async function get(ref: ResourceRef, callOptions?: ManagementCallOptions): Promise<ManagementResource> {
    if (ref.kind === 'project') {
      const response = await http.request(`/projects/${encodeSegment(ref.id)}`, { ...httpOptions(callOptions) });
      const payload = bodyRecord(response.body, 'get-project');
      return mapProject(recordField(payload, 'project', 'get-project'), redactRecord(payload));
    }
    if (ref.kind === 'branch') {
      const response = await http.request(
        `/projects/${encodeSegment(ref.projectId!)}/branches/${encodeSegment(ref.id)}`,
        { ...httpOptions(callOptions) },
      );
      const payload = bodyRecord(response.body, 'get-branch');
      return mapBranch(recordField(payload, 'branch', 'get-branch'), redactRecord(payload), ref.projectId);
    }
    if (ref.kind !== 'database') {
      throw error(
        `get is not supported for kind '${String(ref.kind)}' by the 'neon' adapter. ` +
          "Neon manages 'project', 'branch', and 'database' only.",
        'CAPABILITY',
        { resourceKind: ref.kind, resourceId: ref.id },
      );
    }
    const response = await http.request(
      `/projects/${encodeSegment(ref.projectId!)}/branches/${encodeSegment(ref.branchId!)}/databases/${encodeSegment(ref.id)}`,
      { ...httpOptions(callOptions) },
    );
    const payload = bodyRecord(response.body, 'get-database');
    return mapDatabase(recordField(payload, 'database', 'get-database'), redactRecord(payload), {
      projectId: ref.projectId,
      branchId: ref.branchId,
    });
  }

  async function update(spec: UpdateResourceSpec, callOptions?: ManagementCallOptions): Promise<ManagementWriteResult> {
    const providerOptions = spec.patch.providerOptions ?? {};
    if (spec.kind !== 'project' && spec.kind !== 'branch' && spec.kind !== 'database') {
      throw error(
        `update is not supported for kind '${String(spec.kind)}' by the 'neon' adapter. ` +
          "Neon manages 'project', 'branch', and 'database' only.",
        'CAPABILITY',
        { resourceKind: spec.kind, resourceId: spec.id },
      );
    }
    if (spec.kind === 'project') {
      if (spec.patch.owner !== undefined) {
        throw error("Neon projects have no updatable 'owner' field via the Management API.", 'CONFIGURATION', {
          resourceKind: 'project',
          resourceId: spec.id,
        });
      }
      if (spec.patch.name === undefined && isEmptyRecord(providerOptions)) {
        throw error('update(project) received an empty patch; Neon PATCH /projects/{id} needs at least one field.', 'CONFIGURATION', {
          resourceKind: 'project',
          resourceId: spec.id,
        });
      }
      const project: Record<string, unknown> = {};
      if (spec.patch.name !== undefined) project['name'] = spec.patch.name;
      assignDefined(project, providerOptions);
      const response = await http.request(`/projects/${encodeSegment(spec.id)}`, {
        method: 'PATCH',
        body: { project },
        ...httpOptions(callOptions),
      });
      const payload = bodyRecord(response.body, 'update-project');
      const projectPayload = recordField(payload, 'project', 'update-project');
      return {
        resource: mapProject(projectPayload, redactRecord(payload)),
        operation: operationFromCreateResponse(payload, { kind: 'project', id: spec.id }),
        secrets: [],
        indeterminate: false,
      };
    }
    if (spec.kind === 'branch') {
      if (spec.patch.owner !== undefined) {
        throw error("Branches have no updatable 'owner' field; 'owner' applies to databases.", 'CONFIGURATION', {
          resourceKind: 'branch',
          resourceId: spec.id,
        });
      }
      if (spec.patch.name === undefined && isEmptyRecord(providerOptions)) {
        throw error('update(branch) received an empty patch; pass name or providerOptions (e.g. protected, expires_at).', 'CONFIGURATION', {
          resourceKind: 'branch',
          resourceId: spec.id,
        });
      }
      const branch: Record<string, unknown> = {};
      if (spec.patch.name !== undefined) branch['name'] = spec.patch.name;
      assignDefined(branch, providerOptions);
      const response = await http.request(
        `/projects/${encodeSegment(spec.projectId!)}/branches/${encodeSegment(spec.id)}`,
        { method: 'PATCH', body: { branch }, ...httpOptions(callOptions) },
      );
      const payload = bodyRecord(response.body, 'update-branch');
      const branchPayload = recordField(payload, 'branch', 'update-branch');
      return {
        resource: mapBranch(branchPayload, redactRecord(payload), spec.projectId),
        operation: operationFromCreateResponse(payload, {
          kind: 'branch',
          id: spec.id,
          projectId: spec.projectId,
        }),
        secrets: [],
        indeterminate: false,
      };
    }
    // database
    if (spec.patch.name === undefined && spec.patch.owner === undefined && isEmptyRecord(providerOptions)) {
      throw error('update(database) received an empty patch; Neon accepts name and owner_name updates.', 'CONFIGURATION', {
        resourceKind: 'database',
        resourceId: spec.id,
      });
    }
    const database: Record<string, unknown> = {};
    if (spec.patch.name !== undefined) database['name'] = spec.patch.name;
    if (spec.patch.owner !== undefined) database['owner_name'] = spec.patch.owner;
    assignDefined(database, providerOptions);
    const response = await http.request(
      `/projects/${encodeSegment(spec.projectId!)}/branches/${encodeSegment(spec.branchId!)}/databases/${encodeSegment(spec.id)}`,
      { method: 'PATCH', body: { database }, ...httpOptions(callOptions) },
    );
    const payload = bodyRecord(response.body, 'update-database');
    const databasePayload = recordField(payload, 'database', 'update-database');
    const newName = asString(databasePayload['name']) ?? spec.id;
    return {
      resource: mapDatabase(databasePayload, redactRecord(payload), {
        projectId: spec.projectId,
        branchId: spec.branchId,
      }),
      operation: operationFromCreateResponse(payload, {
        kind: 'database',
        id: newName,
        projectId: spec.projectId,
        branchId: spec.branchId,
      }),
      secrets: [],
      indeterminate: false,
    };
  }

  async function remove(ref: ResourceRef, callOptions?: ManagementCallOptions): Promise<ManagementDeleteResult> {
    if (ref.kind !== 'project' && ref.kind !== 'branch' && ref.kind !== 'database') {
      throw error(
        `delete is not supported for kind '${String(ref.kind)}' by the 'neon' adapter. ` +
          "Neon manages 'project', 'branch', and 'database' only.",
        'CAPABILITY',
        { resourceKind: ref.kind, resourceId: ref.id },
      );
    }
    const path =
      ref.kind === 'project'
        ? `/projects/${encodeSegment(ref.id)}`
        : ref.kind === 'branch'
          ? `/projects/${encodeSegment(ref.projectId!)}/branches/${encodeSegment(ref.id)}`
          : `/projects/${encodeSegment(ref.projectId!)}/branches/${encodeSegment(ref.branchId!)}/databases/${encodeSegment(ref.id)}`;
    const response = await http.request(path, { method: 'DELETE', ...httpOptions(callOptions) });
    const payload = bodyRecord(response.body, `delete-${ref.kind}`);
    // DELETE /projects/{id} returns the project object synchronously (with a 7-day recovery
    // window per Neon docs) and carries no operations. Branch and database deletes DO carry
    // operations (e.g. suspend_compute, apply_config).
    return {
      operation: ref.kind === 'project' ? null : operationFromCreateResponse(payload, ref),
      indeterminate: false,
    };
  }

  // ---- raw escape hatch ------------------------------------------------------

  async function connectionUri(
    input: NeonConnectionUriInput,
    callOptions?: ManagementCallOptions,
  ): Promise<string> {
    if (typeof input?.projectId !== 'string' || input.projectId === '') {
      throw error('raw.connectionUri requires projectId.', 'CONFIGURATION');
    }
    if (typeof input?.databaseName !== 'string' || input.databaseName === '') {
      throw error('raw.connectionUri requires databaseName (the official endpoint requires it).', 'CONFIGURATION');
    }
    if (typeof input?.roleName !== 'string' || input.roleName === '') {
      throw error('raw.connectionUri requires roleName (the official endpoint requires it).', 'CONFIGURATION');
    }
    const response = await http.request(`/projects/${encodeSegment(input.projectId)}/connection_uri`, {
      query: {
        branch_id: input.branchId,
        database_name: input.databaseName,
        role_name: input.roleName,
        pooled: input.pooled === undefined ? undefined : input.pooled ? 'true' : 'false',
      },
      ...httpOptions(callOptions),
    });
    const payload = bodyRecord(response.body, 'connection_uri');
    const uri = payload['uri'];
    if (typeof uri !== 'string' || uri === '') {
      throw error("Neon's connection_uri response is missing the 'uri' string.", 'PROVIDER');
    }
    // The URI embeds the role password. Default output is REDACTED; returning the real
    // credentials requires the explicit `reveal: true` opt-in. Either way the adapter never
    // stores or logs the value.
    return input.reveal === true ? uri : redactConnectionUri(uri);
  }

  const raw: NeonManagementRaw = { connectionUri };

  const adapter: ManagementAdapter<NeonManagementRaw> = {
    id: PROVIDER_ID,
    providerId: PROVIDER_ID,
    capabilities,
    async create(spec: CreateResourceSpec, callOptions?: ManagementCallOptions): Promise<ManagementWriteResult> {
      // The open kind union keeps CreateCustomSpec assignable to every kind literal, so narrowing
      // by `spec.kind` cannot exclude it; these casts are safe because non-known kinds throw below.
      if (spec.kind === 'project') return createProject(spec as CreateProjectSpec, callOptions);
      if (spec.kind === 'branch') return createBranch(spec as CreateBranchSpec, callOptions);
      if (spec.kind === 'database') return createDatabase(spec as CreateDatabaseSpec, callOptions);
      // Neon has no provider-defined kinds; the core client already refuses them, and the
      // adapter refuses them too so direct adapter use cannot invent an endpoint.
      throw error(
        `create is not supported for kind '${String(spec.kind)}' by the 'neon' adapter. ` +
          "Neon manages 'project', 'branch', and 'database' only.",
        'CAPABILITY',
        { resourceKind: spec.kind as ManagementResourceKind },
      );
    },
    list(kind: ManagementResourceKind, query: ManagementListQuery, callOptions?: ManagementCallOptions) {
      if (kind === 'project') return listProjects(query, callOptions);
      if (kind === 'branch') return listBranches(query, callOptions);
      if (kind === 'database') return listDatabases(query, callOptions);
      throw error(
        `list is not supported for kind '${String(kind)}' by the 'neon' adapter. ` +
          "Neon manages 'project', 'branch', and 'database' only.",
        'CAPABILITY',
        { resourceKind: kind },
      );
    },
    get,
    update,
    delete: remove,
    getOperation,
    raw,
  };

  return adapter;
}
