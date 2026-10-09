import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateSoak,
  growthNotes,
  soakLine,
} from '../../scripts/perf/desktop-report.mjs';

// The desktop soak command is nightly/release report material, never a CI
// gate (spec §17.3). What IS deterministic — the shaping of the renderer
// time series and the growth observations — is verified here, including the
// AC's controlled-growth probe: a series that deliberately climbs must
// produce a note, a flat series must not, and a short series must produce
// nothing (too little data to describe a trend).

const sample = (over = {}) => ({
  t: 0,
  rendererRssKiB: 60_000,
  heapKiB: 20_000,
  domNodes: 420,
  listeners: 130,
  ...over,
});

test('aggregateSoak summarizes renderer metrics, keeping raw samples', () => {
  const result = aggregateSoak(
    [
      sample(),
      sample({ t: 2000, rendererRssKiB: 64_000, heapKiB: null }),
      sample({ t: 4000, rendererRssKiB: null, domNodes: 480, listeners: 140 }),
    ],
    2000,
  );
  assert.equal(result.sampleMs, 2000);
  assert.equal(result.count, 3);
  assert.deepEqual(result.summary.rendererRssKiB, {
    min: 60_000,
    avg: 62_000,
    max: 64_000,
  });
  assert.deepEqual(result.summary.heapKiB, {
    min: 20_000,
    avg: 20_000,
    max: 20_000,
  });
  assert.deepEqual(result.summary.domNodes, { min: 420, avg: 440, max: 480 });
  assert.deepEqual(result.summary.listeners, {
    min: 130,
    avg: 133.3,
    max: 140,
  });
  assert.equal(result.raw.length, 3);
});

test('aggregateSoak on no samples yields null summaries, not NaN', () => {
  const result = aggregateSoak([], 2000);
  assert.equal(result.count, 0);
  assert.equal(result.summary.rendererRssKiB, null);
  assert.equal(result.summary.domNodes, null);
});

const ramp = (from, to, count, field) =>
  Array.from({ length: count }, (_, i) =>
    sample({
      t: i * 2000,
      [field]: Math.round(from + ((to - from) * i) / (count - 1)),
    }),
  );

test('growthNotes flags a controlled sustained climb', () => {
  const series = ramp(100, 300, 16, 'heapKiB').map((s) => ({
    ...s,
    domNodes: 400,
    listeners: 100,
  }));
  const notes = growthNotes(series);
  const heap = notes.find((n) => n.metric === 'heapKiB');
  assert.ok(heap, 'the climbing series must produce a heap note');
  assert.equal(heap.firstQuarterMedian, 127);
  assert.equal(heap.lastQuarterMedian, 287);
  assert.equal(heap.changePct, 126);
  assert.match(heap.note, /rerun to confirm/);
  assert.deepEqual(
    notes.filter((n) => n.metric !== 'heapKiB'),
    [],
    'flat fields must stay silent',
  );
});

test('growthNotes stays silent on a flat or short series', () => {
  assert.deepEqual(growthNotes(Array.from({ length: 16 }, () => sample())), []);
  assert.deepEqual(growthNotes([sample(), sample(), sample()]), []);
});

test('growthNotes skips fields without a positive baseline', () => {
  // A counter that starts at zero has no meaningful relative change; the
  // note must be skipped rather than divided into infinity.
  const series = Array.from({ length: 16 }, (_, i) => ({
    ...sample(),
    heapKiB: null,
    rendererRssKiB: null,
    domNodes: null,
    listeners: i < 4 ? 0 : 50,
  }));
  assert.deepEqual(growthNotes(series), []);
});

test('soakLine renders the human-readable run line', () => {
  const aggregate = aggregateSoak(
    [sample(), sample({ t: 2000, rendererRssKiB: 61_000, heapKiB: 20_500 })],
    2000,
  );
  assert.equal(
    soakLine(aggregate, []),
    'samples 2 | rendererRss 60000–61000 KiB | heap 20000–20500 KiB' +
      ' | domNodes 420–420 | listeners 130–130 | growth notes 0',
  );
  assert.equal(
    soakLine(aggregateSoak([], 2000), [{}]),
    'samples 0 | rendererRss n/a | heap n/a | domNodes n/a | listeners n/a' +
      ' | growth notes 1',
  );
});
