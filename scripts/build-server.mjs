import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { ServerProcess, until } from '../tests/support/server-process.ts';
import { root } from './lib/process.mjs';

const { values } = parseArgs({ options: { outDir: { type: 'string' } } });
const output = resolve(root, values.outDir ?? 'apps/server/dist');
const marker = join(output, '.lab-word-server-build.json');
if (output === root || root.startsWith(output + sep))
  throw new Error('Server build output cannot contain the source repository');
let entries = [];
try {
  entries = await readdir(output);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (entries.length) {
  const owner = JSON.parse(await readFile(marker, 'utf8'));
  if (owner.source !== root)
    throw new Error('Server build output has another owner');
}
await mkdir(output, { recursive: true });
await writeFile(
  marker,
  JSON.stringify({ source: root, complete: false }) + '\n',
);
const compiler = await new ServerProcess().create();
try {
  compiler.entry = 'node_modules/typescript/bin/tsc';
  compiler.args = ['-p', 'apps/server/tsconfig.build.json', '--outDir', output];
  await compiler.spawn();
  assertCompiler(
    await until(
      async () => compiler.child.exitCode,
      (code) => code !== null,
      60000,
    ),
  );
  await compiler.stop();
  async function copyRuntime(directory) {
    for (const entry of await readdir(join(root, directory), {
      withFileTypes: true,
    })) {
      const relative = join(directory, entry.name);
      if (entry.isDirectory()) await copyRuntime(relative);
      else if (entry.isFile() && /\.(sql|json)$/.test(entry.name)) {
        await mkdir(join(output, directory), { recursive: true });
        await cp(join(root, relative), join(output, relative));
      }
    }
  }
  await copyRuntime('packages/server/src');
  await cp(
    join(root, 'packages/server/migrations'),
    join(output, 'packages/server/migrations'),
    { recursive: true },
  );
  await cp(
    join(root, 'packages/server/codecs'),
    join(output, 'packages/server/codecs'),
    { recursive: true },
  );
  await cp(
    join(root, 'apps/server/package.json'),
    join(output, 'apps/server/package.json'),
  );
  // Compiled modules use the pinned installed dependencies in their original package scopes.
  for (const directory of ['apps/server', 'packages/server']) {
    const link = join(output, directory, 'node_modules');
    try {
      if (!(await lstat(link)).isSymbolicLink())
        throw new Error('Unexpected server dependency directory');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await symlink(
        join(root, directory, 'node_modules'),
        link,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
  }
  await writeFile(
    marker,
    JSON.stringify({ source: root, complete: true }) + '\n',
  );
  console.log(
    JSON.stringify({
      status: 'built',
      output,
      compilerLedger: join(compiler.evidence, 'owned-resources.json'),
    }),
  );
} finally {
  await compiler.cleanup();
}
function assertCompiler(code) {
  if (code !== 0) throw new Error('Server compiler failed: ' + compiler.logs);
}
