// The deterministic bundle budgets of spec §17.1, as a pure checker so the
// gate can fail in tooling tests on synthetic builds before it ever guards
// a real one. Measurement (vite build + gzip) lives in scripts/perf-bundle.mjs.

const KiB = 1024;

// shapes: { initial: [{name, gzip}], async: [{name, gzip}] } with gzip in
// bytes; budgets: { initialGzipKiB, asyncChunkGzipKiB, lazyPatterns } where
// lazyPatterns name chunks that must never ship in the initial set —
// each is loaded through a dynamic import, and that boundary is a
// contract, not an implementation detail (the markdown renderer, the
// design-system page and its icon catalog all live behind one).
export function evaluateBundle({ initial, async }, budgets) {
  const violations = [];
  const initialGzip = initial.reduce((total, chunk) => total + chunk.gzip, 0);
  if (initialGzip > budgets.initialGzipKiB * KiB)
    violations.push(
      `initial bundle is ${(initialGzip / KiB).toFixed(1)} KiB gzip, over the ${budgets.initialGzipKiB} KiB budget`,
    );
  for (const chunk of async)
    if (chunk.gzip > budgets.asyncChunkGzipKiB * KiB)
      violations.push(
        `async chunk ${chunk.name} is ${(chunk.gzip / KiB).toFixed(1)} KiB gzip, over the ${budgets.asyncChunkGzipKiB} KiB budget`,
      );
  for (const pattern of budgets.lazyPatterns ?? [])
    for (const chunk of initial)
      if (chunk.name.includes(pattern))
        violations.push(
          `lazy boundary broken: ${chunk.name} matches /${pattern}/ and ships in the initial bundle; it must load through a dynamic import`,
        );
  return {
    ok: violations.length === 0,
    violations,
    measured: {
      initialGzipKiB: +(initialGzip / KiB).toFixed(1),
      chunks: [...initial, ...async].map((chunk) => ({
        name: chunk.name,
        role: initial.includes(chunk) ? 'initial' : 'async',
        gzipKiB: +(chunk.gzip / KiB).toFixed(1),
      })),
    },
  };
}
