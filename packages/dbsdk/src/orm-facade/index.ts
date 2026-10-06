/**
 * `dbsdk/orm` — the SDK-owned, version-locked import surface for Drizzle
 * schema authoring (source module `src/orm-facade`): tables, columns, enums,
 * indexes/constraints, relations, comparison operators, and the `sql`
 * template.
 *
 * STATUS: public optional subpath `dbsdk/orm` (wired: `./orm`
 * export in package.json, `src/orm-facade/index.ts` tsdown entry,
 * packed-consumer verification in `scripts/orm-exports-smoke.mjs`). It is a
 * POSTGRESQL-focused authoring surface only — not a query engine, not a
 * full-parity Drizzle replacement, and it ships no Studio, Kit, seed, or
 * migration tooling. Execution stays with `dbsdk/drizzle`.
 *
 * Why this exists (instead of "just import from drizzle-orm"):
 *
 * 1. **One import for the whole authoring surface.** Drizzle splits schema
 *    authoring across `drizzle-orm` (operators, relations, `sql`, type
 *    helpers) and `drizzle-orm/pg-core` (tables, columns, indexes). This
 *    facade merges both into a single SDK-owned namespace:
 *    `import { pgTable, text, relations, eq, sql } from 'dbsdk/orm'`.
 * 2. **Identity lockstep with `dbsdk/drizzle` (mechanism, not guarantee).**
 *    Everything re-exported here comes from the same `drizzle-orm` copy the
 *    `dbsdk/drizzle` bridge resolves (same optional peer, `^0.45.3`). In a
 *    normal install there is exactly one physical drizzle-orm copy, so
 *    schema objects authored via this facade are the same objects the
 *    bridge expects. This shared-peer resolution is the mechanism that
 *    prevents the dual-copy incompatibility documented in
 *    coordination/drizzle-interop-r2.md §4 (where the examples workspace
 *    needed a `file:` pin to force a single shared copy) — it is NOT an
 *    absolute guarantee: unusual dependency layouts that force a second
 *    physical drizzle-orm install would affect this facade exactly as they
 *    affect importing drizzle-orm directly. Keep a single drizzle-orm
 *    version in your dependency tree.
 * 3. **A controlled upgrade seam.** dbSDK is verified against the stable
 *    `drizzle-orm@^0.45.3` line — NOT the 1.0 RC/beta line (the Drizzle
 *    homepage benchmark itself cites a 1.0.0-beta build; RC-only features
 *    such as RQB v2, the alternation engine, MSSQL/CockroachDB, and the
 *    consolidated validators must not be implied here). When dbSDK later
 *    moves to drizzle 1.0 stable, the change is made once in this file and
 *    every consumer inherits it after re-verification.
 *
 * Faithfulness rules:
 *
 * - Pure re-exports. Nothing is renamed, wrapped, filtered, or shimmed: the
 *   `pgTable` imported here IS the stable `pgTable` (verified by object
 *   identity and behavior tests). Every upstream docs snippet, error
 *   message, and generic inference behavior is preserved. The facade
 *   intentionally does NOT curate a "nicer" subset: partial re-exports
 *   would diverge from upstream documentation and drop symbols users need.
 * - Zero dbSDK runtime logic on this path. No connection, no pool, no
 *   network, no dispatch. This module does not import from `../core`,
 *   `../adapters`, or `../drizzle-interop`.
 * - No upstream source is copied. This is a re-export of the upstream
 *   package resolved by the user's package manager, not vendored code;
 *   see THIRD_PARTY_NOTICES.md for the licensing split.
 * - Execution stays with the SDK: instances that run queries are created by
 *   `dbsdk/drizzle` (`drizzlePost` / `drizzleNeonHttp`) over dbSDK-owned
 *   connections. Client-free SQL construction uses the upstream
 *   `QueryBuilder` re-exported here. This module never creates database
 *   instances itself.
 *
 * Honest boundaries:
 *
 * - PostgreSQL authoring only. This entry re-exports the stable root and
 *   pg-core namespaces; it does not add dialects, execution transports, or
 *   capabilities beyond what stable drizzle-orm 0.45.3 provides. Other
 *   dialect surfaces (mysql-core, sqlite-core, singlestore, gel) are not
 *   part of this entry's scope, and no whole-engine or Studio surface is
 *   re-exported here. New-dialect/transport work is tracked in
 *   coordination/drizzle-successor-feature-ledger-r1.md.
 * - The optional peer `drizzle-orm` (^0.45.3) must be installed. Unlike
 *   `dbsdk/drizzle` — whose factories throw an actionable, DSN-free
 *   `DbError` when the peer is missing — this is a static re-export module:
 *   without the peer, importing it fails with the standard Node module
 *   resolution error (and, for TypeScript users, a module-not-found type
 *   error). That is the correct failure mode for a compile-time surface.
 *   This affects only the `dbsdk/orm` subpath; the `dbsdk` root entry never
 *   imports this module and stays dependency-free.
 * - This module is NOT a query engine or reimplementation: everything on
 *   this path is stable drizzle-orm 0.45.3 behavior reached through pure
 *   re-exports (dialect scope: see the PostgreSQL-authoring bullet above).
 * - Root SDK hygiene: the `dbsdk` root entry never imports this module, so
 *   the root SDK stays dependency-free; `drizzle-orm` remains an OPTIONAL
 *   peer shared by the `./drizzle` and `./orm` entries.
 */

/**
 * Drizzle's stable root surface: comparison/logical operators (`eq`, `and`,
 * `or`, `inArray`, ...), ordering (`asc`, `desc`), aggregation helpers
 * (`count`, `sum`, ...), the `sql` template and helpers, relation
 * definition via `relations(table, ({ one, many }) => ...)` (note: in
 * stable 0.45.x `one`/`many` are callback-injected, not module-level
 * exports), table/view utilities (`aliasedTable`, ...), and the public
 * type helpers (`SQL`, `Table`, `InferSelectModel`, ...).
 */
export * from 'drizzle-orm';

/**
 * Drizzle's stable PostgreSQL authoring surface: `pgTable`, `pgSchema`,
 * every column builder (`text`, `integer`, `uuid`, `jsonb`, `timestamp`,
 * enums, arrays, ...), indexes/constraints/checks/foreign keys, policies,
 * roles, sequences, views, and the client-free `QueryBuilder` for SELECT
 * construction (note: `QueryBuilder` is SELECT-only; INSERT/UPDATE/DELETE
 * builders come from a database instance created via `dbsdk/drizzle`).
 */
export * from 'drizzle-orm/pg-core';

/**
 * Explicit resolution of the type names exported by BOTH the root and the
 * pg-core namespace (ESM `export *` would silently shadow them at runtime,
 * but TypeScript requires an explicit re-export to resolve the ambiguity).
 * The pg-core specializations win: this is a PostgreSQL authoring surface,
 * and e.g. pg-core's `TableConfig` is `TableConfigBase<PgColumn>`.
 */
export {
  type ColumnsWithTable,
  type SelectedFields,
  type SelectedFieldsFlat,
  type SelectedFieldsOrdered,
  type TableConfig,
} from 'drizzle-orm/pg-core';
