// Optional maintainer build. pnpm install/start use the checked-in WASM, never Cargo.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, rm, rename, mkdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { processIdentity } from '../tests/support/server-resources.ts';
if (process.platform !== 'linux')
  throw new Error(
    'The optional codec rebuild currently supports Linux; the checked-in WASM runs on Linux and Windows Node',
  );
const runId = randomUUID();
const directory = await mkdtemp(join(tmpdir(), 'lab-word-codec-'));
const evidence = resolve(
  process.env.CODEC_BUILD_EVIDENCE ?? '.scratch/m3a-codec-build',
  runId,
);
await mkdir(evidence, { recursive: true });
const creator = await processIdentity(process.pid);
const ledgerPath = join(evidence, 'owned-resources.json');
let child: ChildProcess | undefined;
let exited: Promise<number | null> | undefined;
let stopping: Promise<void> | undefined;
let interrupted = false;
const ledger = {
  owner: 'developer_m3a validation codec build',
  runId,
  directory,
  creator,
  processes: [] as unknown[],
  docker: [],
  ports: [],
  state: 'owned',
};
await writeFile(
  join(directory, '.codec-owner.json'),
  JSON.stringify({ runId, creator }),
);
async function record() {
  await writeFile(ledgerPath, JSON.stringify(ledger, null, 2));
}
await record();
function stop(): Promise<void> {
  interrupted = true;
  if (!child?.pid || child.exitCode !== null) return Promise.resolve();
  const pid = child.pid;
  stopping ??= Promise.resolve().then(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ESRCH'
      ))
        throw error;
    }
  });
  return stopping;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void stop();
  });
const flags = [
  `--remap-path-prefix=${resolve('.')}=lab-word`,
  `--remap-path-prefix=${resolve(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'registry/src')}=cargo-registry`,
];
const artifact = 'packages/server/codecs/validation/validation.wasm';
try {
  child = spawn(
    'cargo',
    [
      'build',
      '--locked',
      '--release',
      '--target',
      'wasm32-unknown-unknown',
      '--target-dir',
      directory,
      '--manifest-path',
      'packages/server/codecs/validation/Cargo.toml',
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CARGO_TARGET_DIR: directory,
        RUSTFLAGS: flags.join(' '),
        LAB_WORD_CODEC_BUILD_MARKER: runId,
      },
      detached: true,
    },
  );
  child.stdout!.on('data', (part) => process.stdout.write(part));
  child.stderr!.on('data', (part) => process.stderr.write(part));
  exited = new Promise<number | null>((resolve, reject) => {
    child!.once('error', reject);
    child!.once('exit', resolve);
  });
  exited.catch(() => {});
  await new Promise<void>((resolve, reject) => {
    child!.once('spawn', resolve);
    child!.once('error', reject);
  });
  ledger.processes = [await processIdentity(child.pid!)];
  await record();
  const code = await exited;
  if (code !== 0 || interrupted)
    throw new Error('Codec build did not complete');
  const bytes = await readFile(
    join(
      directory,
      'wasm32-unknown-unknown/release/lab_word_validation_codec.wasm',
    ),
  );
  const module = await WebAssembly.compile(bytes);
  if (WebAssembly.Module.imports(module).length)
    throw new Error('Validation codec must have no host imports');
  const previous = await readFile(artifact).catch(() => undefined);
  await writeFile(artifact + '.next', bytes);
  await rename(artifact + '.next', artifact);
  await writeFile(
    join(evidence, 'result.json'),
    JSON.stringify(
      {
        status: 'passed',
        target: 'wasm32-unknown-unknown',
        identicalToExisting: previous?.equals(bytes) ?? false,
        rustFlags: flags,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
        imports: WebAssembly.Module.imports(module),
        exports: WebAssembly.Module.exports(module),
      },
      null,
      2,
    ),
  );
} finally {
  await stop();
  await exited?.catch(() => undefined);
  await rm(artifact + '.next', { force: true });
  await rm(directory, { recursive: true, force: true });
  ledger.state = 'cleaned';
  ledger.processes = [];
  await record();
  console.log(
    JSON.stringify({ event: 'm3a.codec-build-ledger', path: ledgerPath }),
  );
}
