import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { publicFailure } from '../../scripts/safe-browser-reporter.mjs';

type Phase = 'lab' | 'bench' | 'beaker';
type Record = { [key: string]: unknown };
const capacity = 256;
function ring() {
  const records: Record[] = [];
  let omitted = 0;
  return {
    add(record: Record) {
      if (records.length === capacity) {
        records.shift();
        omitted++;
      }
      records.push(record);
    },
    read: () => ({ records, omitted }),
  };
}

function armBrowserObserver() {
  const cap = 256;
  const documentId = performance.timeOrigin;
  const records: { [key: string]: unknown }[] = [];
  let omitted = 0,
    stopped = false,
    lastTimer = performance.now(),
    lastFrame = lastTimer,
    lastFrameSample = lastTimer,
    maxFrameGap = 0,
    frames = 0,
    signature = '';
  const aggregate = {
    timerTicks: 0,
    maxTimerGapMs: 0,
    timerGapScope: 'all visibility states; transition intervals excluded',
    rafFrames: 0,
    maxVisibleFrameGapMs: 0,
  };
  let previousHidden = document.hidden;
  let crossesVisibility = true;
  let crossesTimerVisibility = true;
  function add(record: { [key: string]: unknown }) {
    if (records.length === cap) {
      records.shift();
      omitted++;
    }
    records.push({ ...record, atMs: performance.now(), documentId });
  }
  function acknowledge(record: { [key: string]: unknown }) {
    add(record);
    // Only the fixed event/state record crosses this binding; input data is never read.
    void (
      window as unknown as { __pm67PrefixAck: (v: unknown) => Promise<number> }
    )
      .__pm67PrefixAck({ ...record, atMs: performance.now(), documentId })
      .catch(() => {});
  }
  function button(surface: Element | null) {
    const text = surface?.closest('button')?.textContent?.trim();
    return text === '创建账号'
      ? 'register.submit'
      : text === '创建 Lab'
        ? 'lab.open'
        : text === '选择 Camera Sensor A'
          ? 'sensor-a.select'
          : text === '聚焦模型'
            ? 'camera.focus'
            : text === '创建'
              ? 'lab.submit'
              : text === '登记对象'
                ? 'object.open'
                : text === '登记'
                  ? 'object.submit'
                  : 'unknown';
  }
  function surface(target: EventTarget | null) {
    if (!(target instanceof Element)) return 'unknown';
    if (target.matches('input[type="email"]')) return 'register.email';
    if (target.matches('input[type="password"]')) return 'register.password';
    if (target.closest('[role="dialog"]') && target.matches('select'))
      return 'object.definition';
    if (target.closest('[role="dialog"]') && target.matches('input'))
      return 'dialog.name';
    return button(target);
  }
  function state() {
    const buttons = Array.from(document.querySelectorAll('button'));
    const registration = buttons.find(
      (value) => button(value) === 'object.open',
    );
    const headings = Array.from(
      document.querySelectorAll('[role="heading"],h1,h2,h3'),
    );
    const busy = document
      .querySelector('.world-page')
      ?.getAttribute('aria-busy');
    const value = {
      kind: 'dom-state',
      registrationPresent: !!registration,
      registrationDisabled: registration?.disabled ?? null,
      dialogCount: document.querySelectorAll('[role="dialog"]').length,
      sensorAHeading: headings.some(
        (h) => h.textContent?.trim() === 'Camera Sensor A',
      ),
      sensorBHeading: headings.some(
        (h) => h.textContent?.trim() === 'Camera Sensor B',
      ),
      landmarkHeading: headings.some(
        (h) => h.textContent?.trim() === 'Asymmetric camera landmark',
      ),
      busy: busy === 'true' ? true : busy === 'false' ? false : null,
      canvasCount: document.querySelectorAll('canvas').length,
    };
    const next = JSON.stringify(value);
    if (next !== signature) {
      signature = next;
      acknowledge(value);
    }
  }
  const eventNames = [
    'pointerdown',
    'pointerup',
    'click',
    'input',
    'change',
  ] as const;
  const listeners: {
    name: (typeof eventNames)[number];
    listener: EventListener;
    capture: boolean;
  }[] = [];
  for (const name of eventNames) {
    const listener: EventListener = (event) => {
      acknowledge({
        kind: 'event',
        event: name,
        stage: 'capture',
        surface: surface(event.target),
        trusted: event.isTrusted,
      });
      state();
    };
    document.addEventListener(name, listener, { capture: true, passive: true });
    listeners.push({ name, listener, capture: true });
  }
  const afterClick: EventListener = (event) => {
    acknowledge({
      kind: 'event',
      event: 'click',
      stage: 'document-bubble',
      surface: surface(event.target),
      trusted: event.isTrusted,
    });
    state();
  };
  document.addEventListener('click', afterClick, { passive: true });
  listeners.push({ name: 'click', listener: afterClick, capture: false });
  const lifecycle = () => {
    const at = performance.now();
    acknowledge({
      kind: 'lifecycle',
      hidden: document.hidden,
      previousHidden,
      intervalMs: Math.max(0, at - lastFrame),
      excludedFromVisible: true,
    });
    previousHidden = document.hidden;
    crossesVisibility = true;
    crossesTimerVisibility = true;
    lastTimer = at;
    lastFrame = at;
    lastFrameSample = at;
    maxFrameGap = 0;
    frames = 0;
  };
  document.addEventListener('visibilitychange', lifecycle, { passive: true });
  window.addEventListener('pagehide', lifecycle, { passive: true });
  window.addEventListener('pageshow', lifecycle, { passive: true });
  const mutation = new MutationObserver(state);
  mutation.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled', 'aria-busy'],
  });
  const timer = setInterval(() => {
    const at = performance.now();
    if (crossesTimerVisibility) {
      add({
        kind: 'timer-visibility-boundary',
        hidden: document.hidden,
        excludedFromVisible: true,
      });
      crossesTimerVisibility = false;
      lastTimer = at;
      return;
    }
    add({ kind: 'timer', gapMs: at - lastTimer, hidden: document.hidden });
    aggregate.timerTicks++;
    aggregate.maxTimerGapMs = Math.max(aggregate.maxTimerGapMs, at - lastTimer);
    lastTimer = at;
  }, 100);
  let animation = 0;
  function frame(at: number) {
    if (stopped) return;
    if (crossesVisibility) {
      add({
        kind: 'raf-visibility-boundary',
        hidden: document.hidden,
        excludedFromVisible: true,
      });
      crossesVisibility = false;
      lastFrame = at;
      lastFrameSample = at;
      animation = requestAnimationFrame(frame);
      return;
    }
    maxFrameGap = Math.max(maxFrameGap, at - lastFrame);
    aggregate.rafFrames++;
    if (!document.hidden)
      aggregate.maxVisibleFrameGapMs = Math.max(
        aggregate.maxVisibleFrameGapMs,
        at - lastFrame,
      );
    lastFrame = at;
    frames++;
    if (at - lastFrameSample >= 100) {
      add({
        kind: 'raf',
        gapMs: at - lastFrameSample,
        maxFrameGapMs: maxFrameGap,
        frames,
        hidden: document.hidden,
      });
      lastFrameSample = at;
      maxFrameGap = 0;
      frames = 0;
    }
    animation = requestAnimationFrame(frame);
  }
  animation = requestAnimationFrame(frame);
  acknowledge({ kind: 'document', hidden: document.hidden });
  let rasterIdentity: { [key: string]: unknown } = {};
  (window as unknown as { __pm67PrefixState: unknown }).__pm67PrefixState = {
    rasterMark: (record: { [key: string]: unknown }) => {
      const safe: { [key: string]: unknown } = {};
      for (const key of [
        'captureOrdinal',
        'callbackOrdinal',
        'elapsedMs',
        'changedPixels',
      ])
        if (typeof record[key] === 'number' && Number.isFinite(record[key]))
          safe[key] = record[key];
      for (const [key, values] of Object.entries({
        kind: ['geometry', 'pixel'],
        stage: ['entry', 'end', 'error', 'decodes-complete', 'count-complete'],
        predicate: ['before-focus', 'explicit-focus', 'settled'],
      }))
        if (values.includes(String(record[key]))) safe[key] = record[key];
      if (safe.kind === 'geometry' && safe.stage === 'entry')
        rasterIdentity = {
          captureOrdinal: safe.captureOrdinal,
          callbackOrdinal: safe.callbackOrdinal,
          predicate: safe.predicate,
        };
      add({ ...rasterIdentity, ...safe });
    },
    clock: () => ({
      documentId,
      atMs: performance.now(),
      hidden: document.hidden,
    }),
    drain: () => {
      stopped = true;
      clearInterval(timer);
      cancelAnimationFrame(animation);
      mutation.disconnect();
      for (const { name, listener, capture } of listeners)
        document.removeEventListener(name, listener, capture);
      return {
        documentId,
        atMs: performance.now(),
        hidden: document.hidden,
        records,
        omitted,
        aggregate,
      };
    },
  };
}

async function bounded<T>(
  operation: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Optional observer deadline')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function cameraObserver(page: Page) {
  const steps = ring(),
    nodeTimer = ring(),
    acknowledgements = ring(),
    raster = ring();
  let current: string[] = [],
    sequence = 0,
    firstFailure: Record | null = null,
    lastTimer = performance.now(),
    finished = false,
    nodeTicks = 0,
    maxNodeGapMs = 0;
  const optionalFailures: string[] = [],
    clocks: Record[] = [],
    responseStates = new Map<string, string>();
  const timer = setInterval(() => {
    const at = performance.now();
    nodeTimer.add({ atMs: at, gapMs: at - lastTimer });
    nodeTicks++;
    maxNodeGapMs = Math.max(maxNodeGapMs, at - lastTimer);
    lastTimer = at;
  }, 100);
  function record(label: string, state: string, originalLine?: number) {
    const value = {
      sequence: sequence++,
      label,
      state,
      originalLine: originalLine ?? null,
      atMs: performance.now(),
    };
    steps.add(value);
    return value;
  }
  async function setup() {
    try {
      await bounded(
        page.exposeBinding('__pm67PrefixAck', (_, value) => {
          // Reconstruct only a fixed metadata allowlist, even if another script calls the binding.
          if (!value || typeof value !== 'object') return performance.now();
          const output: Record = { nodeAtMs: performance.now() };
          for (const key of [
            'atMs',
            'documentId',
            'dialogCount',
            'canvasCount',
            'intervalMs',
          ])
            if (typeof value[key] === 'number' && Number.isFinite(value[key]))
              output[key] = value[key];
          for (const key of [
            'trusted',
            'hidden',
            'registrationPresent',
            'registrationDisabled',
            'sensorAHeading',
            'sensorBHeading',
            'landmarkHeading',
            'busy',
            'previousHidden',
            'excludedFromVisible',
          ])
            if (typeof value[key] === 'boolean' || value[key] === null)
              output[key] = value[key];
          const enums: { [key: string]: string[] } = {
            kind: ['event', 'dom-state', 'lifecycle', 'document'],
            event: ['pointerdown', 'pointerup', 'click', 'input', 'change'],
            stage: ['capture', 'document-bubble'],
            surface: [
              'register.submit',
              'register.email',
              'register.password',
              'lab.open',
              'lab.submit',
              'sensor-a.select',
              'camera.focus',
              'object.open',
              'object.submit',
              'object.definition',
              'dialog.name',
              'unknown',
            ],
          };
          for (const [key, values] of Object.entries(enums))
            if (values.includes(value[key])) output[key] = value[key];
          acknowledgements.add(output);
          return performance.now();
        }),
        1000,
      );
      await bounded(page.addInitScript(armBrowserObserver), 1000);
    } catch {
      optionalFailures.push('browser-prearm-unavailable');
    }
  }
  async function clock() {
    const begin = performance.now();
    try {
      const value = await bounded(
        page.evaluate(
          () =>
            (
              window as unknown as {
                __pm67PrefixState?: {
                  clock: () => {
                    documentId: number;
                    atMs: number;
                    hidden: boolean;
                  };
                };
              }
            ).__pm67PrefixState?.clock() ?? null,
        ),
        1000,
      );
      clocks.push({
        nodeBeginMs: begin,
        nodeEndMs: performance.now(),
        browser: value,
        uncertainty: 'round-trip bracket; raw clocks never subtracted',
      });
    } catch {
      optionalFailures.push('pre-native-clock-unavailable');
    }
  }
  async function operation<T>(
    label: string,
    line: number,
    action: () => Promise<T>,
  ) {
    record(label, 'start', line);
    current.push(label);
    try {
      const result = await action();
      record(label, 'end', line);
      return result;
    } catch (error) {
      const entry = record(label, 'error', line);
      firstFailure ??= {
        ...entry,
        failure: publicFailure(error),
        active: [...current],
      };
      throw error;
    } finally {
      current.pop();
    }
  }
  function sync(label: string, line: number, action: () => void) {
    record(label, 'start', line);
    try {
      action();
      record(label, 'end', line);
    } catch (error) {
      firstFailure ??= {
        ...record(label, 'error', line),
        failure: publicFailure(error),
        active: [...current, label],
      };
      throw error;
    }
  }
  function response<T>(phase: Phase, line: number, promise: Promise<T>) {
    record(`${phase}.response.arm`, 'armed', line);
    responseStates.set(phase, 'armed');
    void promise.then(
      () => {
        responseStates.set(phase, 'settled');
        record(`${phase}.response.arm`, 'settled');
      },
      () => {
        responseStates.set(phase, 'rejected');
        record(`${phase}.response.arm`, 'rejected');
      },
    );
    return promise;
  }
  async function finish(verdict: 'error' | 'settled-poll') {
    if (finished) return;
    finished = true;
    const drainBegin = performance.now();
    let browser: unknown = null;
    try {
      browser = await bounded(
        page.evaluate(
          () =>
            (
              window as unknown as {
                __pm67PrefixState?: { drain: () => unknown };
              }
            ).__pm67PrefixState?.drain() ?? null,
        ),
        1000,
      );
      clocks.push({
        nodeBeginMs: drainBegin,
        nodeEndMs: performance.now(),
        terminalBrowserAt:
          browser && typeof browser === 'object'
            ? (browser as Record).atMs
            : null,
        terminalDocument:
          browser && typeof browser === 'object'
            ? (browser as Record).documentId
            : null,
      });
    } catch {
      optionalFailures.push('terminal-browser-drain-unavailable');
    }
    const beforeDocument = (clocks[0]?.browser as Record | null)?.documentId;
    const afterDocument =
      browser && typeof browser === 'object'
        ? (browser as Record).documentId
        : null;
    const documentValidity = {
      beforeDocument: beforeDocument ?? null,
      afterDocument,
      matches:
        typeof beforeDocument === 'number' && typeof afterDocument === 'number'
          ? beforeDocument === afterDocument
          : null,
      currentPageTargetOnly: true,
    };
    clearInterval(timer);
    try {
      writeFileSync(
        join(
          process.env.LAB_NODE_EVIDENCE ?? 'test-results',
          'camera-prefix-observation.json',
        ),
        JSON.stringify({
          verdict,
          firstFailure,
          incomplete: current,
          responseStates: Object.fromEntries(responseStates),
          steps: steps.read(),
          nodeTimer: {
            ...nodeTimer.read(),
            ticks: nodeTicks,
            maxGapMs: maxNodeGapMs,
          },
          acknowledgements: acknowledgements.read(),
          clocks,
          browser,
          documentValidity,
          cpuProfiling: 'omitted for CI boundary discriminator',
          optionalFailures,
          browserCapacity: capacity,
          timerIntervalMs: 100,
          raster: raster.read(),
          rawErrorsInputsBodiesAndSourceSaved: false,
          note: 'Capture/bubble show propagation only; dialog state shows public commit. No React handler completion is inferred. Instrumented green is calibration.',
        }) + '\n',
        { mode: 0o600 },
      );
    } catch {
      /* Optional persistence cannot replace the original verdict. */
    }
  }
  let callbackOrdinal = 0;
  let predicate = 'before-focus';
  let captureOrdinal = 0;
  function beginCallback(next: string) {
    predicate = next;
    callbackOrdinal++;
    rasterNote('predicate-entry');
  }
  function rasterNote(stage: string, extra: Record = {}) {
    if (typeof extra.captureOrdinal === 'number')
      captureOrdinal = extra.captureOrdinal;
    raster.add({
      captureOrdinal,
      stage,
      predicate,
      callbackOrdinal,
      atMs: performance.now(),
      ...extra,
    });
  }
  function rasterIdentity(captureOrdinal: number) {
    return { captureOrdinal, callbackOrdinal, predicate };
  }
  function measureWrite<T>(kind: string, action: () => T) {
    const begin = performance.now();
    try {
      return action();
    } finally {
      rasterNote('evidence-write', {
        kind,
        elapsedMs: performance.now() - begin,
      });
    }
  }
  return {
    setup,
    clock,
    operation,
    sync,
    response,
    finish,
    beginCallback,
    rasterNote,
    rasterIdentity,
    measureWrite,
  };
}
