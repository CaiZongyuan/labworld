import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  readFile,
  readlink,
  readdir,
  rm,
  writeFile,
  realpath,
} from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DirectoryLease } from '../../packages/server/src/platform/db/lease.ts';
export type ProcessIdentity = {
  pid: number;
  start: string;
  executable: string;
};
export type LaunchIntent = {
  title: string;
  entry: string;
  executable: string;
  pid?: number;
  state: 'planned' | 'launched';
};
export type ServerLedger = {
  owner: string;
  runId: string;
  creator: ProcessIdentity;
  directory: string;
  port: number;
  processes: ProcessIdentity[];
  launchIntent?: LaunchIntent;
  inProcessConsumers?: Array<{
    name: string;
    creator: ProcessIdentity;
    port: number;
  }>;
  docker: never[];
  state: 'owned' | 'cleaned';
};
const execute = promisify(execFile);
export async function processIdentity(
  pid: number,
): Promise<ProcessIdentity | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 1)
    throw new Error('Invalid process identity');
  if (process.platform === 'linux') {
    try {
      const stat = (await readFile(`/proc/${pid}/stat`, 'utf8'))
        .split(') ')[1]
        .split(' ');
      if (stat[0] === 'Z') return undefined;
      return {
        pid,
        start: stat[19],
        executable: await readlink(`/proc/${pid}/exe`),
      };
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code!))
        return undefined;
      throw error;
    }
  }
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if($p){ @{pid=[int]$p.ProcessId;start=$p.CreationDate.ToUniversalTime().ToString('o');executable=$p.ExecutablePath} | ConvertTo-Json -Compress }`;
    const { stdout } = await execute(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 15000, windowsHide: true },
    );
    return stdout.trim() ? (JSON.parse(stdout) as ProcessIdentity) : undefined;
  }
  throw new Error(
    'Owned process recovery currently supports Linux and Windows',
  );
}
export function sameProcess(a: ProcessIdentity, b: ProcessIdentity) {
  return (
    a.pid === b.pid && a.start === b.start && a.executable === b.executable
  );
}
function validIdentity(value: ProcessIdentity) {
  return (
    Number.isSafeInteger(value?.pid) &&
    value.pid > 0 &&
    typeof value.start === 'string' &&
    value.start.length > 0 &&
    typeof value.executable === 'string' &&
    value.executable.length > 0
  );
}
export async function markedConsumers(
  title: string,
): Promise<ProcessIdentity[]> {
  if (!/^lab-word-(?:m1|dev)-[0-9a-f-]+$/.test(title))
    throw new Error('Invalid consumer marker');
  if (process.platform === 'linux') {
    const result: ProcessIdentity[] = [];
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const args = (await readFile(`/proc/${entry}/cmdline`, 'utf8')).split(
          '\0',
        );
        if (args[0] !== title && !args.includes(`--title=${title}`)) continue;
        const identity = await processIdentity(Number(entry));
        if (identity) result.push(identity);
      } catch (error) {
        if (
          !['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code!)
        )
          throw error;
      }
    }
    return result;
  }
  const script = `$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '(^|\\s)--title=${title}(\\s|$)' } | ForEach-Object { @{pid=[int]$_.ProcessId;start=$_.CreationDate.ToUniversalTime().ToString('o');executable=$_.ExecutablePath} }) | ConvertTo-Json -Compress`;
  const { stdout } = await execute(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 15000, windowsHide: true },
  );
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout) as ProcessIdentity | ProcessIdentity[];
  return Array.isArray(parsed) ? parsed : [parsed];
}
async function markerMatches(ledger: ServerLedger) {
  const directory = resolve(ledger.directory);
  if ((await realpath(directory)) !== directory)
    throw new Error('Data-directory identity changed');
  const marker = JSON.parse(
    await readFile(join(directory, '.m1-owner.json'), 'utf8'),
  ) as { runId: string; creator: ProcessIdentity };
  if (
    marker.runId !== ledger.runId ||
    !validIdentity(marker.creator) ||
    !sameProcess(marker.creator, ledger.creator)
  )
    throw new Error('Directory owner marker does not match');
  return directory;
}
export async function removeOwnedDirectory(ledger: ServerLedger) {
  const directory = await markerMatches(ledger);
  const lease = await DirectoryLease.acquire(directory);
  try {
    await markerMatches(ledger);
    await rm(directory, { recursive: true, force: true });
  } finally {
    await lease.release();
  }
}
export async function recoverServerResources(path: string) {
  const ledger = JSON.parse(await readFile(path, 'utf8')) as ServerLedger;
  if (
    ledger.owner !== 'M1 server process harness' ||
    !/^[-0-9a-f]{36}$/.test(ledger.runId) ||
    !validIdentity(ledger.creator) ||
    !Array.isArray(ledger.processes) ||
    !ledger.processes.every(validIdentity) ||
    !Array.isArray(ledger.docker) ||
    ledger.docker.length ||
    !['owned', 'cleaned'].includes(ledger.state)
  )
    throw new Error('Unrecognized owned-resource ledger');
  if (ledger.state === 'cleaned') return ledger;
  await markerMatches(ledger); // Validate ownership before signalling any process.
  const creator = await processIdentity(ledger.creator.pid);
  if (creator && sameProcess(creator, ledger.creator))
    throw new Error('Creator is still active; recovery refused');
  const title = `lab-word-m1-${ledger.runId}`;
  const intent = ledger.launchIntent;
  if (
    intent &&
    (intent.title !== title ||
      intent.executable !== ledger.creator.executable ||
      !['planned', 'launched'].includes(intent.state) ||
      typeof intent.entry !== 'string')
  )
    throw new Error('Invalid launch intent');
  const found = await markedConsumers(title);
  if (found.some((p) => p.executable !== ledger.creator.executable))
    throw new Error('Marked consumer executable is unknown');
  for (const proof of ledger.processes) {
    const current = await processIdentity(proof.pid);
    if (
      current &&
      (!sameProcess(current, proof) ||
        !found.some((p) => sameProcess(p, current)))
    )
      throw new Error(
        'Process incarnation or run membership changed; recovery refused',
      );
  }
  if (intent?.pid) {
    const current = await processIdentity(intent.pid);
    if (current && !found.some((p) => sameProcess(p, current)))
      throw new Error('Launch identity unresolved; recovery refused');
  }
  if (intent && !intent.pid && !found.length)
    throw new Error('Planned process creation is unresolved; recovery refused');
  // A matching argv marker reconciles the recorded pre-proof launch intent.
  await stopOwnedConsumers(found);
  if ((await markedConsumers(title)).length)
    throw new Error('A marked consumer remains active');
  await removeOwnedDirectory(ledger);
  ledger.directory = '';
  ledger.processes = [];
  if (ledger.inProcessConsumers) ledger.inProcessConsumers = [];
  delete ledger.launchIntent;
  ledger.state = 'cleaned';
  await writeFile(path, JSON.stringify(ledger, null, 2));
  return ledger;
}

async function stopOwnedConsumers(found: ProcessIdentity[]) {
  for (const proof of found) {
    let current = await processIdentity(proof.pid);
    if (!current) continue;
    if (!sameProcess(current, proof))
      throw new Error('Consumer changed during reconciliation');
    process.kill(proof.pid, 'SIGTERM');
    const deadline = Date.now() + 5000;
    while (
      (current = await processIdentity(proof.pid)) &&
      sameProcess(current, proof) &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 50));
    if (current) {
      if (!sameProcess(current, proof))
        throw new Error('Consumer changed during cleanup');
      process.kill(proof.pid, 'SIGKILL');
    }
    for (let n = 0; n < 100; n++) {
      current = await processIdentity(proof.pid);
      if (!current) break;
      if (!sameProcess(current, proof))
        throw new Error('Consumer changed during cleanup');
      await new Promise((r) => setTimeout(r, 50));
    }
    if (current) throw new Error('Owned consumer did not stop');
  }
}

export type DevelopmentLedger = {
  owner: 'Lab Word development supervisor';
  creator: ProcessIdentity;
  marker: string;
  directory: string;
  dataPurpose: string;
  processes: ProcessIdentity[];
  launchIntents: Array<{
    role: string;
    pid?: number;
    state: 'planned' | 'launched';
  }>;
  docker: never[];
  state: 'running' | 'stopped';
  reconciliation?: {
    creatorStopped: boolean;
    remainingConsumers: number;
    stopped: ProcessIdentity[];
  };
};
export async function reconcileDevelopmentResources(path: string) {
  const ledger = JSON.parse(await readFile(path, 'utf8')) as DevelopmentLedger;
  if (
    ledger.owner !== 'Lab Word development supervisor' ||
    !validIdentity(ledger.creator) ||
    !/^lab-word-dev-[0-9a-f-]{36}$/.test(ledger.marker) ||
    !Array.isArray(ledger.processes) ||
    !ledger.processes.every(validIdentity) ||
    !Array.isArray(ledger.launchIntents) ||
    !ledger.launchIntents.every(
      (intent) =>
        ['server', 'web'].includes(intent.role) &&
        ['planned', 'launched'].includes(intent.state) &&
        (!intent.pid || (Number.isInteger(intent.pid) && intent.pid > 0)),
    ) ||
    !Array.isArray(ledger.docker) ||
    ledger.docker.length ||
    !['running', 'stopped'].includes(ledger.state)
  )
    throw new Error('Unrecognized development ownership ledger');
  const creator = await processIdentity(ledger.creator.pid);
  if (creator && sameProcess(creator, ledger.creator))
    throw new Error(
      'Development creator is still active; reconciliation refused',
    );
  const found = await markedConsumers(ledger.marker);
  if (found.some((proof) => proof.executable !== ledger.creator.executable))
    throw new Error('Development marked consumer executable is unknown');
  for (const proof of ledger.processes) {
    const current = await processIdentity(proof.pid);
    if (
      current &&
      (!sameProcess(current, proof) ||
        !found.some((member) => sameProcess(member, current)))
    )
      throw new Error('Development consumer incarnation or marker changed');
  }
  for (const intent of ledger.launchIntents) {
    if (!intent.pid && intent.state === 'launched')
      throw new Error('Development launch ownership is unresolved');
    if (intent.pid) {
      const current = await processIdentity(intent.pid);
      if (current && !found.some((member) => sameProcess(member, current)))
        throw new Error('Development launch marker is unresolved');
    }
  }
  await stopOwnedConsumers(found);
  const remaining = await markedConsumers(ledger.marker);
  if (remaining.length) throw new Error('Development consumers remain active');
  ledger.state = 'stopped';
  ledger.processes = [];
  ledger.reconciliation = {
    creatorStopped: true,
    remainingConsumers: 0,
    stopped: found,
  };
  // Development data is persistent; this reconciles processes and never removes it.
  await writeFile(path, JSON.stringify(ledger, null, 2));
  return ledger;
}
