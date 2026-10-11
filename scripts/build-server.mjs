import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
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
    join(root, 'tools/synthetic-motion'),
    join(output, 'tools/synthetic-motion'),
    { recursive: true, filter: (path) => !path.includes('__pycache__') },
  );
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
  // Materialize the installed runtime graph; no Windows junction is needed at runtime.
  for (const directory of ['apps/server', 'packages/server']) {
    const oldLink = join(output, directory, 'node_modules');
    try {
      if (!(await lstat(oldLink)).isSymbolicLink())
        throw new Error('Unexpected server dependency directory');
      await unlink(oldLink);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const installed = new Map();
  const runtimeDependencies = [];
  async function copyDependency(name, sourceScope, parentDestination) {
    const entry = createRequire(join(sourceScope, 'package.json')).resolve(
      name,
    );
    let source = dirname(await realpath(entry));
    let manifest;
    for (;;) {
      try {
        const candidate = JSON.parse(
          await readFile(join(source, 'package.json'), 'utf8'),
        );
        if (candidate.name === name) {
          manifest = candidate;
          break;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const parent = dirname(source);
      if (parent === source)
        throw new Error('Installed runtime package not found: ' + name);
      source = parent;
    }
    let destination = join(output, 'node_modules', name);
    if (installed.has(destination) && installed.get(destination) !== source)
      destination = join(parentDestination, 'node_modules', name);
    if (installed.get(destination) === source) return;
    if (installed.has(destination))
      throw new Error('Conflicting installed runtime package: ' + name);
    installed.set(destination, source);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: (path) => path !== join(source, 'node_modules'),
    });
    runtimeDependencies.push({
      name,
      version: manifest.version,
      path: relative(output, destination),
    });
    const dependencies = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}).filter(
        (peer) => !manifest.peerDependenciesMeta?.[peer]?.optional,
      ),
    ]);
    for (const dependency of dependencies)
      await copyDependency(dependency, source, destination);
  }
  for (const directory of ['apps/server', 'packages/server']) {
    const sourceScope = join(root, directory);
    const manifest = JSON.parse(
      await readFile(join(sourceScope, 'package.json'), 'utf8'),
    );
    for (const [name, version] of Object.entries(manifest.dependencies ?? {}))
      if (!version.startsWith('workspace:'))
        await copyDependency(name, sourceScope, join(output, directory));
  }
  await writeFile(
    marker,
    JSON.stringify({ source: root, complete: true, runtimeDependencies }) +
      '\n',
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
