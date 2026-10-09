// Pure report shaping for the load scenarios: aggregation of stack samples,
// the saturation-ladder hint, and the human-readable summary lines. No I/O
// and no process effects, so tests/tooling can import this module directly.
import { stats } from './stats.mjs';

// Samples connection-pool usage, queue depth and process RSS into summary
// statistics; raw samples stay in the report so a spike can be located in
// time (the soak report's value is exactly that timeline).
export function aggregate(samples, sampleMs) {
  const summary = {};
  for (const field of [
    'poolConnections',
    'poolActive',
    'apiRssKiB',
    'workerRssKiB',
  ])
    summary[field] = stats(
      samples.map((s) => s[field]).filter((v) => v != null),
    );
  for (const status of ['queued', 'running', 'retry_wait'])
    summary[`jobs_${status}`] = stats(
      samples.map((s) => s.jobs[status] ?? 0).filter((v) => v != null),
    );
  return { sampleMs, count: samples.length, summary, raw: samples };
}

// Report-only reading of the ladder (spec §17.2's spirit: describe, don't
// gate): the smallest step whose throughput is within 10% of the best step.
export function saturationHint(steps) {
  const rates = steps.map((step) => ({
    vus: step.vus,
    rps: step.summary.metrics?.http_reqs?.rate ?? 0,
  }));
  if (rates.length === 0)
    return {
      bestRps: 0,
      plateauFromVUs: null,
      note: 'report material, not a gate',
    };
  const best = Math.max(...rates.map((r) => r.rps));
  const hint = rates.find((r) => r.rps >= best * 0.9);
  return {
    bestRps: +best.toFixed(1),
    plateauFromVUs: hint?.vus ?? null,
    note: 'report material, not a gate',
  };
}

export function humanLine(summary) {
  const m = summary.metrics ?? {};
  const reqs = m.http_reqs?.count ?? 0;
  const rps = m.http_reqs?.rate ?? 0;
  const p95 = m.http_req_duration?.p95;
  const failed = m.checks ? (1 - (m.checks.rate ?? 1)) * 100 : null;
  return [
    `requests ${reqs}`,
    `throughput ${rps.toFixed(1)}/s`,
    `p95 ${p95 != null ? `${p95.toFixed(1)} ms` : 'n/a'}`,
    `check failures ${failed != null ? `${failed.toFixed(2)}%` : 'n/a'}`,
    `throttles ${m.expected_throttles?.count ?? 0}`,
    `business errors ${m.business_errors?.count ?? 0}`,
  ].join(' | ');
}

export function saturationLine(steps) {
  return steps
    .map((step) => {
      const m = step.summary.metrics ?? {};
      const p95 = m.http_req_duration?.p95;
      return (
        `${step.vus} VUs: ${(m.http_reqs?.rate ?? 0).toFixed(1)}/s` +
        `, p95 ${p95 != null ? `${p95.toFixed(1)} ms` : 'n/a'}` +
        `, throttles ${m.expected_throttles?.count ?? 0}` +
        `, business errors ${m.business_errors?.count ?? 0}`
      );
    })
    .join(' | ');
}
