// Temporary diagnostic observer. Counts calls; never reads camera/target/residuals.
type Updater = { update: (...args: unknown[]) => unknown };
type Bin = {
  first: number;
  last: number;
  updates: number;
  providerUpdates: number;
  otherUpdates: number;
  framingUpdates: number;
  frameCallbacks: number;
  gestureStarts: number;
  gestureEnds: number;
  returnedTrue: number;
  returnedFalse: number;
  returnedOther: number;
  threw: number;
};
export type ControlUpdateSnapshot = {
  schema: 'control-update-observer-v1';
  status: 'covered' | 'unknown';
  coveredFrom: number | null;
  observedAt: number;
  reason: 'not-attached' | 'clock' | 'overflow' | 'ownership' | null;
  ownership: { at: number; kind: 'attach' | 'detach' | 'lost' }[];
  bins: Bin[];
};
export type ControlObservationCanvas = HTMLCanvasElement & {
  getControlUpdateObservation?: () => ControlUpdateSnapshot;
};

export class ControlUpdateObserver {
  private owner?: Updater;
  private original?: Updater['update'];
  private wrapper?: Updater['update'];
  private canvas?: ControlObservationCanvas;
  private previousReader?: ControlObservationCanvas['getControlUpdateObservation'];
  private reader = () => this.snapshot();
  private coveredFrom: number | null = null;
  private reason: ControlUpdateSnapshot['reason'] = 'not-attached';
  private ownership: ControlUpdateSnapshot['ownership'] = [];
  private bins = new Map<number, Bin>();
  private providerFrame = false;
  private framing = false;
  private lastClock = -Infinity;

  constructor(private clock = () => performance.now()) {}

  private now() {
    const at = this.clock();
    if (!Number.isFinite(at) || at < this.lastClock) {
      this.reason = 'clock';
      return null;
    }
    this.lastClock = at;
    return at;
  }
  private bin(at: number) {
    const key = Math.floor(at / 1000);
    let value = this.bins.get(key);
    if (!value) {
      if (this.bins.size >= 256) {
        this.reason = 'overflow';
        return null;
      }
      value = {
        first: at,
        last: at,
        updates: 0,
        providerUpdates: 0,
        otherUpdates: 0,
        framingUpdates: 0,
        frameCallbacks: 0,
        gestureStarts: 0,
        gestureEnds: 0,
        returnedTrue: 0,
        returnedFalse: 0,
        returnedOther: 0,
        threw: 0,
      };
      this.bins.set(key, value);
    }
    value.last = at;
    return value;
  }
  private change(kind: 'attach' | 'detach' | 'lost', at: number) {
    if (this.ownership.length < 32) this.ownership.push({ kind, at });
    else this.reason = 'overflow';
  }
  private owned() {
    if (
      !this.owner ||
      this.owner.update !== this.wrapper ||
      (this.canvas && this.canvas.getControlUpdateObservation !== this.reader)
    ) {
      if (this.owner) {
        const at = this.now();
        if (at !== null) this.change('lost', at);
        this.reason = 'ownership';
      }
      return false;
    }
    return true;
  }
  bind(owner: Updater | null, canvas: ControlObservationCanvas) {
    try {
      if (owner === this.owner && this.owned() && canvas === this.canvas)
        return;
      this.detach();
      if (!owner) return;
      if (canvas.getControlUpdateObservation) {
        this.reason = 'ownership';
        return;
      }
      const at = this.now();
      if (at === null) return;
      this.owner = owner;
      this.original = owner.update;
      const original = owner.update;
      const countUpdate = () => {
        try {
          const started = this.now();
          if (this.owner !== owner) this.reason = 'ownership';
          if (started !== null && this.owner === owner && this.owned()) {
            const bin = this.bin(started);
            if (bin) {
              bin.updates++;
              if (this.framing) bin.framingUpdates++;
              else if (this.providerFrame) bin.providerUpdates++;
              else bin.otherUpdates++;
            }
            return bin;
          }
        } catch {
          this.reason = 'clock';
        }
        return null;
      };
      this.wrapper = function (this: unknown, ...args: unknown[]) {
        const bin = countUpdate();
        try {
          const result = Reflect.apply(original, this, args);
          if (bin) {
            if (result === true) bin.returnedTrue++;
            else if (result === false) bin.returnedFalse++;
            else bin.returnedOther++;
          }
          return result;
        } catch (cause) {
          if (bin) bin.threw++;
          throw cause;
        }
      };
      owner.update = this.wrapper;
      this.canvas = canvas;
      this.previousReader = canvas.getControlUpdateObservation;
      canvas.getControlUpdateObservation = this.reader;
      this.coveredFrom = at;
      this.reason = null;
      this.change('attach', at);
    } catch {
      this.reason = 'ownership';
    }
  }
  detach() {
    try {
      if (this.owner) {
        const at = this.now();
        if (at !== null) this.change('detach', at);
        if (this.owner.update === this.wrapper && this.original)
          this.owner.update = this.original;
        else this.reason = 'ownership';
      }
      if (this.canvas?.getControlUpdateObservation === this.reader) {
        if (this.previousReader)
          this.canvas.getControlUpdateObservation = this.previousReader;
        else delete this.canvas.getControlUpdateObservation;
      }
    } catch {
      this.reason = 'ownership';
    }
    this.owner = undefined;
    this.canvas = undefined;
    this.coveredFrom = null;
    this.providerFrame = false;
  }
  frame(begin: boolean) {
    try {
      this.providerFrame = begin;
      if (!begin || !this.owned()) return;
      const at = this.now();
      if (at !== null) {
        const bin = this.bin(at);
        if (bin) bin.frameCallbacks++;
      }
    } catch {
      this.reason = 'clock';
    }
  }
  gesture(start: boolean, owner: unknown) {
    try {
      if (owner !== this.owner) {
        this.reason = 'ownership';
        return;
      }
      if (!this.owned()) return;
      const at = this.now();
      if (at !== null) {
        const bin = this.bin(at);
        if (bin) {
          if (start) bin.gestureStarts++;
          else bin.gestureEnds++;
        }
      }
    } catch {
      this.reason = 'clock';
    }
  }
  framingUpdate<T>(run: () => T): T {
    const previous = this.framing;
    this.framing = true;
    try {
      return run();
    } finally {
      this.framing = previous;
    }
  }
  snapshot(): ControlUpdateSnapshot {
    const at = this.now();
    const owned = this.owned();
    return {
      schema: 'control-update-observer-v1',
      status:
        owned && at !== null && this.reason === null ? 'covered' : 'unknown',
      coveredFrom: this.coveredFrom,
      observedAt: at ?? 0,
      reason: this.reason,
      ownership: this.ownership.map((value) => ({ ...value })),
      bins: [...this.bins.values()].map((value) => ({ ...value })),
    };
  }
}
