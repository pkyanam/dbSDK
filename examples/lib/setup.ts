/**
 * Shared setup for the examples: pick an adapter from the environment and
 * create the client. No connection strings are committed to this repository.
 *
 * Adapter selection (default: fixture, which needs no database):
 *
 *   DBSDK_ADAPTER=postgres   DBSDK_URL=postgres://...        (any PostgreSQL endpoint)
 *   DBSDK_ADAPTER=supabase   DBSDK_URL=postgres://...        (Supabase dashboard connection string)
 *   DBSDK_ADAPTER=neon_http  DBSDK_URL=postgres://...        (Neon pooled or direct endpoint)
 *   DBSDK_ADAPTER=neon_ws    DBSDK_URL=postgres://...        (Neon endpoint over WebSocket)
 *   (unset)                  -> fixture adapter, no database required
 */

import { createDatabase, type Database } from "dbsdk";
import { postgres } from "dbsdk/postgres";
import { supabase } from "dbsdk/supabase";
import { neon } from "dbsdk/neon";
import { createFixtureDatabase } from "dbsdk/testing";

export type ExampleDb = { db: Database<unknown>; adapterId: string };

export function makeDb(): ExampleDb {
  const url = process.env.DBSDK_URL;
  const adapterId = process.env.DBSDK_ADAPTER ?? "fixture";

  if (adapterId !== "fixture" && !url) {
    console.error(`DBSDK_ADAPTER=${adapterId} requires DBSDK_URL to be set.`);
    process.exit(1);
  }

  switch (adapterId) {
    case "postgres": {
      const db = createDatabase({ adapter: postgres({ connectionString: url!, ssl: false }) });
      return { db, adapterId };
    }
    case "supabase": {
      const db = createDatabase({
        adapter: supabase({
          connectionString: url!,
          // Set DBSDK_MODE to direct | session | transaction (default session).
          connectionMode: (process.env.DBSDK_MODE as "direct" | "session" | "transaction") ?? "session",
          // Remote Supabase endpoints need their root CA supplied for verified TLS;
          // see docs/adapters/supabase. This example connects without a CA only if
          // you explicitly opt out via DBSDK_INSECURE_TLS=1.
          ssl: process.env.DBSDK_INSECURE_TLS === "1" ? { rejectUnauthorized: false } : undefined,
        }),
      });
      return { db, adapterId };
    }
    case "neon_http": {
      const db = createDatabase({ adapter: neon({ connectionString: url!, transport: "http" }) });
      return { db, adapterId };
    }
    case "neon_ws": {
      const db = createDatabase({ adapter: neon({ connectionString: url!, transport: "websocket" }) });
      return { db, adapterId };
    }
    default: {
      // Demo mode: a catch-all fixture makes unmatched statements return
      // empty results, so the examples run end-to-end without a database.
      // In real tests keep requireMatch at its default (true) so drift
      // fails loudly.
      const db = createFixtureDatabase({
        fixtures: [
          {
            match: "select id, email from users where email = $1",
            params: ["ada@example.com"],
            rows: [{ id: 1, email: "ada@example.com" }],
            rowCount: 1,
            command: "SELECT",
          },
          { match: /./, repeat: true },
        ],
      });
      return { db: db as Database<unknown>, adapterId: "fixture" };
    }
  }
}

/** A table for the examples to use; harmless if it already exists. */
export async function ensureSchema(db: Database<unknown>): Promise<void> {
  await db.sql`
    create table if not exists users (
      id integer primary key generated always as identity,
      email text not null unique,
      created_at timestamptz not null default now()
    )
  `;
}
