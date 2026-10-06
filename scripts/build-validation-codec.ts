// Optional Linux maintainer build. pnpm install/start use the checked-in WASM.
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile, rm, rename, mkdir, readFile, open } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { processIdentity } from '../tests/support/server-resources.ts';
import {
  stopCodecConsumers,
  type CodecLedger,
} from './lib/validation-codec-resources.ts';
if (process.platform !== 'linux')
  throw new Error(
    'The optional codec rebuild supports Linux; the checked-in WASM runs on Linux and Windows Node',
  );
const runId = randomUUID(),
  directory = join(tmpdir(), `lab-word-codec-${runId}`);
const evidence = resolve(
  process.env.CODEC_BUILD_EVIDENCE ?? '.scratch/m3a-codec-build',
  runId,
);
const ledgerPath = join(evidence, 'owned-resources.json');
const artifact = resolve('packages/server/codecs/validation/validation.wasm');
const publicationStage = resolve(
  'packages/server/codecs/validation',
  `validation.${runId}.next`,
);
const flags = [
  `--remap-path-prefix=${resolve('.')}=lab-word`,
  `--remap-path-prefix=${resolve(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'registry/src')}=cargo-registry`,
];
let ledger: CodecLedger | undefined,
  child: ChildProcess | undefined,
  exited: Promise<number | null> | undefined,
  stopping: Promise<void> | undefined;
let interrupted = false,
  evidenceCreated = false,
  directoryCreated = false,
  stageCreated = false;
function assertOpen() {
  if (interrupted)
    throw new Error('Codec build cancelled; new work admission refused');
}
async function record() {
  if (ledger && evidenceCreated)
    await writeFile(ledgerPath, JSON.stringify(ledger, null, 2));
}
function stop() {
  interrupted = true;
  if (ledger) stopping ??= stopCodecConsumers(ledger);
  return stopping ?? Promise.resolve();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void stop().catch((error) => {
      console.error(String(error));
      process.exitCode = 1;
    });
  });
try {
  const creator = await processIdentity(process.pid);
  if (!creator) throw new Error('Codec creator identity unavailable');
  assertOpen();
  ledger = {
    owner: 'developer_m3a validation codec build',
    runId,
    creator,
    directory,
    publicationStage,
    processes: [],
    docker: [],
    state: 'planned',
  };
  await mkdir(evidence, { recursive: true });
  evidenceCreated = true;
  assertOpen();
  await record();
  assertOpen();
  await mkdir(directory, { mode: 0o700 });
  directoryCreated = true;
  await writeFile(
    join(directory, '.codec-owner.json'),
    JSON.stringify({ runId, creator }),
  );
  ledger.state = 'owned';
  await record();
  assertOpen();
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
  ledger.compilerGroup = child.pid;
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
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
  const proof = await processIdentity(child.pid!);
  if (proof) ledger.processes = [proof];
  await record();
  assertOpen();
  const code = await exited;
  if (code !== 0) throw new Error('Codec compiler did not complete');
  assertOpen();
  const bytes = await readFile(
    join(
      directory,
      'wasm32-unknown-unknown/release/lab_word_validation_codec.wasm',
    ),
  );
  const module = await WebAssembly.compile(bytes);
  if (WebAssembly.Module.imports(module).length)
    throw new Error('Validation codec must have no host imports');
  assertOpen();
  const previous = await readFile(artifact).catch(() => undefined);
  const staged = await open(publicationStage, 'wx', 0o600);
  stageCreated = true;
  try {
    assertOpen();
    await staged.writeFile(bytes);
    await staged.sync();
  } finally {
    await staged.close();
  }
  assertOpen();
  await rename(publicationStage, artifact);
  stageCreated = false;
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
  if (ledger) await stopCodecConsumers(ledger);
  if (stageCreated) await rm(publicationStage, { force: true });
  if (directoryCreated) await rm(directory, { recursive: true, force: true });
  if (ledger) {
    ledger.state = 'cleaned';
    ledger.processes = [];
    await record();
  }
  if (evidenceCreated)
    console.log(
      JSON.stringify({ event: 'm3a.codec-build-ledger', path: ledgerPath }),
    );
}
