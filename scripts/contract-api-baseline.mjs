import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { root } from './lib/process.mjs';
import {
  retainedOpenApi,
  canonical,
  semanticDifferences,
} from './lib/contract-openapi.ts';
import { sessionApiParts } from './lib/session-api.ts';
import { motionApiParts } from './lib/motion-api.ts';
import { guideProgressApiParts } from './lib/guide-progress-api.ts';
import { recordingApiParts } from './lib/recording-api.ts';
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
  const recordings = recordingApiParts(actual);
  const sessions = sessionApiParts(recordings.existing);
  const motion = motionApiParts(sessions.existing);
  const parts = guideProgressApiParts(motion.existing);
  const diff = semanticDifferences(
    JSON.parse(readFileSync(baseline, 'utf8')),
    parts.existing,
  );
  if (diff.length)
    throw new Error(`Retained API semantic drift:\n${diff.join('\n')}`);
  console.log('Retained API semantic difference is empty');
  const additions = resolve(root, 'tests/contract/guide-progress-api.json');
  const addedDiff = semanticDifferences(
    JSON.parse(readFileSync(additions, 'utf8')),
    parts.addition,
  );
  if (addedDiff.length)
    throw new Error(
      `Approved guide progress API drift:\n${addedDiff.join('\n')}`,
    );
  console.log('Approved guide progress API semantic difference is empty');
  const motionDiff = semanticDifferences(
    JSON.parse(
      readFileSync(resolve(root, 'tests/contract/motion-api.json'), 'utf8'),
    ),
    motion.addition,
  );
  if (motionDiff.length)
    throw new Error('Approved motion API drift:\n' + motionDiff.join('\n'));
  console.log('Approved motion API semantic difference is empty');
  const sessionDiff = semanticDifferences(
    JSON.parse(
      readFileSync(resolve(root, 'tests/contract/session-api.json'), 'utf8'),
    ),
    sessions.addition,
  );
  if (sessionDiff.length)
    throw new Error('Approved Session API drift:\n' + sessionDiff.join('\n'));
  console.log('Approved Session API semantic difference is empty');
  const recordingDiff = semanticDifferences(
    JSON.parse(
      readFileSync(resolve(root, 'tests/contract/recording-api.json'), 'utf8'),
    ),
    recordings.addition,
  );
  if (recordingDiff.length)
    throw new Error(
      'Approved Recording API drift:\n' + recordingDiff.join('\n'),
    );
  console.log('Approved Recording API semantic difference is empty');
}
