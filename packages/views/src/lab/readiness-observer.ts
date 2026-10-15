const phases = [
  'owner-open',
  'owner-close',
  'inputs',
  'viewport',
  'body-start',
  'body-ready',
  'validate-start',
  'validate-ready',
  'gltf-parse-start',
  'gltf-parse-ready',
  'geometry-ready',
  'commit-enqueued',
  'model-observed',
  'node-ready-enqueued',
  'discarded',
  'error',
  'cancel',
  'unknown',
] as const;
type Phase = (typeof phases)[number];
const booleans = [
  'labsPending',
  'worldPending',
  'renderBusy',
  'pending',
  'rendererPresent',
  'cancelled',
] as const;
const counts = [
  'attempt',
  'bytes',
  'nodes',
  'readyEntries',
  'failedEntries',
] as const;
export type ReadinessFact = {
  schema: 'lab-readiness-observer-v1';
  owner: number;
  sequence: number;
  atMs: number;
  phase: Phase;
  fault: 'clock' | 'overflow' | 'ownership' | null;
} & Record<(typeof booleans)[number], boolean | null> &
  Record<(typeof counts)[number], number | null>;
type Values = Partial<
  Pick<ReadinessFact, (typeof booleans)[number] | (typeof counts)[number]>
>;
const number = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1e12;

/** Strict closed projection shared by the write-only producer and passive receiver. */
export function safeReadinessFact(value: unknown): ReadinessFact | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.schema !== 'lab-readiness-observer-v1' ||
    !number(raw.owner) ||
    !Number.isSafeInteger(raw.owner) ||
    !number(raw.sequence) ||
    !Number.isSafeInteger(raw.sequence) ||
    !number(raw.atMs) ||
    typeof raw.phase !== 'string' ||
    !phases.some((phase) => phase === raw.phase) ||
    (raw.fault !== null &&
      raw.fault !== 'clock' &&
      raw.fault !== 'overflow' &&
      raw.fault !== 'ownership') ||
    booleans.some(
      (field) => raw[field] !== null && typeof raw[field] !== 'boolean',
    ) ||
    counts.some(
      (field) =>
        raw[field] !== null &&
        (!number(raw[field]) || !Number.isSafeInteger(raw[field])),
    )
  )
    return null;
  return {
    schema: 'lab-readiness-observer-v1',
    owner: raw.owner,
    sequence: raw.sequence,
    atMs: raw.atMs,
    phase: raw.phase as Phase,
    fault: raw.fault,
    ...Object.fromEntries(booleans.map((field) => [field, raw[field]])),
    ...Object.fromEntries(counts.map((field) => [field, raw[field]])),
  } as ReadinessFact;
}

let nextOwner = 0;
type Channel = (fact: ReadinessFact) => unknown;
function browserChannel(fact: ReadinessFact) {
  console.debug('LAB_READINESS_FACT:' + JSON.stringify(fact));
}

/** Measurement only: no React state, timer, request, frame, or acceptance getter. */
export class ReadinessObserver {
  private owner = ++nextOwner;
  private sequence = 0;
  private attempt = 0;
  private active = true;
  private failed = false;
  private previousAt = -Infinity;
  constructor(
    private channel: Channel = browserChannel,
    private clock = () => performance.now(),
  ) {}
  nextAttempt() {
    return ++this.attempt;
  }
  open() {
    if (this.failed) return;
    this.active = true;
    this.emit('owner-open');
  }
  close() {
    this.emit('owner-close');
    this.active = false;
  }
  emit(phase: Phase, values: Values = {}) {
    if (!this.active || this.sequence >= 64) return;
    try {
      const atMs = this.clock();
      const fault =
        !number(atMs) || atMs < this.previousAt
          ? 'clock'
          : this.sequence === 63
            ? 'overflow'
            : null;
      this.previousAt = atMs;
      const fact = safeReadinessFact({
        schema: 'lab-readiness-observer-v1',
        owner: this.owner,
        sequence: ++this.sequence,
        atMs: number(atMs) ? atMs : 0,
        phase: fault ? 'unknown' : phase,
        fault,
        ...Object.fromEntries(
          [...booleans, ...counts].map((field) => [
            field,
            values[field] ?? null,
          ]),
        ),
      });
      if (fact)
        void Promise.resolve(this.channel(fact)).catch(() => {
          this.failed = true;
          this.active = false;
        });
      if (fault) {
        this.failed = true;
        this.active = false;
      }
    } catch {
      this.failed = true;
      this.active = false;
    }
  }
}

/** Passive console callback owner; stopping returns an immutable first-boundary copy. */
export class ReadinessLedger {
  private rows: {
    receivedAtMs: number;
    generation: number;
    fact: ReadinessFact;
  }[] = [];
  private generation = 0;
  private stopped = false;
  private stoppedAtMs: number | null = null;
  private unknown = false;
  private last = new Map<
    string,
    { sequence: number; atMs: number; closed: boolean }
  >();
  private lastReceivedAt = -Infinity;
  navigate() {
    if (!this.stopped) this.generation++;
  }
  accept(value: unknown, receivedAtMs: number) {
    if (this.stopped) return;
    const fact = safeReadinessFact(value);
    if (!fact || !number(receivedAtMs) || this.rows.length >= 64) {
      this.unknown = true;
      return;
    }
    const key = `${this.generation}:${fact.owner}`;
    const previous = this.last.get(key);
    if (
      fact.fault ||
      receivedAtMs < this.lastReceivedAt ||
      (previous &&
        (fact.sequence !== previous.sequence + 1 ||
          fact.atMs < previous.atMs ||
          (previous.closed && fact.phase !== 'owner-open')))
    )
      this.unknown = true;
    this.lastReceivedAt = receivedAtMs;
    this.last.set(key, {
      sequence: fact.sequence,
      atMs: fact.atMs,
      closed: fact.phase === 'owner-close',
    });
    this.rows.push({ receivedAtMs, generation: this.generation, fact });
  }
  stop() {
    this.stoppedAtMs ??= performance.now();
    this.stopped = true;
    this.last.clear();
    return {
      status: this.unknown || !this.rows.length ? 'unknown' : 'observed',
      stoppedAtMs: this.stoppedAtMs,
      clocks:
        'fact.atMs is browser monotonic; receivedAtMs and stoppedAtMs are Node monotonic; alignment unmeasured',
      readinessVerdict: 'not-evaluated',
      cause: 'unknown',
      meaning:
        'passive original producer callbacks; absence or an enqueued phase does not establish readiness or a cause',
      rows: this.rows.map((row) => ({ ...row, fact: { ...row.fact } })),
    };
  }
}
