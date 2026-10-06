/**
 * 06 - Management core contract with the fixture (no provider, no network)
 *
 *   npm run management:fixture
 *
 * The management fixture (`dbsdk/management/testing`) is handler-based
 * scaffolding, not a provider simulator. It proves what the CORE client
 * does with the results, errors, and capabilities an adapter declares:
 * dispatch-time capability and scope checks, bounded waiting, secret
 * handling, and error normalization. It cannot prove what a real provider
 * API returns; that is the job of each adapter's recorded-HTTP tests.
 *
 * This example uses a fictional provider id ("test") on purpose: nothing
 * here makes claims about Supabase or Neon.
 */

import {
  createManagement,
  describeManagementCapabilities,
  isManagementError,
  type ManagementAdapter,
  type ManagementResource,
} from "dbsdk/management";
import { createManagementFixture } from "dbsdk/management/testing";

function resource(id: string, status: ManagementResource["status"]): ManagementResource {
  return {
    kind: "project",
    providerId: "test",
    id,
    name: "fixture-project",
    region: null,
    status,
    providerStatus: "ACTIVE",
    createdAt: "2026-10-06T00:00:00Z",
    updatedAt: null,
    raw: {},
  };
}

const { adapter, client } = createManagementFixture({
  id: "test",
  capabilities: {
    resourceKinds: ["project"],
    supported: { update: ["project"], delete: ["project"] },
    pagination: false,
    asyncOperations: false,
  },
  handlers: {
    create: async () => ({
      resource: resource("proj_1", "active"),
      operation: null,
      secrets: [{ label: "password", value: "fixture-password" }],
      indeterminate: false,
    }),
    get: async (ref) => resource(ref.id, "active"),
    update: async (spec) => ({
      resource: resource(spec.id, "active"),
      operation: null,
      secrets: [],
      indeterminate: false,
    }),
    delete: async () => ({ operation: null, indeterminate: false }),
  },
});

// 1. The happy path through one client.
const created = await client.create({ kind: "project", name: "fixture-project" });
console.log("create ->", created.resource?.id, "secrets:", created.secrets.length);

// wait() issues GET requests only; against this fixture the resource is
// already active, so it resolves on the first poll.
const ready = await client.wait(created, { timeoutMs: 5_000, pollIntervalMs: 10 });
console.log("wait ->", ready.status);

const fetched = await client.get({ kind: "project", id: "proj_1" });
console.log("get ->", fetched.name);

// 2. Capability enforcement happens BEFORE dispatch: this fixture declares
//    only the "project" kind, so a branch request fails without any call.
try {
  await client.create({ kind: "branch", projectId: "proj_1" });
} catch (error) {
  if (isManagementError(error)) {
    console.log("branch on a project-only adapter ->", error.code); // CAPABILITY
  }
}

// 3. Structured metadata: docs and capability grids render from this.
const descriptor = describeManagementCapabilities(adapter as ManagementAdapter);
console.log("declared kinds:", descriptor.resourceKinds);
console.log("operations:", JSON.stringify(descriptor.operations));
console.log("pagination:", descriptor.pagination, "asyncOperations:", descriptor.asyncOperations);
