import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  assertPaletteCurrent,
  parseTokenTables,
  palettePath,
  renderPalette,
  sourcePath,
} from '../../scripts/lib/docs-palette.mjs';
import { root as repoRoot } from '../../scripts/lib/process.mjs';

// The public site derives its VitePress palette from the application token
// tables (packages/ui/src/styles.css) instead of hand-copying a second
// palette. These tests pin the derivation contract: the parser reads the
// real production tables, the renderer emits token references (no second
// hex), a renamed token fails loudly, and the checked-in generated file
// must match a fresh render.

test('parseTokenTables reads both production tables', () => {
  const css = readFileSync(sourcePath(repoRoot), 'utf8');
  const tables = parseTokenTables(css);
  assert.equal(tables.light.get('--background'), '#ffffff');
  assert.equal(tables.dark.get('--background'), '#191a1c');
  assert.equal(tables.light.get('--link'), '#176bc0');
  assert.equal(tables.dark.get('--link'), '#79b5f0');
  // The module-preview tables must not leak into the semantic tables —
  // except the two grafted landing accents, which keep their per-mode
  // values (dark violet differs from light violet).
  assert.ok(!tables.light.has('--module-blue-start'));
  assert.equal(
    tables.light.get('--module-violet-foreground'),
    'oklch(0.49 0.15 298)',
  );
  assert.equal(
    tables.dark.get('--module-violet-foreground'),
    'oklch(0.82 0.085 298)',
  );
});

test('renderPalette emits token references, never a second hex', () => {
  const css = readFileSync(sourcePath(repoRoot), 'utf8');
  const rendered = renderPalette(parseTokenTables(css));
  // Both token tables ride along so the mapping below resolves live, and
  // the dark mode follows the same .dark class the application uses.
  assert.match(rendered, /--background: #ffffff;/);
  assert.match(rendered, /\.dark \{\n {2}--background: #191a1c;/);
  // The mapping section references tokens; every value there is a var()
  // or color-mix, so a palette change cannot bypass the source.
  const mapping = rendered.slice(
    rendered.indexOf('--vp-c-bg:'),
    rendered.indexOf('.dark {'),
  );
  assert.doesNotMatch(mapping, /#[0-9a-fA-F]{3,8}\b/);
  assert.match(rendered, /--vp-c-bg: var\(--background\)/);
  assert.match(rendered, /--vp-c-brand-1: var\(--link\)/);
  assert.match(rendered, /--vp-button-brand-bg: var\(--primary\)/);
  // The landing accent dots resolve through the semantic and module
  // tokens, so those two module values must ride along as well.
  assert.match(rendered, /--module-violet-foreground:/);
  assert.match(rendered, /--module-cyan-foreground:/);
});

test('a mapped token that no longer exists fails the render', () => {
  // A minimal but otherwise complete table pair: every mapped role is
  // present except --link, whose absence must be the named failure.
  const roles = [
    'background',
    'surface-muted',
    'muted',
    'card',
    'border',
    'foreground',
    'muted-foreground',
    'primary',
    'primary-foreground',
    'sidebar',
  ];
  const table = (bg) => [
    ...roles.map((role) => (role === 'link' ? '' : `  --${role}: ${bg};`)),
    '  color-scheme: x;',
  ];
  const fixture = [
    ':root {',
    ...table('#111111'),
    '}',
    '',
    '.dark {',
    ...table('#222222'),
    '}',
    '',
    ':root,',
    '.module-icon-theme-light {',
    '}',
    '',
    '.dark,',
    '.module-icon-theme-dark {',
    '}',
  ].join('\n');
  // --link is in the map but missing from the fixture tables: the drift
  // must be named, not silently rendered as a dangling var().
  assert.throws(
    () => renderPalette(parseTokenTables(fixture)),
    /--link is not defined in the light token table/,
  );
});

test('assertPaletteCurrent compares the generated file with a fresh render', () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-palette-'));
  try {
    // The tree-shaped fixture mirrors a template copy: source tables and
    // generated palette both resolve inside the given root.
    const source = sourcePath(root);
    mkdirSync(dirname(source), { recursive: true });
    const css = readFileSync(sourcePath(repoRoot), 'utf8');
    writeFileSync(source, css);
    const target = palettePath(root);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renderPalette(parseTokenTables(css)));
    assert.doesNotThrow(() => assertPaletteCurrent(root));
    writeFileSync(target, `${readFileSync(target, 'utf8')}/* drift */\n`);
    assert.throws(
      () => assertPaletteCurrent(root),
      /generate-docs-palette\.mjs/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
