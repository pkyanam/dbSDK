/**
 * Neon HTTP transport integration — runs against a real local Neon proxy
 * (ghcr.io/timowilhelm/local-neon-http-proxy) in front of a local Postgres.
 * This exercises the actual HTTP protocol the @neondatabase/serverless driver
 * uses, including the native non-interactive atomic batch.
 *
 *   DBSDK_TEST_NEON_CONNECTION_STRING='postgres://postgres:dbsdk@db.localtest.me:5432/dbsdk'
 *   DBSDK_TEST_NEON_HTTP_ENDPOINT='http://localhost:14444/sql'
 *   npx vitest run tests/adapters/neon.live.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { neonConfig } from '@neondatabase/serverless';

import { neon } from '../../src/adapters/neon.js';

const hasEndpoint = Boolean(
  process.env.DBSDK_TEST_NEON_HTTP_ENDPOINT && process.env.DBSDK_TEST_NEON_CONNECTION_STRING,
);
const d = hasEndpoint ? describe : describe.skip;

if (hasEndpoint) {
  // Local proxy: plain HTTP, fixed endpoint (same override pattern the Neon
  // proxy docs prescribe for local development).
  const endpoint = process.env.DBSDK_TEST_NEON_HTTP_ENDPOINT!;
  neonConfig.fetchEndpoint = () => endpoint;
  neonConfig.useSecureWebSocket = false;
}

d('neon adapter — live HTTP transport via local proxy', () => {
  let db: ReturnType<typeof neon>;

  const TABLE = 'dbsdk_neon_live_test';

  beforeAll(async () => {
    db = neon({
      connectionString: process.env.DBSDK_TEST_NEON_CONNECTION_STRING!,
    });
    await db.query(`drop table if exists ${TABLE}`);
    await db.query(`create table ${TABLE} (id serial primary key, email text not null)`);
  });

  afterAll(async () => {
    await db.query(`drop table if exists ${TABLE}`);
    await db.close();
  });

  it('runs parameterized one-shot queries over HTTP', async () => {
    const result = await db.query<{ id: number }>(
      `insert into ${TABLE} (email) values ($1) returning id`,
      ['http@live.test'],
    );
    expect(result.command).toBe('INSERT');
    expect(result.rowCount).toBe(1);
    expect(typeof result.rows[0]!.id).toBe('number');
  });

  it('runs a native atomic batch in a single HTTP transaction', async () => {
    const results = await db.batch!([
      { text: `insert into ${TABLE} (email) values ($1)`, params: ['batch@live.test'] },
      { text: `insert into ${TABLE} (email) values ($1)`, params: ['batch2@live.test'] },
      { text: `select count(*)::int as n from ${TABLE}`, params: [] },
    ]);

    expect(results).toHaveLength(3);
    expect(results[2]!.rows[0]!.n).toBe(3);

    // A failing batch rolls back everything and reports a real Postgres error.
    await expect(
      db.batch!([
        { text: `insert into ${TABLE} (email) values ($1)`, params: ['rolledback@live.test'] },
        { text: `insert into ${TABLE} (id, email) values (null, $1)`, params: ['x@live.test'] },
      ]),
    ).rejects.toMatchObject({ code: '23502' });

    const after = await db.query<{ n: number }>(
      `select count(*)::int as n from ${TABLE} where email = 'rolledback@live.test'`,
    );
    expect(after.rows[0]!.n).toBe(0);
  });

  it('refuses interactive transactions before dispatch over HTTP', async () => {
    await expect(
      db.transaction!(async () => {
        throw new Error('callback must never run');
      }),
    ).rejects.toThrow(/interactive transactions are not supported over HTTP/);
  });
});
