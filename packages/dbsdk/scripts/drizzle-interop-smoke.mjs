#!/usr/bin/env node
/**
 * Drizzle interop smoke — fresh PACKED-tarball consumer verification for
 * dbsdk/drizzle. Separate from dist-smoke (owned by the sync fix); run with:
 *
 *   node scripts/drizzle-interop-smoke.mjs
 *
 * With DBSDK_TEST_POSTGRES_URL set (e.g. the local dbsdk-pg-test on :15432),
 * the real-database part runs against that server; otherwise it is skipped.
 *
 * What it proves, from a packed tarball only (never workspace source paths):
 * 1. a clean consumer WITHOUT the drizzle-orm peer: `dbsdk` root import works,
 *    `dbsdk/drizzle` imports lazily with no side effects, and calling the
 *    factory yields an actionable missing-peer error (no DSNs, no stack noise);
 * 2. a consumer WITH drizzle-orm: strict tsc (NodeNext, exactOptionalProperty-
 *    Types, noUncheckedIndexedAccess, skipLibCheck:false) compiles the entry,
 *    including @ts-expect-error cases for native-construction config and wrong
 *    insert columns; the emitted .d.ts preserves Drizzle generics. With ALL
 *    optional peers installed, every reported error lives inside drizzle-orm's
 *    own published d.ts (upstream; reproduces in a bare drizzle consumer).
 *    A consumer that omits @neondatabase/serverless legitimately sees 2
 *    unresolved-optional-peer-type errors in dbsdk's own d.ts (verified as
 *    consumer C below) — no zero-strict-errors claim is made;
 * 3. runtime behavior: offline refusals (non-Database input, DSN/connection/
 *    client config, sessionState:false transaction pooler refused BEFORE pool
 *    creation) and, when a server is available, real schema queries, joins,
 *    transactions, close semantics (no pool recreation) on a unique schema.
 *    The real-DB fixture lifecycle is wrapped in try/finally with a standalone
 *    cleanup connection, so a mid-run failure can never leak the schema.
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.resolve(pkgDir, '..', '..');
const step = (message) => console.log(`\n== ${message}`);
const ok = (message) => console.log(`   ok: ${message}`);
const run = (cmd, opts = {}) =>
  execSync(cmd, { stdio: ['ignore', 'pipe', 'inherit'], ...opts }).toString().trim();
const fail = (message) => {
  console.error(`\nSMOKE FAILED: ${message}`);
  process.exit(1);
};

const testUrl = process.env.DBSDK_TEST_POSTGRES_URL;
const root = mkdtempSync(path.join(tmpdir(), 'dbsdk-drizzle-smoke-'));

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
  // 1. Consumer WITHOUT the optional drizzle peer
  // -----------------------------------------------------------------------
  step('consumer A: no drizzle-orm peer installed');
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
// Root SDK import must work with no drizzle-orm and no pg anywhere.
const dbsdk = await import('dbsdk');
assert.equal(typeof dbsdk.createDatabase, 'function');
console.log('   ok: root import works without drizzle-orm');
// Optional entry imports lazily: loading it must have no side effects
// (no pool, no client, no network) and must not throw.
const interop = await import('dbsdk/drizzle');
assert.equal(typeof interop.drizzlePostgres, 'function');
assert.equal(typeof interop.drizzleNeonHttp, 'function');
console.log('   ok: dbsdk/drizzle imports lazily with no side effects');
// A well-formed Database whose raw handle is a valid pool shape gets past
// validation and then hits the missing-peer error with an actionable message.
const fakeDb = {
  engine: 'postgresql',
  adapterId: 'fake',
  capabilities: { interactiveTransactions: true, atomicBatch: true, sessionState: true, transport: 'tcp', evidence: {} },
  sql() {}, query() {}, batch() {}, transaction() {}, close() {},
  raw: { query() {}, connect() {}, end() {} },
  [Symbol.asyncDispose]() {},
};
let message = '';
try {
  await interop.drizzlePostgres(fakeDb);
} catch (error) {
  message = error?.message ?? String(error);
}
assert.match(message, /drizzle-orm/);
assert.match(message, /npm i drizzle-orm|pnpm add drizzle-orm/);
assert.doesNotMatch(message, /postgres:\\/\\//);
console.log('   ok: missing-peer error is actionable and DSN-free');
`,
  );
  const nodeA = spawnSync('node', ['check.mjs'], { cwd: consumerA, encoding: 'utf8' });
  if (nodeA.status !== 0) fail(`consumer A check failed:\n${nodeA.stdout}\n${nodeA.stderr}`);
  process.stdout.write(nodeA.stdout);

  // -----------------------------------------------------------------------
  // 2. Consumer WITH drizzle-orm — strict typecheck of the packed API
  // -----------------------------------------------------------------------
  step('consumer B: full consumer, strict tsc, skipLibCheck:false');
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
  ok('installed dbsdk tarball + drizzle-orm 0.45.3 + pg + types');

  // The packed .d.ts must preserve Drizzle generics (no any-erasure).
  const packedDts = readFileSync(
    path.join(consumerB, 'node_modules', 'dbsdk', 'dist', 'drizzle-interop', 'index.d.ts'),
    'utf8',
  );
  for (const expected of ['NodePgDatabase<TSchema>', 'NeonHttpDatabase<TSchema>', 'DrizzleConfig<TSchema>', 'DrizzleInteropConfig']) {
    if (!packedDts.includes(expected)) fail(`packed d.ts lost generic: ${expected}`);
  }
  ok('packed d.ts preserves Drizzle generics (NodePgDatabase<TSchema>, DrizzleConfig<TSchema>, ...)');

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
          skipLibCheck: false,
          noEmit: true,
          types: ['node'],
        },
        include: ['*.ts'],
      },
      null,
      2,
    ),
  );  // Compile-only file: compile-time refusals. Never executed.
  writeFileSync(
    path.join(consumerB, 'types.ts'),
    `
import { createDatabase } from 'dbsdk';
import { postgres } from 'dbsdk/postgres';
import { drizzlePostgres } from 'dbsdk/drizzle';
import { integer, pgTable, serial, text } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';

const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
  age: integer('age'),
});
const db = createDatabase({ adapter: postgres({ connectionString: 'postgres://u:p@localhost:5432/d' }) });

export async function typeLevel() {
  const d = await drizzlePostgres(db, { schema: { users } });
  const rows = await d.select().from(users);
  const check: { id: number; email: string; age: number | null }[] = rows;
  void check;
  await d.insert(users).values({ email: 'a@b.c', age: 1 });
  // @ts-expect-error wrong column name
  await d.insert(users).values({ emial: 'a@b.c' });
  // @ts-expect-error wrong value type for a text column
  await d.insert(users).values({ email: 42 });
  // @ts-expect-error DSN via \`connection\` is rejected at compile time
  await drizzlePostgres(db, { connection: 'postgres://u:p@h/db' });
  // @ts-expect-error \`client\` is rejected at compile time
  await drizzlePostgres(db, { client: {} as Pool });
  const client: Pool = d.$client;
  void client;
}
`,
  );

  // Runtime file: offline refusals + (if a server is configured) the real thing.
  writeFileSync(
    path.join(consumerB, 'main.ts'),
    `
import assert from 'node:assert/strict';
import { createDatabase, DbError } from 'dbsdk';
import { postgres } from 'dbsdk/postgres';
import { supabase } from 'dbsdk/supabase';
import { drizzlePostgres } from 'dbsdk/drizzle';
import { eq, relations } from 'drizzle-orm';
import { integer, pgSchema, pgTable, serial, text } from 'drizzle-orm/pg-core';

const SCHEMA = 'dbsdk_drizzle_smoke';
const app = pgSchema(SCHEMA);
const users = app.table('smoke_users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  age: integer('age'),
});
const posts = app.table('smoke_posts', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id),
  title: text('title').notNull(),
});
const usersRelations = relations(users, ({ many }) => ({ posts: many(posts) }));
const postsRelations = relations(posts, ({ one }) => ({
  user: one(users, { fields: [posts.userId], references: [users.id] }),
}));
const schema = { users, posts, usersRelations, postsRelations };

const URL = process.env.DBSDK_TEST_POSTGRES_URL ?? 'postgresql://postgres:dbsdk@localhost:15432/dbsdk';

async function expectConfigError(promise: Promise<unknown>, match: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof DbError, 'expected DbError, got ' + String(error));
    assert.equal(error.code, 'CONFIGURATION');
    assert.match(error.message, match);
    return;
  }
  throw new Error('expected a CONFIGURATION rejection, got success');
}

// -- offline refusals (no server needed) --------------------------------
await expectConfigError(drizzlePostgres(null as never), /createDatabase|Database/i);
console.log('   ok: non-Database input refused');

const db = createDatabase({ adapter: postgres({ connectionString: URL, max: 2 }) });
await expectConfigError(
  drizzlePostgres(db, { connection: 'postgres://u:p@h/db' } as never),
  /connection/,
);
await expectConfigError(drizzlePostgres(db, { client: {} } as never), /client/);
await expectConfigError(drizzlePostgres('postgres://u:p@h/db' as never), /createDatabase|Database/i);
console.log('   ok: DSN / connection / client configs refused before dispatch');

const txDb = createDatabase({
  adapter: supabase({ connectionString: URL, connectionMode: 'transaction', allowModeMismatch: true }),
});
assert.equal(txDb.capabilities.sessionState, false);
await expectConfigError(drizzlePostgres(txDb), /sessionState: false/);
await txDb.close(); // never opened a pool: close is a no-op
console.log('   ok: sessionState:false transaction pooler refused before pool creation');

if (!process.env.DBSDK_TEST_POSTGRES_URL) {
  console.log('   (DBSDK_TEST_POSTGRES_URL not set: real-database part skipped)');
  process.exit(0);
}

// -- real database part --------------------------------------------------
const drizzleDb = await drizzlePostgres(db, { schema });

// Everything below runs inside try/finally: the fixture schema is dropped by a
// STANDALONE pg connection that does not depend on the SDK pool (which the
// close-semantics check deliberately ends), and the original failure always
// surfaces. Only this smoke's own schema is touched.
try {
await db.query({ text: \`drop schema if exists \${SCHEMA} cascade\` });
await db.query({ text: \`create schema \${SCHEMA}\` });
await db.query({
  text:
    'create table ' + SCHEMA + '.smoke_users ' +
    '(id serial primary key, email text not null unique, age integer)',
});
await db.query({
  text:
    'create table ' + SCHEMA + '.smoke_posts ' +
    '(id serial primary key, user_id integer not null references ' + SCHEMA + '.smoke_users(id), title text not null)',
});
const inserted = await drizzleDb.insert(users).values({ email: 'ada@example.com', age: 36 }).returning({ id: users.id });
assert.equal(inserted.length, 1);
const rows = await drizzleDb.select().from(users).where(eq(users.email, 'ada@example.com'));
assert.equal(rows[0]!.age, 36);
await drizzleDb.update(users).set({ age: 37 }).where(eq(users.email, 'ada@example.com'));
assert.equal((await drizzleDb.select({ age: users.age }).from(users))[0]!.age, 37);
console.log('   ok: insert / select / update with typed results');

await drizzleDb.insert(posts).values({ userId: inserted[0]!.id, title: 'First post' });
const joined = await drizzleDb
  .select({ email: users.email, title: posts.title })
  .from(users)
  .innerJoin(posts, eq(posts.userId, users.id));
assert.deepEqual(joined, [{ email: 'ada@example.com', title: 'First post' }]);
console.log('   ok: join across two tables');

await drizzleDb.transaction(async (tx) => {
  const [grace] = await tx.insert(users).values({ email: 'grace@example.com' }).returning({ id: users.id });
  await tx.insert(posts).values({ userId: grace!.id, title: 'Grace post' });
});
const committed = await drizzleDb.select().from(users).where(eq(users.email, 'grace@example.com'));
assert.equal(committed.length, 1);

try {
  await drizzleDb.transaction(async (tx) => {
    await tx.insert(users).values({ email: 'rolledback@example.com' });
    throw new Error('intentional rollback');
  });
} catch {
  // expected: the callback failure rolls the transaction back
}
const afterRollback = await drizzleDb.select().from(users).where(eq(users.email, 'rolledback@example.com'));
assert.equal(afterRollback.length, 0);
console.log('   ok: Drizzle transaction commit + rollback');

const injection = "x'); drop table smoke_users; --";
await drizzleDb.insert(users).values({ email: injection });
const sneaky = await drizzleDb.select().from(users).where(eq(users.email, injection));
assert.equal(sneaky.length, 1);
const stillThere = await db.query<{ t: string | null }>({ text: \`select to_regclass('\${SCHEMA}.smoke_users') as t\` });
assert.match(String(stillThere.rows[0]!.t), /smoke_users/);
console.log('   ok: values are bound, never interpolated');

await db.close();
const failure: unknown = await drizzleDb.select().from(users).catch((e) => e);
assert.match(String((failure as Error)?.cause ?? failure), /Cannot use a pool after calling end/i);
console.log('   ok: after close() the Drizzle instance fails; no pool recreation');
} finally {
  let cleanupError: unknown;
  try {
    const { Client } = await import('pg');
    const cleaner = new Client({ connectionString: URL });
    try {
      await cleaner.connect();
      // Drop ONLY this smoke's own fixture schema — never other owners' schemas.
      await cleaner.query(\`drop schema if exists \${SCHEMA} cascade\`);
    } finally {
      await cleaner.end();
    }
  } catch (error) {
    cleanupError = error;
  }
  try {
    await db.close(); // idempotent; the close-semantics check may already have closed it
  } catch {
    // ignore: close is best-effort here
  }
  if (cleanupError) {
    console.error('   warning: fixture schema cleanup failed:', cleanupError);
    process.exitCode = 1; // surface the leak without masking the original failure
  }
}
`,
  );

  // skipLibCheck:false note (verified upstream, not ours): drizzle-orm 0.45.3's
  // own published d.ts does not fully typecheck under strict NodeNext with
  // skipLibCheck:false even in a bare consumer without dbsdk (~72 errors:
  // missing optional-peer type packages such as gel/mysql2, plus internal d.ts
  // errors). This consumer has ALL THREE optional peers installed, so the
  // meaningful boundary asserted here is: ZERO errors from our packed API
  // (node_modules/dbsdk) or from consumer code — every reported error must
  // live inside node_modules/drizzle-orm. A consumer that omits
  // @neondatabase/serverless sees 2 unresolved-optional-peer-type errors in
  // dbsdk's own d.ts; that configuration is verified separately as consumer C.
  // NO claim is made that skipLibCheck:false is error-free in general.
  const tscStrict = spawnSync('npx', ['tsc', '-p', '.'], { cwd: consumerB, encoding: 'utf8' });
  const strictOutput = (tscStrict.stdout + tscStrict.stderr).trim();
  const errorLines = strictOutput.split('\n').filter((line) => /^\S+\.d\.ts\(|^\S+\.ts\(/.test(line));
  const outsideDrizzle = errorLines.filter(
    (line) => !line.startsWith('node_modules/drizzle-orm/'),
  );
  if (outsideDrizzle.length > 0) {
    fail(`skipLibCheck:false reported errors outside node_modules/drizzle-orm:\n${outsideDrizzle.join('\n')}`);
  }
  ok(
    `skipLibCheck:false (all optional peers installed): 0 errors from the packed ` +
      `dbsdk API or consumer code (${errorLines.length} reported inside drizzle-orm's ` +
      'own published d.ts — upstream, reproduces in a bare drizzle-orm@0.45.3 consumer)',
  );

  // Full passing check: identical flags, library-level check enabled
  // (skipLibCheck:true), which is the setting every other dbSDK entry is
  // checked with. This must pass with no errors at all.
  const tsconfigFull = JSON.parse(readFileSync(path.join(consumerB, 'tsconfig.json'), 'utf8'));
  tsconfigFull.compilerOptions.skipLibCheck = true;
  writeFileSync(path.join(consumerB, 'tsconfig.json'), JSON.stringify(tsconfigFull, null, 2));
  const tscFull = spawnSync('npx', ['tsc', '-p', '.'], { cwd: consumerB, encoding: 'utf8' });
  if (tscFull.status !== 0) fail(`strict typecheck (skipLibCheck:true) failed:\n${tscFull.stdout}\n${tscFull.stderr}`);
  ok('strict tsc (NodeNext, exactOptionalPropertyTypes, noUncheckedIndexedAccess) passed with @ts-expect-error cases');

  const nodeB = spawnSync('node', ['main.ts'], {
    cwd: consumerB,
    encoding: 'utf8',
    env: { ...process.env },
  });
  if (nodeB.status !== 0) fail(`consumer B runtime failed:\n${nodeB.stdout}\n${nodeB.stderr}`);
  process.stdout.write(nodeB.stdout);

  // -----------------------------------------------------------------------
  // 3. Docs fences compile against the packed API
  // -----------------------------------------------------------------------
  step('docs fences compile against the packed API');
  const docsPath = path.join(workspace, 'apps', 'web', 'content', 'docs', 'drizzle.mdx');
  const docsSource = readFileSync(docsPath, 'utf8');
  // Positive fences only: negative-example fences intentionally show compile
  // errors and are marked with the "TypeScript error" comment.
  const fences = [...docsSource.matchAll(/```ts\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .filter((code) => code.includes('import ') && !code.includes('TypeScript error'));
  if (fences.length === 0) fail('no positive ts fences found in docs/drizzle.mdx');
  const docsDir = path.join(consumerB, 'docs-check');
  mkdirSync(docsDir, { recursive: true });
  fences.forEach((code, i) => writeFileSync(path.join(docsDir, `fence${i}.ts`), code));
  const docsConfig = JSON.parse(readFileSync(path.join(consumerB, 'tsconfig.json'), 'utf8'));
  docsConfig.include = ['docs-check/*.ts'];
  writeFileSync(path.join(docsDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: docsConfig.compilerOptions, include: ['*.ts'] }, null, 2));
  const tscDocs = spawnSync('npx', ['tsc', '-p', path.join('docs-check', 'tsconfig.json')], {
    cwd: consumerB,
    encoding: 'utf8',
  });
  if (tscDocs.status !== 0) fail(`docs fences failed to compile:\n${tscDocs.stdout}\n${tscDocs.stderr}`);
  ok(`${fences.length} positive docs fence(s) compile against the packed API`);

  // -----------------------------------------------------------------------
  // 3. Consumer C — skipLibCheck:false WITHOUT the neon peer (documented F2)
  // -----------------------------------------------------------------------
  step('consumer C: skipLibCheck:false without @neondatabase/serverless');
  const consumerC = path.join(root, 'consumer-no-neon');
  mkdirSync(consumerC, { recursive: true });
  writeFileSync(
    path.join(consumerC, 'package.json'),
    JSON.stringify({ name: 'consumer-c', type: 'module', private: true }, null, 2),
  );
  run(
    `npm install ${tarball} drizzle-orm@0.45.3 pg@^8.23.1 ` +
      '@types/pg@^8.23.1 @types/node@^26.6.4 typescript@^5.9.0 --no-audit --no-fund --loglevel=error',
    { cwd: consumerC },
  );
  if (existsSync(path.join(consumerC, 'node_modules', '@neondatabase', 'serverless'))) {
    fail('consumer C unexpectedly has @neondatabase/serverless; the missing-peer premise is broken');
  }
  writeFileSync(
    path.join(consumerC, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: 'ES2023',
          lib: ['ES2023', 'ESNext.Disposable'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          skipLibCheck: false,
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
    path.join(consumerC, 'types.ts'),
    "import { drizzlePostgres } from 'dbsdk/drizzle';\nexport const check = drizzlePostgres;\n",
  );
  // Documented boundary (drizzle acceptance F2): with the neon peer absent — a
  // legitimate configuration when only using dbsdk/postgres + dbsdk/drizzle —
  // skipLibCheck:false reports unresolved-optional-peer-type errors in dbsdk's
  // OWN d.ts (the packed files import @neondatabase/serverless types), exactly
  // like upstream drizzle entries do for their optional peers. This check pins
  // the boundary: such errors may appear ONLY inside node_modules/dbsdk (the
  // known 2, in dist/adapters/neon.d.ts and dist/drizzle-interop/index.d.ts),
  // and none may appear in consumer code.
  const tscC = spawnSync('npx', ['tsc', '-p', '.'], { cwd: consumerC, encoding: 'utf8' });
  const cOutput = (tscC.stdout + tscC.stderr).trim();
  const cErrorLines = cOutput.split('\n').filter((line) => /^\S+\.d\.ts\(|^\S+\.ts\(/.test(line));
  const outsideDrizzleAndDbsdk = cErrorLines.filter(
    (line) => !line.startsWith('node_modules/drizzle-orm/') && !line.startsWith('node_modules/dbsdk/'),
  );
  if (outsideDrizzleAndDbsdk.length > 0) {
    fail(
      'consumer C reported errors outside drizzle-orm/dbsdk packages ' +
        `(unexpected — expected only the documented boundary):\n${outsideDrizzleAndDbsdk.join('\n')}`,
    );
  }
  const dbsdkErrors = cErrorLines.filter((line) => line.startsWith('node_modules/dbsdk/'));
  if (dbsdkErrors.length === 0) {
    fail(
      'consumer C reported no dbsdk d.ts errors; the documented 2-error ' +
        'unresolved-@neondatabase/serverless boundary did not reproduce — re-verify the docs wording',
    );
  }
  if (dbsdkErrors.length !== 2) {
    fail(
      `consumer C reported ${dbsdkErrors.length} dbsdk d.ts errors; docs state 2. ` +
        `Actual:\n${dbsdkErrors.join('\n')}`,
    );
  }
  ok(
    `consumer C (no neon peer): skipLibCheck:false reports exactly ${dbsdkErrors.length} ` +
      'unresolved-optional-peer-type errors in dbsdk\'s own packed d.ts (documented), ' +
      `${cErrorLines.length - dbsdkErrors.length} inside drizzle-orm's own d.ts, 0 in consumer code`,
  );

  step('smoke complete');
  console.log('tarball: ' + path.basename(tarball));
  console.log('workdir kept for inspection: ' + root);
} catch (error) {
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
}
