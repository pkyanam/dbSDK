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
- Documentation: new Management, Credentials, and MCP server pages; the
  homepage compatibility table, agent links, and a Sponsors section;
  `.github/FUNDING.yml`.
- Runnable management examples under `examples/` that run offline through
  injectable fetch fixtures and the management fixture.

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
