/**
 * `dbsdk/orm` facade tests (source module `src/orm-facade`).
 *
 * These are NOT re-export-identity-only tests. They exercise the actual
 * stable drizzle-orm 0.45.3 behavior reachable through the SDK-owned
 * facade namespace: schema definition (tables, columns, enums, indexes,
 * constraints, relations), client-free SELECT construction (QueryBuilder +
 * .toSQL()), INSERT/UPDATE/DELETE construction with returning, set
 * operations and aggregates, and real query execution of a relational
 * query and a typed select through the frozen `dbsdk/drizzle` bridge
 * (facade-authored schema handed to `drizzlePostgres` over a pool-shaped
 * fixture). All SQL strings and parameter lists below were verified
 * against drizzle-orm 0.45.3 directly. Everything runs offline; no
 * database, no network.
 */

import * as upstream from 'drizzle-orm';
import * as upstreamPg from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

// Everything below is imported EXCLUSIVELY from the facade — that is the
// surface under test.
import {
  pgTable,
  pgEnum,
  text,
  integer,
  serial,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  foreignKey,
  check,
  relations,
  aliasedTable,
  count,
  QueryBuilder,
  eq,
  and,
  desc,
  asc,
  inArray,
  ilike,
  isNull,
  sql,
} from '../src/orm-facade/index.js';

import { createDatabase } from '../src/core/database.js';
import { drizzlePostgres } from '../src/drizzle-interop/index.js';
import type { DatabaseAdapter, DatabaseAdapterCapabilities } from '../src/types.js';
import type { PgPoolLike, PgQueryOutput } from '../src/adapters/pg-engine.js';

// ---------------------------------------------------------------------------
// Fixtures — pool-shaped recorder (the contract the stable node-postgres
// session actually calls: query(config, values) with rowMode "array") and a
// well-formed tcp/sessionState adapter.
// ---------------------------------------------------------------------------

class FacadeFakePool implements PgPoolLike {
  readonly queries: { text: string; values?: unknown[]; rowMode?: string }[] = [];
  ended = false;

  constructor(private readonly behavior?: (text: string, values?: unknown[]) => unknown[][]) {}

  async query(
    config: { text: string; values?: unknown[]; name?: string; rowMode?: string },
    values?: unknown[],
  ): Promise<PgQueryOutput> {
    if (this.ended) {
      throw new Error('Cannot use a pool after calling end on the pool');
    }
    const merged = values ?? config.values;
    this.queries.push({
      text: config.text,
      ...(merged !== undefined ? { values: merged as unknown[] } : {}),
      ...(config.rowMode !== undefined ? { rowMode: config.rowMode } : {}),
    });
    const rows = this.behavior?.(config.text, merged as unknown[] | undefined);
    return { rows: rows ?? [], rowCount: rows?.length ?? 0, command: 'SELECT' };
  }

  async connect() {
    return {
      async query() {
        return { rows: [], rowCount: 0, command: 'SELECT' } satisfies PgQueryOutput;
      },
      release() {},
    };
  }

  async end() {
    this.ended = true;
  }
}

function facadeAdapter(raw: PgPoolLike): DatabaseAdapter<PgPoolLike> {
  const capabilities: DatabaseAdapterCapabilities = {
    interactiveTransactions: true,
    atomicBatch: true,
    sessionState: true,
    transport: 'tcp',
    evidence: {},
  };
  return {
    id: 'facade-fake-pg',
    engine: 'postgresql',
    capabilities,
    raw: raw as never,
    async query() {
      return { rows: [], rowCount: 0 };
    },
    async close() {
      await raw.end();
    },
  };
}

// ---------------------------------------------------------------------------
// Schema authored ONLY through the facade namespace
// ---------------------------------------------------------------------------

const membershipRole = pgEnum('facade_role', ['owner', 'member', 'viewer']);

const orgs = pgTable(
  'facade_orgs',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    settings: jsonb('settings'),
    active: boolean('active').notNull().default(true),
  },
  (table) => [
    uniqueIndex('facade_orgs_name_key').on(table.name),
    check('facade_orgs_name_len', sql`length(${table.name}) > 0`),
  ],
);

const users = pgTable(
  'facade_users',
  {
    id: serial('id').primaryKey(),
    orgId: integer('org_id')
      .notNull()
      .references(() => orgs.id),
    email: text('email').notNull(),
    role: membershipRole('role').notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('facade_users_org_idx').on(table.orgId, table.email)],
);

const posts = pgTable(
  'facade_posts',
  {
    id: serial('id').primaryKey(),
    authorId: integer('author_id').notNull(),
    title: text('title'),
  },
  (table) => [
    foreignKey({
      name: 'facade_posts_author_fk',
      columns: [table.authorId],
      foreignColumns: [users.id],
    }),
  ],
);

const orgsRelations = relations(orgs, ({ many }) => ({
  users: many(users),
}));

const usersRelations = relations(users, ({ one, many }) => ({
  org: one(orgs, { fields: [users.orgId], references: [orgs.id] }),
  posts: many(posts),
}));

const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
}));

const schema = { orgs, users, posts, orgsRelations, usersRelations, postsRelations };

// ---------------------------------------------------------------------------
// 1. Identity: facade exports ARE the stable drizzle objects (spot checks,
//    complemented — not replaced — by the behavioral tests below).
// ---------------------------------------------------------------------------

describe('facade — identity with the stable drizzle-orm copy', () => {
  it('re-exports the very objects the bridge resolves (same module instance)', () => {
    // pg-core authoring surface
    expect(pgTable).toBe(upstreamPg.pgTable);
    expect(pgEnum).toBe(upstreamPg.pgEnum);
    expect(serial).toBe(upstreamPg.serial);
    expect(integer).toBe(upstreamPg.integer);
    expect(text).toBe(upstreamPg.text);
    expect(boolean).toBe(upstreamPg.boolean);
    expect(jsonb).toBe(upstreamPg.jsonb);
    expect(timestamp).toBe(upstreamPg.timestamp);
    expect(index).toBe(upstreamPg.index);
    expect(uniqueIndex).toBe(upstreamPg.uniqueIndex);
    expect(foreignKey).toBe(upstreamPg.foreignKey);
    expect(check).toBe(upstreamPg.check);
    expect(QueryBuilder).toBe(upstreamPg.QueryBuilder);
    // root operators / relations / sql
    expect(eq).toBe(upstream.eq);
    expect(and).toBe(upstream.and);
    expect(desc).toBe(upstream.desc);
    expect(asc).toBe(upstream.asc);
    expect(inArray).toBe(upstream.inArray);
    expect(ilike).toBe(upstream.ilike);
    expect(isNull).toBe(upstream.isNull);
    expect(count).toBe(upstream.count);
    expect(aliasedTable).toBe(upstream.aliasedTable);
    expect(sql).toBe(upstream.sql);
    expect(relations).toBe(upstream.relations);
    // NOTE: in stable 0.45.x, `one`/`many` are NOT module-level exports —
    // they exist only as callback-injected helpers inside relations():
    // relations(table, ({ one, many }) => ...). A facade must not pretend
    // otherwise; strict typecheck enforces this.
  });
});

// ---------------------------------------------------------------------------
// 2. Client-free SELECT construction through the facade (QueryBuilder)
// ---------------------------------------------------------------------------

describe('facade — QueryBuilder SELECT construction', () => {
  it('builds join / where / orderBy / limit / offset with parameter binding', () => {
    const query = new QueryBuilder()
      .select({ id: users.id, email: users.email, org: orgs.name })
      .from(users)
      .innerJoin(orgs, eq(users.orgId, orgs.id))
      .where(and(eq(orgs.active, true), ilike(users.email, '%@example.com')))
      .orderBy(desc(users.createdAt), asc(users.id))
      .limit(10)
      .offset(20);

    expect(query.toSQL()).toEqual({
      sql:
        'select "facade_users"."id", "facade_users"."email", "facade_orgs"."name" from "facade_users" ' +
        'inner join "facade_orgs" on "facade_users"."org_id" = "facade_orgs"."id" ' +
        'where ("facade_orgs"."active" = $1 and "facade_users"."email" ilike $2) ' +
        'order by "facade_users"."created_at" desc, "facade_users"."id" asc limit $3 offset $4',
      params: [true, '%@example.com', 10, 20],
    });
  });

  it('supports set operations, aggregates with group/having, and table aliasing', () => {
    const archived = pgTable('facade_archived_users', {
      id: serial('id').primaryKey(),
      email: text('email').notNull(),
    });

    const union = new QueryBuilder()
      .select({ id: users.id, email: users.email })
      .from(users)
      .union(new QueryBuilder().select({ id: archived.id, email: archived.email }).from(archived));
    expect(union.toSQL().sql).toBe(
      '(select "id", "email" from "facade_users") union (select "id", "email" from "facade_archived_users")',
    );

    const aggregate = new QueryBuilder()
      .select({ total: count(), org: orgs.name })
      .from(orgs)
      .groupBy(orgs.id)
      .having(sql`count(*) > ${1}`);
    expect(aggregate.toSQL()).toEqual({
      sql: 'select count(*), "name" from "facade_orgs" group by "facade_orgs"."id" having count(*) > $1',
      params: [1],
    });

    const u2 = aliasedTable(users, 'u2');
    const selfJoin = new QueryBuilder()
      .select({ a: users.id, b: u2.id })
      .from(users)
      .innerJoin(u2, sql`${u2.id} = ${users.id}`);
    expect(selfJoin.toSQL().sql).toBe(
      'select "facade_users"."id", "u2"."id" from "facade_users" inner join "facade_users" "u2" on "u2"."id" = "facade_users"."id"',
    );
  });
});

// ---------------------------------------------------------------------------
// 3–5. Real usage through the frozen bridge: facade-authored schema is handed
//      to `drizzlePostgres` (same drizzle-orm copy the facade re-exports) and
//      driven against a pool-shaped fixture. Write builders are constructed
//      and inspected via .toSQL() without executing; the relational query and
//      the typed select are actually executed and mapped.
// ---------------------------------------------------------------------------

describe('facade — schema through the dbsdk/drizzle bridge', () => {
  it('builds INSERT/UPDATE/DELETE ... returning with correct SQL and params', async () => {
    const pool = new FacadeFakePool();
    const db = createDatabase({ adapter: facadeAdapter(pool) });
    const drizzleDb = await drizzlePostgres(db, { schema });

    const insert = drizzleDb
      .insert(users)
      .values({ orgId: 1, email: 'a@b.c', role: 'owner' })
      .returning({ id: users.id });
    expect(insert.toSQL()).toEqual({
      sql:
        'insert into "facade_users" ("id", "org_id", "email", "role", "created_at") ' +
        'values (default, $1, $2, $3, default) returning "id"',
      params: [1, 'a@b.c', 'owner'],
    });

    const update = drizzleDb
      .update(users)
      .set({ role: 'viewer', email: sql`lower(${'A@B.C'})` })
      .where(eq(users.id, 7))
      .returning();
    expect(update.toSQL()).toEqual({
      sql:
        'update "facade_users" set "email" = lower($1), "role" = $2 ' +
        'where "facade_users"."id" = $3 returning "id", "org_id", "email", "role", "created_at"',
      params: ['A@B.C', 'viewer', 7],
    });

    const del = drizzleDb
      .delete(posts)
      .where(and(inArray(posts.authorId, [3, 4]), isNull(posts.title)))
      .returning({ id: posts.id });
    expect(del.toSQL()).toEqual({
      sql:
        'delete from "facade_posts" where ("facade_posts"."author_id" in ($1, $2) ' +
        'and "facade_posts"."title" is null) returning "id"',
      params: [3, 4],
    });

    expect(pool.queries).toHaveLength(0); // .toSQL() never dispatches
    await db.close();
  });

  it('executes a relational query (RQB) with the relations graph and maps the result', async () => {
    const pool = new FacadeFakePool((text) => {
      if (text.includes('left join lateral')) {
        // users columns (id, org_id, email, role, created_at) followed by the
        // org "data" json_build_array column
        return [[1, 1, 'u@example.com', 'member', new Date(0), [1, 'Acme', null, true]]] as unknown[][];
      }
      return [];
    });
    const db = createDatabase({ adapter: facadeAdapter(pool) });
    const drizzleDb = await drizzlePostgres(db, { schema });

    const result = await drizzleDb.query.users.findMany({ with: { org: true }, limit: 5 });

    expect(pool.queries).toHaveLength(1);
    const { text, values } = pool.queries[0]!;
    expect(text).toContain('from "facade_users" "users"');
    expect(text).toContain('left join lateral');
    expect(text).toContain('"facade_orgs"');
    expect(values).toEqual([1, 5]);

    expect(result).toEqual([
      {
        id: 1,
        orgId: 1,
        email: 'u@example.com',
        role: 'member',
        createdAt: new Date(0),
        org: { id: 1, name: 'Acme', settings: null, active: true },
      },
    ]);

    await db.close();
    expect(pool.ended).toBe(true);
  });

  it('executes a typed select through the bridge and maps array-mode rows', async () => {
    const pool = new FacadeFakePool((text) => {
      if (text.startsWith('select "id", "email", "role"')) {
        return [[1, 'u@example.com', 'member']] as unknown[][];
      }
      return [];
    });
    const db = createDatabase({ adapter: facadeAdapter(pool) });
    const drizzleDb = await drizzlePostgres(db, { schema });

    const rows = await drizzleDb
      .select({ id: users.id, email: users.email, role: users.role })
      .from(users)
      .where(eq(users.orgId, 1));

    expect(rows).toEqual([{ id: 1, email: 'u@example.com', role: 'member' }]);
    expect(pool.queries[0]?.text).toBe('select "id", "email", "role" from "facade_users" where "facade_users"."org_id" = $1');
    expect(pool.queries[0]?.values).toEqual([1]);
    expect(pool.queries[0]?.rowMode).toBe('array');

    await db.close();
  });

  it('bridge refusals still apply to facade-authored schemas (sessionState: false)', async () => {
    const pool = new FacadeFakePool();
    const adapter = facadeAdapter(pool);
    const noSession: DatabaseAdapterCapabilities = { ...adapter.capabilities, sessionState: false };
    const refusedDb = createDatabase({ adapter: { ...adapter, capabilities: noSession } });

    await expect(drizzlePostgres(refusedDb, { schema })).rejects.toMatchObject({
      code: 'CONFIGURATION',
    });
    expect(pool.queries).toHaveLength(0); // refused before any dispatch
  });
});
