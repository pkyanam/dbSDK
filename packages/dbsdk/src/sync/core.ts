/**
 * The transfer engine: `runTransfer`.
 *
 * Crash-safety rules (every one is test-enforced, see tests/sync/core.test.ts):
 * 1. The cursor is advanced (and the checkpoint written) ONLY after the target
 *    write resolves. A crash before that re-reads and re-applies the same batch.
 * 2. Re-applying a batch must converge — targets must be upserts. A non-upsert
 *    target requires an explicit acknowledgement or the job refuses to start.
 * 3. The engine never auto-retries a write. Any write error ends the run as
 *    'failed' with the previous committed cursor preserved; the caller decides.
 * 4. An unknown mutation outcome is never turned into an assumed success. This
 *    includes an invalid write receipt: the target interface contract requires
 *    an integer in 0..rows.length, and violating it leaves the outcome honestly
 *    indeterminate (checkpoint not advanced).
 * 5. A cursor that stops advancing while rows keep coming is a contract violation
 *    (stalled cursor) — the job fails instead of looping forever. Monotonicity
 *    across DISTINCT cursors is the source's responsibility and unverifiable by
 *    the engine; maxBatches is the only guard against a misbehaving source.
 * 6. Mid-run failures return a failed TransferResult (map throws, oversized
 *    pages, invalid receipts, unreadable checkpoints) — the promise does not
 *    reject for errors that fit the documented result shape. onProgress is
 *    best-effort: observer throws are ignored by contract.
 */

import { SyncError } from './errors.js';
import type {
  CheckpointStore,
  SyncSource,
  SyncTarget,
  TransferOptions,
  TransferResult,
} from './types.js';

const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 10_000;

function configurationError(message: string): SyncError {
  return new SyncError(message, 'CONFIGURATION');
}

function contractError(message: string): SyncError {
  return new SyncError(message, 'CONTRACT');
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Default checkpoint key. Must be INJECTIVE over the pair of identities: the
 * previous `a->b` delimiter format collided when identities themselves contain
 * `->` (e.g. ("alpha","beta->gamma") and ("alpha->beta","gamma") shared one key,
 * and the second transfer silently did nothing while reporting completed). A
 * versioned JSON array of the two identities is injective — every special
 * character is escaped — and the `v1` prefix leaves room for future formats.
 * Old pre-v1 keys are NOT adopted silently: they are simply never matched
 * (the API is unreleased; a fresh run starts from the beginning).
 */
const CHECKPOINT_KEY_PREFIX = 'dbsdk.sync:v1:';

function checkpointKeyOf(source: SyncSource<unknown>, target: SyncTarget<unknown>): string {
  return CHECKPOINT_KEY_PREFIX + JSON.stringify([source.identity, target.identity]);
}

/** Minimal structural validation of the source/target before any I/O happens. */
function validateEndpoint(
  endpoint: unknown,
  role: 'source' | 'target',
): asserts endpoint is SyncSource<unknown> | SyncTarget<unknown> {
  if (typeof endpoint !== 'object' || endpoint === null) {
    throw configurationError(`runTransfer requires a ${role} object.`);
  }
  const e = endpoint as Partial<SyncSource<unknown>> & Partial<SyncTarget<unknown>>;
  if (typeof e.identity !== 'string' || e.identity.length === 0) {
    throw configurationError(`The ${role} must have a non-empty string identity.`);
  }
  if (typeof e.read !== 'function' && role === 'source') {
    throw configurationError(`The source ("${e.identity}") must implement read(cursor, limit).`);
  }
  if (typeof e.write !== 'function' && role === 'target') {
    throw configurationError(`The target ("${e.identity}") must implement write(rows).`);
  }
  if (role === 'target') {
    const mode = (endpoint as SyncTarget<unknown>).writeMode;
    if (mode !== 'upsert' && mode !== 'replace' && mode !== 'other') {
      throw configurationError(
        `The target ("${e.identity}") must declare writeMode: 'upsert' | 'replace' | 'other'. ` +
          "Only 'upsert' makes crash reruns converge without duplicates.",
      );
    }
  }
  if (role === 'source') {
    const ordering = (endpoint as SyncSource<unknown>).ordering;
    if (ordering !== 'ordered' && ordering !== 'unordered') {
      throw configurationError(
        `The source ("${e.identity}") must declare ordering: 'ordered' | 'unordered'.`,
      );
    }
  }
}

/** Simple non-durable store. Losing it is always safe for upsert targets (re-copy). */
export function createMemoryCheckpointStore(initial?: Record<string, string>): CheckpointStore {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    async get(key) {
      return map.get(key) ?? null;
    },
    async set(key, value) {
      map.set(key, value);
    },
  };
}

export async function runTransfer<In, Out = In>(
  source: SyncSource<In>,
  target: SyncTarget<Out>,
  options: TransferOptions<In, Out> = {},
): Promise<TransferResult> {
  validateEndpoint(source, 'source');
  validateEndpoint(target, 'target');

  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw configurationError(`batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}.`);
  }
  const maxBatches = options.maxBatches ?? Infinity;
  if (options.maxBatches !== undefined && (!Number.isInteger(options.maxBatches) || options.maxBatches < 1)) {
    throw configurationError('maxBatches must be a positive integer.');
  }
  if (target.writeMode !== 'upsert' && options.acknowledgeNonIdempotentTarget !== true) {
    throw configurationError(
      `Target "${target.identity}" declares writeMode '${target.writeMode}', which is not ` +
        'idempotent: if the job crashes after the target commits but before the checkpoint is ' +
        'saved, rerunning may duplicate rows. Pass acknowledgeNonIdempotentTarget: true to ' +
        "accept this, or use an upsert target.",
    );
  }

  const key = options.checkpointKey ?? checkpointKeyOf(source, target);
  const store = options.checkpointStore ?? createMemoryCheckpointStore();

  // Initial cursor: resume point (default) or a fresh run. A checkpoint store
  // that fails to READ produces a failed result with zero dispatch — no read, no
  // write, no partial state.
  let cursor: string | null;
  if (options.startFrom === 'beginning') {
    cursor = null;
  } else {
    try {
      cursor = await store.get(key);
    } catch (error) {
      return {
        status: 'failed',
        exhausted: false,
        batches: 0,
        rowsRead: 0,
        rowsWritten: 0,
        rowsSkipped: 0,
        lastCursor: null,
        error,
      };
    }
  }

  const signal = options.signal;
  if (isAborted(signal)) {
    return { status: 'aborted', exhausted: false, batches: 0, rowsRead: 0, rowsWritten: 0, rowsSkipped: 0, lastCursor: cursor };
  }

  const result: TransferResult = {
    status: 'completed',
    exhausted: false,
    batches: 0,
    rowsRead: 0,
    rowsWritten: 0,
    rowsSkipped: 0,
    lastCursor: cursor,
  };

  while (result.batches < maxBatches) {
    if (isAborted(signal)) {
      result.status = 'aborted';
      return result; // lastCursor already points at the last committed batch
    }

    let page: { rows: In[]; cursor: string | null };
    try {
      page = await source.read(cursor, batchSize, { signal });
    } catch (error) {
      result.status = isAborted(signal) ? 'aborted' : 'failed';
      result.error = error;
      return result;
    }

    if (!Array.isArray(page?.rows)) {
      result.status = 'failed';
      result.error = contractError(
        `Source "${source.identity}" returned no rows array (got ${page?.rows === null ? 'null' : typeof page?.rows}).`,
      );
      return result;
    }

    // Backpressure contract: the source must honor the limit. An oversized page
    // is a source contract violation and is refused BEFORE mapping or writing —
    // it never reaches the target, and the guard cannot be bypassed by a source
    // that allocates internally (that is outside the engine's control; the guard
    // bounds the batch the engine accepts).
    if (page.rows.length > batchSize) {
      result.status = 'failed';
      result.error = contractError(
        `Source "${source.identity}" returned ${page.rows.length} row(s) for a limit of ` +
          `${batchSize}. Sources must honor the read limit — the oversized page was refused ` +
          'before any write.',
      );
      return result;
    }

    if (page.rows.length === 0) {
      // The source says there is nothing more at this position. The stored cursor
      // stays untouched so a later run resumes from the same position (e.g. to
      // pick up rows that appeared since — scheduled incremental sync).
      result.exhausted = true;
      return result;
    }

    // Non-empty page MUST carry a cursor; a null cursor here would silently
    // re-read the same page forever or drop the remaining rows.
    if (typeof page.cursor !== 'string') {
      result.status = 'failed';
      result.error = contractError(
        `Source "${source.identity}" returned ${page.rows.length} row(s) with a null cursor. ` +
          'A non-empty page must carry a non-null, advancing cursor.',
      );
      return result;
    }

    // Stalled cursor: rows present but the cursor did not advance. Refusing here
    // prevents both an infinite loop and a silent re-read of the same page.
    if (cursor !== null && page.cursor === cursor) {
      result.status = 'failed';
      result.error = contractError(
        `Source "${source.identity}" returned rows with an unchanged cursor — the cursor must ` +
          'advance monotonically on every non-empty page.',
      );
      return result;
    }

    const mapped: Out[] = [];
    // The rows were read regardless of what the mapping does with them.
    result.rowsRead += page.rows.length;
    try {
      if (options.map) {
        for (const row of page.rows) {
          const out = options.map(row);
          if (out !== null && out !== undefined) mapped.push(out);
        }
      } else {
        mapped.push(...(page.rows as unknown as Out[]));
      }
    } catch (error) {
      // A throwing transform is a failure like any other: failed result, the
      // batch is not written, the checkpoint is not advanced.
      result.status = 'failed';
      result.error = error;
      return result;
    }
    result.rowsSkipped += page.rows.length - mapped.length;

    if (mapped.length > 0) {
      if (isAborted(signal)) {
        // Nothing of this batch was written; the cursor was not advanced. The
        // batch will be re-read on the next run — no loss, no duplicates.
        result.status = 'aborted';
        return result;
      }
      let written: { written: number } | undefined;
      try {
        written = await target.write(mapped, { signal });
      } catch (error) {
        result.status = isAborted(signal) ? 'aborted' : 'failed';
        result.error = error;
        return result; // cursor NOT advanced; the batch is retried on the next run
      }
      // The write receipt is part of the contract: it must be an integer in
      // 0..mapped.length. Anything else means the target is misimplemented and
      // the commit outcome is UNKNOWN — never assume success, never advance the
      // checkpoint, report the committed/failed state honestly via lastCursor.
      const receipt = written?.written;
      if (!Number.isInteger(receipt) || receipt < 0 || receipt > mapped.length) {
        result.status = 'failed';
        result.error = contractError(
          `Target "${target.identity}" returned an invalid write receipt ` +
            `(${String(receipt)}; expected an integer in 0..${mapped.length}). The write ` +
            'outcome is indeterminate — the batch may or may not be committed. The ' +
            'checkpoint was not advanced.',
        );
        return result;
      }
      result.rowsWritten += receipt;
    }

    // The batch is committed on the target. Advance the cursor and persist it.
    cursor = page.cursor;
    result.batches += 1;
    result.lastCursor = cursor;
    try {
      await store.set(key, cursor);
    } catch (error) {
      // The batch IS on the target but the checkpoint may not be. Report it:
      // lastCursor truthfully shows the committed cursor; rerunning an upsert
      // target re-applies the batch harmlessly.
      result.status = 'failed';
      result.error = error;
      return result;
    }

    // Progress is best-effort: an observer that throws must not fail a transfer
    // whose batch is already committed and checkpointed. This is documented in
    // TransferOptions.onProgress.
    try {
      options.onProgress?.({
        batches: result.batches,
        rowsRead: result.rowsRead,
        rowsWritten: result.rowsWritten,
        rowsSkipped: result.rowsSkipped,
        cursor,
      });
    } catch {
      // ignored by contract (best-effort observer)
    }
  }

  return result; // maxBatches reached: resumable, lastCursor points at the last commit
}
