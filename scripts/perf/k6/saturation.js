import {
  getDocument,
  listDocuments,
  loginAs,
  scenarioOptions,
  writeSummary,
} from './lib.js';

// One fixed-VU step of the saturation ladder: a read-only mix so the curve
// shows pure serving capacity. The runner (run-scenario.mjs saturation)
// invokes this file once per step and merges the per-step summaries into a
// throughput-vs-concurrency report; the saturation point is read off that
// curve, not asserted here.
//
// No business_errors rail, unlike the steady-state scenarios: the ladder
// deliberately drives past capacity, and errors appearing at the top steps
// is the very signal the curve exists to observe. They are counted (tagged
// by status) into the report instead of failing the run.

export const options = scenarioOptions({
  vus: 1,
  duration: '20s',
  rail: false,
});

export default function () {
  const s = loginAs(__VU);
  if (!s) return;
  const page = listDocuments(s);
  if (page) {
    const docs = page.json('data');
    if (docs.length > 0)
      getDocument(s, docs[Math.floor(Math.random() * docs.length)].id);
  }
}

export const handleSummary = writeSummary({
  description: 'fixed-VU read-only step of the saturation ladder',
});
