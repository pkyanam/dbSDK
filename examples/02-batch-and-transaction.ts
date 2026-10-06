/**
 * 02 - Batches and transactions
 *
 * db.batch: atomic, no control flow (one round trip on Neon HTTP).
 * db.transaction: interactive, control flow allowed, needs a transport
 * that supports it (any TCP mode, or Neon with a transaction transport).
 *
 *   npm run fixture
 *   DBSDK_ADAPTER=postgres DBSDK_URL=postgres://... npm run transactions
 *   DBSDK_ADAPTER=supabase DBSDK_URL=... DBSDK_MODE=transaction npm run transactions
 *   DBSDK_ADAPTER=neon_ws  DBSDK_URL=... npm run transactions
 *
 * On neon_http, db.transaction() fails BEFORE dispatch with a CAPABILITY
 * error - that refusal is demonstrated below instead of being hidden.
 */

import { isDbError } from "dbsdk";
import { makeDb, ensureSchema } from "./lib/setup.js";

const { db, adapterId } = makeDb();

try {
  await ensureSchema(db);

  // Atomic batch: all statements commit together or none do.
  const batchResults = await db.batch([
    { text: "insert into users (email) values ($1) on conflict do nothing", params: ["grace@example.com"] },
    { text: "insert into users (email) values ($1) on conflict do nothing", params: ["alan@example.com"] },
  ]);
  console.log(`batch: ${batchResults.length} statements, rowCounts=${JSON.stringify(batchResults.map((r) => r.rowCount))}`);

  // Interactive transaction: multi-round-trip logic on one connection.
  if (db.capabilities.interactiveTransactions) {
    await db.transaction(async (tx) => {
      const { rowCount } = await tx.query(
        "update users set email = $1 where email = $2",
        ["grace.hopper@example.com", "grace@example.com"],
      );
      console.log(`transaction: updated ${rowCount} row(s), committing`);
    });

    // A thrown error rolls everything back and is rethrown.
    try {
      await db.transaction(async (tx) => {
        await tx.query("update users set email = $1 where id = $2", ["boom@example.com", 1]);
        throw new Error("deliberate abort");
      });
    } catch (error) {
      console.log(`transaction rolled back: ${(error as Error).message}`);
    }
  } else {
    // Expected on DBSDK_ADAPTER=neon_http: refused before dispatch.
    try {
      await db.transaction(async () => {});
    } catch (error) {
      if (isDbError(error)) {
        console.log(`transaction refused before dispatch: code=${error.code} capability=${error.capability}`);
      }
    }
  }
} finally {
  await db.close();
}
