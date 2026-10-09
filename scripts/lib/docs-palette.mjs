import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './process.mjs';

// Single palette source for the whole product (docs/ui/design.md §5): the
// application token tables in packages/ui/src/styles.css are the only
// place colors are defined, and the public site derives its VitePress
// variables from them at generation time instead of hand-copying a second
// palette. The generator copies both tables verbatim and appends the
// --vp-* mapping as var()/color-mix() references, so dark mode keeps
// following the same `.dark` class and a token change re-reaches the site
// through one regeneration. The generated file is untracked derived
// content, so drift cannot reach a user: docs:dev/docs:build regenerate it
// first. `assertPaletteCurrent` is the compare primitive behind the
// generator's `--check` and the tooling tests, not a gate.

export const sourcePath = (rootDir) =>
  join(rootDir, 'packages/ui/src/styles.css');
export const palettePath = (rootDir) =>
  join(rootDir, 'apps/docs/.generated/palette.css');

// The semantic baseline tables in styles.css start with exactly `:root {`
// and `.dark {`; the module-icon preview tables are shared selectors
// (`:root,`) and stay out — except the two hues the landing dots borrow,
// which are grafted in from those shared blocks.
const tableStart = (css, linePattern) => {
  const at = css.search(new RegExp(`^${linePattern}$`, 'm'));
  if (at < 0) throw new Error(`styles.css lacks a ${linePattern} table`);
  const end = css.indexOf('}', at);
  if (end < 0)
    throw new Error(`styles.css ${linePattern} table is unterminated`);
  return css.slice(at, end);
};

const parseTable = (block) => {
  const entries = new Map();
  for (const line of block.split('\n').slice(1)) {
    const match = /^\s*(--[\w-]+):\s*([^;]+);/.exec(line);
    if (match) entries.set(match[1], match[2].trim());
  }
  return entries;
};

export function parseTokenTables(css) {
  const light = parseTable(tableStart(css, ':root \\{'));
  const dark = parseTable(tableStart(css, '\\.dark \\{'));
  // The module tables are shared selectors, one per mode; graft each
  // mode's own values so the dark table never inherits the light hues.
  const sharedLight = parseTable(tableStart(css, ':root,'));
  const sharedDark = parseTable(tableStart(css, '\\.dark,'));
  for (const token of requiredTokens) {
    if (sharedLight.has(token)) light.set(token, sharedLight.get(token));
    if (sharedDark.has(token)) dark.set(token, sharedDark.get(token));
  }
  return { light, dark };
}

// The public-site mapping, one decision per entry. Roles without an
// application counterpart (VitePress's fixed white) stay literal in
// custom.css, not here. Colors referenced beyond the semantic tables (the
// two module hues the landing dots borrow) are pinned by requiredTokens.
const mapping = [
  ['--vp-c-bg', 'var(--background)'],
  ['--vp-c-bg-alt', 'var(--surface-muted)'],
  ['--vp-c-bg-soft', 'var(--muted)'],
  ['--vp-c-bg-elv', 'var(--card)'],
  ['--vp-c-border', 'var(--border)'],
  ['--vp-c-divider', 'var(--border)'],
  ['--vp-c-gutter', 'var(--border)'],
  ['--vp-c-text-1', 'var(--foreground)'],
  ['--vp-c-text-2', 'var(--muted-foreground)'],
  ['--vp-c-text-3', 'var(--muted-foreground)'],
  ['--vp-c-brand-1', 'var(--link)'],
  ['--vp-c-brand-2', 'var(--link)'],
  ['--vp-c-brand-3', 'var(--link)'],
  ['--vp-c-brand-soft', 'color-mix(in srgb, var(--link) 14%, transparent)'],
  ['--vp-c-default-soft', 'var(--muted)'],
  ['--vp-button-brand-bg', 'var(--primary)'],
  ['--vp-button-brand-text', 'var(--primary-foreground)'],
  [
    '--vp-button-brand-hover-bg',
    'color-mix(in srgb, var(--primary) 90%, var(--background))',
  ],
  ['--vp-button-brand-hover-text', 'var(--primary-foreground)'],
  ['--vp-nav-bg-color', 'var(--sidebar)'],
  ['--vp-sidebar-bg-color', 'var(--sidebar)'],
  ['--vp-code-color', 'var(--foreground)'],
  ['--vp-code-bg', 'var(--muted)'],
  ['--vp-custom-block-tip-bg', 'var(--muted)'],
  ['--vp-custom-block-tip-border', 'var(--border)'],
];

// Landing accent dots outside the semantic roles: success/warning/destructive
// cover green/amber/red, and the two extra hues borrow the module-category
// colors, whose tables already carry the dark-mode contrast.
const requiredTokens = [
  '--module-violet-foreground',
  '--module-cyan-foreground',
];

const renderTable = (name, table) =>
  [
    `${name} {`,
    ...[...table].map(([key, value]) => `  ${key}: ${value};`),
    ...(name === ':root' ? mapping : []).map(
      ([key, value]) => `  ${key}: ${value};`,
    ),
    '}',
  ].join('\n');

export function renderPalette(tables) {
  // Every var() the mapping references must exist in both tables — the
  // grafted landing accents included. A rename in styles.css must fail
  // here, never render a dangling reference.
  const referenced = [
    ...mapping.flatMap(([, value]) =>
      [...value.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]),
    ),
    ...requiredTokens,
  ];
  for (const token of new Set(referenced))
    for (const mode of ['light', 'dark'])
      if (!tables[mode].has(token))
        throw new Error(
          `Mapped token ${token} is not defined in the ${mode} token table; update the mapping in scripts/lib/docs-palette.mjs`,
        );
  return `/* Generated by scripts/generate-docs-palette.mjs from
   packages/ui/src/styles.css — the single palette source. Do not edit;
   regenerate with \`pnpm exec node scripts/generate-docs-palette.mjs\`. */

${renderTable(':root', tables.light)}
${renderTable('.dark', tables.dark)}
`;
}

export function assertPaletteCurrent(rootDir = root) {
  const fresh = renderPalette(
    parseTokenTables(readFileSync(sourcePath(rootDir), 'utf8')),
  );
  const current = readFileSync(palettePath(rootDir), 'utf8');
  if (current !== fresh)
    throw new Error(
      'apps/docs/.generated/palette.css is stale; run scripts/generate-docs-palette.mjs to regenerate it from packages/ui/src/styles.css',
    );
}
