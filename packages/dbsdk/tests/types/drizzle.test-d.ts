/**
 * Type-level tests for `dbsdk/drizzle` — checked by vitest's typecheck task
 * (the tests/types test-d files). They verify that the bridge preserves
 * Drizzle's stable generic inference (schema tables, relations, insert and
 * result types) and rejects native-construction config at compile time.
 */

import { expectTypeOf, describe, it } from 'vitest';
import { relations } from 'drizzle-orm';
import { integer, pgTable, serial, text } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';

import { createDatabase } from '../../src/core/database.js';
import { postgres } from '../../src/adapters/postgres.js';
import { drizzlePostgres, drizzleNeonHttp } from '../../src/drizzle-interop/index.js';

const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
  age: integer('age'),
});

const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  title: text('title').notNull(),
});

const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}));
const postsRelations = relations(posts, ({ one }) => ({
  user: one(users, { fields: [posts.userId], references: [users.id] }),
}));
const schema = { users, posts, usersRelations, postsRelations };

// Adapter construction is lazy: no connection is made at type-check time.
const db = createDatabase({
  adapter: postgres({ connectionString: 'postgres://user:pass@localhost:5432/app' }),
});

describe('drizzlePostgres — preserved generic inference', () => {
  it('infers select result types from the schema', async () => {
    const drizzleDb = await drizzlePostgres(db, { schema });
    const rows = await drizzleDb.select().from(users);
    expectTypeOf(rows).toEqualTypeOf<
      { id: number; email: string; age: number | null }[]
    >();
  });

  it('infers projection and join types', async () => {
    const drizzleDb = await drizzlePostgres(db, { schema });
    const joined = await drizzleDb
      .select({ email: users.email, title: posts.title })
      .from(users)
      .innerJoin(posts, undefined);
    expectTypeOf(joined).toEqualTypeOf<{ email: string; title: string }[]>();
  });

  it('infers relational query types from schema relations', async () => {
    const drizzleDb = await drizzlePostgres(db, { schema });
    const withPosts = await drizzleDb.query.users.findMany({ with: { posts: true } });
    expectTypeOf(withPosts).toEqualTypeOf<
      {
        id: number;
        email: string;
        age: number | null;
        posts: { id: number; userId: number; title: string }[];
      }[]
    >();
  });

  it('exposes the dbSDK-owned pool as $client: Pool', async () => {
    const drizzleDb = await drizzlePostgres(db);
    expectTypeOf(drizzleDb.$client).toEqualTypeOf<Pool>();
  });

  it('types inserts from the schema and rejects wrong columns and value types', async () => {
    const drizzleDb = await drizzlePostgres(db, { schema });
    // Valid insert: only schema columns, correctly typed.
    await drizzleDb.insert(users).values({ email: 'a@b.c', age: 30 });
    // @ts-expect-error - "emial" is not a column of the users table
    await drizzleDb.insert(users).values({ emial: 'a@b.c' });
    // @ts-expect-error - email is text, not number
    await drizzleDb.insert(users).values({ email: 42 });
  });

  it('rejects native-construction config at compile time', async () => {
    const dsn = 'postgres://user:pass@localhost:5432/app';
    // @ts-expect-error - `connection` would make Drizzle build its own pool
    await drizzlePostgres(db, { connection: dsn });
    // @ts-expect-error - `client` would bypass the dbSDK-owned handle
    await drizzlePostgres(db, { client: new Pool({ connectionString: dsn }) });
    // @ts-expect-error - unknown keys are rejected (no erasure to `any`)
    await drizzlePostgres(db, { connectionString: dsn });
  });
});

describe('drizzleNeonHttp — preserved generic inference', () => {
  it('infers select result types from the schema', async () => {
    const drizzleDb = await drizzleNeonHttp(db as never, { schema });
    const rows = await drizzleDb.select().from(users);
    expectTypeOf(rows).toEqualTypeOf<
      { id: number; email: string; age: number | null }[]
    >();
    // @ts-expect-error - wrong column rejected just like on the pg bridge
    await drizzleDb.insert(users).values({ emial: 'a@b.c' });
  });
});
