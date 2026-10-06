/**
 * Dist smoke test — run against the BUILT package output (dist/) to prove that every public
 * subpath loads and works from the actual publishable artifact, and that the root entry stays
 * lazy (no peer driver autoload).
 *
 *   node scripts/dist-smoke.mjs
 *
 * Optional: DBSDK_TEST_POSTGRES_URL runs the real create → wait → query bridge from dist.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
const check = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then(() => results.push(['PASS', name]))
    .catch((error) => {
      results.push(['FAIL', `${name}: ${error.message}`]);
      process.exitCode = 1;
    });

const dist = (sub) => path.join(pkgRoot, 'dist', sub);

await check('root entry loads and re-exports createManagement/isManagementError', async () => {
  const root = await import(dist('index.js'));
  if (typeof root.createManagement !== 'function') throw new Error('missing createManagement');
  if (typeof root.isManagementError !== 'function') throw new Error('missing isManagementError');
  if (typeof root.describeManagementCapabilities !== 'function') throw new Error('missing describeManagementCapabilities');
});

await check('root entry stays lazy: no pg / @neondatabase/serverless autoload', async () => {
  const before = new Set(Object.keys(require.cache));
  await import(dist('index.js'));
  const loaded = Object.keys(require.cache).filter((k) => !before.has(k));
  const leaked = loaded.filter((k) => k.includes('pg') || k.includes('neondatabase'));
  if (leaked.length > 0) throw new Error(`peer autoloaded: ${leaked.join(', ')}`);
});

await check('dbsdk/management exports the full contract surface', async () => {
  const m = await import(dist('management/index.js'));
  for (const name of ['createManagement', 'describeManagementCapabilities', 'ManagementError', 'isManagementError', 'createManagementHttp', 'redactRecord', 'redactText', 'SECRET_KEYS']) {
    if (typeof m[name] !== 'function' && typeof m[name] !== 'object') throw new Error(`missing ${name}`);
  }
});

await check('dbsdk/management/testing exports createManagementFixture and it works', async () => {
  const t = await import(dist('management/testing.js'));
  const { client } = t.createManagementFixture({
    handlers: { get: async () => ({ kind: 'project', providerId: 'test', id: 'p1', name: null, region: null, status: 'active', providerStatus: null, createdAt: null, updatedAt: null, raw: {} }) },
  });
  const resource = await client.get({ kind: 'project', id: 'p1' });
  if (resource.status !== 'active') throw new Error('fixture get failed');
});

await check('dbsdk/management/neon loads and validates options without network', async () => {
  const m = await import(dist('management/neon.js'));
  const adapter = m.neonManagement({ apiKey: 'nk_test', fetch: async () => new Response('null', { status: 200 }) });
  const { createManagement } = await import(dist('management/index.js'));
  const client = createManagement({ adapter });
  if (client.providerId !== 'neon') throw new Error('bad providerId');
  // A4: endpoint compute lives on the Neon adapter, so wait() also polls endpoint
  // status alongside branch status. Update this list with the adapter, not ad hoc.
  const declared = adapter.capabilities.statusPolling;
  const expected = ['branch', 'endpoint'];
  if (
    !Array.isArray(declared) ||
    expected.some((kind) => !declared.includes(kind)) ||
    declared.length !== expected.length
  ) {
    throw new Error(`statusPolling not declared as [${expected.join(',')}]: ${JSON.stringify(declared)}`);
  }
});

await check('dbsdk/management/supabase loads and validates options without network', async () => {
  const m = await import(dist('management/supabase.js'));
  const adapter = m.supabaseManagement({ accessToken: 'sbp_test', fetch: async () => new Response('null', { status: 200 }) });
  const declared = adapter.capabilities.statusPolling;
  const expected = ['project', 'branch'];
  if (
    !Array.isArray(declared) ||
    expected.some((kind) => !declared.includes(kind)) ||
    declared.length !== expected.length
  ) {
    throw new Error(`statusPolling not declared as [${expected.join(',')}]: ${JSON.stringify(declared)}`);
  }
  if (adapter.capabilities.resourceKinds.includes('database')) throw new Error('database must not be a Supabase kind');
});

await check('dbsdk/postgres adapter subpath loads (query smoke only with a server)', async () => {
  const m = await import(dist('adapters/postgres.js'));
  if (typeof m.postgres !== 'function') throw new Error('missing postgres factory');
});

await check('dbsdk/sync exports the full contract surface', async () => {
  const s = await import(dist('sync/index.js'));
  for (const name of [
    'runTransfer',
    'createMemoryCheckpointStore',
    'createSqlSource',
    'createSqlTarget',
    'SyncError',
    'isSyncError',
  ]) {
    if (typeof s[name] !== 'function') throw new Error(`missing ${name}`);
  }
});

await check('dbsdk/sync SQL adapters validate identifiers before any query (from dist)', async () => {
  const s = await import(dist('sync/index.js'));
  const noQueries = { adapterId: 'smoke', query: async () => ({ rows: [], rowCount: 0 }) };
  try {
    s.createSqlSource({ db: noQueries, table: ['public', 'evil"]; drop'], orderBy: 'id', identity: 'smoke:src' });
    throw new Error('invalid identifier was accepted');
  } catch (error) {
    if (!s.isSyncError(error) || error.code !== 'CONFIGURATION') throw error;
  }
  const nothingRan = noQueries.query.calls === undefined;
  if (!nothingRan) throw new Error('query was dispatched despite construction failure');
});

await check('dbsdk/sync runs a full transfer from dist (memory checkpoint store)', async () => {
  const s = await import(dist('sync/index.js'));
  // A tiny fake source db: one page of two rows, then exhausted. Rows never
  // leave the process; no driver is needed. The rows carry the internal
  // cursor alias (__dbsdk_cursor_0) the source projects and strips. The
  // column-metadata catalog query (pg_attribute) runs in BOTH uniqueOrder
  // modes (it drives the exact-payload projection and the reserved-alias
  // guard), so the fake answers it too; uniqueOrder: 'assume' skips only the
  // unique-index check (example 09 and the test suite cover 'verify').
  let reads = 0;
  const sourceDb = {
    adapterId: 'smoke-src',
    query: async (statement) => {
      if (/pg_attribute/.test(statement.text)) {
        return {
          rows: [{ attname: 'id', attnotnull: true, basecategory: 'N', basetypname: 'int4', elemcategory: null, elemtypname: null }],
          rowCount: 1,
        };
      }
      reads += 1;
      return reads === 1
        ? { rows: [{ id: 1, __dbsdk_cursor_0: '1' }, { id: 2, __dbsdk_cursor_0: '2' }], rowCount: 2 }
        : { rows: [], rowCount: 0 };
    },
  };
  const inserted = [];
  const targetDb = {
    adapterId: 'smoke-dst',
    query: async (statement) => {
      // Rows arrive as bound parameters, never as SQL text.
      inserted.push(...statement.params);
      return { rows: [], rowCount: statement.params.length };
    },
  };
  const source = s.createSqlSource({
    db: sourceDb,
    table: ['public', 'events'],
    orderBy: 'id',
    identity: 'smoke:src.public.events',
    uniqueOrder: 'assume',
  });
  const target = s.createSqlTarget({ db: targetDb, table: ['public', 'events'], key: 'id', identity: 'smoke:dst.public.events' });
  const result = await s.runTransfer(source, target, { batchSize: 2 });
  if (result.status !== 'completed' || !result.exhausted) {
    throw new Error(`unexpected result: ${JSON.stringify({ status: result.status, exhausted: result.exhausted, error: result.error })}`);
  }
  if (result.rowsRead !== 2 || result.rowsWritten !== 2 || result.batches !== 1) {
    throw new Error(`unexpected counts: ${JSON.stringify(result)}`);
  }
  if (JSON.stringify(inserted) !== '[1,2]') throw new Error(`unexpected params: ${JSON.stringify(inserted)}`);
});

await check('dbsdk/sync refuses a missing identity before any dispatch (R3 contract)', async () => {
  const s = await import(dist('sync/index.js'));
  const noQueries = { adapterId: 'smoke', query: async () => ({ rows: [], rowCount: 0 }) };
  try {
    s.createSqlSource({ db: noQueries, table: ['public', 'events'], orderBy: 'id' });
    throw new Error('missing identity was accepted');
  } catch (error) {
    if (!s.isSyncError(error) || error.code !== 'CONFIGURATION') throw error;
  }
});

if (process.env.DBSDK_TEST_POSTGRES_URL) {
  await check('dist create → wait → query bridge against local PostgreSQL', async () => {
    const m = await import(dist('management/index.js'));
    const neon = await import(dist('management/neon.js'));
    const pg = await import(dist('adapters/postgres.js'));
    const { createDatabase } = await import(dist('index.js'));
    let polls = 0;
    const fetchMock = async (input, init) => {
      const url = new URL(String(input));
      const p = url.pathname.replace('/api/v2', '');
      const method = init?.method ?? 'GET';
      if (method === 'POST' && p === '/projects') {
        return Response.json({
          project: { id: 'p-dist', name: 'app', region_id: 'aws-us-east-1', created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z' },
          connection_uris: [{ connection_uri: process.env.DBSDK_TEST_POSTGRES_URL, connection_parameters: { database: 'dbsdk', password: 'dbsdk', role: 'postgres', host: 'localhost', pooler_host: 'localhost' } }],
          roles: [{ branch_id: 'b', name: 'postgres', password: 'dbsdk', created_at: 'x', updated_at: 'x' }],
          databases: [],
          operations: [{ id: 'op-1', project_id: 'p-dist', branch_id: 'b', action: 'create_timeline', status: polls > 0 ? 'finished' : 'running', failures_count: 0, created_at: 'x', updated_at: 'x', total_duration_ms: 0 }],
          branch: { id: 'b', project_id: 'p-dist', current_state: 'init' },
          endpoints: [],
        }, { status: 201 });
      }
      if (p === '/projects/p-dist/operations/op-1') {
        polls += 1;
        return Response.json({ operation: { id: 'op-1', project_id: 'p-dist', branch_id: 'b', action: 'create_timeline', status: 'finished', failures_count: 0, created_at: 'x', updated_at: 'x', total_duration_ms: 0 } });
      }
      if (p === '/projects/p-dist') return Response.json({ project: { id: 'p-dist', name: 'app' } });
      throw new Error(`unexpected ${method} ${p}`);
    };
    const management = m.createManagement({ adapter: neon.neonManagement({ apiKey: 'nk_test', fetch: fetchMock }) });
    const created = await management.create({ kind: 'project', name: 'app' });
    const connectionString = created.secrets.find((s) => s.label === 'connectionString').value;
    const project = await management.wait(created, { pollIntervalMs: 0 });
    if (project.id !== 'p-dist') throw new Error('wait failed');
    const db = createDatabase({ adapter: pg.postgres({ connectionString, ssl: false }) });
    try {
      const result = await db.sql`select 41 + 1 as answer`;
      if (result.rows[0]?.answer !== 42) throw new Error(`unexpected query result: ${JSON.stringify(result.rows)}`);
    } finally {
      await db.close();
    }
  });
} else {
  results.push(['SKIP', 'dist create → wait → query bridge (set DBSDK_TEST_POSTGRES_URL)']);
}

for (const [status, name] of results) console.log(`${status}: ${name}`);
if (process.exitCode) {
  console.error('dist smoke test FAILED');
} else {
  console.log('dist smoke test PASSED');
}
