/**
 * Sync layer contracts — the provider-agnostic vocabulary for moving data between
 * databases (or any future source/target) with resumable, crash-safe semantics.
 *
 * Design invariants (see coordination/v3-sync-workflows.md):
 * - Sources expose monotonic, opaque cursors. `cursor: null` means exhausted.
 *   Monotonicity across DISTINCT cursor values is the source's responsibility; the
 *   engine only detects an identical cursor repeated (stall) and never compares
 *   opaque cursors lexicographically.
 * - Targets are idempotent by default (`writeMode: 'upsert'`): the same batch may
 *   legitimately be applied more than once after a crash, and that must converge.
 *   Convergence covers ROW STATE; side effects triggered by re-applied batches are
 *   not exactly-once.
 * - Checkpoints are caller-owned; the job only reads/writes through the interface.
 *   At most one concurrent writer per checkpoint key (no CAS/locking).
 * - Incremental (cursor-based) runs only see rows whose cursor values advance
 *   monotonically. Rows that become visible AFTER a run read past their position —
 *   late commits, backfills, clock-skewed writers — are permanently missed by
 *   later incremental runs; repair with a full re-copy or CDC (a different,
 *   future mechanism, not claimed here).
 * - Nothing here knows about SQL. SQL adapters live in `./sql.js` and adapt the
 *   existing `Database` client. The SQL adapters make the default SQL→SQL copy
 *   value-faithful: payload columns with lossy/ambiguous native transport
 *   (date/time, interval, json/jsonb, arrays of those, and numeric-family
 *   arrays — the driver parses numeric ARRAY elements as binary doubles) are
 *   delivered as exact PostgreSQL text; the target encodes JavaScript array
 *   values by the resolved column type, refusing ambiguity loudly before any
 *   write; and every read projects an explicit column list frozen from a cached
 *   schema snapshot that is re-validated against the catalog on each read, so
 *   schema drift after the first read fails loudly instead of silently
 *   appearing, colliding, or losing precision.
 */

export type SyncReadOptions = {
  signal?: AbortSignal;
};

export type SyncWriteOptions = {
  signal?: AbortSignal;
};

/** The read half of a transfer. Cursors are opaque strings; null means exhausted. */
export type SyncSource<Row> = {
  /** Stable, secret-free identity used in checkpoint keys and error messages. */
  readonly identity: string;
  /**
   * Honesty metadata: `'ordered'` sources return rows in an order consistent with
   * their cursors (resumable incremental sync is sound). `'unordered'` sources are
   * only safe for full re-copies — the job surfaces this so callers cannot assume
   * ordering that isn't there.
   */
  readonly ordering: 'ordered' | 'unordered';
  /**
   * Read the page after `cursor`. When rows are returned, `cursor` MUST be a
   * non-null, monotonically advancing string — returning rows with a null cursor
   * is a contract violation and aborts the job. An empty `rows` array ends the
   * run (the source says there is nothing more at this position).
   *
   * Contract details the engine enforces:
   * - The returned `rows.length` must not exceed `limit`. An oversized page is
   *   refused with a CONTRACT error before any write (the engine cannot bound a
   *   source's internal allocations, only the batch it accepts).
   * - Monotonicity across DISTINCT cursor values is the source's responsibility.
   *   Cursors are opaque; the engine never compares them lexicographically and
   *   can only detect an identical cursor repeated on a non-empty page (stall).
   *   A source cycling distinct cursors is bounded only by `maxBatches`.
   */
  read(
    cursor: string | null,
    limit: number,
    options?: SyncReadOptions,
  ): Promise<{ rows: Row[]; cursor: string | null }>;
};

/**
 * The write half of a transfer. `'upsert'` targets converge when the same batch is
 * applied twice (crash between commit and checkpoint). `'replace'`/`'other'` targets
 * require the caller to acknowledge the duplicate risk explicitly.
 */
export type SyncTarget<Row> = {
  readonly identity: string;
  readonly writeMode: 'upsert' | 'replace' | 'other';
  /**
   * Write a batch. The receipt matters: `written` MUST be an integer in
   * `0..rows.length`. Any other value (including `undefined`) is a target
   * interface contract violation — the engine reports a failed result with the
   * commit outcome honestly marked indeterminate and does NOT advance the
   * checkpoint (the batch may or may not have been committed).
   */
  write(rows: Row[], options?: SyncWriteOptions): Promise<{ written: number }>;
};

/**
 * Durable progress storage, owned by the caller. Values are opaque cursor strings.
 *
 * **Concurrency contract:** there is no compare-and-set, locking, or versioning —
 * `set` is last-writer-wins. The caller must guarantee **at most one concurrent
 * writer per checkpoint key** (e.g. a Postgres advisory lock or single scheduler
 * around jobs sharing a key). Overlapping writers interleave checkpoints: safe but
 * wasteful for upsert targets (re-copy converges), NOT universally harmless — with
 * transforms or non-idempotent targets, replay is not guaranteed to converge.
 */
export type CheckpointStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
};

export type TransferProgress = {
  batches: number;
  rowsRead: number;
  rowsWritten: number;
  rowsSkipped: number;
  cursor: string | null;
};

export type TransferOptions<In, Out = In> = {
  /** Rows per batch. Default 500. Integer, 1..10 000. */
  batchSize?: number;
  /** Stop after N batches even if the source has more (resumable via checkpoint). */
  maxBatches?: number;
  /** Cooperative cancellation; checked between batches and before every write. */
  signal?: AbortSignal;
  /** Transform + field mapping. Return null/undefined to skip a row. */
  map?: (row: In) => Out | null | undefined;
  /**
   * Durable checkpoint storage. Default: an in-memory store — progress is lost on
   * restart (always safe to re-copy, never lossy, but not durable). Requires at
   * most one concurrent writer per checkpoint key (see {@link CheckpointStore}).
   */
  checkpointStore?: CheckpointStore;
  /**
   * Default: `dbsdk.sync:v1:` followed by a JSON array of
   * `[source.identity, target.identity]` — an injective encoding, so identities
   * containing delimiters (including `->`), quotes, or any other characters
   * cannot make two different endpoint pairs share one key. An explicit
   * `checkpointKey` is used verbatim and keeps full control (including the
   * responsibility to keep it unique per endpoint pair).
   */
  checkpointKey?: string;
  /** Default `'checkpoint'` — resume from the stored cursor. `'beginning'` ignores it. */
  startFrom?: 'checkpoint' | 'beginning';
  /**
   * Required (true) to run against a target whose `writeMode` is not `'upsert'`,
   * acknowledging that a crash between commit and checkpoint may duplicate rows.
   */
  acknowledgeNonIdempotentTarget?: boolean;
  /**
   * Fired after each committed batch. Payload contains counts only — never row data.
   * **Best-effort:** an observer that throws is ignored; it cannot fail or stop a
   * transfer whose batch is already committed and checkpointed.
   */
  onProgress?: (progress: TransferProgress) => void;
};

export type TransferResult = {
  status: 'completed' | 'aborted' | 'failed';
  /** True when the source reported no more rows at the final cursor. */
  exhausted: boolean;
  batches: number;
  rowsRead: number;
  rowsWritten: number;
  rowsSkipped: number;
  /**
   * Truthful resume point: the cursor of the last batch known to be committed on
   * the target. Equal to the stored checkpoint on success; may be ahead of the
   * stored checkpoint only when checkpoint persistence itself failed (reported
   * via `error`) — rerunning is still safe for upsert targets.
   */
  lastCursor: string | null;
  /** The original error for `status: 'failed'`; absent otherwise. */
  error?: unknown;
};
