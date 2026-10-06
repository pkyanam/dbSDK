/**
 * 10 - Drizzle ORM interoperability (dbsdk/drizzle)
 *
 *   npm run drizzle         # offline part: refusals + Neon HTTP over a mock transport
 *   npm run drizzle:local   # real part: schema, queries, joins, transactions on local
 *                           # PostgreSQL (dbsdk-pg-test, port 15432) — needs the server
 *
 * The bridge hands Drizzle's stable node-postgres / neon-http drivers a
 * validated, dbSDK-OWNED driver handle. You keep the lifecycle: `db.close()`
 * ends the pool, and a previously returned Drizzle instance fails afterwards —
 * no pool is ever recreated. Drizzle executions surface native Drizzle/driver
 * errors, NOT dbSDK-normalized DbError; only the bridge's pre-execution
 * validation uses dbSDK error conventions.
 *
 * Refused before any pool creation or dispatch:
 * - a sessionState:false transaction pooler (e.g. Supabase transaction mode) —
 *   dbSDK's session-state guards live outside the pool, so Drizzle execution
 *   would bypass them; use direct or session mode instead;
 * - any DSN / `connection` / `client` config that would let Drizzle build its
 *   own pool and bypass dbSDK's TLS posture (compile-time AND runtime).
 *
 * NOT shown here (next workflow unit): migrations and seeding. The seam is
 * management.connection() -> connection string -> drizzle-kit generate/push
 * (dev-time CLI) -> drizzle-orm migrate() applied over this same bridge.
 *
 * Setup note: this example imports drizzle-orm through the workspace's
 * single physical copy ("file:../packages/dbsdk/node_modules/drizzle-orm"
 * in examples/package.json). Run the documented order first — root
 * `pnpm install` + `pnpm --filter dbsdk build`, then `npm install` here —
 * or that path does not resolve. The examples README explains why one
 * shared instance is required.
 */

import { eq } from "drizzle-orm";
import { integer, pgTable, pgSchema, serial, text } from "drizzle-orm/pg-core";

import { createDatabase, DbError } from "dbsdk";
import { postgres } from "dbsdk/postgres";
import { supabase } from "dbsdk/supabase";
import { drizzleNeonHttp, drizzlePostgres } from "dbsdk/drizzle";

// A dedicated schema keeps the example's fixtures isolated and easy to drop.
const app = pgSchema("dbsdk_drizzle_example");
const users = app.table("drizzle_users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  age: integer("age"),
});

const LOCAL_URL =
  process.env.DBSDK_DRIZZLE_URL ?? "postgresql://postgres:dbsdk@localhost:15432/dbsdk";

// ---------------------------------------------------------------------------
// Part 1 — the real thing: typed schema queries over a dbSDK-owned pool
// ---------------------------------------------------------------------------

async function realPart(): Promise<void> {
  const db = createDatabase({
    adapter: postgres({ connectionString: LOCAL_URL, max: 3 }),
  });

  // Schema setup with dbSDK's own parameterized SQL; queries with Drizzle.
  // (The migration workflow — drizzle-kit generate/push, then migrate() — is
  // the next unit; this example creates its tables directly.)
  await db.query({ text: "drop schema if exists dbsdk_drizzle_example cascade" });
  await db.query({ text: "create schema dbsdk_drizzle_example" });
  await db.query({
    text:
      "create table dbsdk_drizzle_example.drizzle_users " +
      "(id serial primary key, email text not null unique, age integer)",
  });

  // The factory hands Drizzle the live pool. Every query below runs through
  // the SAME pool dbSDK owns — one connection surface, one lifecycle.
  const drizzleDb = await drizzlePostgres(db, { schema: { users } });

  const inserted = await drizzleDb
    .insert(users)
    .values({ email: "ada@example.com", age: 36 })
    .returning({ id: users.id });
  console.log("insert:", inserted);

  const rows = await drizzleDb.select().from(users).where(eq(users.email, "ada@example.com"));
  console.log("select:", rows); // typed: { id: number; email: string; age: number | null }[]

  await drizzleDb.update(users).set({ age: 37 }).where(eq(users.email, "ada@example.com"));
  console.log("updated age:", (await drizzleDb.select({ age: users.age }).from(users))[0]?.age);

  // A real interactive transaction on one leased connection: commit ...
  await drizzleDb.transaction(async (tx) => {
    await tx.insert(users).values({ email: "grace@example.com", age: 45 });
  });
  // ... and rollback when the callback throws.
  try {
    await drizzleDb.transaction(async (tx) => {
      await tx.insert(users).values({ email: "rolledback@example.com" });
      throw new Error("intentional rollback");
    });
  } catch (error) {
    console.log("rolled back:", (error as Error).message);
  }

  // Lifetime stays with the caller. Clean up the fixtures, then close: it
  // ends the pool, and using the Drizzle instance afterwards fails — the pool
  // is never recreated.
  await db.query({ text: "drop schema if exists dbsdk_drizzle_example cascade" });
  await db.close();
  try {
    await drizzleDb.select().from(users);
  } catch (error) {
    console.log("after close:", (error as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Part 2 — the refusals: guarded poolers and native-construction bypasses
// ---------------------------------------------------------------------------

async function refusalPart(): Promise<void> {
  // A transaction-mode pooler is refused BEFORE the pool is created.
  const txDb = createDatabase({
    adapter: supabase({
      connectionString: LOCAL_URL,
      connectionMode: "transaction",
      allowModeMismatch: true, // the local server does not run on Supabase's ports
    }),
  });
  try {
    await drizzlePostgres(txDb);
  } catch (error) {
    if (error instanceof DbError && error.code === "CONFIGURATION") {
      console.log("refused transaction pooler:", error.message.split(".")[0]);
    }
  }
  await txDb.close();

  // A DSN would let Drizzle construct its own pool, bypassing dbSDK's TLS
  // posture and lifetime ownership — rejected at compile time and at runtime.
  const db = createDatabase({ adapter: postgres({ connectionString: LOCAL_URL }) });
  try {
    await drizzlePostgres(db, { connection: "postgres://u:p@h/db" } as never);
  } catch (error) {
    if (error instanceof DbError) {
      console.log("refused DSN config:", error.message.split(".")[0]);
    }
  }
  await db.close();
}

// ---------------------------------------------------------------------------
// Part 3 — Neon HTTP over the actual raw.sql handle (offline here)
// ---------------------------------------------------------------------------

async function neonHttpPart(): Promise<void> {
  // This part needs a real Neon connection string; offline it only reports.
  const url = process.env.DBSDK_NEON_URL;
  if (!url) {
    console.log("neon http part: set DBSDK_NEON_URL to run against a real endpoint");
    return;
  }
  const { neon } = await import("dbsdk/neon");
  const db = createDatabase({ adapter: neon({ connectionString: url }) });
  const drizzleDb = await drizzleNeonHttp(db, { schema: { users } });
  const rows = await drizzleDb.select().from(users);
  console.log("neon http select:", rows);
  // No interactive transactions over HTTP — the driver refuses them.
  await db.close();
}

try {
  // Refusals need no database: they fail before any pool creation.
  await refusalPart();
  if (process.env.DBSDK_DRIZZLE_OFFLINE) {
    await neonHttpPart();
  } else {
    await realPart();
  }
} catch (error) {
  console.error("example failed:", error);
  process.exitCode = 1;
}
