/**
 * Capability metadata helpers: guard errors and generated human-readable summaries for docs.
 * The adapter's declared capabilities are authoritative; the client enforces them BEFORE
 * dispatch so unsupported operations never reach the database.
 */

import { DbError } from './errors.js';
import type { DatabaseAdapterCapabilities, EvidenceLevel } from './types.js';

export type CapabilityFeature = 'interactiveTransactions' | 'atomicBatch' | 'sessionState';

const FEATURE_LABELS: Record<CapabilityFeature, string> = {
  interactiveTransactions: 'interactive transactions (db.transaction)',
  atomicBatch: 'atomic batches (db.batch with atomic: true)',
  sessionState: 'session state (SET, temp objects, LISTEN/NOTIFY)',
};

/** Build the pre-dispatch error thrown when an adapter does not support a feature. */
export function missingCapabilityError(
  feature: CapabilityFeature,
  adapter: { id: string; capabilities: DatabaseAdapterCapabilities },
): DbError {
  const evidence = adapter.capabilities.evidence[feature];
  const evidenceNote = evidence ? ` (evidence: ${evidence})` : '';
  return new DbError(
    `Adapter "${adapter.id}" does not support ${FEATURE_LABELS[feature]} over the ` +
      `${adapter.capabilities.transport} transport${evidenceNote}. Choose an adapter ` +
      `transport that supports it. dbSDK never falls back silently.`,
    {
      code: 'CAPABILITY',
      adapterId: adapter.id,
      capability: feature,
      retryable: false,
      indeterminate: false,
    },
  );
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

/** Human-readable capability summary (used by docs and diagnostics). */
export function describeCapabilities(capabilities: DatabaseAdapterCapabilities): string {
  const lines = [
    `transport: ${capabilities.transport}`,
    `interactive transactions: ${yesNo(capabilities.interactiveTransactions)}`,
    `atomic batch: ${yesNo(capabilities.atomicBatch)}`,
    `session state: ${yesNo(capabilities.sessionState)}`,
  ];
  const evidence = Object.entries(capabilities.evidence);
  if (evidence.length > 0) {
    lines.push(
      `evidence: ${evidence.map(([key, level]) => `${key}=${level satisfies EvidenceLevel}`).join(', ')}`,
    );
  }
  return lines.join('\n');
}

/** A generated markdown compatibility matrix from adapter metadata (docs use). */
export function capabilityMatrix(
  adapters: readonly {
    id: string;
    capabilities: DatabaseAdapterCapabilities;
  }[],
): string {
  const header =
    '| Adapter | Transport | Interactive transactions | Atomic batch | Session state | Evidence |\n' +
    '| --- | --- | --- | --- | --- | --- |';
  const rows = adapters.map(({ id, capabilities }) => {
    const evidence = Object.entries(capabilities.evidence)
      .map(([key, level]) => `${key}=${level}`)
      .join(', ');
    const cells = [
      id,
      capabilities.transport,
      `${yesNo(capabilities.interactiveTransactions)}`,
      `${yesNo(capabilities.atomicBatch)}`,
      `${yesNo(capabilities.sessionState)}`,
      evidence || '—',
    ];
    return `| ${cells.join(' | ')} |`;
  });
  return [header, ...rows].join('\n');
}
