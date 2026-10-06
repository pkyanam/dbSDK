/**
 * SQL adapters for the transfer engine: `createSqlSource` / `createSqlTarget`.
 *
 * These adapt the existing `Database` client (any provider/transport — local
 * Postgres, Supabase, Neon) into the provider-agnostic `SyncSource`/`SyncTarget`
 * contracts. All names (table, columns, order-by, keys) go through the validated
 * `sql.identifier` primitive; every value is a bound parameter. No string
 * substitution, ever.
 *
 * Source pagination is keyset-based (`where (cursor-cols) > (last-values) order by
 * ... limit n`): monotonic, no OFFSET re-reads. Two enforced preconditions make it
 * row-complete instead of silently lossy:
 *  - The `orderBy` columns must form a UNIQUE total order. By default (`uniqueOrder:
 *    'verify'`) the source verifies this against the catalog — a valid unique index
 *    whose key columns are a subset of the ordering columns — and refuses to read
 *    (CONTRACT error, before any data transfer) when there is none. A non-unique
 *    ordering silently skips rows at page boundaries; no within-page check can catch
 *    every case (batchSize 1, ties spanning pages), hence the preflight.
 *  - Every ordering column must be NOT NULL. A NULL cursor value cannot be encoded
 *    and would silently skip rows — refused instead.
 *
 * Cursor precision: ordering columns are additionally projected as exact `col::text`
 * internal aliases and stripped from the returned rows. Cursor values are therefore
 * PostgreSQL's exact text rendering (microsecond `timestamptz`, full `bigint`/
 * `numeric` digits) — never a driver-side lossy conversion — while the keyset
 * predicate still compares against the original columns with type inference.
 *
 * Payload precision: the same logic applies to the COPIED VALUES, not just the
 * cursor. A catalog query resolves every projected column's type — including
 * domains and array element types — and columns the driver would parse lossily
 * or ambiguously (date/time categories, intervals, `json`/`jsonb`, arrays of
 * those, NUMERIC-family arrays (`numeric[]`/`decimal[]`, domains over them, and
 * multidimensional arrays — the driver parses numeric ARRAY ELEMENTS as binary
 * doubles, silently rounding values beyond double precision, while a scalar
 * `numeric` stays an exact string), plus anything unresolvable) are projected
 * as their exact `col::text` rendering in the row payload. Strings are written
 * back to typed columns verbatim by PostgreSQL, so the default SQL→SQL copy is
 * value-faithful: microseconds survive, `[]` stays an array (not `{}`), JSON
 * `null` stays JSON null, `{"a":[1,2]}` round-trips exactly, and every
 * `numeric[]` digit survives verbatim. Columns with lossless native transport
 * (numbers, text, booleans, `bytea`, `text[]`/`int8[]`-style arrays) are NOT
 * re-projected and keep their native JS values.
 *
 * Schema snapshot: reads NEVER use `SELECT *`. The first read caches the
 * column metadata and freezes an explicit, table-qualified projection from it;
 * every LATER read re-queries the catalog and compares the table's column set
 * and base types against that snapshot. A column added, removed, or retyped
 * after the snapshot fails the read with a CONTRACT error BEFORE the data
 * query — nothing is read, written, or checkpointed — so an added column can
 * neither silently appear in the payload, collide with an internal
 * `__dbsdk_cursor_*` alias, nor silently lose precision (e.g. a new
 * microsecond-timestamp column). To continue against the new schema, recreate
 * the source (a new `createSqlSource` with the same identity; the existing
 * checkpoint key remains valid). The re-validation costs one extra read-only
 * catalog query per page after the first and requires `pg_catalog` read
 * access. An explicit `columns` list may ignore UNSELECTED added/removed
 * columns (documented contract) but still guards the selected columns'
 * existence and types.
 *
 * Target writes are multi-row `INSERT ... ON CONFLICT (key) DO UPDATE` (or
 * `DO NOTHING`) upserts — idempotent under reruns. Batches are split internally
 * to stay under PostgreSQL's 65 535 bind-parameter protocol limit. The target
 * also resolves its columns' types (cached, only when a batch actually contains
 * a top-level JavaScript array value): arrays go natively into PostgreSQL array
 * columns, `JSON.stringify` into `json`/`jsonb` columns — and anything the
 * catalog cannot resolve to one of those is REFUSED with a CONTRACT error
 * before any write, because guessing would risk silent corruption.
 */

import { sql } from '../sql.js';
import type { Database, SqlStatement } from '../types.js';
import { SyncError } from './errors.js';
import type { SyncSource, SyncTarget } from './types.js';

/** PostgreSQL protocol hard limit is 65 535 parameters; stay safely under it. */
const MAX_PARAMS_PER_STATEMENT = 60_000;

/** Reserved prefix for internal cursor projection aliases. */
const CURSOR_ALIAS_PREFIX = '__dbsdk_cursor_';

/** PostgreSQL type OID of `numeric` (the `decimal` alias resolves to it). */
const NUMERIC_OID = 1700;

/**
 * Column metadata resolved from the catalog (one cached query per adapter
 * instance), used for four things: the reserved-alias guard, the NOT NULL
 * check, the exact-payload classification, and the per-read schema-drift
 * comparison. Types are resolved through domains to their base type and, for
 * arrays, through the element type; OIDs make the comparison exact (e.g.
 * `decimal` aliases `numeric`, OID 1700).
 */
type ColumnMeta = {
  attname: string;
  attnotnull: boolean;
  /** `pg_type.typcategory` of the resolved base type (null if unresolved). */
  basecategory: string | null;
  /** `pg_type.typname` of the resolved base type (null if unresolved). */
  basetypname: string | null;
  /** `pg_type.oid` of the resolved base type (null if unresolved/not provided). */
  baseoid: number | null;
  /** Resolved element base type category for array columns (null otherwise). */
  elemcategory: string | null;
  /** Resolved element base type name for array columns (null otherwise). */
  elemtypname: string | null;
  /** `pg_type.oid` of the resolved element base type (null otherwise). */
  elemoid: number | null;
};

/** `pg_type.typcategory` values whose native driver transport is lossy. */
const TEMPORAL_CATEGORIES = new Set(['D', 'T']); // date/time family; interval
/** Type names handled as JSON documents (category alone is not distinctive). */
const JSON_TYPE_NAMES = new Set(['json', 'jsonb']);

/**
 * One read-only catalog query, parameterized with the quoted table parts,
 * returning every real column with its (domain-resolved) base type and, for
 * arrays, the (domain-resolved) element base type. Bounded: only the columns
 * of this one table are returned.
 */
function columnMetadataQuery(tableParts: readonly string[]): SqlStatement {
  const relname = tableParts[tableParts.length - 1]!;
  const schema = tableParts.length >= 2 ? tableParts[0] : null;
  return sql`
    select a.attname::text as attname,
           a.attnotnull as attnotnull,
           bt.typcategory::text as basecategory,
           bt.typname::text as basetypname,
           bt.oid::text as baseoid,
           et.typcategory::text as elemcategory,
           et.typname::text as elemtypname,
           et.oid::text as elemoid
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    join lateral (
      with recursive walk(oid, depth) as (
        select a.atttypid, 0
        union all
        select p.typbasetype, w.depth + 1
        from walk w join pg_type p on p.oid = w.oid
        where p.typtype = 'd' and p.typbasetype is not null and w.depth < 16
      )
      select p.typname, p.typcategory, p.typelem, p.oid
      from walk w join pg_type p on p.oid = w.oid
      order by w.depth desc
      limit 1
    ) bt on true
    left join lateral (
      with recursive walk(oid, depth) as (
        select bt.typelem, 0
        union all
        select p.typbasetype, w.depth + 1
        from walk w join pg_type p on p.oid = w.oid
        where p.typtype = 'd' and p.typbasetype is not null and w.depth < 16
      )
      select p.typname, p.typcategory, p.oid
      from walk w join pg_type p on p.oid = w.oid
      order by w.depth desc
      limit 1
    ) et on true
    where c.relname = ${relname}
      and (${schema}::text is null or n.nspname = ${schema})
      and a.attnum > 0
      and not a.attisdropped
    order by a.attnum
  `;
}

/** Parse a catalog OID delivered as text (or already numeric by a fixture). */
function parseOid(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function parseColumnMetadata(rows: readonly unknown[]): Map<string, ColumnMeta> {
  const meta = new Map<string, ColumnMeta>();
  for (const row of rows as Array<Record<string, unknown>>) {
    const name = row?.attname;
    if (typeof name !== 'string') continue; // malformed catalog row: ignore defensively
    meta.set(name, {
      attname: name,
      attnotnull: row?.attnotnull === true,
      basecategory: typeof row?.basecategory === 'string' ? row.basecategory : null,
      basetypname: typeof row?.basetypname === 'string' ? row.basetypname : null,
      baseoid: parseOid(row?.baseoid),
      elemcategory: typeof row?.elemcategory === 'string' ? row.elemcategory : null,
      elemtypname: typeof row?.elemtypname === 'string' ? row.elemtypname : null,
      elemoid: parseOid(row?.elemoid),
    });
  }
  return meta;
}

/**
 * True when the column's native driver transport is lossy or ambiguous and the
 * payload must carry the exact `col::text` rendering instead: date/time
 * categories and intervals (JS `Date` truncates microseconds), `json`/`jsonb`
 * (documents, scalars and `null` become indistinguishable from SQL values once
 * parsed), arrays whose ELEMENTS fall in those categories or are
 * numeric-family (`numeric[]`/`decimal[]` — the driver parses numeric array
 * ELEMENTS as binary doubles and silently rounds beyond double precision,
 * while a scalar `numeric` stays an exact string; the element walk already
 * resolves domains and multidimensional arrays to the `numeric` base type,
 * OID 1700), and anything the catalog could not resolve (unresolvable ⇒ the
 * exact text rendering is the only transport guaranteed lossless). All other
 * types — numbers, text, booleans, `bytea`, `text[]`/`int8[]`-style arrays —
 * round-trip natively.
 */
function isTextualColumn(meta: ColumnMeta): boolean {
  if (meta.basecategory === 'A') {
    return (
      meta.elemcategory === null || // unresolvable element ⇒ text is the safe transport
      TEMPORAL_CATEGORIES.has(meta.elemcategory) ||
      JSON_TYPE_NAMES.has(meta.elemtypname ?? '') ||
      // numeric/decimal[] (incl. domains over numeric and multidimensional
      // arrays): elements arrive as lossy JS numbers. The name check covers
      // catalog answers without OIDs (fakes); text transport is lossless
      // either way, so a conservative classification is always safe.
      meta.elemoid === NUMERIC_OID ||
      meta.elemtypname === 'numeric'
    );
  }
  return (
    meta.basecategory === null || // unresolvable type ⇒ text is the safe transport
    TEMPORAL_CATEGORIES.has(meta.basecategory) ||
    JSON_TYPE_NAMES.has(meta.basetypname ?? '')
  );
}

/** True when two metadata rows classify the same column differently (drift). */
function classificationChanged(before: ColumnMeta, after: ColumnMeta): boolean {
  return (
    before.baseoid !== after.baseoid ||
    before.elemoid !== after.elemoid ||
    before.basecategory !== after.basecategory ||
    before.basetypname !== after.basetypname ||
    before.elemcategory !== after.elemcategory ||
    before.elemtypname !== after.elemtypname
  );
}


function configurationError(message: string): SyncError {
  return new SyncError(message, 'CONFIGURATION');
}

function contractError(message: string): SyncError {
  return new SyncError(message, 'CONTRACT');
}

function toNameList(name: string | readonly string[], what: string): string[] {
  const parts = typeof name === 'string' ? [name] : [...name];
  if (parts.length === 0) {
    throw configurationError(`${what} must not be empty.`);
  }
  for (const part of parts) {
    if (typeof part !== 'string' || part.length === 0) {
      throw configurationError(`${what} segments must be non-empty strings.`);
    }
  }
  return parts;
}

/** Reject names reserved for internal cursor projection aliases. */
function rejectReservedNames(names: readonly string[], what: string, identity: string): void {
  for (const name of names) {
    if (name.startsWith(CURSOR_ALIAS_PREFIX)) {
      throw configurationError(
        `Source "${identity}": ${what} name "${name}" uses the reserved "${CURSOR_ALIAS_PREFIX}" prefix.`,
      );
    }
  }
}

/**
 * Validate every identifier up front by building quoted fragments. Invalid names
 * fail at construction — before any connection is opened or query is sent.
 */
function quotedNames(names: readonly string[], what: string, identity: string): SqlStatement[] {
  return names.map((name) => {
    try {
      return sql.identifier(name);
    } catch (error) {
      throw new SyncError(
        `Invalid ${what} name: ${JSON.stringify(name)}. Use validated identifiers only ` +
          `(values must stay bound parameters; identifiers must pass sql.identifier). ` +
          `Detail: ${(error as Error).message}`,
        'CONFIGURATION',
      );
    }
  });
}

function tableFragment(parts: readonly string[]): SqlStatement {
  try {
    return sql.identifier(parts); // dot-joined, each segment quoted
  } catch (error) {
    throw new SyncError(
      `Invalid table name segments: ${parts.map((p) => JSON.stringify(p)).join(', ')}. ` +
        `Detail: ${(error as Error).message}`,
      'CONFIGURATION',
    );
  }
}

function requireIdentity(value: unknown, what: 'source' | 'target'): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw configurationError(
      `createSql${what === 'source' ? 'Source' : 'Target'} requires an explicit, stable, ` +
        'secret-free identity string that distinguishes THIS endpoint\'s table ' +
        '(e.g. "supabase:proj-ref.public.events"). There is no safe default: an adapter id ' +
        'and table name do not identify the database, and a default-derived checkpoint key ' +
        'would silently collide across different database pairs.',
    );
  }
  return value;
}

export type SqlSourceOptions = {
  db: Database;
  /** Table name, e.g. `'events'` or `['public', 'events']`. Each segment is quoted. */
  table: string | readonly string[];
  /**
   * Cursor column(s). The combination must be a uniquely total-ordered set of NOT
   * NULL columns (e.g. a primary key, or `(updated_at, id)` with a unique index on
   * a subset of them). Enforced per {@link SqlSourceOptions.uniqueOrder}; NULL
   * cursor values are refused at read time rather than skipped.
   */
  orderBy: string | readonly string[];
  /**
   * **Required.** Stable, secret-free identity of this endpoint's table — it names
   * the checkpoint. Must be stable across runs for the same database pair and
   * distinct across different pairs. dbSDK never derives it from the adapter id,
   * table name, or connection string (no guessing, no credentials).
   */
  identity: string;
  /**
   * Projection. Default `*` (every column).
   *
   * Payload representation: columns whose native driver transport is lossy or
   * ambiguous — date/time categories, intervals, `json`/`jsonb`, arrays of
   * those, numeric-family arrays (`numeric[]`/`decimal[]`, domains over
   * numeric, multidimensional arrays), and anything the catalog cannot
   * resolve — are delivered as their exact PostgreSQL `col::text` rendering
   * (a string), so the default copy is value-faithful: microseconds survive,
   * `[]` stays an array, JSON `null` stays JSON null, every `numeric[]` digit
   * survives. Convert in `map` (e.g. `JSON.parse`, `new Date`) when you need
   * typed values in transform logic. All other columns keep native JS values.
   *
   * Schema snapshot: every read projects an explicit, table-qualified column
   * list frozen from the metadata cached on the first read (never `SELECT *`).
   * Subsequent reads re-validate that snapshot against the live catalog and
   * fail with a CONTRACT error before the data query when a column was added,
   * removed, or retyped — recreate the source (same identity) to pick up the
   * new schema. An explicit list MAY ignore unselected added/removed columns,
   * but selected columns' existence and types are still guarded.
   */
  columns?: readonly string[];
  /** Extra parameterized filter (`sql` fragment), ANDed with the keyset predicate. */
  where?: SqlStatement;
  /**
   * How the unique-total-order precondition of `orderBy` is established.
   *
   * - `'verify'` (default): on the first read, read-only catalog queries check that
   *   the table has a valid, non-partial, non-expression unique index whose key
   *   columns are a subset of the `orderBy` columns, and that every `orderBy`
   *   column is declared NOT NULL. Without one, the read fails with a CONTRACT
   *   error BEFORE any rows are read or written. Runs once per source instance.
   * - `'assume'`: explicit caller opt-out for orderings that are unique in practice
   *   but carry no declared unique index. It skips ONLY the unique-index check:
   *   the column-metadata inspection still runs in both modes (it drives the
   *   exact-payload projection and refuses real columns that would collide with
   *   the internal `__dbsdk_cursor_*` aliases — a wildcard projection cannot be
   *   checked at construction time). As defense in depth, duplicate cursor
   *   tuples within one returned page still fail with a CONTRACT error — but a
   *   non-unique ordering with `batchSize: 1` or ties spanning page boundaries
   *   remains silently lossy. Prefer `'verify'`.
   */
  uniqueOrder?: 'verify' | 'assume';
};

export function createSqlSource(options: SqlSourceOptions): SyncSource<Record<string, unknown>> {
  if (typeof options?.db?.query !== 'function') {
    throw configurationError('createSqlSource requires a dbSDK Database client.');
  }
  const identity = requireIdentity(options.identity, 'source');
  const tableParts = toNameList(options.table, 'table');
  const orderCols = toNameList(options.orderBy, 'orderBy');
  rejectReservedNames(orderCols, 'orderBy', identity);
  const orderFrags = quotedNames(orderCols, 'orderBy', identity);
  const tableFrag = tableFragment(tableParts);
  // Table qualifier for ORDER BY and the explicit projections: always resolves
  // to the source columns, never to an output/alias name.
  const tableQualifier = sql.identifier(tableParts[tableParts.length - 1]!);
  const uniqueOrder = options.uniqueOrder ?? 'verify';
  if (uniqueOrder !== 'verify' && uniqueOrder !== 'assume') {
    throw configurationError(`uniqueOrder must be 'verify' or 'assume' (got ${String(uniqueOrder)}).`);
  }

  // Exact-precision cursor projection: every ordering column is additionally
  // selected as text under an internal alias, then stripped from the rows. The
  // predicate and ORDER BY keep using the original columns.
  const cursorAliases = orderCols.map((_, index) => `${CURSOR_ALIAS_PREFIX}${index}`);
  const cursorProjection = sql.join(
    orderFrags.map(
      (frag, index) =>
        sql`${tableQualifier}.${frag}::text as ${sql.identifier(cursorAliases[index]!)}`,
    ),
    ', ',
  );
  const colFrags =
    options.columns === undefined
      ? undefined
      : quotedNames(toNameList(options.columns, 'columns'), 'column', identity);
  if (colFrags !== undefined) {
    rejectReservedNames(toNameList(options.columns!, 'columns'), 'columns', identity);
  }

  // Builds `where (a, b) > ($n, $n+1)` (or `where a > $n` for one column) from
  // decoded cursor values. Values are strings (PG's exact text rendering); PG
  // infers the parameter types from the compared columns.
  function keysetPredicate(values: readonly unknown[]): SqlStatement {
    const lhs = sql`(${sql.join(orderFrags, ', ')})`;
    const rhs = sql`(${sql.join(
      values.map((value) => sql`${value}`),
      ', ',
    )})`;
    return sql`${lhs} > ${rhs}`;
  }

  function decodeCursor(cursor: string): unknown[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(cursor);
    } catch {
      throw configurationError(`Invalid cursor for source "${identity}": not valid JSON.`);
    }
    if (!Array.isArray(parsed) || parsed.length !== orderCols.length) {
      throw configurationError(
        `Invalid cursor for source "${identity}": expected a JSON array of ${orderCols.length} value(s).`,
      );
    }
    for (const value of parsed) {
      if (
        value === null ||
        !(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      ) {
        throw configurationError(
          `Invalid cursor for source "${identity}": cursor values must be JSON primitives ` +
            '(NULL cursor values are refused — they would silently skip rows).',
        );
      }
    }
    return parsed;
  }

  /**
   * Preflight (once per source instance), BEFORE any data is read:
   * 1. `verify` mode only: establish the unique-total-order precondition via the
   *    catalog. Failures are CONTRACT errors; catalog query errors pass through.
   * 2. Both modes: resolve column metadata (names, NOT NULL, domain- and
   *    element-resolved types). This drives the exact-payload projection, and it
   *    guards the internal cursor-alias namespace: any REAL column that would be
   *    projected and collide with a reserved `__dbsdk_cursor_*` alias is refused
   *    (a wildcard projection cannot be checked at construction time — R4
   *    finding B). `assume` skips only the unique-index check, never this
   *    metadata inspection: there is no bypass.
   *
   * The resolved metadata is also the SCHEMA SNAPSHOT every later read
   * re-validates against the live catalog (see `assertSchemaUnchanged`), and
   * the frozen projection is built from it — so the statement shape of a
   * given source instance never changes mid-run and cannot collide with DDL
   * that races between the snapshot check and a data read.
   */
  let preflightPromise: Promise<Map<string, ColumnMeta>> | null = null;
  let schemaSnapshot: Map<string, ColumnMeta> | null = null;
  function preflight(): Promise<Map<string, ColumnMeta>> {
    preflightPromise ??= (async () => {
      if (uniqueOrder === 'verify') {
        await verifyUniqueOrder();
      }
      const metadata = await options.db.query<ColumnMeta>(columnMetadataQuery(tableParts));
      const meta = parseColumnMetadata(metadata.rows);

      // Every orderBy column must exist and, in verify mode, be NOT NULL (a
      // NULL cursor value cannot be encoded and would silently skip rows).
      const missing = orderCols.filter((col) => !meta.has(col));
      if (missing.length > 0) {
        throw contractError(
          `Source "${identity}": orderBy column(s) ${missing
            .map((c) => `"${c}"`)
            .join(', ')} not found on ${tableFrag.text}. Check the table and column names.`,
        );
      }
      if (uniqueOrder === 'verify') {
        const nullable = orderCols.filter((col) => meta.get(col)!.attnotnull === false);
        if (nullable.length > 0) {
          throw contractError(
            `Source "${identity}": orderBy column(s) ${nullable
              .map((c) => `"${c}"`)
              .join(', ')} are nullable. NULL cursor values cannot be encoded and would ` +
              'silently skip rows. Declare the column(s) NOT NULL or choose other cursor columns.',
          );
        }
      }

      // Reserved-alias collision guard over the columns that will actually be
      // PROJECTED (wildcard: every real column; explicit: the caller's list —
      // an explicit list that omits a reserved real column is safe and allowed).
      const projectedNames =
        colFrags === undefined ? [...meta.keys()] : toNameList(options.columns!, 'columns');
      const reserved = projectedNames.filter((name) => name.startsWith(CURSOR_ALIAS_PREFIX));
      if (reserved.length > 0) {
        throw contractError(
          `Source "${identity}": the table has real column(s) ${reserved
            .map((c) => `"${c}"`)
            .join(', ')} using the reserved internal alias prefix "${CURSOR_ALIAS_PREFIX}". ` +
            'Projecting them would silently drop their data (the internal cursor aliases ' +
            'overwrite the same output names and are then stripped). Rename the column(s), ' +
            'or pass an explicit `columns` list that omits them.',
        );
      }
      return meta;
    })();
    return preflightPromise;
  }

  /** `verify`-mode catalog check: a valid unique index over a subset of orderBy. */
  async function verifyUniqueOrder(): Promise<void> {
    const relname = tableParts[tableParts.length - 1]!;
    const schema = tableParts.length >= 2 ? tableParts[0] : null;

    // A valid unique index (PK counts; partial/expression indexes excluded;
    // INCLUDE columns excluded via indnkeyatts) whose KEY columns are a
    // subset of the orderBy columns.
    const indexResult = await options.db.query<{ ok: number }>(sql`
      select 1 as ok
      from pg_index i
      join pg_class t on t.oid = i.indrelid
      join pg_namespace n on n.oid = t.relnamespace
      where t.relname = ${relname}
        and (${schema}::text is null or n.nspname = ${schema})
        and i.indisunique
        and i.indisvalid
        and i.indpred is null
        and i.indexprs is null
        and (
          select array_agg(a.attname::text order by k.ord)
          from unnest(i.indkey::smallint[]) with ordinality as k(attnum, ord)
          join pg_attribute a
            on a.attrelid = t.oid and a.attnum = k.attnum and not a.attisdropped
          where k.ord <= i.indnkeyatts
        ) <@ ${orderCols}::text[]
      limit 1
    `);
    if (indexResult.rows.length === 0) {
      throw contractError(
        `Source "${identity}": no unique index on ${tableFrag.text} covers a subset of the ` +
          `orderBy columns (${orderCols.map((c) => `"${c}"`).join(', ')}). Keyset pagination ` +
          'without a unique total order SILENTLY SKIPS rows at page boundaries. Create a ' +
          'unique index on a subset of these columns (e.g. orderBy ("updated_at", "id") with ' +
          "the primary key on (\"id\")), or pass uniqueOrder: 'assume' to accept the risk " +
          'explicitly.',
      );
    }
  }

  /**
   * Schema-drift guard (R6 finding B repair): every read AFTER the first
   * re-queries the catalog and compares the live table against the snapshot
   * cached at preflight, BEFORE the data query is dispatched. Default
   * (wildcard) projection: the full column set and base classifications must
   * match — a column added, removed, or retyped after the snapshot fails with
   * an actionable CONTRACT error (nothing read, written, or checkpointed; a
   * NEW microsecond-timestamp column can therefore never silently lose
   * precision, and a NEW column named exactly like an internal cursor alias
   * can never silently collide or be dropped). An explicit `columns` list
   * may ignore UNSELECTED added/removed columns (documented contract), but
   * the selected columns' existence and types are guarded.
   */
  async function assertSchemaUnchanged(snapshot: Map<string, ColumnMeta>): Promise<void> {
    const result = await options.db.query<ColumnMeta>(columnMetadataQuery(tableParts));
    const fresh = parseColumnMetadata(result.rows);

    if (colFrags === undefined) {
      const added: string[] = [];
      const removed: string[] = [];
      const retyped: string[] = [];
      for (const name of fresh.keys()) {
        if (!snapshot.has(name)) added.push(name);
      }
      for (const [name, before] of snapshot) {
        const after = fresh.get(name);
        if (after === undefined) removed.push(name);
        else if (classificationChanged(before, after)) retyped.push(name);
      }
      if (added.length > 0 || removed.length > 0 || retyped.length > 0) {
        const details = [
          added.length > 0
            ? `added column(s) ${added.map((c) => `"${c}"`).join(', ')}`
            : null,
          removed.length > 0
            ? `removed column(s) ${removed.map((c) => `"${c}"`).join(', ')}`
            : null,
          retyped.length > 0
            ? `changed type of column(s) ${retyped.map((c) => `"${c}"`).join(', ')}`
            : null,
        ]
          .filter((part): part is string => part !== null)
          .join('; ');
        throw contractError(
          `Source "${identity}": the source table's schema changed after this instance ` +
            `cached its column metadata: ${details}. The transfer is bound to the schema ` +
            'snapshot cached on the first read — reads use a frozen, explicitly projected ' +
            'column list, so a new column can neither silently appear in the payload, nor ' +
            'collide with an internal cursor alias, nor silently lose precision. To ' +
            'continue against the new schema, recreate the source (a new createSqlSource ' +
            'with the same identity — the existing checkpoint key remains valid). Nothing ' +
            'was read or written for this page.',
        );
      }
      return;
    }

    for (const name of toNameList(options.columns!, 'columns')) {
      const after = fresh.get(name);
      if (after === undefined) {
        throw contractError(
          `Source "${identity}": selected column "${name}" no longer exists on the source ` +
            'table (dropped or renamed since the cached preflight). Recreate the source ' +
            'instance with the updated column list. Nothing was read or written for this page.',
        );
      }
      const before = snapshot.get(name);
      if (before !== undefined && classificationChanged(before, after)) {
        throw contractError(
          `Source "${identity}": selected column "${name}" changed type since the cached ` +
            'preflight — the frozen projection no longer matches the table. Recreate the ' +
            'source instance with the updated column list. Nothing was read or written for ' +
            'this page.',
        );
      }
    }
  }

  /**
   * Build the row-payload projection from the RESOLVED (snapshot) column
   * metadata: always an explicit, table-qualified column list — never
   * `SELECT *`. Lossy/ambiguous columns are re-projected as `col::text as
   * col`; lossless columns pass through natively. Because the projection is
   * derived from the frozen snapshot, the statement shape of a given source
   * instance is stable and DDL racing between the snapshot check and a data
   * read cannot add, drop, or overwrite requested fields.
   */
  function payloadProjection(meta: Map<string, ColumnMeta>): SqlStatement {
    const names =
      colFrags === undefined ? [...meta.keys()] : toNameList(options.columns!, 'columns');
    const parts = names.map((name, index) => {
      const frag =
        colFrags === undefined ? quotedNames([name], 'column', identity)[0]! : colFrags[index]!;
      const column = meta.get(name);
      const qualified = sql`${tableQualifier}.${frag}`;
      return column !== undefined && isTextualColumn(column)
        ? sql`${qualified}::text as ${frag}`
        : qualified;
    });
    if (parts.length === 0) {
      // Unreachable in practice (the preflight guarantees the orderBy columns
      // exist, so the snapshot is never empty), but never emit an empty list.
      throw contractError(`Source "${identity}": the column metadata resolved to no columns.`);
    }
    return sql.join(parts, ', ');
  }

  return {
    identity,
    ordering: 'ordered',

    async read(cursor, limit, readOptions) {
      if (readOptions?.signal?.aborted) {
        throw new SyncError(`Source "${identity}" read aborted.`, 'ABORTED');
      }
      if (!Number.isInteger(limit) || limit < 1) {
        throw configurationError(`Source "${identity}" read limit must be a positive integer.`);
      }
      const meta = await preflight();
      // First read: the just-fetched metadata IS the fresh snapshot. Every
      // later read re-validates it against the live catalog BEFORE the data
      // query is dispatched (schema drift fails loudly, nothing read/written).
      if (schemaSnapshot === null) {
        schemaSnapshot = meta;
      } else {
        await assertSchemaUnchanged(schemaSnapshot);
      }
      const params: unknown[] | null = cursor === null ? null : decodeCursor(cursor);
      const predicate = params === null ? null : keysetPredicate(params);
      // ORDER BY must be table-qualified: qualified references always resolve
      // to the source column, never to an output name. The payload projection
      // (built from the frozen snapshot) is explicitly qualified for the same
      // reason — no `SELECT *`, no output-name ambiguity.
      const orderFrag = sql.join(
        orderFrags.map((frag) => sql`${tableQualifier}.${frag}`),
        ', ',
      );
      const projection = payloadProjection(meta);

      const statement =
        predicate === null
          ? options.where
            ? sql`select ${projection}, ${cursorProjection} from ${tableFrag} where ${options.where} order by ${orderFrag} limit ${limit}`
            : sql`select ${projection}, ${cursorProjection} from ${tableFrag} order by ${orderFrag} limit ${limit}`
          : options.where
            ? sql`select ${projection}, ${cursorProjection} from ${tableFrag} where ${options.where} and ${predicate} order by ${orderFrag} limit ${limit}`
            : sql`select ${projection}, ${cursorProjection} from ${tableFrag} where ${predicate} order by ${orderFrag} limit ${limit}`;

      const result = await options.db.query<Record<string, unknown>>(statement);
      const rawRows = result.rows;
      if (rawRows.length === 0) {
        return { rows: [], cursor: null };
      }

      // Extract the exact cursor tuple from the internal aliases (stripping them
      // from the rows without mutating the caller-facing objects), refusing NULLs
      // and non-primitive values. With a truly unique ordering, cursor tuples
      // within one page are strictly increasing — a duplicate means the ordering
      // is NOT unique and rows would be silently skipped at page boundaries.
      const seenTuples = new Set<string>();
      let lastValues: unknown[] | undefined;
      const rows: Record<string, unknown>[] = [];
      for (const [rowIndex, rawRow] of rawRows.entries()) {
        const values: unknown[] = [];
        for (const [aliasIndex, alias] of cursorAliases.entries()) {
          if (!(alias in rawRow)) {
            throw contractError(
              `Source "${identity}": internal cursor column "${alias}" is missing from row ` +
                `${rowIndex}. The cursor projection must survive to the source (do not strip ` +
                'it upstream).',
            );
          }
          const value = rawRow[alias];
          if (value === null || value === undefined) {
            throw contractError(
              `Source "${identity}": column "${orderCols[aliasIndex]}" is NULL in row ` +
                `${rowIndex}. orderBy columns must be NOT NULL — a NULL cursor value would ` +
                'silently skip rows.',
            );
          }
          if (
            !(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
          ) {
            throw contractError(
              `Source "${identity}": column "${orderCols[aliasIndex]}" has non-encodable type ` +
                `${typeof value}. Cursor columns must project to primitives.`,
            );
          }
          values.push(value);
        }
        const tupleKey = JSON.stringify(values);
        if (seenTuples.has(tupleKey)) {
          throw contractError(
            `Source "${identity}": duplicate cursor values ${tupleKey} within one page — the ` +
              'orderBy columns are NOT uniquely total-ordered, so keyset pagination would ' +
              'silently skip rows at page boundaries. Use a composite (col…, unique-id) cursor.',
          );
        }
        seenTuples.add(tupleKey);
        // Strip the internal aliases into a fresh row object. As defense in
        // depth, any NON-alias key with the reserved prefix is refused rather
        // than silently overwritten/dropped. (The schema-drift guard above
        // already rejects columns added after the snapshot — including one
        // named exactly like an alias, which cannot collide anymore because
        // the projection is explicit and frozen.)
        const aliasSet = new Set(cursorAliases);
        const row: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(rawRow)) {
          if (aliasSet.has(key)) continue;
          if (key.startsWith(CURSOR_ALIAS_PREFIX)) {
            throw contractError(
              `Source "${identity}": the result contains a real column "${key}" using the ` +
                `reserved internal alias prefix "${CURSOR_ALIAS_PREFIX}". Projecting it would ` +
                'silently drop its data. Rename the column, or pass an explicit `columns` list ' +
                'that omits it.',
            );
          }
          row[key] = value;
        }
        rows.push(row);
        lastValues = values;
      }

      if (lastValues === undefined) {
        return { rows: [], cursor: null }; // unreachable when rows.length > 0; keeps strict typing honest
      }
      return { rows, cursor: JSON.stringify(lastValues) };
    },
  };
}

export type SqlTargetOptions = {
  db: Database;
  table: string | readonly string[];
  /**
   * Identity/conflict columns. The table must have a matching unique index —
   * without one, PostgreSQL rejects the upsert (error surfaces as-is, no silent
   * data rewrite).
   */
  key: string | readonly string[];
  /**
   * **Required.** Stable, secret-free identity of this endpoint's table — it names
   * the checkpoint. Same rules as the source identity.
   */
  identity: string;
  /**
   * Default: derived from the first written row (all rows must share the same
   * keys). Top-level JavaScript array values are encoded by column type:
   * natively for PostgreSQL array columns, as JSON text for `json`/`jsonb`
   * columns, and refused (CONTRACT, before any write) for anything the catalog
   * cannot resolve to one of those.
   */
  columns?: readonly string[];
  /** `'update'` (default): re-applied batches overwrite. `'nothing'`: re-applied batches are ignored. */
  onConflict?: 'update' | 'nothing';
};

export function createSqlTarget(options: SqlTargetOptions): SyncTarget<Record<string, unknown>> {
  if (typeof options?.db?.query !== 'function') {
    throw configurationError('createSqlTarget requires a dbSDK Database client.');
  }
  const identity = requireIdentity(options.identity, 'target');
  const tableParts = toNameList(options.table, 'table');
  const keyCols = toNameList(options.key, 'key');
  const keyFrags = quotedNames(keyCols, 'key', identity);
  const tableFrag = tableFragment(tableParts);
  const onConflict = options.onConflict ?? 'update';
  if (onConflict !== 'update' && onConflict !== 'nothing') {
    throw configurationError(`onConflict must be 'update' or 'nothing' (got ${String(onConflict)}).`);
  }
  if (options.columns !== undefined) {
    const explicit = toNameList(options.columns, 'columns');
    for (const col of keyCols) {
      if (!explicit.includes(col)) {
        throw configurationError(
          `Target "${identity}": key column "${col}" is not among the written columns.`,
        );
      }
    }
  }

  function columnsOf(firstRow: Record<string, unknown>): string[] {
    const explicit = options.columns;
    const cols = explicit
      ? toNameList(explicit, 'columns')
      : Object.keys(firstRow);
    if (cols.length === 0) {
      throw configurationError(`Target "${identity}" has no columns to write.`);
    }
    for (const col of keyCols) {
      if (!cols.includes(col)) {
        throw configurationError(
          `Target "${identity}": key column "${col}" is not among the written columns.`,
        );
      }
    }
    return cols;
  }

  /**
   * Target column types (one cached catalog query per instance), resolved ONLY
   * when a batch actually contains a top-level JavaScript array value — the one
   * case where encoding depends on the column's type. Failures are cached too:
   * array values keep failing loudly instead of being guessed at.
   */
  let typeMapPromise: Promise<Map<string, ColumnMeta>> | null = null;
  function targetTypeMap(): Promise<Map<string, ColumnMeta>> {
    typeMapPromise ??= options.db
      .query<ColumnMeta>(columnMetadataQuery(tableParts))
      .then((result) => parseColumnMetadata(result.rows));
    return typeMapPromise;
  }

  /**
   * Encode one top-level JavaScript array value for its target column. A JS
   * array is the single ambiguous payload shape: for a `json`/`jsonb` column it
   * must become JSON text (the pg driver would otherwise send a PostgreSQL
   * array literal — `[]` silently became `{}`), for a PostgreSQL array column
   * it is passed through natively (the driver's array-literal encoding is
   * correct there), and for anything else/unresolvable it is REFUSED before
   * any write. Note `json[]`/`jsonb[]` element arrays are also refused: the
   * driver cannot encode object/array elements as array-literal strings
   * safely — pre-encode those as text in `map`.
   */
  function encodeArrayValue(col: string, value: readonly unknown[], meta: ColumnMeta | undefined): unknown {
    if (meta !== undefined) {
      if (meta.basecategory === 'A') {
        if (meta.elemtypname !== null && JSON_TYPE_NAMES.has(meta.elemtypname)) {
          throw contractError(
            `Target "${identity}": column "${col}" is ${meta.elemtypname}[] — a JavaScript ` +
              'array cannot be encoded natively for JSON array columns (the driver emits a ' +
              'PostgreSQL array literal that mis-encodes object/array elements). Pre-encode ' +
              'the value as PostgreSQL array-literal text in map, or use a json/jsonb column.',
          );
        }
        return value; // PG array column: native array-literal transport is exact
      }
      if (meta.basetypname !== null && JSON_TYPE_NAMES.has(meta.basetypname)) {
        return JSON.stringify(value);
      }
    }
    throw contractError(
      `Target "${identity}": column "${col}" received a JavaScript array value, but the ` +
        'column type is not a PostgreSQL array type or json/jsonb (it could not be resolved ' +
        'from the catalog). Encoding a JS array is type-dependent — a wrong guess silently ' +
        'corrupts data (e.g. `[]` becoming `{}` in jsonb). Pre-encode with JSON.stringify in ' +
        'map for json columns, or verify the target column type.',
    );
  }

  function insertStatement(
    cols: readonly string[],
    rows: readonly Record<string, unknown>[],
  ): SqlStatement {
    const colFrags = quotedNames(cols, 'column', identity); // validates; throws on bad names
    const tuples = rows.map((row) => {
      const values = cols.map((col) => {
        if (!(col in row)) {
          throw configurationError(
            `Target "${identity}": row is missing column "${col}" (all rows must share the same shape).`,
          );
        }
        return sql`${row[col]}`;
      });
      return sql`(${sql.join(values, ', ')})`;
    });

    const conflictClause =
      onConflict === 'update'
        ? sql`on conflict (${sql.join(keyFrags, ', ')}) do update set ${sql.join(
            colFrags.map((colFrag) => sql`${colFrag} = excluded.${colFrag}`),
            ', ',
          )}`
        : sql`on conflict (${sql.join(keyFrags, ', ')}) do nothing`;

    return sql`insert into ${tableFrag} (${sql.join(colFrags, ', ')}) values ${sql.join(
      tuples,
      ', ',
    )} ${conflictClause}`;
  }

  return {
    identity,
    writeMode: 'upsert',

    async write(rows, writeOptions) {
      if (!Array.isArray(rows)) {
        throw configurationError(`Target "${identity}" write expects an array of rows.`);
      }
      if (rows.length === 0) {
        return { written: 0 };
      }
      const cols = columnsOf(rows[0] as Record<string, unknown>);

      // Type-aware encoding of ambiguous (top-level array) values. Every value
      // is resolved BEFORE any statement is sent: an encoding refusal must not
      // happen after earlier chunks already committed.
      let hasArrayValue = false;
      for (const row of rows as Array<Record<string, unknown>>) {
        for (const col of cols) {
          if (Array.isArray(row[col])) hasArrayValue = true;
        }
      }
      const typeMap = hasArrayValue ? await targetTypeMap() : null;
      const encodedRows = (rows as Array<Record<string, unknown>>).map((row) => {
        const out: Record<string, unknown> = {};
        for (const col of cols) {
          if (!(col in row)) {
            throw configurationError(
              `Target "${identity}": row is missing column "${col}" (all rows must share the same shape).`,
            );
          }
          const value = row[col];
          out[col] =
            typeMap !== null && Array.isArray(value)
              ? encodeArrayValue(col, value, typeMap.get(col))
              : value;
        }
        return out;
      });

      const rowsPerStatement = Math.max(1, Math.floor(MAX_PARAMS_PER_STATEMENT / cols.length));

      let written = 0;
      for (let start = 0; start < rows.length; start += rowsPerStatement) {
        if (writeOptions?.signal?.aborted) {
          throw new SyncError(
            `Target "${identity}" write aborted.`,
            'ABORTED',
          );
        }
        const chunk = encodedRows.slice(start, start + rowsPerStatement);
        const result = await options.db.query(insertStatement(cols, chunk));
        written += result.rowCount ?? chunk.length;
      }
      return { written };
    },
  };
}
