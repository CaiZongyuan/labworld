import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { serveDocs } from './lib/docs-server.mjs';
import { siteModel } from './lib/docs.mjs';
import { docsBase } from './lib/docs-locales.mjs';
import { root, runAsync } from './lib/process.mjs';

// Public-site browser journeys: build the real site, serve the dist the
// way the static host does, and drive the landing, the Coming soon pages,
// the locale switcher, the theme and narrow-screen navigation through
// Playwright. Closes with a smoke pass under a custom base, which rebuilds
// the dist so the committed artifact ends in the default base state.
//
// The server lives in this process, so every child runs through runAsync:
// a synchronous wait would block the loop and the server could not answer
// the browser. Requires Playwright's Chromium (pnpm exec playwright install
// chromium); it needs no application stack, database or containers.

const dist = resolve(root, 'apps/docs/.vitepress/dist');

const playwright = (specFile, url) =>
  runAsync(
    'pnpm',
    [
      'exec',
      'playwright',
      'test',
      '--config',
      'playwright.docs.config.ts',
      specFile,
    ],
    { ...process.env, E2E_DOCS_URL: url },
  );

const docsBuild = (env = process.env) => runAsync('pnpm', ['docs:build'], env);

await docsBuild();
const repository = process.env.GITHUB_REPOSITORY ?? siteModel().repository;
const base = docsBase(repository, process.env.DOCS_BASE);
const defaultSite = await serveDocs(dist, base);
try {
  await playwright('tests/docs/public-site.spec.ts', defaultSite.url);
} finally {
  await defaultSite.close();
}

await docsBuild({ ...process.env, DOCS_BASE: '/ui16-custom-base/' });
const customSite = await serveDocs(dist, '/ui16-custom-base/');
try {
  await playwright('tests/docs/custom-base.spec.ts', customSite.url);
} finally {
  await customSite.close();
  rmSync(dist, { recursive: true, force: true });
  await docsBuild();
}
console.log('Public-site browser journeys verified.');
