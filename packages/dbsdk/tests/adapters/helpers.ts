/**
 * Deterministic driver fixtures for adapter tests.
 *
 * These implement the structural pg surface (`PgPoolLike` / `PgClientLike`) the
 * adapters rely on — they record every query so tests can assert on transport
 * behavior (transaction leasing, rollback, release, prepared statement usage)
 * without a live server.
 */

import type { PgClientLike, PgPoolConfig, PgPoolLike, PgQueryOutput } from '../../src/adapters/pg-engine.js';

export type RecordedQuery = {
  text: string;
  values?: unknown[];
  /** 0 = pool-level query; n = the nth leased client. */
  client: number;
  /** True only if the caller asked for a reusable *named* prepared statement. */
  named: boolean;
};

export type FakeBehavior = {
  /** Return a result for matching SQL, or `undefined` to use the default empty result. */
  rows?: (text: string, values?: unknown[]) => Partial<PgQueryOutput> | undefined;
  /** Return an error to throw for matching SQL, or `undefined` to succeed. */
  fail?: (text: string, values?: unknown[]) => Error | undefined;
};

const DEFAULT_RESULT: PgQueryOutput = { rows: [], rowCount: 0, command: 'EXECUTE' };

export class FakeClient implements PgClientLike {
  readonly queries: RecordedQuery[] = [];
  released = false;

  constructor(
    private readonly pool: FakePool,
    readonly id: number,
    private readonly behavior?: FakeBehavior,
  ) {}

  async query(config: { text: string; values?: unknown[]; name?: string }): Promise<PgQueryOutput> {
    this.pool.record({ client: this.id, config });
    const error = this.behavior?.fail?.(config.text, config.values);
    if (error) {
      throw error;
    }
    const custom = this.behavior?.rows?.(config.text, config.values);
    return custom ? { ...DEFAULT_RESULT, ...custom } : DEFAULT_RESULT;
  }

  release(): void {
    this.released = true;
    this.pool.releasedCount += 1;
  }
}

export class FakePool implements PgPoolLike {
  readonly queries: RecordedQuery[] = [];
  readonly clients: FakeClient[] = [];
  releasedCount = 0;
  ended = false;

  constructor(
    readonly config: PgPoolConfig,
    private readonly behavior?: FakeBehavior,
  ) {}

  record({ client, config }: { client: number; config: { text: string; values?: unknown[]; name?: string } }): void {    this.queries.push({
      text: config.text,
      ...(config.values === undefined ? {} : { values: config.values }),
      client,
      named: config.name !== undefined,
    });
  }

  async query(config: { text: string; values?: unknown[]; name?: string }): Promise<PgQueryOutput> {
    this.record({ client: 0, config });
    const error = this.behavior?.fail?.(config.text, config.values);
    if (error) {
      throw error;
    }
    const custom = this.behavior?.rows?.(config.text, config.values);
    return custom ? { ...DEFAULT_RESULT, ...custom } : DEFAULT_RESULT;
  }

  async connect(): Promise<FakeClient> {
    const client = new FakeClient(this, this.clients.length + 1, this.behavior);
    this.clients.push(client);
    return client;
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  clientQueries(clientId: number): RecordedQuery[] {
    return this.queries.filter((q) => q.client === clientId);
  }
}
