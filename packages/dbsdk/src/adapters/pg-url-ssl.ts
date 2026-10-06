/**
 * Shared connection-string SSL directive handling for the `pg`-based adapters.
 *
 * Why this exists (review finding F3, verified empirically against the installed
 * `pg` 8.23.1 / `pg-connection-string` 2.14.1, no network): when a connection URL
 * carries SSL-related query parameters, `pg`'s own parser REPLACES whatever `ssl`
 * value the adapter put into the pool config — regardless of intent:
 *
 * - `?sslmode=disable` makes the final driver config `ssl: false` even when the
 *   adapter or caller explicitly configured verified TLS — a silent plaintext
 *   downgrade on remote hosts.
 * - `?sslmode=require|verify-full|prefer|...` makes the final config `{}`,
 *   silently DISCARDING an explicit `{ rejectUnauthorized: true, ca }` object.
 * - `?sslcert=...` / `?sslkey=...` / `?sslrootcert=...` trigger synchronous file
 *   reads inside the driver and replace the configured ssl object.
 * - `?uselibpqcompat=true` switches modes to weaker libpq semantics (e.g.
 *   `sslmode=require` no longer verifies certificates).
 *
 * This module lets an adapter inspect, refuse, or canonicalize those directives
 * BEFORE the pool is constructed, and strip them from the URL actually handed to
 * `pg` so the driver cannot override the adapter's final, verified policy.
 *
 * Deliberately NOT a universal policy: adapters differ. PlanetScale Postgres
 * (verified-TLS-mandatory on remote hosts) canonicalizes every directive; the
 * generic `postgres` and Supabase adapters only refuse the narrow silent-override
 * ambiguity (URL directives + explicit `ssl` configuration at the same time) and
 * otherwise preserve native `pg` behavior.
 */

import { ConfigurationError } from './errors.js';

/** Query parameter keys that change how `pg`/pg-connection-string resolves TLS. */
const SSL_AFFECTING_KEYS: readonly string[] = [
  'ssl',
  'sslmode',
  'sslcert', // driver reads this file from disk
  'sslkey', // driver reads this file from disk
  'sslrootcert', // driver reads this file from disk
  'sslnegotiation',
  'uselibpqcompat',
];

export type UrlSslDirective = { /** Lowercased parameter key. */ key: string; /** Raw parameter value. */ value: string };

export type UrlSslDirectives = {
  /** Every SSL-affecting parameter found (lowercased key, raw value), in order. */
  all: readonly UrlSslDirective[];
  /** Lowercased, trimmed `sslmode` values (may include duplicates and empty strings). */
  modes: readonly string[];
  /** Lowercased, trimmed values of the `ssl` parameter. */
  sslValues: readonly string[];
  /** File-loading parameter keys found (`sslcert`/`sslkey`/`sslrootcert`). */
  fileParams: readonly string[];
};

/** Collect SSL-affecting query parameters from a parsed connection URL (case-insensitive). */
export function collectUrlSslDirectives(url: URL): UrlSslDirectives {
  const all: UrlSslDirective[] = [];
  for (const [key, value] of url.searchParams) {
    if (SSL_AFFECTING_KEYS.includes(key.toLowerCase())) {
      all.push({ key: key.toLowerCase(), value });
    }
  }
  return {
    all,
    modes: all.filter((d) => d.key === 'sslmode').map((d) => d.value.trim().toLowerCase()),
    sslValues: all.filter((d) => d.key === 'ssl').map((d) => d.value.trim().toLowerCase()),
    fileParams: all
      .filter((d) => d.key === 'sslcert' || d.key === 'sslkey' || d.key === 'sslrootcert')
      .map((d) => d.key),
  };
}

/**
 * Return the connection string with every SSL-affecting query parameter (any casing)
 * removed, so `pg` cannot re-parse/override the adapter's resolved ssl value. All
 * other parameters (application_name, connect_timeout, ...) are preserved.
 */
export function stripUrlSslParams(url: URL): string {
  for (const key of [...url.searchParams.keys()]) {
    if (SSL_AFFECTING_KEYS.includes(key.toLowerCase())) url.searchParams.delete(key);
  }
  return url.toString();
}

/**
 * Resolve the final `ssl` value under a VERIFIED-TLS policy (PlanetScale Postgres):
 * remote connections must be encrypted with certificate + hostname verification
 * unless an explicit ssl configuration says otherwise — and no URL parameter may
 * silently override either. Returns `undefined` when no directive and no explicit
 * option exists (the caller applies its own default). Throws ConfigurationError
 * before any pool construction on conflicting or unsafe directives.
 */
export function resolveVerifiedTlsFromUrl(input: {
  adapter: string;
  isLocal: boolean;
  /** The caller's explicit `ssl` option, if any (the caller checks `false` on remote itself). */
  explicitSsl: boolean | Record<string, unknown> | undefined;
  directives: UrlSslDirectives;
}): boolean | Record<string, unknown> | undefined {
  const { adapter, isLocal, explicitSsl, directives } = input;
  const refuse = (message: string): never => {
    throw new ConfigurationError(adapter, message);
  };
  if (directives.all.length === 0) return explicitSsl;

  // File-loading params always refused: the driver would read them from disk and
  // silently replace the configured ssl object (CA/verification included).
  if (directives.fileParams.length > 0) {
    refuse(
      `the connection string contains the SSL file parameter(s) ${directives.fileParams
        .map((k) => `'${k}=...'`)
        .join(', ')}. This adapter does not let connection-string files override its TLS policy ` +
        '(the driver would read them from disk and discard the configured ssl object). ' +
        'Pass certificates/keys through the explicit `ssl` option instead.',
    );
  }
  // uselibpqcompat switches modes to weaker libpq semantics (require/verify-ca stop
  // verifying) — never permitted under the verified-TLS policy.
  if (directives.all.some((d) => d.key === 'uselibpqcompat')) {
    refuse(
      "the connection string contains 'uselibpqcompat', which switches sslmode semantics to the " +
        'weaker libpq behavior (e.g. sslmode=require would stop verifying certificates). Remove it; ' +
        'this adapter enforces verified TLS on remote hosts via the explicit `ssl` option.',
    );
  }
  // sslnegotiation changes the TLS handshake setup; not part of this policy.
  if (directives.all.some((d) => d.key === 'sslnegotiation')) {
    refuse(
      "the connection string contains 'sslnegotiation'. This adapter does not support connection-" +
        'string TLS negotiation overrides; remove the parameter and use the explicit `ssl` option.',
    );
  }

  // Interpret the remaining directives (sslmode, ssl) into one intent.
  const intents = new Set<'tls' | 'plaintext'>();
  for (const mode of directives.modes) {
    if (mode === 'require' || mode === 'verify-full') intents.add('tls');
    else if (mode === 'disable') intents.add('plaintext');
    else {
      refuse(
        `the connection string requests sslmode '${mode || '(empty)'}'. Under this adapter's ` +
          "verified-TLS policy only 'require' or 'verify-full' (verified TLS) and 'disable' " +
          '(plaintext, local hosts only) are accepted. For a custom CA or other TLS options, ' +
          'remove the URL parameter and pass the explicit `ssl` option instead.',
      );
    }
  }
  for (const value of directives.sslValues) {
    if (value === 'true' || value === '1') intents.add('tls');
    else if (value === 'false' || value === '0') intents.add('plaintext');
    else {
      refuse(
        `the connection string requests ssl='${value || '(empty)'}', which ` +
          'pg resolves ambiguously. Use sslmode=require / verify-full (verified TLS) or the ' +
          'explicit `ssl` option instead.',
      );
    }
  }
  if (intents.size > 1) {
    refuse(
      'the connection string contains conflicting SSL directives (e.g. both plaintext and verified ' +
        'TLS). Keep exactly one intent: sslmode=require/verify-full, or remove the URL parameters ' +
        'and configure the explicit `ssl` option.',
    );
  }
  if (intents.size === 0) return explicitSsl; // only refused/handled keys above; nothing else to apply

  const wantsTls = intents.has('tls');
  if (explicitSsl !== undefined) {
    // The URL directive must AGREE with the explicit configuration; when it does, the
    // explicit object wins (e.g. sslmode=require alongside { rejectUnauthorized: true, ca }
    // keeps the caller's CA — pg would have discarded it).
    const explicitWantsTls = explicitSsl !== false;
    if (explicitWantsTls !== wantsTls) {
      refuse(
        `the connection string requests ${wantsTls ? 'TLS' : 'plaintext'} while the explicit ` +
          '`ssl` option requests ' +
          `${explicitWantsTls ? 'TLS' : 'plaintext'}. Remove the URL SSL parameter(s) ` +
          `${directives.all.map((d) => `'${d.key}'`).join(', ')} or drop the explicit \`ssl\` option ` +
          '— the driver would otherwise silently override one of them.',
      );
    }
    return explicitSsl;
  }

  if (!wantsTls) {
    // Plaintext requested via the URL. On a remote host this is the same refusal as an
    // explicit `ssl: false` — TLS is mandatory for PlanetScale Postgres.
    if (!isLocal) {
      refuse(
        'the connection string requests an unencrypted connection (sslmode=disable or ssl=false) ' +
          'for a non-local host. PlanetScale Postgres requires TLS (official sslmode=verify-full); ' +
          'refusing to connect unencrypted. Use localhost for local no-TLS testing.',
      );
    }
    return false;
  }
  // Verified TLS: certificates and hostname are checked (Node's system trust store).
  return { rejectUnauthorized: true };
}

/**
 * Narrow guard for adapters that pass SSL through to `pg` with their own defaults
 * (generic `postgres`, Supabase): a connection URL carrying SSL directives must not
 * SILENTLY override an explicitly configured `ssl` value (review finding F3). When
 * both are present, refuse before pool construction and tell the caller to pick one
 * source of truth. When only the URL carries directives, native `pg` parsing applies
 * unchanged — including the documented, safe `sslmode=verify-full`.
 */
export function assertNoUrlSslOverride(input: {
  adapter: string;
  directives: UrlSslDirectives;
  explicitSsl: boolean | Record<string, unknown> | undefined;
  /** Explicit ssl inside the `pool` escape hatch overrides the config ssl too. */
  poolSsl?: boolean | Record<string, unknown> | undefined;
}): void {
  const { adapter, directives, explicitSsl, poolSsl } = input;
  if (directives.all.length === 0) return;
  if (explicitSsl === undefined && poolSsl === undefined) return;
  const keys = directives.all.map((d) => `'${d.key}'`).join(', ');
  throw new ConfigurationError(
    adapter,
    `the connection string contains SSL directive(s) ${keys} while an explicit \`ssl\` configuration ` +
      'was also provided. pg resolves URL SSL parameters by REPLACING the configured ssl object ' +
      `silently (e.g. '?sslmode=disable' would discard a configured CA; '?sslmode=require' would ` +
      'discard it too). Choose one source of truth: remove the URL SSL parameters, or drop the ' +
      'explicit `ssl` option.',
  );
}
