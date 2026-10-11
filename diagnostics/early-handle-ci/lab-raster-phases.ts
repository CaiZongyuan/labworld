import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

type Phase =
  | 'canvas-acquisition'
  | 'page-screenshot'
  | 'canvas-geometry'
  | 'canvas-screenshot'
  | 'region-screenshot'
  | 'pixel-evaluate';
type Event = {
  order: number;
  phase: Phase;
  state: 'start' | 'end' | 'error';
  atMs: number;
  elapsedMs?: number;
};

// Diagnostic metadata only: no image bytes, request arguments or raw errors.
// Each record is synchronous so a predicate timeout leaves its pending phase.
export function observeRasterPhases(
  directory?: string,
  noteWrite?: (elapsedMs: number) => void,
  noteBoundary?: (
    phase: Phase,
    state: 'begin' | 'end' | 'error',
    atMs: number,
  ) => void,
) {
  const events: Event[] = [];
  const file = `spatial-raster-phases-${randomUUID()}.json`;
  let latest: Event | undefined;
  let omitted = 0;
  const started = performance.now();
  function record(event: Omit<Event, 'order' | 'atMs'>) {
    if (!directory) return;
    latest = {
      order: events.length + omitted,
      ...event,
      atMs: performance.now() - started,
    };
    if (events.length < 256) events.push(latest);
    else omitted++;
    const writeBegin = performance.now();
    try {
      writeFileSync(
        join(directory, file),
        JSON.stringify({
          events,
          latest,
          omitted,
          rawArgumentsAndErrorsSaved: false,
        }) + '\n',
        { mode: 0o600 },
      );
    } catch {
      // Optional evidence cannot replace or fail the public assertion.
    } finally {
      noteWrite?.(performance.now() - writeBegin);
    }
  }
  return async function phase<T>(name: Phase, operation: () => Promise<T>) {
    const began = performance.now();
    record({ phase: name, state: 'start' });
    noteBoundary?.(name, 'begin', performance.now());
    try {
      const result = await operation();
      noteBoundary?.(name, 'end', performance.now());
      record({
        phase: name,
        state: 'end',
        elapsedMs: performance.now() - began,
      });
      return result;
    } catch (error) {
      noteBoundary?.(name, 'error', performance.now());
      record({
        phase: name,
        state: 'error',
        elapsedMs: performance.now() - began,
      });
      throw error;
    }
  };
}
