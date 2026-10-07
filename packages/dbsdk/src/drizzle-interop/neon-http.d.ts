/**
 * `dbsdk/drizzle/neon-http` — the driver-typed declaration of the Neon HTTP
 * bridge.
 *
 * This is a **type entry** over the same runtime module as `dbsdk/drizzle`
 * (both subpaths execute `dist/drizzle-interop/index.js`; nothing is duplicated
 * and no behavior differs). It exists because the shared `dbsdk/drizzle`
 * entry must typecheck without the `@neondatabase/serverless` peer — for
 * PostgreSQL-only consumers — and therefore describes `drizzleNeonHttp`
 * through dbSDK-owned structural contracts. TypeScript resolves every type in
 * a declaration file eagerly, so the driver-typed signature can only live in
 * a declaration that is not part of the shared entry's graph. Import here
 * **only** when you actually name the driver's types; that is the documented
 * "Neon-specific types/API" boundary.
 *
 * - Same function, same behavior: `drizzleNeonHttp` here is the identical
 *   runtime export of `dbsdk/drizzle`. `drizzlePostgres` is not re-declared
 *   here — import it from `dbsdk/drizzle` (unchanged there).
 * - Exact typing: `db` is `Database<NeonRaw>` (the real adapter type) and the
 *   result carries the driver's own `NeonHttpDatabase` / `NeonQueryFunction`
 *   types — identical to the pre-contract signature of `dbsdk/drizzle`.
 * - Requires the `@neondatabase/serverless` peer, like `dbsdk/neon` itself.
 */

import type { NeonQueryFunction } from '@neondatabase/serverless';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import type { DrizzleConfig } from 'drizzle-orm';
import type { NeonRaw } from '../adapters/neon.js';

/**
 * Same subset as `DrizzleInteropConfig` in `dbsdk/drizzle` (schema for
 * relational queries, logger, casing; no `connection`/`client`/DSN). Kept in
 * sync by tests/types/drizzle-neon-contract.test-d.ts — this inlined copy exists
 * so this declaration does not pull the shared entry's type graph (and with it
 * the whole package's dts chunking) into every Neon consumer.
 */
export type DrizzleInteropConfig<TSchema extends Record<string, unknown> = Record<string, never>> = Pick<
  DrizzleConfig<TSchema>,
  'schema' | 'logger' | 'casing'
>;

/**
 * Hand the dbSDK-owned Neon HTTP query function to Drizzle's stable neon-http
 * driver — driver-typed signature. See `dbsdk/drizzle`'s `drizzleNeonHttp`
 * documentation for behavior, gates, and honest limits; this declaration only
 * strengthens the types.
 */
export declare function drizzleNeonHttp<TSchema extends Record<string, unknown> = Record<string, never>>(
  db: import('../types.js').Database<NeonRaw>,
  config?: DrizzleInteropConfig<TSchema>,
): Promise<NeonHttpDatabase<TSchema> & { $client: NeonQueryFunction<false, true> }>;
