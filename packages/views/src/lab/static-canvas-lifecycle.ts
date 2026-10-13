// Temporary diagnostic branch only; do not merge into product delivery.
const prefix = '[static-canvas-lifecycle:v1]';
const phases = [
  'lazy-start',
  'lazy-resolve',
  'lazy-reject',
  'viewport-enter',
  'viewport-commit',
  'canvas-created',
] as const;
type Phase = (typeof phases)[number];
const emitted = new Set<string>();
let instanceSequence = 0;

export function markStaticCanvasLifecycle(phase: Phase, instance = 0) {
  try {
    if (
      typeof window === 'undefined' ||
      !phases.includes(phase) ||
      !Number.isInteger(instance) ||
      instance < 0 ||
      instance > 8 ||
      emitted.size >= 32
    )
      return;
    const key = `${instance}:${phase}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    const epoch = performance.timeOrigin;
    const browserAt = performance.now();
    if (!Number.isFinite(epoch) || !Number.isFinite(browserAt)) return;
    console.debug(
      prefix + JSON.stringify({ phase, epoch, browserAt, instance }),
    );
  } catch {
    // Observation cannot change import, render or renderer behavior.
  }
}

export function beginStaticCanvasLifecycleInstance() {
  try {
    if (typeof window === 'undefined' || instanceSequence >= 8) return -1;
    const instance = ++instanceSequence;
    markStaticCanvasLifecycle('viewport-enter', instance);
    return instance;
  } catch {
    return -1;
  }
}
