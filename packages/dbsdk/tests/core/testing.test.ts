import { describe, expect, it, vi } from 'vitest';
import { createFixtureAdapter, createFixtureDatabase } from '../../src/testing.js';
import { isDbError } from '../../src/errors.js';

describe('createFixtureAdapter', () => {
  it('matches fixtures by exact statement text', async () => {
    const adapter = createFixtureAdapter({
      fixtures: [{ match: 'select * from users', rows: [{ id: 1 }] }],
    });
    const result = await adapter.query('select * from users', []);
    expect(result.rows).toEqual([{ id: 1 }]);
    expect(result.rowCount).toBe(1);
    expect(result.command).toBe('SELECT');
  });

  it('matches with whitespace normalization', async () => {
    const adapter = createFixtureAdapter({
      fixtures: [{ match: 'select   * from   users', rows: [] }],
    });
    const result = await adapter.query('select * from users', []);
    expect(result.rows).toEqual([]);
  });

  it('matches with regular expressions against the normalized text', async () => {
    const adapter = createFixtureAdapter({
      fixtures: [{ match: /^insert into users/i, rows: [] }],
    });
    await expect(adapter.query('INSERT INTO users (id) VALUES ($1)', [1])).resolves.toMatchObject({
      command: 'INSERT',
    });
  });

  it('matches params deeply when provided', async () => {
    const adapter = createFixtureAdapter({
      fixtures: [
        { match: 'select * from t where id = $1', params: [1], rows: [{ id: 1 }] },
        { match: 'select * from t where id = $1', params: [2], rows: [{ id: 2 }] },
      ],
    });
    await expect(adapter.query('select * from t where id = $1', [2])).resolves.toMatchObject({
      rows: [{ id: 2 }],
    });
  });

  it('treats fixtures as single-use by default and repeatable with repeat: true', async () => {
    const adapter = createFixtureAdapter({
      fixtures: [
        { match: 'insert into x (a) values ($1)', rows: [] },
        { match: 'select 1', rows: [], repeat: true },
      ],
    });
    await adapter.query('insert into x (a) values ($1)', [1]);
    await expect(adapter.query('insert into x (a) values ($1)', [1])).rejects.toMatchObject({
      code: 'UNKNOWN',
    });
    await adapter.query('select 1', []);
    await expect(adapter.query('select 1', [])).resolves.toBeDefined();
  });

  it('throws a loud DbError when no fixture matches', async () => {
    const adapter = createFixtureAdapter({ fixtures: [] });
    try {
      await adapter.query('select 42', []);
      expect.unreachable();
    } catch (error) {
      expect(isDbError(error)).toBe(true);
      if (isDbError(error)) {
        expect(error.code).toBe('UNKNOWN');
        expect(error.message).toContain('No fixture matched');
      }
    }
  });

  it('raw.fixtures reflects fixtures added at runtime (live view, not a stale snapshot)', () => {
    const adapter = createFixtureAdapter({ fixtures: [{ match: 'select 1', rows: [] }] });
    expect(adapter.raw.fixtures).toHaveLength(1);
    adapter.addFixtures([{ match: 'select 2', rows: [] }]);
    expect(adapter.raw.fixtures).toHaveLength(2);
    expect(adapter.raw.fixtures.map((f) => f.match)).toEqual(['select 1', 'select 2']);
  });

  it('throws error fixtures as-is', async () => {
    const driverError = Object.assign(new Error('duplicate key'), { code: '23505' });
    const adapter = createFixtureAdapter({
      fixtures: [{ match: 'insert into users (id) values ($1)', error: driverError }],
    });
    await expect(adapter.query('insert into users (id) values ($1)', [1])).rejects.toBe(driverError);
  });

  it('derives the command from the first keyword and honors explicit values', async () => {
    const adapter = createFixtureAdapter({
      fixtures: [
        { match: /^delete from t/i, rows: [{}, {}] },
        { match: 'select 1', rows: [], command: 'SELECT' },
      ],
    });
    await expect(adapter.query('DELETE FROM t WHERE x = $1', [1])).resolves.toMatchObject({
      command: 'DELETE',
      rowCount: 2,
    });
    await expect(adapter.query('select 1', [])).resolves.toMatchObject({ command: 'SELECT' });
  });

  it('returns rowCount null when rows are not specified', async () => {
    const adapter = createFixtureAdapter({
      fixtures: [{ match: 'select 1' }],
    });
    const result = await adapter.query('select 1', []);
    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBeNull();
  });

  it('records every query on raw.queries', async () => {
    const onQuery = vi.fn();
    const adapter = createFixtureAdapter({
      fixtures: [{ match: 'select 1', rows: [] }],
      onQuery,
    });
    await adapter.query('select 1', [5]);
    expect(adapter.raw.queries).toEqual([{ text: 'select 1', params: [5], inTransaction: false }]);
    expect(onQuery).toHaveBeenCalledWith({ text: 'select 1', params: [5], inTransaction: false });
  });

  it('scopes transaction queries and records them as inTransaction', async () => {
    const adapter = createFixtureAdapter({
      fixtures: [{ match: 'select 1', rows: [], repeat: true }],
    });
    await adapter.transaction!(async (tx) => {
      await tx.query('select 1', []);
      return null;
    });
    expect(adapter.raw.queries).toEqual([
      { text: 'select 1', params: [], inTransaction: true },
    ]);
  });

  it('rejects queries after close', async () => {
    const adapter = createFixtureAdapter();
    await adapter.close();
    await expect(adapter.query('select 1', [])).rejects.toMatchObject({ code: 'CONNECTION' });
  });

  it('respects capability overrides', () => {
    const adapter = createFixtureAdapter({
      capabilities: { interactiveTransactions: false, transport: 'http' },
    });
    expect(adapter.capabilities.interactiveTransactions).toBe(false);
    expect(adapter.capabilities.transport).toBe('http');
    expect(adapter.capabilities.atomicBatch).toBe(true);
  });

  it('supports runtime fixture additions', async () => {
    const adapter = createFixtureAdapter();
    adapter.addFixtures([{ match: 'select 2', rows: [{ n: 2 }] }]);
    await expect(adapter.query('select 2', [])).resolves.toMatchObject({ rows: [{ n: 2 }] });
  });
});

describe('createFixtureDatabase', () => {
  it('returns a full dbSDK client wired to the fixture adapter', async () => {
    const db = createFixtureDatabase({
      fixtures: [{ match: 'select * from users where id = $1', params: [1], rows: [{ id: 1 }] }],
    });
    const result = await db.sql<{ id: number }>`select * from users where id = ${1}`;
    expect(result.rows).toEqual([{ id: 1 }]);
    expect(db.raw.queries).toHaveLength(1);
    await db.close();
  });
});
