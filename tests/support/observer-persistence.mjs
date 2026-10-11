/** Observer failures must neither escape a target listener nor become valid evidence. */
export function observerWriter(publish, notify) {
  let failed = false;
  const status = () => ({
    valid: !failed,
    category: failed ? 'observer_write_failed' : null,
  });
  function notice(event) {
    try {
      notify({ event, observerPersistence: status() });
    } catch {
      // A missing final marker leaves evidence unconfirmed; target cleanup continues.
    }
  }
  return {
    status,
    save() {
      try {
        publish(status());
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
