/**
 * Supabase Management API adapter (`dbsdk/management/supabase`).
 *
 * Implements the frozen management contract (coordination/v2-management-contract.md) against the
 * official Supabase Management API v1 (base URL `https://api.supabase.com/v1`; OpenAPI spec
 * `apps/docs/spec/api_v1_openapi.json` in github.com/supabase/supabase, verified 2026-10-06).
 * Endpoint notes, live-spec discrepancies versus the frozen contract anchors, and open gaps:
 * coordination/v2-supabase-management.md.
 *
 * Honest capability notes (also stated in `capabilities` and coordination/v2-supabase-management.md):
 * - `project` supports real create/list/get/update/delete against official endpoints. A Supabase
 *   project IS the provisioned PostgreSQL database; there is NO separate `database` resource, so
 *   every `database` verb is refused with `CAPABILITY` before any network request (both by the
 *   core client's declared-kind check and by this adapter for direct users).
 * - `branch` (the Environments API) supports create/list plus get/update/delete. Supabase routes
 *   branch get/update/delete through the top-level `/v1/branches/{branch_id_or_ref}` path (the
 *   create/list endpoints live under `/v1/projects/{ref}/branches`); branch get/update/delete do
 *   not take the parent project ref at all, but the contract's `branch` refs still carry
 *   `projectId` (the parent project), so scope stays first-class and `wait()` reconstruction works.
 * - No operations API and no pagination: list endpoints return the full array (`cursor: null`),
 *   `wait()` polls resource status via GET, and `list(..., {cursor|limit})` is refused with
 *   `CAPABILITY` instead of silently ignored.
 * - Live-spec prerequisites (verified 2026-10-06): create-project requires `name`, `db_pass`, and
 *   an organization scope — the API's current required field is `organization_slug`
 *   (`organization_id` is accepted but deprecated). `plan` and `region` are DEPRECATED: plan is
 *   set on the organization level and ignored by this endpoint, and region is expressed through
 *   `region_selection` (this adapter maps a spec `region` to `region_selection`).
 * - Secrets: `db_pass` is REQUIRED by the official create-project endpoint. When the caller omits
 *   `password`, the adapter generates a cryptographically random password (crypto.getRandomValues)
 *   and returns it ONLY via `secrets` (the API never echoes it). A caller-supplied password is
 *   sent but never echoed back. The branch config endpoint (GET /v1/branches/{branch_id_or_ref})
 *   is the only official endpoint that returns database credentials (`db_host`, `db_port`,
 *   `db_user`, `db_pass`, `jwt_secret`); this adapter exposes it via `raw.branchConfig` with its
 *   secrets omitted unless the caller opts in with `includeSecrets: true`. Every discovered
 *   secret value is registered for per-request redaction so it is scrubbed from all subsequent
 *   error messages. Nothing is stored or logged.
 * - Connection/query bridge: a Supabase PAT is NOT a database password. The management layer
 *   surfaces the official pieces — the creation-time password (via `secrets`), the database host
 *   (via `raw.databaseHost`, from GET /v1/projects/{ref} → `database.host`), and full branch
 *   credentials (via `raw.branchConfig`). The caller assembles Supabase's documented direct
 *   connection string (`postgresql://postgres:<password>@<host>:5432/postgres`) and hands it to
 *   the `dbsdk/postgres` adapter. The SDK never fabricates a password or URL from the PAT.
 */

import { ManagementError } from './errors.js';
import { createManagementHttp, redactRecord, SECRET_KEYS } from './http.js';
import type {
  CreateBranchSpec,
  CreateProjectSpec,
  CreateResourceSpec,
  FetchLike,
  ManagementAdapter,
  ManagementAdapterCapabilities,
  ManagementCallOptions,
  ManagementDeleteResult,
  ManagementListQuery,
  ManagementPage,
  ManagementProviderId,
  ManagementResource,
  ManagementResourceKind,
  ManagementStatus,
  ManagementWriteResult,
  ResourceRef,
  UpdateResourceSpec,
} from './types.js';

const PROVIDER_ID: ManagementProviderId = 'supabase';
const DEFAULT_BASE_URL = 'https://api.supabase.com/v1';

/**
 * Secret-bearing keys redacted from raw payloads: the shared baseline plus Supabase-specific
 * keys (`jwt_secret` is returned by the official branch config endpoint).
 */
const REDACT_KEYS: readonly string[] = [...SECRET_KEYS, 'jwt_secret'];

// ---------------------------------------------------------------------------
// Options + raw escape hatch types
// ---------------------------------------------------------------------------

export type SupabaseManagementOptions = {
  /** Supabase personal access token (`sbp_...`). Never logged, never echoed. */
  accessToken: string;
  /** Default: the official `https://api.supabase.com/v1`. Override only for tests/self-hosted gateways. */
  baseUrl?: string;
  /** Injectable fetch (tests, offline examples). Default `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Per-request timeout in ms. Default 30_000. */
  timeoutMs?: number;
};

/** One organization from the official `GET /v1/organizations` list (no secrets). */
export type SupabaseOrganization = {
  /** Organization id (deprecated by Supabase in favor of `slug`; null when absent). */
  id: string | null;
  /** Organization slug — the value create-project expects as `organization_slug`. */
  slug: string;
  name: string;
};

/**
 * Official branch connection details (`GET /v1/branches/{branch_id_or_ref}`).
 * `dbPass` and `jwtSecret` are present ONLY when the caller opted in with
 * `includeSecrets: true` — treat them like secrets: never log them.
 */
export type SupabaseBranchConfig = {
  /** The branch's own project ref (a Supabase branch is backed by a preview project). */
  ref: string;
  dbHost: string;
  dbPort: number | null;
  dbUser: string | null;
  /** Present only with `includeSecrets: true`. */
  dbPass?: string;
  /** Present only with `includeSecrets: true`. */
  jwtSecret?: string;
  /** The branch's underlying project status, normalized. */
  status: ManagementStatus;
  providerStatus: string | null;
};

/**
 * Typed escape hatch. Members wrap verified official Management API endpoints only. Results never
 * contain secrets unless explicitly requested (`branchConfig` with `includeSecrets: true`).
 */
export type SupabaseManagementRaw = {
  /** `GET /v1/organizations` — read-only; the creation prerequisite lookup for create-project. */
  listOrganizations(callOptions?: ManagementCallOptions): Promise<SupabaseOrganization[]>;
  /**
   * `GET /v1/projects/{ref}` → `database.host` — the official database host for the direct
   * connection string. No secrets involved.
   */
  databaseHost(projectRef: string, callOptions?: ManagementCallOptions): Promise<string>;
  /**
   * `GET /v1/branches/{branch_id_or_ref}` — the only official endpoint that returns database
   * credentials for a branch. Secrets are omitted unless `includeSecrets: true`.
   */
  branchConfig(
    input: { branchIdOrRef: string },
    options?: { includeSecrets?: boolean },
    callOptions?: ManagementCallOptions,
  ): Promise<SupabaseBranchConfig>;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
    throw error(`Supabase returned an unexpected response for ${what}: expected a JSON object.`, 'PROVIDER');
  }
  return body;
}

function arrayOf(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

/** Merge optional fields into a request object, skipping `undefined` values. */
function assignDefined(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) target[key] = value;
  }
}

function rejectUnknownOptions(
  providerOptions: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
  resourceKind: ManagementResourceKind,
): void {
  const unknown = Object.keys(providerOptions).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw error(
      `create/update '${resourceKind}' ${what} accepts only the official API fields ` +
        `${allowed.map((k) => `'${k}'`).join(', ')}; got ${unknown.map((k) => `'${k}'`).join(', ')}. ` +
        'The official request body rejects unknown fields.',
      'CONFIGURATION',
      { resourceKind },
    );
  }
}

/**
 * Cryptographically random database password, 24 chars, guaranteed to include lower-case,
 * upper-case, digit, and symbol classes. The alphabet avoids URL-hostile characters (`:` `/` `@`
 * `?` `&` `=` `#` quotes and backslash) so the password is safe to embed in connection strings.
 */
export function generateDatabasePassword(): string {
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const symbols = '-_.!%^*+';
  const alphabet = `${lower}${upper}${digits}${symbols}`;
  const length = 24;

  const randomInt = (max: number): number => {
    // Rejection sampling over random bytes for an unbiased uniform integer in [0, max).
    const limit = Math.floor(256 / max) * max;
    const bytes = new Uint8Array(1);
    for (;;) {
      crypto.getRandomValues(bytes);
      if (bytes[0]! < limit) return bytes[0]! % max;
    }
  };

  const chars: string[] = [
    lower[randomInt(lower.length)]!,
    upper[randomInt(upper.length)]!,
    digits[randomInt(digits.length)]!,
    symbols[randomInt(symbols.length)]!,
  ];
  while (chars.length < length) {
    chars.push(alphabet[randomInt(alphabet.length)]!);
  }
  // Fisher-Yates shuffle with crypto randomness so the guaranteed classes are not position-pinned.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const tmp = chars[i]!;
    chars[i] = chars[j]!;
    chars[j] = tmp;
  }
  return chars.join('');
}

// ---------------------------------------------------------------------------
// Status mapping — the provider's own values, truthfully preserved
// ---------------------------------------------------------------------------

/**
 * Project lifecycle status (official enum: INACTIVE, ACTIVE_HEALTHY, ACTIVE_UNHEALTHY, COMING_UP,
 * UNKNOWN, GOING_DOWN, INIT_FAILED, REMOVED, RESTORING, UPGRADING, PAUSING, RESTORE_FAILED,
 * RESTARTING, PAUSE_FAILED, RESIZING). Also used for branch detail reads, whose status field uses
 * the same project enum.
 */
function mapProjectStatus(
  value: unknown,
): { status: ManagementStatus; providerStatus: string | null } {
  switch (value) {
    case 'ACTIVE_HEALTHY':
    case 'ACTIVE_UNHEALTHY':
      // ACTIVE_UNHEALTHY stays `active` (the database unit is up); the health caveat is preserved
      // verbatim in providerStatus for callers that gate on it.
      return { status: 'active', providerStatus: asString(value) };
    case 'COMING_UP':
    case 'RESTORING':
      return { status: 'creating', providerStatus: asString(value) };
    case 'UPGRADING':
    case 'RESIZING':
    case 'RESTARTING':
      return { status: 'updating', providerStatus: asString(value) };
    case 'GOING_DOWN':
    case 'PAUSING':
    case 'INACTIVE':
      return { status: 'paused', providerStatus: asString(value) };
    case 'REMOVED':
      return { status: 'deleting', providerStatus: asString(value) };
    case 'INIT_FAILED':
    case 'RESTORE_FAILED':
    case 'PAUSE_FAILED':
      return { status: 'failed', providerStatus: asString(value) };
    default:
      return { status: 'unknown', providerStatus: asString(value) };
  }
}

/**
 * Branch status from the create/list payload. The official branch `status` field is DEPRECATED
 * ("List action runs to get branch status instead"); readiness polling goes through
 * `get({ kind: 'branch' })`, which reads the project-style status from the branch config endpoint.
 * `preview_project_status` (the branch's underlying project status) is preferred when present.
 */
function mapBranchStatus(
  payload: Record<string, unknown>,
): { status: ManagementStatus; providerStatus: string | null } {
  const preview = payload['preview_project_status'];
  if (typeof preview === 'string') return mapProjectStatus(preview);
  switch (payload['status']) {
    case 'CREATING_PROJECT':
    case 'RUNNING_MIGRATIONS':
    case 'MIGRATIONS_PASSED':
      // Migrations passed but functions may still be deploying — not ready yet.
      return { status: 'creating', providerStatus: asString(payload['status']) };
    case 'FUNCTIONS_DEPLOYED':
      return { status: 'active', providerStatus: 'FUNCTIONS_DEPLOYED' };
    case 'MIGRATIONS_FAILED':
    case 'FUNCTIONS_FAILED':
      return { status: 'failed', providerStatus: asString(payload['status']) };
    default:
      return { status: 'unknown', providerStatus: asString(payload['status']) };
  }
}

// ---------------------------------------------------------------------------
// Payload → normalized resource mapping
// ---------------------------------------------------------------------------

function mapProject(payload: Record<string, unknown>, raw: Record<string, unknown>): ManagementResource {
  // `ref` is the canonical project identifier (`id` is deprecated); fall back to `id`.
  const id = asString(payload['ref']) ?? asString(payload['id']);
  if (id === null) {
    throw error("Supabase's project payload is missing a 'ref'.", 'PROVIDER', { resourceKind: 'project' });
  }
  const { status, providerStatus } = mapProjectStatus(payload['status']);
  return {
    kind: 'project',
    providerId: PROVIDER_ID,
    id,
    name: asString(payload['name']),
    region: asString(payload['region']),
    status,
    providerStatus,
    createdAt: asString(payload['created_at']),
    updatedAt: null, // the official project payload has no updated_at field
    raw,
  };
}

function mapBranch(
  payload: Record<string, unknown>,
  raw: Record<string, unknown>,
  parentProjectId: string,
  requestedId: string | null,
  statusMode: 'detail' | 'listing' = 'listing',
): ManagementResource {
  const id = asString(payload['id']) ?? requestedId;
  if (id === null) {
    throw error("Supabase's branch payload is missing an 'id'.", 'PROVIDER', { resourceKind: 'branch' });
  }
  // The branch detail endpoint (GET /v1/branches/{id}) reports status with the PROJECT enum;
  // create/list payloads carry the deprecated branch enum (with preview_project_status).
  const { status, providerStatus } =
    statusMode === 'detail' ? mapProjectStatus(payload['status']) : mapBranchStatus(payload);
  return {
    kind: 'branch',
    providerId: PROVIDER_ID,
    id,
    name: asString(payload['name']),
    region: null,
    status,
    providerStatus,
    createdAt: asString(payload['created_at']),
    updatedAt: asString(payload['updated_at']),
    projectId: parentProjectId,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Official request body field allow-lists (verified against the OpenAPI spec)
// ---------------------------------------------------------------------------

const PROJECT_OPTION_KEYS: readonly string[] = [
  'organization_id',
  'organization_slug',
  'region_selection',
  'desired_instance_size',
  'template_url',
  'high_availability',
];

const BRANCH_CREATE_OPTION_KEYS: readonly string[] = [
  'git_branch',
  'is_default',
  'persistent',
  'region',
  'desired_instance_size',
  'release_channel',
  'postgres_engine',
  'secrets',
  'with_data',
  'notify_url',
];

const BRANCH_UPDATE_OPTION_KEYS: readonly string[] = [
  'git_branch',
  'persistent',
  'request_review',
  'notify_url',
];

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function supabaseManagement(
  options: SupabaseManagementOptions,
): ManagementAdapter<SupabaseManagementRaw> {
  if (typeof options?.accessToken !== 'string' || options.accessToken === '') {
    throw error('supabaseManagement requires a Supabase personal access token (accessToken).', 'CONFIGURATION');
  }
  if (options.baseUrl !== undefined && options.baseUrl === '') {
    throw error('supabaseManagement baseUrl must be a non-empty string when provided.', 'CONFIGURATION');
  }

  const http = createManagementHttp({
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    token: options.accessToken,
    adapterId: PROVIDER_ID,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  });

  /**
   * Register a secret value (generated/Caller db password, branch db_pass, jwt_secret) so every
   * later error message is scrubbed of it. The shared HTTP helper redacts at construction time,
   * so any value discovered at runtime must be registered before it can leak.
   */
  function registerSecret(value: string): void {
    http.registerSecrets([value]);
  }

  const httpOptions = (options?: ManagementCallOptions) =>
    ({ signal: options?.signal, timeoutMs: options?.timeoutMs }) as const;

  const capabilities: ManagementAdapterCapabilities = {
    resourceKinds: ['project', 'branch'],
    supported: { update: ['project', 'branch'], delete: ['project', 'branch'] },
    // The official list endpoints return the full array; there is no cursor/limit anywhere.
    pagination: false,
    // No operations endpoint. wait() polls resource status via GET (core resource-polling mode).
    asyncOperations: false,
    // Both kinds expose a real lifecycle status (the official project status enum), so wait() can
    // resolve a bare ResourceRef for either kind (A3 statusPolling declaration).
    statusPolling: ['project', 'branch'],
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
      'refuse:database': 'docs',
      organizations: 'docs',
      databaseHost: 'docs',
      branchConfig: 'docs',
    },
    prerequisites: {
      // Verified 2026-10-06 against the official spec: db_pass is required (generated when
      // omitted), the organization scope is required as organization_slug (organization_id is
      // deprecated), and plan/region are deprecated (plan is organization-level; region goes
      // through region_selection, which this adapter builds from a spec region).
      'create:project': ['name', 'organizationId or providerOptions.organization_slug'],
      'create:branch': ['projectId', 'name (the API requires branch_name)'],
      'list:branch': ['projectId'],
    },
  };

  /** Refuse anything outside the two kinds this provider actually has — before any network I/O. */
  function assertManagedKind(kind: ManagementResourceKind): void {
    if (kind === 'project' || kind === 'branch') return;
    throw error(
      kind === 'database'
        ? "The Supabase Management API has no separate database resource: a Supabase project IS " +
          "the provisioned PostgreSQL database. Use create({ kind: 'project' }) and connect with " +
          'the returned credentials.'
        : `The '${PROVIDER_ID}' adapter manages 'project' and 'branch' resources only (got '${kind}').`,
      'CAPABILITY',
      { resourceKind: kind },
    );
  }

  function assertListNotPaginated(kind: ManagementResourceKind, query: ManagementListQuery): void {
    if (query.cursor !== undefined || query.limit !== undefined) {
      throw error(
        `list('${kind}') was called with cursor/limit, but Supabase's list endpoints return the ` +
          'full list and have no pagination. Omit cursor and limit.',
        'CAPABILITY',
        { resourceKind: kind },
      );
    }
  }

  function requireListProjectId(kind: ManagementResourceKind, query: ManagementListQuery): string {
    if (typeof query.projectId !== 'string' || query.projectId === '') {
      throw error(
        `list('${kind}') on Supabase requires projectId on the query object: the branch list is ` +
          `addressed by path (GET /projects/{ref}/branches).`,
        'CONFIGURATION',
        { resourceKind: kind },
      );
    }
    return query.projectId;
  }

  // ---- create ---------------------------------------------------------------

  async function createProject(
    spec: CreateProjectSpec,
    callOptions?: ManagementCallOptions,
  ): Promise<ManagementWriteResult> {
    if (spec.plan !== undefined) {
      throw error(
        "Supabase no longer accepts a 'plan' on project creation: the official API marks it " +
          'deprecated and ignores it — the subscription plan is set on the organization level. ' +
          "Remove 'plan'.",
        'CONFIGURATION',
        { resourceKind: 'project' },
      );
    }
    const providerOptions = spec.providerOptions ?? {};
    rejectUnknownOptions(providerOptions, PROJECT_OPTION_KEYS, 'providerOptions', 'project');

    // db_pass is REQUIRED by the official endpoint; generate a strong one when omitted.
    const password = spec.password ?? generateDatabasePassword();
    const generated = spec.password === undefined;
    // Register for redaction whether generated or caller-supplied: the value must never leak
    // into an error message. It is echoed to the caller only via `secrets` when generated.
    registerSecret(password);

    const body: Record<string, unknown> = { db_pass: password, name: spec.name };
    if (spec.organizationId !== undefined) body['organization_id'] = spec.organizationId;
    // A spec region maps to the current region_selection form (the flat `region` field is deprecated).
    if (spec.region !== undefined) {
      body['region_selection'] = { type: 'specific', code: spec.region };
    }
    assignDefined(body, providerOptions);

    if (body['organization_id'] === undefined && body['organization_slug'] === undefined) {
      throw error(
        "Creating a Supabase project requires an organization scope: pass organizationId (the " +
          "deprecated-but-accepted organization_id) or providerOptions: { organization_slug } " +
          '(the current required field). List your organizations with raw.listOrganizations().',
        'CONFIGURATION',
        { resourceKind: 'project' },
      );
    }

    const response = await http.request('/projects', {
      method: 'POST',
      body,
      ...httpOptions(callOptions),
    });
    const payload = bodyRecord(response.body, 'create-project');
    // The create response never echoes db_pass; redact defensively anyway.
    const resource = mapProject(payload, redactRecord(payload, REDACT_KEYS));
    return {
      resource,
      operation: null, // Supabase has no operations API; poll the project status with wait()
      secrets: generated ? [{ label: 'password', value: password }] : [],
      indeterminate: false,
    };
  }

  async function createBranch(
    spec: CreateBranchSpec,
    callOptions?: ManagementCallOptions,
  ): Promise<ManagementWriteResult> {
    if (typeof spec.name !== 'string' || spec.name.length === 0) {
      throw error(
        "Supabase requires a branch name (the official create-branch request body field " +
          "'branch_name' is required). Pass name.",
        'CONFIGURATION',
        { resourceKind: 'branch' },
      );
    }
    if (spec.sourceBranchId !== undefined) {
      throw error(
        'Supabase branches are copies of the parent project database; the official create-branch ' +
          "request has no source-branch field. Remove sourceBranchId (use providerOptions: " +
          "{ with_data: false } for a schema-only copy).",
        'CONFIGURATION',
        { resourceKind: 'branch' },
      );
    }
    const providerOptions = spec.providerOptions ?? {};
    rejectUnknownOptions(providerOptions, BRANCH_CREATE_OPTION_KEYS, 'providerOptions', 'branch');

    const body: Record<string, unknown> = { branch_name: spec.name };
    assignDefined(body, providerOptions);

    const response = await http.request(
      `/projects/${encodeSegment(spec.projectId)}/branches`,
      { method: 'POST', body, ...httpOptions(callOptions) },
    );
    const payload = bodyRecord(response.body, 'create-branch');
    const resource = mapBranch(payload, redactRecord(payload, REDACT_KEYS), spec.projectId, null);
    return {
      resource,
      operation: null,
      secrets: [], // the create-branch response carries no credentials; use raw.branchConfig
      indeterminate: false,
    };
  }

  // ---- list -----------------------------------------------------------------

  async function listProjects(
    query: ManagementListQuery,
    callOptions?: ManagementCallOptions,
  ): Promise<ManagementPage> {
    assertListNotPaginated('project', query);
    const response = await http.request('/projects', { ...httpOptions(callOptions) });
    const resources = arrayOf(response.body).map((payload) =>
      mapProject(payload, redactRecord(payload, REDACT_KEYS)),
    );
    return { kind: 'project', resources, cursor: null };
  }

  async function listBranches(
    query: ManagementListQuery,
    callOptions?: ManagementCallOptions,
  ): Promise<ManagementPage> {
    assertListNotPaginated('branch', query);
    const projectId = requireListProjectId('branch', query);
    const response = await http.request(`/projects/${encodeSegment(projectId)}/branches`, {
      ...httpOptions(callOptions),
    });
    const resources = arrayOf(response.body).map((payload) =>
      mapBranch(payload, redactRecord(payload, REDACT_KEYS), projectId, null),
    );
    return { kind: 'branch', resources, cursor: null };
  }

  // ---- get ------------------------------------------------------------------

  async function get(ref: ResourceRef, callOptions?: ManagementCallOptions): Promise<ManagementResource> {
    assertManagedKind(ref.kind);
    if (ref.kind === 'project') {
      const response = await http.request(`/projects/${encodeSegment(ref.id)}`, { ...httpOptions(callOptions) });
      const payload = bodyRecord(response.body, 'get-project');
      return mapProject(payload, redactRecord(payload, REDACT_KEYS));
    }
    // Branch: the official read/update/delete endpoints live at the top-level /branches path
    // and take the branch id or the branch's own project ref — not the parent project.
    const response = await http.request(`/branches/${encodeSegment(ref.id)}`, { ...httpOptions(callOptions) });
    const payload = bodyRecord(response.body, 'get-branch');
    return mapBranch(
      // The detail payload identifies the branch by its own ref, not by uuid id.
      { ...payload, id: payload['id'] ?? ref.id },
      redactRecord(payload, REDACT_KEYS),
      ref.projectId!,
      ref.id,
      'detail',
    );
  }

  // ---- update ---------------------------------------------------------------

  async function update(
    spec: UpdateResourceSpec,
    callOptions?: ManagementCallOptions,
  ): Promise<ManagementWriteResult> {
    assertManagedKind(spec.kind);
    const providerOptions = spec.patch.providerOptions ?? {};
    if (spec.kind === 'project') {
      if (spec.patch.owner !== undefined) {
        throw error("Supabase projects have no updatable 'owner' field via the Management API.", 'CONFIGURATION', {
          resourceKind: 'project',
          resourceId: spec.id,
        });
      }
      if (Object.keys(providerOptions).length > 0) {
        throw error(
          "update(project) accepts only 'name' (the official PATCH /projects/{ref} body requires " +
            `{ name }). Got providerOptions keys: ${Object.keys(providerOptions).map((k) => `'${k}'`).join(', ')}.`,
          'CONFIGURATION',
          { resourceKind: 'project', resourceId: spec.id },
        );
      }
      if (spec.patch.name === undefined) {
        throw error(
          'update(project) received an empty patch; the official PATCH /projects/{ref} requires { name }.',
          'CONFIGURATION',
          { resourceKind: 'project', resourceId: spec.id },
        );
      }
      const response = await http.request(`/projects/${encodeSegment(spec.id)}`, {
        method: 'PATCH',
        body: { name: spec.patch.name },
        ...httpOptions(callOptions),
      });
      const payload = bodyRecord(response.body, 'update-project');
      // The update response carries only id/ref/name; other normalized fields stay null.
      return {
        resource: mapProject({ ...payload, ref: payload['ref'] ?? spec.id }, redactRecord(payload, REDACT_KEYS)),
        operation: null,
        secrets: [],
        indeterminate: false,
      };
    }

    // branch
    if (spec.patch.owner !== undefined) {
      throw error("Branches have no updatable 'owner' field; 'owner' is a Neon database concept.", 'CONFIGURATION', {
        resourceKind: 'branch',
        resourceId: spec.id,
      });
    }
    rejectUnknownOptions(providerOptions, BRANCH_UPDATE_OPTION_KEYS, 'providerOptions', 'branch');
    if (providerOptions['status'] !== undefined) {
      throw error(
        "Branch lifecycle status is not caller-controlled in this adapter: the official PATCH body's " +
          "'status' field is deprecated. Use the dedicated reset/restore endpoints directly if needed.",
        'CONFIGURATION',
        { resourceKind: 'branch', resourceId: spec.id },
      );
    }
    if (spec.patch.name === undefined && Object.keys(providerOptions).length === 0) {
      throw error(
        'update(branch) received an empty patch; pass name (branch_name) or providerOptions ' +
          "(git_branch, persistent, request_review, notify_url).",
        'CONFIGURATION',
        { resourceKind: 'branch', resourceId: spec.id },
      );
    }
    const body: Record<string, unknown> = {};
    if (spec.patch.name !== undefined) body['branch_name'] = spec.patch.name;
    assignDefined(body, providerOptions);
    const response = await http.request(`/branches/${encodeSegment(spec.id)}`, {
      method: 'PATCH',
      body,
      ...httpOptions(callOptions),
    });
    const payload = bodyRecord(response.body, 'update-branch');
    return {
      resource: mapBranch(payload, redactRecord(payload, REDACT_KEYS), spec.projectId!, spec.id),
      operation: null,
      secrets: [],
      indeterminate: false,
    };
  }

  // ---- delete ---------------------------------------------------------------

  async function remove(
    ref: ResourceRef,
    callOptions?: ManagementCallOptions,
  ): Promise<ManagementDeleteResult> {
    assertManagedKind(ref.kind);
    const path =
      ref.kind === 'project'
        ? `/projects/${encodeSegment(ref.id)}`
        : `/branches/${encodeSegment(ref.id)}`;
    await http.request(path, { method: 'DELETE', ...httpOptions(callOptions) });
    // Both deletes answer definitively (project: the deleted summary, branch: { message: 'ok' });
    // there is no async operation to track and a definitive 2xx is not indeterminate.
    return { operation: null, indeterminate: false };
  }

  // ---- raw escape hatch -------------------------------------------------------

  async function listOrganizations(callOptions?: ManagementCallOptions): Promise<SupabaseOrganization[]> {
    const response = await http.request('/organizations', { ...httpOptions(callOptions) });
    return arrayOf(response.body).map((payload) => ({
      id: asString(payload['id']),
      slug: asString(payload['slug']) ?? '',
      name: asString(payload['name']) ?? '',
    }));
  }

  async function databaseHost(projectRef: string, callOptions?: ManagementCallOptions): Promise<string> {
    if (typeof projectRef !== 'string' || projectRef === '') {
      throw error('raw.databaseHost requires a project ref.', 'CONFIGURATION', { resourceKind: 'project' });
    }
    const response = await http.request(`/projects/${encodeSegment(projectRef)}`, { ...httpOptions(callOptions) });
    const payload = bodyRecord(response.body, 'get-project');
    const database = payload['database'];
    const host = isRecord(database) ? asString(database['host']) : null;
    if (host === null) {
      throw error(
        "Supabase's project payload carries no database.host yet (the project may still be provisioning).",
        'PROVIDER',
        { resourceKind: 'project', resourceId: projectRef },
      );
    }
    return host;
  }

  async function branchConfig(
    input: { branchIdOrRef: string },
    options?: { includeSecrets?: boolean },
    callOptions?: ManagementCallOptions,
  ): Promise<SupabaseBranchConfig> {
    const branchIdOrRef = input?.branchIdOrRef;
    if (typeof branchIdOrRef !== 'string' || branchIdOrRef === '') {
      throw error('raw.branchConfig requires branchIdOrRef.', 'CONFIGURATION', { resourceKind: 'branch' });
    }
    const response = await http.request(`/branches/${encodeSegment(branchIdOrRef)}`, { ...httpOptions(callOptions) });
    const payload = bodyRecord(response.body, 'get-branch-config');
    const dbHost = asString(payload['db_host']);
    if (dbHost === null) {
      throw error(
        "Supabase's branch config payload is missing 'db_host'.",
        'PROVIDER',
        { resourceKind: 'branch', resourceId: branchIdOrRef },
      );
    }
    const includeSecrets = options?.includeSecrets === true;
    const dbPass = asString(payload['db_pass']);
    const jwtSecret = asString(payload['jwt_secret']);
    if (includeSecrets) {
      // Register discovered credential values so every later error message is scrubbed of them.
      if (dbPass !== null) registerSecret(dbPass);
      if (jwtSecret !== null) registerSecret(jwtSecret);
    }
    const { status, providerStatus } = mapProjectStatus(payload['status']);
    return {
      ref: asString(payload['ref']) ?? '',
      dbHost,
      dbPort: typeof payload['db_port'] === 'number' ? payload['db_port'] : null,
      dbUser: asString(payload['db_user']),
      ...(includeSecrets && dbPass !== null ? { dbPass } : {}),
      ...(includeSecrets && jwtSecret !== null ? { jwtSecret } : {}),
      status,
      providerStatus,
    };
  }

  const raw: SupabaseManagementRaw = { listOrganizations, databaseHost, branchConfig };

  const adapter: ManagementAdapter<SupabaseManagementRaw> = {
    id: PROVIDER_ID,
    providerId: PROVIDER_ID,
    capabilities,
    async create(spec: CreateResourceSpec, callOptions?: ManagementCallOptions): Promise<ManagementWriteResult> {
      assertManagedKind(spec.kind);
      // The open CreateCustomSpec variant defeats literal narrowing, so cast after the kind check
      // (assertManagedKind already refused anything but 'project'/'branch').
      if (spec.kind === 'project') return createProject(spec as unknown as CreateProjectSpec, callOptions);
      return createBranch(spec as unknown as CreateBranchSpec, callOptions);
    },
    list(kind: ManagementResourceKind, query: ManagementListQuery, callOptions?: ManagementCallOptions) {
      assertManagedKind(kind);
      if (kind === 'project') return listProjects(query, callOptions);
      return listBranches(query, callOptions);
    },
    get,
    update,
    delete: remove,
    raw,
  };

  return adapter;
}
