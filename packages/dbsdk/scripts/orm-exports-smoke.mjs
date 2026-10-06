#!/usr/bin/env node
/**
 * ORM facade smoke — fresh PACKED-tarball consumer verification for
 * dbsdk/orm (the schema-authoring facade). Companion to
 * drizzle-interop-smoke.mjs (which owns dbsdk/drizzle); run with:
 *
 *   node scripts/orm-exports-smoke.mjs
 *
 * With DBSDK_TEST_POSTGRES_URL set (e.g. the local dbsdk-pg-test on :15432),
 * the real-database part runs against that server; otherwise it is skipped.
 *
 * What it proves, from a packed tarball only (never workspace source paths):
 * 1. a clean consumer WITHOUT the drizzle-orm peer: the `dbsdk` root import
 *    still works (the peer failure is NOT triggered at root), and importing
 *    `dbsdk/orm` fails with the native, meaningful Node module-resolution
 *    error naming drizzle-orm — the documented failure mode for a static
 *    re-export authoring surface;
 * 2. a consumer WITH drizzle-orm: the packed facade artifacts are pure
 *    re-exports (drizzle-orm stays an EXTERNAL peer — no upstream code is
 *    bundled), facade exports are runtime-identical to the consumer's own
 *    drizzle-orm copy, and strict tsc (NodeNext, exactOptionalPropertyTypes,
 *    noUncheckedIndexedAccess, skipLibCheck:true) compiles real schema
 *    authoring (pgTable/pgSchema, columns, relations, InferSelectModel/
 *    InferInsertModel, QueryBuilder) including deliberate wrong inputs via
 *    @ts-expect-error. With skipLibCheck:false, every reported error lives
 *    inside drizzle-orm's own published d.ts (upstream boundary, same as
 *    the bridge) — none in dbsdk's artifacts or consumer code;
 * 3. runtime behavior: client-free SELECT construction through the facade
 *    is byte-identical (SQL + params) to the same query built directly from
 *    drizzle-orm, and — when a server is available — a facade-authored
 *    schema drives the frozen dbsdk/drizzle bridge end to end (insert/
 *    select/join/aggregate/union/returning/relational queries) on a unique
 *    schema, with cleanup by an independent pg client in finally.
 *
 * CJS note: the package promises ESM ("import" condition). A `require()`
 * check is included as an observation because Node >= 22.12 supports
 * require(esm) and the exports map's "default" condition points at the ESM
 * artifact; it is reported, not advertised as a supported CJS build.
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const testUrl = process.env.DBSDK_TEST_POSTGRES_URL;
const root = mkdtempSync(path.join(tmpdir(), 'dbsdk-orm-smoke-'));

try {
  // -----------------------------------------------------------------------
  // 0. Build + pack
  // -----------------------------------------------------------------------
  step('build + pack the package');
  run('pnpm run build', { cwd: pkgDir });
  const packOutput = run('npm pack --pack-destination ' + root, { cwd: pkgDir });
  const tarball = path.join(root, packOutput.split('\n').at(-1).trim());
  ok(`packed ${path.basename(tarball)}`);
  const tarballFiles = run(`tar tzf ${tarball}`);
  for (const required of ['package/dist/orm-facade/index.js', 'package/dist/orm-facade/index.d.ts']) {
    if (!tarballFiles.split('\n').includes(required)) fail(`tarball missing ${required}`);
  }
  ok('tarball contains dist/orm-facade artifacts');

  // -----------------------------------------------------------------------
  // 1. Consumer WITHOUT the optional drizzle peer
  // -----------------------------------------------------------------------
  step('consumer A: no drizzle-orm peer installed (root stays dependency-free)');
  const consumerA = path.join(root, 'consumer-no-drizzle');
  mkdirSync(consumerA, { recursive: true });
  writeFileSync(
    path.join(consumerA, 'package.json'),
    JSON.stringify({ name: 'consumer-a', type: 'module', private: true }, null, 2),
  );
  run(`npm install ${tarball} --legacy-peer-deps --no-audit --no-fund --loglevel=error`, { cwd: consumerA });
  if (existsSync(path.join(consumerA, 'node_modules', 'drizzle-orm'))) {
    fail('drizzle-orm was installed in consumer A; the no-peer premise is broken');
  }
  ok('installed with zero optional peers');

  writeFileSync(
    path.join(consumerA, 'check.mjs'),
    `
import assert from 'node:assert/strict';
// The ROOT import must not be affected by the missing drizzle-orm peer.
const dbsdk = await import('dbsdk');
assert.equal(typeof dbsdk.createDatabase, 'function');
console.log('   ok: root import works without drizzle-orm (peer failure is subpath-scoped)');
// Importing dbsdk/orm without the peer fails with the NATIVE module
// resolution error, naming the missing dependency — not a silent failure,
// not a dbSDK crash, and no DSNs anywhere.
let ormError = null;
try {
  await import('dbsdk/orm');
} catch (error) {
  ormError = error;
}
assert.ok(ormError, 'expected dbsdk/orm import to reject without the peer');
assert.equal(ormError.code, 'ERR_MODULE_NOT_FOUND');
assert.match(String(ormError.message), /drizzle-orm/);
assert.doesNotMatch(String(ormError.message), /postgres:\\/\\//);
console.log('   ok: dbsdk/orm fails with the native ERR_MODULE_NOT_FOUND naming drizzle-orm');
// The bridge entry still behaves as documented without the peer (lazy import,
// actionable factory error) — the two entries share the same optional peer.
const interop = await import('dbsdk/drizzle');
assert.equal(typeof interop.drizzlePostgres, 'function');
let bridgeError = null;
try {
  await interop.drizzlePostgres({
    engine: 'postgresql', adapterId: 'fake',
    capabilities: { interactiveTransactions: true, atomicBatch: true, sessionState: true, transport: 'tcp', evidence: {} },
    sql() {}, query() {}, batch() {}, transaction() {}, close() {},
    raw: { query() {}, connect() {}, end() {} },
    [Symbol.asyncDispose]() {},
  });
} catch (error) {
  bridgeError = error;
}
assert.match(String(bridgeError?.message), /drizzle-orm/);
console.log('   ok: dbsdk/drizzle still refuses cleanly without the peer (same optional peer)');
`,
  );
  const nodeA = spawnSync('node', ['check.mjs'], { cwd: consumerA, encoding: 'utf8' });
  if (nodeA.status !== 0) fail(`consumer A check failed:\n${nodeA.stdout}\n${nodeA.stderr}`);
  process.stdout.write(nodeA.stdout);

  // -----------------------------------------------------------------------
  // 2. Consumer WITH drizzle-orm — packed artifacts, identity, strict types
  // -----------------------------------------------------------------------
  step('consumer B: full consumer, strict tsc, facade identity');
  const consumerB = path.join(root, 'consumer-full');
  mkdirSync(consumerB, { recursive: true });
  writeFileSync(
    path.join(consumerB, 'package.json'),
    JSON.stringify({ name: 'consumer-b', type: 'module', private: true }, null, 2),
  );
  run(
    `npm install ${tarball} drizzle-orm@0.45.3 pg@^8.23.1 @neondatabase/serverless@^1.2.0 ` +
      '@types/pg@^8.23.1 @types/node@^26.6.4 typescript@^5.9.0 --no-audit --no-fund --loglevel=error',
    { cwd: consumerB },
  );
  ok('installed dbsdk tarball + drizzle-orm 0.45.3 + pg + neon + types');

  // The packed facade must be a pure re-export: drizzle-orm stays an EXTERNAL
  // peer (no upstream code bundled), so the consumer's single drizzle-orm
  // copy is the one both dbsdk/orm and dbsdk/drizzle resolve.
  const facadeJs = readFileSync(
    path.join(consumerB, 'node_modules', 'dbsdk', 'dist', 'orm-facade', 'index.js'),
    'utf8',
  );
  if (!/export \* from ["']drizzle-orm["']/.test(facadeJs)) {
    fail('packed facade js is not a pure re-export of drizzle-orm (was upstream code bundled?)');
  }
  if (facadeJs.length > 500) fail(`packed facade js suspiciously large (${facadeJs.length} bytes) — upstream code may have been bundled`);
  const facadeDts = readFileSync(
    path.join(consumerB, 'node_modules', 'dbsdk', 'dist', 'orm-facade', 'index.d.ts'),
    'utf8',
  );
  for (const expected of ['drizzle-orm', 'pg-core']) {
    if (!facadeDts.includes(expected)) fail(`packed facade d.ts lost re-export: ${expected}`);
  }
  ok(`packed facade artifacts are pure re-exports (js ${facadeJs.length} bytes, d.ts ${facadeDts.length} bytes, peer external)`);

  // Runtime identity: facade exports ARE the consumer's own drizzle-orm copy.
  writeFileSync(
    path.join(consumerB, 'identity.mjs'),
    `
import assert from 'node:assert/strict';
import * as facade from 'dbsdk/orm';
import * as upstreamRoot from 'drizzle-orm';
import * as upstreamPg from 'drizzle-orm/pg-core';
for (const name of ['pgTable', 'pgSchema', 'text', 'integer', 'serial', 'QueryBuilder']) {
  assert.equal(facade[name], upstreamPg[name], \`facade.\${name} must be the consumer's drizzle-orm/pg-core object\`);
}
for (const name of ['eq', 'and', 'relations', 'sql', 'aliasedTable', 'count']) {
  assert.equal(facade[name], upstreamRoot[name], \`facade.\${name} must be the consumer's drizzle-orm object\`);
}
// The five doubly-exported type names resolve to the pg-core specializations
// (type-level; verified by tsc below — here we assert the runtime namespace
// is intact and non-vacuous).
assert.equal(typeof facade.pgTable, 'function');
assert.equal(typeof facade.QueryBuilder, 'function');
console.log('   ok: facade exports are runtime-identical to the consumer\\'s drizzle-orm copy');
`,
  );
  const nodeIdentity = spawnSync('node', ['identity.mjs'], { cwd: consumerB, encoding: 'utf8' });
  if (nodeIdentity.status !== 0) fail(`identity check failed:\n${nodeIdentity.stdout}\n${nodeIdentity.stderr}`);
  process.stdout.write(nodeIdentity.stdout);

  // CJS observation (Node >= 22.12 require(esm); NOT an advertised CJS build).
  writeFileSync(
    path.join(consumerB, 'cjs-check.cjs'),
    `
const orm = require('dbsdk/orm');
if (typeof orm.pgTable !== 'function') {
  console.log('   note: require(esm) did not expose named exports for dbsdk/orm');
  process.exit(2);
}
console.log('   note: require("dbsdk/orm") resolves via require(esm) on this Node runtime');
`,
  );
  const nodeCjs = spawnSync('node', ['cjs-check.cjs'], { cwd: consumerB, encoding: 'utf8' });
  if (nodeCjs.status !== 0 && nodeCjs.status !== 2) {
    fail(`cjs observation crashed unexpectedly:\n${nodeCjs.stdout}\n${nodeCjs.stderr}`);
  }
  process.stdout.write(nodeCjs.stdout);

  // Strict typecheck: real authoring surface, wrong inputs must fail.
  writeFileSync(
    path.join(consumerB, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: 'ES2023',
          lib: ['ES2023', 'ESNext.Disposable'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: true,
          noEmit: true,
          types: ['node'],
        },
        include: ['*.ts'],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(consumerB, 'types.ts'),
    `
import { createDatabase } from 'dbsdk';
import { postgres } from 'dbsdk/postgres';
import { drizzlePostgres } from 'dbsdk/drizzle';
// The ENTIRE authoring surface below comes from ONE import: dbsdk/orm.
import {
  pgSchema,
  pgTable,
  serial,
  text,
  integer,
  relations,
  eq,
  count,
  sql,
  QueryBuilder,
} from 'dbsdk/orm';
import type { InferSelectModel, InferInsertModel } from 'dbsdk/orm';

const app = pgSchema('orm_smoke_types');
const users = app.table('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
  age: integer('age'),
});
const posts = app.table('posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id').notNull().references(() => users.id),
  title: text('title'),
});
const usersRelations = relations(users, ({ many }) => ({ posts: many(posts) }));
const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
}));
const schema = { users, posts, usersRelations, postsRelations };

// Real table/relation schema inference through the facade.
type User = InferSelectModel<typeof users>;
const userCheck: User = { id: 1, email: 'a@b.c', age: null };
type NewUser = InferInsertModel<typeof users>;
const insertCheck: NewUser = { email: 'a@b.c' };

// Client-free SELECT construction (QueryBuilder is SELECT-only).
const query = new QueryBuilder()
  .select({ id: users.id, email: users.email })
  .from(users)
  .where(eq(users.email, 'x'))
  .limit(10);
void query;

// Aggregates through the facade.
const aggregate = new QueryBuilder().select({ total: count() }).from(users).where(sql\`1 = 1\`);
void aggregate;

const db = createDatabase({ adapter: postgres({ connectionString: 'postgres://u:p@localhost:5432/d' }) });

export async function typeLevel() {
  const d = await drizzlePostgres(db, { schema });
  // Typed select through the bridge, schema authored via dbsdk/orm.
  const rows = await d.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, 1));
  const check: { id: number; email: string }[] = rows;
  void check;
  // Relational query typing through the bridge.
  const rqb = await d.query.users.findMany({ with: { posts: true }, limit: 5 });
  const rqbCheck: { id: number; email: string; age: number | null; posts: { id: number; authorId: number; title: string | null }[] }[] = rqb;
  void rqbCheck;
  // Write returnings keep their types.
  const inserted = await d.insert(users).values({ email: 'a@b.c' }).returning({ id: users.id });
  const idCheck: { id: number }[] = inserted;
  void idCheck;

  // @ts-expect-error wrong comparison type for an integer column
  eq(users.id, 'not-a-number');
  // @ts-expect-error unknown column on the facade-authored table
  eq(users.unknownColumn, 1);
  // @ts-expect-error wrong value type for an integer column
  await d.insert(users).values({ email: 'a@b.c', age: 'not-a-number' });
  // @ts-expect-error unknown column in an insert
  await d.insert(users).values({ emial: 'a@b.c' });
  // @ts-expect-error pg-core QueryBuilder is SELECT-only (no .update)
  new QueryBuilder().update(users);
}
`,
  );

  const tscFull = spawnSync('npx', ['tsc', '-p', '.'], { cwd: consumerB, encoding: 'utf8' });
  if (tscFull.status !== 0) fail(`strict typecheck failed:\n${tscFull.stdout}\n${tscFull.stderr}`);
  ok('strict tsc (NodeNext, exactOptionalPropertyTypes, noUncheckedIndexedAccess): real authoring + inference + @ts-expect-error negatives all fire');

  // skipLibCheck:false boundary — same rule as the bridge: errors only inside
  // drizzle-orm's own published d.ts (upstream), none in dbsdk artifacts or
  // consumer code. All three optional peers are installed here.
  const tsconfigNoLsc = JSON.parse(readFileSync(path.join(consumerB, 'tsconfig.json'), 'utf8'));
  tsconfigNoLsc.compilerOptions.skipLibCheck = false;
  writeFileSync(path.join(consumerB, 'tsconfig-nolsc.json'), JSON.stringify(tsconfigNoLsc, null, 2));
  const tscNoLsc = spawnSync('npx', ['tsc', '-p', 'tsconfig-nolsc.json'], { cwd: consumerB, encoding: 'utf8' });
  const noLscOutput = (tscNoLsc.stdout + tscNoLsc.stderr).trim();
  const errorLines = noLscOutput.split('\n').filter((line) => /^\S+\.d\.ts\(|^\S+\.ts\(/.test(line));
  const outsideDrizzle = errorLines.filter((line) => !line.startsWith('node_modules/drizzle-orm/'));
  if (outsideDrizzle.length > 0) {
    fail(`skipLibCheck:false reported errors outside node_modules/drizzle-orm:\n${outsideDrizzle.join('\n')}`);
  }
  ok(
    `skipLibCheck:false: 0 errors from packed dbsdk artifacts or consumer code ` +
      `(${errorLines.length} inside drizzle-orm's own published d.ts — upstream boundary, unchanged by the facade)`,
  );

  // -----------------------------------------------------------------------
  // 3. Runtime behavior: dual SQL equality + live leg through the bridge
  // -----------------------------------------------------------------------
  writeFileSync(
    path.join(consumerB, 'main.ts'),
    `
import assert from 'node:assert/strict';
import { createDatabase } from 'dbsdk';
import { postgres } from 'dbsdk/postgres';
import { drizzlePostgres } from 'dbsdk/drizzle';
// The same query built through the facade and through drizzle-orm directly
// must produce byte-identical SQL and params (same underlying objects).
import { pgSchema, pgTable, serial, text, integer, relations, QueryBuilder, eq, and, count, sql, asc } from 'dbsdk/orm';
import { count as directCount, asc as directAsc } from 'drizzle-orm';
import { QueryBuilder as DirectQueryBuilder, pgSchema as directPgSchema, serial as directSerial, text as directText, integer as directInteger } from 'drizzle-orm/pg-core';

const SCHEMA = 'dbsdk_orm_smoke';
const app = pgSchema(SCHEMA);
const users = app.table('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
  age: integer('age'),
});
const posts = app.table('posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id').notNull(),
  title: text('title'),
});
const usersRelations = relations(users, ({ many }) => ({ posts: many(posts) }));
const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
}));
const schema = { users, posts, usersRelations, postsRelations };

// Dual construction byte equality (client-free, offline).
const viaFacade = new QueryBuilder()
  .select({ id: users.id, email: users.email })
  .from(users)
  .where(and(eq(users.age, 30), eq(users.email, 'x')))
  .orderBy(asc(users.id))
  .limit(5);
const directApp = directPgSchema(SCHEMA);
const directUsers = directApp.table('users', {
  id: directSerial('id').primaryKey(),
  email: directText('email').notNull(),
  age: directInteger('age'),
});
const viaDirect = new DirectQueryBuilder()
  .select({ id: directUsers.id, email: directUsers.email })
  .from(directUsers)
  .where(and(eq(directUsers.age, 30), eq(directUsers.email, 'x')))
  .orderBy(directAsc(directUsers.id))
  .limit(5);
assert.deepEqual(viaFacade.toSQL(), viaDirect.toSQL());
const aggFacade = new QueryBuilder().select({ total: count() }).from(users);
const aggDirect = new DirectQueryBuilder().select({ total: directCount() }).from(directUsers);
assert.deepEqual(aggFacade.toSQL(), aggDirect.toSQL());
assert.match(aggFacade.toSQL().sql, /count\\(\\*\\)/);
console.log('   ok: facade vs direct drizzle-orm SQL/params byte equality (select + aggregate)');

const URL = process.env.DBSDK_TEST_POSTGRES_URL ?? 'postgresql://postgres:dbsdk@localhost:15432/dbsdk';
if (!process.env.DBSDK_TEST_POSTGRES_URL) {
  console.log('   (DBSDK_TEST_POSTGRES_URL not set: real-database part skipped)');
  process.exit(0);
}

const db = createDatabase({ adapter: postgres({ connectionString: URL, max: 2 }) });
const drizzleDb = await drizzlePostgres(db, { schema });

// Facade-authored schema drives the frozen bridge end to end. Whole live leg
// inside try/finally; cleanup via an independent pg client.
try {
  await db.query({ text: \`drop schema if exists \${SCHEMA} cascade\` });
  await db.query({ text: \`create schema \${SCHEMA}\` });
  await db.query({
    text:
      'create table ' + SCHEMA + '.users ' +
      '(id serial primary key, email text not null, age integer)',
  });
  await db.query({
    text:
      'create table ' + SCHEMA + '.posts ' +
      '(id serial primary key, author_id integer not null references ' + SCHEMA + '.users(id), title text)',
  });

  const inserted = await drizzleDb.insert(users).values([{ email: 'ada@example.com', age: 36 }, { email: 'grace@example.com', age: 45 }]).returning({ id: users.id, email: users.email });
  assert.equal(inserted.length, 2);
  console.log('   ok: insert ... returning through the bridge (facade schema)');

  await drizzleDb.insert(posts).values([{ authorId: inserted[0]!.id, title: 'First post' }, { authorId: inserted[0]!.id, title: 'Second post' }]);
  const joined = await drizzleDb
    .select({ email: users.email, title: posts.title })
    .from(users)
    .innerJoin(posts, eq(posts.authorId, users.id))
    .orderBy(asc(posts.id));
  assert.deepEqual(joined, [
    { email: 'ada@example.com', title: 'First post' },
    { email: 'ada@example.com', title: 'Second post' },
  ]);
  console.log('   ok: typed join select with inferred row shape');

  const aggregate = await drizzleDb
    .select({ authorId: posts.authorId, total: count() })
    .from(posts)
    .groupBy(posts.authorId)
    .having(sql\`count(*) > 0\`);
  assert.deepEqual(aggregate, [{ authorId: inserted[0]!.id, total: 2 }]);
  console.log('   ok: aggregate + group + having');

  const rqb = await drizzleDb.query.users.findMany({ with: { posts: true }, limit: 5 });
  assert.equal(rqb.length, 2);
  assert.equal(rqb[0]!.email, 'ada@example.com');
  assert.equal(rqb[0]!.posts.length, 2);
  assert.equal(rqb[1]!.posts.length, 0);
  console.log('   ok: relational query (RQB) with relations graph through the bridge');

  const updated = await drizzleDb.update(users).set({ age: 37 }).where(eq(users.email, 'ada@example.com')).returning({ id: users.id, age: users.age });
  assert.deepEqual(updated, [{ id: inserted[0]!.id, age: 37 }]);
  console.log('   ok: update ... returning');

  const deleted = await drizzleDb.delete(posts).where(eq(posts.authorId, inserted[1]!.id)).returning({ id: posts.id });
  assert.deepEqual(deleted, []);
  console.log('   ok: delete ... returning (empty result is fine)');

  await drizzleDb.delete(posts).where(eq(posts.authorId, inserted[0]!.id));
  const remaining = await drizzleDb.select({ total: count() }).from(posts);
  assert.equal(remaining[0]!.total, 0);
  console.log('   ok: delete + aggregate confirm');
} finally {
  let cleanupError: unknown;
  try {
    const { Client } = await import('pg');
    const cleaner = new Client({ connectionString: URL });
    try {
      await cleaner.connect();
      await cleaner.query(\`drop schema if exists \${SCHEMA} cascade\`);
    } finally {
      await cleaner.end();
    }
  } catch (error) {
    cleanupError = error;
  }
  try {
    await db.close();
  } catch {
    // best-effort close
  }
  if (cleanupError) {
    console.error('   warning: fixture schema cleanup failed:', cleanupError);
    process.exitCode = 1; // surface the leak without masking the original failure
  }
}
`,
  );

  const nodeB = spawnSync('node', ['main.ts'], {
    cwd: consumerB,
    encoding: 'utf8',
    env: { ...process.env },
  });
  if (nodeB.status !== 0) fail(`consumer B runtime failed:\n${nodeB.stdout}\n${nodeB.stderr}`);
  process.stdout.write(nodeB.stdout);

  step('smoke complete');
  console.log('tarball: ' + path.basename(tarball));
  console.log('workdir kept for inspection: ' + root);
} catch (error) {
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
}
