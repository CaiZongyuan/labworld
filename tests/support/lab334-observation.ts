/** Self-contained so the identical recorder can run in the owning browser realm. */
export function lab334State(
  owner: {
    caseNonce: string;
    pageId: string;
    instanceId: string;
    role: string;
  },
  notify: (status: unknown) => void = () => {},
  now = () => Date.now(),
) {
  const rows: Record<string, unknown>[] = [];
  const identities: string[] = [];
  const renderers = new WeakMap<object, number>();
  let rendererCount = 0,
    failed = false,
    sealed: Record<string, unknown> | undefined,
    generation = 0,
    observerMs = 0;
  const status = () => ({
    valid: !failed,
    category: failed ? 'lab334_observer_failed' : null,
  });
  function invalidate() {
    const first = !failed;
    failed = true;
    if (first) {
      try {
        notify(status());
      } catch {
        /* Failed notification never reaches a target. */
      }
    }
  }
  function run<T>(operation: () => T): T | undefined {
    if (failed || sealed) return;
    const started = performance.now();
    try {
      return operation();
    } catch {
      invalidate();
    } finally {
      observerMs += performance.now() - started;
    }
  }
  function identity(value: unknown) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || value.length > 256)
      throw new Error('Unsupported identity');
    let index = identities.indexOf(value);
    if (index < 0) {
      if (identities.length >= 32) throw new Error('Identity overflow');
      index = identities.push(value) - 1;
    }
    return index;
  }
  return {
    status,
    invalidate,
    run,
    record(input: Record<string, unknown>) {
      run(() => {
        if (rows.length >= 256) throw new Error('Event overflow');
        const producer = String(input.producer),
          stage = String(input.stage);
        if (
          ![
            'loader',
            'resource',
            'appearance',
            'boundary',
            'viewport',
            'response',
            'requestfailed',
            'pageerror',
            'console',
          ].includes(producer) ||
          ![
            'download',
            'response',
            'bytes',
            'validate',
            'parse',
            'bounds',
            'complete',
            'caught',
            'resource-error',
            'appearance-failed',
            'appearance-cleared',
            'boundary',
            'viewport-failed',
            'viewport-ready',
            'request-failed',
            'page-error',
            'console-error',
          ].includes(stage)
        )
          throw new Error('Unsupported category');
        let renderer: number | null = null;
        if (input.renderer && typeof input.renderer === 'object') {
          renderer = renderers.get(input.renderer) ?? null;
          if (renderer === null) {
            if (rendererCount >= 32) throw new Error('Renderer overflow');
            renderer = ++rendererCount;
            renderers.set(input.renderer, renderer);
          }
        }
        const key =
          typeof input.key === 'string' &&
          [
            'format',
            'invalid',
            'external',
            'empty',
            'failed',
            'tooLarge',
            'denied',
            'storage',
          ].includes(input.key)
            ? input.key
            : null;
        const category =
          typeof input.category === 'string' &&
          [
            'Error',
            'TypeError',
            'RangeError',
            'SyntaxError',
            'DOMException',
            'OtherError',
          ].includes(input.category)
            ? input.category
            : null;
        const statusCode =
          Number.isInteger(input.status) &&
          Number(input.status) >= 100 &&
          Number(input.status) <= 599
            ? input.status
            : null;
        rows.push({
          at: now(),
          monoAt: performance.now(),
          producer,
          stage,
          asset: identity(input.asset),
          appearance: identity(input.appearance),
          node: identity(input.node),
          renderer,
          key,
          category,
          status: statusCode,
          aborted: typeof input.aborted === 'boolean' ? input.aborted : null,
        });
        generation++;
      });
    },
    seal(requestId: string) {
      if (sealed) return sealed;
      const requestObservedAt = now();
      sealed = {
        ...owner,
        clock: 'performance.now per realm; Date.now freshness only',
        clockTimeOriginMs: performance.timeOrigin,
        requestId,
        generation: ++generation,
        requestObservedAt,
        sealedAt: now(),
        health: status(),
        observerMs,
        rows: rows.map((row) => ({ ...row })),
        identities: [...identities],
      };
      return sealed;
    },
  };
}

export function assertLab334Seal(
  value: Record<string, unknown>,
  expected: {
    requestId: string;
    caseNonce: string;
    pageId: string;
    requestedAt: number;
    receivedAt: number;
  },
) {
  if (
    value.requestId !== expected.requestId ||
    value.caseNonce !== expected.caseNonce ||
    value.pageId !== expected.pageId ||
    typeof value.instanceId !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(value.instanceId) ||
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) < 1
  )
    throw new Error('Wrong current owner/nonce/generation');
  if (
    !Number.isSafeInteger(value.requestObservedAt) ||
    !Number.isSafeInteger(value.sealedAt) ||
    Number(value.requestObservedAt) < expected.requestedAt ||
    Number(value.sealedAt) < Number(value.requestObservedAt) ||
    Number(value.sealedAt) > expected.receivedAt
  )
    throw new Error('Stale/future seal');
  if ((value.health as { valid?: boolean })?.valid !== true)
    throw new Error('Latched invalidity');
  return value;
}

/** Exact injected bootstrap: unavailable observer construction is never a page error. */
export function lab334BootstrapSource(owner: {
  caseNonce: string;
  pageId: string;
  role: string;
}) {
  return `(() => {
    let state;
    try {
      state = (${lab334State.toString()})({...${JSON.stringify(owner)},instanceId:crypto.randomUUID()});
      const sink = row => state.record(row);
      globalThis[Symbol.for('lab-word.lab334-observer')] = sink;
      globalThis[Symbol.for('lab-word.lab334-state')] = state;
      if (globalThis[Symbol.for('lab-word.lab334-observer')] !== sink || globalThis[Symbol.for('lab-word.lab334-state')] !== state) throw new Error('Unavailable registration');
    } catch {
      try { state?.invalidate(); } catch {}
      try { globalThis[Symbol.for('lab-word.lab334-state')]?.invalidate(); } catch {}
      try { delete globalThis[Symbol.for('lab-word.lab334-observer')]; } catch {}
      try { delete globalThis[Symbol.for('lab-word.lab334-state')]; } catch {}
    }
  })()`;
}
