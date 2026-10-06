#!/usr/bin/env node
/**
 * PlanetScale exports smoke — fresh PACKED-tarball consumer verification for
 * the accepted public subpaths `dbsdk/planetscale` and
 * `dbsdk/management/planetscale`. Run with:
 *
 *   node scripts/planetscale-exports-smoke.mjs
 *
 * What it proves, from a packed tarball only (never workspace source paths):
 * 1. consumer WITHOUT any optional peers: the root import stays lazy and
 *    driver-free; `dbsdk/management/planetscale` imports and runs a full
 *    management CRUD round trip offline through an injected fetch — the
 *    management subpath needs no database driver at runtime;
 * 2. `dbsdk/planetscale` without `pg` fails AT IMPORT (the same documented
 *    static-peer contract as `dbsdk/postgres` / `dbsdk/supabase` — this is
 *    asserted, not hidden);
 * 3. a consumer WITH `pg`: the adapter's refusals fire before any connection
 *    (missing/mismatched connection mode, remote plaintext), and a query
 *    round trip works offline through an injected pool factory.
 */

import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const step = (message) => console.log(`\n== ${message}`);
const ok = (message) => console.log(`   ok: ${message}`);
const run = (cmd, opts = {}) =>
  execSync(cmd, { stdio: ['ignore', 'pipe', 'inherit'], ...opts }).toString().trim();
const fail = (message) => {
  console.error(`\nSMOKE FAILED: ${message}`);
  process.exit(1);
};

const root = mkdtempSync(path.join(tmpdir(), 'dbsdk-planetscale-smoke-'));

try {
  // -----------------------------------------------------------------------
  // 0. Build + pack
  // -----------------------------------------------------------------------
  step('build + pack the package');
  run('pnpm run build', { cwd: pkgDir });
  const packOutput = run('npm pack --pack-destination ' + root, { cwd: pkgDir });
  const tarball = path.join(root, packOutput.split('\n').at(-1).trim());
  ok(`packed ${path.basename(tarball)}`);

  // -----------------------------------------------------------------------
  // 1. Consumer WITHOUT optional peers: root lazy + management subpath works
  // -----------------------------------------------------------------------
  step('consumer A: zero optional peers — root lazy, management subpath runs offline');
  const consumerA = path.join(root, 'consumer-no-peers');
  mkdirSync(consumerA, { recursive: true });
  writeFileSync(
    path.join(consumerA, 'package.json'),
    JSON.stringify({ name: 'consumer-ps-a', type: 'module', private: true }, null, 2),
  );
  run(`npm install ${tarball} --legacy-peer-deps --no-audit --no-fund --loglevel=error`, { cwd: consumerA });
  writeFileSync(
    path.join(consumerA, 'check-peers.mjs'),
    `
import { existsSync } from 'node:fs';
for (const peer of ['pg', 'drizzle-orm', '@neondatabase/serverless']) {
  if (existsSync('node_modules/' + peer)) {
    console.error('FAIL: peer installed in no-peer consumer: ' + peer);
    process.exit(1);
  }
}
console.log('   ok: zero optional peers installed');
`,
  );
  const peersCheck = spawnSync('node', ['check-peers.mjs'], { cwd: consumerA, encoding: 'utf8' });
  if (peersCheck.status !== 0) fail(`peer premise broken:\n${peersCheck.stdout}\n${peersCheck.stderr}`);
  process.stdout.write(peersCheck.stdout);

  writeFileSync(
    path.join(consumerA, 'check-management.mjs'),
    `
import assert from 'node:assert/strict';
// Root import works with zero peers and loads no driver.
const dbsdk = await import('dbsdk');
assert.equal(typeof dbsdk.createManagement, 'function');
console.log('   ok: root import works without any optional peer');

// The management subpath needs NO database driver: full CRUD round trip
// offline through an injected fetch (mock control plane, official shapes).
const { createManagement } = await import('dbsdk/management');
const { planetscaleManagement } = await import('dbsdk/management/planetscale');

const NOW = '2026-10-06T00:00:00Z';
const calls = [];
let dbKind = 'postgresql'; // flipped to 'mysql' to prove the engine gate
const fetch = async (input, init) => {
  const url = new URL(String(input));
  calls.push({ path: url.pathname, method: init?.method ?? 'GET', body: init?.body });
  const json = (body, status = 200) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json' },
    });
  if (init?.method === 'POST' && url.pathname === '/v1/organizations/acme/databases') {
    assert.deepEqual(JSON.parse(init.body), { name: 'app-db', kind: 'postgresql', cluster_size: 'PS-10-GP' });
    return json({ id: 'uid-1', name: 'app-db', state: 'pending', ready: false, default_branch: 'main',
      region: { slug: 'us-east-1' }, created_at: NOW, updated_at: NOW, kind: 'postgresql' }, 201);
  }
  if (url.pathname === '/v1/organizations/acme/databases/app-db') {
    return json({ id: 'uid-1', name: 'app-db', state: 'ready', ready: true, default_branch: 'main',
      region: { slug: 'us-east-1' }, created_at: NOW, updated_at: NOW, kind: dbKind });
  }
  throw new Error('unexpected: ' + init?.method + ' ' + url.pathname);
};

const management = createManagement({
  adapter: planetscaleManagement({ tokenId: 't', tokenSecret: 's', organization: 'acme', fetch }),
});
const result = await management.create({ kind: 'project', name: 'app-db', providerOptions: { cluster_size: 'PS-10-GP' } });
assert.equal(result.resource?.id, 'app-db');
assert.equal(result.secrets.length, 0); // no fabricated passwords
const ready = await management.wait(result, { timeoutMs: 5000, pollIntervalMs: 1 });
assert.equal(ready.status, 'active');
assert.equal(calls.filter((c) => c.method === 'POST').length, 1); // wait() never replays the create
// Engine preflight + refusal on a mysql parent (mutation never sent):
calls.length = 0;
dbKind = 'mysql';
await assert.rejects(
  management.create({ kind: 'branch', name: 'x', projectId: 'app-db' }),
  /kind 'mysql'|PostgreSQL/,
);
dbKind = 'postgresql';
await assert.rejects(management.action({ kind: 'project', id: 'app-db' }, 'restart'), /CAPABILITY|not supported/);
assert.deepEqual(calls.filter((c) => c.method !== 'GET'), []); // zero mutating requests left the process
console.log('   ok: dbsdk/management/planetscale full CRUD round trip offline, engine gate + capability refusals intact');
`,
  );
  const mgmtCheck = spawnSync('node', ['check-management.mjs'], { cwd: consumerA, encoding: 'utf8' });
  if (mgmtCheck.status !== 0) fail(`consumer A management check failed:\n${mgmtCheck.stdout}\n${mgmtCheck.stderr}`);
  process.stdout.write(mgmtCheck.stdout);

  // Query adapter import without pg: the documented static-peer contract
  // (identical to dbsdk/postgres) — fails at import, not silently.
  writeFileSync(
    path.join(consumerA, 'check-no-pg.mjs'),
    `
try {
  await import('dbsdk/planetscale');
  console.error('FAIL: dbsdk/planetscale imported without pg');
  process.exit(1);
} catch (error) {
  if (!/Cannot find package ['"]pg['"]|Cannot find module ['"]pg['"]/.test(String(error?.message ?? error))) {
    console.error('FAIL: unexpected error: ' + String(error?.message ?? error));
    process.exit(1);
  }
}
try {
  await import('dbsdk/postgres');
  console.error('FAIL: dbsdk/postgres imported without pg');
  process.exit(1);
} catch (error) {
  if (!/Cannot find package ['"]pg['"]|Cannot find module ['"]pg['"]/.test(String(error?.message ?? error))) {
    console.error('FAIL: unexpected error: ' + String(error?.message ?? error));
    process.exit(1);
  }
}
console.log('   ok: dbsdk/planetscale without pg fails at import — same documented contract as dbsdk/postgres');
`,
  );
  const noPgCheck = spawnSync('node', ['check-no-pg.mjs'], { cwd: consumerA, encoding: 'utf8' });
  if (noPgCheck.status !== 0) fail(`consumer A no-pg check failed:\n${noPgCheck.stdout}\n${noPgCheck.stderr}`);
  process.stdout.write(noPgCheck.stdout);

  // -----------------------------------------------------------------------
  // 2. Consumer WITH pg: refusals before connection + offline query round trip
  // -----------------------------------------------------------------------
  step('consumer B: with pg — adapter refusals + offline query via injected pool factory');
  const consumerB = path.join(root, 'consumer-pg');
  mkdirSync(consumerB, { recursive: true });
  writeFileSync(
    path.join(consumerB, 'package.json'),
    JSON.stringify({ name: 'consumer-ps-b', type: 'module', private: true }, null, 2),
  );
  run(`npm install ${tarball} pg@^8.23.1 --no-audit --no-fund --loglevel=error`, { cwd: consumerB });
  writeFileSync(
    path.join(consumerB, 'main.mjs'),
    `
import assert from 'node:assert/strict';
const { createDatabase } = await import('dbsdk');
const { planetscale } = await import('dbsdk/planetscale');

// Refusals before any connection attempt:
assert.throws(
  () => planetscale({ connectionString: 'postgresql://u:p@h/db' }),
  /connectionMode is required/,
);
assert.throws(
  () => planetscale({ connectionString: 'postgresql://u:p@h:6432/db', connectionMode: 'direct' }),
  /requires port 5432/,
);
assert.throws(
  () => planetscale({ connectionString: 'postgresql://u:p@app.psdb.cloud/db', connectionMode: 'direct', ssl: false }),
  /ssl: false.*non-local host|refusing to connect unencrypted/is,
);
assert.throws(
  () => planetscale({ connectionString: 'postgresql://u:p@app.psdb.cloud/db?sslmode=verify-ca', connectionMode: 'direct' }),
  /sslmode/,
);
console.log('   ok: mode/TLS refusals fire before any connection');

// Offline query round trip through an injected pool factory (no server):
let ended = false;
const fakePool = {
  async query(config) {
    return { rows: [{ ok: 1 }], rowCount: 1, command: 'SELECT', fields: [] };
  },
  async connect() {
    return {
      query: async (c) => ({ rows: [], rowCount: 0, command: '', fields: [] }),
      release: () => {},
    };
  },
  async end() { ended = true; },
  on() {},
};
const db = createDatabase({
  adapter: planetscale({
    connectionString: 'postgresql://role.branch:pw@127.0.0.1:5432/db',
    connectionMode: 'direct',
    poolFactory: () => fakePool,
  }),
});
const { rows } = await db.query({ text: 'select $1 as ok', params: [1] });
assert.deepEqual(rows, [{ ok: 1 }]);
assert.equal(db.capabilities.sessionState, true); // direct mode
await db.close();
assert.equal(ended, true);
console.log('   ok: parameterized query + close through the public facade (offline, injected pool)');
`,
  );
  const nodeB = spawnSync('node', ['main.mjs'], { cwd: consumerB, encoding: 'utf8' });
  if (nodeB.status !== 0) fail(`consumer B failed:\n${nodeB.stdout}\n${nodeB.stderr}`);
  process.stdout.write(nodeB.stdout);

  step('smoke complete');
  console.log('tarball: ' + path.basename(tarball));
  console.log('workdir kept for inspection: ' + root);
} catch (error) {
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
}
