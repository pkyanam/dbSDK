/**
 * 08 - Supabase management flow, offline (real adapter, injected fetch)
 *
 *   npm run management:supabase
 *
 * What this proves and what it does not:
 * - It runs the REAL `supabaseManagement` adapter
 *   (`dbsdk/management/supabase`) end to end: list organizations ->
 *   create project -> wait for readiness (resource status polling) ->
 *   read the generated password from `secrets` -> retrieve the official
 *   database host -> assemble the documented direct connection string ->
 *   construct the query client. The injected `fetch` answers with
 *   response shapes recorded from the official Supabase Management API v1
 *   spec (the same shapes the package's own tests assert against).
 * - It does NOT call the network and does NOT prove that the live
 *   Supabase service behaves this way; adapter behavior is additionally
 *   covered by recorded-HTTP tests, and the evidence level in the docs is
 *   `docs`.
 * - No query is executed and no connection is made; the query client is
 *   only constructed. Running a query requires a live project.
 *
 * To run against the real API, swap `fetch` for the global and provide a
 * real personal access token (sbp_...) - and expect a real project to be
 * created on your organization. The token is never a database credential.
 */

import { createDatabase } from "dbsdk";
import { createManagement, isManagementError, type FetchLike } from "dbsdk/management";
import { postgres } from "dbsdk/postgres";
import { supabaseManagement } from "dbsdk/management/supabase";

// ---- recorded-shape fetch (offline) ---------------------------------------

const NOW = "2026-10-06T00:00:00Z";
const REF = "abcdefghijklmnopqrst";
const HOST = `db.${REF}.supabase.co`;

const projectPayload = (status: string) => ({
  id: REF,
  ref: REF,
  organization_id: "org-1",
  organization_slug: "acme",
  name: "acme-prod",
  region: "us-east-1",
  created_at: NOW,
  status,
  database: { host: HOST, version: "17", postgres_engine: "17", release_channel: "ga" },
});

const fetchImpl: FetchLike = async (input, init) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = (init?.method ?? "GET").toUpperCase();
  let body: unknown = null;
  let status = 200;
  if (path === "/organizations") {
    body = [{ id: "org-1", slug: "acme", name: "Acme" }];
  } else if (path === "/projects" && method === "POST") {
    status = 201;
    body = projectPayload("COMING_UP");
  } else if (path === `/projects/${REF}`) {
    // wait() polls this GET until the resource is active; the fixture
    // answers ACTIVE_HEALTHY immediately.
    body = projectPayload("ACTIVE_HEALTHY");
  } else {
    body = {};
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
};

// ---- the actual flow -------------------------------------------------------

const management = createManagement({
  adapter: supabaseManagement({ accessToken: "sbp_offline_example_token", fetch: fetchImpl }),
});

// 1. The create-project prerequisite: an organization scope. Discover it
//    from the official organizations endpoint if you only know the name.
const organizations = await management.raw.listOrganizations();
const organizationId = organizations[0]!.id;
console.log("organizations ->", organizations.map((o) => o.slug));

// 2. Create the project. Do NOT pass `plan`: the current endpoint refuses
//    it (plans are chosen at the organization level) and the adapter maps
//    a spec `region` to the official region_selection form.
const result = await management.create({
  kind: "project",
  name: "acme-prod",
  organizationId,
  region: "us-east-1",
});
console.log("create ->", result.resource?.id, result.resource?.status);

// 3. The database password: required by the API, never echoed. When
//    omitted, the adapter generated one and returns it exactly once here.
const password = result.secrets.find((s) => s.label === "password");
console.log("password secret present:", password !== undefined, "(treat like a secret)");

// 4. Wait for readiness. No operations endpoint on Supabase, so wait()
//    polls GET /projects/{ref} (GETs only) until the status is active.
const project = await management.wait(result, { timeoutMs: 10_000, pollIntervalMs: 10 });
console.log("wait ->", project.status);

// 5. The official host, from the provider (GET /projects/{ref}).
const host = await management.raw.databaseHost(project.id);
console.log("host ->", host);

// 6. Assemble Supabase's documented direct connection string from the two
//    official pieces. The PAT is never a database credential and the SDK
//    never fabricates this URL for you.
const connectionString = `postgresql://postgres:${password?.value ?? ""}@${host}:5432/postgres`;
const db = createDatabase({ adapter: postgres({ connectionString }) });
console.log("query client constructed; connection deferred until the first query");
await db.close();

// 7. Current-API guard, for completeness: including `plan` in the spec is
//    refused before dispatch with a CONFIGURATION error.
try {
  await management.create({
    kind: "project",
    name: "plan-refused",
    organizationId,
    plan: "free",
  });
} catch (error) {
  if (isManagementError(error)) {
    console.log("plan in spec ->", error.code); // CONFIGURATION
  }
}
