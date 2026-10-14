import type { ControlUpdateSnapshot } from '../../packages/views/src/lab/control-update-observer';

export type ComparisonObservation = {
  nodeStart: number;
  nodeEnd: number;
  browserStart: number;
  browserEnd: number;
  observation: ControlUpdateSnapshot | null;
};
export type CaptureInterval = { nodeStart: number; nodeEnd: number };

export function safeControlSnapshot(
  value: unknown,
): ControlUpdateSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const numeric = (input: unknown): input is number =>
    typeof input === 'number' &&
    Number.isFinite(input) &&
    input >= 0 &&
    input <= 1e12;
  if (
    raw.schema !== 'control-update-observer-v1' ||
    !['covered', 'unknown'].includes(String(raw.status)) ||
    !(raw.coveredFrom === null || numeric(raw.coveredFrom)) ||
    !numeric(raw.observedAt) ||
    !Array.isArray(raw.bins) ||
    raw.bins.length > 256 ||
    !Array.isArray(raw.ownership) ||
    raw.ownership.length > 32
  )
    return null;
  const fields = [
    'first',
    'last',
    'updates',
    'providerUpdates',
    'otherUpdates',
    'framingUpdates',
    'frameCallbacks',
    'gestureStarts',
    'gestureEnds',
    'returnedTrue',
    'returnedFalse',
    'returnedOther',
    'threw',
  ] as const;
  const bins: ControlUpdateSnapshot['bins'] = [];
  for (const value of raw.bins) {
    if (!value || typeof value !== 'object') return null;
    const row = value as Record<string, unknown>;
    if (fields.some((field) => !numeric(row[field]))) return null;
    bins.push(
      Object.fromEntries(
        fields.map((field) => [field, row[field]]),
      ) as ControlUpdateSnapshot['bins'][number],
    );
  }
  const ownership: ControlUpdateSnapshot['ownership'] = [];
  for (const value of raw.ownership) {
    if (!value || typeof value !== 'object') return null;
    const row = value as Record<string, unknown>;
    if (
      !numeric(row.at) ||
      !['attach', 'detach', 'lost'].includes(String(row.kind))
    )
      return null;
    ownership.push({
      at: row.at,
      kind: row.kind as 'attach' | 'detach' | 'lost',
    });
  }
  return {
    schema: 'control-update-observer-v1',
    status: raw.status as 'covered' | 'unknown',
    coveredFrom: raw.coveredFrom as number | null,
    observedAt: raw.observedAt,
    reason: ['not-attached', 'clock', 'overflow', 'ownership'].includes(
      String(raw.reason),
    )
      ? (raw.reason as ControlUpdateSnapshot['reason'])
      : null,
    ownership,
    bins,
  };
}

export function associateControlUpdates(
  before: CaptureInterval,
  after: CaptureInterval,
  comparison: ComparisonObservation | undefined,
) {
  if (!comparison)
    return { status: 'unknown', reason: 'comparison-unavailable' };
  const { nodeStart, nodeEnd, browserStart, browserEnd, observation } =
    comparison;
  const times = [
    before.nodeStart,
    before.nodeEnd,
    after.nodeStart,
    after.nodeEnd,
    nodeStart,
    nodeEnd,
    browserStart,
    browserEnd,
  ];
  if (
    times.some((value) => !Number.isFinite(value)) ||
    before.nodeEnd < before.nodeStart ||
    after.nodeEnd < after.nodeStart ||
    nodeEnd < nodeStart ||
    browserEnd < browserStart
  )
    return { status: 'unknown', reason: 'clock-inconsistent' };
  // Same-host monotonic-ms offset model, bracketed by this existing evaluation.
  // Rate/drift is not measured. This is a containing window, never exact instants.
  const offsetLow = browserEnd - nodeEnd;
  const offsetHigh = browserStart - nodeStart;
  if (offsetLow > offsetHigh)
    return { status: 'unknown', reason: 'clock-inconsistent' };
  const lower = before.nodeStart + offsetLow;
  const upper = after.nodeEnd + offsetHigh;
  const calibration = {
    offsetLow,
    offsetHigh,
    uncertaintyMs: offsetHigh - offsetLow,
    model: 'same-host monotonic-ms offset; unmeasured rate/drift',
    lower,
    upper,
  };
  if (
    !observation ||
    observation.status !== 'covered' ||
    observation.coveredFrom === null ||
    observation.coveredFrom > lower ||
    observation.observedAt < upper ||
    observation.ownership.some(
      (value) => value.at >= lower && value.at <= upper,
    )
  )
    return { status: 'unknown', reason: 'coverage-or-ownership', calibration };
  const bins = observation.bins.filter(
    (value) => value.last >= lower && value.first <= upper,
  );
  return {
    status: 'covered-under-clock-model',
    calibration,
    scope:
      'whole one-second bins intersecting a conservative containing capture window; boundary bins include extra work',
    emissionMeaning:
      'returnedTrue is provider threshold signaling, not zero-motion/pose evidence',
    bins,
  };
}
