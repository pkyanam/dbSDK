/**
 * Type-level tests for the peer-free Neon HTTP contracts in `dbsdk/drizzle`
 * (checked by vitest's typecheck task over tests/types).
 *
 * Background: TypeScript resolves every type named in a declaration file
 * eagerly, so the shared `dbsdk/drizzle` entry must not name
 * `@neondatabase/serverless` (or anything that transitively does, like
 * drizzle-orm/neon-http's own declarations) — otherwise `tsc
 * --skipLibCheck:false` fails for every PostgreSQL-only consumer that only
 * uses the pg bridge. The entry therefore describes `drizzleNeonHttp` through
 * dbSDK-owned structural contracts. These tests prove the contracts are
 * precise, not weaker:
 *
 * 1. soundness — a driver-typed database/result satisfies the contracts;
 * 2. inference strength — `$client` is still exactly the driver's
 *    `NeonQueryFunction<false, true>` for `dbsdk/neon` databases;
 * 3. result identity — select/insert/update/delete/$count/execute/RQB types
 *    are identical between the contract path and the driver-typed path
 *    (imported from `dbsdk/drizzle/neon-http`);
 * 4. mirror sync — the inlined literal unions and config subset stay equal to
 *    the adapter / driver-typed entry versions;
 * 5. non-vacuous negatives — wrong usage is rejected on both paths (vitest
 *    typecheck fails on unused `@ts-expect-error` directives, so every
 *    directive below is proven live);
 * 6. explicit-schema call form (R4 regression) — `drizzleNeonHttp<MySchema>(db)`
 *    keeps the full official `$client` surface via the native-shaped default
 *    contract, while custom/narrower raw handles fall through to the
 *    permissive contract instead of being claimed as fully native.
 */

import { describe, expectTypeOf, it } from 'vitest';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import { relations } from 'drizzle-orm';
import { integer, pgTable, serial, text } from 'drizzle-orm/pg-core';

import { createDatabase } from '../../src/core/database.js';
import { neon } from '../../src/adapters/neon.js';
import { drizzleNeonHttp } from '../../src/drizzle-interop/index.js';
import { drizzleNeonHttp as drizzleNeonHttpStrong } from '../../src/drizzle-interop/neon-http.js';
import type { DrizzleInteropConfig as DrizzleInteropConfigStrong } from '../../src/drizzle-interop/neon-http.js';
import type {
  NeonHttpNativeClientContract,
  NeonHttpClientContract,
  NeonHttpNativeRawContract,
  NeonHttpQueryResultContract,
  NeonRawContract,
  NeonTransactionTransportContract,
} from '../../src/drizzle-interop/index.js';
import type { Database } from '../../src/types.js';
import type { NeonRaw, NeonTransactionTransport } from '../../src/adapters/neon.js';

const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
  age: integer('age'),
});
const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id),
  title: text('title').notNull(),
});
const usersRelations = relations(users, ({ many }) => ({ posts: many(posts) }));
const postsRelations = relations(posts, ({ one }) => ({ user: one(users, { fields: [posts.userId], references: [users.id] }) }));
const schema = { users, posts, usersRelations, postsRelations };

describe('peer-free Neon contracts: mirror precision', () => {
  it('the real adapter raw handle satisfies the peer-free contract', () => {
    expectTypeOf<NeonRaw>().toExtend<NeonRawContract>();
  });

  it('the transaction-transport literal union stays in sync with the adapter', () => {
    expectTypeOf<NeonTransactionTransport>().toEqualTypeOf<NeonTransactionTransportContract>();
  });

  it('the driver query function satisfies the contract client', () => {
    expectTypeOf<NeonQueryFunction<false, true>>().toExtend<NeonHttpClientContract>();
  });

  it('the official-client mirror is bidirectionally assignable to the peer type', () => {
    // Structural equivalence in BOTH directions — the mirror is not claimed to
    // be alias-identical to `NeonQueryFunction<false, true>` (the shared entry
    // must stay peer-free), but every call, member access and assignment
    // behaves identically.
    expectTypeOf<NeonHttpNativeClientContract>().toExtend<NeonQueryFunction<false, true>>();
    expectTypeOf<NeonQueryFunction<false, true>>().toExtend<NeonHttpNativeClientContract>();
  });

  it('the native-shaped raw default is satisfied by the real adapter and stays contract-compatible', () => {
    expectTypeOf<NeonRaw>().toExtend<NeonHttpNativeRawContract>();
    expectTypeOf<NeonHttpNativeRawContract>().toExtend<NeonRawContract>();
  });
});

describe('peer-free Neon contracts: inference strength', () => {
  it('$client is the driver’s own NeonQueryFunction for a dbsdk/neon database', async () => {
    const db = createDatabase({ adapter: neon({ connectionString: 'postgres://ep-example/test' }) });
    const result = await drizzleNeonHttp(db, { schema });
    expectTypeOf(result.$client).toEqualTypeOf<NeonQueryFunction<false, true>>();
  });

  it('$client falls back to the contract for a contract-typed raw handle', async () => {
    const db = createDatabase({ adapter: neon({ connectionString: 'postgres://ep-example/test' }) });
    const loose = db as unknown as import('../../src/types.js').Database<NeonRawContract>;
    const result = await drizzleNeonHttp(loose);
    expectTypeOf(result.$client).toEqualTypeOf<NeonHttpClientContract>();
  });
});

describe('peer-free Neon contracts: soundness and result identity', () => {
  it('the driver-typed result satisfies the contract', () => {
    const strongDb = null as unknown as NeonHttpDatabase<typeof schema> & { $client: NeonQueryFunction<false, true> };
    expectTypeOf(strongDb).toExtend<Awaited<ReturnType<typeof drizzleNeonHttp<typeof schema>>>>();
  });

  it('select / insert.returning / $count / RQB results are identical on both paths', async () => {
    const db = createDatabase({ adapter: neon({ connectionString: 'postgres://ep-example/test' }) });
    const contractDb = await drizzleNeonHttp(db, { schema });
    const strongDb = await drizzleNeonHttpStrong(db, { schema });

    const cRows = await contractDb.select({ id: users.id, email: users.email }).from(users);
    const sRows = await strongDb.select({ id: users.id, email: users.email }).from(users);
    expectTypeOf(cRows).toEqualTypeOf<typeof sRows>();

    const cIns = await contractDb.insert(users).values({ email: 'a@b.c' }).returning({ id: users.id });
    const sIns = await strongDb.insert(users).values({ email: 'a@b.c' }).returning({ id: users.id });
    expectTypeOf(cIns).toEqualTypeOf<typeof sIns>();

    const cCount = await contractDb.$count(users);
    const sCount = await strongDb.$count(users);
    expectTypeOf(cCount).toEqualTypeOf<typeof sCount>();

    const cRqb = await contractDb.query.users.findMany({ with: { posts: { columns: { title: true } } } });
    const sRqb = await strongDb.query.users.findMany({ with: { posts: { columns: { title: true } } } });
    expectTypeOf(cRqb).toEqualTypeOf<typeof sRqb>();

    const cBuilder = contractDb.select().from(users).limit(3);
    const sBuilder = strongDb.select().from(users).limit(3);
    expectTypeOf(cBuilder).toEqualTypeOf<typeof sBuilder>();
  });

  it('the strong entry accepts exactly the same configuration subset', () => {
    expectTypeOf<DrizzleInteropConfigStrong<{ users: typeof users }>>().toEqualTypeOf<
      import('../../src/drizzle-interop/index.js').DrizzleInteropConfig<{ users: typeof users }>
    >();
  });
});

describe('peer-free Neon contracts: negatives (each directive is live)', () => {
  it('rejects unknown RQB relations and wrong insert values on the contract path', async () => {
    const db = createDatabase({ adapter: neon({ connectionString: 'postgres://ep-example/test' }) });
    const contractDb = await drizzleNeonHttp(db, { schema });
    // @ts-expect-error — unknown relation must be rejected
    await contractDb.query.users.findMany({ with: { ghost: true } });
    // @ts-expect-error — wrong value type must be rejected
    await contractDb.insert(users).values({ email: 123 });
  });

  it('rejects unknown RQB relations on the strong path', async () => {
    const db = createDatabase({ adapter: neon({ connectionString: 'postgres://ep-example/test' }) });
    const strongDb = await drizzleNeonHttpStrong(db, { schema });
    // @ts-expect-error — unknown relation must be rejected
    await strongDb.query.users.findMany({ with: { ghost: true } });
  });
});

describe('explicit-schema call form keeps the official client (R4 regression)', () => {
  it('the three pre-change explicit-schema shapes keep working (R3 regression)', async () => {
    const db = createDatabase({ adapter: neon({ connectionString: 'postgres://ep-example/test' }) });
    const result = await drizzleNeonHttp<Record<string, never>>(db);
    // 1. assignment to the driver type (pre-change legal; regressed in R1)
    const asPeer: NeonQueryFunction<false, true> = result.$client;
    // 2. driver-only member access (pre-change typed; regressed in R1)
    const transaction = result.$client.transaction;
    // 3. typed .query call with the peer's real generics/options
    const rows: Record<string, unknown>[] = await result.$client.query('select 1', [], { fullResults: false });
    void asPeer;
    void transaction;
    void rows;
  });

  it('$client on the explicit-schema path is bidirectionally assignable to the peer type', async () => {
    const db = createDatabase({ adapter: neon({ connectionString: 'postgres://ep-example/test' }) });
    const result = await drizzleNeonHttp<{ users: typeof users }>(db);
    // mirror → peer: the pre-change assignment shape works again
    expectTypeOf(result.$client).toExtend<NeonQueryFunction<false, true>>();
    // peer → mirror: a peer-typed client satisfies the explicit-schema path's type
    expectTypeOf<NeonQueryFunction<false, true>>().toExtend<NeonHttpNativeClientContract>();
  });

  it('official-client members keep their full signatures on the explicit-schema path', async () => {
    const db = createDatabase({ adapter: neon({ connectionString: 'postgres://ep-example/test' }) });
    const result = await drizzleNeonHttp<{ users: typeof users }>(db);

    // .query(): per-call options, both row modes, generic overrides
    const env: { fields: { name: string }[]; command: string; rowCount: number; rows: Record<string, unknown>[]; rowAsArray: false } =
      await result.$client.query('select 1', [], { fullResults: true });
    const arrayRows: unknown[][] = await result.$client.query('select 1', [], { arrayMode: true, fullResults: false });
    void env;
    void arrayRows;

    // inspectable query-promise metadata (same object the driver produced)
    const pending = result.$client`select 1`;
    const meta: { queryData: unknown; opts?: unknown } = pending;
    void meta;
    const awaitedEnv: { fields: unknown[]; command: string; rowCount: number; rows: Record<string, unknown>[]; rowAsArray: false } = await pending;
    void awaitedEnv;

    // .unsafe() and .transaction() keep the peer's signatures (transaction typing
    // mirrors the peer; the driver still refuses HTTP transactions at runtime)
    const marker: { sql: string } = result.$client.unsafe('col');
    void marker;
    const batch = result.$client.transaction([pending], { isolationLevel: 'ReadCommitted' });
    const batchResults: unknown[] = await batch;
    void batchResults;

    // auth token option accepted on per-call options (mirrors HTTPQueryOptions.authToken)
    result.$client.query('select 1', [], { authToken: () => 'token' });
  });

  it('the mirror keeps the peer\'s own strictness (negatives are live)', async () => {
    const db = createDatabase({ adapter: neon({ connectionString: 'postgres://ep-example/test' }) });
    const result = await drizzleNeonHttp<{ users: typeof users }>(db);
    // @ts-expect-error — the peer's own constraint: .query type arguments are booleans only
    await result.$client.query<{ id: number }>('select 1');
    // @ts-expect-error — unknown per-call options are rejected
    result.$client.query('select 1', [], { fullResults: true, notAnOption: 1 });
    // @ts-expect-error — transaction options are typed (isolation level union)
    result.$client.transaction([], { isolationLevel: 'SNAPSHOT' });
    // @ts-expect-error — .unsafe returns the raw-SQL marker, not a string
    const notAString: string = result.$client.unsafe('col');
    void notAString;
  });

  it('explicit schema + a non-native raw falls through to the permissive contract', async () => {
    const db = createDatabase({ adapter: neon({ connectionString: 'postgres://ep-example/test' }) });
    const loose = db as unknown as Database<NeonRawContract>;
    const result = await drizzleNeonHttp<{ users: typeof users }>(loose);
    expectTypeOf(result.$client).toEqualTypeOf<NeonHttpClientContract>();
  });

  it('custom raw handles keep their own sql type in explicit and inferred forms', async () => {
    const db = createDatabase({ adapter: neon({ connectionString: 'postgres://ep-example/test' }) });
    interface MySql {
      (strings: TemplateStringsArray, ...params: any[]): Promise<NeonHttpQueryResultContract<Record<string, unknown>>>;
      query(text: string): Promise<NeonHttpQueryResultContract<Record<string, unknown>>>;
    }
    type MyRaw = { transport: 'http'; transactionTransport: 'none'; sql: MySql };
    const custom = db as unknown as Database<MyRaw>;

    const explicit = await drizzleNeonHttp<{ users: typeof users }, MyRaw>(custom);
    expectTypeOf(explicit.$client).toEqualTypeOf<MySql>();

    const inferred = await drizzleNeonHttp(custom);
    expectTypeOf(inferred.$client).toEqualTypeOf<MySql>();
  });

  it('the native default raw is used only for the first overload (two-arg form unchanged)', async () => {
    const db = createDatabase({ adapter: neon({ connectionString: 'postgres://ep-example/test' }) });
    const result = await drizzleNeonHttp<{ users: typeof users }, NeonRawContract>(db);
    expectTypeOf(result.$client).toEqualTypeOf<NeonHttpClientContract>();
    const native = await drizzleNeonHttp<{ users: typeof users }, NeonHttpNativeRawContract>(db);
    expectTypeOf(native.$client).toEqualTypeOf<NeonHttpNativeClientContract>();
  });
});
