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
