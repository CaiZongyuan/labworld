import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { ChildProcess } from 'node:child_process';

type Status = { valid: boolean; category: string | null };
export type ObserverOwner = {
  pid: number;
  clockTimeOriginMs: number;
  instanceId: string;
};
export type ObserverWindow = {
  event: 'motion.observer_window_sealed';
  request_id: string;
  owner: ObserverOwner;
  publicationGeneration: number;
  requestObservedEpochMs: number;
  sealedEpochMs: number;
  sealed: true;
  observerPersistence: Status;
  snapshot: Record<string, unknown> | null;
};
type Writer = {
  save: () => void;
  status: () => Status;
  generation: () => number;
  markInvalid: () => void;
};
const epoch = () => performance.timeOrigin + performance.now();
export function sealObserverWindow(
  requestId: string,
  owner: ObserverOwner,
  writer: Writer,
  snapshot: () => Record<string, unknown>,
  now = epoch,
): ObserverWindow {
  const requestObservedEpochMs = now();
  writer.save();
  let sealedSnapshot = null;
  try {
    sealedSnapshot = JSON.parse(JSON.stringify(snapshot())) as Record<
      string,
      unknown
    >;
  } catch {
    writer.markInvalid();
  }
  return Object.freeze({
    event: 'motion.observer_window_sealed' as const,
    request_id: requestId,
    owner: { ...owner },
    publicationGeneration: writer.generation(),
    requestObservedEpochMs,
    sealedEpochMs: now(),
    sealed: true as const,
    observerPersistence: writer.status(),
    snapshot: sealedSnapshot,
  });
}

export function checkObserverWindow(
  value: unknown,
  expected: {
    requestId: string;
    pid: number;
    runId: string;
    minimumGeneration: number;
    owner?: ObserverOwner;
  },
) {
  const bad = {
    confirmed: false,
    valid: false,
    category: 'observer_health_unconfirmed',
  };
  if (!value || typeof value !== 'object') return bad;
  const envelope = value as {
    request_id: string;
    boundChildPid: number;
    runId: string;
    receivedEpochMs: number;
    health: ObserverWindow;
  };
  const ack = envelope.health;
  if (
    !ack ||
    envelope.request_id !== expected.requestId ||
    envelope.boundChildPid !== expected.pid ||
    envelope.runId !== expected.runId ||
    ack.event !== 'motion.observer_window_sealed' ||
    ack.request_id !== expected.requestId ||
    ack.owner?.pid !== expected.pid ||
    !/^[0-9a-f-]{36}$/.test(ack.owner.instanceId) ||
    !Number.isFinite(ack.owner.clockTimeOriginMs) ||
    ack.sealed !== true ||
    !Number.isSafeInteger(ack.publicationGeneration) ||
    ack.publicationGeneration < 0 ||
    !Number.isFinite(ack.requestObservedEpochMs) ||
    !Number.isFinite(ack.sealedEpochMs) ||
    ack.sealedEpochMs < ack.requestObservedEpochMs ||
    ack.requestObservedEpochMs < ack.owner.clockTimeOriginMs ||
    !Number.isFinite(envelope.receivedEpochMs) ||
    (expected.owner &&
      (ack.owner.instanceId !== expected.owner.instanceId ||
        ack.owner.clockTimeOriginMs !== expected.owner.clockTimeOriginMs))
  )
    return bad;
  if (
    ack.observerPersistence?.valid === false &&
    ack.observerPersistence.category === 'observer_write_failed'
  )
    return { confirmed: true, valid: false, category: 'observer_write_failed' };
  if (
    ack.observerPersistence?.valid !== true ||
    ack.observerPersistence.category !== null ||
    ack.publicationGeneration <= expected.minimumGeneration ||
    !ack.snapshot ||
    ack.snapshot.publicationGeneration !== ack.publicationGeneration
  )
    return bad;
  return { confirmed: true, valid: true, category: null };
}

/** Exact current child IPC; unrelated fixture messages cannot satisfy the request. */
export function ownedObserverWindow(
  child: ChildProcess,
  request: {
    request_id: string;
    expected_owner_pid: number;
    key_sha256?: string;
  },
  runId: string,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const finish = (health: unknown) => {
      clearTimeout(timer);
      child.off('message', message);
      child.off('exit', exited);
      resolve({
        request_id: request.request_id,
        boundChildPid: child.pid,
        runId,
        receivedEpochMs: epoch(),
        health,
      });
    };
    const message = (value: unknown) => {
      const ack = value as Partial<ObserverWindow>;
      if (
        ack?.event === 'motion.observer_window_sealed' &&
        ack.request_id === request.request_id
      )
        finish(ack);
    };
    const exited = () => finish(null);
    child.on('message', message);
    child.once('exit', exited);
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      child.send({ action: 'observer-health-barrier', ...request }, (error) => {
        if (error) finish(null);
      });
    } catch {
      finish(null);
    }
  });
}

/** Owned file-to-supervisor channel; never an HTTP route or clock/control mutation. */
export async function requestObserverWindow(
  key: string,
  minimumGeneration: number,
  owner?: ObserverOwner,
) {
  const requestId = randomUUID();
  const control = process.env.E2E_SERVICE_CONTROL!,
    reply = process.env.E2E_SERVICE_CONTROL_REPLY!;
  const pid = Number(readFileSync(process.env.E2E_API_PID_FILE!, 'utf8'));
  const runId = process.env.CONTRACT_RUN_ID!;
  return new Promise<{
    health: unknown;
    assessment: ReturnType<typeof checkObserverWindow>;
  }>((resolve) => {
    let closed = false;
    const finish = (value: unknown) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      watcher.close();
      resolve({
        health: value,
        assessment: checkObserverWindow(value, {
          requestId,
          pid,
          runId,
          minimumGeneration,
          owner,
        }),
      });
    };
    const read = () => {
      try {
        const value = JSON.parse(readFileSync(reply, 'utf8'));
        if (value.request_id === requestId) finish(value);
      } catch {
        /* A missing owned reply stays unconfirmed. */
      }
    };
    const watcher = watch(dirname(reply), (_event, name) => {
      if (String(name) === basename(reply)) read();
    });
    const timer = setTimeout(() => finish(null), 2500);
    try {
      writeFileSync(
        control + '.next',
        JSON.stringify({
          action: 'observer-health-barrier',
          request_id: requestId,
          expected_owner_pid: pid,
          key_sha256: key,
        }),
      );
      renameSync(control + '.next', control);
      read();
    } catch {
      finish(null);
    }
  });
}
