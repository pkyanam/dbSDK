<div align="center">

<img src="apps/web/public/brand/banner-v2.webp" alt="dbSDK" width="880" />

# dbSDK

**One typed PostgreSQL client for Supabase and Neon.**

Parameterized SQL, one result shape, explicit transports, and errors that
never replay a failed write on their own.

</div>

dbSDK wraps the database you already have. It does not provision databases,
translate SQL between engines, or hide how each transport behaves. You write
PostgreSQL; dbSDK normalizes everything around the query: parameter binding,
the result envelope, errors, transactions, and capability checks.

- **Parameterized by construction.** Interpolated values become positional
  bind parameters. They can never become identifiers or raw SQL fragments.
- **One result shape.** Every adapter returns `{ rows, rowCount, command? }`,
  on TCP, HTTP, and WebSocket transports alike.
- **Honest capabilities.** Each adapter declares what its transport supports.
  Unsupported operations fail before dispatch. Nothing falls back silently.
- **Writes are never replayed.** If a connection drops after a write was
  sent, the error is marked `indeterminate`. You decide what to do.

## Status

Version 0.1, source-only. **There is no npm package yet**, so nothing here
will ask you to `npm install dbsdk`. You install from this repository
(instructions below). The current verification is local: a real Postgres 17
container, the Neon HTTP protocol through a local proxy, and the Supabase
adapter against a local server. No hosted Supabase or Neon project has been
queried by this project, and the docs never claim otherwise.

## Install from source

```bash
git clone https://github.com/pkyanam/dbSDK.git
cd dbSDK
pnpm install
pnpm --filter dbsdk build          # emits packages/dbsdk/dist
```

Then either link the built package into your app:

```bash
# from your app
npm install /absolute/path/to/dbSDK/packages/dbsdk
```

or pack and install the tarball:

```bash
cd packages/dbsdk && npm pack      # produces dbsdk-0.1.0.tgz
npm install ./dbsdk-0.1.0.tgz      # from your app
```

The two database drivers are optional peers, installed only where you use
them: `pg` for the PostgreSQL and Supabase adapters, `@neondatabase/serverless`
for the Neon adapter.

## Quickstart

```ts
import { createDatabase } from "dbsdk";
import { neon } from "dbsdk/neon";

const db = createDatabase({
  adapter: neon({
    connectionString: process.env.DATABASE_URL!,
    transport: "http", // default; "websocket" enables interactive transactions
  }),
});

const { rows, rowCount, command } = await db.sql`
  select id, email from users where id = ${userId}
`;

await db.close(); // Node 24+: or `await using db = ...` for scoped disposal
```

The same statement, on Supabase, is a connection-mode change rather than a
rewrite:

```ts
import { createDatabase } from "dbsdk";
import { supabase } from "dbsdk/supabase";

const db = createDatabase({
  adapter: supabase({
    connectionString: process.env.SUPABASE_DB_URL!,
    connectionMode: "transaction", // direct | session | transaction
    // Remote Supabase endpoints verify TLS certificates by default and need
    // Supabase's root CA: pool: { ssl: { ca: supabaseCaCert } }. Or opt out
    // explicitly with ssl: { rejectUnauthorized: false }.
  }),
});
```

And on any plain PostgreSQL endpoint:

```ts
import { postgres } from "dbsdk/postgres";

const db = createDatabase({
  adapter: postgres({ connectionString: process.env.PGURL! }),
});
```

Dynamic identifiers are explicit and validated; user input never becomes SQL
text:

```ts
import { sql } from "dbsdk";

await db.query(sql`select * from ${sql.identifier(tableName)} limit 10`);
```

## What each transport supports

| Connection mode | Transport | Parameterized query | Interactive transaction | Atomic batch | Session state |
| --- | --- | --- | --- | --- | --- |
| postgres (TCP) | tcp | yes | yes | yes | on a leased session |
| supabase direct | tcp | yes | yes | yes | on a leased session |
| supabase session | tcp | yes | yes | yes | on a leased session |
| supabase transaction | tcp | yes | yes | yes | guarded before dispatch |
| neon http | http | yes | refused before dispatch | yes, one round trip | no |
| neon websocket | websocket | yes | yes | yes | no on pooled hosts |
| neon http + websocket transactions | http + websocket | yes | yes | yes | no on pooled hosts |

"Session state" means `SET`, temp objects, and `LISTEN` persisting on one
dedicated session (inside `transaction()`, which leases a single connection,
or a client leased via `raw`). It does not mean these persist between
separate top-level queries on a pool. Unsupported operations fail before any
network traffic, and no failed write is ever replayed automatically: an
outcome that cannot be known is reported as `indeterminate`. Full table with
evidence levels: [capabilities docs](https://dbsdk.com/docs/capabilities).

## What dbSDK will not do

- No silent failover between providers. Switching adapters moves nothing.
- No automatic retry or replay of writes, ever. `indeterminate` is reported;
  the decision is yours.
- No endpoint guessing. Supabase connection modes are explicit and validated
  against the connection string.
- No SQL translation. The query is yours; the plumbing is ours.
- No browser sessions. This is a server-side client.

## Documentation

- Getting started: https://dbsdk.com/docs/getting-started
- Capabilities: https://dbsdk.com/docs/capabilities
- Also mirrored at https://database-sdk.dev
- Every page is available as Markdown to agents and readers (append `.md`),
  plus `llms.txt`, `llms-full.txt`, and an MCP endpoint on the live site.
- A coding-agent skill lives at [`skills/dbsdk/SKILL.md`](skills/dbsdk/SKILL.md).
- Runnable examples live in [`examples/`](examples/), including one that
  needs no database at all (the fixture adapter).

## Repository layout

```
packages/dbsdk/     the package: core client, SQL builder, errors, adapters, tests
apps/web/           the documentation site (dbsdk.com), with brand assets in apps/web/public/brand
examples/           runnable TypeScript examples
skills/             coding-agent skill
research/           pre-implementation research notes
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports:
[SECURITY.md](SECURITY.md). Changelog: [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE).
