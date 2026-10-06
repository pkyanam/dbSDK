/**
 * Type-level tests for the `dbsdk/orm` facade (source module
 * `src/orm-facade`) — checked by vitest's typecheck task. They verify that
 * the SDK-owned namespace preserves stable drizzle-orm 0.45.3 generic
 * inference for schema authoring (select/insert models) and operator
 * strictness, and that schema authored via the facade infers correctly when
 * handed to the frozen `dbsdk/drizzle` bridge.
 */

import { expectTypeOf, describe, it } from 'vitest';

// Schema authoring comes ONLY from the facade — that is the surface tested.
import {
  pgTable,
  serial,
  text,
  integer,
  eq,
  sql,
  QueryBuilder,
  type InferSelectModel,
  type InferInsertModel,
  type SQL,
} from '../../src/orm-facade/index.js';

import { createDatabase } from '../../src/core/database.js';
import { postgres } from '../../src/adapters/postgres.js';
import { drizzlePostgres } from '../../src/drizzle-interop/index.js';

const users = pgTable('facade_type_users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
  age: integer('age'),
});

// Adapter construction is lazy: no connection is made at type-check time.
const db = createDatabase({
  adapter: postgres({ connectionString: 'postgres://user:pass@localhost:5432/app' }),
});

describe('orm facade — schema model inference', () => {
  it('infers the select model from a facade-authored table', () => {
    expectTypeOf<InferSelectModel<typeof users>>().toEqualTypeOf<{
      id: number;
      email: string;
      age: number | null;
    }>();
  });

  it('infers the insert model with only the not-null column required', () => {
    const insertable: InferInsertModel<typeof users> = { email: 'x@y.z' };
    expectTypeOf(insertable.email).toEqualTypeOf<string>();
    expectTypeOf(insertable.age).toEqualTypeOf<number | null | undefined>();
  });
});

describe('orm facade — operator and template strictness', () => {
  it('keeps column-typed operator checking', () => {
    expectTypeOf(eq(users.age, 42)).toMatchTypeOf<SQL>();
    // @ts-expect-error a string is not assignable to an integer column operand
    eq(users.age, 'not-a-number');
  });

  it('keeps the sql template and QueryBuilder types intact', () => {
    expectTypeOf(sql`select 1`).toMatchTypeOf<SQL>();
    const query = new QueryBuilder().select({ id: users.id }).from(users).where(eq(users.id, 1));
    expectTypeOf(query.toSQL()).toEqualTypeOf<{ sql: string; params: unknown[] }>();
  });
});

describe('orm facade — inference through the frozen bridge', () => {
  it('infers select row types from the facade-authored schema', async () => {
    const drizzleDb = await drizzlePostgres(db, { schema: { users } });
    const rows = await drizzleDb.select().from(users);
    expectTypeOf(rows).toEqualTypeOf<{ id: number; email: string; age: number | null }[]>();
  });
});
