/**
 * 05 - Express server: one process-wide client, disposed on shutdown
 *
 *   DBSDK_ADAPTER=postgres DBSDK_URL=postgres://... npm run server
 *
 * In a long-running server, create the client once at startup and let the
 * pool amortize connections across requests. Dispose on SIGTERM so the
 * process exits cleanly.
 */

import express from "express";
import { isDbError } from "dbsdk";
import { makeDb, ensureSchema } from "./lib/setup.js";

const { db } = makeDb();
await ensureSchema(db);

const app = express();
app.use(express.json());

app.get("/users", async (_req, res) => {
  const { rows } = await db.sql`select id, email from users order by id limit 50`;
  res.json(rows);
});

app.post("/users", async (req, res) => {
  const email = req.body?.email;
  if (typeof email !== "string") {
    res.status(400).json({ error: "email is required" });
    return;
  }

  try {
    // Parameterized by construction: even unvalidated input is bound, not spliced.
    const { rows } = await db.sql`
      insert into users (email) values (${email})
      on conflict (email) do update set email = excluded.email
      returning id, email
    `;
    res.status(201).json(rows);
  } catch (error) {
    if (isDbError(error) && error.code === "CONSTRAINT") {
      res.status(409).json({ error: "email conflict", sqlstate: error.sqlstate });
      return;
    }
    if (isDbError(error) && error.indeterminate) {
      // The insert may or may not have committed. Do not auto-retry.
      res.status(503).json({ error: "write outcome unknown, check the database" });
      return;
    }
    res.status(500).json({ error: "query failed" });
  }
});

const server = app.listen(3000, () => {
  console.log("listening on http://localhost:3000");
});

process.on("SIGTERM", () => {
  server.close(() => {
    db.close().then(() => process.exit(0));
  });
});
