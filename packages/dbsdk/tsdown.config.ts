import { existsSync } from 'node:fs';
import { defineConfig } from 'tsdown';

/**
 * Build entries: the core API, the testing adapter, and the service adapters whenever their
 * source files exist (adapter sources are owned by the adapters agent and may land after core).
 */
const entry = ['src/index.ts', 'src/testing.ts'];
for (const name of ['postgres', 'supabase', 'neon']) {
  const file = `src/adapters/${name}.ts`;
  if (existsSync(file)) entry.push(file);
}

/** Management plane: core entry + fixture testing adapter + provider adapters when they land. */
entry.push('src/management/index.ts', 'src/management/testing.ts');
for (const name of ['supabase', 'neon', 'planetscale']) {
  const file = `src/management/${name}.ts`;
  if (existsSync(file)) entry.push(file);
}

/** PlanetScale Postgres adapter (dbsdk/planetscale): thin query adapter over the shared TCP engine. */
if (existsSync('src/planetscale.ts')) entry.push('src/planetscale.ts');

/** Sync plane: provider-agnostic resumable transfer + SQL adapters (dbsdk/sync). */
if (existsSync('src/sync/index.ts')) entry.push('src/sync/index.ts');

/** Optional Drizzle interop entry (dbsdk/drizzle): lazy runtime imports of drizzle-orm inside. */
if (existsSync('src/drizzle-interop/index.ts')) entry.push('src/drizzle-interop/index.ts');

export default defineConfig({
  entry,
  format: 'esm',
  dts: true,
  sourcemap: true,
  clean: true,
  platform: 'node',
  target: 'node22.12',
  // Emit `.js` / `.d.ts` to match the package.json exports map.
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
