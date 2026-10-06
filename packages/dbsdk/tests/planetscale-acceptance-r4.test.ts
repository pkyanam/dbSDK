/**
 * Independent ACCEPTANCE review R4 — PlanetScale Postgres (tests/planetscale-acceptance-r4.test.ts).
 *
 * Ownership: this file + coordination/planetscale-postgres-r4.md only. This is NOT another
 * implementation round: it verifies the ACTUAL behavior of the R1 implementation as repaired by
 * R3, independently of the fix author's own suites (which are re-run separately as regressions).
 *
 * Evidence rules honored here:
 * - NO hosted PlanetScale traffic anywhere. Management control-plane fixtures are MOCKED
 *   (injected fetch); query-adapter TLS proofs introspect the REAL installed `pg` driver's
 *   `connectionParameters.ssl` (synchronous URL/config parsing, no network) — the exact vector
 *   review finding F3 was proven with. Local PostgreSQL 17 (env-gated) is driver-compatibility
 *   only, in a dedicated `dbsdk_ps_r4_accept` schema cleaned up afterwards.
 * - Fixtures are shaped from the official per-endpoint OpenAPI YAML summarized in
 *   coordination/planetscale-postgres-r1.md (no facts re-invented here).
 * - Engine-gate proofs COUNT actual network methods: a refusal must yield exactly `['GET']`
 *   (the pre-flight) or `[]` (pre-dispatch refusals), never PATCH/POST/DELETE.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client as PgClient } from 'pg';

import { planetscale, type PlanetScaleAdapterOptions } from '../src/planetscale.js';
import { postgres } from '../src/adapters/postgres.js';
import { supabase, assertNoSessionState } from '../src/adapters/supabase.js';
import { assertNoUrlSslOverride, collectUrlSslDirectives } from '../src/adapters/pg-url-ssl.js';
import type { PgPoolConfig } from '../src/adapters/pg-engine.js';
import { createManagement } from '../src/management/core.js';
import { planetscaleManagement, type PlanetScaleManagementRaw } from '../src/management/planetscale.js';
import type { FetchLike } from '../src/management/types.js';

// ---------------------------------------------------------------------------
// Query-adapter harness: capture the pool config the PUBLIC adapter resolves,
// then feed it to the REAL installed pg driver (no network) for final-config proofs.
// ---------------------------------------------------------------------------

const DIRECT_URL = 'postgresql://app-role.br3anchid:pscale_pw_SECRET_fixture@eu-central-useast1-1.horizon.psdb.cloud:5432/app-db';
const POOLED_URL = 'postgresql://app-role.br3anchid:pscale_pw_SECRET_fixture@eu-central-useast1-1.horizon.psdb.cloud:6432/app-db';

const stubPool = () => ({
  query: async () => ({ rows: [], rowCount: 0, command: 'SELECT' }),
  connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
  end: async () => {},
});

function capturePoolConfig(options: Omit<PlanetScaleAdapterOptions, 'poolFactory'>): {
  db: ReturnType<typeof planetscale>;
  config: () => PgPoolConfig;
} {
  let captured: PgPoolConfig | undefined;
  const db = planetscale({
    ...options,
    poolFactory: (config) => {
      captured = config;
      return stubPool();
    },
  });
  return { db, config: () => captured! };
}

/** The FINAL ssl value the installed pg driver would use for this pool config (no network). */
function finalDriverSsl(config: PgPoolConfig): unknown {
  const client = new PgClient(config as never) as unknown as { connectionParameters: { ssl: unknown } };
  return client.connectionParameters.ssl;
}

// ---------------------------------------------------------------------------
// Management harness: mocked control plane (labeled), full request capture
// ---------------------------------------------------------------------------

type FakeResponse = { status?: number; body?: unknown; headers?: Record<string, string> };
type CapturedRequest = {
  path: string;
  method: string;
  body: unknown;
  query: URLSearchParams;
  headers: Record<string, string>;
};
const BASE_PATH = '/v1';

function fakeFetch(handler: (req: CapturedRequest) => FakeResponse | Promise<FakeResponse>): {
  fetch: FetchLike;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const rawBody = typeof init?.body === 'string' ? init.body : undefined;
    const captured: CapturedRequest = {
      path: url.pathname.startsWith(BASE_PATH) ? url.pathname.slice(BASE_PATH.length) : url.pathname,
      method,
      body: rawBody === undefined ? undefined : JSON.parse(rawBody),
      query: url.searchParams,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
      ),
    };
    calls.push(captured);
    // Honor caller aborts the way real fetch does (an already-aborted signal rejects).
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    const response = await handler(captured);
    if (response.status === 204) return new Response(null, { status: 204 });
    return new Response(response.body === undefined ? null : JSON.stringify(response.body ?? null), {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/json', ...(response.headers ?? {}) },
    });
  };
  return { fetch, calls };
}

const TOKEN_ID = 'r4tokenid';
const TOKEN_SECRET = 'r4tokensecret';
const ORG = 'acme';
const NOW = '2026-10-06T00:00:00Z';
const PASSWORD_1 = 'pscale_pw_r4_first_abcdefgh';
const PASSWORD_2 = 'pscale_pw_r4_second_ijklmnop';

const REGION_OBJ = {
  id: 'reg-uid', provider: 'AWS', enabled: true, public_ip_addresses: [],
  display_name: 'US East', location: 'US East', slug: 'us-east-1',
  current_default: true, mysql_supported: true, postgresql_supported: true, neki_supported: false,
};

function databaseFixture(kind: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'db-uid', name: 'app-db', state: 'ready', ready: true, region: REGION_OBJ,
    default_branch: 'main', created_at: NOW, updated_at: NOW, kind, ...overrides,
  };
}
function branchFixture(kind: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'branch-uid', name: 'main', created_at: NOW, updated_at: NOW, deleted_at: null,
    kind, state: 'ready', ready: true, region: REGION_OBJ, ...overrides,
  };
}
function roleFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'role-uid-456', name: 'app-role', access_host_url: 'eu-central-useast1-1.horizon.psdb.cloud',
    username: 'app-role.br3anchid', database_name: 'app-db', password: null,
    created_at: NOW, updated_at: NOW, deleted_at: null, expires_at: null,
    dropped_at: null, disabled_at: null, ready: true, expired: false, ...overrides,
  };
}

function makeClient(
  handler: (req: CapturedRequest) => FakeResponse | Promise<FakeResponse>,
  overrides: { organization?: string } = {},
) {
  const { fetch, calls } = fakeFetch(handler);
  const adapter = planetscaleManagement({
    tokenId: TOKEN_ID,
    tokenSecret: TOKEN_SECRET,
    organization: ORG,
    fetch,
    ...overrides,
  });
  return { client: createManagement({ adapter }), adapter, calls };
}

const SCOPE = { projectId: 'app-db', branchId: 'main' };
const OK_DB = (): FakeResponse => ({ body: databaseFixture('postgresql') });

// ===========================================================================
// A. F3 — TLS policy must hold for the FINAL driver configuration
// ===========================================================================

describe('R4-A — TLS final-config proofs through the real installed pg driver (no network)', () => {
  it('defaults a remote connection to verified TLS in the driver config', async () => {
    const { db, config } = capturePoolConfig({ connectionString: DIRECT_URL, connectionMode: 'direct' });
    await db.query('select 1');
    expect(finalDriverSsl(config())).toEqual({ rejectUnauthorized: true });
  });

  it('sslmode=require / verify-full alone resolve to verified TLS and are stripped from the URL', async () => {
    for (const mode of ['require', 'verify-full']) {
      const { db, config } = capturePoolConfig({
        connectionString: `${DIRECT_URL}?sslmode=${mode}`, connectionMode: 'direct',
      });
      await db.query('select 1');
      expect(finalDriverSsl(config()), mode).toEqual({ rejectUnauthorized: true });
      expect(config().connectionString).not.toContain('sslmode');
      expect(config().connectionString!.startsWith('postgresql://app-role.br3anchid:')).toBe(true);
      expect(config().connectionString).toContain('/app-db');
    }
  });

  it('an explicit CA survives sslmode=require / verify-full (pg would have discarded it)', async () => {
    for (const mode of ['require', 'verify-full']) {
      const { db, config } = capturePoolConfig({
        connectionString: `${DIRECT_URL}?sslmode=${mode}`,
        connectionMode: 'direct',
        ssl: { rejectUnauthorized: true, ca: 'r4-test-ca' },
      });
      await db.query('select 1');
      expect(finalDriverSsl(config()), mode).toEqual({ rejectUnauthorized: true, ca: 'r4-test-ca' });
    }
  });

  it('case-insensitive keys/values and duplicates canonicalize without refusal', async () => {
    const { db, config } = capturePoolConfig({
      connectionString: `${DIRECT_URL}?SSLMODE=REQUIRE&sslmode=require&ssl=1`, connectionMode: 'direct',
    });
    await db.query('select 1');
    expect(finalDriverSsl(config())).toEqual({ rejectUnauthorized: true });
    expect(config().connectionString).not.toMatch(/sslmode|ssl=/i);
  });

  it('ambiguous / weak / unknown sslmodes are refused before pool creation', () => {
    for (const directive of ['sslmode=', 'sslmode=prefer', 'sslmode=allow', 'sslmode=verify-ca', 'sslmode=bogus', 'ssl=maybe']) {
      expect(() => planetscale({ connectionString: `${DIRECT_URL}?${directive}`, connectionMode: 'direct' }), directive)
        .toThrow(/sslmode|ssl=/i);
    }
  });

  it('file-loading URL parameters are refused (the driver must never read TLS config from disk)', () => {
    for (const directive of ['sslcert=/tmp/r4-nope.pem', 'sslkey=/tmp/r4-nope.key', 'sslrootcert=/tmp/r4-nope.crt']) {
      expect(() => planetscale({ connectionString: `${DIRECT_URL}?${directive}`, connectionMode: 'direct' }), directive)
        .toThrow(/sslcert|sslkey|sslrootcert|ssl option/i);
    }
  });

  it('sslnegotiation and uselibpqcompat are refused', () => {
    expect(() => planetscale({ connectionString: `${DIRECT_URL}?sslnegotiation=direct`, connectionMode: 'direct' })).toThrow(/sslnegotiation/);
    expect(() => planetscale({ connectionString: `${DIRECT_URL}?uselibpqcompat=true`, connectionMode: 'direct' })).toThrow(/uselibpqcompat/);
  });

  it('plaintext directives are refused on remote hosts and allowed on localhost', async () => {
    for (const directive of ['sslmode=disable', 'ssl=false', 'ssl=0']) {
      expect(() => planetscale({ connectionString: `${DIRECT_URL}?${directive}`, connectionMode: 'direct' }), directive)
        .toThrow(/unencrypted|requires TLS/i);
    }
    const { db, config } = capturePoolConfig({
      connectionString: 'postgresql://postgres:pw@localhost:15432/dbsdk?sslmode=disable',
      connectionMode: 'direct',
      allowModeMismatch: true,
    });
    await db.query('select 1');
    expect(finalDriverSsl(config())).toBe(false);
  });

  it('conflicting directives are refused before pool creation', () => {
    expect(() => planetscale({ connectionString: `${DIRECT_URL}?sslmode=require&sslmode=disable`, connectionMode: 'direct' }))
      .toThrow(/conflicting/);
    // Two agreeing plaintext directives are not "conflicting" — they hit the remote plaintext refusal.
    expect(() => planetscale({ connectionString: `${DIRECT_URL}?sslmode=disable&ssl=false`, connectionMode: 'direct' }))
      .toThrow(/unencrypted|requires TLS/i);
  });

  it('a directive conflicting with the explicit ssl option is refused (both directions)', () => {
    expect(() => planetscale({
      connectionString: `${DIRECT_URL}?sslmode=disable`, connectionMode: 'direct',
      ssl: { rejectUnauthorized: true },
    })).toThrow(/plaintext|TLS/i);
    expect(() => planetscale({
      connectionString: `${DIRECT_URL}?sslmode=require`, connectionMode: 'direct',
      ssl: false,
    })).toThrow(/TLS|plaintext/i);
  });

  it('the pool escape hatch cannot produce an unencrypted remote config (final safety net)', () => {
    expect(() => planetscale({
      connectionString: DIRECT_URL, connectionMode: 'direct', pool: { ssl: false },
    })).toThrow(/disables TLS|unencrypted/i);
  });

  it('the encrypted-but-unverified escape hatch is EXPLICIT-only, never reachable via the URL', async () => {
    // Deliberate: only a caller-written `ssl: { rejectUnauthorized: false }` reaches it.
    const explicit = capturePoolConfig({
      connectionString: DIRECT_URL, connectionMode: 'direct', ssl: { rejectUnauthorized: false },
    });
    await explicit.db.query('select 1');
    expect(finalDriverSsl(explicit.config())).toEqual({ rejectUnauthorized: false });
    // No URL directive can produce it: every accepted TLS directive resolves to verified TLS.
    const viaUrl = capturePoolConfig({ connectionString: `${DIRECT_URL}?sslmode=require`, connectionMode: 'direct' });
    await viaUrl.db.query('select 1');
    expect(finalDriverSsl(viaUrl.config())).toEqual({ rejectUnauthorized: true });
  });

  it('TLS validation errors never leak the URL password', () => {
    try {
      planetscale({ connectionString: `${DIRECT_URL}?sslmode=prefer`, connectionMode: 'direct' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = String((error as Error).message);
      expect(message).not.toContain('pscale_pw_SECRET_fixture');
      expect(message).not.toContain('psdb.cloud');
    }
  });

  it('safe non-SSL URL parameters survive (no collateral rewriting)', async () => {
    const { db, config } = capturePoolConfig({
      connectionString: `${DIRECT_URL}?application_name=r4-acceptance`, connectionMode: 'direct',
    });
    await db.query('select 1');
    expect(config().connectionString).toContain('application_name=r4-acceptance');
    expect(finalDriverSsl(config())).toEqual({ rejectUnauthorized: true });
  });

  it('missing explicit default TLS interplay: local default plaintext, remote default verified', async () => {
    const local = capturePoolConfig({
      connectionString: 'postgresql://postgres:pw@localhost:15432/dbsdk', connectionMode: 'direct', allowModeMismatch: true,
    });
    await local.db.query('select 1');
    expect(finalDriverSsl(local.config())).toBe(false); // local testing default (documented)
    const remote = capturePoolConfig({ connectionString: DIRECT_URL, connectionMode: 'direct' });
    await remote.db.query('select 1');
    expect(finalDriverSsl(remote.config())).toEqual({ rejectUnauthorized: true }); // verified default
  });
});

describe('R4-A2 — narrow Postgres/Supabase ambiguity fix through the PUBLIC adapters', () => {
  function captureGeneric(
    factory: (options: Record<string, unknown>) => unknown,
    options: Record<string, unknown>,
  ): { db: { query(text: string): Promise<unknown> }; config: () => PgPoolConfig } {
    let captured: PgPoolConfig | undefined;
    const db = factory({
      ...options,
      poolFactory: (config: PgPoolConfig) => {
        captured = config;
        return stubPool();
      },
    }) as { query(text: string): Promise<unknown> };
    return { db, config: () => captured! };
  }

  it('postgres: URL directives + explicit ssl conflict is refused before the pool', () => {
    expect(() => captureGeneric(postgres as unknown as (o: Record<string, unknown>) => unknown, {
      connectionString: 'postgresql://u:p@localhost:5432/d?sslmode=disable', ssl: { rejectUnauthorized: true },
      poolFactory: () => { throw new Error('pool must not be created'); },
    })).toThrow(/SSL directive|source of truth/i);
  });

  it('postgres: URL directives alone keep NATIVE pg parsing (verify-full stays verified)', async () => {
    const { db, config } = captureGeneric(postgres as unknown as (o: Record<string, unknown>) => unknown, {
      connectionString: 'postgresql://u:p@localhost:5432/d?sslmode=verify-full',
    });
    await db.query('select 1');
    const ssl = finalDriverSsl(config());
    expect(ssl).toBeTruthy(); // native pg resolves verify-full to a verified config object today
    expect(typeof ssl).toBe('object');
  });

  it('postgres: explicit generic plaintext stays allowed (no universal PlanetScale policy imposed)', async () => {
    const { db, config } = captureGeneric(postgres as unknown as (o: Record<string, unknown>) => unknown, {
      connectionString: 'postgresql://u:p@localhost:5432/d', ssl: false,
    });
    await db.query('select 1');
    expect(finalDriverSsl(config())).toBe(false);
  });

  it('postgres: pool.ssl conflicts with URL directives are refused too', () => {
    expect(() => captureGeneric(postgres as unknown as (o: Record<string, unknown>) => unknown, {
      connectionString: 'postgresql://u:p@localhost:5432/d?sslmode=require', pool: { ssl: { rejectUnauthorized: true } },
      poolFactory: () => { throw new Error('pool must not be created'); },
    })).toThrow(/SSL directive|source of truth/i);
  });

  it('supabase: URL directives + explicit ssl conflict is refused; URL-only verify-full preserved natively', async () => {
    expect(() => captureGeneric(supabase as unknown as (o: Record<string, unknown>) => unknown, {
      connectionString: 'postgresql://postgres.abcdef@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require',
      connectionMode: 'direct', ssl: { rejectUnauthorized: true, ca: 'x' },
      poolFactory: () => { throw new Error('pool must not be created'); },
    })).toThrow(/SSL directive|source of truth/i);

    const { db, config } = captureGeneric(supabase as unknown as (o: Record<string, unknown>) => unknown, {
      connectionString: 'postgresql://postgres.abcdef@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full',
      connectionMode: 'direct',
    });
    await db.query('select 1');
    const ssl = finalDriverSsl(config());
    expect(ssl).toBeTruthy(); // documented URL-only verify-full keeps native pg behavior
  });

  it('assertNoSessionState wrapper is preserved and now rejects multi-statement strings', () => {
    expect(() => assertNoSessionState('set application_name = x')).toThrow(/session-level state/);
    expect(() => assertNoSessionState('select 1; set application_name = x')).toThrow(/multiple SQL statements/);
    expect(() => assertNoSessionState('select 1')).not.toThrow();
  });

  it('shared helper unit: directive collection is case-insensitive and complete', () => {
    const url = new URL('postgresql://u:p@h:5432/d?SslMode=require&application_name=x&SSLCERT=/a&sslrootcert=/b&uselibpqcompat=true');
    const d = collectUrlSslDirectives(url);
    expect(d.all.map((x) => x.key)).toEqual(['sslmode', 'sslcert', 'sslrootcert', 'uselibpqcompat']);
    expect(d.fileParams).toEqual(['sslcert', 'sslrootcert']);
    expect(() => assertNoUrlSslOverride({ adapter: 't', directives: d, explicitSsl: undefined })).not.toThrow();
    expect(() => assertNoUrlSslOverride({ adapter: 't', directives: d, explicitSsl: { ca: 'x' } })).toThrow(/SSL directive/);
  });
});

// ===========================================================================
// B. F4 — organization model: factory org owns ALL CRUD
// ===========================================================================

describe('R4-B — organization model', () => {
  it('create with spec.organizationId ≠ factory org is refused with ZERO dispatch', async () => {
    const { client, calls } = makeClient(() => OK_DB());
    await expect(client.create({
      kind: 'project', name: 'new-db', organizationId: 'other-org',
      providerOptions: { cluster_size: 'PS_10' },
    } as never)).rejects.toMatchObject({ code: 'CONFIGURATION' });
    expect(calls).toHaveLength(0);
  });

  it('create without a factory organization is refused with ZERO dispatch', async () => {
    const { client, calls } = makeClient(() => OK_DB(), { organization: undefined });
    await expect(client.create({
      kind: 'project', name: 'new-db', providerOptions: { cluster_size: 'PS_10' },
    } as never)).rejects.toMatchObject({ code: 'CONFIGURATION' });
    expect(calls).toHaveLength(0);
  });

  it('create with a MATCHING org dispatches to the factory org with the exact official body', async () => {
    const { client, calls } = makeClient(() => OK_DB());
    await client.create({
      kind: 'project', name: 'new-db', organizationId: ORG,
      providerOptions: { cluster_size: 'PS_10' },
    } as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe(`/organizations/${ORG}/databases`);
    expect(calls[0]!.body).toEqual({ name: 'new-db', kind: 'postgresql', cluster_size: 'PS_10' });
  });

  it('follow-up get/update/connection all target the SAME factory org', async () => {
    const { client, calls } = makeClient((req) => {
      if (req.method === 'GET' && req.path.endsWith('/roles/default')) return { body: roleFixture() };
      return OK_DB();
    });
    await client.get({ kind: 'project', id: 'new-db' } as never);
    await client.update({ kind: 'project', id: 'new-db', patch: { providerOptions: { deletion_protected: true } } } as never);
    await client.connection({ kind: 'project', id: 'new-db' } as never, {});
    for (const call of calls) {
      expect(call.path.startsWith(`/organizations/${ORG}/`), call.path).toBe(true);
    }
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch).toBeDefined();
    expect(patch!.body).toEqual({ deletion_protected: true });
  });

  it('discovery may still target OTHER organizations explicitly', async () => {
    const { adapter, calls } = makeClient((req) => {
      if (req.path.endsWith('/regions')) return { body: { data: [], next_page: null } };
      return { body: [] }; // cluster-size-skus returns a plain array
    });
    await adapter.regions!({ organizationId: 'other-org' });
    await adapter.raw!.clusterSizeSkus({ organization: 'other-org' });
    expect(calls[0]!.path).toBe('/organizations/other-org/regions');
    expect(calls[1]!.path).toBe('/organizations/other-org/cluster-size-skus');
  });

  it('the factory organization is immutable — concurrent creates all target it, no mutable state', async () => {
    const { client, calls, adapter } = makeClient(() => OK_DB());
    await Promise.all([
      client.create({ kind: 'project', name: 'db-a', providerOptions: { cluster_size: 'PS_10' } } as never),
      client.create({ kind: 'project', name: 'db-b', providerOptions: { cluster_size: 'PS_10' } } as never),
    ]);
    for (const call of calls) expect(call.path).toBe(`/organizations/${ORG}/databases`);
    expect(adapter.id).toBe('planetscale'); // adapter identity/config untouched by the calls
  });
});

// ===========================================================================
// C. F1 — wrong-engine mutations dispatch NOTHING beyond the safe pre-flight GET
// ===========================================================================

describe('R4-C — engine gate: every mutating verb pre-flights with GET only', () => {
  const MYSQL_DB = (): FakeResponse => ({ body: databaseFixture('mysql') });
  const NEKI_DB = (): FakeResponse => ({ body: databaseFixture('neki') });

  async function expectGetOnly(
    run: (client: ReturnType<typeof makeClient>['client']) => Promise<unknown>,
    kind: 'mysql' | 'neki',
  ): Promise<void> {
    const handler = kind === 'mysql' ? MYSQL_DB : NEKI_DB;
    const { client, calls } = makeClient(handler);
    await expect(run(client)).rejects.toMatchObject({ code: 'CONFIGURATION' });
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    expect(calls[0]!.path).toBe(`/organizations/${ORG}/databases/app-db`);
  }

  it('update(project) sends only the pre-flight GET against a Vitess/MySQL database', async () => {
    await expectGetOnly((c) => c.update({ kind: 'project', id: 'app-db', patch: { name: 'x' } } as never), 'mysql');
  });

  it('delete(project) sends only the pre-flight GET (destructive call never dispatched)', async () => {
    await expectGetOnly((c) => c.delete({ kind: 'project', id: 'app-db' } as never), 'mysql');
  });

  it('create(branch) sends only the pre-flight GET before any POST', async () => {
    await expectGetOnly((c) => c.create({ kind: 'branch', projectId: 'app-db', name: 'staging' } as never), 'mysql');
  });

  it('create(role) sends only the pre-flight GET before any POST', async () => {
    await expectGetOnly((c) => c.create({ kind: 'role', scope: SCOPE, name: 'app' } as never), 'mysql');
  });

  it('update(role) sends only the pre-flight GET before any PATCH', async () => {
    await expectGetOnly((c) => c.update({ kind: 'role', id: 'role-uid-456', scope: SCOPE, patch: { name: 'renamed' } } as never), 'mysql');
  });

  it('delete(branch) sends only the pre-flight GET', async () => {
    await expectGetOnly((c) => c.delete({ kind: 'branch', id: 'main', projectId: 'app-db' } as never), 'mysql');
  });

  it('delete(role) sends only the pre-flight GET', async () => {
    await expectGetOnly((c) => c.delete({ kind: 'role', id: 'role-uid-456', scope: SCOPE } as never), 'mysql');
  });

  it('resetCredential(role) sends only the pre-flight GET before the POST /reset', async () => {
    await expectGetOnly((c) => c.resetCredential({ kind: 'role', id: 'role-uid-456', scope: SCOPE } as never, {}), 'mysql');
  });

  it('raw.renewRole sends only the pre-flight GET before the POST /renew', async () => {
    const { adapter, calls } = makeClient(MYSQL_DB);
    await expect(adapter.raw.renewRole({ projectId: 'app-db', branchId: 'main', roleId: 'role-uid-456' }))
      .rejects.toMatchObject({ code: 'CONFIGURATION' });
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('a Neki database is equally refused (platform preview)', async () => {
    await expectGetOnly((c) => c.delete({ kind: 'project', id: 'app-db' } as never), 'neki');
  });

  it('a missing `kind` fails honestly (PROVIDER) — never assumed PostgreSQL', async () => {
    const { client, calls } = makeClient(() => {
      const fixture = databaseFixture('postgresql');
      delete fixture['kind'];
      return { body: fixture };
    });
    await expect(client.get({ kind: 'project', id: 'app-db' } as never)).rejects.toMatchObject({ code: 'PROVIDER' });
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('connection(project) refuses a non-PostgreSQL database on its existing GET (no second request)', async () => {
    const { client, calls } = makeClient(MYSQL_DB);
    await expect(client.connection({ kind: 'project', id: 'app-db' } as never, {}))
      .rejects.toMatchObject({ code: 'CONFIGURATION' });
    expect(calls.map((c) => c.method)).toEqual(['GET']); // the database GET only — never the default-role chain
  });

  it('correct PostgreSQL mutations still dispatch with exact official bodies and per-call GETs', async () => {
    const { client, calls } = makeClient((req) => {
      if (req.method === 'GET' && req.path.endsWith('/roles/default')) return { body: roleFixture() };
      return OK_DB();
    });
    // update
    await client.update({ kind: 'project', id: 'app-db', patch: { name: 'renamed-db' } } as never);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[1]!.method).toBe('PATCH');
    expect(calls[1]!.body).toEqual({ new_name: 'renamed-db' });
    // create branch with source
    await client.create({ kind: 'branch', projectId: 'app-db', name: 'staging', sourceBranchId: 'main' } as never);
    expect(calls[2]!.method).toBe('GET');
    expect(calls[3]!.method).toBe('POST');
    expect(calls[3]!.path).toBe(`/organizations/${ORG}/databases/app-db/branches`);
    expect(calls[3]!.body).toEqual({ name: 'staging', parent_branch: 'main' });
    // delete
    await client.delete({ kind: 'project', id: 'app-db' } as never);
    expect(calls[4]!.method).toBe('GET');
    expect(calls[5]!.method).toBe('DELETE');
  });

  it('NO stale cached engine decision: each mutating call re-preflights its own target', async () => {
    const { client, calls } = makeClient((req) => {
      const isGood = req.path.includes('/databases/good-db');
      return { body: databaseFixture(isGood ? 'postgresql' : 'mysql', { name: isGood ? 'good-db' : 'bad-db' }) };
    });
    await client.update({ kind: 'project', id: 'good-db', patch: { name: 'x' } } as never); // GET + PATCH
    await expect(client.update({ kind: 'project', id: 'bad-db', patch: { name: 'x' } } as never))
      .rejects.toMatchObject({ code: 'CONFIGURATION' }); // GET only
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /organizations/${ORG}/databases/good-db`,
      `PATCH /organizations/${ORG}/databases/good-db`,
      `GET /organizations/${ORG}/databases/bad-db`,
    ]);
  });

  it('list(project) filters mixed-engine pages; entries missing kind fail honestly', async () => {
    const { client, calls } = makeClient(() => ({
      body: {
        data: [
          databaseFixture('postgresql'),
          databaseFixture('mysql', { name: 'mysql-db' }),
          databaseFixture('neki', { name: 'neki-db' }),
        ],
        current_page: 1,
        next_page: null,
      },
    }));
    const page = await client.list('project', {} as never);
    expect(page.resources.map((r) => r.id)).toEqual(['app-db']);
    expect(calls).toHaveLength(1);

    const missing = makeClient(() => ({
      body: { data: [{ id: 'x', name: 'no-kind-db', ready: true, state: 'ready' }], next_page: null },
    }));
    await expect(missing.client.list('project', {} as never)).rejects.toMatchObject({ code: 'PROVIDER' });
  });

  it('list(branch) drops present non-PostgreSQL kinds and tolerates a missing branch kind', async () => {
    const { client } = makeClient(() => ({
      body: {
        data: [branchFixture('postgresql'), branchFixture('mysql', { name: 'vitess-branch' }), { id: 'k', name: 'kindless', ready: true, state: 'ready' }],
        next_page: null,
      },
    }));
    const page = await client.list('branch', { projectId: 'app-db' } as never);
    expect(page.resources.map((r) => r.id)).toEqual(['main', 'kindless']);
  });

  it('read scope honesty: no false Postgres support label from Vitess systems', async () => {
    const { client, adapter, calls } = makeClient(MYSQL_DB);
    await expect(client.get({ kind: 'project', id: 'app-db' } as never)).rejects.toThrow(/PostgreSQL databases only|kind 'mysql'/);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    // Unsupported kinds refuse with zero dispatch; Vitess passwords are a separate system.
    // Through the core client the unknown kind is refused at the core layer (CONFIGURATION);
    // the adapter itself refuses with CAPABILITY — both with zero requests.
    await expect(client.create({ kind: 'database' } as never)).rejects.toMatchObject({ code: 'CONFIGURATION' });
    await expect(adapter.create({ kind: 'database' } as never)).rejects.toMatchObject({ code: 'CAPABILITY' });
    await expect(client.resetCredential({ kind: 'project', id: 'app-db' } as never, {})).rejects.toMatchObject({ code: 'CAPABILITY' });
    await expect(client.update({ kind: 'branch', id: 'main', projectId: 'app-db', patch: { name: 'x' } } as never))
      .rejects.toMatchObject({ code: 'CAPABILITY' }); // branch PATCH remains unimplemented (R1 §6 gap 5)
    expect(calls).toHaveLength(1); // only the honest mysql GET above
  });
});

// ===========================================================================
// D. F2/F5 — role lifecycle precedence, bounded wait, one-time secrets
// ===========================================================================

describe('R4-D — role status precedence and bounded wait (never falsely active)', () => {
  async function statusOf(overrides: Record<string, unknown>): Promise<string> {
    const { client } = makeClient(() => ({ body: roleFixture(overrides) }));
    const resource = await client.get({ kind: 'role', id: 'role-uid-456', scope: SCOPE } as never);
    return resource.status;
  }

  it('terminal/disabled states outrank ready:true (exact precedence order)', async () => {
    await expect(statusOf({ ready: true, dropped_at: NOW })).resolves.toBe('deleting');
    await expect(statusOf({ ready: true, deleted_at: NOW })).resolves.toBe('deleting');
    await expect(statusOf({ ready: true, expired: true })).resolves.toBe('paused');
    await expect(statusOf({ ready: true, disabled_at: NOW })).resolves.toBe('paused');
    await expect(statusOf({ ready: true })).resolves.toBe('active');
    await expect(statusOf({ ready: false })).resolves.toBe('creating');
    await expect(statusOf({ ready: undefined })).resolves.toBe('unknown'); // no invented status
  });

  it('bounded wait() on a ready:true + expired role NEVER reports active (GET-only, TIMEOUT)', async () => {
    const { client, calls } = makeClient(() => ({ body: roleFixture({ ready: true, expired: true }) }));
    await expect(client.wait({ kind: 'role', id: 'role-uid-456', scope: SCOPE } as never, { timeoutMs: 250, pollIntervalMs: 10 }))
      .rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(calls.every((c) => c.path.endsWith('/roles/role-uid-456'))).toBe(true);
  });

  it('one-time password: secrets only, redacted raw, BOTH rotations scrubbed from later errors', async () => {
    let mode: 'create' | 'reset' | 'fail' = 'create';
    const { client } = makeClient((req) => {
      if (req.path.endsWith('/roles') || req.path.endsWith('/reset')) {
        return { body: roleFixture({ password: mode === 'create' ? PASSWORD_1 : PASSWORD_2 }) };
      }
      if (mode === 'fail') return { status: 500, body: { message: `boom ${PASSWORD_1} ${PASSWORD_2}` } };
      return OK_DB();
    });
    const created = await client.create({ kind: 'role', scope: SCOPE, name: 'app-role' } as never);
    expect(created.resource).not.toBeNull();
    expect(created.secrets).toHaveLength(1);
    expect(created.secrets[0]!.label).toContain('password');
    expect(created.secrets[0]!.value).toBe(PASSWORD_1);
    expect(created.resource!.raw['password']).toBe('[redacted]');
    // rotate: new one-time password, both scrubbed from a later error message
    mode = 'reset';
    const rotated = await client.resetCredential({ kind: 'role', id: 'role-uid-456', scope: SCOPE } as never, {});
    expect(rotated.secrets[0]!.value).toBe(PASSWORD_2);
    mode = 'fail';
    await expect(client.get({ kind: 'project', id: 'app-db' } as never)).rejects.toSatisfy((error: Error) => {
      const message = String(error.message);
      return message.includes('[redacted]') && !message.includes(PASSWORD_1) && !message.includes(PASSWORD_2);
    });
  });

  it('caller-supplied passwords are refused before dispatch (create AND reset)', async () => {
    const { client, calls } = makeClient(() => OK_DB());
    await expect(client.create({ kind: 'role', scope: SCOPE, name: 'app', password: 'chosen' } as never))
      .rejects.toMatchObject({ code: 'CONFIGURATION' });
    await expect(client.resetCredential({ kind: 'role', id: 'role-uid-456', scope: SCOPE } as never, { password: 'chosen' }))
      .rejects.toMatchObject({ code: 'CONFIGURATION' });
    expect(calls).toHaveLength(0);
  });
});

// ===========================================================================
// E. F6 — pooled SQL guard semantics via the PUBLIC adapters
// ===========================================================================

describe('R4-E — transaction-pooler guard via the public PlanetScale + Supabase adapters', () => {
  function recordingDb(options: Omit<PlanetScaleAdapterOptions, 'poolFactory'>) {
    const queries: string[] = [];
    const db = planetscale({
      ...options,
      poolFactory: () => ({
        query: async (q: { text: string }) => {
          queries.push(q.text);
          return { rows: [], rowCount: 0, command: 'SELECT' };
        },
        connect: async () => ({
          query: async (q: { text: string }) => {
            queries.push(q.text);
            return { rows: [], rowCount: 0 };
          },
          release: () => {},
        }),
        end: async () => {},
      }),
    });
    return { db, queries };
  }

  it('session-state and multi-statement strings are refused BEFORE the pool exists', async () => {
    const { db, queries } = recordingDb({ connectionString: POOLED_URL, connectionMode: 'pooled' });
    await expect(db.query('/* ctx */ SET statement_timeout = 3000')).rejects.toMatchObject({ capability: 'sessionState' });
    await expect(db.query('select 1; set application_name = smuggled')).rejects.toThrow(/multiple SQL statements/);
    await expect(db.query('select 1; select 2')).rejects.toThrow(/multiple SQL statements/);
    await expect(db.query('RESET ALL')).rejects.toThrow();
    await expect(db.query('LISTEN chan')).rejects.toThrow();
    await expect(db.query('NOTIFY chan')).rejects.toThrow();
    await expect(db.query('PREPARE p AS select 1')).rejects.toThrow();
    await expect(db.query('DEALLOCATE p')).rejects.toThrow();
    await expect(db.query('create temp table t (x int)')).rejects.toThrow();
    await expect(db.query('declare c cursor with hold for select 1')).rejects.toThrow();
    expect(queries).toEqual([]); // nothing reached the driver
  });

  it('lexical masking: literals, dollar bodies, quoted identifiers, E-strings cannot smuggle', async () => {
    const { db, queries } = recordingDb({ connectionString: POOLED_URL, connectionMode: 'pooled' });
    await db.query('select 1;');
    await db.query('select 2 -- trailing comment');
    await db.query("select 'set x = 1' as literal");
    await db.query('select $tag$; set application_name = evil$tag$ as body');
    await db.query('select * from "weird;ident"');
    await db.query("select E'won\\'t end; set x' as v");
    await db.query('/* nested /* comment */ still comment */ select 3');
    await db.query('select * from reset_log where id = $1', [3]);
    expect(queries).toEqual([
      'select 1;',
      'select 2 -- trailing comment',
      "select 'set x = 1' as literal",
      'select $tag$; set application_name = evil$tag$ as body',
      'select * from "weird;ident"',
      "select E'won\\'t end; set x' as v",
      '/* nested /* comment */ still comment */ select 3',
      'select * from reset_log where id = $1',
    ]);
  });

  it('the guard covers transaction executors and batches, allows SET LOCAL in-transaction', async () => {
    const { db, queries } = recordingDb({ connectionString: POOLED_URL, connectionMode: 'pooled' });
    await expect(db.transaction!(async (tx) => {
      await tx.query('select 1; set x = 2');
    })).rejects.toThrow(/multiple SQL statements/);
    await expect(db.batch!([{ text: 'set statement_timeout = 1' }])).rejects.toMatchObject({ capability: 'sessionState' });
    await db.transaction!(async (tx) => {
      await tx.query('SET LOCAL statement_timeout = 3000');
    });
    expect(queries).toContain('SET LOCAL statement_timeout = 3000');
  });

  it('raw.pool is the documented native escape hatch — the guard is NOT a SQL sandbox', async () => {
    const raw: string[] = [];
    const db = planetscale({
      connectionString: POOLED_URL, connectionMode: 'pooled',
      poolFactory: () => ({
        query: async (q: { text: string }) => {
          raw.push(q.text);
          return { rows: [], rowCount: 0 };
        },
        connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
        end: async () => {},
      }),
    });
    await (db.raw.pool as unknown as { query(config: { text: string }): Promise<unknown> }).query({
      text: 'set application_name = native-escape',
    });
    expect(raw).toEqual(['set application_name = native-escape']);
  });

  it('supabase transaction mode shares the guard; legitimate SQL passes', async () => {
    const queries: string[] = [];
    const tx = supabase({
      connectionString: 'postgresql://postgres.ref@localhost:6543/postgres',
      connectionMode: 'transaction',
      poolFactory: () => ({
        query: async (q: { text: string }) => {
          queries.push(q.text);
          return { rows: [], rowCount: 0 };
        },
        connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
        end: async () => {},
      }),
    } as never);
    await expect(tx.query('select 1; set x = 2')).rejects.toThrow(/multiple SQL statements/);
    await expect(tx.query('/* c */ set statement_timeout = 1')).rejects.toMatchObject({ capability: 'sessionState' });
    await tx.query("select 'set x' as literal");
    expect(queries).toEqual(["select 'set x' as literal"]);
  });

  it('direct mode keeps full session semantics', async () => {
    const { db, queries } = recordingDb({ connectionString: DIRECT_URL, connectionMode: 'direct' });
    await db.query('set statement_timeout to 3000');
    await db.query('select 1; select 2'); // multi-statement is fine on a session connection
    expect(queries).toEqual(['set statement_timeout to 3000', 'select 1; select 2']);
  });
});

// ===========================================================================
// F. Pagination, limits, SKU discovery, HTTP transport honesty
// ===========================================================================

describe('R4-F — pagination, per_page cap, SKUs, transport', () => {
  it('limit > 100 is refused with ZERO HTTP; limit 100 round-trips as per_page=100', async () => {
    const refused = makeClient(() => ({ body: { data: [], next_page: null } }));
    await expect(refused.client.list('project', { limit: 500 } as never)).rejects.toMatchObject({ code: 'CONFIGURATION' });
    expect(refused.calls).toHaveLength(0);

    const ok = makeClient(() => ({ body: { data: [], next_page: null } }));
    await ok.client.list('project', { limit: 100 } as never);
    expect(ok.calls[0]!.query.get('per_page')).toBe('100');
  });

  it('cursor is the next page NUMBER; non-numeric cursors are refused before any request', async () => {
    const { client, calls } = makeClient((req) => {
      if (req.query.get('page') === '2') return { body: { data: [], next_page: null } };
      return { body: { data: [databaseFixture('postgresql')], current_page: 1, next_page: 2 } };
    });
    const page1 = await client.list('project', {} as never);
    expect(page1.cursor).toBe('2');
    await client.list('project', { cursor: page1.cursor! } as never);
    expect(calls[1]!.query.get('page')).toBe('2');
    const bad = makeClient(() => ({ body: { data: [], next_page: null } }));
    await expect(bad.client.list('project', { cursor: 'opaque-token' } as never)).rejects.toMatchObject({ code: 'CONFIGURATION' });
    expect(bad.calls).toHaveLength(0);
  });

  it('raw.clusterSizeSkus returns the official array UNFILTERED (code matches comment, F7)', async () => {
    const { adapter, calls } = makeClient(() => ({
      body: [
        { name: 'PS_10', enabled: true, engine: 'postgresql' },
        { name: 'PS_5', enabled: false, engine: 'postgresql' },
      ],
    }));
    const skus = await (adapter.raw as PlanetScaleManagementRaw).clusterSizeSkus();
    expect(skus).toHaveLength(2); // disabled entries are NOT dropped by the adapter
    expect(calls[0]!.query.get('engine')).toBe('postgresql'); // official default is mysql — always explicit
  });

  it('auth header is the exact two-part token, never Bearer', async () => {
    const { client, calls } = makeClient(() => OK_DB());
    await client.get({ kind: 'project', id: 'app-db' } as never);
    expect(calls[0]!.headers['authorization']).toBe(`${TOKEN_ID}:${TOKEN_SECRET}`);
  });

  it('429 maps to RATE_LIMIT with retryAfterMs and there is NO automatic retry', async () => {
    const { client, calls } = makeClient(() => ({ status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '2' } }));
    await expect(client.get({ kind: 'project', id: 'app-db' } as never)).rejects.toMatchObject({
      code: 'RATE_LIMIT', retryAfterMs: 2000,
    });
    expect(calls).toHaveLength(1);
  });

  it('caller abort maps to ABORTED; 5xx mutation is indeterminate with exactly one request', async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = makeClient(() => OK_DB());
    await expect(aborted.client.get({ kind: 'project', id: 'app-db' } as never, { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'ABORTED' });

    const flaky = makeClient((req) => {
      if (req.method === 'PATCH') return { status: 503, body: { message: 'down' } };
      return OK_DB();
    });
    await expect(flaky.client.update({ kind: 'project', id: 'app-db', patch: { name: 'x' } } as never))
      .rejects.toMatchObject({ code: 'PROVIDER', indeterminate: true });
    expect(flaky.calls.map((c) => c.method)).toEqual(['GET', 'PATCH']); // pre-flight + exactly one PATCH, no retry
  });

  it('malformed JSON 200 on a GET is a truthful PROVIDER error; 204 deletes map to operation null', async () => {
    const malformedFetch: FetchLike = async () =>
      new Response('{"broken":', { status: 200, headers: { 'content-type': 'application/json' } });
    const mClient = createManagement({
      adapter: planetscaleManagement({ tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET, organization: ORG, fetch: malformedFetch }),
    });
    await expect(mClient.get({ kind: 'project', id: 'app-db' } as never)).rejects.toMatchObject({ code: 'PROVIDER' });

    const deleted = makeClient((req) => (req.method === 'DELETE' ? { status: 204 } : OK_DB()));
    const result = await deleted.client.delete({ kind: 'project', id: 'app-db' } as never);
    expect(result.operation).toBeNull();
    expect(result.indeterminate).toBe(false);
  });

  it('real GET bounded readiness: wait() on a pending database times out with GET-only polls; no invented fields', async () => {
    const { client, calls } = makeClient(() => ({
      body: databaseFixture('postgresql', { ready: false, state: 'pending', region: undefined }),
    }));
    await expect(client.wait({ kind: 'project', id: 'app-db' } as never, { timeoutMs: 250, pollIntervalMs: 10 }))
      .rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);

    const once = makeClient(() => ({ body: databaseFixture('postgresql', { ready: false, state: 'pending', region: undefined }) }));
    const resource = await once.client.get({ kind: 'project', id: 'app-db' } as never);
    expect(resource.status).toBe('creating');
    expect(resource.providerStatus).toBe('pending');
    expect(resource.region).toBeNull(); // missing field is null, never invented
  });
});

// ===========================================================================
// Local PostgreSQL 17 leg (env-gated): driver compatibility ONLY — unique schema,
// cleaned up; proves nothing about hosted PlanetScale TLS.
// ===========================================================================

const URL_ENV = 'DBSDK_TEST_POSTGRES_URL';
const hasServer = Boolean(process.env[URL_ENV]);
const live = hasServer ? describe : describe.skip;
const TEST_SCHEMA = 'dbsdk_ps_r4_accept';

live('R4-local — real PostgreSQL 17 wire compatibility through the public adapters', () => {
  beforeAll(async () => {
    const setup = planetscale({
      connectionString: process.env[URL_ENV]!, connectionMode: 'direct', allowModeMismatch: true, ssl: false,
    });
    await setup.query(`create schema if not exists ${TEST_SCHEMA}`);
    await setup.query(`create table if not exists ${TEST_SCHEMA}.r4_items (id int primary key, label text)`);
    await setup.close();
  });

  afterAll(async () => {
    const teardown = planetscale({
      connectionString: process.env[URL_ENV]!, connectionMode: 'direct', allowModeMismatch: true, ssl: false,
    });
    await teardown.query(`drop schema if exists ${TEST_SCHEMA} cascade`);
    await teardown.close();
  });

  it('PlanetScale adapter (direct): parameterized writes, transactions, rollback over the real wire', async () => {
    const db = planetscale({
      connectionString: process.env[URL_ENV]!, connectionMode: 'direct', allowModeMismatch: true, ssl: false,
    });
    await db.transaction!(async (tx) => {
      await tx.query(`insert into ${TEST_SCHEMA}.r4_items values ($1, $2)`, [1, 'committed']);
    });
    await expect(db.transaction!(async (tx) => {
      await tx.query(`insert into ${TEST_SCHEMA}.r4_items values ($1, $2)`, [2, 'rolled-back']);
      throw new Error('force rollback');
    })).rejects.toThrow('force rollback');
    const result = await db.query<{ id: number; label: string }>(`select id, label from ${TEST_SCHEMA}.r4_items`);
    expect(result.rows).toEqual([{ id: 1, label: 'committed' }]);
    await db.close();
  });

  it('PlanetScale adapter (pooled against the local server): guard refuses multi-statement pre-dispatch, allows normal SQL', async () => {
    const db = planetscale({
      connectionString: process.env[URL_ENV]!, connectionMode: 'pooled', allowModeMismatch: true, ssl: false,
    });
    await expect(db.query('select 1; select 2')).rejects.toThrow(/multiple SQL statements/);
    const result = await db.query<{ one: number }>('select $1::int as one', [1]);
    expect(result.rows).toEqual([{ one: 1 }]);
    await db.close();
  });

  it('generic postgres adapter still works after the narrow F3 guard', async () => {
    const db = postgres({ connectionString: process.env[URL_ENV]!, max: 2 } as never);
    const result = await db.query<{ one: number }>('select $1::int as one', [41]);
    expect(result.rows).toEqual([{ one: 41 }]);
    await db.close();
  });
});
