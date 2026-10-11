// Own the animation and observers for one mounted landing page.
export function createLifecycle() {
  const cleanup = new Set();
  const frames = new Set();
  const timers = new Set();
  const intervals = new Set();
  let disposed = false;

  return {
    listen(target, type, callback, options) {
      target.addEventListener(type, callback, options);
      cleanup.add(() => target.removeEventListener(type, callback, options));
    },
    observe(observer, target) {
      observer.observe(target);
      cleanup.add(observer);
    },
    animationFrame(callback) {
      if (disposed) return;
      const id = requestAnimationFrame((time) => {
        frames.delete(id);
        callback(time);
      });
      frames.add(id);
    },
    timeout(callback, delay) {
      if (disposed) return;
      const id = setTimeout(() => {
        timers.delete(id);
        callback();
      }, delay);
      timers.add(id);
    },
    interval(callback, delay) {
      intervals.add(setInterval(callback, delay));
    },
    dispose() {
      disposed = true;
      for (const id of frames) cancelAnimationFrame(id);
      for (const id of timers) clearTimeout(id);
      for (const id of intervals) clearInterval(id);
      for (const release of cleanup) {
        if (typeof release === 'function') release();
        else release.disconnect();
      }
      frames.clear();
      timers.clear();
      intervals.clear();
      cleanup.clear();
    },
  };
}
