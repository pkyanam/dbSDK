---
description: Work with dbSDK, the SDK to create, manage, and query databases on providers like Supabase and Neon. Use when writing or reviewing code that imports dbsdk, dbsdk/postgres, dbsdk/supabase, dbsdk/neon, dbsdk/testing, dbsdk/management, dbsdk/management/supabase, dbsdk/management/neon, or dbsdk/management/testing - covers the real API on both planes (createDatabase with db.sql, db.query, db.batch, db.transaction; createManagement with create, list, get, update, delete, wait), parameterization rules, capability and scope checks, credential distinctions, transaction semantics, and the guardrails that keep queries injection-safe and writes unreplayed.
---

# dbSDK skill

dbSDK is one SDK to create, manage, and query databases on providers like
Supabase and Neon. It has two planes with one design language: a management
(control-plane) layer and a typed PostgreSQL query client. There is no
central dbSDK backend and no credential proxying.

## Package layout (source-only, not on npm)

- `dbsdk` (root): `createDatabase`, `createManagement`, `sql`, `DbError`,
  `ManagementError`, `isDbError`, `isManagementError`, `capabilityMatrix`,
  `describeCapabilities`, `describeManagementCapabilities`, and the contract
  types of both planes.
- `dbsdk/postgres`, `dbsdk/supabase`, `dbsdk/neon`: query adapters
  (optional peer drivers `pg` and `@neondatabase/serverless`).
- `dbsdk/testing`: scripted query fixture.
- `dbsdk/management`: `createManagement`, `describeManagementCapabilities`,
  `ManagementError`, the management contract types.
- `dbsdk/management/supabase`: `supabaseManagement({ accessToken })`.
- `dbsdk/management/neon`: `neonManagement({ apiKey })`.
- `dbsdk/management/testing`: `createManagementFixture`.

## Query plane (typed PostgreSQL client)

```ts
import { createDatabase } from "dbsdk";
import { neon } from "dbsdk/neon";

const db = createDatabase({
  adapter: neon({ connectionString: process.env.DATABASE_URL!, transport: "http" }),
});
const { rows, rowCount, command } = await db.sql`select * from users where id = ${id}`;
await db.close();
```

- Interpolated values always become positional bind parameters. Dynamic
  identifiers must go through `sql.identifier` (validated, quoted). Never
  build SQL text by string concatenation; `db.query({ text })` with
  hand-built strings is outside dbSDK's protections.
- One result envelope everywhere: `{ rows, rowCount, command? }`.
- `db.batch(statements)` is atomic by default; `db.transaction(fn)` is
  capability-gated and leases one connection. On Neon HTTP,
  `transaction()` is refused before dispatch.
- Session state (`SET`, temp objects, `LISTEN`) holds only on a single
  dedicated, leased connection: inside `transaction()` or a client leased
  via `raw`. Never across separate top-level pooled `db.sql`/`db.query`
  calls.
- A write whose outcome cannot be known (transport failure or 5xx after
  the write was sent) is reported with `indeterminate: true`. The SDK
  never retries or replays a write; make writes idempotent or reconcile
  before retrying.

## Management plane (control plane)

```ts
import { createManagement } from "dbsdk/management";
import { neonManagement } from "dbsdk/management/neon";

const management = createManagement({
  adapter: neonManagement({ apiKey: process.env.NEON_API_KEY! }),
});
const result = await management.create({ kind: "project", name: "my-app" });
const project = await management.wait(result, { timeoutMs: 120_000 });
```

- Verbs: `create(spec)`, `list(kind, query?)`, `get(ref)`, `update(spec)`,
  `delete(ref)`, `wait(target)`. Kinds: `project`, `branch`, `database`
  (open set; provider-defined kinds carry their own scope rules).
- Every call is checked against the adapter's declared capabilities
  **before dispatch**: unsupported kind/verb/pagination fails with
  `ManagementError` code `CAPABILITY`; missing scope fields fail with
  `CONFIGURATION`. Scope rules: Neon `branch` requires `projectId`; Neon
  `database` requires `projectId` and `branchId` and is addressed by name.
- `wait()` issues GET requests only and never resubmits a write. Bounded
  by `timeoutMs` (default 300,000) with `pollIntervalMs` (default 2,000)
  and an optional `onStatus` callback. Budget overrun throws `TIMEOUT`;
  caller abort throws `ABORTED`; neither is indeterminate.
- Secrets surface only in `ManagementWriteResult.secrets`
  (`{ label, value }`) and are redacted from every `raw` payload and error
  message. On Neon, create responses carry connection URIs and role
  passwords once; `management.raw.connectionUri({ projectId,
  databaseName, roleName, reveal: true })` retrieves an official URI,
  redacted unless `reveal: true`. On Supabase, the create-time database
  password is generated when omitted and returned once via `secrets`; the
  host comes from `management.raw.databaseHost(projectRef)`, full branch
  credentials from `management.raw.branchConfig(...)` (secrets omitted
  unless `includeSecrets: true`).
- Mutations follow the same indeterminate rule as queries: transport
  failure or 5xx during create/update/delete means the outcome is unknown
  (`indeterminate: true`); the SDK never retries; reconcile with reads.
- `describeManagementCapabilities(adapter)` returns the structured
  per-provider capability descriptor (per-operation kind availability,
  pagination, asyncOperations, prerequisites, evidence). Availability
  means "implemented and declared"; it never certifies credentials, plan
  tier, or a live request.

### Provider specifics (current APIs, verified)

- Supabase Management API (`https://api.supabase.com/v1`, PAT `sbp_...`):
  create-project requires `name` and an organization scope
  (`organizationId`, or `providerOptions: { organization_slug }`;
  `organization_id` is deprecated-but-accepted). A spec `plan` is REFUSED
  with `CONFIGURATION` (plans are chosen at the organization level). A
  spec `region` maps to the official `region_selection` form. No
  operations endpoint: `wait()` polls resource status. No pagination. A
  Supabase project IS the PostgreSQL database: `kind: "database"` is
  refused with `CAPABILITY`.
- Neon API (`https://console.neon.tech/api/v2`, API key): project,
  branch, and database CRUD; project/branch writes are asynchronous
  (multiple provider operations; `wait()` resolves only when all
  finished); projects and branches paginate, the branch database list
  does not (cursor/limit refused with `CAPABILITY` there); Neon
  generates role passwords (no caller password on create).

## Credential rules (never mix planes)

- Management credentials: Supabase personal access token (`sbp_...`,
  scope `organization_projects_create` to create projects,
  `project_admin_write` to update) and Neon API key. Query credentials:
  the database password inside a `postgresql://` connection string.
- Never pass a PAT or API key to a query adapter; never pass a connection
  string to the management client. The SDK never fabricates a password or
  connection URL from a management token.
- Supabase anon/service_role keys belong to the Data API (PostgREST), not
  to this SDK; do not pass them to either plane.
- All credentials are server-side secrets. There is no browser build.

## Testing without providers

- Query fixtures: `dbsdk/testing` (`createFixtureAdapter` /
  `createFixtureDatabase`) - scripted rows/errors, recorded queries.
- Management fixtures: `dbsdk/management/testing`
  (`createManagementFixture`) - handler-based scaffolding that proves what
  the core client does with declared results, errors, and capabilities;
  not a provider simulator.

## Guardrails for generated code

- Import only from the subpaths listed above; never invent adapter
  options, methods, or connection formats.
- Do not wrap management and query credentials into one "key"; keep them
  as separate environment variables.
- Do not retry mutations (either plane); check `indeterminate` and
  reconcile with reads.
- Do not claim hosted verification; evidence levels in the docs
  (`docs` / `tests` / `live`) state exactly what was checked.
