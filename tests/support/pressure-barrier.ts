import assert from 'node:assert/strict';

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
  assert(
    ack.requestObservedEpochMs! >= expected.requestedAt &&
      ack.sealedEpochMs! >= ack.requestObservedEpochMs!,
  );
  assert(ack.sealedEpochMs! <= Date.now() + 1000);
  assert.equal(ack.sealed, true);
  assert.equal(
    ack.observerPersistence?.valid,
    true,
    'Latched observation invalidity',
  );
  assert(ack.snapshot, 'No fresh published capture');
  return ack;
}
