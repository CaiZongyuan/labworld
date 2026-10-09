import { withTestRustfs } from './lib/rustfs.mjs';
import { run } from './lib/process.mjs';

await withTestRustfs(async ({ env }) => {
  run(
    'cargo',
    [
      'test',
      '--locked',
      '-p',
      'labos-threejs-platform',
      '--test',
      'object_storage',
      ...process.argv.slice(2),
    ],
    {
      ...process.env,
      ...env,
      CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '4',
    },
  );
});
