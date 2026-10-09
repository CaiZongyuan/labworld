import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './lib/process.mjs';

const output = resolve(root, 'apps/docs/.vitepress/dist');
if (!existsSync(join(output, 'index.html')))
  throw new Error('Build the documentation before publishing');
const git = (args, options = {}) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', ...options }).trim();
const sourceRef = process.env.DOCS_SOURCE_REF ?? git(['rev-parse', 'HEAD']);
const origin = git(['remote', 'get-url', 'origin']);
const originRepo = origin.match(
  /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/,
)?.[1];
const repository = process.env.GITHUB_REPOSITORY ?? originRepo;
if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository))
  throw new Error('Publishing requires a GitHub repository origin');
if (
  !readFileSync(join(output, 'index.html'), 'utf8')
    .toLowerCase()
    .includes(`github.com/${repository}/blob/${sourceRef}/`.toLowerCase())
) {
  throw new Error(
    'Documentation artifact does not match this source commit/repository. Rebuild after committing.',
  );
}
const gitDir = git(['rev-parse', '--absolute-git-dir']);
const previous = git([
  'ls-remote',
  '--heads',
  'origin',
  'refs/heads/gh-pages',
]).split(/\s+/)[0];
if (previous) git(['fetch', '--quiet', 'origin', 'gh-pages']);
let artifactCommit = previous;
const temporary = mkdtempSync(join(tmpdir(), 'labos-threejs-docs-publish-'));
const actor = process.env.GITHUB_ACTIONS
  ? {
      GIT_AUTHOR_NAME: 'github-actions[bot]',
      GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'github-actions[bot]',
      GIT_COMMITTER_EMAIL:
        '41898282+github-actions[bot]@users.noreply.github.com',
    }
  : {};
const env = {
  ...process.env,
  ...actor,
  GIT_INDEX_FILE: join(temporary, 'index'),
};
const artifactGit = (args) =>
  git(['--git-dir', gitDir, '--work-tree', output, ...args], {
    cwd: output,
    env,
  });
try {
  writeFileSync(join(output, '.nojekyll'), '');
  artifactGit(['read-tree', '--empty']);
  artifactGit(['add', '--all']);
  const tree = artifactGit(['write-tree']);
  if (previous && tree === git(['rev-parse', `${previous}^{tree}`])) {
    console.log('Documentation artifact is already published.');
  } else {
    const commit = git(
      ['commit-tree', tree, ...(previous ? ['-p', previous] : [])],
      { env, input: `docs: publish ${sourceRef}\n` },
    );
    artifactCommit = commit;
    git(['push', 'origin', `${commit}:refs/heads/gh-pages`], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    console.log(
      `Published documentation artifact for ${sourceRef}. Source branch and index were not changed.`,
    );
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

if (process.argv.includes('--request-build')) {
  const api = (args) =>
    JSON.parse(
      execFileSync('gh', ['api', ...args], {
        encoding: 'utf8',
        timeout: 15_000,
      }),
    );
  const page = api([`repos/${repository}/pages`]);
  if (
    page.build_type !== 'legacy' ||
    page.source?.branch !== 'gh-pages' ||
    page.source?.path !== '/'
  ) {
    throw new Error(
      'Configure GitHub Pages once to use gh-pages:/ before requesting builds.',
    );
  }
  api(['--method', 'POST', `repos/${repository}/pages/builds`]);
  console.log(
    `Requested Pages build for artifact ${artifactCommit}; waiting for that commit and live content.`,
  );
  const deadline = performance.now() + 300_000;
  let live = false;
  while (performance.now() < deadline) {
    const build = api([`repos/${repository}/pages/builds/latest`]);
    if (build.commit === artifactCommit && build.status === 'errored')
      throw new Error(
        `Pages build failed: ${build.error?.message ?? 'unknown error'}`,
      );
    if (build.commit === artifactCommit && build.status === 'built') {
      try {
        const target = new URL(page.html_url);
        target.searchParams.set('source', sourceRef);
        const response = await fetch(target, {
          signal: AbortSignal.timeout(10_000),
          cache: 'no-store',
        });
        if (response.ok && (await response.text()).includes(sourceRef)) {
          live = true;
          break;
        }
      } catch {
        /* bounded retry while the published artifact reaches the edge */
      }
    }
    await delay(2_000);
  }
  if (!live)
    throw new Error(
      'Pages did not serve the requested source revision within five minutes',
    );
  console.log(
    `Verified live documentation: ${page.html_url} (source ${sourceRef})`,
  );
}
