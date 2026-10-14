// DEBUG-model-acquisition: diagnostic only, no credential/resource values leave this module.
const identities = new WeakMap<object, number>();
const resources = new Map<string, number>();
let identitySequence = 0;
let resourceSequence = 0;
let facts = 0;
export function acquisitionIdentity(value: object) {
  let id = identities.get(value);
  if (!id) identities.set(value, (id = ++identitySequence));
  return id;
}
export function acquisitionResource(key: string) {
  let id = resources.get(key);
  if (!id) resources.set(key, (id = ++resourceSequence));
  return id;
}
export function acquisitionFact(
  event:
    | 'canvas-created'
    | 'load-start'
    | 'load-cleanup'
    | 'model-ready'
    | 'scene-attached'
    | 'capability-start'
    | 'capability-ready'
    | 'bytes-start'
    | 'bytes-response'
    | 'attempt-settled'
    | 'lease-acquired'
    | 'lease-released',
  counters: Record<string, number | boolean>,
) {
  if (facts++ >= 512) return;
  console.info(
    'DEBUG-model-acquisition ' +
      JSON.stringify({
        event,
        documentEpoch: performance.timeOrigin,
        at: performance.now(),
        ...counters,
      }),
  );
}
