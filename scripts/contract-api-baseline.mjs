import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { root } from './lib/process.mjs';
import {
  retainedOpenApi,
  canonical,
  semanticDifferences,
} from './lib/contract-openapi.ts';
const { values } = parseArgs({
  options: {
    input: { type: 'string', default: 'packages/contracts/openapi.json' },
    write: { type: 'boolean' },
  },
});
const baseline = resolve(root, 'tests/contract/api-baseline.json');
const actual = retainedOpenApi(
  JSON.parse(readFileSync(resolve(root, values.input), 'utf8')),
);
if (values.write) {
  writeFileSync(baseline, JSON.stringify(canonical(actual), null, 2) + '\n');
  console.log('Retained Rust API baseline written');
} else {
  const diff = semanticDifferences(
    JSON.parse(readFileSync(baseline, 'utf8')),
    actual,
  );
  if (diff.length)
    throw new Error(`Retained API semantic drift:\n${diff.join('\n')}`);
  console.log('Retained API semantic difference is empty');
}
