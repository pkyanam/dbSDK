/**
 * dbSDK management contract — the shared vocabulary for the control plane.
 *
 * This is the single source of truth (see coordination/v2-management-contract.md).
 * The management layer is a control-plane SDK: the user brings their own provider credential and
 * gets one stable verb set — create / list / get / update / delete / wait — over normalized
 * resources, plus the existing query foundation (the SQL client). There is no central dbSDK
 * backend, no credential proxying, no automatic replay of create/delete, and no silent mapping
 * between provider resource models.
 *
 * Design invariants (mirroring the SQL contract in `src/types.ts`):
 * - Capability and scope checks happen BEFORE dispatch — no request is made for an unsupported
 *   kind, verb, or pagination argument.
 * - Secrets appear only in explicit `ManagementSecret` results; provider `raw` payloads are
 *   redacted.
 * - Resource models are normalized but never falsified: provider-specific identity and scope
 *   (e.g. Neon databases live on branches) is part of the types, not hidden.
 */

import type { EvidenceLevel } from '../types.js';

export type { EvidenceLevel };

/**
 * The known built-in providers. The closed union exists only to type the built-in factories
 * (`dbsdk/management/supabase`, `dbsdk/management/neon`).
 */
export type KnownManagementProviderId = 'supabase' | 'neon';

/**
 * Adapter provider identity — deliberately an open string so third-party adapters for other
 * major providers can be written without touching this package. Resources, operations, errors
 * and clients all carry the open `ManagementProviderId`; the closed
 * {@link KnownManagementProviderId} union is only a typing convenience for the built-ins.
 */
export type ManagementProviderId = string;

/**
 * The known normalized resource kinds. This closed union exists for typing convenience and
 * editor autocomplete; the open {@link ManagementResourceKind} accepts additional
 * provider-defined kinds (e.g. a Convex deployment or a PlanetScale database) without breaking
 * existing callers. Adding a *known* kind is a contract change owned in
 * coordination/v2-management-contract.md.
 *
 * Semantics of the known kinds (deliberately small and honest):
 * - `project`: the top-level billable unit on both providers (a Supabase project *is* a
 *   PostgreSQL database; a Neon project is a container whose default branch carries one).
 * - `branch`: a Neon branch (Supabase branching exists via its Environments API but is a paid
 *   add-on; the kind is still shared and adapters declare whether they support it).
 * - `database`: a logical PostgreSQL database. Neon-scoped to `{ projectId, branchId }` and
 *   identified by name; Supabase has no such resource (creating one is refused with
 *   `CAPABILITY`).
 */
export type KnownManagementResourceKind = 'project' | 'branch' | 'database';

/**
 * Normalized resource kinds — open for extension. The known kinds carry first-class scope rules
 * (enforced by the core client); provider-defined kinds declare their scope requirements in
 * `capabilities.resourceScopes` and are validated the same way. The lifecycle layer must not
 * assume every future provider looks like Postgres projects/branches: non-SQL services (e.g.
 * Convex) plug in with their own kinds and never get fabricated SQL semantics.
 */
export type ManagementResourceKind = KnownManagementResourceKind | (string & {});

/**
 * Generic scope extension for provider-defined kinds: extra identity dimensions beyond the
 * first-class `projectId`/`branchId` fields (e.g. `organization`, `cluster`, `region`). Values
 * are non-empty strings; adapters validate their own semantics.
 */
export type ManagementScope = Readonly<Record<string, string>>;

/** A normalized lifecycle status. The provider's own status is always preserved in `providerStatus`. */
export type ManagementStatus =
  | 'active'
  | 'creating'
  | 'updating'
  | 'deleting'
  | 'paused'
  | 'failed'
  | 'unknown';

/** A normalized management resource with secret-bearing fields redacted from `raw`. */
export type ManagementResource = {
  kind: ManagementResourceKind;
  providerId: ManagementProviderId;
  id: string;
  name: string | null;
  /** The provider's own region identifier, passed through unchanged (never rewritten). */
  region: string | null;
  status: ManagementStatus;
  providerStatus: string | null;
  /** ISO 8601 timestamps when the provider reports them. */
  createdAt: string | null;
  updatedAt: string | null;
  /**
   * Identity scope, populated by adapters whenever the kind is scoped: `projectId` for `branch`,
   * `projectId` + `branchId` for `database`. These fields (not the raw payload) are what make
   * the resource addressable — `wait()`, polling, and any follow-up get/update/delete round trip
   * reconstruct a `ResourceRef` from them, so adapters must always fill them in.
   */
  projectId?: string;
  branchId?: string;
  /** Extra provider-defined scope dimensions for kinds beyond the known ones. */
  scope?: ManagementScope;
  /** Provider payload with secret-bearing keys redacted (see `redactRecord` in `http.ts`). */
  raw: Record<string, unknown>;
};

/**
 * A resource reference: kind + id + the scope the provider's API actually requires.
 * `project` takes no scope; `branch` requires `projectId`; `database` requires `projectId`
 * and `branchId`. For Neon databases the `id` is the database name (the API addresses
 * databases by name). Provider-defined kinds carry extra dimensions in `scope`.
 */
export type ResourceRef = {
  kind: ManagementResourceKind;
  id: string;
  projectId?: string;
  branchId?: string;
  scope?: ManagementScope;
};

/** A credential value returned by a provider at creation time. Handle with care; never log. */
export type ManagementSecret = {
  /** Standard labels: `'password'`, `'connectionString'`, `'apiKey'`; adapters may add others. */
  label: string;
  value: string;
};

// ---------------------------------------------------------------------------
// Amendment A4 — discovery, connections, credentials, actions (2026-10-06)
// ---------------------------------------------------------------------------

/** One organization from the provider's account, as returned by `client.organizations()`. */
export type ManagementOrganization = {
  providerId: ManagementProviderId;
  /**
   * The provider's canonical organization identifier — the value to pass as
   * `organizationId` on project creation (Neon: org id; Supabase: slug, which the current
   * create-project API requires). Never empty.
   */
  id: string;
  name: string | null;
  /**
   * A secondary provider identifier when one exists (e.g. Supabase's deprecated numeric
   * `id`, Neon's URL-safe `handle`). `null` when the provider has only one identifier.
   */
  aliasId: string | null;
  /** Provider payload (no secrets exist on these endpoints). */
  raw: Record<string, unknown>;
};

/** One region available for new resources, as returned by `client.regions()`. */
export type ManagementRegion = {
  providerId: ManagementProviderId;
  /** The provider's own region identifier, e.g. Neon `aws-us-east-1`, Supabase `us-east-1`. */
  id: string;
  /** Human-readable name when the provider provides one. */
  name: string | null;
  /** Cloud platform when the provider reports one (e.g. Supabase `AWS`, Neon platform ids). */
  platform: string | null;
  /** Whether the provider selects this region by default. `null` when not reported. */
  default: boolean | null;
  /** Provider payload. */
  raw: Record<string, unknown>;
};

/** Input for `client.connection()`. Provider requirements differ and are enforced per adapter. */
export type ManagementConnectionInput = {
  /** Neon: required by the official connection_uri endpoint. */
  databaseName?: string;
  /** Neon: required by the official connection_uri endpoint. */
  roleName?: string;
  /** `true` requests the pooled (PgBouncer / Supavisor) connection variant. */
  pooled?: boolean;
  /**
   * Explicit secret opt-in. `false`/omitted: any provider-issued URI is returned redacted and
   * `secrets` is empty. `true`: credential values the provider API actually returned at request
   * time are additionally surfaced in `secrets` — treat them like passwords; never log them.
   */
  reveal?: boolean;
};

/**
 * Provider-selected connection details for an existing resource, as returned by
 * `client.connection()`. Every field is the provider's own value or `null` when the provider's
 * API does not expose it — the SDK never fabricates hosts, roles, database names, or URIs, and
 * never derives a database credential from the management API key/token.
 */
export type ManagementConnectionInfo = {
  providerId: ManagementProviderId;
  /** The kind of resource the details point at (`project` or `branch` today). */
  kind: ManagementResourceKind;
  id: string;
  projectId: string | null;
  branchId: string | null;
  /** Real host from the provider API (never invented). `null` only when the provider's response does not expose one. */
  host: string | null;
  port: number | null;
  /** Database name when the provider API selected one. */
  database: string | null;
  /** Role/user when the provider API selected one. */
  role: string | null;
  /** Whether this is the pooled connection variant, when the provider reports it. */
  pooled: boolean | null;
  /**
   * Provider-issued connection URI with its password segment REDACTED. `null` when the
   * provider offers no URI endpoint for this resource.
   */
  redactedUri: string | null;
  /**
   * Credential values only when the provider API actually returned them at request time AND
   * the caller passed `reveal: true` on the connection call (e.g. Neon's connection URI
   * password, Supabase branch `db_pass`). Empty otherwise.
   */
  secrets: readonly ManagementSecret[];
  /** Provider payload with secret-bearing keys redacted. */
  raw: Record<string, unknown>;
};

/**
 * Options for `client.action()`: an optional provider-defined input body plus the usual
 * transport controls. Input values are validated by the adapter against its official API.
 */
export type ManagementActionOptions = {
  /** Provider-defined request body for actions that take one (e.g. Neon branch restore). */
  input?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
};

/**
 * Options for `client.resetCredential()`. When `password` is omitted on providers that require
 * one, the adapter generates a cryptographically random password and returns it ONLY in the
 * result's `secrets` (the provider never echoes it back). A caller-supplied password is sent
 * but never echoed.
 */
export type ResetCredentialOptions = {
  password?: string;
  signal?: AbortSignal;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
};

/** Options for creating a project. Required provider-side fields are enforced by the adapter. */
export type CreateProjectSpec = {
  kind: 'project';
  name: string;
  /** Provider region identifier (e.g. Supabase `us-east-1`, Neon `aws-us-east-1`). */
  region?: string;
  /** Organization/owner scope where the provider requires or supports it (Supabase: required). */
  organizationId?: string;
  /** Billing plan where the provider requires it (Supabase: required, e.g. `'free'`). */
  plan?: string;
  /**
   * Database password for the new project. When omitted on providers that require one, the
   * adapter generates a cryptographically random password and returns it in `secrets`
   * (the provider API does not echo it back). A caller-supplied password is never echoed.
   */
  password?: string;
  /** Provider-specific options; validated by the adapter against the official API. */
  providerOptions?: Record<string, unknown>;
};

export type CreateBranchSpec = {
  kind: 'branch';
  projectId: string;
  name?: string;
  /** Source branch for copy-on-write creation; omitted means the default/parent branch. */
  sourceBranchId?: string;
  providerOptions?: Record<string, unknown>;
};

export type CreateDatabaseSpec = {
  kind: 'database';
  projectId: string;
  /** Neon: databases live on a branch — this scope is mandatory and checked before dispatch. */
  branchId: string;
  name: string;
  owner?: string;
  providerOptions?: Record<string, unknown>;
};

export type CreateCustomSpec = {
  kind: Exclude<ManagementResourceKind, KnownManagementResourceKind>;
  /** Required for kinds the provider scopes; field names are provider-defined. */
  scope?: ManagementScope;
  /**
   * All other fields are provider-defined and validated by the adapter against its official API.
   * Common optional fields (name, region, organizationId, plan, password) may be reused where
   * the provider genuinely has those concepts.
   */
  providerOptions?: Record<string, unknown>;
  [field: string]: unknown;
};

export type CreateResourceSpec =
  | CreateProjectSpec
  | CreateBranchSpec
  | CreateDatabaseSpec
  | CreateCustomSpec;

/**
 * A partial update. Adapters validate which fields their provider actually supports and reject
 * the rest (no silent ignoring); unknown or provider-specific fields go through `patch.providerOptions`.
 */
export type UpdateResourceSpec = {
  kind: ManagementResourceKind;
  id: string;
  projectId?: string;
  branchId?: string;
  scope?: ManagementScope;
  patch: {
    name?: string;
    /** Database owner (Neon). */
    owner?: string;
    providerOptions?: Record<string, unknown>;
  };
};

/** A normalized asynchronous provider operation (e.g. Neon project/branch/database mutations). */
export type ManagementOperation = {
  id: string;
  providerId: ManagementProviderId;
  action: 'create' | 'update' | 'delete' | 'other';
  /**
   * The resource this operation acts on, when derivable. `wait()` uses it to fetch the final
   * resource once the operation completes; providers without an operations API leave it null.
   */
  ref: ResourceRef | null;
  status: 'running' | 'completed' | 'failed' | 'unknown';
  /** The provider's own status string (e.g. Neon `finished` / `failed` / `cancelled`). */
  providerStatus: string | null;
  createdAt: string | null;
  finishedAt: string | null;
  /** Provider-provided failure detail, sanitized (no secrets). */
  error: string | null;
  raw: Record<string, unknown>;
};

/** Result of a create/update. `secrets` is the ONLY place credentials ever appear. */
export type ManagementWriteResult = {
  /** The created/updated resource, when the provider echoes one. */
  resource: ManagementResource | null;
  /** The provider operation tracking async work, when the provider reports one. */
  operation: ManagementOperation | null;
  secrets: readonly ManagementSecret[];
  /**
   * True when the mutation may or may not have taken effect (transport failure or 5xx after the
   * request was sent). The SDK never retries; callers reconcile.
   */
  indeterminate: boolean;
};

export type ManagementDeleteResult = {
  operation: ManagementOperation | null;
  indeterminate: boolean;
};

/**
 * List query. Scope fields (Amendment A3) are validated before dispatch with the same rules as
 * refs: `project` takes no scope; `branch` requires `projectId`; `database` requires `projectId`
 * and `branchId`; provider-defined kinds read `scope` exclusively (per their
 * `capabilities.resourceScopes` declaration). `cursor`/`limit` are only passed to the provider
 * when the adapter declares `pagination`; otherwise supplying them is refused with `CAPABILITY`
 * (never silently ignored).
 */
export type ManagementListQuery = {
  cursor?: string;
  limit?: number;
  /** Required for scoped list endpoints (e.g. Neon branch and database lists). */
  projectId?: string;
  branchId?: string;
  /** Extra provider-defined scope dimensions for kinds beyond the known ones. */
  scope?: ManagementScope;
};

/** One page of results. `cursor: null` always means "no further pages / provider has no pagination". */
export type ManagementPage = {
  kind: ManagementResourceKind;
  resources: ManagementResource[];
  /** Opaque provider cursor; pass back verbatim for the next page. */
  cursor: string | null;
};

/** Per-call transport options forwarded to the adapter. */
export type ManagementCallOptions = {
  signal?: AbortSignal;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
};

/**
 * Options for `wait()`. `timeoutMs` is the overall budget (default 300000, not a per-request
 * timeout); `pollIntervalMs` is the delay between polls (default 2000). When a poll is
 * rate-limited, the provider's `retryAfterMs` is honored (capped by the remaining budget).
 */
export type WaitOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Called with each polled resource (resource-polling mode) or operation (operation mode). */
  onStatus?: (update: ManagementResource | ManagementOperation) => void;
};

/** What `wait()` accepts: a write result, a bare operation, or a resource reference. */
export type WaitTarget = ManagementWriteResult | ManagementOperation | ResourceRef;

/**
 * Declared capabilities of a management adapter. The core client enforces this table before
 * dispatch: an unsupported kind, verb, or pagination argument fails without any network request.
 *
 * Operation availability is declared **per resource kind** (not as a broad boolean) so a
 * provider that can delete projects but not databases says exactly that, and capability
 * tables/docs can be generated from the same declaration.
 */
export type ManagementAdapterCapabilities = {
  /** Subset of the normalized kinds this adapter can actually manage. */
  resourceKinds: readonly ManagementResourceKind[];
  /** Which kinds support update()/delete(). A kind absent from the list is unsupported. */
  supported: {
    update: readonly ManagementResourceKind[];
    delete: readonly ManagementResourceKind[];
    /**
     * Kinds for which `client.connection()` can retrieve provider-selected connection details
     * (A4). Optional; a kind absent from the list is refused with `CAPABILITY` before dispatch.
     */
    connection?: readonly ManagementResourceKind[];
    /**
     * Kinds for which `client.resetCredential()` can rotate a password/credential (A4).
     * Optional; a kind absent from the list is refused with `CAPABILITY` before dispatch.
     */
    resetCredential?: readonly ManagementResourceKind[];
    /**
     * Lifecycle actions (A4) as action name -> kinds that support it, e.g.
     * `{ pause: ['project'], restart: ['project'], start: ['endpoint'] }`. Optional; an action
     * not declared for the ref's kind is refused with `CAPABILITY` before dispatch. Action
     * names are lowercase verbs (`pause`, `resume`, `restart`, `start`, `suspend`, `stop`,
     * `reset`, `restore`, `recover`, ...); the mapping is the honest per-provider table.
     */
    actions?: Readonly<Record<string, readonly ManagementResourceKind[]>>;
  };
  /** True when `list()` honors `cursor`/`limit` server-side (Neon: true, Supabase: false). */
  pagination: boolean;
  /** True when the provider has an operations API and the adapter implements `getOperation`. */
  asyncOperations: boolean;
  /**
   * Kinds whose normalized `status` actually reflects provider lifecycle and can be polled by
   * `wait()` to `active`/`failed` from a bare {@link ResourceRef}. Adapters whose kinds have no
   * status field (e.g. Neon projects and databases, whose readiness is operation-based) list
   * only the kinds that do; `wait()` on a bare reference of a kind outside this list is refused
   * with `CAPABILITY` instead of hanging until the timeout budget expires. When omitted, the
   * core assumes every declared kind is status-pollable (the behavior of adapters that expose a
   * status field for all their kinds).
   */
  statusPolling?: readonly ManagementResourceKind[];
  /**
   * Scope requirements for provider-defined kinds (kind -> required scope field names), checked
   * before dispatch exactly like the built-in `branch`/`database` scope rules. Known kinds have
   * fixed rules and need no entry here.
   */
  resourceScopes?: Readonly<Record<string, readonly string[]>>;
  /** Evidence level per capability key, mirroring the SQL contract's honesty model. */
  evidence: Readonly<Record<string, EvidenceLevel>>;
  /**
   * Documented prerequisites per operation, keyed like `'create:project'` (e.g. Supabase:
   * `['organizationId', 'region', 'plan']`). Used in error messages; enforcement is the
   * adapter's job.
   */
  prerequisites: Readonly<Record<string, readonly string[]>>;
};

/** The contract every management adapter implements. */
export type ManagementAdapter<Raw = unknown> = {
  /** Must equal `providerId`. */
  readonly id: ManagementProviderId;
  readonly providerId: ManagementProviderId;
  readonly capabilities: ManagementAdapterCapabilities;
  create(spec: CreateResourceSpec, options?: ManagementCallOptions): Promise<ManagementWriteResult>;
  list(
    kind: ManagementResourceKind,
    query: ManagementListQuery,
    options?: ManagementCallOptions,
  ): Promise<ManagementPage>;
  get(ref: ResourceRef, options?: ManagementCallOptions): Promise<ManagementResource>;
  update?(spec: UpdateResourceSpec, options?: ManagementCallOptions): Promise<ManagementWriteResult>;
  delete?(ref: ResourceRef, options?: ManagementCallOptions): Promise<ManagementDeleteResult>;
  /** Required iff `capabilities.asyncOperations`. Polls one operation by its full object. */
  getOperation?(
    operation: ManagementOperation,
    options?: ManagementCallOptions,
  ): Promise<ManagementOperation>;
  /**
   * Optional (A4): list the caller's organizations for discovery (e.g. the prerequisite scope
   * of project creation). The core client refuses with `CAPABILITY` when not implemented.
   */
  organizations?(callOptions?: ManagementCallOptions): Promise<readonly ManagementOrganization[]>;
  /**
   * Optional (A4): list regions available for new resources. `input.organizationId` is required
   * by adapters whose region endpoint is organization-scoped (Supabase) and ignored otherwise.
   */
  regions?(
    input: { organizationId?: string },
    callOptions?: ManagementCallOptions,
  ): Promise<readonly ManagementRegion[]>;
  /**
   * Optional (A4): retrieve provider-selected connection details for an existing resource.
   * Declared per kind in `capabilities.supported.connection`.
   */
  connection?(
    ref: ResourceRef,
    input: ManagementConnectionInput,
    callOptions?: ManagementCallOptions,
  ): Promise<ManagementConnectionInfo>;
  /**
   * Optional (A4): perform a declared lifecycle action (pause/restart/start/restore/...).
   * Declared per action and kind in `capabilities.supported.actions`.
   */
  action?(
    ref: ResourceRef,
    action: string,
    options?: ManagementActionOptions,
  ): Promise<ManagementWriteResult>;
  /**
   * Optional (A4): rotate the password credential of a declared resource kind (Neon role
   * reset_password; Supabase project database password). Declared per kind in
   * `capabilities.supported.resetCredential`.
   */
  resetCredential?(
    ref: ResourceRef,
    options?: ResetCredentialOptions,
  ): Promise<ManagementWriteResult>;
  /** Typed escape hatch (e.g. prebuilt API clients). Never contains secrets. */
  readonly raw: Raw;
};

/** The management client returned by `createManagement`. */
export type ManagementClient<Raw = unknown> = {
  readonly providerId: ManagementProviderId;
  readonly adapterId: ManagementProviderId;
  readonly capabilities: ManagementAdapterCapabilities;
  create(spec: CreateResourceSpec, options?: ManagementCallOptions): Promise<ManagementWriteResult>;
  list(
    kind: ManagementResourceKind,
    query?: ManagementListQuery,
    options?: ManagementCallOptions,
  ): Promise<ManagementPage>;
  get(ref: ResourceRef, options?: ManagementCallOptions): Promise<ManagementResource>;
  update(spec: UpdateResourceSpec, options?: ManagementCallOptions): Promise<ManagementWriteResult>;
  delete(ref: ResourceRef, options?: ManagementCallOptions): Promise<ManagementDeleteResult>;
  /**
   * Bounded, cancellable wait for a create/update to reach a terminal state. Issues GETs only —
   * it never resubmits a mutation. Polls `getOperation` when the provider has an operations API,
   * otherwise polls `get(ref)` for `active`/`failed`.
   */
  wait(target: WaitTarget, options?: WaitOptions): Promise<ManagementResource>;
  /**
   * (A4) List the caller's organizations for discovery — e.g. the prerequisite scope of
   * project creation. Refused with `CAPABILITY` when the adapter does not implement it.
   */
  organizations(callOptions?: ManagementCallOptions): Promise<readonly ManagementOrganization[]>;
  /**
   * (A4) List regions available for new resources. `input.organizationId` is required by
   * adapters whose official region endpoint is organization-scoped (Supabase) and ignored by
   * the others. Refused with `CAPABILITY` when the adapter does not implement it.
   */
  regions(
    input?: { organizationId?: string },
    callOptions?: ManagementCallOptions,
  ): Promise<readonly ManagementRegion[]>;
  /**
   * (A4) Provider-selected connection details for an existing resource: real host/port/
   * database/role and, when the provider offers a URI endpoint, a password-REDACTED uri.
   * Credential values surface only in `secrets` and only after the explicit `reveal: true`
   * opt-in. The management credential is never used as a database credential and no field is
   * ever fabricated. Declared per kind in `capabilities.supported.connection`.
   */
  connection(
    ref: ResourceRef,
    input?: ManagementConnectionInput,
    callOptions?: ManagementCallOptions,
  ): Promise<ManagementConnectionInfo>;
  /**
   * (A4) Perform a declared lifecycle action (pause, restart, start, suspend, reset,
   * restore, ...) on a resource. GET-only rules do not apply — this is an explicit mutation —
   * and it is never retried. Declared per action and kind in `capabilities.supported.actions`;
   * unknown actions or kinds are refused with `CAPABILITY` before dispatch.
   */
  action(
    ref: ResourceRef,
    action: string,
    options?: ManagementActionOptions,
  ): Promise<ManagementWriteResult>;
  /**
   * (A4) Rotate the password credential of a declared resource kind. When `password` is
   * omitted on providers that require one, the adapter generates a strong password and returns
   * it ONLY in `secrets`. Declared per kind in `capabilities.supported.resetCredential`.
   */
  resetCredential(
    ref: ResourceRef,
    options?: ResetCredentialOptions,
  ): Promise<ManagementWriteResult>;
  readonly raw: Raw;
};

/** Injectable fetch (for offline tests, examples, and custom transports). */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
