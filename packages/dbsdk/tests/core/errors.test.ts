/**
 * Error classification and indeterminate-outcome regressions (review round 1).
 * Covers SQLSTATE mapping (42501, class 25/2D), the conservative write heuristic
 * (comments, multi-statement strings, side-effecting SELECTs, added keywords),
 * and the uncertain-outcome marker used by adapters.
 */

import { describe, expect, it } from 'vitest';

import {
  DbError,
  hasUncertainOutcome,
  isWriteStatement,
  markUncertainOutcome,
  normalizeError,
} from '../../src/errors.js';

function pgError(message: string, code: string): Error {
  const error = new Error(message);
  (error as { code?: string }).code = code;
  return error;
}

describe('SQLSTATE to code mapping', () => {
  it.each([
    ['42501', 'PERMISSION'], // insufficient_privilege: RLS denials, revoked grants
    ['42P01', 'SYNTAX'], // undefined_table stays in class 42
    ['42601', 'SYNTAX'], // syntax_error
    ['25P02', 'TRANSACTION'], // in_failed_sql_transaction
    ['25P01', 'TRANSACTION'], // no_active_sql_transaction
    ['2D000', 'TRANSACTION'], // invalid_transaction_termination
    ['40001', 'TRANSACTION'], // serialization_failure
    ['08006', 'CONNECTION'], // connection_failure
    ['57014', 'TIMEOUT'], // query_canceled (statement timeout)
    ['23505', 'CONSTRAINT'],
    ['28000', 'PERMISSION'], // invalid_authorization_specification
  ])('maps %s to %s', (sqlstate, expected) => {
    const error = normalizeError(pgError('db error', sqlstate), { text: 'select 1' });
    expect(error.code).toBe(expected);
    expect(error.sqlstate).toBe(sqlstate);
  });

  it('classifies 42501 as PERMISSION (retryable false) — the RLS denial case', () => {
    const error = normalizeError(pgError('permission denied for table users', '42501'), {
      text: 'select * from users',
    });
    expect(error.code).toBe('PERMISSION');
    expect(error.retryable).toBe(false);
  });
});

describe('conservative write heuristic (isWriteStatement)', () => {
  it('treats ordinary write keywords as writes', () => {
    expect(isWriteStatement('insert into t values (1)')).toBe(true);
    expect(isWriteStatement('update t set x = 1')).toBe(true);
    expect(isWriteStatement('delete from t')).toBe(true);
  });

  it('does not claim plain reads are writes', () => {
    expect(isWriteStatement('select 1')).toBe(false);
    expect(isWriteStatement('show application_name')).toBe(false);
    expect(isWriteStatement('select * from users where id = $1')).toBe(false);
  });

  it('flags writes hidden behind leading comments', () => {
    expect(isWriteStatement('-- setup\ninsert into t values (1)')).toBe(true);
    expect(isWriteStatement('/* drop me */ drop table users')).toBe(true);
    expect(isWriteStatement('-- a\n-- b\nupdate t set x = 1')).toBe(true);
  });

  it('treats comment-only and unterminated-comment statements conservatively', () => {
    expect(isWriteStatement('-- just a comment')).toBe(true);
    expect(isWriteStatement('/* unterminated')).toBe(true);
    expect(isWriteStatement('   ')).toBe(true);
  });

  it('flags multi-statement strings (simple query protocol runs them all)', () => {
    expect(isWriteStatement('select 1; drop table users')).toBe(true);
    expect(isWriteStatement('select $1::text; insert into t values (1)')).toBe(true);
    // A single trailing semicolon is not a second statement.
    expect(isWriteStatement('select 1;')).toBe(false);
    expect(isWriteStatement('select 1; ')).toBe(false);
  });

  it('flags SELECTs that invoke known side-effect functions', () => {
    expect(isWriteStatement("select setval('user_id_seq', 100)")).toBe(true);
    expect(isWriteStatement('select nextval(\'user_id_seq\')')).toBe(true);
    expect(isWriteStatement("select dblink_exec('dbname=x', 'insert into t values (1)')")).toBe(
      true,
    );
    expect(isWriteStatement('select pg_terminate_backend($1)')).toBe(true);
  });

  it('includes session-affecting commands in the keyword list', () => {
    expect(isWriteStatement('notify my_channel')).toBe(true);
    expect(isWriteStatement('vacuum analyze')).toBe(true);
    expect(isWriteStatement('checkpoint')).toBe(true);
  });

  it('treats EXPLAIN ANALYZE as a possible write — it executes the statement (round 3)', () => {
    expect(isWriteStatement('explain analyze update t set x = 1')).toBe(true);
    expect(isWriteStatement('EXPLAIN ANALYZE DELETE FROM t')).toBe(true);
    expect(isWriteStatement('EXPLAIN ANALYZE INSERT INTO t VALUES (1)')).toBe(true);
    // Parenthesized options and mixed case after leading comments.
    expect(isWriteStatement('explain (analyze, format text) insert into t values (1)')).toBe(true);
    expect(isWriteStatement('/* cost check */ Explain Analyze Update t Set x = 1')).toBe(true);
  });

  it('conservatively flags plain EXPLAIN as a possible write too (safe over-approximation)', () => {
    expect(isWriteStatement('explain select 1')).toBe(true);
    expect(isWriteStatement("explain (format json) select setval('s', 5)")).toBe(true);
  });
});

describe('system errnos vs SQLSTATE (round 3)', () => {
  it('never treats Node system errnos as server SQLSTATEs', () => {
    for (const code of ['EPIPE', 'EBADF', 'E2BIG', 'EAGAIN', 'EINTR', 'ESRCH']) {
      const error = normalizeError(pgError('write failed', code), { text: 'select 1' });
      expect(error.sqlstate, `code ${code} must not become a sqlstate`).toBeUndefined();
    }
  });

  it('classifies recognized transport errnos as CONNECTION', () => {
    for (const code of ['EPIPE', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH']) {
      const error = normalizeError(pgError('transport down', code), { text: 'select 1' });
      expect(error.code, `errno ${code}`).toBe('CONNECTION');
      expect(error.sqlstate).toBeUndefined();
    }
  });

  it('flags a write lost to EPIPE as indeterminate with no sqlstate', () => {
    const error = normalizeError(pgError('write EPIPE', 'EPIPE'), { text: 'update t set x = 1' });
    expect(error.sqlstate).toBeUndefined();
    expect(error.code).toBe('CONNECTION');
    expect(error.indeterminate).toBe(true);
  });

  it('preserves real PostgreSQL SQLSTATEs that share the 5-uppercase shape', () => {
    for (const sqlstate of ['08006', '23505', 'P0001', 'XX000', 'HV000', 'FD000', '40001']) {
      const error = normalizeError(pgError('db error', sqlstate), { text: 'select 1' });
      expect(error.sqlstate, `sqlstate ${sqlstate} must pass through`).toBe(sqlstate);
    }
  });

  it('maps known classes and leaves valid but unmapped classes as UNKNOWN with sqlstate intact', () => {
    expect(normalizeError(pgError('x', '08006'), {}).code).toBe('CONNECTION');
    expect(normalizeError(pgError('x', '23505'), {}).code).toBe('CONSTRAINT');
    expect(normalizeError(pgError('x', 'P0001'), {}).code).toBe('UNKNOWN');
    expect(normalizeError(pgError('x', 'XX000'), {}).code).toBe('UNKNOWN');
    expect(normalizeError(pgError('x', 'HV000'), {}).code).toBe('UNKNOWN');
    // The sqlstate is still reported so callers can branch on the exact code.
    expect(normalizeError(pgError('x', 'XX000'), {}).sqlstate).toBe('XX000');
  });

  it('honors custom SQLSTATEs passed via the explicit sqlstate field (never errno-filtered)', () => {
    const error = new Error('custom class');
    (error as { sqlstate?: string }).sqlstate = 'EU001';
    const normalized = normalizeError(error, { text: 'select 1' });
    expect(normalized.sqlstate).toBe('EU001');
  });

  it('unwraps EPIPE through a Neon-style sourceError chain', () => {
    const source = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    const wrapped = Object.assign(new Error('fetch failed'), { sourceError: source });
    const error = normalizeError(wrapped, { text: 'insert into t values (1)' });
    expect(error.sqlstate).toBeUndefined();
    expect(error.indeterminate).toBe(true);
  });
});

describe('uncertain outcome marker', () => {
  it('round-trips through markUncertainOutcome / hasUncertainOutcome', () => {
    const error = new Error('connection terminated during COMMIT');
    expect(hasUncertainOutcome(error)).toBe(false);
    markUncertainOutcome(error);
    expect(hasUncertainOutcome(error)).toBe(true);
  });

  it('makes normalizeError report indeterminate even without write text context', () => {
    const error = new Error('connection terminated during COMMIT');
    markUncertainOutcome(error);
    const normalized = normalizeError(error, { adapterId: 'postgres' });
    expect(normalized).toBeInstanceOf(DbError);
    expect(normalized.indeterminate).toBe(true);
    expect(normalized.adapterId).toBe('postgres');
  });

  it('never marks pre-dispatch capability errors as indeterminate', () => {
    const error = new Error('not supported');
    error.name = 'CapabilityError';
    (error as { adapter?: string; capability?: string }).adapter = 'neon';
    (error as { capability?: string }).capability = 'interactiveTransactions';
    const normalized = normalizeError(error, { adapterId: 'neon', text: 'begin' });
    expect(normalized.code).toBe('CAPABILITY');
    expect(normalized.indeterminate).toBe(false);
  });
});
