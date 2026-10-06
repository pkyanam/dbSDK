---
name: dbsdk
description: Work with dbSDK, the typed PostgreSQL client for Supabase and Neon. Use when writing or reviewing code that imports dbsdk, dbsdk/postgres, dbsdk/supabase, dbsdk/neon, or dbsdk/testing - covers the real API (createDatabase, db.sql, db.query, db.batch, db.transaction, capabilities, DbError), parameterization rules, transaction semantics, and the guardrails that keep queries injection-safe and writes unreplayed.
license: MIT
metadata:
  version: 0.1.0
  source: https://github.com/pkyanam/dbSDK
---

# dbSDK skill

dbSDK is a server-side TypeScript client for PostgreSQL services (launch
adapters: Supabase and Neon, plus any plain PostgreSQL endpoint). It wraps
the database you already have: it does not provision, translate SQL, retry
writes, or fail over between providers.

## Install facts

- The package is NOT on npm. Do not write `npm install dbsdk`.
- It is consumed from a local build of https://github.com/pkyanam/dbSDK:
  `pnpm install && pnpm --filter dbsdk build` in the repo, then
  `npm install <path-to>/packages/dbsdk` (or the packed tarball) in the app.
- Drivers are optional peers, installed only where used: `pg` for
  postgres/supabase, `@neondatabase/serverless` for neon.

## The API (v0.1, stable)

```ts
import { createDatabase, sql, isDbError, type QueryResult } from "dbsdk";
import { neon } from "dbsdk/neon";        // or dbsdk/postgres, dbsdk/supabase

const db = createDatabase({ adapter: neon({ connectionString: process.env.DATABASE_URL!, transport: "http" }) });

// Tagged template: values become $1..$n bind parameters, never SQL text.
// Annotate the result to type the rows (db.sql<Row>`...` only parses for
// simple single-property types; multi-property generics are a syntax error).
const result: QueryResult<{ id: string; email: string }> = await db.sql`
  select id, email from users where id = ${id}
`;
// result.rows, result.rowCount (number | null), result.command?

// Reusable statements: db.query takes a { text, params } OBJECT, not a string.
const stmt = sql`select * from users where email = ${email}`;
await db.query(stmt);

// Atomic batch (default), all-or-nothing:
await db.batch([{ text: "insert into t (x) values ($1)", params: [1] }]);

// Interactive transaction; tx has ONLY query(text, params) - no tx.sql.
await db.transaction(async (tx) => {
  await tx.query("update accounts set balance = balance - $1 where id = $2", [10, 1]);
});

await db.close(); // idempotent; Node 22: explicit close, Node 24+: await using
```

Adapters and their dials:

- `postgres({ connectionString, ssl?, max?, statementTimeout? })` - TCP.
- `supabase({ connectionString, connectionMode: "direct" | "session" | "transaction", ... })` - modes are
  explicit and validated; the transaction pooler rejects session-state
  statements (plain SET, LISTEN, PREPARE, CREATE TEMP) before dispatch.
  Remote Supabase TLS verifies certificates by default and needs Supabase's
  root CA via `pool: { ssl: { ca } }`, or explicit
  `ssl: { rejectUnauthorized: false }` opt-out.
- `neon({ connectionString, transport: "http" | "websocket", transactionTransport?: "postgres" | "websocket" })` -
  HTTP refuses interactive transactions BEFORE dispatch; use `db.batch`
  there, or configure a transaction transport.

## Guardrails (follow these when writing or reviewing code)

1. **Never interpolate user input into SQL text.** Values go through the
   template; identifiers only through `sql.identifier()` (validated,
   double-quoted). If code builds strings with concatenation and passes
   them to `db.query({ text })`, flag it.
2. **Never retry a write automatically.** If `error.indeterminate === true`
   the write MAY have committed. Recommend idempotency (client-generated
   keys, `on conflict`) or a server-side check instead.
3. **Check `db.capabilities` before transport-sensitive code.** Don't branch
   on adapter ids; don't assume `transaction()` exists (false on neon http).
4. **`undefined` parameters are rejected** - use `null`. Same rules on
   `db.sql`, `db.query`, `db.batch`.
5. **Dispose clients.** `await using` on Node 24+; explicit `close()` in a
   `finally` on Node 22. Never hold a transaction across a request boundary.
6. **Session state is dedicated-session-only.** `SET`/temp objects/LISTEN
   persist inside `transaction()` or on a client leased via `raw` - NOT
   between top-level pooled queries.
7. **No browser use.** Connection strings are server-side secrets.

## Result and error shapes

- Results: `{ rows: Row[], rowCount: number | null, command?: string }` -
  nothing else; no timing or field metadata.
- Errors: one `DbError` with `code` (CAPABILITY, CONFIGURATION, CONSTRAINT,
  CONNECTION, TIMEOUT, PERMISSION, SYNTAX, TRANSACTION, DATA, UNKNOWN),
  `sqlstate?`, `retryable`, `indeterminate`, `adapterId?`, `cause` preserved.
- SQLSTATE 42501 (RLS/permission denials) maps to PERMISSION, not SYNTAX.
- Type generics are caller assertions, not runtime verification. bigint and
  numeric come back as strings.

## Testing

`dbsdk/testing` gives a scripted fixture adapter
(`createFixtureDatabase`): zero credentials, recorded queries at
`adapter.raw.queries`, unmatched queries fail loudly. It is not an in-memory
SQL engine and cannot prove transaction or SQL correctness - integration
tests need a real PostgreSQL.
