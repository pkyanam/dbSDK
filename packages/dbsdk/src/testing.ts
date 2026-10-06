/**
 * Fixture testing adapter (`dbsdk/testing`).
 *
 * Deterministic, scripted query→result matching for tests — NOT an in-memory SQL engine.
 * It cannot prove transaction semantics, SQL correctness, or real adapter behavior; it proves
 * what the core client does with the results, errors, and capabilities the adapter declares.
 *
 * Features:
 * - Fixtures match by exact statement text (whitespace-normalized) or RegExp, with optional
 *   deep parameter matching.
 * - Fixtures are single-use by default (`repeat: true` allows re-matching) so scripts are
 *   deterministic and accidental double-execution of writes is caught.
 * - Error fixtures throw the given error as-is; the core client normalizes it.
 * - Every executed query is recorded on `raw.queries` for assertions.
 * - A query that matches no fixture throws DbError code 'UNKNOWN' (loud failure).
 */

import { DbError } from './errors.js';
import { createDatabase } from './core/database.js';
import type {
  DatabaseAdapter,
  DatabaseAdapterCapabilities,
  QueryExecutor,
  QueryResult,
  SqlStatement,
} from './types.js';

export type QueryFixture = {
  /** Exact statement text (whitespace-normalized) or RegExp tested against the normalized text. */
  match: string | RegExp;
  /** When present, the fixture only matches queries whose parameters are deeply equal to this. */
  params?: readonly unknown[];
  rows?: readonly Record<string, unknown>[];
  rowCount?: number | null;
  command?: string;
  /** Allow the fixture to match repeatedly. Default: single-use. */
  repeat?: boolean;
};

export type ErrorFixture = {
  match: string | RegExp;
  params?: readonly unknown[];
  /** Thrown as-is by the fixture adapter; the dbSDK client normalizes it into a DbError. */
  error: unknown;
  repeat?: boolean;
};

export type Fixture = QueryFixture | ErrorFixture;

export type RecordedQuery = {
  text: string;
  params: readonly unknown[];
  /** True when the query was executed inside a transaction callback. */
  inTransaction: boolean;
};

export type FixtureAdapterOptions = {
  id?: string;
  capabilities?: Partial<Omit<DatabaseAdapterCapabilities, 'evidence'>>;
  evidence?: Readonly<Record<string, DatabaseAdapterCapabilities['evidence'][string]>>;
  fixtures?: readonly Fixture[];
  /** Throw when a query matches no fixture (default true). */
  requireMatch?: boolean;
  onQuery?: (query: RecordedQuery) => void;
};

export type FixtureAdapterRaw = {
  queries: readonly RecordedQuery[];
  fixtures: readonly Fixture[];
};

const DEFAULT_CAPABILITIES: DatabaseAdapterCapabilities = {
  interactiveTransactions: true,
  atomicBatch: true,
  sessionState: true,
  transport: 'tcp',
  evidence: {
    query: 'tests',
    interactiveTransactions: 'tests',
    atomicBatch: 'tests',
    sessionState: 'tests',
  },
};

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const recordA = a as Record<string, unknown>;
  const recordB = b as Record<string, unknown>;
  const keysA = Object.keys(recordA);
  const keysB = Object.keys(recordB);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => key in recordB && deepEqual(recordA[key], recordB[key]));
}

interface FixtureState {
  readonly fixture: Fixture;
  matched: boolean;
}

function isMatch(state: FixtureState, text: string, params: readonly unknown[]): boolean {
  if (state.matched) return false;
  const fixture = state.fixture;
  const normalized = normalizeText(text);
  if (typeof fixture.match === 'string') {
    if (normalizeText(fixture.match) !== normalized) return false;
  } else if (!fixture.match.test(normalized)) {
    return false;
  }
  if (fixture.params !== undefined && !deepEqual(fixture.params, params)) return false;
  return true;
}

function isQueryFixture(fixture: Fixture): fixture is QueryFixture {
  return !('error' in fixture);
}

function commandFromText(text: string): string | undefined {
  const word = text.trimStart().split(/\s+/)[0];
  return word ? word.toUpperCase() : undefined;
}

export type FixtureAdapter = DatabaseAdapter<FixtureAdapterRaw> & {
  /** Prepend fixtures at runtime (useful for multi-phase tests). */
  addFixtures(fixtures: readonly Fixture[]): void;
};

export function createFixtureAdapter(options: FixtureAdapterOptions = {}): FixtureAdapter {
  const id = options.id ?? 'fixture';
  const requireMatch = options.requireMatch ?? true;
  const capabilities: DatabaseAdapterCapabilities = {
    ...DEFAULT_CAPABILITIES,
    ...options.capabilities,
    evidence: options.evidence ?? DEFAULT_CAPABILITIES.evidence,
  };
  const states: FixtureState[] = (options.fixtures ?? []).map((fixture) => ({ fixture, matched: false }));
  const queries: RecordedQuery[] = [];

  function record(text: string, params: readonly unknown[], inTransaction: boolean): void {
    const entry: RecordedQuery = { text, params, inTransaction };
    queries.push(entry);
    options.onQuery?.(entry);
  }

  function takeFixture(text: string, params: readonly unknown[]): Fixture {
    const state = states.find((candidate) => isMatch(candidate, text, params));
    if (!state) {
      throw new DbError(
        `No fixture matched query: ${normalizeText(text)}`,
        { code: 'UNKNOWN', adapterId: id, retryable: false, indeterminate: false },
      );
    }
    state.matched = !state.fixture.repeat;
    return state.fixture;
  }

  function execute(
    text: string,
    params: readonly unknown[],
    inTransaction: boolean,
  ): QueryResult {
    record(text, params, inTransaction);
    const fixture = takeFixture(text, params);
    if (!isQueryFixture(fixture)) {
      throw fixture.error;
    }
    const rows = [...(fixture.rows ?? [])];
    return {
      rows,
      rowCount: fixture.rowCount ?? (fixture.rows === undefined ? null : rows.length),
      command: fixture.command ?? commandFromText(text),
    };
  }

  function queryFn(
    inTransaction: boolean,
  ): <Row>(text: string, params?: readonly unknown[]) => Promise<QueryResult<Row>> {
    return async <Row>(text: string, params?: readonly unknown[]) =>
      execute(text, params ?? [], inTransaction) as QueryResult<Row>;
  }

  let closed = false;

  const adapter: FixtureAdapter = {
    id,
    engine: 'postgresql',
    capabilities,
    query: queryFn(false),

    async transaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T> {
      // The fixture adapter does not emulate BEGIN/COMMIT/ROLLBACK; it cannot prove
      // transaction semantics. It only scopes the executor and records `inTransaction`.
      const tx: QueryExecutor = {
        query: queryFn(true),
      };
      return fn(tx);
    },

    async batch(statements: readonly SqlStatement[]): Promise<QueryResult[]> {
      // Sequential execution; the fixture cannot prove real atomicity.
      return statements.map((statement) =>
        execute(statement.text, statement.params ?? [], false),
      );
    },

    async close(): Promise<void> {
      closed = true;
    },

    raw: {
      get queries(): readonly RecordedQuery[] {
        return queries;
      },
      /** Live view: reflects fixtures added via `addFixtures` at runtime. */
      get fixtures(): readonly Fixture[] {
        return states.map((state) => state.fixture);
      },
    },

    addFixtures(fixtures: readonly Fixture[]): void {
      states.push(...fixtures.map((fixture) => ({ fixture, matched: false })));
    },
  };

  // Guard: closed fixture adapter refuses queries before dispatch, like real adapters.
  const originalQuery = adapter.query;
  adapter.query = (async (text: string, params?: readonly unknown[]) => {
    if (closed) {
      throw new DbError(`Adapter "${id}" is closed.`, {
        code: 'CONNECTION',
        adapterId: id,
        retryable: false,
        indeterminate: false,
      });
    }
    return originalQuery(text, params);
  }) as typeof adapter.query;

  return adapter;
}

/** Convenience: a full dbSDK client over a fixture adapter. */
export function createFixtureDatabase(options: FixtureAdapterOptions = {}) {
  return createDatabase({ adapter: createFixtureAdapter(options) });
}
