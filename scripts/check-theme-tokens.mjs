import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Post-build verification of the theme contract (docs/ui/design.md §5,
// UI-R1): the built stylesheet must carry the semantic tokens that
// components reference at runtime — most importantly `--popover`, whose
// absence once shipped as a transparent AlertDialog background that no
// source-level check could see. Every token must resolve in the light
// (`:root`) and dark (`.dark`) tables separately, because each surface
// role needs a dark counterpart and one stray duplicate must not stand
// in for a missing table.

const dist = join(new URL('../apps/web/dist/assets', import.meta.url).pathname);
if (!existsSync(dist))
  throw new Error('Built app not found; run the web build before this check.');

const cssFile = readdirSync(dist).find(
  (entry) => entry.startsWith('index-') && entry.endsWith('.css'),
);
if (!cssFile)
  throw new Error(`No built stylesheet (index-*.css) under ${dist}.`);
const text = readFileSync(join(dist, cssFile), 'utf8');

// The dark table opens at the `.dark` selector (not prose mentions of it
// in preserved comments); everything before it is the light table plus
// the @theme mapping, which references but does not define values, so it
// cannot satisfy the check.
const darkAt = text.search(/\.dark\s*[{,:]/);
if (darkAt < 0) throw new Error(`Built CSS ${cssFile} has no .dark table.`);
const tables = { light: text.slice(0, darkAt), dark: text.slice(darkAt) };

const tokens = [
  // Core surfaces and text.
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--popover',
  '--popover-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--border',
  '--input',
  // Reference-specific roles.
  '--selection',
  '--selection-foreground',
  '--surface-muted',
  '--sidebar',
  '--ring',
  '--link',
  // Status colors.
  '--info',
  '--success',
  '--warning',
  '--destructive',
];
const missing = [];
for (const [name, table] of Object.entries(tables)) {
  for (const token of tokens) {
    // A definition must carry a value; `--token:;` counts as missing.
    if (!new RegExp(`${token}:\\s*[^\\s;}]+`).test(table))
      missing.push(`${name} ${token}`);
  }
}
if (missing.length)
  throw new Error(
    `Built CSS ${cssFile} lacks theme token definitions: ${missing.join(', ')}.`,
  );
console.log(
  `Built stylesheet ${cssFile} defines all ${tokens.length} semantic theme tokens in both light and dark tables.`,
);
