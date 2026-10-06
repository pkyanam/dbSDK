/**
 * Shared SQL text analysis for pooled (transaction-pooler) guards
 * (src/adapters/pg-sql.ts).
 *
 * These tests prove the lexer/guard semantics that the PlanetScale PgBouncer and
 * Supabase transaction adapters rely on:
 * - masking: comments, quoted strings/identifiers and dollar-quoted bodies never
 *   leak their content into statement-start analysis;
 * - statement splitting: only TOP-LEVEL semicolons separate statements; semicolons
 *   inside strings/identifiers/dollar-quoted bodies and trailing semicolons or
 *   comments are harmless;
 * - the guard: session-state statement classes are refused per top-level statement
 *   (leading comments don't hide them), multi-statement strings are refused
 *   conservatively, and SELECT literals containing session keywords are NOT flagged.
 */

import { describe, expect, it } from 'vitest';

import {
  createTransactionPoolerGuard,
  maskSqlLiterals,
  splitTopLevelStatements,
} from '../../src/adapters/pg-sql.js';
import { CapabilityError } from '../../src/adapters/errors.js';

const guard = createTransactionPoolerGuard({ adapterId: 'test-adapter', label: 'test (pooled)' });

describe('pg-sql — maskSqlLiterals', () => {
  it('masks line comments, block comments (nested), strings, identifiers and dollar quotes', () => {
    expect(maskSqlLiterals("select 1 -- set dangerous\n, 2")).toBe("select 1                 \n, 2");
    expect(maskSqlLiterals("/* outer /* inner */ still */ SET x")).toMatch(/^\s+SET x$/);
    expect(maskSqlLiterals("select 'set x = 1'")).toBe("select " + " ".repeat(11));
    expect(maskSqlLiterals("select E'a\\'b set x'")).not.toContain('set');
    expect(maskSqlLiterals('select "weird; name" from t')).toBe('select               from t');
    expect(maskSqlLiterals('select $tag$ body; set x $tag$')).toBe('select ' + ' '.repeat(23));
  });

  it('does not treat positional parameters as dollar quotes', () => {
    // $1 is a parameter, not a dollar-quote tag: its content must survive masking.
    expect(maskSqlLiterals('select $1')).toBe('select $1');
    expect(maskSqlLiterals('where id = $1 and tag = $t2$hidden$t2$')).not.toContain('hidden');
  });

  it('masks unterminated constructs conservatively (to end of text)', () => {
    expect(maskSqlLiterals("select 'unclosed")).toBe("select " + " ".repeat(9));
    expect(maskSqlLiterals('select /* unclosed')).toBe("select " + " ".repeat(11));
  });
});

describe('pg-sql — splitTopLevelStatements', () => {
  it('splits on top-level semicolons and drops empty/comment-only remainders', () => {
    expect(splitTopLevelStatements(maskSqlLiterals('select 1; select 2;'))).toHaveLength(2);
    expect(splitTopLevelStatements(maskSqlLiterals('select 1; -- trailing comment'))).toEqual(['select 1']);
    expect(splitTopLevelStatements(maskSqlLiterals('/* only a comment */'))).toEqual([]);
    expect(splitTopLevelStatements(maskSqlLiterals("select ';'; select 2"))).toHaveLength(2);
    expect(splitTopLevelStatements(maskSqlLiterals('select $b$;$b$'))).toEqual(['select']);
  });
});

describe('pg-sql — transaction-pooler guard', () => {
  it('refuses each session-state statement class before dispatch', () => {
    for (const text of [
      'SET statement_timeout = 3000',
      '  set application_name = x',
      'RESET ALL',
      'LISTEN chan',
      'NOTIFY chan',
      'PREPARE p AS select 1',
      'DEALLOCATE p',
      'CREATE TEMP TABLE t (x int)',
      'create global temp table t (x int)',
      'DECLARE c CURSOR WITH HOLD FOR select 1',
    ]) {
      expect(() => guard(text), text).toThrow(CapabilityError);
    }
  });

  it('allows SET LOCAL and ordinary statements (transaction-pooler-safe)', () => {
    expect(() => guard('SET LOCAL statement_timeout = 3000')).not.toThrow();
    expect(() => guard('select 1')).not.toThrow();
    expect(() => guard('insert into t values ($1)')).not.toThrow();
    expect(() => guard('CREATE TABLE t (x int)')).not.toThrow(); // non-temp CREATE is fine
  });

  it('does NOT flag session keywords inside literals, identifiers or comments (no false positives)', () => {
    expect(() => guard("select 'set application_name = smuggled'")).not.toThrow();
    expect(() => guard('select * from reset_log where note = $1')).not.toThrow();
    expect(() => guard('/* set x = 1 */ select 1')).not.toThrow();
    expect(() => guard('-- prepare something\nselect 1')).not.toThrow();
    expect(() => guard('select $flag$ set x $flag$')).not.toThrow();
  });

  it('catches a session-state statement hidden behind a leading comment (review F6)', () => {
    expect(() => guard('/* ctx */ SET statement_timeout = 3000')).toThrow(CapabilityError);
    expect(() => guard('-- ctx\nset x = 1')).toThrow(CapabilityError);
  });

  it('refuses multi-statement strings conservatively (review F6)', () => {
    expect(() => guard('select 1; set application_name = smuggled')).toThrow(/multiple SQL statements/);
    expect(() => guard('select 1; select 2')).toThrow(/multiple SQL statements/);
    // Even two harmless statements are refused on the pooled path: one statement per
    // round-trip is the contract a transaction pooler can guarantee.
    expect(() => guard('insert into a values (1); insert into b values (2)')).toThrow(CapabilityError);
  });

  it('allows a trailing semicolon and trailing comments (harmless single statement)', () => {
    expect(() => guard('select 1;')).not.toThrow();
    expect(() => guard('select 1 ; -- done')).not.toThrow();
    expect(() => guard('select 1 /* trailing */ ;')).not.toThrow();
  });

  it('semicolons inside strings/quoted identifiers/dollar bodies do not split statements', () => {
    expect(() => guard("select 'a;b'")).not.toThrow();
    expect(() => guard('select "a;b" from t')).not.toThrow();
    expect(() => guard('select $q$; set x; $q$ as v')).not.toThrow();
    // But the content is still one statement whose start is checked:
    expect(() => guard("select 'a;b'; set x = 1")).toThrow(/multiple SQL statements/);
  });

  it('a session statement smuggled after another statement cannot bypass the guard (review F6)', () => {
    expect(() => guard('select 1; SET statement_timeout = 3000')).toThrow(CapabilityError);
    expect(() => guard("select 'x'; /* c */ PREPARE p AS select 1")).toThrow(CapabilityError);
  });
});
