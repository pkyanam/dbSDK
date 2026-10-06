/**
 * Integration tests for the accepted PlanetScale Postgres slice, run through
 * the PUBLIC facades (`createManagement` / `createDatabase`), not the raw
 * adapters — this is the wiring-level proof the export round owns:
 *
 * - the management workflow (create → wait → role credentials → connection)
 *   against a mocked control plane shaped from the official API;
 * - the engine gate and capability gates firing through the unified client
 *   with zero dispatch;
 * - one-time secret handling across create/reset through the public client;
 * - a local-PostgreSQL leg (env-gated) that assembles a connection string
 *   from the management connection() output the way a real caller would and
 *   queries through `dbsdk/planetscale` + `createDatabase`.
 *
 * No hosted PlanetScale endpoint is exercised; evidence stays offline /
 * local (see coordination/planetscale-postgres-acceptance-r4.md §6).
 */

import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { createDatabase } from '../../src/index.js';
import type { Database } from '../../src/types.js';
import { planetscale } from '../../src/planetscale.js';
import type { PgPoolConfig, PgPoolLike } from '../../src/adapters/pg-engine.js';
import { createManagement } from '../../src/management/core.js';
import { ManagementError } from '../../src/management/errors.js';
import { planetscaleManagement } from '../../src/management/planetscale.js';
import type { FetchLike, ManagementWriteResult } from '../../src/management/types.js';

// ---------------------------------------------------------------------------
// Mock control plane (same shape as tests/management/planetscale.test.ts)
// ---------------------------------------------------------------------------

type FakeResponse = { status?: number; body?: unknown };
type CapturedRequest = { path: string; method: string; body: unknown };

const NOW = '2026-10-06T00:00:00Z';
const ONE_TIME_PASSWORD = 'pscale_pw_integration_fixture_value';

function fakeFetch(
  handler: (req: CapturedRequest) => FakeResponse | Promise<FakeResponse>,
): { fetch: FetchLike; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const captured: CapturedRequest = {
      path: url.pathname,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(captured);
    const response = await handler(captured);
    return new Response(response.body === undefined ? null : JSON.stringify(response.body ?? null), {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, calls };
}

function databaseFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'psdb-uid-123',
    name: 'app-db',
    state: 'ready',
    ready: true,
    region: { slug: 'us-east-1' },
    default_branch: 'main',
    created_at: NOW,
    updated_at: NOW,
    kind: 'postgresql',
    ...overrides,
  };
}

function roleFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'role-uid-456',
    name: 'app-role',
    access_host_url: 'app-db.us-east-1.psdb.cloud',
    username: 'app-role.br3anchid',
    password: null,
    database_name: 'app-db',
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    dropped_at: null,
    disabled_at: null,
    ready: true,
    expired: false,
    kind: 'postgresql',
    ...overrides,
  };
}

function makeClient(handler: (req: CapturedRequest) => FakeResponse | Promise<FakeResponse>) {
  const { fetch, calls } = fakeFetch(handler);
  const adapter = planetscaleManagement({
    tokenId: 'integration-token-id',
    tokenSecret: 'integration-token-secret',
    organization: 'acme',
    fetch,
  });
  return { client: createManagement({ adapter }), calls };
}

// ---------------------------------------------------------------------------
// Management workflow through the public createManagement facade
// ---------------------------------------------------------------------------

describe('integration — planetscale management workflow (public facade, offline)', () => {
  it('creates a database with cluster_size, waits to ready, and never fabricates a password', async () => {
    const { client, calls } = makeClient((req) => {
      if (req.method === 'POST' && req.path === '/v1/organizations/acme/databases') {
        return { status: 201, body: databaseFixture({ state: 'pending', ready: false }) };
      }
      if (req.method === 'GET' && req.path === '/v1/organizations/acme/databases/app-db') {
        return { body: databaseFixture() }; // ready on the first poll
      }
      throw new Error(`unexpected request: ${req.method} ${req.path}`);
    });

    const result: ManagementWriteResult = await client.create({
      kind: 'project',
      name: 'app-db',
      providerOptions: { cluster_size: 'PS-10-GP' },
    });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v1/organizations/acme/databases' });
    expect(calls[0]!.body).toEqual({ name: 'app-db', kind: 'postgresql', cluster_size: 'PS-10-GP' });
    expect(result.resource?.id).toBe('app-db');
    // No create-time password exists on PlanetScale: secrets must be empty, not fabricated.
    expect(result.secrets).toHaveLength(0);

    const ready = await client.wait(result, { timeoutMs: 5_000, pollIntervalMs: 1 });
    expect(ready.status).toBe('active');
    // wait() polls GETs only — the POST was never replayed.
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('hands out role credentials once via secrets, then connection() without any password', async () => {
    const { client } = makeClient((req) => {
      if (req.method === 'GET' && req.path === '/v1/organizations/acme/databases/app-db') {
        return { body: databaseFixture() }; // engine preflight for the role create
      }
      if (req.method === 'POST' && req.path.endsWith('/roles')) {
        return { status: 201, body: roleFixture({ password: ONE_TIME_PASSWORD }) };
      }
      if (req.method === 'GET' && req.path.includes('/roles/role-uid-456')) {
        return { body: roleFixture() }; // later GETs: password is null (one-time)
      }
      throw new Error(`unexpected request: ${req.method} ${req.path}`);
    });

    const role = await client.create({
      kind: 'role',
      name: 'app-role',
      scope: { projectId: 'app-db', branchId: 'main' },
    });
    // The one-time password appears exactly once, only in secrets.
    expect(role.secrets).toEqual([{ label: 'password:app-role', value: ONE_TIME_PASSWORD }]);
    expect(JSON.stringify(role.resource?.raw ?? {})).not.toContain(ONE_TIME_PASSWORD);

    const info = await client.connection({
      kind: 'role',
      id: 'role-uid-456',
      scope: { projectId: 'app-db', branchId: 'main' },
    });
    expect(info.host).toBe('app-db.us-east-1.psdb.cloud');
    expect(info.port).toBe(5432);
    expect(info.role).toBe('app-role.br3anchid');
    expect(info.database).toBe('app-db');
    expect(info.redactedUri).toContain('[redacted]');
    // connection() can never produce a PlanetScale password: empty secrets is the honest answer.
    expect(info.secrets).toHaveLength(0);
  });

  it('refuses lifecycle actions and non-postgres parents with zero dispatch through the facade', async () => {
    const { client, calls } = makeClient((req) => {
      if (req.method === 'GET' && req.path === '/v1/organizations/acme/databases/app-db') {
        return { body: databaseFixture({ kind: 'mysql' }) };
      }
      throw new Error(`unexpected request: ${req.method} ${req.path}`);
    });

    // No actions declared at all → CAPABILITY before any HTTP.
    await expect(client.action({ kind: 'project', id: 'app-db' }, 'restart')).rejects.toMatchObject({
      code: 'CAPABILITY',
    });
    expect(calls).toHaveLength(0);

    // Engine gate: a mutation over a mysql parent is refused after the preflight GET only.
    await expect(
      client.create({ kind: 'branch', name: 'feature', projectId: 'app-db' }),
    ).rejects.toSatisfy((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      return /kind 'mysql'/.test(message) || /PostgreSQL/.test(message);
    });
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });
});

// ---------------------------------------------------------------------------
// Local PostgreSQL leg: management-derived identity → query through the facade
// ---------------------------------------------------------------------------

const hasServer = Boolean(process.env.DBSDK_TEST_POSTGRES_URL);
const d = hasServer ? describe : describe.skip;
const LOCAL_URL = process.env.DBSDK_TEST_POSTGRES_URL ?? 'postgresql://postgres:dbsdk@localhost:15432/dbsdk';
const SCHEMA = 'dbsdk_ps_integration';

d('integration — provision-to-query shape over real local PostgreSQL', () => {
  // The "hosted" control plane is mocked, but its connection facts point at the
  // real local server: the role fixture carries the local host, the local user
  // as the role username, and the caller supplies the one-time password (here:
  // the local server's own password) — exactly the real PlanetScale flow.
  const parsed = new URL(LOCAL_URL);
  const localPassword = decodeURIComponent(parsed.password);
  const role = roleFixture({
    access_host_url: parsed.hostname,
    username: decodeURIComponent(parsed.username),
    database_name: parsed.pathname.replace(/^\//, '') || 'postgres',
    password: localPassword,
  });

  const { client } = makeClient((req) => {
    if (req.method === 'GET' && req.path === '/v1/organizations/acme/databases/app-db') {
      return { body: databaseFixture() }; // engine preflight for the role create
    }
    if (req.method === 'POST' && req.path.endsWith('/roles')) {
      return { status: 201, body: role };
    }
    if (req.method === 'GET' && req.path.includes('/roles/role-uid-456')) {
      return { body: roleFixture({ ...role, password: null }) };
    }
    throw new Error(`unexpected request: ${req.method} ${req.path}`);
  });

  let db: Database;

  afterAll(async () => {
    if (!db) return;
    const closer = new Pool({ connectionString: LOCAL_URL });
    try {
      await closer.query(`drop schema if exists ${SCHEMA} cascade`);
    } finally {
      await closer.end();
      await db.close();
    }
  });

  it('assembles the connection from management output + the one-time secret and queries', async () => {
    const created = await client.create({
      kind: 'role',
      name: 'app-role',
      scope: { projectId: 'app-db', branchId: 'main' },
    });
    const secret = created.secrets[0]!.value;

    const info = await client.connection({
      kind: 'role',
      id: 'role-uid-456',
      scope: { projectId: 'app-db', branchId: 'main' },
    });
    // The caller owns assembly: host/username/database from management, the
    // password from the one-time secret. (Local port override is a test-only
    // artifact: the container maps 5432 → 15432.)
    const assembled = `postgresql://${encodeURIComponent(info.role!)}:${encodeURIComponent(secret)}@${
      info.host
    }:${parsed.port}/${info.database}`;
    expect(info.secrets).toHaveLength(0); // connection() itself never carries credentials

    const adapter = planetscale({
      connectionString: assembled,
      connectionMode: 'direct',
      // Test-only: the local container maps 5432 → 15432, an intentional
      // nonstandard endpoint — exactly what this documented option exists for.
      allowModeMismatch: true,
    });
    db = createDatabase({ adapter });

    const setup = await db.query({ text: `drop schema if exists ${SCHEMA} cascade` });
    expect(setup.rows).toEqual([]);
    await db.query({ text: `create schema ${SCHEMA}` });
    await db.query({ text: `create table ${SCHEMA}.items (id int primary key, label text not null)` });
    await db.query({ text: `insert into ${SCHEMA}.items values (1, 'one')` });

    const { rows } = await db.query<{ id: number; label: string }>({
      text: `select id, label from ${SCHEMA}.items where id = $1`,
      params: [1],
    });
    expect(rows).toEqual([{ id: 1, label: 'one' }]);

    // The public adapter keeps its guarantees on this path too.
    expect(db.capabilities.sessionState).toBe(true);
    await db.transaction(async (tx) => {
      await tx.query(`insert into ${SCHEMA}.items values (2, 'two')`);
    });
    const all = await db.query<{ n: number }>({ text: `select count(*)::int as n from ${SCHEMA}.items` });
    expect(all.rows[0]!.n).toBe(2);
  });
});
