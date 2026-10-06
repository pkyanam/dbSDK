/**
 * INDEPENDENT R4 acceptance tests for the wired `dbsdk/orm` public subpath
 * (source module `src/orm-facade`) — review sub-agent, round 4.
 *
 * Purpose: independently verify the R3 integration candidate's claims with
 * coverage deliberately DISTINCT from tests/orm-facade.test.ts (author, R1)
 * and tests/orm-facade-acceptance-r2.test.ts (R2 review):
 *
 * 1. Wider non-vacuous identity: 22 runtime symbols proven DEFINED before
 *    being compared by reference to the consumer-resolved drizzle-orm —
 *    including `aliasedTable` (root-only) and the pg-core specializations.
 * 2. pgSchema-qualified authoring with table constraints (index + unique +
 *    check) built EXCLUSIVELY through the facade; dual SQL byte-equality vs
 *    direct upstream construction with EXACT parameter-list assertions.
 * 3. Union with post-union order/limit, aggregate + group + having with
 *    exact params, and INSERT/UPDATE/DELETE…RETURNING byte-equality through
 *    the frozen bridge over recording pools (zero dispatch).
 * 4. LIVE leg (approved local PostgreSQL 17 only, env-gated): a UNIQUE review
 *    schema is created and dropped by an INDEPENDENT `pg` client; rows written
 *    through the frozen bridge via facade-authored schema are then READ BACK
 *    and verified through that independent client (external verification of
 *    the bridge's effect, not just the bridge's own results). The afterAll
 *    also FAILS if the fixture schema still exists (leak = test failure).
 *
 * Everything except leg 4 is fully offline. No hosted services are contacted.
 */

import * as upstream from 'drizzle-orm';
import * as upstreamPg from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import pg from 'pg';

// The surface under test — imported EXCLUSIVELY through the facade module.
import {
  pgSchema,
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
  check,
  relations,
  aliasedTable,
  count,
  sum,
  QueryBuilder,
  eq,
  and,
  asc,
  desc,
  inArray,
  ilike,
  sql,
} from '../src/orm-facade/index.js';
import * as facade from '../src/orm-facade/index.js';

import { createDatabase } from '../src/core/database.js';
import { postgres } from '../src/adapters/postgres.js';
import { drizzlePostgres } from '../src/drizzle-interop/index.js';
import type { DatabaseAdapter, DatabaseAdapterCapabilities } from '../src/types.js';
import type { PgPoolLike, PgQueryOutput } from '../src/adapters/pg-engine.js';

// ---------------------------------------------------------------------------
// 1. Wider non-vacuous identity (22 symbols)
// ---------------------------------------------------------------------------

describe('R4: facade symbols defined and reference-identical (wider set)', () => {
  const SYMBOLS = [
    // pg-core authoring
    'pgSchema', 'pgTable', 'serial', 'text', 'integer', 'timestamp', 'index',
    'uniqueIndex', 'check', 'QueryBuilder',
    // root utilities + operators + aggregations
    'relations', 'aliasedTable', 'count', 'sum',
    'eq', 'and', 'asc', 'desc', 'inArray', 'ilike', 'sql',
  ] as const;

  it('all 22 symbols are defined through the facade (vacuity guard first)', () => {
    for (const name of SYMBOLS) {
      const value = (facade as Record<string, unknown>)[name];
      expect(value, `${name} must be exported`).toBeDefined();
    }
  });

  it('pg-core symbols are the consumer\'s drizzle-orm/pg-core objects', () => {
    expect(facade.pgSchema).toBe(upstreamPg.pgSchema);
    expect(facade.pgTable).toBe(upstreamPg.pgTable);
    expect(facade.serial).toBe(upstreamPg.serial);
    expect(facade.text).toBe(upstreamPg.text);
    expect(facade.integer).toBe(upstreamPg.integer);
    expect(facade.timestamp).toBe(upstreamPg.timestamp);
    expect(facade.index).toBe(upstreamPg.index);
    expect(facade.uniqueIndex).toBe(upstreamPg.uniqueIndex);
    expect(facade.check).toBe(upstreamPg.check);
    expect(facade.QueryBuilder).toBe(upstreamPg.QueryBuilder);
  });

  it('root symbols are the consumer\'s drizzle-orm objects; aliasedTable is root-only', () => {
    expect(facade.relations).toBe(upstream.relations);
    expect(facade.aliasedTable).toBe(upstream.aliasedTable);
    expect(facade.count).toBe(upstream.count);
    expect(facade.sum).toBe(upstream.sum);
    expect(facade.eq).toBe(upstream.eq);
    expect(facade.and).toBe(upstream.and);
    expect(facade.asc).toBe(upstream.asc);
    expect(facade.desc).toBe(upstream.desc);
    expect(facade.inArray).toBe(upstream.inArray);
    expect(facade.ilike).toBe(upstream.ilike);
    expect(facade.sql).toBe(upstream.sql);
    // Documented upstream shape: aliasedTable is NOT a pg-core export.
    expect((upstreamPg as Record<string, unknown>).aliasedTable).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. pgSchema-qualified constrained authoring + dual SQL byte equality
// ---------------------------------------------------------------------------

const SCHEMA = 'r4_review';
const app = pgSchema(SCHEMA);
const r4Users = app.table('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
  age: integer('age'),
  createdAt: timestamp('created_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('r4_users_email_uq').on(t.email),
  index('r4_users_age_idx').on(t.age),
  check('r4_users_age_ck', sql`${t.age} is null or ${t.age} >= 0`),
]);
const r4Posts = app.table('posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id').notNull().references(() => r4Users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  score: integer('score').notNull().default(0),
});

// Independent upstream mirror of the SAME schema.
const upApp = upstreamPg.pgSchema(SCHEMA);
const upUsers = upApp.table('users', {
  id: upstreamPg.serial('id').primaryKey(),
  email: upstreamPg.text('email').notNull(),
  age: upstreamPg.integer('age'),
  createdAt: upstreamPg.timestamp('created_at', { withTimezone: true }),
}, (t) => [
  upstreamPg.uniqueIndex('r4_users_email_uq').on(t.email),
  upstreamPg.index('r4_users_age_idx').on(t.age),
  upstreamPg.check('r4_users_age_ck', upstream.sql`${t.age} is null or ${t.age} >= 0`),
]);
const upPosts = upApp.table('posts', {
  id: upstreamPg.serial('id').primaryKey(),
  authorId: upstreamPg.integer('author_id').notNull().references(() => upUsers.id, { onDelete: 'cascade' }),
  title: upstreamPg.text('title').notNull(),
  score: upstreamPg.integer('score').notNull().default(0),
});

describe('R4: dual SQL byte equality with EXACT params (facade vs direct upstream)', () => {
  const qb = new QueryBuilder();
  const uqb = new upstreamPg.QueryBuilder();

  it('select + join + composite where + order + limit/offset (exact SQL and params)', () => {
    const f = qb.select({ id: r4Users.id, email: r4Users.email, title: r4Posts.title })
      .from(r4Posts)
      .innerJoin(r4Users, eq(r4Posts.authorId, r4Users.id))
      .where(and(inArray(r4Users.age, [21, 30, 45]), ilike(r4Users.email, '%@example.com'), sql`${r4Posts.score} > ${3}`))
      .orderBy(desc(r4Posts.score), asc(r4Users.id))
      .limit(10)
      .offset(5)
      .toSQL();
    const u = uqb.select({ id: upUsers.id, email: upUsers.email, title: upPosts.title })
      .from(upPosts)
      .innerJoin(upUsers, upstream.eq(upPosts.authorId, upUsers.id))
      .where(upstream.and(upstream.inArray(upUsers.age, [21, 30, 45]), upstream.ilike(upUsers.email, '%@example.com'), upstream.sql`${upPosts.score} > ${3}`))
      .orderBy(upstream.desc(upPosts.score), upstream.asc(upUsers.id))
      .limit(10)
      .offset(5)
      .toSQL();
    expect(f.sql).toBe(u.sql);
    expect(f.sql).toContain(`"r4_review"."posts"`);
    expect(f.params).toEqual(u.params);
    expect(f.params).toEqual([21, 30, 45, '%@example.com', 3, 10, 5]);
  });

  it('union with post-union order/limit', () => {
    const aliased = aliasedTable(r4Users, 'u2');
    const upAliased = upstream.aliasedTable(upUsers, 'u2');
    const f = qb.select({ email: r4Users.email }).from(r4Users).where(inArray(r4Users.age, [30]))
      .union(qb.select({ email: aliased.email }).from(aliased))
      .orderBy(asc(r4Users.email))
      .limit(3)
      .toSQL();
    const u = uqb.select({ email: upUsers.email }).from(upUsers).where(upstream.inArray(upUsers.age, [30]))
      .union(uqb.select({ email: upAliased.email }).from(upAliased))
      .orderBy(upstream.asc(upUsers.email))
      .limit(3)
      .toSQL();
    expect(f.sql).toBe(u.sql);
    expect(f.params).toEqual([30, 3]);
  });

  it('aggregate + group + having with exact params', () => {
    const f = qb.select({ author: r4Posts.authorId, n: count(), total: sum(r4Posts.score) })
      .from(r4Posts)
      .groupBy(r4Posts.authorId)
      .having(sql`count(*) > ${1} and sum(${r4Posts.score}) >= ${5}`)
      .toSQL();
    const u = uqb.select({ author: upPosts.authorId, n: upstream.count(), total: upstream.sum(upPosts.score) })
      .from(upPosts)
      .groupBy(upPosts.authorId)
      .having(upstream.sql`count(*) > ${1} and sum(${upPosts.score}) >= ${5}`)
      .toSQL();
    expect(f.sql).toBe(u.sql);
    expect(f.params).toEqual([1, 5]);
  });

  it('INSERT/UPDATE/DELETE…RETURNING byte-equality through the frozen bridge over recording pools (zero dispatch)', async () => {
    const facadePool = new R4RecordingPool();
    const facadeDb = createDatabase({ adapter: r4Adapter(facadePool) });
    const viaFacade = await drizzlePostgres(facadeDb, {});
    const upstreamPool = new R4RecordingPool();
    const { drizzle: upstreamDrizzle } = await import('drizzle-orm/node-postgres');
    const viaUpstream = upstreamDrizzle(upstreamPool as never);

    const ins = viaFacade.insert(r4Users)
      .values({ email: 'a@example.com', age: 30, createdAt: new Date('2026-01-01T00:00:00Z') })
      .returning({ id: r4Users.id, email: r4Users.email, createdAt: r4Users.createdAt });
    const insU = viaUpstream.insert(upUsers)
      .values({ email: 'a@example.com', age: 30, createdAt: new Date('2026-01-01T00:00:00Z') })
      .returning({ id: upUsers.id, email: upUsers.email, createdAt: upUsers.createdAt });
    expect(ins.toSQL()).toEqual(insU.toSQL());

    const upd = viaFacade.update(r4Posts).set({ score: 10 }).where(eq(r4Posts.id, 7)).returning({ id: r4Posts.id, score: r4Posts.score });
    const updU = viaUpstream.update(upPosts).set({ score: 10 }).where(upstream.eq(upPosts.id, 7)).returning({ id: upPosts.id, score: upPosts.score });
    expect(upd.toSQL()).toEqual(updU.toSQL());
    expect(upd.toSQL().params).toEqual([10, 7]);

    const del = viaFacade.delete(r4Posts).where(and(eq(r4Posts.authorId, 3), eq(r4Posts.score, 0))).returning({ id: r4Posts.id });
    const delU = viaUpstream.delete(upPosts).where(upstream.and(upstream.eq(upPosts.authorId, 3), upstream.eq(upPosts.score, 0))).returning({ id: upPosts.id });
    expect(del.toSQL()).toEqual(delU.toSQL());
    expect(del.toSQL().params).toEqual([3, 0]);

    // Construction only — nothing dispatched through either pool.
    expect(facadePool.queries).toHaveLength(0);
    expect(upstreamPool.queries).toHaveLength(0);
    await facadeDb.close();
  });
});

class R4RecordingPool implements PgPoolLike {
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

function r4Adapter(raw: PgPoolLike): DatabaseAdapter<PgPoolLike> {
  const capabilities: DatabaseAdapterCapabilities = {
    interactiveTransactions: true,
    atomicBatch: true,
    sessionState: true,
    transport: 'tcp',
    evidence: {},
  };
  return {
    id: 'r4-review-fake-pg',
    engine: 'postgresql',
    capabilities,
    raw: raw as never,
    async query() { return { rows: [], rowCount: 0 }; },
    async close() { await raw.end(); },
  };
}

// ---------------------------------------------------------------------------
// 4. LIVE leg with EXTERNAL verification (approved local PG 17 only)
// ---------------------------------------------------------------------------

const LOCAL_URL = process.env.DBSDK_TEST_POSTGRES_URL ?? 'postgresql://postgres:dbsdk@localhost:15432/dbsdk';
// UNIQUE schema owned by the R4 review only:
const REVIEW_SCHEMA = 'dbsdk_orm_r4_review';

const reviewApp = pgSchema(REVIEW_SCHEMA);
const liveUsers = reviewApp.table('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
  age: integer('age'),
  createdAt: timestamp('created_at', { withTimezone: true }),
});
const livePosts = reviewApp.table('posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id').notNull().references(() => liveUsers.id),
  title: text('title').notNull(),
  score: integer('score').notNull().default(0),
});
const liveUsersRel = relations(liveUsers, ({ many }) => ({ posts: many(livePosts) }));
const livePostsRel = relations(livePosts, ({ one }) => ({
  author: one(liveUsers, { fields: [livePosts.authorId], references: [liveUsers.id] }),
}));
const liveSchema = { users: liveUsers, posts: livePosts, usersRel: liveUsersRel, postsRel: livePostsRel };

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

describe.skipIf(!LIVE)('R4 live: bridge effects verified through an INDEPENDENT pg client', () => {
  let client: pg.Client;
  let dbClosed = false;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: LOCAL_URL });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${REVIEW_SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${REVIEW_SCHEMA}`);
    await client.query(
      `CREATE TABLE ${REVIEW_SCHEMA}.users (id serial PRIMARY KEY, email text NOT NULL, age integer, created_at timestamptz)`,
    );
    await client.query(
      `CREATE TABLE ${REVIEW_SCHEMA}.posts (id serial PRIMARY KEY, author_id integer NOT NULL REFERENCES ${REVIEW_SCHEMA}.users(id), title text NOT NULL, score integer NOT NULL DEFAULT 0)`,
    );
  });

  afterAll(async () => {
    try {
      if (client) {
        await client.query(`DROP SCHEMA IF EXISTS ${REVIEW_SCHEMA} CASCADE`);
        // LEAK GUARD: the fixture schema must be gone after cleanup.
        const residue = await client.query(
          `SELECT 1 FROM pg_namespace WHERE nspname = '${REVIEW_SCHEMA}'`,
        );
        expect(residue.rows).toHaveLength(0);
        await client.end();
      }
    } finally {
      void dbClosed;
    }
  });

  it('writes through the frozen bridge are externally verified row-by-row', async () => {
    const db = createDatabase({ adapter: postgres({ connectionString: LOCAL_URL, max: 2 }) });
    const when = new Date('2026-02-03T04:05:06.789Z');
    try {
      const drizzle = await drizzlePostgres(db, { schema: liveSchema });

      // INSERT…RETURNING through the bridge (facade-authored, pgSchema-qualified).
      const inserted = await drizzle.insert(liveUsers).values([
        { email: 'r4-alice@example.com', age: 30, createdAt: when },
        { email: 'r4-bob@example.com', age: 45 },
      ]).returning({ id: liveUsers.id, email: liveUsers.email });
      expect(inserted).toHaveLength(2);

      // EXTERNAL verification: read back through the independent client.
      const extUsers = await client.query(
        `SELECT id, email, age, created_at FROM ${REVIEW_SCHEMA}.users ORDER BY id`,
      );
      expect(extUsers.rows).toHaveLength(2);
      expect(extUsers.rows[0]!.email).toBe('r4-alice@example.com');
      expect(extUsers.rows[0]!.age).toBe(30);
      expect(extUsers.rows[0]!.created_at.toISOString()).toBe(when.toISOString());
      expect(extUsers.rows[1]!.email).toBe('r4-bob@example.com');
      expect(extUsers.rows[1]!.age).toBe(45);
      expect(extUsers.rows[1]!.created_at).toBeNull();

      const aliceId = inserted[0]!.id;
      const bobId = inserted[1]!.id;

      await drizzle.insert(livePosts).values([
        { authorId: aliceId, title: 'one', score: 5 },
        { authorId: aliceId, title: 'two', score: 9 },
        { authorId: bobId, title: 'three', score: 1 },
      ]);

      // Typed join select (bridge view).
      const joined = await drizzle
        .select({ email: liveUsers.email, title: livePosts.title })
        .from(livePosts)
        .innerJoin(liveUsers, eq(livePosts.authorId, liveUsers.id))
        .where(eq(liveUsers.id, aliceId))
        .orderBy(asc(livePosts.id));
      expect(joined).toEqual([
        { email: 'r4-alice@example.com', title: 'one' },
        { email: 'r4-alice@example.com', title: 'two' },
      ]);

      // Aggregate + group + having (bridge view) — cross-check externally.
      const agg = await drizzle
        .select({ authorId: livePosts.authorId, n: count(), total: sum(livePosts.score) })
        .from(livePosts)
        .groupBy(livePosts.authorId)
        .having(sql`count(*) > ${1}`);
      expect(agg).toEqual([{ authorId: aliceId, n: 2, total: '14' }]);
      const extAgg = await client.query(
        `SELECT author_id, count(*)::int AS n FROM ${REVIEW_SCHEMA}.posts GROUP BY author_id HAVING count(*) > 1`,
      );
      expect(extAgg.rows).toEqual([{ author_id: aliceId, n: 2 }]);

      // RQB with nested mapping (bridge view).
      const feed = await drizzle.query.users.findMany({
        with: { posts: true },
        orderBy: [asc(liveUsers.id)],
      });
      expect(feed).toHaveLength(2);
      expect(feed[0]!.posts.map((p) => p.title)).toEqual(['one', 'two']);
      expect(feed[1]!.posts.map((p) => p.title)).toEqual(['three']);
      // one() side mapping via the posts relational config:
      const authors = await drizzle.query.posts.findMany({
        with: { author: true },
        orderBy: [asc(livePosts.id)],
      });
      expect(authors.map((p) => p.author!.email)).toEqual([
        'r4-alice@example.com',
        'r4-alice@example.com',
        'r4-bob@example.com',
      ]);

      // UPDATE…RETURNING + external verification.
      const updated = await drizzle.update(livePosts).set({ score: 10 })
        .where(eq(livePosts.title, 'two')).returning({ id: livePosts.id, score: livePosts.score });
      expect(updated).toEqual([{ id: updated[0]!.id, score: 10 }]);
      const extUpd = await client.query(
        `SELECT score FROM ${REVIEW_SCHEMA}.posts WHERE title = 'two'`,
      );
      expect(extUpd.rows[0]!.score).toBe(10);

      // DELETE…RETURNING (empty) and non-empty + external verification.
      const delEmpty = await drizzle.delete(livePosts).where(eq(livePosts.score, 999)).returning({ id: livePosts.id });
      expect(delEmpty).toEqual([]);
      const deleted = await drizzle.delete(livePosts).where(eq(livePosts.title, 'three')).returning({ id: livePosts.id });
      expect(deleted).toHaveLength(1);
      const extDel = await client.query(
        `SELECT count(*)::int AS n FROM ${REVIEW_SCHEMA}.posts WHERE title = 'three'`,
      );
      expect(extDel.rows[0]!.n).toBe(0);
    } finally {
      dbClosed = true;
      await db.close();
    }
  });
});
