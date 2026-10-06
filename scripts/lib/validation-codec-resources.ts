import {
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
  stat,
} from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  processIdentity,
  sameProcess,
  type ProcessIdentity,
} from '../../tests/support/server-resources.ts';
export type CodecLedger = {
  owner: 'developer_m3a validation codec build';
  runId: string;
  creator: ProcessIdentity;
  directory: string;
  publicationStage: string;
  compilerGroup?: number;
  processes: ProcessIdentity[];
  docker: never[];
  state: 'planned' | 'owned' | 'cleaned';
};
export async function codecConsumers(ledger: CodecLedger) {
  const result: ProcessIdentity[] = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const fields = (await readFile(`/proc/${entry}/stat`, 'utf8'))
        .split(') ')[1]
        .split(' ');
      if (fields[0] === 'Z') continue;
      const group = Number(fields[2]);
      const knownGroup =
        group === ledger.compilerGroup ||
        ledger.processes.some((proof) => proof.pid === group);
      if (!knownGroup) {
        const args = (await readFile(`/proc/${entry}/cmdline`, 'utf8')).split(
          '\0',
        );
        if (
          !args.some(
            (argument) =>
              argument === ledger.directory ||
              argument.startsWith(ledger.directory + '/'),
          )
        )
          continue;
      }
      const env = (await readFile(`/proc/${entry}/environ`, 'utf8')).split(
        '\0',
      );
      if (!env.includes(`LAB_WORD_CODEC_BUILD_MARKER=${ledger.runId}`))
        throw new Error(
          'Possible compiler consumer marker is unknown; resources retained',
        );
      const identity = await processIdentity(Number(entry));
      if (identity) result.push(identity);
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        ['ENOENT', 'ESRCH'].includes(String(error.code))
      ))
        throw error;
    }
  }
  return result;
}
export async function stopCodecConsumers(ledger: CodecLedger) {
  const deadline = Date.now() + 5000;
  let remaining = await codecConsumers(ledger);
  while (remaining.length && Date.now() < deadline) {
    for (const proof of remaining) {
      const current = await processIdentity(proof.pid);
      if (current && !sameProcess(current, proof))
        throw new Error('Compiler changed during cleanup');
      if (current) process.kill(proof.pid, 'SIGKILL');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    remaining = await codecConsumers(ledger);
  }
  if (remaining.length)
    throw new Error('Owned compiler consumers remain active');
}
export async function recoverCodec(path: string) {
  const ledger = JSON.parse(await readFile(path, 'utf8')) as CodecLedger;
  if (
    ledger.owner !== 'developer_m3a validation codec build' ||
    !/^[0-9a-f-]{36}$/.test(ledger.runId) ||
    !Array.isArray(ledger.processes) ||
    !Array.isArray(ledger.docker) ||
    ledger.docker.length ||
    !['planned', 'owned', 'cleaned'].includes(ledger.state) ||
    !/^lab-word-codec-[a-zA-Z0-9-]+$/.test(basename(ledger.directory)) ||
    resolve(ledger.directory) !== join(tmpdir(), basename(ledger.directory))
  )
    throw new Error('Unrecognized codec ownership ledger');
  const creator = await processIdentity(ledger.creator.pid);
  if (creator && sameProcess(creator, ledger.creator))
    throw new Error('Codec creator is still active; recovery refused');
  if (ledger.state === 'cleaned') return ledger;
  for (const proof of ledger.processes) {
    const current = await processIdentity(proof.pid);
    if (current && !sameProcess(current, proof))
      throw new Error('Compiler incarnation changed; recovery refused');
  }
  const exists = await stat(ledger.directory).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
  if (exists) {
    if ((await realpath(ledger.directory)) !== ledger.directory)
      throw new Error('Codec directory identity changed');
    const marker = JSON.parse(
      await readFile(join(ledger.directory, '.codec-owner.json'), 'utf8'),
    ) as { runId: string; creator: ProcessIdentity };
    if (
      marker.runId !== ledger.runId ||
      !sameProcess(marker.creator, ledger.creator)
    )
      throw new Error('Codec directory ownership changed');
  }
  await stopCodecConsumers(ledger);
  if (ledger.publicationStage) {
    const expected = resolve(
      'packages/server/codecs/validation',
      `validation.${ledger.runId}.next`,
    );
    if (ledger.publicationStage !== expected)
      throw new Error('Codec publication staging ownership is unknown');
    await rm(expected, { force: true });
  }
  if (exists) await rm(ledger.directory, { recursive: true, force: true });
  ledger.state = 'cleaned';
  ledger.processes = [];
  await writeFile(path, JSON.stringify(ledger, null, 2));
  return ledger;
}
