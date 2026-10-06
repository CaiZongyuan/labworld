import {
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
  stat as fileStat,
} from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import {
  processIdentity,
  sameProcess,
  type ProcessIdentity,
} from '../tests/support/server-resources.ts';
if (process.platform !== 'linux')
  throw new Error('Optional codec build recovery currently supports Linux');
const path = resolve(process.argv[2] ?? '');
const ledger = JSON.parse(await readFile(path, 'utf8')) as {
  owner: string;
  runId: string;
  creator: ProcessIdentity;
  directory: string;
  processes: ProcessIdentity[];
  docker: unknown[];
  state: string;
};
if (
  ledger.owner !== 'developer_m3a validation codec build' ||
  !/^[0-9a-f-]{36}$/.test(ledger.runId) ||
  !Array.isArray(ledger.docker) ||
  ledger.docker.length ||
  !['owned', 'cleaned'].includes(ledger.state) ||
  !Array.isArray(ledger.processes) ||
  !/^lab-word-codec-[a-zA-Z0-9]+$/.test(basename(ledger.directory))
)
  throw new Error('Unrecognized codec ownership ledger');
const creator = await processIdentity(ledger.creator.pid);
if (creator && sameProcess(creator, ledger.creator))
  throw new Error('Codec creator is still active; recovery refused');
if (ledger.state === 'cleaned') {
  console.log('Codec ledger already cleaned');
  process.exit(0);
}
if ((await realpath(ledger.directory)) !== ledger.directory)
  throw new Error('Codec directory identity changed');
const marker = JSON.parse(
  await readFile(join(ledger.directory, '.codec-owner.json'), 'utf8'),
) as { runId: string; creator: ProcessIdentity };
const ownerUid = (await fileStat(join(ledger.directory, '.codec-owner.json')))
  .uid;
if (
  marker.runId !== ledger.runId ||
  !sameProcess(marker.creator, ledger.creator)
)
  throw new Error('Codec directory ownership changed');
for (const proof of ledger.processes) {
  const current = await processIdentity(proof.pid);
  if (current && !sameProcess(current, proof))
    throw new Error('Compiler incarnation changed; recovery refused');
}
async function consumers() {
  const result: ProcessIdentity[] = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = (await readFile(`/proc/${entry}/stat`, 'utf8'))
        .split(') ')[1]
        .split(' ');
      if (stat[0] === 'Z') continue;
      if ((await fileStat(`/proc/${entry}`)).uid !== ownerUid) continue;
      const knownGroup = ledger.processes.some(
        (proof) => String(proof.pid) === stat[2],
      );
      if (ledger.processes.length && !knownGroup) continue;
      if (!ledger.processes.length) {
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
const deadline = Date.now() + 5000;
let remaining = await consumers();
while (remaining.length && Date.now() < deadline) {
  for (const proof of remaining) {
    const current = await processIdentity(proof.pid);
    if (current && !sameProcess(current, proof))
      throw new Error('Compiler changed during recovery');
    if (current) process.kill(proof.pid, 'SIGKILL');
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
  remaining = await consumers();
}
if (remaining.length) throw new Error('Owned compiler consumers remain active');
await rm(ledger.directory, { recursive: true, force: true });
ledger.state = 'cleaned';
ledger.processes = [];
await writeFile(path, JSON.stringify(ledger, null, 2));
console.log('Owned compiler consumers stopped; codec directory removed');
