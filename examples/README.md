# dbSDK examples

Runnable TypeScript programs that use the same parameterized SQL on every
adapter. No connection strings are committed; everything is read from
environment variables. The fixture example needs no database at all.

## Setup

The `dbsdk` package is not on npm, so examples consume the local build:

```bash
# from the repository root
pnpm install
pnpm --filter dbsdk build

# then, in examples/
npm install
```

`package.json` declares `"dbsdk": "file:../packages/dbsdk"` plus the optional
peer drivers (`pg`, `@neondatabase/serverless`), so the install picks up a
real local build rather than a registry package.

The Drizzle interop example needs `drizzle-orm` too, and it is pinned to the
**same physical copy** the workspace package resolves (`"file:../packages/
dbsdk/node_modules/drizzle-orm"`). That seam is deliberate: the bridge's
packed types and the example's `pgTable` types must come from ONE
drizzle-orm instance, or TypeScript treats them as incompatible duplicates.
It only resolves after the root `pnpm install` + `pnpm --filter dbsdk build`
have run — follow the order above exactly.

## Choose an adapter

| Environment | Meaning |
| --- | --- |
| (unset) | fixture adapter, no database needed |
| `DBSDK_ADAPTER=postgres` + `DBSDK_URL` | any PostgreSQL endpoint |
| `DBSDK_ADAPTER=supabase` + `DBSDK_URL`, `DBSDK_MODE=direct\|session\|transaction` | Supabase Postgres connection |
| `DBSDK_ADAPTER=neon_http` + `DBSDK_URL` | Neon over HTTP |
| `DBSDK_ADAPTER=neon_ws` + `DBSDK_URL` | Neon over WebSocket |

Supabase note: remote endpoints verify TLS certificates by default and need
Supabase's root CA supplied via `pool: { ssl: { ca } }` in
`lib/setup.ts`; `DBSDK_INSECURE_TLS=1` opts out explicitly (encrypted but
unverified). Localhost needs neither.

## Management examples

The `06` to `08` programs cover the management (control-plane) layer. All
three run completely offline:

- `npm run management:fixture`: the core contract on the
  `dbsdk/management/testing` fixture (fictional provider; capability and
  scope enforcement, bounded waiting).
- `npm run management:neon`: the real Neon management adapter with an
  injected `fetch` answering recorded official-API shapes; create project,
  wait for all operations, secrets, connection URI retrieval with explicit
  reveal.
- `npm run management:supabase`: the real Supabase management adapter with
  an injected `fetch`; organizations, create, status-based waiting, the
  generated password via `secrets`, the official host, and the current-API
  `plan` refusal.

None of them touches the network or a hosted provider; each file header
states exactly what is proven and what is not.

## Sync example

- `npm run sync`: `09-resumable-transfer.ts`, fully offline — two fixture
  clients play provider A and provider B. Real keyset page fixtures drive
  the SQL source's actual pagination, the target fails batch 2 once with a
  `08006` connection reset, and a durable file checkpoint store carries
  progress between the failed run and the resummed run.
- `npm run sync:local`: the same program against a local PostgreSQL 17
  (the `dbsdk-pg-test` container on port 15432 — start it with the command
  in CONTRIBUTING.md). Two independent clients with two schemas play the
  two providers: initial copy, incremental rerun after a change phase
  (exactly the new and updated rows move), and an idle rerun (0 rows).
  Nothing leaves your machine.

What it proves: initial copy and incremental sync are the same primitive;
a failed run stops with the original error and the last committed cursor;
reruns converge because the target is an upsert (idempotent data, not
exactly-once delivery). The offline mode also runs the real
`uniqueOrder: "verify"` preflight against fixture catalog answers, the
copied payload is value-faithful (timestamps as exact text), and later
reads re-validate the cached schema snapshot (schema drift fails loudly).
What it does not claim: deletes are not propagated, a timestamp watermark
can miss late-committing updates, and there is no bidirectional sync or
cross-provider atomicity.

## Drizzle interop example

- `npm run drizzle`: `10-drizzle-interop.ts`, fully offline
  (`DBSDK_DRIZZLE_OFFLINE=1`) — the bridge's refusals demonstrated without
  any database: transaction-mode pooler, direction mismatches, DSN/
  `connection`/`client` configs, and the actionable missing-peer error.
- `npm run drizzle:local`: the same program against a local PostgreSQL 17
  — real typed schema queries, joins, a relational query, a committed and a
  rolled-back transaction, parameter binding, and close semantics; the
  example drops its own schema afterward.

The example needs the root pnpm install + package build first (see Setup):
it consumes the workspace's single physical drizzle-orm copy.

## Run

```bash
npm run fixture        # 04-fixture-testing.ts, zero credentials
npm run basic          # 01-basic-query.ts
npm run transactions   # 02-batch-and-transaction.ts
npm run errors         # 03-error-handling.ts
npm run server         # 05-express-server.ts (listens on :3000)
npm run typecheck      # tsc --noEmit
```

## What the examples show

- `01-basic-query.ts`: one program, every adapter; the result envelope.
- `02-batch-and-transaction.ts`: atomic batch vs interactive transaction,
  including the before-dispatch CAPABILITY refusal on Neon HTTP.
- `03-error-handling.ts`: `DbError` codes, SQLSTATE passthrough, the
  indeterminate write rule, capability refusals.
- `04-fixture-testing.ts`: unit tests without a database, and their limits.
- `05-express-server.ts`: process-wide client lifetime, request handling
  with constraint and indeterminate branches, clean shutdown.
- `09-resumable-transfer.ts`: provider-to-provider resumable transfer
  through `dbsdk/sync` — keyset source, upsert target, durable file
  checkpoints, honest failure and resume semantics, value-faithful
  payloads.
- `10-drizzle-interop.ts`: Drizzle ORM over a dbSDK-owned connection —
  typed schema queries on the same pool, refused modes, lifetime kept by
  the caller.
