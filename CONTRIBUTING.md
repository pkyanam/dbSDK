# Contributing

Thanks for your interest in dbSDK. This document covers how to set up the
repository, run the tests, and open changes. The project is MIT-licensed and
source-distributed; there is no npm release process to worry about.

## Setup

```bash
git clone https://github.com/pkyanam/dbSDK.git
cd dbSDK
pnpm install
pnpm --filter dbsdk build
```

Requirements: Node 22.12+ (verified through Node 26) and pnpm 11. The
package lives at `packages/dbsdk`; the documentation site at `apps/web`; the
runnable examples at `examples/`.

## The test suite

The suite is split by what it can honestly verify:

- **Unit and contract tests** (no database, no network): core client
  behavior, SQL building, error normalization, adapter fixtures. These run
  anywhere:

  ```bash
  pnpm --filter dbsdk test
  ```

- **Live local integration tests** (Docker required): real behavior against
  a real local PostgreSQL and the real Neon HTTP protocol through a local
  proxy:

  ```bash
  docker run -d --name dbsdk-pg-test -e POSTGRES_PASSWORD=dbsdk -e POSTGRES_DB=dbsdk -p 15432:5432 postgres:17-alpine
  docker run -d --name dbsdk-neon-proxy \
    -e PG_CONNECTION_STRING='postgres://postgres:dbsdk@host.docker.internal:15432/dbsdk' \
    -p 14444:4444 ghcr.io/timowilhelm/local-neon-http-proxy:main

  DBSDK_TEST_POSTGRES_URL='postgres://postgres:dbsdk@localhost:15432/dbsdk' \
  DBSDK_TEST_NEON_CONNECTION_STRING='postgres://postgres:dbsdk@db.localtest.me:5432/dbsdk' \
  DBSDK_TEST_NEON_HTTP_ENDPOINT='http://localhost:14444/sql' \
  pnpm --filter dbsdk test
  ```

  The current verified state: 182 passed / 0 failed / 0 skipped with the
  live environment up. Note: on the very first `docker run` of the Neon
  proxy, its init SQL can race the database startup; if you see
  `neon_control_plane.endpoints does not exist`, restart the proxy
  container after PostgreSQL is ready.

- **Hosted checks** (Supabase project, real Neon): not part of CI and not
  run by this project so far. If you add one, make it opt-in via
  credentials, name it clearly, and keep the evidence vocabulary honest:
  `docs` (stated by provider documentation), `tests` (this project's
  automated tests), `live` (verified against the real hosted service). A
  test that runs against a local server is `tests`, not `live`.

## Where things live

```
packages/dbsdk/src/         core client, SQL builder, errors, capabilities
packages/dbsdk/src/adapters/ postgres, supabase, neon adapters
packages/dbsdk/tests/       unit, contract, adapter, and live tests
examples/                   runnable example programs
skills/dbsdk/               the coding-agent skill
apps/web/content/docs/      the documentation source
```

## Rules for changes

- **The contract is sacred.** `packages/dbsdk/src/types.ts` defines the
  adapter contract; `QueryResult` is `{ rows, rowCount, command? }`. Do not
  add fields, do not widen types casually, and update
  `coordination/core-contract.md` plus the docs if the contract changes.
- **No silent behavior.** Unsupported operations fail before dispatch. No
  retries, no replay of writes, no failover, no endpoint rewriting. If your
  change makes a failure quieter, it is probably wrong.
- **Errors normalize, causes survive.** Driver errors keep their `cause`
  and SQLSTATE. New classifications belong in `src/errors.ts` with tests.
- **Capabilities stay honest.** If you change what a transport can do,
  update the adapter's capability flags, the evidence map, the capabilities
  doc page, and the matrix in the docs.
- **Secrets never move.** No connection strings in tests, examples, logs,
  or error messages.

## Documentation

Docs live in `apps/web/content/docs/` as MDX. If your change affects the
public API, capabilities, or error behavior, update the relevant pages in
the same pull request. Every capability statement in the docs must match a
capability flag in code.

## Commits and releases

- Keep commits small and descriptive; the repository does not enforce a
  strict convention, but write messages a future reader can follow.
- Versions are managed with Changesets. Add a changeset for user-facing
  changes:

  ```bash
  pnpm changeset
  ```

  Publishing to npm is a maintainer decision and is currently not done; a
  changeset is still required so the CHANGELOG stays accurate.

## Reporting issues

- Bugs and proposals: GitHub Issues with a minimal reproduction.
- Security: follow [SECURITY.md](SECURITY.md); please do not open public
  issues for vulnerabilities.
