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
 *
 * Amendment A4 expansion (2026-10-06, verified against the official spec):
 * - Provider-defined kinds (A2 open-kinds mechanism): `role` (branch-scoped), `endpoint`
 *   (compute; project-scoped), `snapshot` (project-scoped). No Postgres semantics are imposed
 *   beyond what the official endpoints offer; role/endpoint/snapshot scope is carried in
 *   `ref.scope` per the A2 rules.
 * - Discovery: `organizations()` (GET /users/me/organizations) and `regions()` (GET /regions).
 * - `connection(ref)`: GET /projects/{pid}/connection_uri — requires `databaseName` and
 *   `roleName` (official endpoint requirement, never fabricated). URI returned redacted unless
 *   `reveal: true`; revealed values surface only in `secrets`.
 * - `resetCredential({kind:'role'})`: POST .../roles/{name}/reset_password (returns a new
 *   one-time password in `secrets`). Neon has no project-password rotation endpoint.
 * - `action()`: `start`/`suspend`/`restart` on `endpoint` (official compute lifecycle), and
 *   `restore` on `branch` (POST .../branches/{bid}/restore) and `snapshot` (POST
 *   .../snapshots/{sid}/restore → creates/updates a branch). `recover` for deleted projects is
 *   left to `raw.recoverProject` (single-purpose official endpoint).
 * - Honest gaps: no single-snapshot GET exists in the official API (list instead); role
 *   passwords cannot be listed, only (re)generated or revealed via `raw.revealRolePassword`.
 */

import { ManagementError } from './errors.js';
import { createManagementHttp, redactRecord, redactText } from './http.js';
import type {
  CreateBranchSpec,
  CreateCustomSpec,
  CreateDatabaseSpec,
  CreateProjectSpec,
  CreateResourceSpec,
  ManagementActionOptions,
  ManagementAdapter,
  ManagementAdapterCapabilities,
  ManagementCallOptions,
  ManagementConnectionInfo,
  ManagementConnectionInput,
  ManagementDeleteResult,
  FetchLike,
  ManagementListQuery,
  ManagementOperation,
  ManagementOrganization,
  ManagementPage,
  ManagementProviderId,
  ManagementRegion,
  ManagementResource,
  ManagementResourceKind,
  ManagementScope,
  ManagementSecret,
  ManagementStatus,
  ManagementWriteResult,
  ResetCredentialOptions,
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
  /**
   * `GET /projects/{projectId}/branches/{branchId}/roles/{roleName}/reveal_password` (official,
   * verified against the spec). Returns the role's CURRENT password — the one secret Neon can
   * recover after creation. The value is registered for error-message redaction; treat it like
   * a password and never log it.
   */
  revealRolePassword(
    input: { projectId: string; branchId: string; roleName: string },
    callOptions?: ManagementCallOptions,
  ): Promise<string>;
  /**
   * `POST /projects/{projectId}/recover` (official): recover a recently deleted project within
   * Neon's recovery window. Response carries the recovered `project` and `branches`.
   */
  recoverProject(
    projectId: string,
    callOptions?: ManagementCallOptions,
  ): Promise<ManagementResource>;
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

/** Map the official endpoint `current_state` enum (init | active | idle) truthfully. */
function endpointStatus(currentState: unknown): { status: ManagementStatus; providerStatus: string | null } {
  switch (currentState) {
    case 'init':
      return { status: 'creating', providerStatus: 'init' };
    case 'active':
      return { status: 'active', providerStatus: 'active' };
    case 'idle':
      // Idle = suspended (scaled to zero): the compute is stopped, not failed.
      return { status: 'paused', providerStatus: 'idle' };
    default:
      return { status: 'unknown', providerStatus: asString(currentState) };
  }
}

/**
 * Map a custom-kind payload into a `ManagementResource`. Custom kinds carry their scope in
 * `ref.scope`/`query.scope` (A2) exclusively; the first-class projectId/branchId fields belong
 * to the known kinds, so the scope is preserved on `resource.scope` and never fabricated into
 * projectId fields.
 */
function mapCustom(
  kind: ManagementResourceKind,
  id: string,
  name: string | null,
  raw: Record<string, unknown>,
  scope: ManagementScope,
  extra: { status?: ManagementStatus; providerStatus?: string | null } = {},
): ManagementResource {
  return {
    kind,
    providerId: PROVIDER_ID,
    id,
    name,
    region: null,
    status: extra.status ?? 'unknown',
    providerStatus: extra.providerStatus ?? null,
    createdAt: asString(raw['created_at']),
    updatedAt: asString(raw['updated_at']),
    scope: { ...scope },
    raw,
  };
}

function requireScope(
  spec: CreateCustomSpec,
  kind: 'role' | 'endpoint' | 'snapshot',
  required: readonly string[],
): ManagementScope {
  const scope = spec.scope ?? {};
  const missing = required.filter((field) => typeof scope[field] !== 'string' || scope[field] === '');
  if (missing.length > 0) {
    throw error(
      `create('${kind}') requires the scope fields ${required.map((f) => `'${f}'`).join(', ')} on ` +
        `spec.scope (Neon addresses these resources by path). Missing: ${missing.map((f) => `'${f}'`).join(', ')}.`,
      'CONFIGURATION',
      { resourceKind: kind },
    );
  }
  return scope;
}

function requireScopeOnRef(ref: ResourceRef, kind: string, required: readonly string[]): ManagementScope {
  const scope = ref.scope ?? {};
  const missing = required.filter((field) => typeof scope[field] !== 'string' || scope[field] === '');
  if (missing.length > 0) {
    throw error(
      `${kind} references require the scope fields ${required.map((f) => `'${f}'`).join(', ')} on ` +
        `ref.scope (Neon addresses these resources by path). Missing: ${missing.map((f) => `'${f}'`).join(', ')}.`,
      'CONFIGURATION',
      { resourceKind: kind, resourceId: ref.id },
    );
  }
  return scope;
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
 * `branch_id`, which would otherwise re-route the final get to the branch). Custom kinds
 * (role/endpoint/snapshot) keep their caller's ref when the payload's project/branch ids match
 * the declared scope. Otherwise derive the ref from the payload: branch-scoped when `branch_id`
 * is present, project-scoped otherwise.
 */
function refForOperation(
  payload: Record<string, unknown>,
  existingRef: ResourceRef | null,
): ResourceRef | null {
  const projectId = asString(payload['project_id']);
  const branchId = asString(payload['branch_id']);
  if (existingRef !== null && projectId !== null) {
    if (existingRef.kind === 'project' && existingRef.id === projectId) return existingRef;
    if (
      existingRef.kind === 'branch' &&
      branchId !== null &&
      existingRef.id === branchId &&
      existingRef.projectId === projectId
    ) {
      return existingRef;
    }
    if (
      existingRef.kind === 'database' &&
      branchId !== null &&
      existingRef.projectId === projectId &&
      existingRef.branchId === branchId
    ) {
      return existingRef;
    }
    // Provider-defined kinds: scope lives on ref.scope (A2). Keep the ref when the payload's
    // project matches and any branch scope the caller declared agrees with the payload.
    if (
      existingRef.kind !== 'project' &&
      existingRef.kind !== 'branch' &&
      existingRef.kind !== 'database' &&
      existingRef.scope?.['projectId'] === projectId &&
      (branchId === null || existingRef.scope['branchId'] === undefined || existingRef.scope['branchId'] === branchId)
    ) {
      return existingRef;
    }
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
    // A4: `role`, `endpoint`, and `snapshot` are provider-defined kinds implemented through the
    // A2 open-kinds mechanism (they are NOT known kinds; their scope lives in `ref.scope`).
    resourceKinds: ['project', 'branch', 'database', 'role', 'endpoint', 'snapshot'],
    // Per-kind operation availability (A2): Neon supports real update and delete for every kind
    // it manages, EXCEPT roles (the official API has no role update endpoint) — roles support
    // create/list/get/delete plus resetCredential.
    supported: {
      update: ['project', 'branch', 'database', 'endpoint', 'snapshot'],
      delete: ['project', 'branch', 'database', 'role', 'endpoint', 'snapshot'],
      connection: ['project', 'branch'],
      resetCredential: ['role'],
      actions: {
        start: ['endpoint'],
        suspend: ['endpoint'],
        restart: ['endpoint'],
        restore: ['branch', 'snapshot'],
      },
    },
    // Per-resource truth (coordination/v2-neon-management.md §12): /projects and branch lists
    // paginate server-side; the database list does NOT. `pagination: true` covers project/branch,
    // and list('database') refuses cursor/limit with CAPABILITY before dispatch. Role, endpoint,
    // and snapshot lists are likewise unpaginated in the official API and refuse cursor/limit.
    pagination: true,
    asyncOperations: true,
    // Status truth (A3): only branches and compute endpoints expose a lifecycle state
    // (`current_state`). Projects, databases, roles, and snapshots have no status field, so
    // wait() on a bare reference of those kinds is refused with CAPABILITY instead of hanging
    // until the timeout budget; pass the write result or the operation so wait() polls Neon's
    // operations endpoint.
    statusPolling: ['branch', 'endpoint'],
    // A2 scope rules for the provider-defined kinds (enforced by the core before dispatch).
    resourceScopes: {
      role: ['projectId', 'branchId'],
      endpoint: ['projectId'],
      snapshot: ['projectId'],
    },
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
      'create:role': 'docs',
      'list:role': 'docs',
      'get:role': 'docs',
      'delete:role': 'docs',
      'resetCredential:role': 'docs',
      'create:endpoint': 'docs',
      'list:endpoint': 'docs',
      'get:endpoint': 'docs',
      'update:endpoint': 'docs',
      'delete:endpoint': 'docs',
      'action:start:endpoint': 'docs',
      'action:suspend:endpoint': 'docs',
      'action:restart:endpoint': 'docs',
      'create:snapshot': 'docs',
      'list:snapshot': 'docs',
      'update:snapshot': 'docs',
      'delete:snapshot': 'docs',
      'action:restore:branch': 'docs',
      'action:restore:snapshot': 'docs',
      organizations: 'docs',
      regions: 'docs',
      'connection:project': 'docs',
      'connection:branch': 'docs',
      asyncOperations: 'docs',
      'pagination:project': 'docs',
      'pagination:branch': 'docs',
      connectionUri: 'docs',
      revealRolePassword: 'docs',
      recoverProject: 'docs',
    },
    prerequisites: {
      'create:database': ['owner'],
      'list:branch': ['projectId'],
      'list:database': ['projectId', 'branchId'],
      'create:role': ['scope.projectId', 'scope.branchId', 'name'],
      'list:role': ['scope.projectId', 'scope.branchId'],
      'create:endpoint': ['scope.projectId', 'branchId', 'type'],
      'list:endpoint': ['scope.projectId'],
      'list:snapshot': ['scope.projectId'],
      'create:snapshot': ['scope.projectId', 'branchId'],
      'action:restore:branch': ['sourceBranchId (on action input)'],
      'connection:project': ['databaseName', 'roleName'],
      'connection:branch': ['databaseName', 'roleName'],
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

  async function getKnown(ref: ResourceRef, callOptions?: ManagementCallOptions): Promise<ManagementResource> {
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

  async function updateKnown(spec: UpdateResourceSpec, callOptions?: ManagementCallOptions): Promise<ManagementWriteResult> {
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

  // ---- A4: provider-defined kinds (role / endpoint / snapshot) ---------------

  function scopeFromQuery(
    query: ManagementListQuery,
    kind: 'role' | 'endpoint' | 'snapshot',
    required: readonly string[],
  ): ManagementScope {
    const scope = query.scope ?? {};
    const missing = required.filter((field) => typeof scope[field] !== 'string' || scope[field] === '');
    if (missing.length > 0) {
      throw error(
        `list('${kind}') requires the scope fields ${required.map((f) => `'${f}'`).join(', ')} on ` +
          `query.scope (Neon addresses these lists by path). Missing: ${missing.map((f) => `'${f}'`).join(', ')}.`,
        'CONFIGURATION',
        { resourceKind: kind },
      );
    }
    return scope;
  }

  function refuseCustomPagination(kind: 'role' | 'endpoint' | 'snapshot', query: ManagementListQuery): void {
    if (query.cursor !== undefined || query.limit !== undefined) {
      throw error(
        `list('${kind}') was called with cursor/limit, but Neon's ${kind} list endpoint is not ` +
          'paginated and returns the full list. Omit cursor and limit.',
        'CAPABILITY',
        { resourceKind: kind },
      );
    }
  }

  /** Extract one-time role passwords (labelled `password:<name>` when named) before redaction. */
  function roleSecrets(roles: readonly Record<string, unknown>[]): ManagementSecret[] {
    const secrets: ManagementSecret[] = [];
    roles.forEach((role, index) => {
      const password = role['password'];
      if (typeof password !== 'string' || password === '') return;
      const name = asString(role['name']);
      secrets.push({
        label: name !== null ? `password:${name}` : `password:${index + 1}`,
        value: password,
      });
    });
    return secrets;
  }

  const registerRoleSecrets = (roles: readonly Record<string, unknown>[]): ManagementSecret[] => {
    const secrets = roleSecrets(roles);
    registerSecrets(secrets.map((secret) => secret.value));
    return secrets;
  };

  async function createRole(
    spec: CreateCustomSpec,
    callOptions?: ManagementCallOptions,
  ): Promise<ManagementWriteResult> {
    const scope = requireScope(spec, 'role', ['projectId', 'branchId']);
    const name = spec['name'];
    if (typeof name !== 'string' || name === '') {
      throw error("create('role') requires a non-empty name (the official body requires role.name).", 'CONFIGURATION', {
        resourceKind: 'role',
      });
    }
    const providerOptions = spec.providerOptions ?? {};
    for (const key of Object.keys(providerOptions)) {
      if (key !== 'no_login') {
        throw error(
          `create('role') providerOptions only accepts 'no_login' (the official RoleCreateRequest has ` +
            `role.name and role.no_login). Got '${key}'.`,
          'CONFIGURATION',
          { resourceKind: 'role' },
        );
      }
    }
    const role: Record<string, unknown> = { name };
    if (providerOptions['no_login'] !== undefined) role['no_login'] = providerOptions['no_login'];

    const response = await http.request(
      `/projects/${encodeSegment(scope['projectId']!)}/branches/${encodeSegment(scope['branchId']!)}/roles`,
      { method: 'POST', body: { role }, ...httpOptions(callOptions) },
    );
    const payload = bodyRecord(response.body, 'create-role');
    const rolePayload = recordField(payload, 'role', 'create-role');
    const roleName = asString(rolePayload['name']) ?? name;
    return {
      resource: mapCustom('role', roleName, roleName, redactRecord(rolePayload), scope),
      operation: operationFromCreateResponse(payload, { kind: 'role', id: roleName, scope }),
      secrets: registerRoleSecrets([rolePayload]),
      indeterminate: false,
    };
  }

  async function listRoles(query: ManagementListQuery, callOptions?: ManagementCallOptions): Promise<ManagementPage> {
    refuseCustomPagination('role', query);
    const scope = scopeFromQuery(query, 'role', ['projectId', 'branchId']);
    const response = await http.request(
      `/projects/${encodeSegment(scope['projectId']!)}/branches/${encodeSegment(scope['branchId']!)}/roles`,
      { ...httpOptions(callOptions) },
    );
    const payload = bodyRecord(response.body, 'list-roles');
    const resources = arrayOf(payload['roles']).map((role) => {
      const name = asString(role['name']);
      if (name === null) throw error("Neon's role payload is missing a 'name'.", 'PROVIDER', { resourceKind: 'role' });
      return mapCustom('role', name, name, redactRecord(role), scope);
    });
    return { kind: 'role', resources, cursor: null };
  }

  async function getRole(ref: ResourceRef, callOptions?: ManagementCallOptions): Promise<ManagementResource> {
    const scope = requireScopeOnRef(ref, 'role', ['projectId', 'branchId']);
    const response = await http.request(
      `/projects/${encodeSegment(scope['projectId']!)}/branches/${encodeSegment(scope['branchId']!)}/roles/${encodeSegment(ref.id)}`,
      { ...httpOptions(callOptions) },
    );
    const payload = bodyRecord(response.body, 'get-role');
    const rolePayload = recordField(payload, 'role', 'get-role');
    const name = asString(rolePayload['name']) ?? ref.id;
    return mapCustom('role', name, name, redactRecord(rolePayload), scope);
  }

  async function deleteRole(ref: ResourceRef, callOptions?: ManagementCallOptions): Promise<ManagementDeleteResult> {
    const scope = requireScopeOnRef(ref, 'role', ['projectId', 'branchId']);
    const response = await http.request(
      `/projects/${encodeSegment(scope['projectId']!)}/branches/${encodeSegment(scope['branchId']!)}/roles/${encodeSegment(ref.id)}`,
      { method: 'DELETE', ...httpOptions(callOptions) },
    );
    const payload = bodyRecord(response.body, 'delete-role');
    return { operation: operationFromCreateResponse(payload, ref), indeterminate: false };
  }

  async function createEndpoint(
    spec: CreateCustomSpec,
    callOptions?: ManagementCallOptions,
  ): Promise<ManagementWriteResult> {
    const scope = requireScope(spec, 'endpoint', ['projectId']);
    const branchId = spec['branchId'];
    const type = spec['type'];
    if (typeof branchId !== 'string' || branchId === '') {
      throw error(
        "create('endpoint') requires branchId (the official EndpointCreateRequest requires endpoint.branch_id).",
        'CONFIGURATION',
        { resourceKind: 'endpoint' },
      );
    }
    if (typeof type !== 'string' || type === '') {
      throw error(
        "create('endpoint') requires type ('read_write' | 'read_only'; the official EndpointCreateRequest " +
          'requires endpoint.type).',
        'CONFIGURATION',
        { resourceKind: 'endpoint' },
      );
    }
    const endpoint: Record<string, unknown> = { branch_id: branchId, type };
    assignDefined(endpoint, spec.providerOptions ?? {});

    const response = await http.request(`/projects/${encodeSegment(scope['projectId']!)}/endpoints`, {
      method: 'POST',
      body: { endpoint },
      ...httpOptions(callOptions),
    });
    const payload = bodyRecord(response.body, 'create-endpoint');
    const endpointPayload = recordField(payload, 'endpoint', 'create-endpoint');
    const id = asString(endpointPayload['id']);
    if (id === null) {
      throw error("Neon's endpoint payload is missing an 'id'.", 'PROVIDER', { resourceKind: 'endpoint' });
    }
    const { status, providerStatus } = endpointStatus(endpointPayload['current_state']);
    return {
      resource: mapCustom('endpoint', id, asString(endpointPayload['name']), redactRecord(endpointPayload), scope, {
        status,
        providerStatus,
      }),
      operation: operationFromCreateResponse(payload, { kind: 'endpoint', id, scope }),
      secrets: [],
      indeterminate: false,
    };
  }

  async function listEndpoints(query: ManagementListQuery, callOptions?: ManagementCallOptions): Promise<ManagementPage> {
    refuseCustomPagination('endpoint', query);
    const scope = scopeFromQuery(query, 'endpoint', ['projectId']);
    const response = await http.request(`/projects/${encodeSegment(scope['projectId']!)}/endpoints`, {
      ...httpOptions(callOptions),
    });
    const payload = bodyRecord(response.body, 'list-endpoints');
    const resources = arrayOf(payload['endpoints']).map((endpointPayload) => {
      const id = asString(endpointPayload['id']);
      if (id === null) throw error("Neon's endpoint payload is missing an 'id'.", 'PROVIDER', { resourceKind: 'endpoint' });
      const { status, providerStatus } = endpointStatus(endpointPayload['current_state']);
      return mapCustom('endpoint', id, asString(endpointPayload['name']), redactRecord(endpointPayload), scope, {
        status,
        providerStatus,
      });
    });
    return { kind: 'endpoint', resources, cursor: null };
  }

  async function getEndpoint(ref: ResourceRef, callOptions?: ManagementCallOptions): Promise<ManagementResource> {
    const scope = requireScopeOnRef(ref, 'endpoint', ['projectId']);
    const response = await http.request(
      `/projects/${encodeSegment(scope['projectId']!)}/endpoints/${encodeSegment(ref.id)}`,
      { ...httpOptions(callOptions) },
    );
    const payload = bodyRecord(response.body, 'get-endpoint');
    const endpointPayload = recordField(payload, 'endpoint', 'get-endpoint');
    const id = asString(endpointPayload['id']) ?? ref.id;
    const { status, providerStatus } = endpointStatus(endpointPayload['current_state']);
    return mapCustom('endpoint', id, asString(endpointPayload['name']), redactRecord(endpointPayload), scope, {
      status,
      providerStatus,
    });
  }

  async function updateEndpoint(
    spec: UpdateResourceSpec,
    callOptions?: ManagementCallOptions,
  ): Promise<ManagementWriteResult> {
    const scope = requireScopeOnRef(
      { kind: spec.kind, id: spec.id, scope: spec.scope },
      'endpoint',
      ['projectId'],
    );
    const providerOptions = spec.patch.providerOptions ?? {};
    if (spec.patch.owner !== undefined) {
      throw error("Compute endpoints have no 'owner' field.", 'CONFIGURATION', {
        resourceKind: 'endpoint',
        resourceId: spec.id,
      });
    }
    if (spec.patch.name === undefined && isEmptyRecord(providerOptions)) {
      throw error(
        'update(endpoint) received an empty patch; pass name or providerOptions (e.g. disabled, ' +
          'autoscaling_limit_min_cu, suspend_timeout_seconds).',
        'CONFIGURATION',
        { resourceKind: 'endpoint', resourceId: spec.id },
      );
    }
    const endpoint: Record<string, unknown> = {};
    if (spec.patch.name !== undefined) endpoint['name'] = spec.patch.name;
    assignDefined(endpoint, providerOptions);
    const response = await http.request(
      `/projects/${encodeSegment(scope['projectId']!)}/endpoints/${encodeSegment(spec.id)}`,
      { method: 'PATCH', body: { endpoint }, ...httpOptions(callOptions) },
    );
    const payload = bodyRecord(response.body, 'update-endpoint');
    const endpointPayload = recordField(payload, 'endpoint', 'update-endpoint');
    const id = asString(endpointPayload['id']) ?? spec.id;
    const { status, providerStatus } = endpointStatus(endpointPayload['current_state']);
    return {
      resource: mapCustom('endpoint', id, asString(endpointPayload['name']), redactRecord(endpointPayload), scope, {
        status,
        providerStatus,
      }),
      operation: operationFromCreateResponse(payload, { kind: 'endpoint', id: spec.id, scope }),
      secrets: [],
      indeterminate: false,
    };
  }

  async function deleteEndpoint(ref: ResourceRef, callOptions?: ManagementCallOptions): Promise<ManagementDeleteResult> {
    const scope = requireScopeOnRef(ref, 'endpoint', ['projectId']);
    const response = await http.request(
      `/projects/${encodeSegment(scope['projectId']!)}/endpoints/${encodeSegment(ref.id)}`,
      { method: 'DELETE', ...httpOptions(callOptions) },
    );
    const payload = bodyRecord(response.body, 'delete-endpoint');
    return { operation: operationFromCreateResponse(payload, ref), indeterminate: false };
  }

  async function createSnapshot(
    spec: CreateCustomSpec,
    callOptions?: ManagementCallOptions,
  ): Promise<ManagementWriteResult> {
    const scope = requireScope(spec, 'snapshot', ['projectId']);
    const branchId = spec['branchId'];
    if (typeof branchId !== 'string' || branchId === '') {
      throw error(
        "create('snapshot') requires branchId (the official endpoint is branch-scoped: " +
          'POST /projects/{projectId}/branches/{branchId}/snapshot).',
        'CONFIGURATION',
        { resourceKind: 'snapshot' },
      );
    }
    const providerOptions = spec.providerOptions ?? {};
    for (const key of Object.keys(providerOptions)) {
      if (key !== 'name' && key !== 'lsn' && key !== 'timestamp' && key !== 'expires_at') {
        throw error(
          `create('snapshot') providerOptions only accepts 'name', 'lsn', 'timestamp', and ` +
            `'expires_at' (the official endpoint takes these as query parameters). Got '${key}'.`,
          'CONFIGURATION',
          { resourceKind: 'snapshot' },
        );
      }
    }
    const response = await http.request(
      `/projects/${encodeSegment(scope['projectId']!)}/branches/${encodeSegment(branchId)}/snapshot`,
      {
        method: 'POST',
        query: {
          name: typeof providerOptions['name'] === 'string' ? providerOptions['name'] : undefined,
          lsn: typeof providerOptions['lsn'] === 'string' ? providerOptions['lsn'] : undefined,
          timestamp: typeof providerOptions['timestamp'] === 'string' ? providerOptions['timestamp'] : undefined,
          expires_at: typeof providerOptions['expires_at'] === 'string' ? providerOptions['expires_at'] : undefined,
        },
        ...httpOptions(callOptions),
      },
    );
    const payload = bodyRecord(response.body, 'create-snapshot');
    const snapshotPayload = recordField(payload, 'snapshot', 'create-snapshot');
    const id = asString(snapshotPayload['id']);
    if (id === null) {
      throw error("Neon's snapshot payload is missing an 'id'.", 'PROVIDER', { resourceKind: 'snapshot' });
    }
    return {
      resource: mapCustom('snapshot', id, asString(snapshotPayload['name']), redactRecord(snapshotPayload), scope),
      operation: operationFromCreateResponse(payload, { kind: 'snapshot', id, scope }),
      secrets: [],
      indeterminate: false,
    };
  }

  async function listSnapshots(query: ManagementListQuery, callOptions?: ManagementCallOptions): Promise<ManagementPage> {
    refuseCustomPagination('snapshot', query);
    const scope = scopeFromQuery(query, 'snapshot', ['projectId']);
    const response = await http.request(`/projects/${encodeSegment(scope['projectId']!)}/snapshots`, {
      ...httpOptions(callOptions),
    });
    const payload = bodyRecord(response.body, 'list-snapshots');
    const resources = arrayOf(payload['snapshots']).map((snapshotPayload) => {
      const id = asString(snapshotPayload['id']);
      if (id === null) throw error("Neon's snapshot payload is missing an 'id'.", 'PROVIDER', { resourceKind: 'snapshot' });
      return mapCustom('snapshot', id, asString(snapshotPayload['name']), redactRecord(snapshotPayload), scope);
    });
    return { kind: 'snapshot', resources, cursor: null };
  }

  async function updateSnapshot(
    spec: UpdateResourceSpec,
    callOptions?: ManagementCallOptions,
  ): Promise<ManagementWriteResult> {
    const scope = requireScopeOnRef({ kind: spec.kind, id: spec.id, scope: spec.scope }, 'snapshot', ['projectId']);
    const providerOptions = spec.patch.providerOptions ?? {};
    for (const key of Object.keys(providerOptions)) {
      if (key !== 'name' && key !== 'expires_at') {
        throw error(
          `update('snapshot') providerOptions only accepts 'name' and 'expires_at' (the official ` +
            `SnapshotUpdateRequest fields). Got '${key}'.`,
          'CONFIGURATION',
          { resourceKind: 'snapshot', resourceId: spec.id },
        );
      }
    }
    if (spec.patch.name === undefined && providerOptions['name'] === undefined && providerOptions['expires_at'] === undefined) {
      throw error(
        "update('snapshot') received an empty patch; pass name or providerOptions (name, expires_at).",
        'CONFIGURATION',
        { resourceKind: 'snapshot', resourceId: spec.id },
      );
    }
    const snapshot: Record<string, unknown> = {};
    if (spec.patch.name !== undefined) snapshot['name'] = spec.patch.name;
    if (providerOptions['name'] !== undefined) snapshot['name'] = providerOptions['name'];
    if (providerOptions['expires_at'] !== undefined) snapshot['expires_at'] = providerOptions['expires_at'];
    const response = await http.request(
      `/projects/${encodeSegment(scope['projectId']!)}/snapshots/${encodeSegment(spec.id)}`,
      { method: 'PATCH', body: { snapshot }, ...httpOptions(callOptions) },
    );
    const payload = bodyRecord(response.body, 'update-snapshot');
    const snapshotPayload = recordField(payload, 'snapshot', 'update-snapshot');
    const id = asString(snapshotPayload['id']) ?? spec.id;
    return {
      resource: mapCustom('snapshot', id, asString(snapshotPayload['name']), redactRecord(snapshotPayload), scope),
      operation: null,
      secrets: [],
      indeterminate: false,
    };
  }

  async function deleteSnapshot(ref: ResourceRef, callOptions?: ManagementCallOptions): Promise<ManagementDeleteResult> {
    const scope = requireScopeOnRef(ref, 'snapshot', ['projectId']);
    const response = await http.request(
      `/projects/${encodeSegment(scope['projectId']!)}/snapshots/${encodeSegment(ref.id)}`,
      { method: 'DELETE', ...httpOptions(callOptions) },
    );
    const payload = bodyRecord(response.body, 'delete-snapshot');
    return { operation: operationFromCreateResponse(payload, ref), indeterminate: false };
  }

  // ---- A4: discovery, connection, actions, credentials ----------------------

  async function listOrganizations(callOptions?: ManagementCallOptions): Promise<readonly ManagementOrganization[]> {
    const response = await http.request('/users/me/organizations', { ...httpOptions(callOptions) });
    const payload = bodyRecord(response.body, 'list-organizations');
    return arrayOf(payload['organizations']).map((org) => {
      const id = asString(org['id']);
      if (id === null) throw error("Neon's organization payload is missing an 'id'.", 'PROVIDER');
      return {
        providerId: PROVIDER_ID,
        id,
        name: asString(org['name']),
        aliasId: asString(org['handle']),
        raw: redactRecord(org),
      };
    });
  }

  async function listRegions(
    input: { organizationId?: string },
    callOptions?: ManagementCallOptions,
  ): Promise<readonly ManagementRegion[]> {
    // GET /regions accepts an optional org_id query param ("recommended for accurate region
    // availability"). A caller-supplied organizationId is passed through verbatim; omitting it
    // stays valid per the official endpoint.
    const response = await http.request('/regions', {
      query: { org_id: input?.organizationId },
      ...httpOptions(callOptions),
    });
    const payload = bodyRecord(response.body, 'list-regions');
    return arrayOf(payload['regions']).map((region) => {
      const id = asString(region['region_id']);
      if (id === null) throw error("Neon's region payload is missing a 'region_id'.", 'PROVIDER');
      return {
        providerId: PROVIDER_ID,
        id,
        name: asString(region['name']),
        platform: asString(region['platform']),
        default: typeof region['default'] === 'boolean' ? region['default'] : null,
        raw: redactRecord(region),
      };
    });
  }

  async function connectionInfo(
    ref: ResourceRef,
    input: ManagementConnectionInput,
    callOptions?: ManagementCallOptions,
  ): Promise<ManagementConnectionInfo> {
    if (ref.kind !== 'project' && ref.kind !== 'branch') {
      throw error(
        `connection is not supported for kind '${String(ref.kind)}' by the 'neon' adapter: the ` +
          'official connection_uri endpoint addresses projects and branches only.',
        'CAPABILITY',
        { resourceKind: ref.kind, resourceId: ref.id },
      );
    }
    if (typeof input.databaseName !== 'string' || input.databaseName === '') {
      throw error(
        'connection() on Neon requires databaseName: the official GET /projects/{id}/connection_uri ' +
          'endpoint requires database_name. Never guessed, never fabricated.',
        'CONFIGURATION',
        { resourceKind: ref.kind, resourceId: ref.id },
      );
    }
    if (typeof input.roleName !== 'string' || input.roleName === '') {
      throw error(
        'connection() on Neon requires roleName: the official GET /projects/{id}/connection_uri ' +
          'endpoint requires role_name. Never guessed, never fabricated.',
        'CONFIGURATION',
        { resourceKind: ref.kind, resourceId: ref.id },
      );
    }
    const projectId = ref.kind === 'project' ? ref.id : ref.projectId!;
    const response = await http.request(`/projects/${encodeSegment(projectId)}/connection_uri`, {
      query: {
        branch_id: ref.kind === 'branch' ? ref.id : undefined,
        database_name: input.databaseName,
        role_name: input.roleName,
        pooled: input.pooled === undefined ? undefined : input.pooled ? 'true' : 'false',
      },
      ...httpOptions(callOptions),
    });
    const payload = bodyRecord(response.body, 'connection_uri');
    const uri = payload['uri'];
    if (typeof uri !== 'string' || uri === '') {
      throw error("Neon's connection_uri response is missing the 'uri' string.", 'PROVIDER', {
        resourceKind: ref.kind,
        resourceId: ref.id,
      });
    }
    // Parse the provider-selected host/port from the real URI (never invented; null when the
    // URI cannot be parsed). The returned URI is password-REDACTED; the credential-bearing
    // value surfaces only in `secrets` on the explicit `reveal: true` opt-in.
    let host: string | null = null;
    let port: number | null = null;
    try {
      const parsed = new URL(uri);
      host = parsed.hostname !== '' ? parsed.hostname : null;
      port = parsed.port !== '' ? Number(parsed.port) : null;
    } catch {
      host = null;
      port = null;
    }
    let secrets: ManagementSecret[] = [];
    if (input.reveal === true) {
      secrets = [{ label: 'connectionString', value: uri }];
      registerSecrets(secrets.map((secret) => secret.value));
    }
    return {
      providerId: PROVIDER_ID,
      kind: ref.kind,
      id: ref.id,
      projectId: ref.kind === 'project' ? ref.id : ref.projectId ?? null,
      branchId: ref.kind === 'branch' ? ref.id : null,
      host,
      port,
      database: input.databaseName ?? null,
      role: input.roleName ?? null,
      pooled: input.pooled ?? null,
      redactedUri: redactConnectionUri(uri),
      secrets,
      raw: {},
    };
  }

  async function performAction(
    ref: ResourceRef,
    action: string,
    options: ManagementActionOptions,
  ): Promise<ManagementWriteResult> {
    const input = options.input ?? {};
    if (ref.kind === 'endpoint') {
      const scope = requireScopeOnRef(ref, 'endpoint', ['projectId']);
      if (action !== 'start' && action !== 'suspend' && action !== 'restart') {
        throw error(
          `action '${action}' is not supported for kind 'endpoint' by the 'neon' adapter. Supported ` +
            "endpoint actions: 'start', 'suspend', 'restart' (official compute lifecycle endpoints).",
          'CAPABILITY',
          { resourceKind: 'endpoint', resourceId: ref.id },
        );
      }
      const response = await http.request(
        `/projects/${encodeSegment(scope['projectId']!)}/endpoints/${encodeSegment(ref.id)}/${action}`,
        { method: 'POST', ...httpOptions(options) },
      );
      const payload = bodyRecord(response.body, `endpoint-${action}`);
      const endpointPayload = recordField(payload, 'endpoint', `endpoint-${action}`);
      const id = asString(endpointPayload['id']) ?? ref.id;
      const { status, providerStatus } = endpointStatus(endpointPayload['current_state']);
      return {
        resource: mapCustom('endpoint', id, asString(endpointPayload['name']), redactRecord(endpointPayload), scope, {
          status,
          providerStatus,
        }),
        operation: operationFromCreateResponse(payload, { kind: 'endpoint', id: ref.id, scope }),
        secrets: [],
        indeterminate: false,
      };
    }
    if (ref.kind === 'branch' && action === 'restore') {
      const sourceBranchId = input['sourceBranchId'] ?? input['source_branch_id'];
      if (typeof sourceBranchId !== 'string' || sourceBranchId === '') {
        throw error(
          "action 'restore' on a Neon branch requires input.sourceBranchId (the official " +
            'BranchRestoreRequest requires source_branch_id). Pass sourceBranchId, plus optional ' +
            'sourceLsn/sourceTimestamp for point-in-time restores and preserveUnderName when the ' +
            'branch has children.',
          'CONFIGURATION',
          { resourceKind: 'branch', resourceId: ref.id },
        );
      }
      // Official BranchRestoreRequest fields: source_branch_id (required), source_lsn,
      // source_timestamp, preserve_under_name (required by Neon when the branch has children or
      // the source is the branch itself). Unknown input keys are rejected, never silently dropped.
      const preserveUnderName = input['preserveUnderName'] ?? input['preserve_under_name'];
      const unknownKeys = Object.keys(input).filter(
        (key) =>
          !['sourceBranchId', 'source_branch_id', 'sourceLsn', 'source_lsn', 'sourceTimestamp', 'source_timestamp', 'preserveUnderName', 'preserve_under_name'].includes(key),
      );
      if (unknownKeys.length > 0) {
        throw error(
          `action 'restore' on a Neon branch accepts only sourceBranchId, sourceLsn, ` +
            `sourceTimestamp, and preserveUnderName (official BranchRestoreRequest fields). ` +
            `Got unknown input keys: ${unknownKeys.map((k) => `'${k}'`).join(', ')}.`,
          'CONFIGURATION',
          { resourceKind: 'branch', resourceId: ref.id },
        );
      }
      const body: Record<string, unknown> = {
        source_branch_id: sourceBranchId,
        ...(typeof input['sourceLsn'] === 'string' ? { source_lsn: input['sourceLsn'] } : {}),
        ...(typeof input['sourceTimestamp'] === 'string' ? { source_timestamp: input['sourceTimestamp'] } : {}),
        ...(typeof preserveUnderName === 'string' ? { preserve_under_name: preserveUnderName } : {}),
      };
      const response = await http.request(
        `/projects/${encodeSegment(ref.projectId!)}/branches/${encodeSegment(ref.id)}/restore`,
        { method: 'POST', body, ...httpOptions(options) },
      );
      const payload = bodyRecord(response.body, 'branch-restore');
      const branchPayload = recordField(payload, 'branch', 'branch-restore');
      const branchId = asString(branchPayload['id']) ?? ref.id;
      return {
        resource: mapBranch(branchPayload, redactRecord(payload), ref.projectId!),
        operation: operationFromCreateResponse(payload, { kind: 'branch', id: branchId, projectId: ref.projectId }),
        secrets: [],
        indeterminate: false,
      };
    }
    if (ref.kind === 'snapshot' && action === 'restore') {
      const scope = requireScopeOnRef(ref, 'snapshot', ['projectId']);
      const body: Record<string, unknown> = {
        ...(typeof input['name'] === 'string' ? { name: input['name'] } : {}),
        ...(typeof input['targetBranchId'] === 'string' ? { target_branch_id: input['targetBranchId'] } : {}),
        ...(input['target_branch_id'] !== undefined ? { target_branch_id: input['target_branch_id'] } : {}),
        ...(typeof input['finalizeRestore'] === 'boolean' ? { finalize_restore: input['finalizeRestore'] } : {}),
      };
      const response = await http.request(
        `/projects/${encodeSegment(scope['projectId']!)}/snapshots/${encodeSegment(ref.id)}/restore`,
        { method: 'POST', body, ...httpOptions(options) },
      );
      const payload = bodyRecord(response.body, 'snapshot-restore');
      const branchPayload = recordField(payload, 'branch', 'snapshot-restore');
      const branchId = asString(branchPayload['id']);
      if (branchId === null) {
        throw error("Neon's snapshot restore response is missing branch.id.", 'PROVIDER', {
          resourceKind: 'snapshot',
          resourceId: ref.id,
        });
      }
      return {
        resource: mapBranch(branchPayload, redactRecord(payload), scope['projectId']!),
        operation: operationFromCreateResponse(payload, {
          kind: 'branch',
          id: branchId,
          projectId: scope['projectId'],
        }),
        secrets: [],
        indeterminate: false,
      };
    }
    throw error(
      `action '${action}' is not supported for kind '${String(ref.kind)}' by the 'neon' adapter. ` +
        "Supported: 'start'/'suspend'/'restart' on 'endpoint', 'restore' on 'branch' and 'snapshot'.",
      'CAPABILITY',
      { resourceKind: ref.kind, resourceId: ref.id },
    );
  }

  async function resetRoleCredential(
    ref: ResourceRef,
    options: ResetCredentialOptions,
  ): Promise<ManagementWriteResult> {
    if (ref.kind !== 'role') {
      throw error(
        `resetCredential is not supported for kind '${String(ref.kind)}' by the 'neon' adapter: ` +
          "Neon rotates role passwords via POST .../roles/{role_name}/reset_password (kind 'role'). " +
          'Neon has no project-password rotation endpoint.',
        'CAPABILITY',
        { resourceKind: ref.kind, resourceId: ref.id },
      );
    }
    if (options.password !== undefined) {
      throw error(
        'Neon generates the new role password server-side; the official reset_password endpoint takes ' +
          'no body. Omit password and read the returned one-time value from the result secrets.',
        'CONFIGURATION',
        { resourceKind: 'role', resourceId: ref.id },
      );
    }
    const scope = requireScopeOnRef(ref, 'role', ['projectId', 'branchId']);
    const response = await http.request(
      `/projects/${encodeSegment(scope['projectId']!)}/branches/${encodeSegment(scope['branchId']!)}/roles/${encodeSegment(ref.id)}/reset_password`,
      { method: 'POST', ...httpOptions(options) },
    );
    const payload = bodyRecord(response.body, 'reset-password');
    const rolePayload = recordField(payload, 'role', 'reset-password');
    const roleName = asString(rolePayload['name']) ?? ref.id;
    return {
      resource: mapCustom('role', roleName, roleName, redactRecord(rolePayload), scope),
      operation: operationFromCreateResponse(payload, ref),
      secrets: registerRoleSecrets([rolePayload]),
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
    // credentials requires the explicit `reveal: true` opt-in. The revealed value is registered
    // for error-message redaction either way; the adapter never stores or logs it.
    if (input.reveal === true) registerSecrets([uri]);
    return input.reveal === true ? uri : redactConnectionUri(uri);
  }

  async function revealRolePassword(
    input: { projectId: string; branchId: string; roleName: string },
    callOptions?: ManagementCallOptions,
  ): Promise<string> {
    if (typeof input?.projectId !== 'string' || input.projectId === '') {
      throw error('raw.revealRolePassword requires projectId.', 'CONFIGURATION', { resourceKind: 'role' });
    }
    if (typeof input?.branchId !== 'string' || input.branchId === '') {
      throw error('raw.revealRolePassword requires branchId.', 'CONFIGURATION', { resourceKind: 'role' });
    }
    if (typeof input?.roleName !== 'string' || input.roleName === '') {
      throw error('raw.revealRolePassword requires roleName.', 'CONFIGURATION', { resourceKind: 'role' });
    }
    const response = await http.request(
      `/projects/${encodeSegment(input.projectId)}/branches/${encodeSegment(input.branchId)}/roles/${encodeSegment(input.roleName)}/reveal_password`,
      { ...httpOptions(callOptions) },
    );
    const payload = bodyRecord(response.body, 'reveal-password');
    const password = payload['password'];
    if (typeof password !== 'string' || password === '') {
      throw error("Neon's reveal_password response is missing the 'password' string.", 'PROVIDER', {
        resourceKind: 'role',
      });
    }
    // Register the recovered value so every later error message scrubs it. The adapter never
    // stores or logs it.
    registerSecrets([password]);
    return password;
  }

  async function recoverProject(projectId: string, callOptions?: ManagementCallOptions): Promise<ManagementResource> {
    if (typeof projectId !== 'string' || projectId === '') {
      throw error('raw.recoverProject requires projectId.', 'CONFIGURATION', { resourceKind: 'project' });
    }
    const response = await http.request(`/projects/${encodeSegment(projectId)}/recover`, {
      method: 'POST',
      ...httpOptions(callOptions),
    });
    const payload = bodyRecord(response.body, 'recover-project');
    const projectPayload = recordField(payload, 'project', 'recover-project');
    return mapProject(projectPayload, redactRecord(payload));
  }

  const raw: NeonManagementRaw = { connectionUri, revealRolePassword, recoverProject };

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
      // Provider-defined kinds (A2/A4): role, endpoint, snapshot.
      if (spec.kind === 'role') return createRole(spec as CreateCustomSpec, callOptions);
      if (spec.kind === 'endpoint') return createEndpoint(spec as CreateCustomSpec, callOptions);
      if (spec.kind === 'snapshot') return createSnapshot(spec as CreateCustomSpec, callOptions);
      // Neon has no other provider-defined kinds; the core client already refuses them, and the
      // adapter refuses them too so direct adapter use cannot invent an endpoint.
      throw error(
        `create is not supported for kind '${String(spec.kind)}' by the 'neon' adapter. ` +
          "Neon manages 'project', 'branch', 'database', 'role', 'endpoint', and 'snapshot' only.",
        'CAPABILITY',
        { resourceKind: spec.kind as ManagementResourceKind },
      );
    },
    list(kind: ManagementResourceKind, query: ManagementListQuery, callOptions?: ManagementCallOptions) {
      if (kind === 'project') return listProjects(query, callOptions);
      if (kind === 'branch') return listBranches(query, callOptions);
      if (kind === 'database') return listDatabases(query, callOptions);
      if (kind === 'role') return listRoles(query, callOptions);
      if (kind === 'endpoint') return listEndpoints(query, callOptions);
      if (kind === 'snapshot') return listSnapshots(query, callOptions);
      throw error(
        `list is not supported for kind '${String(kind)}' by the 'neon' adapter. ` +
          "Neon manages 'project', 'branch', 'database', 'role', 'endpoint', and 'snapshot' only.",
        'CAPABILITY',
        { resourceKind: kind },
      );
    },
    async get(ref: ResourceRef, callOptions?: ManagementCallOptions): Promise<ManagementResource> {
      if (ref.kind === 'project') return getKnown(ref, callOptions);
      if (ref.kind === 'branch') return getKnown(ref, callOptions);
      if (ref.kind === 'database') return getKnown(ref, callOptions);
      if (ref.kind === 'role') return getRole(ref, callOptions);
      if (ref.kind === 'endpoint') return getEndpoint(ref, callOptions);
      // The official API has no single-snapshot GET (only list/PATCH/DELETE/restore).
      if (ref.kind === 'snapshot') {
        throw error(
          "get is not available for kind 'snapshot': the official Neon API has no single-snapshot " +
            "read endpoint (only list, PATCH, DELETE, and restore). Use list('snapshot', ...).",
          'CAPABILITY',
          { resourceKind: 'snapshot', resourceId: ref.id },
        );
      }
      throw error(
        `get is not supported for kind '${String(ref.kind)}' by the 'neon' adapter. ` +
          "Neon manages 'project', 'branch', 'database', 'role', 'endpoint', and 'snapshot' only.",
        'CAPABILITY',
        { resourceKind: ref.kind, resourceId: ref.id },
      );
    },
    async update(spec: UpdateResourceSpec, callOptions?: ManagementCallOptions): Promise<ManagementWriteResult> {
      if (spec.kind === 'project' || spec.kind === 'branch' || spec.kind === 'database') return updateKnown(spec, callOptions);
      if (spec.kind === 'endpoint') return updateEndpoint(spec, callOptions);
      if (spec.kind === 'snapshot') return updateSnapshot(spec, callOptions);
      throw error(
        `update is not supported for kind '${String(spec.kind)}' by the 'neon' adapter. ` +
          "Kinds supporting update: 'project', 'branch', 'database', 'endpoint', 'snapshot' " +
          "(the official API has no role update endpoint).",
        'CAPABILITY',
        { resourceKind: spec.kind, resourceId: spec.id },
      );
    },
    async delete(ref: ResourceRef, callOptions?: ManagementCallOptions): Promise<ManagementDeleteResult> {
      if (ref.kind === 'project' || ref.kind === 'branch' || ref.kind === 'database') return remove(ref, callOptions);
      if (ref.kind === 'role') return deleteRole(ref, callOptions);
      if (ref.kind === 'endpoint') return deleteEndpoint(ref, callOptions);
      if (ref.kind === 'snapshot') return deleteSnapshot(ref, callOptions);
      throw error(
        `delete is not supported for kind '${String(ref.kind)}' by the 'neon' adapter. ` +
          "Neon manages 'project', 'branch', 'database', 'role', 'endpoint', and 'snapshot' only.",
        'CAPABILITY',
        { resourceKind: ref.kind, resourceId: ref.id },
      );
    },
    getOperation,
    organizations: listOrganizations,
    regions: listRegions,
    connection: connectionInfo,
    action: performAction,
    resetCredential: resetRoleCredential,
    raw,
  };

  return adapter;
}
