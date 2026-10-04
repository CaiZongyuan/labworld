// Capture only this prototype with an isolated index; preserve the user's worktree and index.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('./', import.meta.url));
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const branch = process.argv[2] ?? 'preview/lab-onboarding-v2';
const message =
  process.argv[3] ??
  'preview: capture Lab onboarding v2 contextual visual tour';
const git = (args, env) =>
  execFileSync('git', args, {
    cwd: repository,
    env: env ?? process.env,
    encoding: 'utf8',
  }).trim();
git(['check-ref-format', '--branch', branch]);
try {
  git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  throw new Error(`Preserve ${branch}; use a new version for another capture.`);
} catch (error) {
  if (!('status' in error) || error.status !== 1) throw error;
}
const before = {
  head: git(['rev-parse', 'HEAD']),
  index: git(['diff', '--cached', '--binary']),
};
async function filesAt(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (
      ['node_modules', 'dist', 'dev-server.log', 'manifest.json'].includes(
        entry.name,
      )
    )
      continue;
    const file = join(path, entry.name);
    if (entry.isDirectory()) result.push(...(await filesAt(file)));
    else if (entry.isFile()) result.push(file);
  }
  return result.sort();
}
const paths = await filesAt(directory);
const entries = [];
for (const file of paths)
  entries.push({
    path: relative(repository, file),
    sha256: createHash('sha256')
      .update(await readFile(file))
      .digest('hex'),
  });
await writeFile(
  join(directory, 'evidence/manifest.json'),
  JSON.stringify(
    {
      question:
        'Can a first-time user learn the permanent workspace controls through a contextual visual tour?',
      base: before.head,
      branch,
      capturedAt: new Date().toISOString(),
      files: entries,
    },
    null,
    2,
  ),
);
paths.push(join(directory, 'evidence/manifest.json'));
const temporary = await mkdtemp(join(tmpdir(), 'lab-onboarding-index-'));
const env = { ...process.env, GIT_INDEX_FILE: join(temporary, 'index') };
try {
  git(['read-tree', before.head], env);
  git(
    ['add', '-f', '--', ...paths.map((file) => relative(repository, file))],
    env,
  );
  const tree = git(['write-tree'], env);
  const commit = git(
    ['commit-tree', tree, '-p', before.head, '-m', message],
    env,
  );
  git([
    'update-ref',
    `refs/heads/${branch}`,
    commit,
    '0000000000000000000000000000000000000000',
  ]);
  if (
    git(['rev-parse', 'HEAD']) !== before.head ||
    git(['diff', '--cached', '--binary']) !== before.index
  )
    throw new Error(
      'The active branch or user index changed during capture; inspect before proceeding.',
    );
  console.log(
    JSON.stringify(
      {
        branch,
        commit,
        tree,
        files: paths.length,
        preserved: 'Active branch and user index',
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
