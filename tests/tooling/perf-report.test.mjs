import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregate,
  humanLine,
  saturationHint,
  saturationLine,
} from '../../scripts/perf/report.mjs';

// The load commands themselves are nightly/release report material, never
// CI gates (spec §17.3). What IS deterministic — the report shaping the
// commands rest on — is verified here: field names the tutorial promises,
// the saturation hint's plateau read, and the sample aggregation a soak
// report is read from.

const sample = (over = {}) => ({
  at: '2026-09-27T00:00:00Z',
  poolConnections: 4,
  poolActive: 1,
  jobs: { queued: 0, running: 1 },
  apiRssKiB: 60_000,
  workerRssKiB: 50_000,
  ...over,
});

test('aggregate summarizes pool, queue and RSS, keeping raw samples', () => {
  const result = aggregate(
    [
      sample(),
      sample({
        at: '…1',
        poolConnections: 8,
        poolActive: 6,
        apiRssKiB: 64_000,
      }),
      sample({ at: '…2', jobs: { retry_wait: 3 }, apiRssKiB: null }),
    ],
    2000,
  );
  assert.equal(result.sampleMs, 2000);
  assert.equal(result.count, 3);
  assert.deepEqual(result.summary.poolConnections, {
    min: 4,
    avg: 5.3,
    max: 8,
  });
  assert.deepEqual(result.summary.poolActive, { min: 1, avg: 2.7, max: 6 });
  assert.deepEqual(result.summary.apiRssKiB, {
    min: 60_000,
    avg: 62_000,
    max: 64_000,
  });
  // A gap (null) drops out of the stats instead of reading as zero.
  assert.deepEqual(result.summary.workerRssKiB, {
    min: 50_000,
    avg: 50_000,
    max: 50_000,
  });
  assert.deepEqual(result.summary.jobs_queued, { min: 0, avg: 0, max: 0 });
  assert.deepEqual(result.summary.jobs_retry_wait, { min: 0, avg: 1, max: 3 });
  assert.equal(result.raw.length, 3);
});

test('aggregate over no samples yields null summaries, not NaNs', () => {
  const result = aggregate([], 2000);
  assert.equal(result.count, 0);
  assert.equal(result.summary.poolConnections, null);
  assert.equal(result.summary.jobs_running, null);
});

test('saturationHint reads the plateau off a rising-then-falling curve', () => {
  const step = (vus, rate) => ({
    vus,
    summary: { metrics: { http_reqs: { rate } } },
  });
  const hint = saturationHint([
    step(1, 130),
    step(4, 330), // below 90% of best → still climbing
    step(8, 379), // best, and the smallest step within 10% of itself
    step(16, 250),
  ]);
  assert.equal(hint.bestRps, 379);
  assert.equal(hint.plateauFromVUs, 8);
  assert.equal(hint.note, 'report material, not a gate');
});

test('saturationHint on an empty ladder reports no plateau without throwing', () => {
  const hint = saturationHint([]);
  assert.equal(hint.plateauFromVUs, null);
  assert.equal(hint.bestRps, 0);
});

test('humanLine renders the steady-state fields the tutorial documents', () => {
  const line = humanLine({
    metrics: {
      http_reqs: { count: 19_729, rate: 329.42 },
      http_req_duration: { p95: 18.63 },
      checks: { rate: 1 },
      expected_throttles: { count: 0 },
      business_errors: { count: 0 },
    },
  });
  assert.match(line, /requests 19729/);
  assert.match(line, /throughput 329\.4\/s/);
  assert.match(line, /p95 18\.6 ms/);
  assert.match(line, /check failures 0\.00%/);
  assert.match(line, /throttles 0/);
  assert.match(line, /business errors 0/);
});

test('saturationLine renders one segment per ladder step', () => {
  const step = (vus, rate, p95, errors) => ({
    vus,
    summary: {
      metrics: {
        http_reqs: { rate },
        http_req_duration: { p95 },
        expected_throttles: { count: 0 },
        business_errors: { count: errors },
      },
    },
  });
  const line = saturationLine([step(1, 130, 10, 0), step(16, 250, null, 2332)]);
  assert.match(line, /^1 VUs: 130\.0\/s, p95 10\.0 ms/);
  assert.match(line, /16 VUs: 250\.0\/s, p95 n\/a/);
  assert.match(line, /business errors 2332/);
  assert.equal(line.split('|').length, 2);
});
