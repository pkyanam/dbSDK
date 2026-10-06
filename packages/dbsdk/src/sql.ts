/**
 * The `sql` tagged template: build reusable, parameterized statements.
 *
 * Invariants:
 * - Interpolated values become positional `$n` parameters. They can NEVER become SQL text,
 *   identifiers, or fragments — only statements created by `sql`, `sql.identifier`, or
 *   `sql.join` are inlined (tracked in module-private registries).
 * - `undefined` parameters are rejected up front (use `null` for SQL NULL).
 * - Functions and symbols are rejected as parameters.
 * - Dynamic identifiers require the explicit, validated `sql.identifier()` API.
 * - While composing, inlined fragments are renumbered safely: user-written text (a literal
 *   `$1.50`, dollar-quoted strings, etc.) is never rewritten. Internal placeholder tokens
 *   are converted to PostgreSQL `$n` only when a statement's text is read.
 */

import { DbError } from './errors.js';
import type { SqlStatement, SqlTag } from './types.js';

/** Brand registry: only statements created by this module count as inline-able fragments. */
const fragments = new WeakSet<object>();

/** Module-private view of each fragment's text with unconverted placeholder tokens. */
const internalTexts = new WeakMap<object, string>();

const TOKEN_RE = /\u0000(\d+)\u0000/g;

function token(n: number): string {
  return `\u0000${n}\u0000`;
}

/** Shift every placeholder token in a fragment's internal text by `offset` positions. */
function renumber(text: string, offset: number): string {
  return text.replace(TOKEN_RE, (_match, digits: string) => token(Number(digits) + offset));
}

/** Convert placeholder tokens into PostgreSQL `$n` parameters. */
function detokenize(text: string): string {
  return text.replace(TOKEN_RE, (_match, digits: string) => `$${digits}`);
}

function isFragment(value: unknown): value is SqlStatement {
  return typeof value === 'object' && value !== null && fragments.has(value);
}

function internalTextOf(fragment: SqlStatement): string {
  const text = internalTexts.get(fragment);
  if (text === undefined) {
    throw new DbError('Unknown sql fragment; fragments must come from the sql builder.', {
      code: 'CONFIGURATION',
      retryable: false,
      indeterminate: false,
    });
  }
  return text;
}

function createFragment(internalText: string, params: readonly unknown[]): SqlStatement {
  const fragment: SqlStatement = Object.freeze({
    get text(): string {
      return detokenize(internalText);
    },
    params: Object.freeze([...params]),
  });
  fragments.add(fragment);
  internalTexts.set(fragment, internalText);
  return fragment;
}

function configurationError(message: string): DbError {
  return new DbError(message, { code: 'CONFIGURATION', retryable: false, indeterminate: false });
}

function validateParameter(value: unknown, position: number): void {
  if (value === undefined) {
    throw configurationError(
      `SQL parameter at position ${position} is \`undefined\`. Use \`null\` for SQL NULL.`,
    );
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw configurationError(
      `SQL parameter at position ${position} has an unsupported type (${typeof value}).`,
    );
  }
}

/** Validate all parameters of a raw statement (shared with `db.query`/`db.batch`). */
export function validateStatementParams(params: readonly unknown[] | undefined): void {
  if (params !== undefined) {
    params.forEach((value, index) => validateParameter(value, index + 1));
  }
}

function inline(fragment: SqlStatement, text: string, params: unknown[]): string {
  // Renumber the fragment's placeholders to continue the outer statement's parameter
  // sequence. Only internal tokens are renumbered; user text is never touched.
  text += renumber(internalTextOf(fragment), params.length);
  params.push(...(fragment.params ?? []));
  return text;
}

/**
 * Build a statement from tagged-template parts. Internal; shared by the public `sql` tag and
 * `db.sql` so both produce identical parameterization.
 */
export function buildSql(
  strings: readonly string[],
  values: readonly unknown[],
): SqlStatement {
  if (strings.length !== values.length + 1) {
    throw configurationError('Tagged template parts and values are mismatched.');
  }
  let text = '';
  const params: unknown[] = [];
  for (let i = 0; i < values.length; i++) {
    // A cooked string can be undefined when the template contains an invalid
    // escape sequence (e.g. `\d`). Silently dropping it would change the SQL,
    // so fail loudly instead.
    const cooked = strings[i];
    if (cooked === undefined) {
      throw configurationError(
        'Invalid tagged template: a cooked string part is undefined (invalid escape sequence?).',
      );
    }
    text += cooked;
    const value = values[i];
    if (isFragment(value)) {
      text = inline(value, text, params);
    } else {
      validateParameter(value, params.length + 1);
      params.push(value);
      text += token(params.length);
    }
  }
  const last = strings[strings.length - 1];
  if (last === undefined) {
    throw configurationError(
      'Invalid tagged template: a cooked string part is undefined (invalid escape sequence?).',
    );
  }
  text += last;
  return createFragment(text, params);
}

const IDENTIFIER_SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

function quoteIdentifier(segment: string): string {
  if (!IDENTIFIER_SEGMENT_RE.test(segment)) {
    throw configurationError(
      `Invalid SQL identifier segment: ${JSON.stringify(segment)}. Only [A-Za-z_][A-Za-z0-9_$]* is allowed. Use a bound parameter for values, and sql.identifier only for names you control.`,
    );
  }
  // Validation already excludes double quotes; escape defensively anyway.
  return `"${segment.replaceAll('"', '""')}"`;
}

function identifier(name: string | readonly string[]): SqlStatement {
  if (name === '') {
    throw configurationError('SQL identifier must not be empty.');
  }
  const parts = typeof name === 'string' ? name.split('.') : [...name];
  const text = parts.map((part) => quoteIdentifier(part)).join('.');
  return createFragment(text, []);
}

function join(fragmentsIn: readonly SqlStatement[], separator = ' '): SqlStatement {
  if (!Array.isArray(fragmentsIn)) {
    throw configurationError('sql.join expects an array of sql fragments.');
  }
  let text = '';
  const params: unknown[] = [];
  for (const [index, fragment] of fragmentsIn.entries()) {
    if (!isFragment(fragment)) {
      throw configurationError(
        'sql.join only accepts statements created by the sql tag, sql.identifier, or sql.join.',
      );
    }
    if (index > 0) text += separator;
    text = inline(fragment, text, params);
  }
  return createFragment(text, params);
}

function sqlTag(strings: TemplateStringsArray, ...values: readonly unknown[]): SqlStatement {
  return buildSql(strings, values);
}

/** The reusable SQL builder (also re-exported from the package root). */
export const sql = Object.assign(sqlTag, { identifier, join }) as SqlTag;
