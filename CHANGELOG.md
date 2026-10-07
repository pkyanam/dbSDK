# Changelog

All notable changes to dbSDK are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
does not yet publish to npm; versions below describe the source tree.

## [Unreleased]

### Added

- **Management layer (control plane).** `dbsdk/management` with
  `createManagement`, the full contract type set, `ManagementError` with
  stable codes and the `indeterminate` mutation rule, a shared HTTP helper
  with timeouts, abort handling, and credential redaction, a deterministic
  test fixture (`dbsdk/management/testing`), and the capability metadata
  source `describeManagementCapabilities`. Verbs:
  `create` / `list` / `get` / `update` / `delete` / `wait`, checked against
  declared per-provider capabilities before dispatch.
- **Neon management adapter** (`dbsdk/management/neon`): project, branch,
  and branch-scoped database lifecycle over the official Neon API v2,
  paginated project and branch lists, asynchronous operations with
  aggregated polling, and connection URI retrieval with explicit secret
  opt-in (`reveal: true`).
- **Supabase management adapter** (`dbsdk/management/supabase`): project
  and branch lifecycle over the official Supabase Management API v1.
  Current-API handling verified against the live spec: organization scope
  required (`organizationId` or `providerOptions.organization_slug`),
  `plan` refused with `CONFIGURATION` (plans are organization-level), a
  spec `region` mapped to `region_selection`, generated database passwords
  returned once via `secrets`, and host/branch credential retrieval through
  `raw.databaseHost` / `raw.branchConfig`.
- **PlanetScale Postgres adapters** (`dbsdk/planetscale`,
  `dbsdk/management/planetscale`), independently accepted by review:
  a thin query adapter over the shared PostgreSQL engine with mandatory
  verified TLS on remote hosts (connection-string SSL directives
  canonicalized and stripped so `pg` cannot override the resolved policy;
  explicit `ssl: { rejectUnauthorized: false }` is the only downgrade path),
  validated direct/pooled modes (5432/6432) with the transaction-pooler
  session-state guards on the pooled path, and a management adapter over the
  official PlanetScale API (service-token auth as
  `Authorization: <id>:<secret>`, organization-scoped CRUD with the
  database-as-`project` mapping, a per-mutation engine preflight that
  refuses non-PostgreSQL databases before the mutation, `cluster_size`
  required at create, unfiltered `raw.clusterSizeSkus`, page-based
  pagination refusing limits above the official max of 100, one-time role
  passwords surfaced only via `secrets`, and `resetCredential` /
  `raw.renewRole`). Vitess/MySQL and Neki are refused, not approximated.
  Evidence: official docs plus offline/local-PG tests; no hosted
  PlanetScale endpoint was exercised.
- **Drizzle ORM interop (`dbsdk/drizzle`)**, independently accepted by
  review: optional bridge factories `drizzlePostgres` / `drizzleNeonHttp`
  hand Drizzle's stable drivers a validated, dbSDK-owned connection (typed
  schema queries, joins, relational queries, transactions on the same pool,
  with lifetime, TLS posture, and pooler guards preserved). Refusals fire
  before any pool creation or raw access; the missing-peer error is
  actionable and DSN-free. Failures on the bridge's supported execution
  paths surface as normalized `DbError`s (same `code` / `sqlstate` /
  `retryable` / `indeterminate` semantics as `db.sql` / `db.query` /
  `db.transaction`, native driver error preserved on `cause`, Drizzle's
  params-echoing wrapper unwrapped, no retries or replays); raw boundaries
  stay raw: `$client` / `db.raw`, Drizzle's deliberate abort
  (`tx.rollback()`), and construction-time builder throws. The shared
  entry's declarations never name the Neon peer (explicit-schema calls keep
  the full official `$client` surface through a peer-free structural
  mirror), and the type-only `dbsdk/drizzle/neon-http` subpath serves code
  that names the driver's nominal types. No Studio/Kit/seed/migrations
  claims.
- Documentation: new Management, Credentials, and MCP server pages; the
  homepage compatibility table, agent links, and a Sponsors section;
  `.github/FUNDING.yml`. Added since: the Sync page, the Drizzle interop
  page, and the PlanetScale Postgres adapter page, with the provider
  capability grids extended accordingly.
- Runnable management examples under `examples/` that run offline through
  injectable fetch fixtures and the management fixture.
- **Sync plane (`dbsdk/sync`).** One-way resumable transfer between
  databases through `runTransfer` with `createSqlSource` /
  `createSqlTarget` and `createMemoryCheckpointStore`: keyset-paginated
  reads, chunked `INSERT ... ON CONFLICT` upserts under the 65,535
  parameter protocol limit, caller-owned checkpoints, cancellation, and
  failure results that preserve the original error and the last committed
  cursor. Explicit stable `identity` is required on both adapters;
  `uniqueOrder: "verify"` (default) checks the unique-index and NOT NULL
  preconditions with read-only catalog queries before any write, and
  cursor values use exact PostgreSQL text rendering (microsecond
  timestamps safe). The copied payload is value-faithful by default:
  date/time, interval, `json`/`jsonb`, array-over-those columns, and
  numeric-family arrays (`numeric[]`/`decimal[]`, domains over `numeric`,
  multidimensional arrays — the driver parses numeric *array elements* as
  binary doubles) are delivered as their exact `col::text` rendering
  (microsecond timestamps, JSON arrays and JSON null survive verbatim, every
  `numeric[]` digit survives; lossless columns keep native JS values), and
  the target encodes JavaScript array values by resolved column type,
  refusing ambiguous cases loudly before any write. Reads project an
  explicit, table-qualified column list frozen from the metadata cached on
  the first read (never `SELECT *`) and re-validate that schema snapshot
  against the catalog on every later read, so a column added, removed, or
  retyped after the first read fails with `CONTRACT` before the data query
  (recreate the source to pick up the new schema; the checkpoint stays
  valid). The default checkpoint key is an injective encoding of both
  identities (`dbsdk.sync:v1:[...]`), so delimiter-like identities cannot
  share a key, and real columns colliding with the internal
  `__dbsdk_cursor_*` aliases are refused before any read. Not provided:
  delete propagation, CDC, bidirectional sync, cross-provider transactions,
  schema translation.
- Runnable resumable-transfer example (`examples/09-resumable-transfer.ts`)
  that runs fully offline and, with a local PostgreSQL, end to end through
  two independent clients and schemas.

### Changed

- Project scope and all public copy now describe the full create / manage /
  query story instead of the earlier query-only framing. The frozen
  management contract lives in `coordination/`.
- Site theme tokens flipped to monochrome in `blume.config.ts` (accent,
  action, OG card palette), matching the black-and-white site design.
- Documentation set launched: getting started, capabilities, queries,
  transactions, errors, per-adapter guides (Postgres, Supabase, Neon),
  testing, frameworks, provider switching, installation, and FAQ, with a
  machine-readable index for tooling.
- Runnable examples added under `examples/`, consuming the locally built
  package; a coding-agent skill added under `skills/`.

### Verification

- 355 automated tests pass (0 failed, 3 skipped) with the live environment
  running; 342 pass fully offline and the 16 environment-dependent live
  checks skip without credentials. Management adapter behavior is covered
  by recorded-HTTP style tests; no hosted Supabase or Neon project has
  been created, queried, or deleted by this project.

## [0.1.0] - 2026-10-06

Initial source release.

### Added

- Core client (`createDatabase`): `db.sql` tagged-template queries,
  `db.query` for `{ text, params }` statements, `db.batch` (atomic by
  default), `db.transaction` (interactive, capability-gated), `db.close`
  (idempotent) with async disposal support, `db.capabilities`, and the
  typed `db.raw` escape hatch.
- SQL builder: the `sql` tag with statement composition, `sql.identifier`
  (validated, double-quoted segments), and `sql.join`.
- Normalized results on every adapter and transport:
  `{ rows, rowCount, command? }`.
- Normalized errors: one `DbError` with stable codes, PostgreSQL SQLSTATE
  passthrough, `retryable`, and `indeterminate` marking for writes with
  unknown outcomes. No automatic retries, no replay of writes, no
  failover, anywhere.
- Adapters behind subpath imports with optional peer drivers:
  `dbsdk/postgres` (any PostgreSQL endpoint over TCP), `dbsdk/supabase`
  (explicit connection modes with strict validation and transaction-pooler
  session-state guards), `dbsdk/neon` (HTTP, WebSocket, and TCP
  transaction transports).
- Testing adapter behind `dbsdk/testing`: scripted fixtures, recorded
  queries, zero credentials.
- Capability declarations with per-capability evidence levels.
- Verification: 182 tests passing (0 failed, 0 skipped) including live
  local integration against a real PostgreSQL 17 container and the real
  Neon HTTP protocol through a local proxy. No hosted provider was
  queried and no hosted verification is claimed.

[Unreleased]: https://github.com/pkyanam/dbSDK/commits
[0.1.0]: https://github.com/pkyanam/dbSDK/commits
