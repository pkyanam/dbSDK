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

`package.json` declares `"dbsdk": "file:../packages/dbsdk"` plus the two
optional peer drivers (`pg`, `@neondatabase/serverless`), so the install
picks up a real local build rather than a registry package.

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
