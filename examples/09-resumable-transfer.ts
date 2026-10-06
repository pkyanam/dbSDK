/**
 * 09 - Resumable provider-to-provider transfer (dbsdk/sync)
 *
 *   npm run sync          # fully offline: two fixture clients, no database
 *   npm run sync:local    # two clients against a local PostgreSQL (dbsdk-pg-test, port 15432)
 *
 * One-way, resumable, keyset-paginated transfer from a source database to a
 * target database through two INDEPENDENT clients — the same shape a real
 * Supabase-to-Neon copy takes, shown here with providers you can actually run.
 *
 * What this proves, in both modes:
 * - initial copy and incremental rerun are the same primitive (checkpoint cursor);
 * - a failed run stops with `status: "failed"`, the ORIGINAL error, and the
 *   last COMMITTED cursor preserved — nothing auto-retries;
 * - rerunning from the checkpoint converges: the target is an upsert, so a
 *   batch that may already have landed (crash after commit, before checkpoint)
 *   is re-applied harmlessly. Idempotent data, NOT exactly-once delivery.
 *
 * What this does NOT prove (and dbsdk/sync does not claim):
 * - deletes at the source are not propagated;
 * - rows updated in place are only picked up when the `orderBy` columns change
 *   (a finite-polling `updated_at` high-water cursor can miss late-committing
 *   or backdated updates; it is a watermark, not CDC);
 * - no bidirectional sync, no cross-provider atomicity.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDatabase, isDbError, type Database } from "dbsdk";
import { postgres } from "dbsdk/postgres";
import {
  createMemoryCheckpointStore,
  createSqlSource,
  createSqlTarget,
  isSyncError,
  runTransfer,
  SyncError,
  type CheckpointStore,
  type TransferResult,
} from "dbsdk/sync";
import { createFixtureDatabase } from "dbsdk/testing";

type EventRow = { id: number; value: string; updated_at: string };

/**
 * A DURABLE checkpoint store the caller owns. `runTransfer` only sees the
 * two-method CheckpointStore interface, so progress can live in a file,
 * a table, or Redis — anywhere that survives a restart. The default store is
 * in-memory and NON-durable: fine for tests, wrong for production resumability.
 */
function fileCheckpointStore(file: string): CheckpointStore {
  return {
    async get(key) {
      try {
        const map = JSON.parse(await readFile(file, "utf8")) as Record<string, string>;
        return map[key] ?? null;
      } catch {
        return null; // no file yet = no checkpoint (safe: the copy starts over)
      }
    },
    async set(key, value) {
      let map: Record<string, string> = {};
      try {
        map = JSON.parse(await readFile(file, "utf8")) as Record<string, string>;
      } catch {
        // start a fresh map
      }
      map[key] = value;
      await writeFile(file, JSON.stringify(map, null, 2));
    },
  };
}

function report(title: string, result: TransferResult): void {
  console.log(`${title}: status=${result.status} exhausted=${result.exhausted}`, {
    batches: result.batches,
    rowsRead: result.rowsRead,
    rowsWritten: result.rowsWritten,
    rowsSkipped: result.rowsSkipped,
    lastCursor: result.lastCursor,
  });
}

// ---------------------------------------------------------------------------
// Mode 1: OFFLINE — two fixture clients. The source "database" is scripted to
// answer real keyset queries (matched by statement shape AND bound params), so
// the exact pagination the SQL source builds is what gets exercised. The
// target "database" fails batch 2 the first time it sees it (connection reset),
// like a real network drop.
// ---------------------------------------------------------------------------

const T = (second: number) => `2026-10-01T00:00:${String(second).padStart(2, "0")}.000Z`;
// PostgreSQL renders a timestamptz as exact text (microsecond-capable); the
// sync source projects every orderBy column as `col::text` under an internal
// `__dbsdk_cursor_N` alias and encodes the cursor from that exact rendering.
// Since R5 the same applies to the copied PAYLOAD: every column whose native
// driver transport is lossy or ambiguous (date/time family, intervals,
// json/jsonb, arrays of those, and numeric-family arrays — the driver parses
// numeric ARRAY elements as binary doubles) is delivered as its exact text
// rendering, so microseconds, JSON arrays, JSON null and full numeric digits
// survive the copy verbatim. Since R7, every read projects an explicit
// table-qualified column list frozen from the first read's metadata snapshot
// (never `SELECT *`) and re-validates that snapshot against the catalog, so
// schema drift after the first read fails loudly before anything is written.
const TS = (second: number) => `2026-10-01 00:00:${String(second).padStart(2, "0")}+00`;
const row = (id: number, value: string): EventRow => ({ id, value, updated_at: T(id) });

// One page worth of fixture rows, each carrying the internal cursor aliases
// the SQL source projects and strips. Fresh objects per fixture: the source
// deletes the alias keys from the rows it returns.
const page = (rows: EventRow[]): Record<string, unknown>[] =>
  rows.map((r) => ({
    ...r,
    __dbsdk_cursor_0: TS(r.id),
    __dbsdk_cursor_1: String(r.id),
  }));

function offlineDemo(): void {
  const events: EventRow[] = [row(1, "alpha"), row(2, "beta"), row(3, "gamma"), row(4, "delta"), row(5, "epsilon"), row(6, "zeta"), row(7, "eta")];

  // The default `uniqueOrder: "verify"` runs two read-only catalog preflight
  // queries on the source's first read: a valid unique index whose key columns
  // are a subset of the orderBy columns, and a column-metadata query (names,
  // NOT NULL, and domain/element-resolved types) that drives the exact-payload
  // projection and refuses real columns colliding with the internal
  // `__dbsdk_cursor_*` aliases. Later reads re-validate that cached schema
  // snapshot with the same column-metadata query (one extra read-only query
  // per page) and refuse added/removed/retyped columns loudly. The fixture
  // database answers both, so the offline demo exercises the real preflight
  // and drift paths a real PostgreSQL takes.
  const preflightFixtures = [
    { match: /\bfrom\s+pg_index\b/, repeat: true, rows: [{ ok: 1 }] },
    {
      match: /\bfrom\s+pg_attribute\b/,
      repeat: true,
      rows: [
        // Same shape the real catalog query returns: name, NOT NULL, resolved
        // base type category/name (and element type for arrays).
        { attname: "updated_at", attnotnull: true, basecategory: "D", basetypname: "timestamptz", elemcategory: null, elemtypname: null },
        { attname: "id", attnotnull: true, basecategory: "N", basetypname: "int4", elemcategory: null, elemtypname: null },
        { attname: "value", attnotnull: true, basecategory: "S", basetypname: "text", elemcategory: null, elemtypname: null },
      ],
    },
  ];

  // Keyset pages the source will read (batchSize 3), in the exact order the
  // two runs issue them. Each fixture is single-use with its own row copies:
  // a resumed run legitimately re-reads the page after the committed cursor.
  // Cursor params are the exact text values the previous page encoded.
  const readFixture = {
    match: /^select [\s\S]*from "public"\."events"/,
    params: undefined as readonly unknown[] | undefined,
  };
  const source = createFixtureDatabase({
    id: "offline-source",
    fixtures: [
      ...preflightFixtures,
      { ...readFixture, params: [3], rows: page(events.slice(0, 3)) }, // run 1: first page
      { ...readFixture, params: [TS(3), "3", 3], rows: page(events.slice(3, 6)) }, // run 1: after cursor
      { ...readFixture, params: [TS(3), "3", 3], rows: page(events.slice(3, 6)) }, // run 2: re-read after resume
      { ...readFixture, params: [TS(6), "6", 3], rows: page(events.slice(6, 7)) }, // run 2: after cursor
      { ...readFixture, params: [TS(7), "7", 3], rows: [] }, // run 2: exhausted
    ],
  });

  // The target: every upsert lands (repeat), but batch 2 fails ONCE with a
  // connection-level error, mid-run — the crash-after-write scenario.
  const target = createFixtureDatabase({
    id: "offline-target",
    fixtures: [
      {
        match: /^insert into "public"\."events"/,
        params: [4, "delta", T(4), 5, "epsilon", T(5), 6, "zeta", T(6)],
        // Thrown as-is; the core client normalizes it into a DbError.
        error: { code: "08006", message: "connection reset by peer" },
      },
      { match: /^insert into "public"\."events"/, repeat: true },
    ],
  });

  // Real upsert state the target "database" holds. Recorded inserts are
  // applied by id; a replayed batch overwrites the same keys and converges.
  // Derived lazily (after each run) from the fixture's recorded queries.
  const targetRows = (): Map<number, EventRow> => {
    const rows = new Map<number, EventRow>();
    for (const q of target.raw.queries) {
      if (!/^insert into/.test(q.text)) continue;
      for (let i = 0; i < q.params.length; i += 3) {
        const id = q.params[i] as number;
        rows.set(id, { id, value: q.params[i + 1] as string, updated_at: q.params[i + 2] as string });
      }
    }
    return rows;
  };

  mainOffline(source as unknown as Database, target as unknown as Database, targetRows);
}

async function mainOffline(
  sourceDb: Database,
  targetDb: Database,
  targetRows: () => Map<number, EventRow>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "dbsdk-sync-example-"));
  const checkpoints = path.join(dir, "checkpoints.json");

  // Explicit, stable, secret-free identities are REQUIRED (R3): they name the
  // checkpoint and must distinguish endpoints. dbSDK never derives them from
  // connection strings — two different database pairs with the same adapter and
  // table name used to collide silently (review finding R2-1).
  const source = createSqlSource({
    db: sourceDb,
    table: ["public", "events"],
    orderBy: ["updated_at", "id"],
    identity: "offline-demo:source.public.events",
  });
  const target = createSqlTarget({
    db: targetDb,
    table: ["public", "events"],
    key: ["id"],
    identity: "offline-demo:target.public.events",
  });

  // The guardrail: a target that is not an upsert is refused before dispatch.
  try {
    await runTransfer(source, { identity: "non-idempotent", writeMode: "replace", write: async () => ({ written: 0 }) });
  } catch (error) {
    if (isSyncError(error)) console.log("non-idempotent target refused:", error.code); // CONFIGURATION
  }

  // Run 1: initial copy. Batch 1 lands, batch 2's write fails. The run ends
  // with the original error and the checkpoint still at batch 1's cursor.
  const run1 = await runTransfer(source, target, {
    batchSize: 3,
    checkpointStore: fileCheckpointStore(checkpoints),
  });
  report("run 1 (fails mid-batch)", run1);
  if (run1.status !== "failed" || !isDbError(run1.error)) {
    throw new Error(`expected a failed run with the original DbError, got ${run1.status}`);
  }
  console.log("  run 1 error:", run1.error.code, run1.error.message);
  // The simulated target state includes batch 2's upsert because a 08006
  // connection reset leaves the write's outcome UNKNOWN (it may have landed).
  // Rerunning is safe either way: the same keys overwrite with the same values.
  console.log("  rows the target may hold after run 1:", [...targetRows().keys()].sort().join(", "));

  // Run 2: rerun from the SAME checkpoint file. Batch 2 is re-read and
  // re-applied as an upsert — even if it had landed before the crash, the
  // same keys overwrite with the same values. Then the remaining rows flow,
  // and the source is exhausted.
  const run2 = await runTransfer(source, target, {
    batchSize: 3,
    checkpointStore: fileCheckpointStore(checkpoints),
  });
  report("run 2 (resume)", run2);
  if (run2.status !== "completed" || !run2.exhausted) {
    throw new Error(`expected a completed, exhausted resume, got ${run2.status}`);
  }
  console.log("  final rows on target:", [...targetRows().keys()].sort((a, b) => a - b).join(", "));
  if (targetRows().size !== 7) throw new Error(`expected 7 distinct rows, got ${targetRows().size}`);
  console.log("  checkpoint file:", await readFile(checkpoints, "utf8").then((t) => t.trim()));

  await sourceDb.close();
  await targetDb.close();
  await rm(dir, { recursive: true, force: true });
  console.log("offline demo done — no database, no credentials, no network.\n");
}

// ---------------------------------------------------------------------------
// Mode 2: LOCAL PG 17 (DBSDK_SYNC_URL, e.g. the dbsdk-pg-test container on
// port 15432). Two INDEPENDENT clients and two schemas play "provider A" and
// "provider B" — the same shape as two real hosted providers.
// ---------------------------------------------------------------------------

const SRC_SCHEMA = "sync_demo_source";
const DST_SCHEMA = "sync_demo_target";

async function localDemo(url: string): Promise<void> {
  const src = createDatabase({ adapter: postgres({ connectionString: url, ssl: false }) });
  const dst = createDatabase({ adapter: postgres({ connectionString: url, ssl: false }) });

  try {
    await src.query({ text: `drop schema if exists ${SRC_SCHEMA} cascade` });
    await src.query({ text: `create schema ${SRC_SCHEMA}` });
    await src.query({
      text: `create table ${SRC_SCHEMA}.events (id integer primary key, value text not null, updated_at timestamptz not null unique)`,
    });
    await dst.query({ text: `drop schema if exists ${DST_SCHEMA} cascade` });
    await dst.query({ text: `create schema ${DST_SCHEMA}` });
    await dst.query({
      text: `create table ${DST_SCHEMA}.events (id integer primary key, value text not null, updated_at timestamptz not null unique)`,
    });

    // Six seeded rows with distinct, deterministic timestamps (the caller
    // guarantees the NOT NULL, unique, total-ordered cursor columns).
    const values: unknown[] = [];
    const rows = [1, 2, 3, 4, 5, 6].map((id) => {
      values.push(id, `seed-${id}`, new Date(Date.UTC(2026, 9, 1, 0, 0, id)));
      return `($${values.length - 2}, $${values.length - 1}, $${values.length})`;
    });
    await src.query({ text: `insert into ${SRC_SCHEMA}.events (id, value, updated_at) values ${rows.join(", ")}`, params: values });

    const dir = await mkdtemp(path.join(tmpdir(), "dbsdk-sync-example-"));
    const checkpoints = path.join(dir, "checkpoints.json");
    const store = fileCheckpointStore(checkpoints);

    // Explicit identities (R3): stable across runs, distinct between the two
    // endpoints, never derived from the connection string.
    const source = createSqlSource({
      db: src,
      table: [SRC_SCHEMA, "events"],
      orderBy: ["updated_at", "id"],
      identity: "local-pg:sync_demo_source.events",
    });
    const target = createSqlTarget({
      db: dst,
      table: [DST_SCHEMA, "events"],
      key: ["id"],
      identity: "local-pg:sync_demo_target.events",
    });

    // Run 1: the initial copy — same primitive as every later run.
    const run1 = await runTransfer(source, target, { batchSize: 2, checkpointStore: store });
    report("run 1 (initial copy)", run1);
    const count1 = await dst.query({ text: `select count(*)::int as n from ${DST_SCHEMA}.events` });
    console.log("  rows on target:", count1.rows[0] && (count1.rows[0] as { n: number }).n);

    // Change phase on the source only: two inserts and one in-place update.
    await src.query({
      text: `insert into ${SRC_SCHEMA}.events (id, value, updated_at) values ($1, $2, $3), ($4, $5, $6)`,
      params: [7, "new-7", new Date(Date.UTC(2026, 9, 1, 0, 0, 10)), 8, "new-8", new Date(Date.UTC(2026, 9, 1, 0, 0, 11))],
    });
    await src.query({
      text: `update ${SRC_SCHEMA}.events set value = $1, updated_at = $2 where id = 3`,
      params: ["seed-3-revised", new Date(Date.UTC(2026, 9, 1, 0, 0, 12))],
    });

    // Run 2: incremental rerun from the durable checkpoint — only the rows
    // whose cursor columns changed move (2 new + 1 updated).
    const run2 = await runTransfer(source, target, { batchSize: 2, checkpointStore: store });
    report("run 2 (incremental rerun)", run2);
    if (run2.rowsRead !== 3) throw new Error(`expected exactly 3 changed rows, got ${run2.rowsRead}`);
    const count2 = await dst.query({ text: `select count(*)::int as n from ${DST_SCHEMA}.events` });
    console.log("  rows on target:", count2.rows[0] && (count2.rows[0] as { n: number }).n);

    // Run 3: idle rerun — the high-water cursor has not moved, 0 rows read.
    const run3 = await runTransfer(source, target, { batchSize: 2, checkpointStore: store });
    report("run 3 (idle rerun)", run3);
    if (run3.rowsRead !== 0) throw new Error(`expected an idle rerun, got ${run3.rowsRead}`);

    await rm(dir, { recursive: true, force: true });
  } finally {
    await src.query({ text: `drop schema if exists ${SRC_SCHEMA} cascade` }).catch(() => {});
    await dst.query({ text: `drop schema if exists ${DST_SCHEMA} cascade` }).catch(() => {});
    await src.close();
    await dst.close();
  }
  console.log("local demo done — two independent clients, one local PostgreSQL.\n");
}

// ---------------------------------------------------------------------------

const url = process.env.DBSDK_SYNC_URL;
if (url) {
  await localDemo(url);
} else {
  offlineDemo();
}

// Keep the memory store import honest: it is the default (non-durable) store,
// shown here so its role is explicit rather than incidental.
void createMemoryCheckpointStore;
