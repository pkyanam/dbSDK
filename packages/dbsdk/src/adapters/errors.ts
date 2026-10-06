/**
 * Adapter-level errors, thrown strictly BEFORE dispatch. The core client layer
 * recognizes these by `name` and normalizes them into `DbError`
 * (`code: 'CONFIGURATION'` / `'CAPABILITY'`), preserving `adapter` and
 * `capability`. See coordination/core-contract.md §3.
 */

/**
 * Thrown before dispatch when the adapter configuration itself is invalid
 * (e.g. a Supabase connection string that contradicts the declared connection mode).
 */
export class ConfigurationError extends Error {
  readonly adapter: string;

  constructor(adapter: string, message: string) {
    super(message);
    this.name = 'ConfigurationError';
    this.adapter = adapter;
  }
}

/**
 * Thrown before dispatch when an operation is not supported by the selected
 * transport/connection mode (e.g. interactive transactions over Neon HTTP).
 */
export class CapabilityError extends Error {
  readonly adapter: string;
  readonly capability: string;

  constructor(adapter: string, capability: string, message: string) {
    super(message);
    this.name = 'CapabilityError';
    this.adapter = adapter;
    this.capability = capability;
  }
}
