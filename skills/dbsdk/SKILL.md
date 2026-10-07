---
description: Work with dbSDK, the SDK to create, manage, and query databases on providers like Supabase, Neon, and PlanetScale Postgres. Use when writing or reviewing code that imports dbsdk, dbsdk/postgres, dbsdk/supabase, dbsdk/neon, dbsdk/planetscale, dbsdk/drizzle, dbsdk/orm, dbsdk/testing, dbsdk/management, dbsdk/management/supabase, dbsdk/management/neon, dbsdk/management/planetscale, dbsdk/management/testing, or dbsdk/sync - covers the real API on both planes plus Drizzle ORM interop, Drizzle schema authoring, and resumable transfer (createDatabase with db.sql, db.query, db.batch, db.transaction; createManagement with create, list, get, update, delete, wait; drizzlePostgres/drizzleNeonHttp over dbSDK-owned connections; pgTable/columns/relations/eq/sql re-exported by dbsdk/orm; runTransfer with createSqlSource/createSqlTarget), parameterization rules, capability and scope checks, credential distinctions, transaction semantics, and the guardrails that keep queries injection-safe and writes unreplayed.
---

# dbSDK skill

dbSDK is one SDK to create, manage, and query databases on providers like
Supabase, Neon, and PlanetScale Postgres. It has two planes with one design
language: a management (control-plane) layer and a typed PostgreSQL query
client, plus an optional Drizzle ORM interop entry. There is no central
dbSDK backend and no credential proxying.

## Package layout (source-only, not on npm)

- `dbsdk` (root): `createDatabase`, `createManagement`, `sql`, `DbError`,
  `ManagementError`, `isDbError`, `isManagementError`, `capabilityMatrix`,
  `describeCapabilities`, `describeManagementCapabilities`, and the contract
  types of both planes. The root import loads no database driver.
- `dbsdk/postgres`, `dbsdk/supabase`, `dbsdk/neon`, `dbsdk/planetscale`:
  query adapters (optional peer drivers `pg` and `@neondatabase/serverless`).
- `dbsdk/testing`: scripted query fixture.
- `dbsdk/drizzle`: optional Drizzle ORM interop (`drizzlePostgres`,
  `drizzleNeonHttp`); lazy — needs the `drizzle-orm` peer only at factory call.
  `dbsdk/drizzle/neon-http` is a type-only subpath over the same runtime
  module for naming the driver's nominal `NeonHttpDatabase`/`NeonQueryFunction`
  types; it requires the `@neondatabase/serverless` peer.
- `dbsdk/orm`: optional Drizzle schema authoring surface (`pgTable`,
  columns, indexes, `relations`, operators, `sql`) — a single pure re-export
  of stable drizzle-orm root + pg-core; needs the `drizzle-orm` peer at
  import time; PostgreSQL authoring only, no runtime logic.
- `dbsdk/sync`: `runTransfer`, `createSqlSource`, `createSqlTarget`,
  `createMemoryCheckpointStore` - one-way resumable transfer between
  databases.
- `dbsdk/management`: `createManagement`, `describeManagementCapabilities`,
  `ManagementError`, the management contract types.
- `dbsdk/management/supabase`: `supabaseManagement({ accessToken })`.
- `dbsdk/management/neon`: `neonManagement({ apiKey })`.
- `dbsdk/management/planetscale`:
  `planetscaleManagement({ tokenId, tokenSecret, organization })`.
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
- `dbsdk/planetscale` is PlanetScale **Postgres** over the standard `pg`
  wire protocol. `connectionMode` is required and validated against the
  port (`"direct"` 5432, `"pooled"` 6432 PgBouncer; mismatches refused
  unless `allowModeMismatch`). Remote connections default to verified TLS;
  URL SSL directives are canonicalized and stripped (weaker/file-loading
  directives refused), remote plaintext refused, and the only downgrade is
  an explicit `ssl: { rejectUnauthorized: false }`. On `pooled`, the
  transaction-pooler guards refuse session-state statements and
  multi-statement strings before dispatch. Vitess/MySQL and Neki are not
  supported.

## Drizzle interop (`dbsdk/drizzle`, optional)

```ts
import { drizzlePostgres } from "dbsdk/drizzle";
const drizzleDb = await drizzlePostgres(db, { schema }); // async: lazy-imports drizzle-orm
```

- Hands Drizzle's stable drivers (0.45.x line) a **validated dbSDK-owned
  connection**: `drizzlePostgres` for TCP/session databases (`dbsdk/
  postgres`, Supabase direct/session, PlanetScale direct),
  `drizzleNeonHttp` for Neon HTTP. Transaction-mode poolers
  (`sessionState: false`), HTTP/TCP direction mismatches, DSN/`connection`/
  `client` configs, and closed databases are refused BEFORE any pool
  creation or raw access.
- Config is `{ schema, logger, casing }` — generic inference preserved.
  Import schemas/builders from `dbsdk/orm` (single re-export surface of the
  same stable copy) or from `drizzle-orm`/`drizzle-orm/pg-core` directly;
  both resolve to the same objects, so schemas authored either way run
  through the bridge identically.
- Honest boundaries: query/transaction/batch failures through the returned
  instance are normalized `DbError`s with the same `code`/`sqlstate`/
  `retryable`/`indeterminate` semantics as `db.sql`, and the native driver
  error stays on `cause` (Drizzle's `DrizzleQueryError` wrapper is unwrapped,
  so parameter values never leak into messages). Raw exceptions remain on the
  escape hatches (`drizzleDb.$client`, `db.raw`), for Drizzle's
  deliberate-abort signal (`tx.rollback()` rejects with Drizzle's
  `TransactionRollbackError`), and for misuse that throws while *constructing*
  a query object before the Drizzle instance is called (e.g. `.values([])`
  in a batch array) — that raises Drizzle's own error synchronously, outside
  the bridge. `db.close()` ends the pool and the previously
  returned instance then fails (no recreation); Neon HTTP instances keep
  working after close (nothing to release). No full-parity claim: Studio,
  Kit, seed, and migrations are separate upstream tools, not implemented here.

## Schema authoring (`dbsdk/orm`, optional)

```ts
import { pgTable, pgSchema, serial, text, integer, relations, eq } from "dbsdk/orm";

const app = pgSchema("myapp");
export const users = app.table("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
});
export const posts = app.table("posts", {
  id: serial("id").primaryKey(),
  authorId: integer("author_id").notNull().references(() => users.id),
  title: text("title"),
});
export const usersRelations = relations(users, ({ many }) => ({ posts: many(posts) }));
```

- One import for the whole PostgreSQL authoring surface (stable
  `drizzle-orm@^0.45.3` root + pg-core; no 1.0 RC/beta features implied).
  Pure re-export: no renames, no wrappers, no dbSDK runtime logic.
- Requires the `drizzle-orm` optional peer at import time; without it the
  subpath import fails with the native module-resolution error (the `dbsdk`
  root entry is unaffected). The five doubly-exported type names resolve to
  the pg-core specializations; `one`/`many` are callback-injected inside
  `relations()`, not module exports; client-free `QueryBuilder` is
  SELECT-only.
- Execution is separate: hand the schema to `dbsdk/drizzle`
  (`drizzlePostgres`/`drizzleNeonHttp`) over a dbSDK-owned connection.

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
  `delete(ref)`, `wait(target)`, plus `organizations()`, `regions(input?)`,
  `connection(ref, input?)`, `action(ref, name, options?)`, and
  `resetCredential(ref, options?)`. Kinds: `project`, `branch`, `database`
  (open set; provider-defined kinds carry their own scope rules - Neon adds
  `role`, `endpoint`, `snapshot`, PlanetScale adds `role`).
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
  passwords once; `connection(ref, { reveal: true })` and
  `raw.connectionUri({ ..., reveal: true })` retrieve an official URI,
  redacted unless `reveal: true`, and register the revealed secret for
  later error redaction; `raw.revealRolePassword` re-reveals a role
  password. On Supabase, the create-time database password is generated
  when omitted and returned once via `secrets` (rotate with
  `resetCredential`; it cannot be recovered); connection details come from
  `connection(ref, { pooled?, reveal? })`.
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
  refused with `CAPABILITY`. Actions: `pause`, `restart`, and `resume` on
  a project (`resume` is the official `POST /v1/projects/{ref}/restore`
  un-pause; it echoes no resource, so poll `get()`), `reset` and
  `restore` on a branch (`restore` cancels a scheduled branch deletion,
  it is not point-in-time data restore). No recover-deleted-project
  endpoint exists; Supabase backups/PITR is not implemented.
- Neon API (`https://console.neon.tech/api/v2`, API key): project,
  branch, and database CRUD; project/branch writes are asynchronous
  (multiple provider operations; `wait()` resolves only when all
  finished); projects and branches paginate, the branch database list
  does not (cursor/limit refused with `CAPABILITY` there); Neon
  generates role passwords (no caller password on create). Provider
  kinds `role` (branch-scoped credentials, create/list/get/delete +
  `resetCredential`, no update), `endpoint` (compute; `start`/`suspend`/
  `restart` actions), and `snapshot` (create/list/update/delete +
  restore-to-branch; no single GET). `raw.recoverProject` restores a
  deleted project. `regions()` forwards a supplied `organizationId` as
  `org_id` (optional; recommended by Neon). Neon has no project
  pause/resume: scale-to-zero is per-endpoint.
- PlanetScale API (`https://api.planetscale.com/v1`, service token
  `Authorization: <id>:<secret>`, no Bearer): the **database** maps to kind
  `project` (name-slug addressed), branches are scoped to the database
  slug, and Postgres role credentials are the provider-defined `role` kind
  scoped `{ projectId, branchId }` and addressed by uid. ALL CRUD is
  organization-scoped: the factory `organization` is the required owner,
  and a mismatching `spec.organizationId` is refused with zero dispatch.
  Engine gate: every mutating verb first GETs the parent database and
  refuses non-PostgreSQL parents before the mutation (one extra documented
  GET, never cached). `create('project')` requires
  `providerOptions.cluster_size`; no plan field, no create-time password.
  `raw.clusterSizeSkus` sends `engine=postgresql` and returns the official
  array UNFILTERED (including `enabled: false`). Pagination is page-based;
  `limit` above 100 is refused. Role passwords are ONE-TIME secrets
  (create/reset only), redacted from raw and errors; `connection(ref)`
  never fabricates a password. `resetCredential({kind:'role'})` rotates
  server-generated; `raw.renewRole` extends expiration. No operations
  endpoint: `wait()` polls resource status (all three kinds). Refused
  rather than guessed: branch update (PATCH), backups, deploy requests, IP
  restrictions, bouncers, and all lifecycle `action()`s (none declared).

## Sync plane (resumable transfer, `dbsdk/sync`)

```ts
import { createSqlSource, createSqlTarget, runTransfer } from "dbsdk/sync";

const result = await runTransfer(
  createSqlSource({
    db: sourceDb,                       // any dbsdk client, any provider
    table: ["public", "events"],
    orderBy: ["updated_at", "id"],
    identity: "supabase:proj-ref.public.events", // REQUIRED, stable, secret-free
  }),
  createSqlTarget({
    db: targetDb,
    table: ["public", "events"],
    key: ["id"],
    identity: "neon:branch-42.public.events",    // REQUIRED
  }),
  { batchSize: 500, checkpointStore: myStore },
);
if (result.status === "failed") throw result.error;
```

- `identity` is required on both adapters. It names the checkpoint, must
  be stable across runs for the same database pair, and distinct across
  pairs. dbSDK never derives it; different databases with the same table
  name must not share identities. The default checkpoint key is an
  injective encoding of both identities (`dbsdk.sync:v1:["src","dst"]`),
  so identities containing `->` or quotes cannot share a key.
- `orderBy` columns must be a unique, NOT NULL total order. Default
  `uniqueOrder: "verify"` checks this with read-only pg_catalog queries on
  the first read and fails with `SyncError/CONTRACT` before any write.
  `"assume"` is an explicit opt-out that skips only the index check; the
  column-metadata inspection runs in both modes.
- The copied payload is value-faithful: date/time, interval,
  `json`/`jsonb`, array-over-those columns, and numeric-family arrays
  (`numeric[]`/`decimal[]` — the driver parses numeric array elements as
  binary doubles) arrive as their exact `col::text` rendering (microsecond
  timestamps, `[]` as an array, JSON null preserved, `numeric[]` digits
  exact); lossless columns keep native JS values. Convert in `map` when you
  need typed values. A real column named `__dbsdk_cursor_*` is refused
  before any read (wildcard projection); explicit `columns` may omit it
  safely. Every read projects an explicit frozen column list (never
  `SELECT *`) and re-validates the cached schema snapshot against the
  catalog, so schema drift after the first read fails with `CONTRACT`
  before anything is written — recreate the source to pick up the new
  schema.
- Targets are upserts (`INSERT ... ON CONFLICT`); the target table needs a
  real unique index on the key columns. Replay after a crash converges row
  state; it is not exactly-once for side effects. Top-level JavaScript
  array values are encoded by resolved column type (JSON text for
  json/jsonb, native for array columns) and refused loudly before any
  write for anything else.
- The default checkpoint store is in-memory and non-durable. For
  scheduled incremental sync, back `CheckpointStore` (two methods,
  `get`/`set`) with your own storage, and keep at most one writer per
  checkpoint key.
- Failures return `status: "failed"` with the original error and the last
  committed cursor; nothing auto-retries. `status: "completed"` with
  `exhausted: false` is a bounded pause (`maxBatches`), not source
  exhaustion.
- Not provided: delete propagation, CDC, bidirectional sync,
  cross-provider transactions, schema translation. Late-committing or
  backdated rows can be missed by incremental runs; that is the honest
  limit of a timestamp watermark.

## Credential rules (never mix planes)

- Management credentials: Supabase personal access token (`sbp_...`,
  scope `organization_projects_create` to create projects,
  `project_admin_write` to update), Neon API key, and PlanetScale service
  token (`tokenId` + `tokenSecret`). Query credentials: the database
  password inside a `postgresql://` connection string (on PlanetScale,
  a role's ONE-TIME password `pscale_pw_...` — issued once by role
  create/reset, never retrievable again; `connection()` cannot produce it).
- Never pass a PAT, API key, or service token to a query adapter; never
  pass a connection string to the management client. The SDK never
  fabricates a password or connection URL from a management token.
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
