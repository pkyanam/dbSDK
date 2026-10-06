/**
 * Shared SQL text analysis for transaction-pooler session guards.
 *
 * Used by the pooled paths of the PlanetScale (PgBouncer 6432) and Supabase
 * (transaction 6543) adapters. The guard must run BEFORE dispatch, on every path
 * that sends caller SQL through the pool (query, transaction statements, batch),
 * and it must not be fooled by:
 *
 * - leading comments (`/* ctx *\/ SET ...`),
 * - statements after another statement in one query string (`select 1; set ...`),
 * - session-state keywords inside string literals (`select 'set x'`),
 * - dollar-quoted bodies or quoted identifiers containing such keywords.
 *
 * How it works (deliberately NOT a full SQL parser): a small lexer masks the
 * constructs that could hide text — comments (line, nested block), single-quoted
 * strings (including `E'...'` backslash escapes), double-quoted identifiers, and
 * dollar-quoted bodies — then splits the remaining text at top-level semicolons.
 * The pooled guard then (a) refuses multi-statement strings conservatively (a
 * transaction-pooler connection runs one statement per transaction and cannot
 * host session state between them) and (b) runs the session-state statement
 * classes against each surviving statement's start. A `SELECT` whose *literal*
 * contains "set"/"reset" is NOT flagged, because literals are masked.
 */

import { CapabilityError } from './errors.js';

/**
 * Mask comments, quoted strings/identifiers and dollar-quoted bodies by replacing
 * them with spaces (length-preserving). Unclosed constructs mask to the end.
 */
export function maskSqlLiterals(sql: string): string {
  const out: string[] = new Array(sql.length);
  const n = sql.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < Math.min(to, n); k++) out[k] = ' ';
  };

  let i = 0;
  while (i < n) {
    const c = sql[i] as string;

    // Line comment: -- to end of line (the newline itself stays).
    if (c === '-' && sql[i + 1] === '-') {
      const start = i;
      while (i < n && sql[i] !== '\n') i++;
      blank(start, i);
      continue;
    }

    // Block comment: /* ... */ with PostgreSQL's nested block comments.
    if (c === '/' && sql[i + 1] === '*') {
      const start = i;
      let depth = 0;
      while (i < n) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
          continue;
        }
        if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
          if (depth === 0) break;
          continue;
        }
        i++;
      }
      blank(start, i);
      continue;
    }

    // Single-quoted string. Backslash escapes only apply for E'...' strings
    // (PostgreSQL default: standard_conforming_strings = on).
    if (c === "'") {
      const start = i;
      const prev = start > 0 ? sql[start - 1] : '';
      const escapeBackslash = (prev === 'E' || prev === 'e') && !/[A-Za-z0-9_$]/.test(start > 1 ? sql[start - 2] ?? '' : ' ');
      i++;
      while (i < n) {
        if (escapeBackslash && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      blank(start, i);
      continue;
    }

    // Double-quoted identifier ("" is the escape).
    if (c === '"') {
      const start = i;
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      blank(start, i);
      continue;
    }

    // Dollar-quoted body: $tag$ ... $tag$ (tag may be empty; a tag never starts
    // with a digit, so positional parameters like $1 are not dollar quotes).
    if (c === '$') {
      const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (match) {
        const tag = match[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        blank(i, end);
        i = end;
        continue;
      }
    }

    out[i] = c;
    i++;
  }
  return out.join('');
}

/**
 * Split masked SQL text into its top-level statements. Empty pieces and
 * comment-only remainders disappear (they are spaces after masking), so a
 * harmless trailing semicolon or trailing comment yields no extra statement.
 */
export function splitTopLevelStatements(maskedSql: string): string[] {
  return maskedSql
    .split(';')
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0);
}

/**
 * Session-level statement classes that cannot work through a transaction-mode
 * pooler (matched against the MASKED text of each top-level statement, so they
 * anchor on the statement's real first keyword).
 */
const SESSION_STATE_PATTERNS: RegExp[] = [
  /^\s*SET\s+(?!LOCAL\b)/i, // plain session `SET`; `SET LOCAL` inside a transaction is fine
  /^\s*RESET\b/i,
  /^\s*(LISTEN|UNLISTEN|NOTIFY)\b/i,
  /^\s*PREPARE\b/i,
  /^\s*DEALLOCATE\b/i,
  /^\s*CREATE\s+(?:GLOBAL\s+|LOCAL\s+)?TEMP/i,
  /^\s*DECLARE\b[\s\S]*\bWITH\s+HOLD\b/i,
];

export type TransactionPoolerGuard = (text: string) => void;

/**
 * Build the pre-dispatch guard for a transaction-pooler connection path. The
 * returned function throws a CapabilityError (adapterId, capability
 * 'sessionState') before anything reaches the driver when the text carries
 * session-state statements or more than one top-level statement.
 */
export function createTransactionPoolerGuard(options: {
  adapterId: string;
  /** Human label used in error messages, e.g. `planetscale (pooled, PgBouncer 6432)`. */
  label: string;
}): TransactionPoolerGuard {
  const { adapterId, label } = options;
  return (text: string): void => {
    const masked = maskSqlLiterals(text);
    const statements = splitTopLevelStatements(masked);
    if (statements.length > 1) {
      throw new CapabilityError(
        adapterId,
        'sessionState',
        `${label}: a query string with multiple SQL statements was rejected before dispatch. ` +
          'A transaction-pooler connection runs one statement per transaction and session-level ' +
          'state does not survive between transactions, so multi-statement strings are refused. ' +
          'Split the text into separate queries (a trailing semicolon or comment is fine). ' +
          `Second statement starts with: ${statements[1]!.slice(0, 80)}`,
      );
    }
    for (const statement of statements) {
      for (const pattern of SESSION_STATE_PATTERNS) {
        if (pattern.test(statement)) {
          throw new CapabilityError(
            adapterId,
            'sessionState',
            `${label}: session-level state is not supported by the transaction pooler and this ` +
              `statement was rejected before dispatch: ${statement.slice(0, 80)}`,
          );
        }
      }
    }
  };
}
