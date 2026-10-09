import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateBundle } from '../../scripts/lib/perf-budget.mjs';

// The deterministic performance gate of spec §17.1. These tests feed the
// real checker synthetic builds so the gate's failure ability is pinned in
// tooling: an over-budget sample must fail with the numbers, and the real
// build shape must pass. The live measurement itself runs in
// scripts/perf-bundle.mjs (just perf-ci).

const KiB = 1024;
const baselines = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '../../scripts/perf/baselines.json',
    ),
    'utf8',
  ),
);

function build({
  initial = [{ name: 'index.js', gzip: 100 * KiB }],
  async = [{ name: 'markdown-content.js', gzip: 40 * KiB }],
} = {}) {
  return { initial, async };
}

test('a build within the budgets passes with no violations', () => {
  const report = evaluateBundle(build(), {
    initialGzipKiB: 400,
    asyncChunkGzipKiB: 500,
    lazyPatterns: ['markdown'],
  });
  assert.deepEqual(report.violations, []);
  assert.equal(report.ok, true);
});

test('an initial bundle over budget fails and names the numbers', () => {
  const report = evaluateBundle(
    build({ initial: [{ name: 'index.js', gzip: 401 * KiB }] }),
    { initialGzipKiB: 400, asyncChunkGzipKiB: 500, lazyPatterns: ['markdown'] },
  );
  assert.equal(report.ok, false);
  assert.equal(report.violations.length, 1);
  assert.match(report.violations[0], /initial/);
  assert.match(report.violations[0], /401(\.\d+)? KiB/);
  assert.match(report.violations[0], /\b400\b/);
});

test('a single async chunk over budget fails on its own name', () => {
  const report = evaluateBundle(
    build({
      async: [
        { name: 'markdown-content.js', gzip: 40 * KiB },
        { name: 'heavy-vendor.js', gzip: 501 * KiB },
      ],
    }),
    { initialGzipKiB: 400, asyncChunkGzipKiB: 500, lazyPatterns: ['markdown'] },
  );
  assert.equal(report.ok, false);
  assert.equal(report.violations.length, 1);
  assert.match(report.violations[0], /heavy-vendor\.js/);
  assert.match(report.violations[0], /501(\.\d+)? KiB/);
});

test('lazy-marked code that ships in the initial bundle breaks the contract', () => {
  const report = evaluateBundle(
    build({
      initial: [
        { name: 'index.js', gzip: 100 * KiB },
        { name: 'markdown-content.js', gzip: 40 * KiB },
      ],
      async: [],
    }),
    { initialGzipKiB: 400, asyncChunkGzipKiB: 500, lazyPatterns: ['markdown'] },
  );
  assert.equal(report.ok, false);
  assert(
    report.violations.some(
      (violation) =>
        /lazy/.test(violation) && /markdown-content\.js/.test(violation),
    ),
    `expected a lazy-boundary violation, got: ${report.violations.join(' | ')}`,
  );
});

test('budgets are configurable and the report records what was measured', () => {
  const initial = [{ name: 'index.js', gzip: 30 * KiB }];
  const async = [{ name: 'route.js', gzip: 20 * KiB }];
  const report = evaluateBundle(build({ initial, async }), {
    initialGzipKiB: 25,
    asyncChunkGzipKiB: 10,
    lazyPatterns: [],
  });
  assert.equal(report.ok, false);
  assert.equal(report.violations.length, 2);
  assert.deepEqual(report.measured.initialGzipKiB, 30);
  assert.deepEqual(report.measured.chunks.map((chunk) => chunk.name).sort(), [
    'index.js',
    'route.js',
  ]);
});

test('the committed real baseline passes the committed budgets', () => {
  const measured = baselines.firstMeasured.bundle;
  const report = evaluateBundle(
    {
      initial: [
        {
          name: 'index.js',
          gzip: measured.initialGzipKiB * KiB,
        },
      ],
      async: measured.chunks
        .filter((chunk) => chunk.role === 'async')
        .map((chunk) => ({ name: chunk.name, gzip: chunk.gzipKiB * KiB })),
    },
    baselines.budgets.bundle,
  );
  assert.deepEqual(report.violations, []);
  assert.equal(report.ok, true);
});

test('a build just over the committed budget fails with the numbers', () => {
  const budget = baselines.budgets.bundle;
  const report = evaluateBundle(
    {
      initial: [{ name: 'index.js', gzip: (budget.initialGzipKiB + 1) * KiB }],
      async: [],
    },
    budget,
  );
  assert.equal(report.ok, false);
  assert.match(report.violations[0], /initial/);
  assert.match(report.violations[0], /401(\.\d+)? KiB/);
});
