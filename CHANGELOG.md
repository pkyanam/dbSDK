# Changelog

All notable changes to dbSDK are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
does not yet publish to npm; versions below describe the source tree.

## [Unreleased]

### Changed

- Documentation set launched: getting started, capabilities, queries,
  transactions, errors, per-adapter guides (Postgres, Supabase, Neon),
  testing, frameworks, provider switching, installation, and FAQ, with a
  machine-readable index for tooling.
- Runnable examples added under `examples/`, consuming the locally built
  package; a coding-agent skill added under `skills/`.

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
