/**
 * PlanetScale Management API adapter — PostgreSQL databases (`dbsdk/management/planetscale`).
 *
 * Implements the frozen management contract (coordination/v2-management-contract.md + A4) against
 * the official PlanetScale API v1 (base `https://api.planetscale.com/v1`). Every endpoint below
 * was verified against the official per-endpoint reference pages (each embedding the OpenAPI
 * 3.0.1 YAML, fetched 2026-10-06); see coordination/planetscale-postgres-r1.md for the inventory
 * and the gap list.
 *
 * Honest scope notes (also encoded in `capabilities`):
 * - **PostgreSQL only.** PlanetScale is three engines (Vitess/MySQL, Postgres, Neki). This
 *   adapter creates `kind: 'postgresql'` databases and refuses conflicting caller-supplied
 *   engine kinds. Vitess credentials are a DIFFERENT system (branch *passwords* — the official
 *   create_role page states Vitess/MySQL databases do not have roles); they are NOT modeled.
 *   Neki is platform preview and NOT modeled. No MySQL query semantics are claimed anywhere.
 * - **Kind mapping (no fabricated resources):** PlanetScale's *database* is the top-level
 *   managed/billable unit, so it maps to the unified `project` kind (the same normalization
 *   Supabase uses for "a project IS the database"). Branches map to the known `branch` kind with
 *   `projectId` = the database NAME SLUG. Postgres role credentials map to the provider-defined
 *   `role` kind (A2), scope `{ projectId, branchId }` = `{ database slug, branch name }`.
 * - **Slug vs uid:** databases and branches are NAME-addressed (canonical `id` = slug; the uid
 *   stays in `raw.id`). Roles are **ID-addressed** (canonical `id` = the role uid from the
 *   official `roles/{id}` paths; `name` is a separate field). The two are never conflated.
 * - **Organization scoping:** every endpoint lives under `/organizations/{organization}` (the
 *   org NAME SLUG). The factory `organization` option is the required owner for ALL CRUD
 *   verbs, including `create('project')` — a `spec.organizationId` that differs from it is
 *   refused before dispatch (a create into org B would be unreachable by later verbs, which
 *   all address the factory org; unified refs carry no organization field). Discovery
 *   (`organizations()`, `regions()`, `raw.clusterSizeSkus()`) may target other orgs
 *   explicitly. Without the factory org, org-scoped verbs fail with `CONFIGURATION` before
 *   dispatch.
 * - **No operations API.** PlanetScale has no operations endpoints for these resources;
 *   `asyncOperations` is false, write results carry `operation: null`, and `wait()` polls the
 *   resource's own status (`statusPolling` covers all three kinds). Readiness comes from real
 *   GETs: databases expose `ready` + `state`, branches expose their OWN `ready` + `state`
 *   (branch readiness is never assumed from the database), roles expose `ready`.
 * - **Engine gate everywhere (official `kind` field).** Every database response carries the
 *   required official `kind` (mysql | postgresql | neki); this adapter refuses non-PostgreSQL
 *   payloads and fails honestly on a missing kind. Every MUTATING verb (update/delete for
 *   project, create/delete for branch, create/update/delete/reset/renew for role) first
 *   fetches the parent database via its official GET path and refuses non-PostgreSQL parents
 *   BEFORE the mutation is sent — one extra documented GET per mutation, never cached, so the
 *   decision is always based on current API state. `list('project')` is engine-filtered:
 *   only PostgreSQL databases are returned; a mixed page is filtered, never surfaced.
 * - **Pagination:** these resources use PlanetScale's page-based style (`page`/`per_page`;
 *   response wrapper `current_page`/`next_page`/`data`). The unified `cursor` carries the next
 *   page NUMBER as a string — a well-defined continuation, passed back as `page=<n>`. The API's
 *   separate cursor style (`starting_after`/`has_next`) is used by other endpoints only and is
 *   not modeled here.
 * - **Credentials:** role passwords are returned ONCE (create/reset) and cannot be recovered;
 *   they surface ONLY in `secrets`, are redacted from `raw`, and are registered for error-message
 *   redaction. `connection()` can NEVER produce a password (nothing is fabricated or derived
 *   from the service token), so its `secrets` is always empty and its URI is always redacted.
 * - **Auth:** service tokens use `Authorization: <TOKEN_ID>:<TOKEN_SECRET>` — NO `Bearer`
 *   scheme (official service-tokens docs). The shared HTTP helper sends Bearer, so this adapter
 *   wraps its injectable fetch with a local rewriting wrapper (§2 of
 *   coordination/planetscale-postgres-r1.md); the shared helper's timeouts, error normalization,
 *   429/401/403 mapping, indeterminate rules and redaction registry are reused unchanged.
 */

import { ManagementError } from './errors.js';
import { createManagementHttp, redactRecord } from './http.js';
import type {
  CreateBranchSpec,
  CreateCustomSpec,
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

const PROVIDER_ID: ManagementProviderId = 'planetscale';
const DEFAULT_BASE_URL = 'https://api.planetscale.com/v1';

/** Official documented ports (postgres/connecting/quickstart): direct 5432, PgBouncer 6432. */
const DIRECT_PORT = 5432;
const POOLER_PORT = 6432;

export type PlanetScaleManagementOptions = {
  /** Service token ID. Sent (with the secret) as `Authorization: <id>:<secret>` — never logged. */
  tokenId: string;
  /** Service token secret. Never logged, never echoed, registered for error redaction. */
  tokenSecret: string;
  /**
   * Organization NAME SLUG (e.g. `acme`) used for every org-scoped path. Required for all verbs
   * except `organizations()` and `create('project')` (which prefers `spec.organizationId`).
   */
  organization?: string;
  /** Default: the official `https://api.planetscale.com/v1`. Override only for tests/gateways. */
  baseUrl?: string;
  /** Injectable fetch (tests, offline examples). Default `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Per-request timeout in ms. Default 30_000. */
  timeoutMs?: number;
};

/**
 * Typed escape hatch for official endpoints that have no unified-verb home this round.
 * Never contains secrets beyond what the official response itself carries (role payloads are
 * redacted; `clusterSizeSkus` carries no secrets).
 */
export type PlanetScaleManagementRaw = {
  /**
   * `GET /organizations/{organization}/cluster-size-skus` (official). Discovers the caller's
   * REAL cluster sizes — SKUs are never hardcoded by the adapter. The official endpoint's
   * `engine` query param DEFAULTS TO `mysql`, so this wrapper always sends `postgresql` unless
   * explicitly overridden. Returns the official array UNFILTERED — exactly what the API sent
   * (including `enabled: false` entries); filtering (e.g. by `enabled: true`) is the caller's
   * decision, and the adapter does not guess which SKUs are supported.
   */
  clusterSizeSkus(
    input?: { organization?: string; engine?: 'postgresql' | 'mysql' | 'neki' },
    callOptions?: ManagementCallOptions,
  ): Promise<readonly Record<string, unknown>[]>;
  /**
   * `POST .../branches/{branch}/roles/{id}/renew` (official): extend a role's expiration.
   * Returns the renewed role as a normalized resource (no new password is generated).
   */
  renewRole(
    input: { projectId: string; branchId: string; roleId: string },
    callOptions?: ManagementCallOptions,
  ): Promise<ManagementResource>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function arrayOf(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function error(
  message: string,
  code: 'CONFIGURATION' | 'CAPABILITY' | 'PROVIDER',
  context: { resourceKind?: ManagementResourceKind; resourceId?: string } = {},
): ManagementError {
  return new ManagementError(message, { code, adapterId: PROVIDER_ID, ...context });
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

const httpOptions = (options?: ManagementCallOptions | ManagementActionOptions | ResetCredentialOptions) =>
  ({ signal: options?.signal, timeoutMs: options?.timeoutMs }) as const;

/** Merge optional fields into a request object, skipping `undefined` values. */
function assignDefined(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) target[key] = value;
  }
}

function unknownProviderOptions(known: readonly string[], providerOptions: Record<string, unknown>): string[] {
  return Object.keys(providerOptions).filter((key) => !known.includes(key));
}

// ---------------------------------------------------------------------------
// Status mapping (readiness is real: `ready` booleans + official state enums)
// ---------------------------------------------------------------------------

function statusFromReadyAndState(
  ready: unknown,
  state: unknown,
  pendingStates: readonly string[],
  updatingStates: readonly string[],
  pausedStates: readonly string[],
): { status: ManagementStatus; providerStatus: string | null } {
  const providerStatus = asString(state);
  if (ready === true) return { status: 'active', providerStatus };
  if (providerStatus === null) return { status: 'unknown', providerStatus: null };
  if (pendingStates.includes(providerStatus)) return { status: 'creating', providerStatus };
  if (updatingStates.includes(providerStatus)) return { status: 'updating', providerStatus };
  if (pausedStates.includes(providerStatus)) return { status: 'paused', providerStatus };
  return { status: 'unknown', providerStatus };
}

function databaseStatus(payload: Record<string, unknown>): { status: ManagementStatus; providerStatus: string | null } {
  // Official create_database/get_database schema: `ready: boolean`,
  // `state: pending|importing|sleep_in_progress|sleeping|awakening|import_ready|ready`.
  return statusFromReadyAndState(
    payload['ready'],
    payload['state'],
    ['pending', 'import_ready'],
    ['importing', 'sleep_in_progress', 'awakening'],
    ['sleeping'],
  );
}

function branchStatus(payload: Record<string, unknown>): { status: ManagementStatus; providerStatus: string | null } {
  // Official get_branch schema: `ready: boolean`,
  // `state: pending|sleep_in_progress|sleeping|awakening|ready`. Read from the BRANCH payload
  // only — branch readiness is never inferred from the database's.
  return statusFromReadyAndState(payload['ready'], payload['state'], ['pending'], ['sleep_in_progress', 'awakening'], ['sleeping']);
}

function roleStatus(payload: Record<string, unknown>): { status: ManagementStatus; providerStatus: string | null } {
  // Official role schema: `ready`, `expired`, `disabled_at`, `dropped_at`, `deleted_at`,
  // `expires_at`. There is no state enum; readiness is the boolean plus lifecycle timestamps.
  // Precedence (review finding F2): terminal/deletion FIRST, then disabled/expired, and only
  // then readiness — a payload carrying `ready: true` alongside a terminal or disabled state
  // must never be reported as active.
  if (asString(payload['dropped_at']) !== null || asString(payload['deleted_at']) !== null) {
    return { status: 'deleting', providerStatus: 'dropped' };
  }
  if (payload['expired'] === true) {
    return { status: 'paused', providerStatus: 'expired' };
  }
  if (asString(payload['disabled_at']) !== null) {
    return { status: 'paused', providerStatus: 'disabled' };
  }
  if (payload['ready'] === true) return { status: 'active', providerStatus: 'ready' };
  if (payload['ready'] === false) return { status: 'creating', providerStatus: 'pending' };
  return { status: 'unknown', providerStatus: null };
}

// ---------------------------------------------------------------------------
// Payload → normalized resource mapping
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Engine gate (review finding F1): this adapter manages PostgreSQL databases only
// ---------------------------------------------------------------------------

/**
 * Every official database response carries the required `kind` enum
 * (mysql | postgresql | neki). Refuse non-PostgreSQL payloads at the single mapping
 * choke point so reads, updates and deletes can never present a Vitess/MySQL or Neki
 * database as a PostgreSQL resource. A MISSING `kind` fails honestly too: the official
 * schema marks it required, and assuming PostgreSQL would be a silent lie.
 */
function assertPostgresqlDatabase(
  payload: Record<string, unknown>,
  where: string,
  resourceId?: string,
): void {
  const kind = asString(payload['kind']);
  if (kind === null) {
    throw error(
      `${where} response has no 'kind' field. The official database schema marks kind as required ` +
        "(mysql | postgresql | neki); this adapter manages PostgreSQL databases only and cannot " +
        'assume PostgreSQL from an unrecognized payload.',
      'PROVIDER',
      { resourceKind: 'project', resourceId },
    );
  }
  if (kind !== 'postgresql') {
    throw error(
      `${where} returned a database with kind '${kind}'. This adapter manages PostgreSQL databases ` +
        "only (kind 'postgresql'); Vitess/MySQL and Neki are separate systems with their own " +
        'adapters, and this refusal happens before any mutation was sent.',
      'CONFIGURATION',
      { resourceKind: 'project', resourceId },
    );
  }
}

/**
 * Branch payloads also carry the official `kind` field. Unlike databases, this adapter
 * does NOT fail on a missing branch kind (the branch schema is the adapter's less certain
 * source); it refuses only a present, non-PostgreSQL kind.
 */
function assertPostgresqlBranch(payload: Record<string, unknown>, where: string, resourceId?: string): void {
  const kind = asString(payload['kind']);
  if (kind !== null && kind !== 'postgresql') {
    throw error(
      `${where} returned a branch with kind '${kind}'. This adapter manages PostgreSQL branches ` +
        'only; Vitess/MySQL branches are a separate system.',
      'CONFIGURATION',
      { resourceKind: 'branch', resourceId },
    );
  }
}

function mapDatabase(payload: Record<string, unknown>, raw: Record<string, unknown>): ManagementResource {
  const name = asString(payload['name']);
  if (name === null) {
    throw error("PlanetScale's database payload is missing a 'name'.", 'PROVIDER', { resourceKind: 'project' });
  }
  assertPostgresqlDatabase(payload, 'PlanetScale', name);
  const { status, providerStatus } = databaseStatus(payload);
  const region = isRecord(payload['region']) ? asString(payload['region']['slug']) : null;
  return {
    kind: 'project',
    providerId: PROVIDER_ID,
    id: name, // canonical: the NAME SLUG every database path uses; the uid stays in raw.id
    name,
    region,
    status,
    providerStatus,
    createdAt: asString(payload['created_at']),
    updatedAt: asString(payload['updated_at']),
    raw,
  };
}

function mapBranch(
  payload: Record<string, unknown>,
  raw: Record<string, unknown>,
  databaseSlug: string,
): ManagementResource {
  const name = asString(payload['name']);
  if (name === null) {
    throw error("PlanetScale's branch payload is missing a 'name'.", 'PROVIDER', { resourceKind: 'branch' });
  }
  assertPostgresqlBranch(payload, 'PlanetScale', name);
  const { status, providerStatus } = branchStatus(payload);
  const region = isRecord(payload['region']) ? asString(payload['region']['slug']) : null;
  return {
    kind: 'branch',
    providerId: PROVIDER_ID,
    id: name, // canonical: the branch NAME (paths address branches by name); uid stays in raw.id
    name,
    region,
    status,
    providerStatus,
    createdAt: asString(payload['created_at']),
    updatedAt: asString(payload['updated_at']),
    projectId: databaseSlug,
    raw,
  };
}

function mapRole(
  payload: Record<string, unknown>,
  raw: Record<string, unknown>,
  scope: ManagementScope,
): ManagementResource {
  const id = asString(payload['id']);
  if (id === null) {
    throw error("PlanetScale's role payload is missing an 'id'.", 'PROVIDER', { resourceKind: 'role' });
  }
  const { status, providerStatus } = roleStatus(payload);
  return {
    kind: 'role',
    providerId: PROVIDER_ID,
    id, // canonical: the role UID (official roles/{id} paths); the name is a separate field
    name: asString(payload['name']),
    region: null,
    status,
    providerStatus,
    createdAt: asString(payload['created_at']),
    updatedAt: asString(payload['updated_at']),
    scope: { ...scope },
    raw,
  };
}

// ---------------------------------------------------------------------------
// Page responses (official wrapper: current_page/next_page/data)
// ---------------------------------------------------------------------------

function pageData(payload: Record<string, unknown>, what: string): readonly Record<string, unknown>[] {
  if (!isRecord(payload) || !Array.isArray(payload['data'])) {
    throw error(`PlanetScale's ${what} response is missing the 'data' array.`, 'PROVIDER');
  }
  return payload['data'].filter(isRecord);
}

/** The next page NUMBER (or null). Carried verbatim as the unified cursor string. */
function nextPageCursor(payload: Record<string, unknown>): string | null {
  const next = payload['next_page'];
  return typeof next === 'number' && Number.isInteger(next) ? String(next) : null;
}

/** The unified cursor is the next page number; anything else is a caller error, not a query param. */
function cursorToPage(cursor: string | undefined, kind: ManagementResourceKind): number | undefined {
  if (cursor === undefined) return undefined;
  const page = Number(cursor);
  if (!Number.isInteger(page) || page < 1 || String(page) !== cursor.trim()) {
    throw error(
      `list('${String(kind)}') cursor must be the next page number returned by a previous page ` +
        `(PlanetScale paginates these endpoints with page/per_page, not opaque tokens). Got '${cursor}'.`,
      'CONFIGURATION',
      { resourceKind: kind },
    );
  }
  return page;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/** Extract the one-time role password BEFORE redaction; register it for error redaction. */
function rolePasswordSecret(payload: Record<string, unknown>): ManagementSecret[] {
  const password = payload['password'];
  if (typeof password !== 'string' || password === '') return [];
  const name = asString(payload['name']);
  return [{ label: name !== null ? `password:${name}` : 'password', value: password }];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function planetscaleManagement(
  options: PlanetScaleManagementOptions,
): ManagementAdapter<PlanetScaleManagementRaw> {
  const tokenId = options?.tokenId;
  const tokenSecret = options?.tokenSecret;
  if (typeof tokenId !== 'string' || tokenId === '') {
    throw error('planetscaleManagement requires tokenId (the service token ID).', 'CONFIGURATION');
  }
  if (typeof tokenSecret !== 'string' || tokenSecret === '') {
    throw error('planetscaleManagement requires tokenSecret (the service token secret).', 'CONFIGURATION');
  }
  if (options.organization !== undefined && (typeof options.organization !== 'string' || options.organization === '')) {
    throw error('planetscaleManagement organization must be a non-empty org name slug when provided.', 'CONFIGURATION');
  }
  if (options.baseUrl !== undefined && options.baseUrl === '') {
    throw error('planetscaleManagement baseUrl must be a non-empty string when provided.', 'CONFIGURATION');
  }

  const fullToken = `${tokenId}:${tokenSecret}`;

  /**
   * Auth seam (coordination/planetscale-postgres-r1.md §2): the shared management HTTP helper
   * hardcodes `Authorization: Bearer <token>`. PlanetScale service tokens use the raw
   * `<TOKEN_ID>:<TOKEN_SECRET>` value with NO Bearer scheme. Rather than fork the helper's
   * timeout/abort/error/redaction machinery, this wrapper rewrites exactly that header on the
   * way out. The shared helper receives `token = <id>:<secret>` so the FULL header value (and
   * each part, via redactValues) is registered for message redaction.
   */
  const bearerSentinel = `Bearer ${fullToken}`;
  const rewritingFetch: FetchLike = (input, init) => {
    const headers = init?.headers;
    let auth: string | null = null;
    if (headers instanceof Headers) auth = headers.get('Authorization');
    else if (isRecord(headers)) auth = typeof headers['Authorization'] === 'string' ? headers['Authorization'] : null;
    if (auth !== bearerSentinel) return options.fetch?.(input, init) ?? fetch(input, init);
    if (headers instanceof Headers) {
      const clone = new Headers(headers);
      clone.set('Authorization', fullToken);
      return (options.fetch ?? ((i, ii) => fetch(i, ii)))(input, { ...init, headers: clone });
    }
    const clone = { ...(headers as Record<string, string>), Authorization: fullToken };
    return (options.fetch ?? ((i, ii) => fetch(i, ii)))(input, { ...init, headers: clone });
  };

  const http = createManagementHttp({
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    token: fullToken,
    adapterId: PROVIDER_ID,
    fetch: rewritingFetch,
    timeoutMs: options.timeoutMs,
    // Redact each part separately too: a partial leak (e.g. only the id echoed) must also scrub.
    redactValues: [tokenId, tokenSecret],
  });

  /** Secret values scrubbed from every later error message (one-time role passwords). */
  const registerSecrets = (values: readonly string[]): void => {
    http.registerSecrets(values);
  };
  const registerRoleSecrets = (payload: Record<string, unknown>): ManagementSecret[] => {
    const secrets = rolePasswordSecret(payload);
    registerSecrets(secrets.map((secret) => secret.value));
    return secrets;
  };

  function requireOrganization(what: string): string {
    if (typeof options.organization !== 'string' || options.organization === '') {
      throw error(
        `planetscaleManagement requires the 'organization' option (the org name slug, discoverable ` +
          `via organizations()) for ${what}: every PlanetScale endpoint is addressed under ` +
          `/organizations/{organization}.`,
        'CONFIGURATION',
      );
    }
    return options.organization;
  }

  function requireScope(
    scope: ManagementScope | undefined,
    kind: ManagementResourceKind,
    required: readonly string[],
    where: string,
  ): ManagementScope {
    const value = scope ?? {};
    const missing = required.filter((field) => typeof value[field] !== 'string' || value[field] === '');
    if (missing.length > 0) {
      throw error(
        `${where} requires the scope fields ${required.map((f) => `'${f}'`).join(', ')} ` +
          `(PlanetScale addresses roles under /organizations/{org}/databases/{database}/branches/{branch}). ` +
          `Missing: ${missing.map((f) => `'${f}'`).join(', ')}.`,
        'CONFIGURATION',
        { resourceKind: kind },
      );
    }
    return value;
  }

  // ---- verbs ----------------------------------------------------------------

  /**
   * Engine pre-flight (review finding F1): fetch the REAL parent database via its official
   * GET path and refuse anything that is not `kind: 'postgresql'` BEFORE a mutation is
   * sent. Engine changes never happen mid-flight, so no cache is kept — every mutating
   * verb re-verifies against the current API state rather than trusting a stale snapshot.
   * The extra GET is the price of never mutating a Vitess/MySQL or Neki database through
   * this PostgreSQL-only adapter.
   */
  async function assertPostgresqlParent(
    organization: string,
    databaseSlug: string,
    what: string,
    callOptions?: ManagementCallOptions,
  ): Promise<void> {
    const response = await http.request(
      `/organizations/${encodeSegment(organization)}/databases/${encodeSegment(databaseSlug)}`,
      { ...httpOptions(callOptions) },
    );
    if (!isRecord(response.body)) {
      throw error(`PlanetScale's get-database response is not a JSON object.`, 'PROVIDER', {
        resourceKind: 'project',
        resourceId: databaseSlug,
      });
    }
    assertPostgresqlDatabase(response.body, what, databaseSlug);
  }

  async function createDatabase(
    spec: CreateProjectSpec,
    callOptions?: ManagementCallOptions,
  ): Promise<ManagementWriteResult> {
    if (spec.plan !== undefined) {
      throw error(
        "PlanetScale databases do not take a 'plan' field at create: the official create_database " +
          'body has no plan property (plans are applied by PlanetScale at the database level).',
        'CONFIGURATION',
        { resourceKind: 'project' },
      );
    }
    if (spec.password !== undefined) {
      throw error(
        "PlanetScale Postgres databases do not take a 'password' at create: credentials are " +
          "branch-scoped ROLES (create a 'role' afterwards; the password is returned once).",
        'CONFIGURATION',
        { resourceKind: 'project' },
      );
    }
    const providerOptions = spec.providerOptions ?? {};
    const knownKeys = ['cluster_size', 'kind', 'major_version', 'replicas', 'storage'];
    const unknownKeys = unknownProviderOptions(knownKeys, providerOptions);
    if (unknownKeys.length > 0) {
      throw error(
        `create('project') providerOptions only accepts ${knownKeys.map((k) => `'${k}'`).join(', ')} ` +
          `(the official create_database body fields). Got unknown keys: ` +
          `${unknownKeys.map((k) => `'${k}'`).join(', ')}.`,
        'CONFIGURATION',
        { resourceKind: 'project' },
      );
    }
    // Engine gate: this adapter is PostgreSQL-only; a conflicting caller kind fails loudly.
    if (providerOptions['kind'] !== undefined && providerOptions['kind'] !== 'postgresql') {
      throw error(
        `create('project') received providerOptions.kind '${String(providerOptions['kind'])}'. This ` +
          "adapter manages PostgreSQL databases only (kind 'postgresql'). Vitess/MySQL and Neki are " +
          'not supported by this adapter.',
        'CONFIGURATION',
        { resourceKind: 'project' },
      );
    }
    // cluster_size: the official page's schema lists it as required while the prose note calls it
    // optional for PostgreSQL. Without a live experiment we cannot resolve which the API enforces,
    // so the adapter requires it explicitly instead of inventing a (billable) default. Discover
    // the real SKUs with raw.clusterSizeSkus() and pass the chosen name here.
    if (typeof providerOptions['cluster_size'] !== 'string' || providerOptions['cluster_size'] === '') {
      throw error(
        "create('project') requires providerOptions.cluster_size (the official create_database schema " +
          "lists cluster_size as required; the prose calls it optional for PostgreSQL — this adapter " +
          "requires it explicitly rather than inventing a billable default). Discover your organization's " +
          "real SKUs with raw.clusterSizeSkus() and pass one (e.g. 'PS_10').",
        'CONFIGURATION',
        { resourceKind: 'project' },
      );
    }
    const storage = providerOptions['storage'];
    if (storage !== undefined && !isRecord(storage)) {
      throw error("create('project') providerOptions.storage must be an object (official storage fields).", 'CONFIGURATION', {
        resourceKind: 'project',
      });
    }
    /**
     * Organization model (review finding F4): the factory `organization` option is the ONE
     * required owner for every CRUD verb, including create('project'). A mismatch with
     * `spec.organizationId` is refused BEFORE dispatch because unified refs carry no org
     * field — a create into org B followed by verbs against the factory org A would be an
     * unreachable resource. Discovery (`organizations()`, `regions()`,
     * `raw.clusterSizeSkus()`) may still target other orgs explicitly.
     */
    const organization = requireOrganization("create('project')");
    if (spec.organizationId !== undefined && spec.organizationId !== organization) {
      throw error(
        `create('project') received spec.organizationId '${spec.organizationId}', but this adapter's ` +
          `factory organization is '${organization}'. Creating into a different organization would ` +
          'return a resource that no follow-up get/update/delete/connection can reach (unified refs ' +
          'carry no organization field; all verbs address the factory organization). Set the factory ' +
          "`organization` option to the owning org, or omit spec.organizationId. Discovery " +
          'functions (organizations(), regions(), raw.clusterSizeSkus()) may target other orgs.',
        'CONFIGURATION',
        { resourceKind: 'project' },
      );
    }
    const body: Record<string, unknown> = {
      name: spec.name,
      kind: 'postgresql',
      cluster_size: providerOptions['cluster_size'],
    };
    if (spec.region !== undefined) body['region'] = spec.region;
    if (providerOptions['major_version'] !== undefined) body['major_version'] = providerOptions['major_version'];
    if (providerOptions['replicas'] !== undefined) body['replicas'] = providerOptions['replicas'];
    if (storage !== undefined) body['storage'] = storage;

    const response = await http.request(`/organizations/${encodeSegment(organization)}/databases`, {
      method: 'POST',
      body,
      ...httpOptions(callOptions),
    });
    if (!isRecord(response.body)) {
      throw error("PlanetScale's create-database response is not a JSON object.", 'PROVIDER', {
        resourceKind: 'project',
      });
    }
    assertPostgresqlDatabase(response.body, "PlanetScale's create-database", String(spec.name));
    const resource = mapDatabase(response.body, redactRecord(response.body));
    // No operations API: the database object itself carries ready/state for wait() polling.
    return {
      resource,
      operation: null,
      secrets: [],
      indeterminate: false,
    };
  }

  async function createBranch(
    spec: CreateBranchSpec,
    callOptions?: ManagementCallOptions,
  ): Promise<ManagementWriteResult> {
    if (typeof spec.name !== 'string' || spec.name === '') {
      throw error(
        "create('branch') requires a non-empty name (the official create_branch body requires 'name').",
        'CONFIGURATION',
        { resourceKind: 'branch' },
      );
    }
    const providerOptions = spec.providerOptions ?? {};
    const knownKeys = ['region', 'deletion_protected', 'restore_point', 'replicas', 'cluster_size', 'major_version', 'storage'];
    const unknownKeys = unknownProviderOptions(knownKeys, providerOptions);
    if (unknownKeys.length > 0) {
      throw error(
        `create('branch') providerOptions only accepts ${knownKeys.map((k) => `'${k}'`).join(', ')} ` +
          '(official create_branch body fields relevant to PostgreSQL). Backup-restores ' +
          "(backup_id/seed_data) and Vitess/Neki-specific fields (keyspace_cluster_sizes, " +
          'configuration_profile_sizes, router_sizes) are not part of this round.',
        'CONFIGURATION',
        { resourceKind: 'branch' },
      );
    }
    const organization = requireOrganization(`create('branch') on '${spec.projectId}'`);
    const body: Record<string, unknown> = { name: spec.name };
    if (spec.sourceBranchId !== undefined) body['parent_branch'] = spec.sourceBranchId;
    assignDefined(body, providerOptions);

    // Engine pre-flight: a branch on a Vitess/MySQL database would be a real (wrong-engine)
    // mutation. Verify the parent database is PostgreSQL before the POST.
    await assertPostgresqlParent(organization, spec.projectId, "PlanetScale's create-branch pre-flight", callOptions);

    const response = await http.request(
      `/organizations/${encodeSegment(organization)}/databases/${encodeSegment(spec.projectId)}/branches`,
      { method: 'POST', body, ...httpOptions(callOptions) },
    );
    if (!isRecord(response.body)) {
      throw error("PlanetScale's create-branch response is not a JSON object.", 'PROVIDER', { resourceKind: 'branch' });
    }
    return {
      resource: mapBranch(response.body, redactRecord(response.body), spec.projectId),
      operation: null,
      secrets: [],
      indeterminate: false,
    };
  }

  async function createRole(
    spec: CreateCustomSpec,
    callOptions?: ManagementCallOptions,
  ): Promise<ManagementWriteResult> {
    const scope = requireScope(spec.scope, 'role', ['projectId', 'branchId'], "create('role')");
    const providerOptions = spec.providerOptions ?? {};
    const knownKeys = ['ttl', 'inherited_roles', 'with_replication', 'require_where_on_delete', 'require_where_on_update'];
    const unknownKeys = unknownProviderOptions(knownKeys, providerOptions);
    if (unknownKeys.length > 0) {
      throw error(
        `create('role') providerOptions only accepts ${knownKeys.map((k) => `'${k}'`).join(', ')} ` +
          '(the official create_role body fields). Got unknown keys: ' +
          `${unknownKeys.map((k) => `'${k}'`).join(', ')}.`,
        'CONFIGURATION',
        { resourceKind: 'role' },
      );
    }
    if (spec['name'] !== undefined && (typeof spec['name'] !== 'string' || spec['name'] === '')) {
      throw error("create('role') name must be a non-empty string when provided.", 'CONFIGURATION', {
        resourceKind: 'role',
      });
    }
    // Review finding F5: PlanetScale generates role passwords server-side (the official
    // create_role body has no password field; the returned password is a ONE-TIME secret).
    // A caller-supplied password would be silently ignored — refuse it before dispatch,
    // consistent with resetCredential.
    if (spec['password'] !== undefined) {
      throw error(
        "create('role') does not accept a caller-supplied password: PlanetScale generates role " +
          'passwords server-side and returns the ONE-TIME value in the result secrets. Omit ' +
          'password and read secrets[0] (label password:<name>).',
        'CONFIGURATION',
        { resourceKind: 'role' },
      );
    }
    const organization = requireOrganization(`create('role') on '${String(scope['projectId'])}'`);
    const body: Record<string, unknown> = {};
    if (spec['name'] !== undefined) body['name'] = spec['name'];
    assignDefined(body, providerOptions);

    // Engine pre-flight: roles exist only on PostgreSQL branches; verify the parent
    // database kind before the POST (a Vitess database has no role system at all).
    await assertPostgresqlParent(
      organization,
      String(scope['projectId']),
      "PlanetScale's create-role pre-flight",
      callOptions,
    );

    const response = await http.request(
      `/organizations/${encodeSegment(organization)}/databases/${encodeSegment(scope['projectId']!)}` +
        `/branches/${encodeSegment(scope['branchId']!)}/roles`,
      { method: 'POST', body, ...httpOptions(callOptions) },
    );
    if (!isRecord(response.body)) {
      throw error("PlanetScale's create-role response is not a JSON object.", 'PROVIDER', { resourceKind: 'role' });
    }
    return {
      resource: mapRole(response.body, redactRecord(response.body), scope),
      operation: null,
      secrets: registerRoleSecrets(response.body),
      indeterminate: false,
    };
  }

  /**
   * Page-per-request limits (review finding F8): the official pagination page states
   * per_page is capped at 100. Values above it are refused BEFORE the request instead of
   * being forwarded and silently clamped by the provider — the caller gets a page size it
   * did not ask for otherwise. The core client already enforces positive integers.
   */
  function perPageFor(kind: ManagementResourceKind, query: ManagementListQuery): number | undefined {
    if (query.limit === undefined) return undefined;
    if (query.limit > 100) {
      throw error(
        `list('${String(kind)}') limit ${query.limit} exceeds the official per_page maximum of 100 ` +
          '(PlanetScale pagination.md). Pass limit <= 100 and walk pages via the cursor ' +
          '(the next page number), or omit limit for the provider default (25).',
        'CONFIGURATION',
        { resourceKind: kind },
      );
    }
    return query.limit;
  }

  async function listPage(
    kind: ManagementResourceKind,
    path: string,
    query: ManagementListQuery,
    callOptions: ManagementCallOptions | undefined,
    map: (payload: Record<string, unknown>) => ManagementResource | null,
  ): Promise<ManagementPage> {
    const response = await http.request(path, {
      query: { page: cursorToPage(query.cursor, kind), per_page: perPageFor(kind, query) },
      ...httpOptions(callOptions),
    });
    if (!isRecord(response.body)) {
      throw error(`PlanetScale's list-${String(kind)} response is not a JSON object.`, 'PROVIDER', {
        resourceKind: kind,
      });
    }
    // The mapper returns null for entries outside this adapter's engine scope; nulls are
    // dropped (documented engine-filtered list behavior), while missing/invalid payloads
    // fail honestly inside the mapper.
    return {
      kind,
      resources: pageData(response.body, `list-${String(kind)}`)
        .map(map)
        .filter((resource): resource is ManagementResource => resource !== null),
      cursor: nextPageCursor(response.body),
    };
  }

  async function getKnown(ref: ResourceRef, callOptions?: ManagementCallOptions): Promise<ManagementResource> {
    const organization = requireOrganization(`get('${String(ref.kind)}')`);
    if (ref.kind === 'project') {
      const response = await http.request(
        `/organizations/${encodeSegment(organization)}/databases/${encodeSegment(ref.id)}`,
        { ...httpOptions(callOptions) },
      );
      if (!isRecord(response.body)) {
        throw error("PlanetScale's get-database response is not a JSON object.", 'PROVIDER', { resourceKind: 'project', resourceId: ref.id });
      }
      return mapDatabase(response.body, redactRecord(response.body));
    }
    if (ref.kind !== 'branch') {
      throw error(
        `get is not supported for kind '${String(ref.kind)}' by the 'planetscale' adapter ` +
          "(roles are provider-defined; the get path handles 'project' and 'branch').",
        'CAPABILITY',
        { resourceKind: ref.kind, resourceId: ref.id },
      );
    }
    const response = await http.request(
      `/organizations/${encodeSegment(organization)}/databases/${encodeSegment(ref.projectId!)}/branches/${encodeSegment(ref.id)}`,
      { ...httpOptions(callOptions) },
    );
    if (!isRecord(response.body)) {
      throw error("PlanetScale's get-branch response is not a JSON object.", 'PROVIDER', { resourceKind: 'branch', resourceId: ref.id });
    }
    return mapBranch(response.body, redactRecord(response.body), ref.projectId!);
  }

  async function getRole(ref: ResourceRef, callOptions?: ManagementCallOptions): Promise<ManagementResource> {
    const scope = requireScope(ref.scope, 'role', ['projectId', 'branchId'], 'get(role)');
    const organization = requireOrganization("get('role')");
    const response = await http.request(
      `/organizations/${encodeSegment(organization)}/databases/${encodeSegment(scope['projectId']!)}` +
        `/branches/${encodeSegment(scope['branchId']!)}/roles/${encodeSegment(ref.id)}`,
      { ...httpOptions(callOptions) },
    );
    if (!isRecord(response.body)) {
      throw error("PlanetScale's get-role response is not a JSON object.", 'PROVIDER', { resourceKind: 'role', resourceId: ref.id });
    }
    return mapRole(response.body, redactRecord(response.body), scope);
  }

  async function updateProject(
    spec: UpdateResourceSpec,
    callOptions?: ManagementCallOptions,
  ): Promise<ManagementWriteResult> {
    const providerOptions = spec.patch.providerOptions ?? {};
    // Official update_database_settings (PATCH) fields. Vitess-only fields are refused, not
    // silently dropped: automatic_migrations, migration_framework, migration_table_name,
    // allow_data_branching, allow_foreign_key_constraints are marked "(Vitess only)" in the spec.
    const knownKeys = [
      'deletion_protected',
      'default_branch',
      'development_branches_limit',
      'require_approval_for_deploy',
      'restrict_branch_region',
      'insights_raw_queries',
      'production_branch_web_console',
    ];
    const vitessOnly = ['automatic_migrations', 'migration_framework', 'migration_table_name', 'allow_data_branching', 'allow_foreign_key_constraints'];
    const unknownKeys = unknownProviderOptions([...knownKeys, ...vitessOnly], providerOptions);
    if (unknownKeys.length > 0) {
      throw error(
        `update('project') providerOptions only accepts ${knownKeys.map((k) => `'${k}'`).join(', ')} ` +
          '(official update_database_settings body fields). Got unknown keys: ' +
          `${unknownKeys.map((k) => `'${k}'`).join(', ')}.`,
        'CONFIGURATION',
        { resourceKind: 'project', resourceId: spec.id },
      );
    }
    for (const key of vitessOnly) {
      if (providerOptions[key] !== undefined) {
        throw error(
          `update('project') providerOptions.${key} is a Vitess-only database setting (the official ` +
            'spec marks it "(Vitess only)"); this PostgreSQL adapter refuses it instead of sending it.',
          'CONFIGURATION',
          { resourceKind: 'project', resourceId: spec.id },
        );
      }
    }
    if (spec.patch.name === undefined && Object.keys(providerOptions).length === 0) {
      throw error(
        "update('project') received an empty patch; pass name or providerOptions (e.g. deletion_protected, default_branch).",
        'CONFIGURATION',
        { resourceKind: 'project', resourceId: spec.id },
      );
    }
    const organization = requireOrganization(`update('project') on '${spec.id}'`);
    const body: Record<string, unknown> = {};
    if (spec.patch.name !== undefined) body['new_name'] = spec.patch.name;
    assignDefined(body, providerOptions);
    // Engine pre-flight: verify the database is PostgreSQL BEFORE the PATCH mutation
    // (the mapped PATCH response alone would only make the error honest after the fact).
    await assertPostgresqlParent(organization, spec.id, "PlanetScale's update-database pre-flight", callOptions);
    const response = await http.request(
      `/organizations/${encodeSegment(organization)}/databases/${encodeSegment(spec.id)}`,
      { method: 'PATCH', body, ...httpOptions(callOptions) },
    );
    if (!isRecord(response.body)) {
      throw error("PlanetScale's update-database response is not a JSON object.", 'PROVIDER', {
        resourceKind: 'project',
        resourceId: spec.id,
      });
    }
    return {
      resource: mapDatabase(response.body, redactRecord(response.body)),
      operation: null,
      secrets: [],
      indeterminate: false,
    };
  }

  async function updateRole(
    spec: UpdateResourceSpec,
    callOptions?: ManagementCallOptions,
  ): Promise<ManagementWriteResult> {
    const scope = requireScope(spec.scope, 'role', ['projectId', 'branchId'], "update('role')");
    const providerOptions = spec.patch.providerOptions ?? {};
    const knownKeys = ['require_where_on_delete', 'require_where_on_update'];
    const unknownKeys = unknownProviderOptions(knownKeys, providerOptions);
    if (unknownKeys.length > 0) {
      throw error(
        `update('role') providerOptions only accepts ${knownKeys.map((k) => `'${k}'`).join(', ')} ` +
          '(official update_role body fields). Got unknown keys: ' +
          `${unknownKeys.map((k) => `'${k}'`).join(', ')}.`,
        'CONFIGURATION',
        { resourceKind: 'role', resourceId: spec.id },
      );
    }
    if (spec.patch.name === undefined && Object.keys(providerOptions).length === 0) {
      throw error(
        "update('role') received an empty patch; pass name or providerOptions (require_where_on_delete, require_where_on_update).",
        'CONFIGURATION',
        { resourceKind: 'role', resourceId: spec.id },
      );
    }
    const organization = requireOrganization(`update('role') on '${spec.id}'`);
    const body: Record<string, unknown> = {};
    if (spec.patch.name !== undefined) body['name'] = spec.patch.name;
    assignDefined(body, providerOptions);
    // Engine pre-flight: verify the parent database is PostgreSQL before the PATCH.
    await assertPostgresqlParent(
      organization,
      String(scope['projectId']),
      "PlanetScale's update-role pre-flight",
      callOptions,
    );
    const response = await http.request(
      `/organizations/${encodeSegment(organization)}/databases/${encodeSegment(scope['projectId']!)}` +
        `/branches/${encodeSegment(scope['branchId']!)}/roles/${encodeSegment(spec.id)}`,
      { method: 'PATCH', body, ...httpOptions(callOptions) },
    );
    if (!isRecord(response.body)) {
      throw error("PlanetScale's update-role response is not a JSON object.", 'PROVIDER', {
        resourceKind: 'role',
        resourceId: spec.id,
      });
    }
    return {
      resource: mapRole(response.body, redactRecord(response.body), scope),
      operation: null,
      secrets: [],
      indeterminate: false,
    };
  }

  async function remove(ref: ResourceRef, callOptions?: ManagementCallOptions): Promise<ManagementDeleteResult> {
    const organization = requireOrganization(`delete('${String(ref.kind)}')`);
    let path: string;
    if (ref.kind === 'project') {
      path = `/organizations/${encodeSegment(organization)}/databases/${encodeSegment(ref.id)}`;
      // Engine pre-flight: verify kind=postgresql BEFORE the destructive DELETE.
      await assertPostgresqlParent(organization, ref.id, "PlanetScale's delete pre-flight", callOptions);
    } else if (ref.kind === 'branch') {
      const databaseSlug = ref.projectId!;
      path =
        `/organizations/${encodeSegment(organization)}/databases/${encodeSegment(databaseSlug)}` +
        `/branches/${encodeSegment(ref.id)}`;
      // Engine pre-flight: never delete a Vitess/MySQL branch through this adapter.
      await assertPostgresqlParent(organization, databaseSlug, "PlanetScale's delete-branch pre-flight", callOptions);
    } else if (ref.kind === 'role') {
      const scope = requireScope(ref.scope, 'role', ['projectId', 'branchId'], "delete('role')");
      path =
        `/organizations/${encodeSegment(organization)}/databases/${encodeSegment(scope['projectId']!)}` +
        `/branches/${encodeSegment(scope['branchId']!)}/roles/${encodeSegment(ref.id)}`;
      // Engine pre-flight: roles exist only on PostgreSQL branches; verify before DELETE.
      await assertPostgresqlParent(
        organization,
        String(scope['projectId']),
        "PlanetScale's delete-role pre-flight",
        callOptions,
      );
    } else {
      throw error(
        `delete is not supported for kind '${String(ref.kind)}' by the 'planetscale' adapter. ` +
          "PlanetScale manages 'project' (database), 'branch', and 'role'.",
        'CAPABILITY',
        { resourceKind: ref.kind, resourceId: ref.id },
      );
    }
    await http.request(path, { method: 'DELETE', ...httpOptions(callOptions) });
    // Official responses are 204 with no body and no operations API — nothing to fabricate.
    return { operation: null, indeterminate: false };
  }

  // ---- A4: discovery ----------------------------------------------------------

  async function listOrganizations(callOptions?: ManagementCallOptions): Promise<readonly ManagementOrganization[]> {
    // Official description: "When using a service token, returns the list of organizations the
    // service token has access to." Page-based; walk pages so nothing is silently dropped.
    const orgs: ManagementOrganization[] = [];
    let page = 1;
    for (;;) {
      const response = await http.request('/organizations', {
        query: { page, per_page: 100 },
        ...httpOptions(callOptions),
      });
      if (!isRecord(response.body)) {
        throw error("PlanetScale's list-organizations response is not a JSON object.", 'PROVIDER');
      }
      for (const org of pageData(response.body, 'list-organizations')) {
        const slug = asString(org['name']);
        if (slug === null) {
          throw error("PlanetScale's organization payload is missing a 'name' (the org slug).", 'PROVIDER');
        }
        orgs.push({
          providerId: PROVIDER_ID,
          // Canonical id = the NAME SLUG (the value every org-scoped path requires);
          // the uid stays visible as aliasId and in raw.
          id: slug,
          name: slug,
          aliasId: asString(org['id']),
          raw: redactRecord(org),
        });
      }
      const next = nextPageCursor(response.body);
      if (next === null) break;
      page = Number(next);
      if (!Number.isInteger(page) || page <= 0 || page > 200) {
        throw error(`PlanetScale's list-organizations pagination is not terminating (page ${page}).`, 'PROVIDER');
      }
    }
    return orgs;
  }

  async function listRegions(
    input: { organizationId?: string },
    callOptions?: ManagementCallOptions,
  ): Promise<readonly ManagementRegion[]> {
    const organization =
      typeof input?.organizationId === 'string' && input.organizationId !== ''
        ? input.organizationId
        : requireOrganization('regions() without input.organizationId');
    const regions: ManagementRegion[] = [];
    let page = 1;
    for (;;) {
      const response = await http.request(`/organizations/${encodeSegment(organization)}/regions`, {
        query: { page, per_page: 100 },
        ...httpOptions(callOptions),
      });
      if (!isRecord(response.body)) {
        throw error("PlanetScale's list-regions response is not a JSON object.", 'PROVIDER');
      }
      for (const region of pageData(response.body, 'list-regions')) {
        const slug = asString(region['slug']);
        if (slug === null) {
          throw error("PlanetScale's region payload is missing a 'slug'.", 'PROVIDER');
        }
        // Engine flags + enabled honored (coordination/planetscale-postgres-r1.md §1.4): only
        // regions where a PostgreSQL database can actually be created are surfaced.
        if (region['enabled'] !== true || region['postgresql_supported'] !== true) continue;
        regions.push({
          providerId: PROVIDER_ID,
          id: slug,
          name: asString(region['display_name']),
          platform: asString(region['provider']),
          default: region['current_default'] === true,
          // Full payload (all three engine flags, public IPs, location) preserved in raw.
          raw: redactRecord(region),
        });
      }
      const next = nextPageCursor(response.body);
      if (next === null) break;
      page = Number(next);
      if (!Number.isInteger(page) || page <= 0 || page > 200) {
        throw error(`PlanetScale's list-regions pagination is not terminating (page ${page}).`, 'PROVIDER');
      }
    }
    return regions;
  }

  // ---- A4: connection ---------------------------------------------------------

  /**
   * Parse the host out of a role's `access_host_url`. The official schema types it as a string
   * ("The database connection string"); in practice it is the hostname
   * (`{id+region}.horizon.psdb.cloud`). If the value ever carries a scheme/port, parse it
   * truthfully; otherwise pass it through as the host.
   */
  function hostFromAccessHostUrl(value: unknown): string | null {
    const text = asString(value);
    if (text === null || text === '') return null;
    try {
      const parsed = new URL(`postgresql://${text}`);
      return parsed.hostname !== '' ? parsed.hostname : text;
    } catch {
      return text;
    }
  }

  async function fetchRolePayload(
    organization: string,
    databaseSlug: string,
    branchName: string,
    roleId: string,
    callOptions?: ManagementCallOptions,
  ): Promise<Record<string, unknown>> {
    const response = await http.request(
      `/organizations/${encodeSegment(organization)}/databases/${encodeSegment(databaseSlug)}` +
        `/branches/${encodeSegment(branchName)}/roles/${encodeSegment(roleId)}`,
      { ...httpOptions(callOptions) },
    );
    if (!isRecord(response.body)) {
      throw error("PlanetScale's role response is not a JSON object.", 'PROVIDER', { resourceKind: 'role', resourceId: roleId });
    }
    return response.body;
  }

  async function connectionInfo(
    ref: ResourceRef,
    input: ManagementConnectionInput,
    callOptions?: ManagementCallOptions,
  ): Promise<ManagementConnectionInfo> {
    const organization = requireOrganization(`connection('${String(ref.kind)}')`);
    let rolePayload: Record<string, unknown>;
    let projectId: string | null;
    let branchId: string | null;
    if (ref.kind === 'role') {
      const scope = requireScope(ref.scope, 'role', ['projectId', 'branchId'], 'connection(role)');
      projectId = scope['projectId']!;
      branchId = scope['branchId']!;
      rolePayload = await fetchRolePayload(organization, projectId, branchId, ref.id, callOptions);
    } else if (ref.kind === 'branch') {
      // Official get_default_role: GET .../branches/{branch}/roles/default.
      projectId = ref.projectId!;
      branchId = ref.id;
      rolePayload = await fetchRolePayload(organization, projectId, branchId, 'default', callOptions);
    } else if (ref.kind === 'project') {
      // Two official GETs: get_database (carries `default_branch`) then that branch's default role.
      const dbResponse = await http.request(
        `/organizations/${encodeSegment(organization)}/databases/${encodeSegment(ref.id)}`,
        { ...httpOptions(callOptions) },
      );
      if (!isRecord(dbResponse.body)) {
        throw error("PlanetScale's get-database response is not a JSON object.", 'PROVIDER', {
          resourceKind: 'project',
          resourceId: ref.id,
        });
      }
      // Engine gate: never hand out PostgreSQL connection details for a Vitess/MySQL or
      // Neki database (the GET is already required here, so this adds no request).
      assertPostgresqlDatabase(dbResponse.body, "PlanetScale's connection('project') lookup", ref.id);
      const defaultBranch = asString(dbResponse.body['default_branch']);
      if (defaultBranch === null || defaultBranch === '') {
        throw error(
          `connection('project') could not determine the database's default_branch from the official ` +
            'get_database response; fetch a role explicitly and call connection({ kind: \'role\' }).',
          'PROVIDER',
          { resourceKind: 'project', resourceId: ref.id },
        );
      }
      projectId = ref.id;
      branchId = defaultBranch;
      rolePayload = await fetchRolePayload(organization, projectId, defaultBranch, 'default', callOptions);
    } else {
      throw error(
        `connection is not supported for kind '${String(ref.kind)}' by the 'planetscale' adapter. ` +
          "PlanetScale exposes connection hosts on ROLES; supported kinds: 'project', 'branch', 'role'.",
        'CAPABILITY',
        { resourceKind: ref.kind, resourceId: ref.id },
      );
    }

    const host = hostFromAccessHostUrl(rolePayload['access_host_url']);
    const username = asString(rolePayload['username']);
    const database = asString(rolePayload['database_name']);
    const pooled = input.pooled === true;
    const port = pooled ? POOLER_PORT : DIRECT_PORT; // official documented convention, not an API field
    const redactedUri =
      host !== null && username !== null && database !== null
        ? `postgresql://${encodeURIComponent(username)}:[redacted]@${host}:${port}/${encodeURIComponent(database)}`
        : null;

    return {
      providerId: PROVIDER_ID,
      kind: ref.kind,
      id: ref.id,
      projectId,
      branchId,
      host,
      port,
      database,
      role: username,
      pooled: input.pooled ?? null,
      redactedUri,
      // PlanetScale cannot return role passwords after creation (one-time secret), so there is
      // nothing to reveal here — an empty list is the honest answer, never a fabricated value.
      secrets: [],
      raw: { role: redactRecord(rolePayload) },
    };
  }

  // ---- A4: resetCredential ------------------------------------------------------

  async function resetRoleCredential(
    ref: ResourceRef,
    options: ResetCredentialOptions,
  ): Promise<ManagementWriteResult> {
    if (ref.kind !== 'role') {
      throw error(
        `resetCredential is not supported for kind '${String(ref.kind)}' by the 'planetscale' adapter: ` +
          "Postgres credentials are ROLES (POST .../roles/{id}/reset). Vitess branch passwords are a " +
          'separate system this adapter does not manage.',
        'CAPABILITY',
        { resourceKind: ref.kind, resourceId: ref.id },
      );
    }
    if (options.password !== undefined) {
      throw error(
        'PlanetScale generates the new role password server-side; the official reset_role endpoint ' +
          'takes no body. Omit password and read the returned one-time value from the result secrets.',
        'CONFIGURATION',
        { resourceKind: 'role', resourceId: ref.id },
      );
    }
    const scope = requireScope(ref.scope, 'role', ['projectId', 'branchId'], 'resetCredential(role)');
    const organization = requireOrganization("resetCredential('role')");
    // Engine pre-flight: verify the parent database is PostgreSQL before rotating the
    // credential (review finding F1 — no mutation may be sent against a Vitess database).
    await assertPostgresqlParent(organization, String(scope['projectId']), "PlanetScale's reset-credential pre-flight", options);
    const response = await http.request(
      `/organizations/${encodeSegment(organization)}/databases/${encodeSegment(scope['projectId']!)}` +
        `/branches/${encodeSegment(scope['branchId']!)}/roles/${encodeSegment(ref.id)}/reset`,
      { method: 'POST', ...httpOptions(options) },
    );
    if (!isRecord(response.body)) {
      throw error("PlanetScale's reset-role response is not a JSON object.", 'PROVIDER', {
        resourceKind: 'role',
        resourceId: ref.id,
      });
    }
    return {
      resource: mapRole(response.body, redactRecord(response.body), scope),
      operation: null,
      secrets: registerRoleSecrets(response.body),
      indeterminate: false,
    };
  }

  // ---- raw escape hatch ---------------------------------------------------------

  async function clusterSizeSkus(
    input: { organization?: string; engine?: 'postgresql' | 'mysql' | 'neki' } = {},
    callOptions?: ManagementCallOptions,
  ): Promise<readonly Record<string, unknown>[]> {
    const organization =
      typeof input.organization === 'string' && input.organization !== ''
        ? input.organization
        : requireOrganization('raw.clusterSizeSkus() without input.organization');
    const response = await http.request(`/organizations/${encodeSegment(organization)}/cluster-size-skus`, {
      // The official endpoint's engine param DEFAULTS TO 'mysql' — always send one explicitly.
      query: { engine: input.engine ?? 'postgresql' },
      ...httpOptions(callOptions),
    });
    if (!Array.isArray(response.body)) {
      throw error("PlanetScale's cluster-size-skus response is not an array.", 'PROVIDER');
    }
    return response.body.filter(isRecord);
  }

  async function renewRole(
    input: { projectId: string; branchId: string; roleId: string },
    callOptions?: ManagementCallOptions,
  ): Promise<ManagementResource> {
    if (typeof input?.projectId !== 'string' || input.projectId === '') {
      throw error('raw.renewRole requires projectId (the database name slug).', 'CONFIGURATION', { resourceKind: 'role' });
    }
    if (typeof input?.branchId !== 'string' || input.branchId === '') {
      throw error('raw.renewRole requires branchId (the branch name).', 'CONFIGURATION', { resourceKind: 'role' });
    }
    if (typeof input?.roleId !== 'string' || input.roleId === '') {
      throw error('raw.renewRole requires roleId (the role ID).', 'CONFIGURATION', { resourceKind: 'role' });
    }
    const organization = requireOrganization('raw.renewRole');
    const scope: ManagementScope = { projectId: input.projectId, branchId: input.branchId };
    // Engine pre-flight: renew is a mutation too — verify the parent database is
    // PostgreSQL before the POST.
    await assertPostgresqlParent(organization, input.projectId, "PlanetScale's renew-role pre-flight", callOptions);
    const response = await http.request(
      `/organizations/${encodeSegment(organization)}/databases/${encodeSegment(input.projectId)}` +
        `/branches/${encodeSegment(input.branchId)}/roles/${encodeSegment(input.roleId)}/renew`,
      { method: 'POST', ...httpOptions(callOptions) },
    );
    if (!isRecord(response.body)) {
      throw error("PlanetScale's renew-role response is not a JSON object.", 'PROVIDER', {
        resourceKind: 'role',
        resourceId: input.roleId,
      });
    }
    return mapRole(response.body, redactRecord(response.body), scope);
  }

  // ---- capabilities -------------------------------------------------------------

  const capabilities: ManagementAdapterCapabilities = {
    // 'project' = PlanetScale database (the managed/billable unit — no fabricated project kind),
    // 'branch' = PlanetScale branch, 'role' = Postgres role credentials (A2 provider-defined kind).
    resourceKinds: ['project', 'branch', 'role'],
    supported: {
      // update_branch exists officially but was not verified this round — refused rather than
      // guessed (coordination/planetscale-postgres-r1.md §6 gap 5).
      update: ['project', 'role'],
      delete: ['project', 'branch', 'role'],
      // Connection hosts live on roles; 'project'/'branch' resolve via the official default role.
      connection: ['project', 'branch', 'role'],
      resetCredential: ['role'],
      // No pause/restart/resume-style lifecycle endpoints exist for PlanetScale Postgres.
      actions: {},
    },
    // Page-based pagination on every implemented list endpoint.
    pagination: true,
    // PlanetScale has no operations API for these resources; wait() polls resource status.
    asyncOperations: false,
    // All three kinds expose real readiness (ready booleans / state enums) on their own GETs.
    statusPolling: ['project', 'branch', 'role'],
    resourceScopes: {
      role: ['projectId', 'branchId'],
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
      'delete:branch': 'docs',
      'create:role': 'docs',
      'list:role': 'docs',
      'get:role': 'docs',
      'update:role': 'docs',
      'delete:role': 'docs',
      'resetCredential:role': 'docs',
      organizations: 'docs',
      regions: 'docs',
      'connection:project': 'docs',
      'connection:branch': 'docs',
      'connection:role': 'docs',
      'pagination:project': 'docs',
      'pagination:branch': 'docs',
      'pagination:role': 'docs',
      clusterSizeSkus: 'docs',
      renewRole: 'docs',
    },
    prerequisites: {
      'create:project': ['name', 'providerOptions.cluster_size', 'organization (factory option; spec.organizationId must match)'],
      'list:project': ['organization (factory option)'],
      'get:project': ['organization (factory option)'],
      'update:project': ['organization (factory option)'],
      'delete:project': ['organization (factory option)'],
      'create:branch': ['projectId (database name slug)', 'name'],
      'list:branch': ['projectId (database name slug)', 'organization (factory option)'],
      'create:role': ['scope.projectId (database slug)', 'scope.branchId (branch name)'],
      'list:role': ['scope.projectId', 'scope.branchId', 'organization (factory option)'],
      regions: ['organizationId (input or factory organization)'],
      'connection:project': ['organization (factory option)'],
      'connection:branch': ['projectId (database name slug)', 'organization (factory option)'],
      'connection:role': ['scope.projectId', 'scope.branchId', 'organization (factory option)'],
      'resetCredential:role': ['scope.projectId', 'scope.branchId', 'organization (factory option)'],
    },
  };

  const adapter: ManagementAdapter<PlanetScaleManagementRaw> = {
    id: PROVIDER_ID,
    providerId: PROVIDER_ID,
    capabilities,
    async create(spec: CreateResourceSpec, callOptions?: ManagementCallOptions): Promise<ManagementWriteResult> {
      if (spec.kind === 'project') return createDatabase(spec as CreateProjectSpec, callOptions);
      if (spec.kind === 'branch') return createBranch(spec as CreateBranchSpec, callOptions);
      if (spec.kind === 'role') return createRole(spec as CreateCustomSpec, callOptions);
      throw error(
        `create is not supported for kind '${String(spec.kind)}' by the 'planetscale' adapter. ` +
          "PlanetScale (PostgreSQL) manages 'project' (the database), 'branch', and 'role' only. " +
          "Vitess/MySQL databases use branch passwords (a separate system) and Neki is platform preview.",
        'CAPABILITY',
        { resourceKind: spec.kind as ManagementResourceKind },
      );
    },
    list(kind: ManagementResourceKind, query: ManagementListQuery, callOptions?: ManagementCallOptions): Promise<ManagementPage> {
      const organization = requireOrganization(`list('${String(kind)}')`);
      if (kind === 'project') {
        // Engine-filtered list behavior (review finding F1), explicit: the list endpoint
        // returns ALL of the organization's databases (any engine), so this adapter returns
        // ONLY the PostgreSQL ones. A mixed page is filtered, not failed; an entry MISSING
        // the required official `kind` field fails honestly instead of being assumed
        // PostgreSQL.
        return listPage(kind, `/organizations/${encodeSegment(organization)}/databases`, query, callOptions, (payload) => {
          const entryKind = asString(payload['kind']);
          if (entryKind === null) {
            throw error(
              "PlanetScale's list-databases response contains a database without the required official " +
                "'kind' field; this adapter manages PostgreSQL databases only and cannot assume PostgreSQL.",
              'PROVIDER',
              { resourceKind: 'project' },
            );
          }
          if (entryKind !== 'postgresql') return null; // Vitess/MySQL or Neki: filtered, never surfaced
          return mapDatabase(payload, redactRecord(payload));
        });
      }
      if (kind === 'branch') {
        const databaseSlug = typeof query.projectId === 'string' && query.projectId !== '' ? query.projectId : '';
        if (databaseSlug === '') {
          throw error("list('branch') requires projectId (the database name slug).", 'CONFIGURATION', {
            resourceKind: 'branch',
          });
        }
        return listPage(
          kind,
          `/organizations/${encodeSegment(organization)}/databases/${encodeSegment(databaseSlug)}/branches`,
          query,
          callOptions,
          (payload) => {
            // Same explicit engine filter: present non-PostgreSQL branch kinds are dropped.
            const entryKind = asString(payload['kind']);
            if (entryKind !== null && entryKind !== 'postgresql') return null;
            return mapBranch(payload, redactRecord(payload), databaseSlug);
          },
        );
      }
      if (kind === 'role') {
        const scope = requireScope(query.scope, 'role', ['projectId', 'branchId'], "list('role')");
        return listPage(
          kind,
          `/organizations/${encodeSegment(organization)}/databases/${encodeSegment(scope['projectId']!)}` +
            `/branches/${encodeSegment(scope['branchId']!)}/roles`,
          query,
          callOptions,
          (payload) => mapRole(payload, redactRecord(payload), scope),
        );
      }
      throw error(
        `list is not supported for kind '${String(kind)}' by the 'planetscale' adapter. ` +
          "PlanetScale (PostgreSQL) manages 'project' (the database), 'branch', and 'role' only.",
        'CAPABILITY',
        { resourceKind: kind },
      );
    },
    async get(ref: ResourceRef, callOptions?: ManagementCallOptions): Promise<ManagementResource> {
      if (ref.kind === 'project' || ref.kind === 'branch') return getKnown(ref, callOptions);
      if (ref.kind === 'role') return getRole(ref, callOptions);
      throw error(
        `get is not supported for kind '${String(ref.kind)}' by the 'planetscale' adapter. ` +
          "PlanetScale (PostgreSQL) manages 'project' (the database), 'branch', and 'role' only.",
        'CAPABILITY',
        { resourceKind: ref.kind, resourceId: ref.id },
      );
    },
    async update(spec: UpdateResourceSpec, callOptions?: ManagementCallOptions): Promise<ManagementWriteResult> {
      if (spec.kind === 'project') return updateProject(spec, callOptions);
      if (spec.kind === 'role') return updateRole(spec, callOptions);
      throw error(
        `update is not supported for kind '${String(spec.kind)}' by the 'planetscale' adapter. ` +
          "Kinds supporting update: 'project' (database settings), 'role' (name, query-safety). " +
          'The official branch PATCH endpoint was not verified this round and is refused rather than guessed.',
        'CAPABILITY',
        { resourceKind: spec.kind, resourceId: spec.id },
      );
    },
    delete: remove,
    organizations: listOrganizations,
    regions: listRegions,
    connection: connectionInfo,
    action: undefined,
    resetCredential: resetRoleCredential,
    raw: { clusterSizeSkus, renewRole },
  };

  return adapter;
}
