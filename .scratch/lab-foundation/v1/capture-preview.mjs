import { createHash } from 'node:crypto';
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
if (
  !inspection.checks.every((check) => check.passed) ||
  inspection.errors.length
)
  throw new Error(
    'The final browser inspection must pass before this version is captured.',
  );
const excluded = new Set([
  'node_modules',
  'dist',
  'initial-desktop.png',
  'inspection-failure.png',
  'display-failure.png',
  'lifecycle-failure.png',
  'display-inspection.json',
  'manifest.json',
  'capture.json',
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
const manifest = await Promise.all(
  files.sort().map(async (path) => {
    const bytes = await readFile(join(preview, path));
    return {
      path,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }),
);
await writeFile(
  join(preview, 'evidence/manifest.json'),
  JSON.stringify(manifest, null, 2),
);
files.push('evidence/manifest.json');
const temp = await mkdtemp(join(tmpdir(), 'foundation-preview-capture-'));
const env = { ...process.env, GIT_INDEX_FILE: join(temp, 'index') };
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
    'Capture Digital Twin Foundation v1 interactive experience preview\n\nIsolated 3D lab composition, independent virtual-device interaction,\nuser/Agent shared state, local save/reopen and recoverable scenarios.\nThis branch preserves design evidence; experience acceptance is pending.\n',
  );
  git([
    'update-ref',
    'refs/heads/preview/lab-foundation-v1',
    commit,
    '0000000000000000000000000000000000000000',
  ]);
  const result = {
    branch: 'preview/lab-foundation-v1',
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
  await rm(temp, { recursive: true, force: true });
}
