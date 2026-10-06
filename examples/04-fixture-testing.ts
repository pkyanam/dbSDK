/**
 * 04 - Testing with the fixture adapter (no database, no credentials)
 *
 *   npm run fixture
 *
 * The fixture adapter is a scripted adapter for unit tests. It is not an
 * in-memory SQL engine: it proves what your code sends and how it handles
 * results and errors, not whether PostgreSQL would execute the SQL.
 */

import { createDatabase, isDbError, type QueryResult } from "dbsdk";
import { createFixtureAdapter } from "dbsdk/testing";

const adapter = createFixtureAdapter({
  fixtures: [
    {
      match: "select id, email from users where id = $1",
      params: [42],
      rows: [{ id: 42, email: "ada@example.com" }],
      rowCount: 1,
      command: "SELECT",
    },
    {
      match: "update users set email = $1 where id = $2",
      // Thrown as-is; the client normalizes it into a DbError.
      error: { code: "42501", message: "permission denied for table users" },
    },
  ],
});
const db = createDatabase({ adapter });

// A query matching a fixture returns the scripted envelope.
const found: QueryResult<{ id: number; email: string }> =
  await db.sql`select id, email from users where id = ${42}`;
console.log("fixture result:", found.rows);

// An unmatched query fails loudly (requireMatch defaults to true).
try {
  await db.sql`select 1`;
} catch (error) {
  if (isDbError(error)) console.log("unmatched query:", error.code); // UNKNOWN
}

// Errors normalize like real ones.
try {
  await db.query({ text: "update users set email = $1 where id = $2", params: ["x@example.com", 42] });
} catch (error) {
  if (isDbError(error)) console.log("normalized:", error.code, error.sqlstate); // PERMISSION 42501
}

// Assert what your code actually sent.
console.log(
  "recorded queries:",
  adapter.raw.queries.map((q) => ({ text: q.text, params: q.params, inTransaction: q.inTransaction })),
);

await db.close();
