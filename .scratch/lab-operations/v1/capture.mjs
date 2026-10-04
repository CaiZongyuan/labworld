import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = '.scratch/lab-operations/v1';
const ref = 'refs/heads/preview/lab-operations-v1';
const git = (args, env = process.env) =>
  execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
const verification = JSON.parse(
  await readFile(
    new URL('evidence/verification.json', import.meta.url),
    'utf8',
  ),
);
if (verification.status !== 'pass')
  throw new Error('Capture requires passing preview verification.');
verification.validation = {};
for (const command of ['typecheck', 'build']) {
  execFileSync('pnpm', [command], {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    stdio: 'pipe',
  });
  verification.validation[command] = {
    status: 'pass',
    checkedAt: new Date().toISOString(),
  };
}
await writeFile(
  new URL('evidence/verification.json', import.meta.url),
  JSON.stringify(verification, null, 2),
);
try {
  git(['show-ref', '--verify', ref]);
  throw new Error(
    'Preview branch already exists. Preserve it; create a new version.',
  );
} catch (error) {
  if (!error.status) throw error;
}

const files = (await readdir(new URL('.', import.meta.url)))
  .filter((name) => /\.(?:tsx?|css|html|json|md|mjs|yaml)$/.test(name))
  .map((name) => `${directory}/${name}`);
files.push(`${directory}/evidence/verification.json`);
files.push(
  ...verification.screenshots.map(
    (name) => `${directory}/evidence/${name}.png`,
  ),
);
const baseline = git(['rev-parse', 'HEAD']);
const records = await Promise.all(
  files.map(async (path) => {
    const data = await readFile(join(root, path));
    return {
      path,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    };
  }),
);
await writeFile(
  new URL('evidence/manifest.json', import.meta.url),
  JSON.stringify(
    {
      version: 'v1',
      baseline,
      capturedAt: new Date().toISOString(),
      publication: 'Local branch only; user acceptance pending.',
      files: records,
    },
    null,
    2,
  ),
);
files.push(`${directory}/evidence/manifest.json`);

// An independent index preserves the user's staged changes and current branch.
const temporary = await mkdtemp(join(tmpdir(), 'lab-operations-preview-'));
const env = { ...process.env, GIT_INDEX_FILE: join(temporary, 'index') };
try {
  git(['read-tree', baseline], env);
  git(['add', '-f', '--', ...files], env);
  const changed = git(['diff', '--cached', '--name-only'], env).split('\n');
  if (changed.some((path) => !path.startsWith(`${directory}/`)))
    throw new Error('Capture included files outside the preview.');
  const tree = git(['write-tree'], env);
  const commit = git(
    [
      'commit-tree',
      tree,
      '-p',
      baseline,
      '-m',
      'preview(lab): preserve operations workbench v1 and browser evidence',
    ],
    env,
  );
  git(['update-ref', ref, commit, '']);
  console.log(
    JSON.stringify({
      branch: ref.replace('refs/heads/', ''),
      commit,
      files: files.length,
      baseline,
    }),
  );
} finally {
  await rm(temporary, { recursive: true });
}
