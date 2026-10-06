/**
 * 03 - Error handling: codes, SQLSTATE, and indeterminate writes
 *
 *   npm run fixture
 *   DBSDK_ADAPTER=postgres DBSDK_URL=postgres://... npm run errors
 *
 * With a real adapter (postgres/supabase/neon), the errors come from a real
 * database. With the fixture adapter (default), scripted errors demonstrate
 * exactly the same normalization, because the client normalizes whatever the
 * adapter throws.
 */

import { createDatabase, isDbError, type Database } from "dbsdk";
import { createFixtureAdapter } from "dbsdk/testing";
import { makeDb, ensureSchema } from "./lib/setup.js";

function fixtureDb(): Database<unknown> {
  const adapter = createFixtureAdapter({
    fixtures: [
      {
        // Simulate a unique violation the way PostgreSQL reports it.
        match: /insert into users/,
        error: Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), { code: "23505" }),
      },
      {
        // Simulate a syntax error (undefined table).
        match: /definitively_not_a_table/,
        error: Object.assign(new Error('relation "definitively_not_a_table" does not exist'), { code: "42P01" }),
      },
      { match: /./, repeat: true }, // everything else: empty result
    ],
  });
  return createDatabase({ adapter }) as Database<unknown>;
}

const useFixtures = (process.env.DBSDK_ADAPTER ?? "fixture") === "fixture";
const { db, adapterId } = useFixtures ? { db: fixtureDb(), adapterId: "fixture" } : makeDb();

try {
  if (!useFixtures) await ensureSchema(db);

  // 1. A constraint violation keeps its SQLSTATE.
  try {
    await db.sql`insert into users (email) values (${"ada@example.com"})`;
    if (!useFixtures) {
      // second insert violates the unique constraint on a real database
      await db.sql`insert into users (email) values (${"ada@example.com"})`;
    }
  } catch (error) {
    if (isDbError(error)) {
      console.log(`constraint: code=${error.code} sqlstate=${error.sqlstate} retryable=${error.retryable}`);
      // code=CONSTRAINT sqlstate=23505
    }
  }

  // 2. A syntax error classifies as SYNTAX, with the driver error as cause.
  try {
    await db.sql`select * from definitively_not_a_table`;
  } catch (error) {
    if (isDbError(error)) {
      console.log(`syntax: code=${error.code} sqlstate=${error.sqlstate}`);
      console.log(`cause preserved: ${error.cause instanceof Error}`);
    }
  }

  // 3. The indeterminate rule: never retry blindly.
  try {
    await db.sql`update users set email = ${"new@example.com"} where id = ${999999}`;
  } catch (error) {
    if (isDbError(error) && error.indeterminate) {
      // A transport-level failure around a write: the update MAY have
      // committed. dbSDK will not retry it, and neither should you, unless
      // the write is idempotent.
      console.log("write outcome unknown: check the server before retrying");
    }
  }

  // 4. Capability refusals happen before dispatch (nothing is sent).
  if (!db.capabilities.interactiveTransactions) {
    try {
      await db.transaction(async () => {});
    } catch (error) {
      if (isDbError(error) && error.code === "CAPABILITY") {
        console.log(`capability: ${error.capability} is not available on ${adapterId}`);
      }
    }
  } else {
    console.log(`capability: interactiveTransactions available on ${adapterId}`);
  }
} finally {
  await db.close();
}
