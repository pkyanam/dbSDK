/**
 * 07 - Neon management flow, offline (real adapter, injected fetch)
 *
 *   npm run management:neon
 *
 * What this proves and what it does not:
 * - It runs the REAL `neonManagement` adapter (`dbsdk/management/neon`)
 *   end to end: create project -> wait for all provider operations ->
 *   read the returned secrets -> retrieve an official connection URI ->
 *   construct the query client. The injected `fetch` answers with
 *   response shapes recorded from the official Neon API v2 spec (the same
 *   shapes the package's own tests assert against).
 * - It does NOT call the network and does NOT prove that the live Neon
 *   service behaves this way; adapter behavior is additionally covered by
 *   recorded-HTTP tests, and the evidence level in the docs is `docs`.
 * - No query is executed: the query client is constructed, which needs no
 *   connection; running a query requires a live project and credentials.
 *
 * To run against the real API, swap `fetch` for the global and export
 * NEON_API_KEY - and expect a real project to be created on your account.
 */

import { createDatabase } from "dbsdk";
import { createManagement, isManagementError, type FetchLike } from "dbsdk/management";
import { neon } from "dbsdk/neon";
import { neonManagement } from "dbsdk/management/neon";

// ---- recorded-shape fetch (offline) ---------------------------------------

const NOW = "2026-10-06T00:00:00Z";
const PASSWORD = "offline-example-password"; // fixture value; never a real secret
const URI = `postgresql://app_owner:${PASSWORD}@ep-cool-123.aws.neon.tech/neondb?sslmode=require`;

const operations = [
  { id: "op-create-timeline", project_id: "p1", action: "create_timeline", status: "finished", failures_count: 0, created_at: NOW, updated_at: NOW },
  { id: "op-start-compute", project_id: "p1", action: "start_compute", status: "finished", failures_count: 0, created_at: NOW, updated_at: NOW },
];

const fetchImpl: FetchLike = async (input, init) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/api\/v2/, "");
  const method = init?.method ?? "GET";
  let body: unknown = null;
  if (path === "/projects" && method === "POST") {
    body = {
      project: { id: "p1", name: "my-app", region_id: "aws-us-east-1", org_id: "org1", pg_version: 17, created_at: NOW, updated_at: NOW },
      connection_uris: [
        {
          connection_uri: URI,
          connection_parameters: { database: "neondb", password: PASSWORD, role: "app_owner", host: "ep-cool-123.aws.neon.tech", pooler_host: "ep-cool-123-pooler.aws.neon.tech" },
        },
      ],
      operations,
      branch: { id: "b1", project_id: "p1", name: "main", current_state: "ready", created_at: NOW, updated_at: NOW },
    };
  } else if (path.startsWith("/projects/p1/operations/")) {
    const id = path.split("/").pop();
    body = { operation: operations.find((op) => op.id === id) ?? operations[0] };
  } else if (path === "/projects/p1" && method === "GET") {
    body = { project: { id: "p1", name: "my-app", region_id: "aws-us-east-1", org_id: "org1", pg_version: 17, created_at: NOW, updated_at: NOW } };
  } else if (path === "/projects/p1/connection_uri") {
    body = { uri: URI };
  } else {
    body = {};
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

// ---- the actual flow -------------------------------------------------------

const management = createManagement({
  adapter: neonManagement({ apiKey: "nk_offline_example_key", fetch: fetchImpl }),
});

// 1. Create the project. Neon provisions the default branch "main",
//    database "neondb", role "<name>_owner", and a read-write compute.
const result = await management.create({ kind: "project", name: "my-app" });
console.log("create ->", result.resource?.id, result.resource?.region);

// 2. Wait until ALL provider operations finished. GET requests only.
const project = await management.wait(result, { timeoutMs: 10_000, pollIntervalMs: 10 });
console.log("wait ->", project.id);

// 3. Credentials: Neon returned connection URIs and role passwords once.
//    They surface ONLY here (secrets); raw payloads are redacted.
const secret = result.secrets.find((s) => s.label === "connectionString");
console.log("secret label:", secret?.label, "(value handled like a password)");

// 4. An official connection URI on demand. Default output is redacted;
//    reveal: true is the explicit opt-in for the credential-bearing URI.
const redacted = await management.raw.connectionUri({
  projectId: project.id,
  databaseName: "neondb",
  roleName: "app_owner",
});
console.log("connectionUri (redacted):", redacted);

const usable = await management.raw.connectionUri({
  projectId: project.id,
  databaseName: "neondb",
  roleName: "app_owner",
  reveal: true,
});
console.log("connectionUri (revealed): usable for connecting; treat as a secret");

// 5. Bridge to the query client. Constructing needs no connection; the
//    first query would run against the (offline, fictional) endpoint.
const db = createDatabase({ adapter: neon({ connectionString: usable, transport: "http" }) });
console.log("query client constructed for provider:", db.capabilities.transport);
await db.close();

// 6. Error normalization, for completeness: an unsupported kind fails
//    before dispatch with a typed ManagementError.
try {
  await management.create({ kind: "organization", name: "nope" } as never);
} catch (error) {
  if (isManagementError(error)) {
    console.log("unsupported kind ->", error.code); // CONFIGURATION or CAPABILITY per core rules
  }
}
