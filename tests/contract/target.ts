import { readFileSync } from 'node:fs';
import { base, until } from './http';

export async function restartTarget() {
  if (process.platform !== 'linux')
    throw new Error(
      'M0 controlled process restart requires Linux; Windows adapter remains pending',
    );
  const pidFile = process.env.CONTRACT_API_PID_FILE!;
  const oldPid = Number(readFileSync(pidFile, 'utf8'));
  const ledger = JSON.parse(
    readFileSync(process.env.CONTRACT_LEDGER_PATH!, 'utf8'),
  ) as { runId: string; consumers: Array<{ pid: number; role: string }> };
  const wrapper = ledger.consumers.find(
    (consumer) => consumer.role === 'target-process-group',
  );
  if (!wrapper) throw new Error('Owned target wrapper is absent from ledger');
  const proof = readFileSync(
    process.env.CONTRACT_PROCESS_PROOF_JOURNAL!,
    'utf8',
  )
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          runId: string;
          pid: number;
          token: string;
          group: number;
          session: number;
        },
    )
    .reverse()
    .find((record) => record.pid === oldPid && record.runId === ledger.runId);
  const stat = readFileSync(`/proc/${oldPid}/stat`, 'utf8')
    .split(') ')[1]
    .split(' ');
  if (
    !proof ||
    proof.token !== stat[19] ||
    proof.group !== Number(stat[2]) ||
    proof.session !== Number(stat[3]) ||
    proof.group !== wrapper?.pid ||
    proof.session !== wrapper.pid
  )
    throw new Error(
      'Owned target process identity does not match; restart refused',
    );
  process.kill(oldPid, 'SIGKILL');
  const newPid = await until(
    async () => Number(readFileSync(pidFile, 'utf8')),
    (pid) => pid !== oldPid,
    15_000,
  );
  await until(
    async () => {
      try {
        return (
          await fetch(`${base}/health/ready`, {
            signal: AbortSignal.timeout(1000),
          })
        ).ok;
      } catch {
        return false;
      }
    },
    (ready) => ready,
    30_000,
  );
  return { oldPid, newPid };
}
