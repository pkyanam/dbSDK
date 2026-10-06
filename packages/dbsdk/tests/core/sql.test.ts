import { describe, expect, it } from 'vitest';
import { sql } from '../../src/sql.js';
import { DbError, isDbError } from '../../src/errors.js';

describe('sql tagged template', () => {
  it('converts interpolated values into positional parameters', () => {
    const id = 'abc';
    const limit = 10;
    const statement = sql`select * from users where id = ${id} limit ${limit}`;
    expect(statement).toEqual({
      text: 'select * from users where id = $1 limit $2',
      params: ['abc', 10],
    });
  });

  it('passes non-string values through as bound parameters (never as SQL)', () => {
    const ids = [1, 2, 3];
    const payload = { name: 'Ada' };
    const statement = sql`insert into t (ids, payload) values (${ids}, ${payload})`;
    expect(statement.text).toBe('insert into t (ids, payload) values ($1, $2)');
    expect(statement.params).toEqual([ids, payload]);
  });

  it('keeps null as a parameter and rejects undefined with a clear message', () => {
    const statement = sql`select ${null}`;
    expect(statement.params).toEqual([null]);

    expect(() => sql`select ${undefined}`).toThrowError(DbError);
    try {
      sql`select ${undefined}`;
      expect.unreachable();
    } catch (error) {
      expect(isDbError(error) && error.code).toBe('CONFIGURATION');
      expect(isDbError(error) && error.message).toContain('null');
    }
  });

  it('rejects functions and symbols as parameters', () => {
    expect(() => sql`select ${() => 1}`).toThrowError(DbError);
    expect(() => sql`select ${Symbol.iterator}`).toThrowError(DbError);
  });

  it('inlines nested fragments and concatenates their parameters in order', () => {
    const name = 'ada';
    const inner = sql`age > ${18}`;
    const outer = sql`select * from people where name = ${name} and ${inner}`;
    expect(outer.text).toBe('select * from people where name = $1 and age > $2');
    expect(outer.params).toEqual(['ada', 18]);
  });

  it('inlines a fragment reused multiple times without shifting parameters', () => {
    const active = sql`active = ${true}`;
    const statement = sql`select * from t where ${active} or ${active}`;
    expect(statement.text).toBe('select * from t where active = $1 or active = $2');
    expect(statement.params).toEqual([true, true]);
  });

  it('never treats plain values as fragments, even if shaped like one', () => {
    const fake = { text: 'true', params: [1] };
    const statement = sql`select ${fake}`;
    expect(statement.text).toBe('select $1');
    expect(statement.params).toEqual([fake]);
  });

  it('does not mutate the original fragment when building', () => {
    const inner = sql`x = ${1}`;
    sql`select * from t where ${inner}`;
    expect(inner.text).toBe('x = $1');
    expect(inner.params).toEqual([1]);
  });
});

describe('sql.join', () => {
  it('joins fragments with a separator and concatenates parameters', () => {
    const a = sql`name = ${'ada'}`;
    const b = sql`age > ${18}`;
    const condition = sql.join([a, b], ' and ');
    expect(condition.text).toBe('name = $1 and age > $2');
    expect(condition.params).toEqual(['ada', 18]);
  });

  it('defaults the separator to a single space', () => {
    const condition = sql.join([sql`a = ${1}`, sql`b = ${2}`]);
    expect(condition.text).toBe('a = $1 b = $2');
  });

  it('rejects non-fragment values', () => {
    expect(() => sql.join(['a = 1'] as never)).toThrowError(DbError);
    expect(() => sql.join([undefined as never])).toThrowError(DbError);
  });

  it('handles empty arrays', () => {
    expect(sql.join([])).toEqual({ text: '', params: [] });
  });
});

describe('sql.identifier', () => {
  it('quotes and validates identifiers', () => {
    expect(sql.identifier('user')).toEqual({ text: '"user"', params: [] });
    expect(sql.identifier('_private$x')).toEqual({ text: '"_private$x"', params: [] });
  });

  it('splits dotted names into quoted segments', () => {
    expect(sql.identifier('schema.table')).toEqual({ text: '"schema"."table"', params: [] });
    expect(sql.identifier(['a', 'b', 'c'])).toEqual({ text: '"a"."b"."c"', params: [] });
  });

  it('rejects values masquerading as identifiers', () => {
    expect(() => sql.identifier('user id')).toThrowError(DbError);
    expect(() => sql.identifier('user; drop table x')).toThrowError(DbError);
    expect(() => sql.identifier('1col')).toThrowError(DbError);
    expect(() => sql.identifier('col-name')).toThrowError(DbError);
    expect(() => sql.identifier('col"name')).toThrowError(DbError);
    expect(() => sql.identifier('')).toThrowError(DbError);
    expect(() => sql.identifier(['ok', ''])).toThrowError(DbError);
  });

  it('composes identifiers with parameterized statements', () => {
    const table = sql.identifier('user_events');
    const userId = 42;
    const statement = sql`select * from ${table} where user_id = ${userId}`;
    expect(statement.text).toBe('select * from "user_events" where user_id = $1');
    expect(statement.params).toEqual([42]);
  });
});
