#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { evaluateBundle } from './lib/perf-budget.mjs';
import { root } from './lib/process.mjs';

// The frontend budget in `pnpm check`: build the web entry, gzip every JS
// chunk, and hold the result against the committed budgets in
// scripts/perf/baselines.json. Violations fail the command and land in a
// report under .scratch/perf/ — the gate is deterministic (file sizes, no
// shared-runner timing).

const webDist = join(root, 'apps/web/dist');

console.log('Building the web entry for bundle measurement...');
execFileSync('pnpm', ['--filter', '@labos-threejs/web', 'build'], {
  cwd: root,
  stdio: 'inherit',
});

const html = readFileSync(join(webDist, 'index.html'), 'utf8');
// "Initial" is what the browser must download before the app renders: the
// entry's <script> tags plus every modulepreload link, which Vite emits for
// chunks the entry imports statically. Counting only <script> would let a
// future entry split silently move weight into the weaker async budget.
const entrySources = [
  ...html.matchAll(/(?:<script[^>]+src=|<link[^>]+href=)"([^"]+\.js)"/g),
].map((match) => basename(new URL(match[1], 'https://x').pathname));
const initial = new Set(entrySources);
const assets = readdirSync(join(webDist, 'assets'), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
  .map((entry) => entry.name);

const chunkGzip = new Map(
  assets.map((name) => [
    name,
    gzipSync(readFileSync(join(webDist, 'assets', name))).length,
  ]),
);
const unknown = entrySources.filter((name) => !chunkGzip.has(name));
if (unknown.length > 0)
  throw new Error(
    `index.html references missing assets: ${unknown.join(', ')}`,
  );

const budgets = JSON.parse(
  readFileSync(join(root, 'scripts/perf/baselines.json'), 'utf8'),
).budgets.bundle;
const report = evaluateBundle(
  {
    initial: [...initial].map((name) => ({ name, gzip: chunkGzip.get(name) })),
    async: assets
      .filter((name) => !initial.has(name))
      .map((name) => ({ name, gzip: chunkGzip.get(name) })),
  },
  budgets,
);

for (const chunk of report.measured.chunks)
  console.log(
    `${chunk.role.padEnd(8)} ${chunk.name.padEnd(40)} ${chunk.gzipKiB} KiB gzip`,
  );

const reportPath = join(root, '.scratch', 'perf', 'bundle-report.json');
mkdirSync(join(root, '.scratch', 'perf'), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

if (!report.ok) {
  console.error(`Bundle budgets failed (report: ${reportPath}):`);
  for (const violation of report.violations) console.error(`- ${violation}`);
  process.exit(1);
}
console.log(
  `Bundle budgets passed (initial ${report.measured.initialGzipKiB} KiB gzip, ${report.measured.chunks.length - initial.size} async chunks); report: ${reportPath}`,
);
