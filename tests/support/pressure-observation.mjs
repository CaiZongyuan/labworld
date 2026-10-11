/** Safe invalidity is latched; metric faults never become target faults. */
export function pressureObservation(
  role,
  notify = (row) => console.log(JSON.stringify(row)),
) {
  let failed = false;
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
      if (failed) return;
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
      published++;
      lastTupleWallMs = Date.now();
    },
    finalNotice() {
      notice('pressure.observer.health.final');
    },
  };
}
