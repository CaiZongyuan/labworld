/** Observer failures must neither escape a target listener nor become valid evidence. */
export function observerWriter(publish, notify) {
  let failed = false;
  let generation = 0;
  const status = () => ({
    valid: !failed,
    category: failed ? 'observer_write_failed' : null,
  });
  function notice(event) {
    try {
      notify({ event, observerPersistence: status() });
    } catch {
      failed = true;
    }
  }
  return {
    status,
    generation: () => generation,
    markInvalid() {
      const first = !failed;
      failed = true;
      if (first) notice('motion.observer_write_failed');
    },
    save() {
      try {
        publish(status(), generation + 1);
        generation++;
      } catch {
        const first = !failed;
        failed = true;
        if (first) notice('motion.observer_write_failed');
      }
    },
    finalNotice() {
      notice('motion.observer_persistence_final');
    },
  };
}
