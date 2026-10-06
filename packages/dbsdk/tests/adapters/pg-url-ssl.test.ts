/**
 * Shared connection-string SSL directive handling (src/adapters/pg-url-ssl.ts).
 *
 * Two layers of proof:
 * 1. Unit tests over the directive collector / resolver / narrow guard.
 * 2. END-TO-END tests against the INSTALLED `pg` driver (no network): the pool config
 *    produced by each adapter is fed into a real `new PgClient(config)` and the driver's
 *    own parsed `connectionParameters.ssl` is inspected — proving the FINAL driver
 *    configuration (not just the adapter's options) honors the policy. This is the exact
 *    override vector review finding F3 demonstrated on pg 8.23.1 / pg-connection-string
 *    2.14.1 (`?sslmode=disable` → ssl:false; `?sslmode=require` → explicit CA discarded).
 */

import { describe, expect, it } from 'vitest';
import { Client as PgClient } from 'pg';

import { postgres } from '../../src/adapters/postgres.js';
import { supabase } from '../../src/adapters/supabase.js';
import { planetscale, type PlanetScaleAdapterOptions } from '../../src/planetscale.js';
import {
  assertNoUrlSslOverride,
  collectUrlSslDirectives,
  resolveVerifiedTlsFromUrl,
  stripUrlSslParams,
} from '../../src/adapters/pg-url-ssl.js';
import { ConfigurationError } from '../../src/adapters/errors.js';
import type { PgPoolConfig } from '../../src/adapters/pg-engine.js';

/** Inspect the ssl value the INSTALLED pg driver would actually use for a pool config. */
function finalDriverSsl(config: PgPoolConfig): unknown {
  return (new PgClient(config as never) as unknown as { connectionParameters: { ssl: unknown } })
    .connectionParameters.ssl;
}

/** Capture the pool config an adapter builds (recording poolFactory, triggered by a query). */
async function captureConfig(build: (factory: (config: PgPoolConfig) => unknown) => { query: (text: string) => Promise<unknown> }): Promise<PgPoolConfig> {
  let captured: PgPoolConfig | undefined;
  const db = build((config) => {
    captured = config;
    return {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => undefined }),
      end: async () => undefined,
    };
  });
  await db.query('select 1'); // the pool is created lazily on first use
  if (!captured) throw new Error('pool factory was not invoked');
  return captured;
}

const REMOTE = 'postgresql://u:p@eu-central-useast1-1.horizon.psdb.cloud:5432/app-db';
const REMOTE_NO_PORT = 'postgresql://u:p@db.abcdefghij.supabase.co/app-db';

describe('pg-url-ssl — directive collection', () => {
  it('collects ssl-affecting params case-insensitively, with duplicates and values', () => {
    const url = new URL(`${REMOTE}?sslmode=DISABLE&SSLMODE=require&ssl=true&uselibpqcompat=TRUE&app=1`);
    const directives = collectUrlSslDirectives(url);
    expect(directives.all).toEqual([
      { key: 'sslmode', value: 'DISABLE' },
      { key: 'sslmode', value: 'require' },
      { key: 'ssl', value: 'true' },
      { key: 'uselibpqcompat', value: 'TRUE' },
    ]);
    expect(directives.modes).toEqual(['disable', 'require']);
    expect(directives.sslValues).toEqual(['true']);
    expect(directives.fileParams).toEqual([]);
  });

  it('identifies file-loading params', () => {
    const url = new URL(`${REMOTE}?sslcert=/tmp/c.pem&sslkey=/tmp/k.key&sslrootcert=/tmp/ca.pem`);
    expect(collectUrlSslDirectives(url).fileParams).toEqual(['sslcert', 'sslkey', 'sslrootcert']);
  });

  it('reports no directives for a plain URL', () => {
    expect(collectUrlSslDirectives(new URL(REMOTE)).all).toEqual([]);
  });

  it('strips ssl params (any casing) while preserving other params and credentials', () => {
    const url = new URL(`${REMOTE}?sslmode=disable&application_name=dbsdk&SSLCERT=/tmp/c.pem`);
    const stripped = stripUrlSslParams(url);
    expect(stripped).toContain('application_name=dbsdk');
    expect(stripped).not.toContain('sslmode');
    expect(stripped).not.toContain('sslcert');
    expect(stripped.startsWith('postgresql://u:p@')).toBe(true); // credentials untouched
  });
});

describe('pg-url-ssl — verified-TLS resolution (PlanetScale policy)', () => {
  const base = { adapter: 'planetscale', isLocal: false };

  it('returns the explicit ssl option unchanged when the URL has no directives', () => {
    const explicit = { rejectUnauthorized: true, ca: 'CA' };
    expect(resolveVerifiedTlsFromUrl({ ...base, explicitSsl: explicit, directives: collectUrlSslDirectives(new URL(REMOTE)) })).toBe(explicit);
    expect(
      resolveVerifiedTlsFromUrl({ ...base, explicitSsl: undefined, directives: collectUrlSslDirectives(new URL(REMOTE)) }),
    ).toBeUndefined();
  });

  it('sslmode=require/verify-full without explicit ssl resolve to verified TLS', () => {
    for (const mode of ['require', 'verify-full', 'REQUIRE']) {
      const resolved = resolveVerifiedTlsFromUrl({
        ...base,
        explicitSsl: undefined,
        directives: collectUrlSslDirectives(new URL(`${REMOTE}?sslmode=${mode}`)),
      });
      expect(resolved).toEqual({ rejectUnauthorized: true });
    }
  });

  it('sslmode=require/verify-full KEEPS the explicit ssl object (CA not discarded)', () => {
    const explicit = { rejectUnauthorized: true, ca: 'CA' };
    const resolved = resolveVerifiedTlsFromUrl({
      ...base,
      explicitSsl: explicit,
      directives: collectUrlSslDirectives(new URL(`${REMOTE}?sslmode=require`)),
    });
    expect(resolved).toBe(explicit);
  });

  it('sslmode=disable is refused on remote hosts and allowed on localhost', () => {
    expect(() =>
      resolveVerifiedTlsFromUrl({ ...base, explicitSsl: undefined, directives: collectUrlSslDirectives(new URL(`${REMOTE}?sslmode=disable`)) }),
    ).toThrow(/requires TLS|unencrypted|sslmode=disable/i);
    const local = resolveVerifiedTlsFromUrl({
      adapter: 'planetscale',
      isLocal: true,
      explicitSsl: undefined,
      directives: collectUrlSslDirectives(new URL('postgresql://u:p@localhost:5432/db?sslmode=disable')),
    });
    expect(local).toBe(false);
  });

  it('sslmode=disable conflicts with an explicit TLS configuration', () => {
    expect(() =>
      resolveVerifiedTlsFromUrl({
        ...base,
        explicitSsl: { rejectUnauthorized: true, ca: 'CA' },
        directives: collectUrlSslDirectives(new URL(`${REMOTE}?sslmode=disable`)),
      }),
    ).toThrow(/conflict|plaintext|TLS/i);
  });

  it('refuses prefer/allow/verify-ca/unknown/empty sslmode values with an actionable error', () => {
    for (const mode of ['prefer', 'allow', 'verify-ca', 'nope', '']) {
      expect(() =>
        resolveVerifiedTlsFromUrl({ ...base, explicitSsl: undefined, directives: collectUrlSslDirectives(new URL(`${REMOTE}?sslmode=${mode}`)) }),
      ).toThrow(/sslmode|ssl option/i);
    }
  });

  it('refuses ambiguous ssl= values', () => {
    for (const value of ['', 'maybe', 'FALSE']) {
      expect(() =>
        resolveVerifiedTlsFromUrl({ ...base, explicitSsl: undefined, directives: collectUrlSslDirectives(new URL(`${REMOTE}?ssl=${value}`)) }),
      ).toThrow(/ssl=/);
    }
  });

  it('accepts ssl=true/1 as verified TLS and ssl=false/0 as local plaintext', () => {
    expect(
      resolveVerifiedTlsFromUrl({ ...base, explicitSsl: undefined, directives: collectUrlSslDirectives(new URL(`${REMOTE}?ssl=true`)) }),
    ).toEqual({ rejectUnauthorized: true });
    expect(
      resolveVerifiedTlsFromUrl({ ...base, explicitSsl: undefined, directives: collectUrlSslDirectives(new URL(`${REMOTE}?ssl=1`)) }),
    ).toEqual({ rejectUnauthorized: true });
    expect(() =>
      resolveVerifiedTlsFromUrl({ ...base, explicitSsl: undefined, directives: collectUrlSslDirectives(new URL(`${REMOTE}?ssl=0`)) }),
    ).toThrow(/unencrypted|requires TLS/i);
  });

  it('refuses conflicting duplicate directives (plaintext AND tls in one URL)', () => {
    expect(() =>
      resolveVerifiedTlsFromUrl({
        ...base,
        explicitSsl: undefined,
        directives: collectUrlSslDirectives(new URL(`${REMOTE}?sslmode=require&sslmode=disable`)),
      }),
    ).toThrow(/conflicting/);
  });

  it('refuses file-loading params, uselibpqcompat, and sslnegotiation outright', () => {
    for (const qs of ['sslcert=/tmp/c.pem', 'sslrootcert=/tmp/ca.pem', 'uselibpqcompat=true', 'sslnegotiation=direct']) {
      expect(() =>
        resolveVerifiedTlsFromUrl({ ...base, explicitSsl: undefined, directives: collectUrlSslDirectives(new URL(`${REMOTE}?${qs}`)) }),
      ).toThrow(ConfigurationError);
    }
  });
});

describe('pg-url-ssl — narrow override guard (postgres/supabase policy)', () => {
  const directivesOf = (qs: string) => collectUrlSslDirectives(new URL(`${REMOTE}?${qs}`));

  it('refuses URL directives combined with an explicit ssl option (either source)', () => {
    expect(() =>
      assertNoUrlSslOverride({ adapter: 'postgres', directives: directivesOf('sslmode=require'), explicitSsl: { ca: 'CA' } }),
    ).toThrow(/silently|source of truth/);
    expect(() =>
      assertNoUrlSslOverride({ adapter: 'postgres', directives: directivesOf('sslmode=disable'), explicitSsl: undefined, poolSsl: false }),
    ).toThrow(/silently|source of truth/);
  });

  it('allows URL directives alone (native pg parsing, incl. documented verify-full)', () => {
    expect(() =>
      assertNoUrlSslOverride({ adapter: 'postgres', directives: directivesOf('sslmode=verify-full'), explicitSsl: undefined }),
    ).not.toThrow();
    expect(() => assertNoUrlSslOverride({ adapter: 'postgres', directives: directivesOf(''), explicitSsl: { ca: 'CA' } })).not.toThrow();
  });
});

describe('pg-url-ssl — END-TO-END against the installed pg driver (final driver config)', () => {
  it('planetscale: ?sslmode=disable on a remote host is REFUSED before any pool exists', () => {
    expect(() => planetscale({ connectionString: `${REMOTE}?sslmode=disable`, connectionMode: 'direct' })).toThrow(
      /requires TLS|unencrypted/i,
    );
  });

  it('planetscale: ?sslmode=disable + explicit verified TLS is refused (no silent override)', () => {
    expect(() =>
      planetscale({ connectionString: `${REMOTE}?sslmode=disable`, connectionMode: 'direct', ssl: { rejectUnauthorized: true } }),
    ).toThrow(/plaintext|TLS/i);
  });

  it('planetscale: ?sslmode=require keeps the explicit CA — the FINAL driver config still verifies with it', async () => {
    const config = await captureConfig((factory) =>
      planetscale({
        connectionString: `${REMOTE}?sslmode=require&application_name=e2e`,
        connectionMode: 'direct',
        ssl: { rejectUnauthorized: true, ca: 'dummy-ca' },
        poolFactory: factory as never,
      }),
    );
    expect(config.ssl).toEqual({ rejectUnauthorized: true, ca: 'dummy-ca' });
    // The decisive check: what the DRIVER ends up using.
    expect(finalDriverSsl(config)).toEqual({ rejectUnauthorized: true, ca: 'dummy-ca' });
    // The URL handed to pg no longer carries the sslmode param (other params preserved).
    expect(config.connectionString).toContain('application_name=e2e');
    expect(config.connectionString).not.toContain('sslmode');
  });

  it('planetscale: ?sslmode=verify-full with no explicit ssl yields verified TLS in the final driver config', async () => {
    const config = await captureConfig((factory) =>
      planetscale({
        connectionString: `${REMOTE}?sslmode=verify-full`,
        connectionMode: 'direct',
        poolFactory: factory as never,
      }),
    );
    expect(finalDriverSsl(config)).toEqual({ rejectUnauthorized: true });
  });

  it('planetscale: ?sslcert=... is refused before the driver can read files from disk', () => {
    expect(() => planetscale({ connectionString: `${REMOTE}?sslcert=/nonexistent/dbsdk-test.pem`, connectionMode: 'direct' })).toThrow(
      /sslcert|ssl option/i,
    );
  });

  it('planetscale: ?sslmode=prefer and ?uselibpqcompat=true are refused with actionable errors', () => {
    expect(() => planetscale({ connectionString: `${REMOTE}?sslmode=prefer`, connectionMode: 'direct' })).toThrow(/sslmode/);
    expect(() => planetscale({ connectionString: `${REMOTE}?uselibpqcompat=true`, connectionMode: 'direct' })).toThrow(/uselibpqcompat/);
  });

  it('planetscale: the pool escape hatch cannot produce a plaintext remote config (final-net check)', () => {
    expect(() =>
      planetscale({
        connectionString: REMOTE,
        connectionMode: 'direct',
        pool: { ssl: false },
      }),
    ).toThrow(/ssl: false|requires TLS/i);
  });

  it('planetscale: localhost keeps no-TLS default; ?sslmode=disable on localhost is accepted', async () => {
    const plain = await captureConfig((factory) =>
      planetscale({
        connectionString: 'postgresql://postgres:pw@localhost:15432/dbsdk?sslmode=disable',
        connectionMode: 'direct',
        allowModeMismatch: true,
        poolFactory: factory as never,
      }),
    );
    expect(plain.ssl).toBe(false);
  });

  it('postgres: URL directives + explicit ssl are refused; directives alone keep native parsing', async () => {
    expect(() => postgres({ connectionString: `${REMOTE_NO_PORT}?sslmode=disable`, ssl: { rejectUnauthorized: true } })).toThrow(
      /silently|source of truth/,
    );
    const config = await captureConfig((factory) =>
      postgres({ connectionString: `${REMOTE_NO_PORT}?sslmode=verify-full`, poolFactory: factory as never }),
    );
    expect(finalDriverSsl(config)).toEqual({}); // native pg behavior preserved (verified TLS via node defaults)
  });

  it('supabase: URL directives + explicit ssl are refused; explicit ssl alone still works', async () => {
    expect(() =>
      supabase({ connectionString: `${REMOTE_NO_PORT}?sslmode=verify-full`, connectionMode: 'direct', ssl: { ca: 'CA' } }),
    ).toThrow(/silently|source of truth/);
    const config = await captureConfig((factory) =>
      supabase({
        connectionString: REMOTE_NO_PORT,
        connectionMode: 'direct',
        ssl: { rejectUnauthorized: true, ca: 'CA' },
        poolFactory: factory as never,
      }),
    );
    expect(finalDriverSsl(config)).toEqual({ rejectUnauthorized: true, ca: 'CA' });
  });
});

// Type-level import guard: the planetscale options type is part of the public surface used above.
const _optionsType: PlanetScaleAdapterOptions['connectionMode'] = 'direct';
void _optionsType;
