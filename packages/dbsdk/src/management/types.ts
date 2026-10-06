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
  readonly raw: Raw;
};

/** Injectable fetch (for offline tests, examples, and custom transports). */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
