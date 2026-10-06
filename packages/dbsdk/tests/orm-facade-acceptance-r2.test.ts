/**
 * INDEPENDENT R2 acceptance tests for the `dbsdk/orm` facade
 * (source module `src/orm-facade`) — review sub-agent, round 2.
 *
 * Purpose: independently verify the foundation round's claims. This file is
 * owned by the R2 review; it does not modify any source, metadata, or the
 * author's test files. It complements (does not mirror) tests/orm-facade.test.ts:
 *
 * 1. NON-VACUOUS export verification: every key runtime symbol re-exported by
 *    the facade is first proven DEFINED (typeof guard) before its identity is
 *    compared against the directly-imported drizzle-orm — this defeats the
 *    undefined===undefined vacuous-pass failure mode.
 * 2. `one`/`many` callback injection (documented 0.45.x behavior): absent as
 *    module exports, present as injected functions.
 * 3. Dual-construction SQL equivalence: the SAME query built independently
 *    through the facade namespace AND through direct drizzle-orm 0.45.3
 *    imports must produce byte-identical SQL and identical parameter lists
 *    (select/joins/where/order/limit, union, aggregate+group+having,
 *    aliased-table self-join, insert/update/delete…returning).
 * 4. Wrong-input refusal with zero dispatch: `QueryBuilder` is SELECT-only
 *    (no write methods); the frozen `dbsdk/drizzle` bridge refuses a
 *    connection string and a sessionState:false pool before any query.
 * 5. LIVE behavioral leg against the approved local PostgreSQL 17
 *    (dbsdk-pg-test, port 15432, env-gated like the other suites): a UNIQUE
 *    review schema is created via an independent `pg` client, exercised
 *    through the bridge with facade-authored schema (pgSchema-qualified
 *    insert/returning, typed join select, aggregates, self-join, RQB), and
 *    ALWAYS dropped afterwards via the independent client.
 *
 * Everything except leg 5 is fully offline. No hosted services are contacted.
 */

import * as upstream from 'drizzle-orm';
import * as upstreamPg from 'drizzle-orm/pg-core';
import * as relationsMod from 'drizzle-orm/relations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import pg from 'pg';

// The surface under test — imported EXCLUSIVELY through the facade.
import * as facade from '../src/orm-facade/index.js';
import {
  pgTable,
  pgSchema,
  pgEnum,
  text,
  integer,
  serial,
  boolean,
  timestamp,
  jsonb,
  uuid,
  index,
  uniqueIndex,
  foreignKey,
  check,
  primaryKey,
  relations,
  aliasedTable,
  count,
  sum,
  avg,
  QueryBuilder,
  eq,
  and,
  or,
  not,
  desc,
  asc,
  inArray,
  notInArray,
  ilike,
  isNull,
  isNotNull,
  between,
  sql,
} from '../src/orm-facade/index.js';

import { createDatabase } from '../src/core/database.js';
import { postgres } from '../src/adapters/postgres.js';
import { drizzlePostgres } from '../src/drizzle-interop/index.js';
import type { DatabaseAdapter, DatabaseAdapterCapabilities } from '../src/types.js';
import type { PgPoolLike, PgQueryOutput } from '../src/adapters/pg-engine.js';

// ---------------------------------------------------------------------------
// 1. Non-vacuous export verification
// ---------------------------------------------------------------------------

describe('facade exports are genuinely defined and identical to upstream', () => {
  const RUNTIME_SYMBOLS = [
    // pg-core authoring
    'pgTable', 'pgSchema', 'pgEnum', 'text', 'integer', 'serial', 'boolean',
    'timestamp', 'jsonb', 'uuid', 'index', 'uniqueIndex', 'foreignKey',
    'check', 'primaryKey',
    // relations + root utilities
    'relations', 'aliasedTable', 'count', 'sum', 'avg', 'QueryBuilder',
    // operators + sql
    'eq', 'and', 'or', 'not', 'desc', 'asc', 'inArray', 'notInArray',
    'ilike', 'isNull', 'isNotNull', 'between', 'sql',
  ] as const;

  it('every key runtime symbol is defined through the facade (no undefined identity)', () => {
    for (const name of RUNTIME_SYMBOLS) {
      const value = (facade as Record<string, unknown>)[name];
      // Guard FIRST: fail loudly if a symbol is missing (vacuous check defeat).
      expect(value, `${name} must be exported by the facade`).toBeDefined();
      expect(typeof value === 'function' || typeof value === 'object', `${name} type`).toBe(true);
    }
  });

  it('key runtime symbols are the same objects as direct drizzle-orm imports', () => {
    const f = facade as Record<string, unknown>;
    expect(facade.pgTable).toBe(upstreamPg.pgTable);
    expect(facade.pgSchema).toBe(upstreamPg.pgSchema);
    expect(facade.text).toBe(upstreamPg.text);
    expect(facade.integer).toBe(upstreamPg.integer);
    expect(facade.index).toBe(upstreamPg.index);
    expect(facade.foreignKey).toBe(upstreamPg.foreignKey);
    expect(facade.check).toBe(upstreamPg.check);
    expect(facade.primaryKey).toBe(upstreamPg.primaryKey);
    expect(facade.relations).toBe(upstream.relations);
    expect(facade.aliasedTable).toBe(upstream.aliasedTable);
    expect(facade.count).toBe(upstream.count);
    expect(facade.QueryBuilder).toBe(upstreamPg.QueryBuilder);
    expect(facade.eq).toBe(upstream.eq);
    expect(facade.inArray).toBe(upstream.inArray);
    expect(facade.sql).toBe(upstream.sql);
    expect(facade.desc).toBe(upstream.desc);
    expect(facade.asc).toBe(upstream.asc);
  });

  it('one/many are NOT module-level exports in stable 0.45.x; relations() injects them', () => {
    // Documented absence — must not be faked by the facade:
    expect((facade as Record<string, unknown>).one).toBeUndefined();
    expect((facade as Record<string, unknown>).many).toBeUndefined();
    // But the relations() callback DOES receive working one/many helpers when
    // the relational config is extracted (same mechanism RQB setup uses in
    // stable 0.45.x — helpers are lazily injected, not module-level exports):
    const relUsers = pgTable('r2_review_rel_users', { id: serial('id').primaryKey() });
    const relPosts = pgTable('r2_review_rel_posts', {
      id: serial('id').primaryKey(),
      userId: integer('user_id').notNull(),
    });
    const rel = relations(relUsers, ({ many }) => ({
      posts: many(relPosts),
    }));
    const { createTableRelationsHelpers, extractTablesRelationalConfig } = relationsMod;
    const helpers = createTableRelationsHelpers(relUsers);
    expect(typeof helpers.one).toBe('function');
    expect(typeof helpers.many).toBe('function');
    const built = rel.config(helpers);
    expect(Object.keys(built)).toEqual(['posts']);
    // one() with correctly-directed fields (FK on the relPosts side), built
    // through the same helpers:
    const postsRel = relations(relPosts, ({ one }) => ({
      author: one(relUsers, { fields: [relPosts.userId], references: [relUsers.id] }),
    }));
    const builtOne = postsRel.config(createTableRelationsHelpers(relPosts));
    expect(Object.keys(builtOne)).toEqual(['author']);
    // Full extraction path also accepts a facade-authored schema:
    const extracted = extractTablesRelationalConfig(
      { relUsers, relPosts, rel },
      (table) => createTableRelationsHelpers(table as never),
    );
    expect(Object.keys(extracted.tables)).toContain('relUsers');
  });
});

// ---------------------------------------------------------------------------
// 2. Dual-construction SQL equivalence (facade vs direct upstream)
// ---------------------------------------------------------------------------

const r2Users = pgTable('r2_review_users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
  age: integer('age'),
  active: boolean('active').notNull().default(true),
});

const r2Posts = pgTable('r2_review_posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id').notNull(),
  title: text('title'),
});

const r2UpstreamUsers = upstreamPg.pgTable('r2_review_users', {
  id: upstreamPg.serial('id').primaryKey(),
  email: upstreamPg.text('email').notNull(),
  age: upstreamPg.integer('age'),
  active: upstreamPg.boolean('active').notNull().default(true),
});

const r2UpstreamPosts = upstreamPg.pgTable('r2_review_posts', {
  id: upstreamPg.serial('id').primaryKey(),
  authorId: upstreamPg.integer('author_id').notNull(),
  title: upstreamPg.text('title'),
});

describe('dual-construction SQL equivalence (facade === direct drizzle-orm 0.45.3)', () => {
  it('select + inner join + where + order + limit/offset', () => {
    const viaFacade = new QueryBuilder()
      .select({ id: r2Users.id, email: r2Users.email, title: r2Posts.title })
      .from(r2Users)
      .innerJoin(r2Posts, eq(r2Posts.authorId, r2Users.id))
      .where(and(eq(r2Users.active, true), isNotNull(r2Posts.title)))
      .orderBy(desc(r2Users.id), asc(r2Posts.title))
      .limit(10)
      .offset(5);
    const viaUpstream = new upstreamPg.QueryBuilder()
      .select({ id: r2UpstreamUsers.id, email: r2UpstreamUsers.email, title: r2UpstreamPosts.title })
      .from(r2UpstreamUsers)
      .innerJoin(r2UpstreamPosts, upstream.eq(r2UpstreamPosts.authorId, r2UpstreamUsers.id))
      .where(upstream.and(upstream.eq(r2UpstreamUsers.active, true), upstream.isNotNull(r2UpstreamPosts.title)))
      .orderBy(upstream.desc(r2UpstreamUsers.id), upstream.asc(r2UpstreamPosts.title))
      .limit(10)
      .offset(5);
    expect(viaFacade.toSQL()).toEqual(viaUpstream.toSQL());
  });

  it('union', () => {
    const a = new QueryBuilder().select({ id: r2Users.id }).from(r2Users).where(isNull(r2Users.age));
    const b = new QueryBuilder().select({ id: r2Users.id }).from(r2Users).where(notInArray(r2Users.age, [1, 2, 3]));
    const aU = new upstreamPg.QueryBuilder().select({ id: r2UpstreamUsers.id }).from(r2UpstreamUsers).where(upstream.isNull(r2UpstreamUsers.age));
    const bU = new upstreamPg.QueryBuilder().select({ id: r2UpstreamUsers.id }).from(r2UpstreamUsers).where(upstream.notInArray(r2UpstreamUsers.age, [1, 2, 3]));
    expect(a.union(b).toSQL()).toEqual(aU.union(bU).toSQL());
  });

  it('aggregate + group by + having', () => {
    const viaFacade = new QueryBuilder()
      .select({ author: r2Posts.authorId, total: count(r2Posts.id), titles: count(r2Posts.title) })
      .from(r2Posts)
      .groupBy(r2Posts.authorId)
      .having(and(sql`count(*) > 0`, between(r2Posts.authorId, 1, 100)));
    const viaUpstream = new upstreamPg.QueryBuilder()
      .select({ author: r2UpstreamPosts.authorId, total: upstream.count(r2UpstreamPosts.id), titles: upstream.count(r2UpstreamPosts.title) })
      .from(r2UpstreamPosts)
      .groupBy(r2UpstreamPosts.authorId)
      .having(upstream.and(upstream.sql`count(*) > 0`, upstream.between(r2UpstreamPosts.authorId, 1, 100)));
    expect(viaFacade.toSQL()).toEqual(viaUpstream.toSQL());
  });

  it('aliased-table self-join', () => {
    const follower = aliasedTable(r2Users, 'follower');
    const followee = aliasedTable(r2Users, 'followee');
    const viaFacade = new QueryBuilder()
      .select({ f: follower.id, e: followee.id })
      .from(follower)
      .innerJoin(followee, eq(followee.id, follower.id));
    // NOTE (independent finding): `aliasedTable` is a ROOT export only — it is
    // NOT available on `drizzle-orm/pg-core`.
    const uFollower = upstream.aliasedTable(r2UpstreamUsers, 'follower');
    const uFollowee = upstream.aliasedTable(r2UpstreamUsers, 'followee');
    const viaUpstream = new upstreamPg.QueryBuilder()
      .select({ f: uFollower.id, e: uFollowee.id })
      .from(uFollower)
      .innerJoin(uFollowee, upstream.eq(uFollowee.id, uFollower.id));
    expect(viaFacade.toSQL()).toEqual(viaUpstream.toSQL());
  });

  it('insert / update / delete with returning (instance builders; QueryBuilder is SELECT-only)', async () => {
    // CONFIRMED (independent): the pg-core QueryBuilder has NO write methods —
    // write builders require a database instance.
    const qb = new QueryBuilder() as unknown as Record<string, unknown>;
    expect(qb.insert).toBeUndefined();
    expect(qb.update).toBeUndefined();
    expect(qb.delete).toBeUndefined();
    const uQb = new upstreamPg.QueryBuilder() as unknown as Record<string, unknown>;
    expect(uQb.insert).toBeUndefined();

    // Write SQL comparison: facade-built instance (via the frozen bridge over a
    // recording fake pool) vs a direct upstream instance over the SAME fake pool.
    const facadePool = new R2RecordingPool();
    const facadeDb = createDatabase({ adapter: r2Adapter(facadePool, true) });
    const viaFacade = await drizzlePostgres(facadeDb, {});
    const upstreamPool = new R2RecordingPool();
    const { drizzle: upstreamDrizzle } = await import('drizzle-orm/node-postgres');
    const viaUpstream = upstreamDrizzle(upstreamPool as never);

    const ins = viaFacade.insert(r2Users).values({ email: 'a@b.c', age: 30 }).returning({ id: r2Users.id });
    const insU = viaUpstream.insert(r2UpstreamUsers).values({ email: 'a@b.c', age: 30 }).returning({ id: r2UpstreamUsers.id });
    expect(ins.toSQL()).toEqual(insU.toSQL());

    const upd = viaFacade.update(r2Users).set({ age: 31 }).where(eq(r2Users.id, 1)).returning({ id: r2Users.id });
    const updU = viaUpstream.update(r2UpstreamUsers).set({ age: 31 }).where(upstream.eq(r2UpstreamUsers.id, 1)).returning({ id: r2UpstreamUsers.id });
    expect(upd.toSQL()).toEqual(updU.toSQL());

    const del = viaFacade.delete(r2Users).where(and(eq(r2Users.id, 1), isNull(r2Users.age)));
    const delU = viaUpstream.delete(r2UpstreamUsers).where(upstream.and(upstream.eq(r2UpstreamUsers.id, 1), upstream.isNull(r2UpstreamUsers.age)));
    expect(del.toSQL()).toEqual(delU.toSQL());

    // Nothing was dispatched — these were construction-only.
    expect(facadePool.queries).toHaveLength(0);
    expect(upstreamPool.queries).toHaveLength(0);
  });

  it('ilike / or / not / sql operator shape', () => {
    const viaFacade = new QueryBuilder()
      .select({ id: r2Users.id })
      .from(r2Users)
      .where(or(ilike(r2Users.email, '%@example.com'), and(not(r2Users.active), sql`${r2Users.age} > ${18}`)));
    const viaUpstream = new upstreamPg.QueryBuilder()
      .select({ id: r2UpstreamUsers.id })
      .from(r2UpstreamUsers)
      .where(upstream.or(upstream.ilike(r2UpstreamUsers.email, '%@example.com'), upstream.and(upstream.not(r2UpstreamUsers.active), upstream.sql`${r2UpstreamUsers.age} > ${18}`)));
    expect(viaFacade.toSQL()).toEqual(viaUpstream.toSQL());
  });
});

// ---------------------------------------------------------------------------
// 3. Wrong-input refusal with zero dispatch
// ---------------------------------------------------------------------------

class R2RecordingPool implements PgPoolLike {
  readonly queries: { text: string; values?: unknown[] }[] = [];
  async query(config: { text: string; values?: unknown[] }): Promise<PgQueryOutput> {
    this.queries.push({ text: config.text, values: config.values });
    return { rows: [], rowCount: 0, command: 'SELECT' };
  }
  async connect() {
    return { async query() { return { rows: [], rowCount: 0 } satisfies PgQueryOutput; }, release() {} };
  }
  async end() {}
}

function r2Adapter(raw: PgPoolLike, sessionState: boolean): DatabaseAdapter<PgPoolLike> {
  const capabilities: DatabaseAdapterCapabilities = {
    interactiveTransactions: true,
    atomicBatch: true,
    sessionState,
    transport: 'tcp',
    evidence: {},
  };
  return {
    id: 'r2-review-fake-pg',
    engine: 'postgresql',
    capabilities,
    raw: raw as never,
    async query() { return { rows: [], rowCount: 0 }; },
    async close() { await raw.end(); },
  };
}

describe('wrong-input refusal with zero dispatch', () => {
  it('bridge refuses a plain connection string before any dispatch', async () => {
    const pool = new R2RecordingPool();
    const fakeDb = createDatabase({ adapter: r2Adapter(pool, true) });
    await expect(drizzlePostgres(fakeDb, 'postgresql://user:pass@localhost:5432/app' as never)).rejects.toThrow(/connection string/i);
    expect(pool.queries).toHaveLength(0);
  });

  it('bridge refuses a sessionState:false pool (e.g. transaction pooler) before any dispatch', async () => {
    const pool = new R2RecordingPool();
    const fakeDb = createDatabase({ adapter: r2Adapter(pool, false) });
    await expect(drizzlePostgres(fakeDb, { schema: {} })).rejects.toThrow(/sessionState: false/i);
    expect(pool.queries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. LIVE leg — approved local PostgreSQL 17 (:15432), unique review schema
// ---------------------------------------------------------------------------

const LOCAL_URL = process.env.DBSDK_TEST_POSTGRES_URL ?? 'postgresql://postgres:dbsdk@localhost:15432/dbsdk';
// UNIQUE schema owned by this review round only:
const REVIEW_SCHEMA = 'dbsdk_orm_facade_r2_review';

const reviewSchema = pgSchema(REVIEW_SCHEMA);
const rUsers = reviewSchema.table('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
  age: integer('age'),
});
const rPosts = reviewSchema.table('posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id')
    .notNull()
    .references(() => rUsers.id),
  title: text('title'),
});
const rPostsRelations = relations(rPosts, ({ one }) => ({
  author: one(rUsers, { fields: [rPosts.authorId], references: [rUsers.id] }),
}));
const rUsersRelations = relations(rUsers, ({ many }) => ({
  posts: many(rPosts),
}));
const liveSchema = { users: rUsers, posts: rPosts, usersRelations: rUsersRelations, postsRelations: rPostsRelations };

async function liveAvailable(): Promise<boolean> {
  if (process.env.DBSDK_SKIP_LIVE === '1') return false;
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: 15432, timeout: 2000 });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

const LIVE = await liveAvailable();

describe.skipIf(!LIVE)('live: facade schema over the frozen bridge (local PostgreSQL 17)', () => {
  let client: pg.Client;

  beforeAll(async () => {
    // Independent client for DDL and cleanup (does not share the bridge pool).
    client = new pg.Client({ connectionString: LOCAL_URL });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${REVIEW_SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${REVIEW_SCHEMA}`);
    await client.query(`CREATE TABLE ${REVIEW_SCHEMA}.users (id serial PRIMARY KEY, email text NOT NULL, age integer)`);
    await client.query(
      `CREATE TABLE ${REVIEW_SCHEMA}.posts (id serial PRIMARY KEY, author_id integer NOT NULL REFERENCES ${REVIEW_SCHEMA}.users(id), title text)`,
    );
  });

  afterAll(async () => {
    try {
      if (client) {
        await client.query(`DROP SCHEMA IF EXISTS ${REVIEW_SCHEMA} CASCADE`);
        await client.end();
      }
    } finally {
      // no-op: client.end is idempotent-enough for this review fixture
    }
  });

  it('insert…returning, typed join select, aggregates, self-join and RQB run against real PG', async () => {
    const db = createDatabase({ adapter: postgres({ connectionString: LOCAL_URL }) });
    const drizzle = await drizzlePostgres(db, { schema: liveSchema });

    // insert…returning
    const inserted = await drizzle
      .insert(rUsers)
      .values([
        { email: 'alice@example.com', age: 30 },
        { email: 'bob@example.com', age: 40 },
      ])
      .returning({ id: rUsers.id, email: rUsers.email });
    expect(inserted).toHaveLength(2);
    const aliceId = inserted[0]!.id;
    const bobId = inserted[1]!.id;

    const postRows = await drizzle
      .insert(rPosts)
      .values([
        { authorId: aliceId, title: 'one' },
        { authorId: aliceId, title: 'two' },
        { authorId: bobId, title: 'three' },
      ])
      .returning({ id: rPosts.id });
    expect(postRows).toHaveLength(3);

    // typed join select with inferred row shape
    const joined = await drizzle
      .select({ email: rUsers.email, title: rPosts.title })
      .from(rUsers)
      .innerJoin(rPosts, eq(rPosts.authorId, rUsers.id))
      .where(eq(rUsers.id, aliceId))
      .orderBy(asc(rPosts.id));
    expect(joined).toEqual([
      { email: 'alice@example.com', title: 'one' },
      { email: 'alice@example.com', title: 'two' },
    ]);

    // aggregate + group + having
    const counts = await drizzle
      .select({ author: rPosts.authorId, n: count(rPosts.id) })
      .from(rPosts)
      .groupBy(rPosts.authorId)
      .having(sql`count(*) >= 2`);
    expect(counts).toEqual([{ author: aliceId, n: 2 }]);

    // aliased self-join
    const u1 = aliasedTable(rUsers, 'u1');
    const u2 = aliasedTable(rUsers, 'u2');
    const selfJoined = await drizzle
      .select({ a: u1.id, b: u2.id })
      .from(u1)
      .innerJoin(u2, and(eq(u2.id, u1.id), inArray(u1.id, [aliceId, bobId])))
      .orderBy(desc(u1.id));
    expect(selfJoined).toEqual([
      { a: bobId, b: bobId },
      { a: aliceId, b: aliceId },
    ]);

    // RQB (relational query, lateral-join shape) via the passed schema
    const withAuthor = await drizzle.query.posts.findMany({
      where: eq(rPosts.authorId, aliceId),
      with: { author: true },
      orderBy: [asc(rPosts.id)],
    });
    expect(withAuthor).toHaveLength(2);
    expect(withAuthor[0]!.author).toMatchObject({ id: aliceId, email: 'alice@example.com' });

    // update…returning and delete…returning
    const aged = await drizzle.update(rUsers).set({ age: 31 }).where(eq(rUsers.id, aliceId)).returning({ age: rUsers.age });
    expect(aged).toEqual([{ age: 31 }]);
    const del = await drizzle.delete(rPosts).where(eq(rPosts.authorId, bobId)).returning({ id: rPosts.id });
    expect(del).toHaveLength(1);

    // sum/avg sanity through the facade namespace
    const totals = await drizzle.select({ total: sum(rUsers.age), mean: avg(rUsers.age) }).from(rUsers);
    expect(Number(totals[0]!.total)).toBe(71);
    await db.close();
  });
});
