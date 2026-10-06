/**
 * SSL option type regressions (web round 5 defect, fixed in the release-fix round):
 * the documented secure setup `ssl: { ca }` — with or without an explicit
 * `rejectUnauthorized` — must type-check against every adapter's public options
 * and the `pool` escape hatch. Previously `ssl` was typed
 * `boolean | { rejectUnauthorized: boolean }`, so any CA configuration was a
 * compile error (TS2353/TS2322) even though the runtime handled it.
 */

import { describe, expectTypeOf, it } from 'vitest';

import type { PgPoolConfig, PgSslOptions } from '../../src/adapters/pg-engine.js';
import type { PostgresAdapterOptions } from '../../src/adapters/postgres.js';
import type { SupabaseAdapterOptions } from '../../src/adapters/supabase.js';
import type { NeonAdapterOptions } from '../../src/adapters/neon.js';

const CA = '-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n';

const SUPABASE_BASE = {
  connectionString: 'postgresql://postgres.abcdefghijklmnopqrst@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
  connectionMode: 'session',
} as const;

const NEON_BASE = {
  connectionString: 'postgresql://user:pass@ep-example-123456.us-east-2.aws.neon.tech/neondb',
  transactionTransport: 'postgres',
  postgresConnectionString: 'postgresql://user:pass@ep-example-123456-pooler.us-east-2.aws.neon.tech/neondb',
} as const;

describe('SSL option types accept certificate CA configuration', () => {
  it('accepts ssl: { ca } on the supabase adapter (the documented secure setup)', () => {
    const options: SupabaseAdapterOptions = { ...SUPABASE_BASE, ssl: { ca: CA } };
    expectTypeOf(options.ssl).toEqualTypeOf<boolean | PgSslOptions | undefined>();
  });

  it('accepts ssl: { ca, rejectUnauthorized: true } on the supabase adapter', () => {
    const options: SupabaseAdapterOptions = {
      ...SUPABASE_BASE,
      ssl: { ca: CA, rejectUnauthorized: true },
    };
    expectTypeOf(options.ssl).toEqualTypeOf<boolean | PgSslOptions | undefined>();
  });

  it('accepts pool: { ssl: { ca } } through the supabase escape hatch', () => {
    const options: SupabaseAdapterOptions = { ...SUPABASE_BASE, pool: { ssl: { ca: CA } } };
    expectTypeOf(options.pool).toEqualTypeOf<PgPoolConfig | undefined>();
  });

  it('accepts CA configuration on the postgres and neon adapters', () => {
    const pgOptions: PostgresAdapterOptions = {
      connectionString: 'postgres://user:pass@localhost:5432/db',
      ssl: { ca: CA },
    };
    const neonOptions: NeonAdapterOptions = { ...NEON_BASE, ssl: { ca: CA, rejectUnauthorized: true } };
    expectTypeOf(pgOptions.ssl).toEqualTypeOf<boolean | PgSslOptions | undefined>();
    expectTypeOf(neonOptions.ssl).toEqualTypeOf<boolean | PgSslOptions | undefined>();
  });

  it('accepts ssl: { ca } directly on PgPoolConfig', () => {
    const config: PgPoolConfig = { ssl: { ca: CA } };
    const withBuffer: PgPoolConfig = { ssl: { ca: Buffer.from(CA) } };
    expectTypeOf(config.ssl).toEqualTypeOf<boolean | PgSslOptions | undefined>();
    expectTypeOf(withBuffer.ssl).toEqualTypeOf<boolean | PgSslOptions | undefined>();
  });

  it('still accepts the previous forms without behavior change', () => {
    const off: SupabaseAdapterOptions = { ...SUPABASE_BASE, ssl: false };
    const optOut: SupabaseAdapterOptions = { ...SUPABASE_BASE, ssl: { rejectUnauthorized: false } };
    const on: SupabaseAdapterOptions = { ...SUPABASE_BASE, ssl: true };
    const plainTlsObject: PgSslOptions = { rejectUnauthorized: false };
    expectTypeOf(off).toMatchTypeOf<SupabaseAdapterOptions>();
    expectTypeOf(optOut).toMatchTypeOf<SupabaseAdapterOptions>();
    expectTypeOf(on).toMatchTypeOf<SupabaseAdapterOptions>();
    expectTypeOf(plainTlsObject).toEqualTypeOf<PgSslOptions>();
  });
});
