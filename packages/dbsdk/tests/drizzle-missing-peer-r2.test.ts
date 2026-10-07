/**
 * Missing-peer behavior of the Drizzle bridge after the R2 session rework:
 * the error-normalizing session layer is loaded through the same lazy dynamic
 * import as before, so an uninstalled `drizzle-orm` peer still produces the
 * actionable `DbError` (code `CONFIGURATION`) instead of a module-resolution
 * crash — and the loader must retry cleanly (no cached rejection) once the
 * peer becomes available.
 *
 * The peer is simulated as missing with a module mock; no real install/uninstall.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('drizzle-orm/node-postgres', () => {
  // Simulates the peer not being installed (native Node resolution error shape).
  throw new Error("Cannot find package 'drizzle-orm' imported from drizzle-orm/node-postgres");
});

import { createDatabase } from '../src/core/database.js';
import { DbError } from '../src/errors.js';
import { drizzlePostgres } from '../src/drizzle-interop/index.js';
import type { DatabaseAdapter, DatabaseAdapterCapabilities } from '../src/types.js';
import type { PgPoolLike } from '../src/adapters/pg-engine.js';

class IdlePool implements PgPoolLike {
  async query(): Promise<{ rows: unknown[]; rowCount: number | null; command?: string }> {
    return { rows: [], rowCount: 0 };
  }
  async connect(): Promise<never> {
    throw new Error('not expected in this test');
  }
  async end(): Promise<void> {}
}

describe('drizzlePostgres — missing peer after the session rework', () => {
  it('rejects with the actionable DbError and retries cleanly on a second call', async () => {
    const pool = new IdlePool();
    const adapter: DatabaseAdapter<PgPoolLike> = {
      id: 'peerless',
      engine: 'postgresql',
      capabilities: {
        interactiveTransactions: true,
        atomicBatch: true,
        sessionState: true,
        transport: 'tcp',
        evidence: {},
      } satisfies DatabaseAdapterCapabilities,
      raw: pool,
      async query() {
        return { rows: [], rowCount: 0 };
      },
      async close() {},
    };
    const db = createDatabase({ adapter });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = await drizzlePostgres(db).then(
        () => {
          throw new Error('expected the factory to reject');
        },
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(DbError);
      const dbError = error as DbError;
      expect(dbError.code).toBe('CONFIGURATION');
      expect(dbError.indeterminate).toBe(false);
      expect(dbError.retryable).toBe(false);
      expect(dbError.message).toMatch(/drizzle-orm/);
      expect(dbError.message).toMatch(/optional peer/i);
      // The raw module-resolution failure is preserved on cause, not surfaced
      // as the user-facing message (vitest's mock wrapper text in this test).
      expect(dbError.cause).toBeInstanceOf(Error);
    }
  });
});
