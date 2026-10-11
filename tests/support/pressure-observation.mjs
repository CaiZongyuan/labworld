import { randomUUID } from 'node:crypto';
/** Safe invalidity is latched; metric faults never become target faults. */
export function pressureObservation(
  role,
  notify = (row) => console.log(JSON.stringify(row)),
) {
  let failed = false;
  let sealedAck;
  let generation = 0;
  const instanceId = randomUUID();
  let published = 0;
  let lastTupleWallMs = null;
  const status = () => ({
    valid: !failed,
    category: failed ? 'pressure_observer_failed' : null,
    published,
    lastTupleWallMs,
  });
  function notice(event) {
    try {
      notify({ event, role, diagnosticHealth: status() });
    } catch {
      /* No valid log proof. */
    }
  }
  const invalidate = () => {
    const first = !failed;
    failed = true;
    if (first) notice('pressure.observer.invalid');
  };
  return {
    status,
    invalidate,
    observe(operation) {
      if (failed || sealedAck) return;
      try {
        return operation();
      } catch {
        invalidate();
      }
    },
    cleanup(operation) {
      try {
        return operation();
      } catch {
        invalidate();
      }
    },
    published() {
      if (sealedAck) return;
      generation++;
      published++;
      lastTupleWallMs = Date.now();
    },
    seal(request, publish) {
      if (sealedAck) return sealedAck;
      const requestObservedEpochMs = Date.now();
      generation++;
      let snapshot = null;
      try {
        snapshot = publish(generation);
      } catch {
        invalidate();
      }
      sealedAck = {
        event: 'motion.observer_window_sealed',
        request_id: request.request_id,
        owner: {
          pid: process.pid,
          clockTimeOriginMs: performance.timeOrigin,
          instanceId,
        },
        publicationGeneration: generation,
        requestObservedEpochMs,
        sealedEpochMs: Date.now(),
        observerPersistence: status(),
        sealed: true,
        snapshot,
      };
      return sealedAck;
    },
    isSealed() {
      return !!sealedAck;
    },
    finalNotice() {
      notice('pressure.observer.health.final');
    },
  };
}
