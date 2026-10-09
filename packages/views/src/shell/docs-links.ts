import type { AppLocale } from './preferences';

// Deep links into the published documentation site (docs/ui/design.md §6
// Q8): Simplified Chinese lives on the historical paths, English mirrors
// under /en/. `docsUrl` carries the site base (including a deployment
// sub-path), so every link resolves against it — tutorial buttons must
// open the documentation, never the public landing at the site root.

export function docsHomeUrl(docsUrl: string, locale: AppLocale): string {
  return joinDocs(docsUrl, locale === 'en' ? 'en/docs/' : 'docs/');
}

export function docsChapterUrl(
  docsUrl: string,
  locale: AppLocale,
  chapter: string,
): string {
  const path = chapter.replace(/\.md$/, '');
  return joinDocs(docsUrl, locale === 'en' ? `en/${path}` : path);
}

function joinDocs(docsUrl: string, path: string): string {
  // Relative docsUrl values resolve against the app origin; absolute ones
  // are used as-is. A trailing slash on the base keeps sub-paths joined
  // instead of replacing the last segment.
  const base = docsUrl.endsWith('/') ? docsUrl : `${docsUrl}/`;
  return new URL(path, base).toString();
}
