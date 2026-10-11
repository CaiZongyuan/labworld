import assert from 'node:assert/strict';
import { writeFileSync, renameSync } from 'node:fs';

export function assertPressureSealAck(
  value: unknown,
  expected: {
    request_id: string;
    pid: number;
    afterGeneration: number;
    requestedAt: number;
  },
) {
  const ack = value as {
    event?: string;
    request_id?: string;
    owner?: { pid: number; instanceId: string };
    publicationGeneration?: number;
    requestObservedEpochMs?: number;
    sealedEpochMs?: number;
    observerPersistence?: { valid?: boolean };
    sealed?: boolean;
    snapshot?: unknown;
  };
  assert(ack && ack.event === 'motion.observer_window_sealed');
  assert.equal(
    ack.request_id,
    expected.request_id,
    'Missing/current request nonce mismatch',
  );
  assert.equal(ack.owner?.pid, expected.pid, 'Current owned PID mismatch');
  assert.match(ack.owner!.instanceId, /^[0-9a-f-]{36}$/);
  assert(
    Number.isSafeInteger(ack.publicationGeneration) &&
      ack.publicationGeneration! > expected.afterGeneration,
  );
  assert(Number.isSafeInteger(expected.requestedAt));
  assert(
    Number.isSafeInteger(ack.requestObservedEpochMs) &&
      Number.isSafeInteger(ack.sealedEpochMs),
  );
  assert(
    ack.requestObservedEpochMs! >= expected.requestedAt &&
      ack.sealedEpochMs! >= ack.requestObservedEpochMs!,
  );
  // All owners are on this host's UTC wall clock; no skew allowance is assumed.
  assert(
    ack.sealedEpochMs! <= Date.now(),
    'Future ACK is not completed evidence',
  );
  assert.equal(ack.sealed, true);
  assert.equal(
    ack.observerPersistence?.valid,
    true,
    'Latched observation invalidity',
  );
  assert(ack.snapshot, 'No fresh published capture');
  return ack;
}

/** A failed partial temporary write never changes a published request. */
export function publishPressureRequest(
  path: string,
  request: unknown,
  io = { writeFileSync, renameSync },
) {
  try {
    io.writeFileSync(path + '.next', JSON.stringify(request) + '\n', {
      mode: 0o600,
    });
    io.renameSync(path + '.next', path);
    return true;
  } catch {
    return false;
  }
}
