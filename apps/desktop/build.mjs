import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
mkdirSync(dist, { recursive: true });

// The shell bundles to CommonJS: sandboxed preload scripts load through the
// limited CJS require shim, and `electron` stays external on both entries.
const shared = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  external: ['electron'],
  sourcemap: false,
  logLevel: 'warning',
};

await build({
  ...shared,
  entryPoints: [join(here, 'src/main.ts')],
  outfile: join(dist, 'main.cjs'),
});
await build({
  ...shared,
  entryPoints: [join(here, 'src/preload.ts')],
  outfile: join(dist, 'preload.cjs'),
});
copyFileSync(join(here, 'src/error.html'), join(dist, 'error.html'));
console.log('desktop shell built into dist/');
