import { readFileSync, readlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export function verifyFrozenInputs() {
  const bundle = dirname(new URL(import.meta.url).pathname);
  const manifest = JSON.parse(
    readFileSync(resolve(bundle, 'manifest.json'), 'utf8'),
  );
  const git = (...args) =>
    execFileSync('git', args, { encoding: 'utf8' }).trim();
  const sha256 = (path, kind) =>
    createHash('sha256')
      .update(kind === 'symlink' ? readlinkSync(path) : readFileSync(path))
      .digest('hex');
  if (
    git('rev-parse', 'HEAD') !== manifest.productCommit ||
    git('rev-parse', 'HEAD^{tree}') !== manifest.productTree
  )
    throw new Error('Frozen product identity mismatch');
  for (const entry of manifest.productFiles)
    if (sha256(entry.path, entry.kind) !== entry.sha256)
      throw new Error(`Frozen product bytes mismatch: ${entry.path}`);
  for (const entry of manifest.bundleFiles)
    if (sha256(resolve(bundle, entry.path)) !== entry.sha256)
      throw new Error(`Frozen bundle bytes mismatch: ${entry.path}`);
  const evidence = resolve('.scratch/early-handle-ci-evidence');
  mkdirSync(evidence, { recursive: true });
  writeFileSync(
    resolve(evidence, 'frozen-input-verification.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        diagnosticRunHead: process.env.DIAGNOSTIC_RUN_HEAD ?? null,
        productCommit: manifest.productCommit,
        productTree: manifest.productTree,
        productFiles: manifest.productFiles.length,
        bundleFiles: manifest.bundleFiles.length,
        manifestSha256: sha256(resolve(bundle, 'manifest.json')),
        pass: true,
      },
      null,
      2,
    ) + '\n',
  );
  return manifest;
}

if (process.argv[1] === new URL(import.meta.url).pathname) verifyFrozenInputs();
