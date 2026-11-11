import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);
const declarations = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json'], { cwd: directory, stdio: 'inherit' });
if (declarations.error) throw declarations.error;
if (declarations.status !== 0) throw new Error('QQ plugin declaration emission failed');

const shared = ['@omp-desktop/plugin', '@omp-desktop/plugin/*', '@omp-desktop/client', '@omp-desktop/client/*', '@omp-desktop/protocol', '@omp-desktop/protocol/*', 'react', 'react/*', 'react-native', 'zod'];
// Bundle the QQ SDK's import-only JavaScript and the connector's ESM export
// into both service formats. The connector's require target is CommonJS .js
// under a type:module package with no CommonJS scope, so it cannot be external.
// Source imports select the valid import condition regardless of output format.
// Keep npm loaders external so codecs load their own Wasm files at runtime.
const serviceExternal = [...shared, 'ws', 'silk-wasm', 'mpg123-decoder'];
for (const format of ['esm', 'cjs']) {
  const extension = format === 'esm' ? 'mjs' : 'cjs';
  await build({ absWorkingDir: directory, entryPoints: ['src/client.tsx'], outfile: `dist/client.${extension}`, bundle: true, format, platform: 'browser', target: 'es2022', jsx: 'automatic', external: shared, sourcemap: true });
  await build({ absWorkingDir: directory, entryPoints: ['src/service.ts'], outfile: `dist/service.${extension}`, bundle: true, format, platform: 'node', target: 'node22', external: serviceExternal, sourcemap: true, ...(format === 'esm' ? { banner: { js: "import { createRequire as __ompQQCreateRequire } from 'node:module'; const require = __ompQQCreateRequire(import.meta.url);" } } : {}) });
}
