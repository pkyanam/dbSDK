#!/usr/bin/env node
/**
 * drizzle-peer-types-fence.mjs — build fence for the `dbsdk/drizzle` optional-peer
 * type boundary (run after `pnpm --filter dbsdk build`).
 *
 * Invariant being guarded: the emitted `dist/drizzle-interop/index.d.ts` must be
 * free of `@neondatabase/serverless` (the optional Neon peer) and of any module
 * whose declaration graph references it (`../adapters/neon`, `drizzle-orm/neon-http`),
 * so that a PostgreSQL-only consumer (pg + drizzle-orm installed, no Neon) can
 * typecheck the shared entry with `skipLibCheck: false`. The driver-typed
 * declaration lives in `dist/drizzle-interop/neon-http.d.ts`
 * (`dbsdk/drizzle/neon-http`), which by design DOES reference the peer and is
 * therefore only for consumers who actually name Neon-specific types.
 *
 * Exits 0 when the fence holds, 1 with a report otherwise.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(pkgRoot, 'dist', 'drizzle-interop');

const failures = [];
const ok = (name) => console.log(`  ok  ${name}`);
const fail = (name, detail) => {
  failures.push(name);
  console.error(`FAIL  ${name}\n      ${detail}`);
};

/** Import/export-from statements (the eager resolution surface), ignoring comments. */
function moduleStatements(source) {
  const noComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');
  return [...noComments.matchAll(/(?:^|[\s;}])((?:import|export)[^\n]*?from\s*['"]([^'"]+)['"])/g)].map((m) => m[2]);
}

const sharedDts = join(dist, 'index.d.ts');
if (existsSync(sharedDts)) {
  const source = readFileSync(sharedDts, 'utf8');
  const modules = moduleStatements(source);
  const forbidden = [
    ['@neondatabase/serverless', 'the optional Neon peer itself'],
    ['../adapters/neon', "NeonRaw's home module (drag in the peer-typed adapter declaration)"],
    ['drizzle-orm/neon-http', 'the driver module whose declarations import the Neon peer'],
  ];
  for (const [needle, why] of forbidden) {
    const hit = modules.filter((m) => m === needle || m.startsWith(`${needle}/`));
    if (hit.length === 0) {
      ok(`shared index.d.ts does not reference ${needle}`);
    } else {
      fail(
        `shared index.d.ts must not reference ${needle}`,
        `found module statements: ${hit.join(', ')} — it would ${why} and break pg-only consumers under skipLibCheck:false`,
      );
    }
  }
  for (const required of [
    'drizzlePostgres',
    'drizzleNeonHttp',
    'NeonHttpClientContract',
    'NeonRawContract',
    'NeonHttpDatabaseContract',
    'NeonHttpNativeClientContract',
    'NeonHttpNativeRawContract',
  ]) {
    if (source.includes(required)) ok(`shared index.d.ts still exports ${required}`);
    else fail(`shared index.d.ts must still export ${required}`, 'public surface changed unexpectedly');
  }
  // Regression guard for the R3 finding: the FIRST overload's second type
  // parameter must keep the native-shaped default, so an explicit-schema call
  // (`drizzleNeonHttp<MySchema>(db)`) keeps the full official `$client`
  // surface instead of silently downgrading to the permissive contract. The
  // permissive default must also remain (second overload) for custom raw
  // handles.
  if (source.includes('= NeonHttpNativeRawContract')) {
    ok('shared index.d.ts keeps the native-shaped default on drizzleNeonHttp (explicit-schema form)');
  } else {
    fail(
      'shared index.d.ts lost the native-shaped drizzleNeonHttp default',
      'the first overload must default its raw parameter to NeonHttpNativeRawContract — otherwise explicit-schema calls silently downgrade $client to the permissive contract (R3 finding)',
    );
  }
  if (source.includes('= NeonRawContract')) {
    ok('shared index.d.ts keeps the permissive contract default (second overload for custom raws)');
  } else {
    fail(
      'shared index.d.ts lost the permissive contract default',
      'the second overload must default its raw parameter to NeonRawContract — custom raw handles with narrower sql types would lose their contract typing',
    );
  }
} else {
  fail('shared index.d.ts exists', `missing file: ${sharedDts} — run the build first`);
}

const strongDts = join(dist, 'neon-http.d.ts');
if (existsSync(strongDts)) {
  const source = readFileSync(strongDts, 'utf8');
  const modules = moduleStatements(source);
  if (modules.some((m) => m === '@neondatabase/serverless')) {
    ok('strong neon-http.d.ts declares driver-typed signature (references @neondatabase/serverless)');
  } else {
    fail('strong neon-http.d.ts lost its driver-typed signature', 'it no longer references @neondatabase/serverless');
  }
  if (source.includes('NeonHttpDatabase') && source.includes('NeonQueryFunction<false, true>')) {
    ok('strong neon-http.d.ts carries NeonHttpDatabase / NeonQueryFunction<false, true> types');
  } else {
    fail('strong neon-http.d.ts type strength', 'NeonHttpDatabase or NeonQueryFunction<false, true> declaration missing');
  }
  if (source.includes('drizzlePostgres')) {
    ok('strong neon-http.d.ts keeps the shared runtime parity note');
  }
} else {
  fail('strong neon-http.d.ts exists', `missing file: ${strongDts} — the dbsdk/drizzle/neon-http type entry is broken`);
}

// The shared runtime must stay the single JS module for both type entries.
// Scan EVERY emitted JS chunk in dist/drizzle-interop/ (the bridge directory),
// not just index.js: a future refactor may move the session factory into a
// sibling chunk, and a static forbidden import must not hide there either.
// Detection runs on a comment-stripped, newline-collapsed view and matches
// from/require( followed by the module specifier, so multi-line statements
// cannot bypass the check (a plain same-line regex could).
const jsDir = dist;
const bridgeJs = existsSync(jsDir)
  ? readdirSync(jsDir).filter((f) => f.endsWith('.js') && !f.endsWith('.map')).sort()
  : [];
if (bridgeJs.length === 0) {
  fail('bridge JS chunks exist', `no .js files found in ${jsDir} — run the build first`);
} else {
  let sawLazyNeonImport = false;
  let staticFailures = 0;
  for (const file of bridgeJs) {
    const source = readFileSync(join(jsDir, file), 'utf8');
    // comment-stripped, newline-collapsed view so multi-line statements match
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
      .join(' ')
      .replace(/\s+/g, ' ');
    const staticHit =
      /(?:from|require\()\s*['"](drizzle-orm\/neon-http|@neondatabase\/serverless)(?:\/[\w./-]*)?['"]/.test(stripped);
    if (staticHit) {
      staticFailures++;
      fail(
        `${file} must not statically import the Neon modules`,
        'a static import/export-from/require of drizzle-orm/neon-http or @neondatabase/serverless was found — the bridge must stay lazy so a PostgreSQL-only consumer never needs them',
      );
    }
    if (/import\(\s*(['"])drizzle-orm\/neon-http\1\s*\)/.test(stripped)) sawLazyNeonImport = true;
  }
  if (sawLazyNeonImport) {
    ok(`bridge JS keeps the lazy dynamic drizzle-orm/neon import (no static import in ${bridgeJs.length} chunk(s))`);
  } else if (staticFailures === 0) {
    fail('bridge JS lazy import', 'the runtime must keep loading drizzle-orm/neon-http lazily via import()');
  }
  if (bridgeJs.includes('index.js')) ok('bridge entry index.js present');
  else fail('bridge entry index.js present', 'dist/drizzle-interop/index.js is missing');
}

console.log('');
if (failures.length > 0) {
  console.error(`drizzle-peer-types-fence: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log('drizzle-peer-types-fence: ALL CHECKS PASSED');
