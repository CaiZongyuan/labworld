import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { siteModel } from './lib/docs.mjs';
import { docsBase } from './lib/docs-locales.mjs';

// Post-build verification of the real site: every internal link in the
// built HTML must land on a built page, and every page's locale switcher
// must land on a built page of the other locale. This closes the gap the
// rendered-source checks cannot see — wrong hrefs that only appear after
// VitePress applies the base path and the locale routes.

const dist = new URL('../apps/docs/.vitepress/dist', import.meta.url).pathname;
if (!existsSync(dist))
  throw new Error(
    'Built site not found; run the docs build before this check.',
  );

// The base path must mirror apps/docs/.vitepress/config.mts.
const repository = process.env.GITHUB_REPOSITORY ?? siteModel().repository;
const base = docsBase(repository, process.env.DOCS_BASE);

const pages = new Set();
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (entry.endsWith('.html')) pages.add(relative(dist, path));
  }
};
walk(dist);

// Built file -> the URL path it serves under cleanUrls.
const urlOfFile = (file) =>
  `/${file.replace(/(^|\/)index\.html$/, '$1').replace(/\.html$/, '')}`;
const served = new Map([...pages].map((file) => [urlOfFile(file), file]));
const has404 = pages.has('404.html');
if (!has404 || !served.has('/'))
  throw new Error('Built site lacks the root page or 404 fallback.');

// URL path -> the file that must exist: directory URLs come from an
// index.html, paths with their own extension (the OpenAPI download) from
// the literal file, everything else from <path>.html. Returns null for
// paths outside the configured base so the caller reports them per page.
const fileOfUrl = (path) => {
  if (!path.startsWith(base)) return null;
  const withoutBase = path.slice(base.length);
  if (withoutBase === '' || withoutBase.endsWith('/'))
    return `${withoutBase}index.html`;
  return existsSync(join(dist, withoutBase))
    ? withoutBase
    : `${withoutBase}.html`;
};

const checked = new Set();
const broken = [];
for (const file of pages) {
  if (file === '404.html') continue;
  const html = readFileSync(join(dist, file), 'utf8');
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  const targets = hrefs.filter(
    (href) =>
      !/^(https?:|mailto:|#)/.test(href) &&
      !/\.(js|css|ico|svg|png|woff2?)$/.test(href.split('#')[0]) &&
      href !== '',
  );
  if (targets.length === 0)
    broken.push(`${file}: no internal navigation found`);
  // Relative hrefs resolve against the page's own URL under the base;
  // VitePress keeps within-locale links relative in the built HTML.
  const resolve = (href) =>
    new URL(href, `http://x${base.replace(/\/$/, '')}${urlOfFile(file)}`)
      .pathname;
  for (const href of targets) {
    const absolute = resolve(href);
    const target = fileOfUrl(absolute);
    if (target === null) {
      broken.push(`${file} links at ${href} outside base ${base}`);
      continue;
    }
    checked.add(target);
    // Pages must exist as built HTML; published non-page artifacts (the
    // OpenAPI download) just need to exist in the output.
    const exists = target.endsWith('.html')
      ? pages.has(target)
      : existsSync(join(dist, target));
    if (!exists) broken.push(`${file} links at ${href} -> missing ${target}`);
  }
  const switcher = html.match(/class="docs-locale-link"[^>]*href="([^"]*)"/);
  if (!switcher)
    broken.push(`${file}: locale switcher link missing from built page`);
  else {
    const target = fileOfUrl(resolve(switcher[1]));
    if (!pages.has(target))
      broken.push(`${file} locale switch targets missing ${target}`);
  }
}

if (broken.length) {
  throw new Error(
    `Built-site navigation broken:\n${broken.map((line) => `- ${line}`).join('\n')}`,
  );
}
console.log(
  `Built site navigation verified: ${pages.size - (has404 ? 1 : 0)} pages, ${checked.size} distinct internal targets resolve under base ${base}.`,
);
