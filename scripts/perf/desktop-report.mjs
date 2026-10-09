// Pure report shaping for the desktop soak: aggregation of the renderer
// time series and growth observations over it. No I/O and no process
// effects, so tests/tooling can import this module directly.
import { stats } from './stats.mjs';

const FIELDS = ['rendererRssKiB', 'heapKiB', 'domNodes', 'listeners'];

export function aggregateSoak(samples, sampleMs) {
  const summary = {};
  for (const field of FIELDS)
    summary[field] = stats(
      samples.map((s) => s[field]).filter((v) => v != null),
    );
  return { sampleMs, count: samples.length, summary, raw: samples };
}

// Growth observations compare the medians of the first and last quarters of
// each series. They describe one run's trend; a single soak never claims a
// leak — the note asks for a rerun, and the raw series travels with the
// report so a human can judge. Report material, not a gate. The 25% bar
// keeps one quiet GC round or one background task from manufacturing a
// note on an otherwise flat series.
export function growthNotes(samples) {
  const threshold = 0.25;
  if (samples.length < 8) return [];
  const quarter = Math.floor(samples.length / 4);
  const median = (from, field) => {
    const values = samples
      .slice(from, from + quarter)
      .map((s) => s[field])
      .filter((v) => v != null)
      .sort((a, b) => a - b);
    return values.length === 0 ? null : values[Math.floor(values.length / 2)];
  };
  const notes = [];
  for (const field of FIELDS) {
    const first = median(0, field);
    const last = median(samples.length - quarter, field);
    if (first == null || last == null || first <= 0) continue;
    const change = (last - first) / first;
    if (change >= threshold)
      notes.push({
        metric: field,
        firstQuarterMedian: first,
        lastQuarterMedian: last,
        changePct: +(change * 100).toFixed(1),
        note: 'growth observed over this run; rerun to confirm — a single soak is not a leak claim',
      });
  }
  return notes;
}

export function soakLine(aggregate, notes) {
  const s = aggregate.summary;
  const range = (stat, unit = '') =>
    stat == null ? 'n/a' : `${stat.min}–${stat.max}${unit}`;
  return [
    `samples ${aggregate.count}`,
    `rendererRss ${range(s.rendererRssKiB, ' KiB')}`,
    `heap ${range(s.heapKiB, ' KiB')}`,
    `domNodes ${range(s.domNodes)}`,
    `listeners ${range(s.listeners)}`,
    `growth notes ${notes.length}`,
  ].join(' | ');
}
