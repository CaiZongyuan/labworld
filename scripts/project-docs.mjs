import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { renderDocs } from './lib/docs.mjs';
import { root } from './lib/process.mjs';

const pages = renderDocs();
const output = resolve(root, 'apps/docs/.generated');
rmSync(output, { recursive: true, force: true });
for (const [route, content] of pages) {
  const target = resolve(output, route);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
const assets = resolve(root, 'apps/docs/public');
if (existsSync(assets))
  cpSync(assets, resolve(output, 'public'), { recursive: true });
console.log(`Projected ${pages.size} canonical/generated documentation files.`);
