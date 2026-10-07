/**
 * dbSDK-normalized Drizzle sessions for the two supported execution bridges.
 *
 * The factories in `./index.js` hand Drizzle the dbSDK-owned pool / Neon query
 * function unchanged (identity, `$client`, pool lifetime, TLS posture and all
 * pool semantics stay exactly as before). What changes is the SESSION layer:
 * instead of Drizzle's stock `NodePgSession` / `NeonHttpSession`, the bridge
 * installs subclasses that
 *
 * 1. normalize every query execution failure into the same `DbError` the core
 *    client produces (`code` / `sqlstate` / `retryable` / `indeterminate`,
 *    native driver error preserved on `cause`), and
 * 2. run transactions with dbSDK's semantics: `ROLLBACK` never masks the
 *    primary error, and a failure without a server SQLSTATE (transport or
 *    otherwise) is marked `indeterminate` exactly like `db.transaction` —
 *    because the callback's writes may or may not have committed.
 *
 * Drizzle's stock `NodePgSession.transaction` has two behaviors dbSDK cannot
 * accept for its own bridge: a failed `ROLLBACK` **replaces** the original
 * error (the primary failure is lost), and no error is ever marked as having
 * an unknowable write outcome. Both are fixed here while keeping the same
 * generated SQL (`begin`, `begin isolation level ...`, `commit`, `savepoint
 * spN`, ...), the same pooled-client lease/release behavior, and Drizzle's
 * `TransactionRollbackError` control flow for `tx.rollback()`.
 *
 * Everything here is built on the stable driver's own exported classes
 * (`drizzle-orm/node-postgres`, `drizzle-orm/neon-http` — Apache-2.0), reached
 * through the same lazy dynamic imports the factories already use, so the
 * optional peer is only required when a factory is actually called.
 */

import type {
  NodePgClient,
  NodePgDatabase,
  NodePgPreparedQuery,
  NodePgSession,
  NodePgSessionOptions,
  NodePgTransaction,
} from 'drizzle-orm/node-postgres';
import type {
  NeonHttpDatabase,
  NeonHttpClient,
  NeonHttpPreparedQuery,
  NeonHttpSession,
  NeonHttpSessionOptions,
  NeonTransaction,
} from 'drizzle-orm/neon-http';
import type { PgDialect } from 'drizzle-orm/pg-core';
import type { PgTransactionConfig, PreparedQueryConfig } from 'drizzle-orm/pg-core/session';
import type { SelectedFieldsOrdered } from 'drizzle-orm/pg-core/query-builders/select.types';
import type { BatchItem } from 'drizzle-orm/batch';
import type { Cache } from 'drizzle-orm/cache/core';
import type { WithCacheConfig } from 'drizzle-orm/cache/core/types';
import type { Logger } from 'drizzle-orm/logger';
import type { Query } from 'drizzle-orm/sql/sql';
import type { ExtractTablesWithRelations, RelationalSchemaConfig, TablesRelationalConfig } from 'drizzle-orm/relations';
import type { Pool, PoolClient } from 'pg';

import { DbError } from '../errors.js';
import { finalizeBatchError, finalizeTransactionError, normalizeStatementFailure } from './normalize.js';
import type { DrizzleInteropConfig } from './index.js';
import type { createTableRelationsHelpers, extractTablesRelationalConfig } from 'drizzle-orm/relations';

/** Session options extension used to thread the owning adapter's id. */
type BridgeSessionOptions = {
  /** Internal: the `Database.adapterId` for `DbError.adapterId` attribution. */
  dbSdk: { adapterId: string };
};
type PgBridgeSessionOptions = NodePgSessionOptions & BridgeSessionOptions;
type NeonBridgeSessionOptions = NeonHttpSessionOptions & BridgeSessionOptions;

/** What the Drizzle bridge gets from its own error-normalizing session layer. */
export interface PgBridge {
  buildNodePgDatabase<TSchema extends Record<string, unknown>>(
    client: Pool,
    config: DrizzleInteropConfig<TSchema>,
    adapterId: string,
  ): NodePgDatabase<TSchema> & { $client: Pool };
}

export interface NeonHttpBridge {
  buildNeonHttpDatabase<TSchema extends Record<string, unknown>>(
    client: NeonHttpClient,
    config: DrizzleInteropConfig<TSchema>,
    adapterId: string,
  ): NeonHttpDatabase<TSchema> & { $client: NeonHttpClient };
}

let pgBridgePromise: Promise<PgBridge> | undefined;

/** Lazily build (once) the error-normalizing node-postgres session layer. */
export function loadPgBridge(): Promise<PgBridge> {
  pgBridgePromise ??= createPgBridge();
  // Do not cache rejections: after installing the missing peer the factory
  // can be retried within the same process.
  return pgBridgePromise.catch((error: unknown) => {
    pgBridgePromise = undefined;
    throw error;
  });
}

let neonBridgePromise: Promise<NeonHttpBridge> | undefined;

/** Lazily build (once) the error-normalizing neon-http session layer. */
export function loadNeonHttpBridge(): Promise<NeonHttpBridge> {
  neonBridgePromise ??= createNeonHttpBridge();
  return neonBridgePromise.catch((error: unknown) => {
    neonBridgePromise = undefined;
    throw error;
  });
}

/**
 * Quietly run a statement on the client that owns the transaction, mirroring
 * `rollbackQuietly` in `adapters/pg-engine.js`. Failures are swallowed: the
 * original error is what matters, and the lease is released in `finally`.
 */
async function runQuietly(client: NodePgClient, text: string): Promise<boolean> {
  try {
    await client.query({ text });
    return true;
  } catch {
    return false;
  }
}

/**
 * Replicate Drizzle 0.45.3's internal `PgTransaction.getTransactionConfigSQL`
 * (not part of its published typings) from the public `PgTransactionConfig`
 * shape, so `drizzleDb.transaction(fn, config)` sends byte-identical SQL to
 * the stock bridge: `begin`, `begin isolation level serializable`,
 * `begin isolation level read committed read only deferrable`, ...
 */
function transactionConfigChunks(config: PgTransactionConfig): string[] {
  const chunks: string[] = [];
  if (config.isolationLevel) chunks.push(`isolation level ${config.isolationLevel}`);
  if (config.accessMode) chunks.push(config.accessMode);
  if (typeof config.deferrable === 'boolean') chunks.push(config.deferrable ? 'deferrable' : 'not deferrable');
  return chunks;
}

/** Drizzle batch items expose `_prepare().getQuery()` (see NeonHttpSession.batch). */
type BatchItemInternals = { _prepare?: () => { getQuery?: () => { sql?: unknown } } | undefined };

function batchItemTexts(queries: readonly unknown[]): string[] {
  return queries.map((item) => {
    const candidate = item as BatchItemInternals;
    try {
      const query = candidate._prepare?.call(candidate)?.getQuery?.();
      return typeof query?.sql === 'string' ? query.sql : '';
    } catch {
      // Building the text for error context must never introduce a new failure.
      return '';
    }
  });
}

function resolveLogger<TSchema extends Record<string, unknown>>(
  config: DrizzleInteropConfig<TSchema> | undefined,
  DefaultLogger: new () => Logger,
): Logger | undefined {
  const logger = config?.logger;
  if (logger === true) return new DefaultLogger();
  if (logger === false || logger === undefined) return undefined;
  return logger;
}

/**
 * Same schema assembly as Drizzle's own `construct()`: the
 * `{ fullSchema, schema, tableNamesMap }` relational config the drivers build
 * from `config.schema`. The assertion matches Drizzle's dynamic assembly of
 * exactly this shape (`RelationalSchemaConfig`).
 */
function buildSchemaConfig<TSchema extends Record<string, unknown>>(
  config: DrizzleInteropConfig<TSchema> | undefined,
  extract: typeof extractTablesRelationalConfig,
  helpers: typeof createTableRelationsHelpers,
): RelationalSchemaConfig<ExtractTablesWithRelations<TSchema>> | undefined {
  if (!config?.schema) return undefined;
  const tablesConfig = extract<ExtractTablesWithRelations<TSchema>>(config.schema, helpers);
  return {
    fullSchema: config.schema,
    schema: tablesConfig.tables,
    tableNamesMap: tablesConfig.tableNamesMap,
  } as RelationalSchemaConfig<ExtractTablesWithRelations<TSchema>>;
}

async function createPgBridge(): Promise<PgBridge> {
  const [nodePg, pgCore, relations, loggerModule, cacheModule, sqlModule, drizzleErrors, pgModule] =
    await Promise.all([
      import('drizzle-orm/node-postgres'),
      import('drizzle-orm/pg-core'),
      import('drizzle-orm/relations'),
      import('drizzle-orm/logger'),
      import('drizzle-orm/cache/core'),
      import('drizzle-orm/sql'),
      import('drizzle-orm/errors'),
      import('pg').catch(() => undefined),
    ]);
  const { NodePgDatabase, NodePgSession, NodePgPreparedQuery, NodePgTransaction } = nodePg;
  const { PgDialect } = pgCore;
  const { extractTablesRelationalConfig, createTableRelationsHelpers } = relations;
  const { DefaultLogger, NoopLogger } = loggerModule;
  const { NoopCache } = cacheModule;
  const { sql } = sqlModule;
  const { TransactionRollbackError } = drizzleErrors;
  // cjs-module-lexer usually exposes named exports on the namespace; fall back
  // to the CJS default (module.exports) when it does not.
  const PgPool: typeof Pool | undefined =
    pgModule?.Pool ?? (pgModule as { default?: { Pool?: typeof Pool } } | undefined)?.default?.Pool;

  class DbSdkNodePgPreparedQuery<T extends PreparedQueryConfig> extends NodePgPreparedQuery<T> {
    private readonly dbSdkAdapterId: string;

    constructor(
      client: NodePgClient,
      queryString: string,
      params: unknown[],
      logger: Logger,
      cache: Cache,
      queryMetadata: { type: 'select' | 'update' | 'delete' | 'insert'; tables: string[] } | undefined,
      cacheConfig: WithCacheConfig | undefined,
      fields: SelectedFieldsOrdered | undefined,
      name: string | undefined,
      isResponseInArrayMode: boolean,
      customResultMapper: ((rows: unknown[][]) => T['execute']) | undefined,
      adapterId: string,
    ) {
      super(
        client,
        queryString,
        params,
        logger,
        cache,
        queryMetadata,
        cacheConfig,
        fields,
        name,
        isResponseInArrayMode,
        customResultMapper,
      );
      this.dbSdkAdapterId = adapterId;
    }

    /**
     * Statement execution: Drizzle wraps driver rejections in
     * `DrizzleQueryError` inside `queryWithCache`; this layer unwraps and
     * normalizes them (native error on `cause`, statement text for the
     * indeterminate-write policy). Result-mapping failures after a successful
     * driver call are normalized WITHOUT statement context — nothing is
     * pending, so they never claim an indeterminate write.
     */
    override async execute(placeholderValues?: Record<string, unknown> | undefined): Promise<T['execute']> {
      try {
        return await super.execute(placeholderValues);
      } catch (error) {
        throw normalizeStatementFailure(error, this.query.sql, this.dbSdkAdapterId);
      }
    }

    /** `all()` is dispatch-only (rows returned unmapped): failures are driver-level. */
    override async all(placeholderValues?: Record<string, unknown> | undefined): Promise<T['all']> {
      try {
        return await super.all(placeholderValues);
      } catch (error) {
        throw normalizeStatementFailure(error, this.query.sql, this.dbSdkAdapterId, { textOnUnshaped: true });
      }
    }
  }

  class DbSdkNodePgSession<TFullSchema extends Record<string, unknown>, TSchema extends TablesRelationalConfig>
    extends NodePgSession<TFullSchema, TSchema>
  {
    private readonly dbSdkClient: NodePgClient;
    private readonly dbSdkSchema: RelationalSchemaConfig<TSchema> | undefined;
    private readonly dbSdkOptions: PgBridgeSessionOptions;
    private readonly dbSdkAdapterId: string;

    constructor(
      client: NodePgClient,
      dialect: PgDialect,
      schema: RelationalSchemaConfig<TSchema> | undefined,
      options: PgBridgeSessionOptions,
    ) {
      super(client, dialect, schema, options);
      this.dbSdkClient = client;
      this.dbSdkSchema = schema;
      this.dbSdkOptions = options;
      this.dbSdkAdapterId = options.dbSdk.adapterId;
    }

    override prepareQuery<TQuery extends PreparedQueryConfig = PreparedQueryConfig>(
      query: Query,
      fields: SelectedFieldsOrdered | undefined,
      name: string | undefined,
      isResponseInArrayMode: boolean,
      customResultMapper?: (rows: unknown[][]) => TQuery['execute'],
      queryMetadata?: { type: 'select' | 'update' | 'delete' | 'insert'; tables: string[] },
      cacheConfig?: WithCacheConfig,
    ): NodePgPreparedQuery<TQuery> {
      return new DbSdkNodePgPreparedQuery<TQuery>(
        this.dbSdkClient,
        query.sql,
        query.params,
        this.dbSdkOptions.logger ?? new NoopLogger(),
        this.dbSdkOptions.cache ?? new NoopCache(),
        queryMetadata,
        cacheConfig,
        fields,
        name,
        isResponseInArrayMode,
        customResultMapper,
        this.dbSdkAdapterId,
      );
    }

    /**
     * dbSDK transaction semantics over Drizzle's API. SQL is byte-identical to
     * the stock session; differences are error-side only:
     * - the leased client is released even when `begin` fails (the stock
     *   session leaks it);
     * - `ROLLBACK` failures never replace the primary error;
     * - the final error is normalized exactly like `db.transaction`
     *   (`transactionErrorContext` in core): no server SQLSTATE means
     *   `indeterminate: true`; user-thrown `DbError`s pass through unchanged;
     * - `tx.rollback()` still rejects with Drizzle's `TransactionRollbackError`
     *   (upstream control flow, preserved deliberately).
     */
    override async transaction<TransactionResult>(
      transaction: (tx: NodePgTransaction<TFullSchema, TSchema>) => Promise<TransactionResult>,
      config?: PgTransactionConfig | undefined,
    ): Promise<TransactionResult> {
      const client = this.dbSdkClient;
      const isPool =
        (PgPool !== undefined && client instanceof PgPool) ||
        Object.getPrototypeOf(client)?.constructor?.name.includes('Pool') === true;

      let leased: PoolClient | undefined;
      let connected = false;
      let committed = false;
      try {
        leased = isPool ? await (client as Pool).connect() : undefined;
        const session = leased
          ? new DbSdkNodePgSession<TFullSchema, TSchema>(leased, this.dialect, this.dbSdkSchema, this.dbSdkOptions)
          : this;
        const tx = new DbSdkNodePgTransaction<TFullSchema, TSchema>(
          this.dialect,
          session,
          this.dbSdkSchema,
          0,
          this.dbSdkAdapterId,
        );
        connected = true;
        const chunks = config ? transactionConfigChunks(config) : [];
        await tx.execute(chunks.length > 0 ? sql`begin ${sql.raw(chunks.join(' '))}` : sql`begin`);
        const result = await transaction(tx);
        await tx.execute(sql`commit`);
        committed = true;
        return result;
      } catch (error) {
        if (error instanceof TransactionRollbackError) {
          // Upstream control flow: the transaction is still open server-side,
          // so the ROLLBACK is still sent (quietly, never masking the signal),
          // and the TransactionRollbackError itself propagates unchanged.
          if (connected && !committed) await runQuietly(leased ?? client, 'ROLLBACK');
          throw error;
        }
        if (connected && !committed) await runQuietly(leased ?? client, 'ROLLBACK');
        throw finalizeTransactionError(error, this.dbSdkAdapterId);
      } finally {
        if (leased) {
          try {
            leased.release();
          } catch {
            // A release failure is pool-side cleanup, not a transaction
            // outcome: it must never mask the primary error, never turn an
            // acknowledged commit into a failure, and never fabricate an
            // `indeterminate` claim. Mirrors core `runLeasedTransaction`.
          }
        }
      }
    }
  }

  class DbSdkNodePgTransaction<TFullSchema extends Record<string, unknown>, TSchema extends TablesRelationalConfig>
    extends NodePgTransaction<TFullSchema, TSchema>
  {
    private readonly dbSdkDialect: PgDialect;
    private readonly dbSdkSession: NodePgSession<TFullSchema, TSchema>;
    private readonly dbSdkAdapterId: string;

    constructor(
      dialect: PgDialect,
      session: NodePgSession<TFullSchema, TSchema>,
      schema: RelationalSchemaConfig<TSchema> | undefined,
      nestedIndex = 0,
      adapterId = '',
    ) {
      super(dialect, session, schema, nestedIndex);
      this.dbSdkDialect = dialect;
      this.dbSdkSession = session;
      this.dbSdkAdapterId = adapterId;
    }

    /**
     * Savepoints with the stock SQL (`savepoint spN`, `release savepoint spN`,
     * `rollback to savepoint spN`) and dbSDK error discipline: a failed
     * `ROLLBACK TO SAVEPOINT` never masks the original error, and the error
     * leaving a nested transaction is normalized at this boundary too — so
     * code awaiting `tx.transaction(...)` inside the callback sees the same
     * `DbError` shape as everything else. Re-finalizing a bridge-normalized
     * error at the outer boundary is idempotent.
     */
    override async transaction<TransactionResult>(
      transaction: (tx: NodePgTransaction<TFullSchema, TSchema>) => Promise<TransactionResult>,
    ): Promise<TransactionResult> {
      const savepointName = `sp${this.nestedIndex + 1}`;
      const tx = new DbSdkNodePgTransaction<TFullSchema, TSchema>(
        this.dbSdkDialect,
        this.dbSdkSession,
        this.schema,
        this.nestedIndex + 1,
        this.dbSdkAdapterId,
      );
      await tx.execute(sql.raw(`savepoint ${savepointName}`));
      try {
        const result = await transaction(tx);
        await tx.execute(sql.raw(`release savepoint ${savepointName}`));
        return result;
      } catch (error) {
        if (error instanceof TransactionRollbackError) throw error;
        try {
          await tx.execute(sql.raw(`rollback to savepoint ${savepointName}`));
        } catch {
          // Never mask the primary error with the rollback failure.
        }
        throw finalizeTransactionError(error, this.dbSdkAdapterId);
      }
    }
  }

  return {
    buildNodePgDatabase<TSchema extends Record<string, unknown>>(
      client: Pool,
      config: DrizzleInteropConfig<TSchema>,
      adapterId: string,
    ): NodePgDatabase<TSchema> & { $client: Pool } {
      // Mirrors drizzle-orm/node-postgres `construct()` with the SDK session in
      // place of the stock one. `cache` is not part of the bridge config, so
      // `$cache` stays unset exactly like a stock instance built without it.
      const dialect = new PgDialect(config?.casing !== undefined ? { casing: config.casing } : undefined);
      const schema = buildSchemaConfig(config, extractTablesRelationalConfig, createTableRelationsHelpers);
      const options: PgBridgeSessionOptions = { dbSdk: { adapterId } };
      const logger = resolveLogger(config, DefaultLogger);
      if (logger !== undefined) options.logger = logger;
      const session = new DbSdkNodePgSession<TSchema, ExtractTablesWithRelations<TSchema>>(
        client,
        dialect,
        schema,
        options,
      );
      const db = new NodePgDatabase<TSchema>(dialect, session, schema);
      return Object.assign(db, { $client: client });
    },
  };
}

async function createNeonHttpBridge(): Promise<NeonHttpBridge> {
  const [neonHttp, pgCore, relations, loggerModule, cacheModule] = await Promise.all([
    import('drizzle-orm/neon-http'),
    import('drizzle-orm/pg-core'),
    import('drizzle-orm/relations'),
    import('drizzle-orm/logger'),
    import('drizzle-orm/cache/core'),
  ]);
  const { NeonHttpDatabase, NeonHttpDriver, NeonHttpSession, NeonHttpPreparedQuery } = neonHttp;
  const { PgDialect } = pgCore;
  const { extractTablesRelationalConfig, createTableRelationsHelpers } = relations;
  const { DefaultLogger, NoopLogger } = loggerModule;
  const { NoopCache } = cacheModule;

  class DbSdkNeonHttpPreparedQuery<T extends PreparedQueryConfig> extends NeonHttpPreparedQuery<T> {
    private readonly dbSdkAdapterId: string;

    constructor(
      client: NeonHttpClient,
      query: Query,
      logger: Logger,
      cache: Cache,
      queryMetadata: { type: 'select' | 'update' | 'delete' | 'insert'; tables: string[] } | undefined,
      cacheConfig: WithCacheConfig | undefined,
      fields: SelectedFieldsOrdered | undefined,
      isResponseInArrayMode: boolean,
      customResultMapper: ((rows: unknown[][]) => T['execute']) | undefined,
      adapterId: string,
    ) {
      super(client, query, logger, cache, queryMetadata, cacheConfig, fields, isResponseInArrayMode, customResultMapper);
      this.dbSdkAdapterId = adapterId;
    }

    override async execute(placeholderValues?: Record<string, unknown> | undefined): Promise<T['execute']> {
      try {
        return await super.execute(placeholderValues);
      } catch (error) {
        throw normalizeStatementFailure(error, this.query.sql, this.dbSdkAdapterId);
      }
    }

    /** HTTP round-trips with no client-side mapping: all failures are driver-level. */
    override async all(placeholderValues?: Record<string, unknown> | undefined): Promise<T['all']> {
      try {
        return await super.all(placeholderValues);
      } catch (error) {
        throw normalizeStatementFailure(error, this.query.sql, this.dbSdkAdapterId, { textOnUnshaped: true });
      }
    }

    override async values(placeholderValues?: Record<string, unknown> | undefined): Promise<T['values']> {
      try {
        return await super.values(placeholderValues);
      } catch (error) {
        throw normalizeStatementFailure(error, this.query.sql, this.dbSdkAdapterId, { textOnUnshaped: true });
      }
    }
  }

  class DbSdkNeonHttpSession<TFullSchema extends Record<string, unknown>, TSchema extends TablesRelationalConfig>
    extends NeonHttpSession<TFullSchema, TSchema>
  {
    private readonly dbSdkClient: NeonHttpClient;
    private readonly dbSdkSchema: RelationalSchemaConfig<TSchema> | undefined;
    private readonly dbSdkOptions: NeonBridgeSessionOptions;
    private readonly dbSdkAdapterId: string;

    constructor(
      client: NeonHttpClient,
      dialect: PgDialect,
      schema: RelationalSchemaConfig<TSchema> | undefined,
      options: NeonBridgeSessionOptions,
    ) {
      super(client, dialect, schema, options);
      this.dbSdkClient = client;
      this.dbSdkSchema = schema;
      this.dbSdkOptions = options;
      this.dbSdkAdapterId = options.dbSdk.adapterId;
    }

    override prepareQuery<TQuery extends PreparedQueryConfig = PreparedQueryConfig>(
      query: Query,
      fields: SelectedFieldsOrdered | undefined,
      name: string | undefined,
      isResponseInArrayMode: boolean,
      customResultMapper?: (rows: unknown[][]) => TQuery['execute'],
      queryMetadata?: { type: 'select' | 'update' | 'delete' | 'insert'; tables: string[] },
      cacheConfig?: WithCacheConfig,
    ): NeonHttpPreparedQuery<TQuery> {
      return new DbSdkNeonHttpPreparedQuery<TQuery>(
        this.dbSdkClient,
        query,
        this.dbSdkOptions.logger ?? new NoopLogger(),
        this.dbSdkOptions.cache ?? new NoopCache(),
        queryMetadata,
        cacheConfig,
        fields,
        isResponseInArrayMode,
        customResultMapper,
        this.dbSdkAdapterId,
      );
    }

    /**
     * One HTTP round-trip for the whole batch: a lost response leaves the
     * outcome of any write in the batch unknown. Normalized with core's batch
     * policy (any write counts; transport loss without a server SQLSTATE marks
     * `indeterminate`), matching `db.batch` over `dbsdk/neon` exactly.
     */
    override async batch<UBatchItem extends BatchItem<'pg'>, TQueries extends Readonly<[UBatchItem, ...UBatchItem[]]>>(
      queries: TQueries,
    ): Promise<any> {
      try {
        return await super.batch(queries);
      } catch (error) {
        throw finalizeBatchError(error, batchItemTexts([...queries]), this.dbSdkAdapterId);
      }
    }

    /**
     * Capability refusal, normalized like core's `db.transaction` on a
     * non-supporting adapter (`DbError`, code `CAPABILITY`, nothing sent).
     * Same message text as the stock session for compatibility.
     */
    override async transaction<TransactionResult>(
      _transaction: (tx: NeonTransaction<TFullSchema, TSchema>) => Promise<TransactionResult>,
      _config?: PgTransactionConfig | undefined,
    ): Promise<TransactionResult> {
      throw new DbError('No transactions support in neon-http driver', {
        code: 'CAPABILITY',
        adapterId: this.dbSdkAdapterId,
        retryable: false,
        indeterminate: false,
      });
    }
  }

  return {
    buildNeonHttpDatabase<TSchema extends Record<string, unknown>>(
      client: NeonHttpClient,
      config: DrizzleInteropConfig<TSchema>,
      adapterId: string,
    ): NeonHttpDatabase<TSchema> & { $client: NeonHttpClient } {
      // Mirrors drizzle-orm/neon-http `construct()` with the SDK session in
      // place of the stock one. The stock driver constructor runs
      // `initMappers()` — global timestamp/date type parsers the accepted
      // bridge depends on for identical value conversion — so that exact
      // driver class is still constructed (for that side effect) before the
      // database is assembled with the SDK session. `cache` is not part of the
      // bridge config, so `$cache` stays unset like a stock no-cache instance.
      const dialect = new PgDialect(config?.casing !== undefined ? { casing: config.casing } : undefined);
      const schema = buildSchemaConfig(config, extractTablesRelationalConfig, createTableRelationsHelpers);
      const options: NeonBridgeSessionOptions = { dbSdk: { adapterId } };
      const logger = resolveLogger(config, DefaultLogger);
      if (logger !== undefined) options.logger = logger;
      new NeonHttpDriver(client, dialect, { ...(logger !== undefined ? { logger } : {}) });
      const session = new DbSdkNeonHttpSession<TSchema, ExtractTablesWithRelations<TSchema>>(
        client,
        dialect,
        schema,
        options,
      );
      const db = new NeonHttpDatabase<TSchema>(dialect, session, schema);
      return Object.assign(db, { $client: client });
    },
  };
}
