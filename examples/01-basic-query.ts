/**
 * 01 - Basic query
 *
 * The same program runs on every adapter; only the environment changes.
 *
 *   npm run fixture                                     # no database needed
 *   DBSDK_ADAPTER=postgres DBSDK_URL=postgres://... npm run basic
 *   DBSDK_ADAPTER=supabase DBSDK_URL=postgres://... DBSDK_MODE=session npm run basic
 *   DBSDK_ADAPTER=neon_http DBSDK_URL=postgres://... npm run basic
 */

import type { QueryResult } from "dbsdk";
import { makeDb, ensureSchema } from "./lib/setup.js";

const { db, adapterId } = makeDb();

try {
  console.log(`adapter: ${adapterId} | capabilities:`, db.capabilities);

  await ensureSchema(db);

  // Interpolated values become positional bind parameters ($1, $2, ...).
  // They can never become identifiers or SQL fragments.
  const email = "ada@example.com";
  await db.sql`insert into users (email) values (${email}) on conflict (email) do nothing`;

  // Annotate the result to type the rows (multi-property generics inside
  // db.sql<...> angle brackets are a TypeScript syntax error).
  const result: QueryResult<{ id: number; email: string }> = await db.sql`
    select id, email from users where email = ${email}
  `;

  console.log({ command: result.command, rowCount: result.rowCount, rows: result.rows });
} finally {
  await db.close();
}
