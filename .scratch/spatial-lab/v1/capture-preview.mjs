import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const preview = fileURLToPath(new URL('./', import.meta.url));
const inspection = JSON.parse(
  await readFile(join(preview, 'evidence/inspection.json'), 'utf8'),
);
if (!inspection.passed || inspection.errors.length)
  throw new Error('Browser inspection must pass before capture.');
const excluded = new Set([
  'node_modules',
  'dist',
  'capture.json',
  'inspection-failure.json',
  'inspection-failure.png',
  'desktop-initial.png',
  'desktop-selected.png',
  'mobile-selected.png',
]);
const files = [];
async function walk(folder = '') {
  for (const entry of await readdir(join(preview, folder), {
    withFileTypes: true,
  })) {
    if (excluded.has(entry.name) || entry.isSymbolicLink()) continue;
    const path = join(folder, entry.name);
    if (entry.isDirectory()) await walk(path);
    else files.push(path);
  }
}
await walk();
const temporary = await mkdtemp(join(tmpdir(), 'spatial-preview-capture-'));
const env = { ...process.env, GIT_INDEX_FILE: join(temporary, 'index') };
const git = (args, input) =>
  execFileSync('git', args, { cwd: root, env, encoding: 'utf8', input }).trim();
try {
  const head = git(['rev-parse', 'HEAD']);
  git(['read-tree', head]);
  git([
    'add',
    '--force',
    '--',
    ...files.map((path) => relative(root, join(preview, path))),
  ]);
  const tree = git(['write-tree']);
  const commit = git(
    ['commit-tree', tree, '-p', head],
    'Capture Lab Word spatial workspace interactive preview v1\n\nScene-led laboratory, contextual equipment controls, independent simulated\ntasks, layout drafts and desktop/mobile visual evidence. Acceptance pending.\n',
  );
  git([
    'update-ref',
    'refs/heads/preview/spatial-lab-v1',
    commit,
    '0000000000000000000000000000000000000000',
  ]);
  const result = {
    branch: 'preview/spatial-lab-v1',
    commit,
    parent: head,
    files: files.length,
  };
  await writeFile(
    join(preview, 'evidence/capture.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
