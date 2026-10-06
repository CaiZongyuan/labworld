// M1 cache of immutable legacy documentation facts. This command reads literal
// Setting/FIELDS declarations; it never compiles or executes the frozen stack.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { root } from './lib/process.mjs';
const chain = [
  ['crates/platform/src/config.rs', 'FIELDS'],
  ['crates/platform/src/telemetry/settings.rs', 'FIELDS'],
  ['crates/app/src/modules/jobs/worker.rs', 'FIELDS'],
  ['crates/platform/src/cache.rs', 'FIELDS'],
  ['crates/app/src/modules/rate_limit/configuration.rs', 'FIELDS'],
  ['crates/platform/src/mail.rs', 'FIELDS'],
  ['crates/app/src/modules/mail/mod.rs', 'FIELDS'],
  ['crates/app/src/modules/identity/password_reset/mod.rs', 'FIELDS'],
  ['crates/app/src/modules/lab/history/retention.rs', 'RETENTION_FIELDS'],
  ['crates/app/src/modules/knowledge/exports/configuration.rs', 'FIELDS'],
];
const provenance = [
  'apps/api/src/bin/config-reference.rs',
  'crates/platform/src/telemetry/mod.rs',
  'crates/app/src/modules/jobs/mod.rs',
  'crates/app/src/modules/rate_limit/mod.rs',
  'crates/app/src/modules/identity/mod.rs',
  'crates/app/src/modules/lab/mod.rs',
  'crates/app/src/modules/lab/history.rs',
  'crates/app/src/modules/knowledge/mod.rs',
  'crates/app/src/modules/knowledge/exports/mod.rs',
  ...chain.map(([path]) => path),
];
const sourceHashes = Object.fromEntries(
  provenance.map((path) => [
    path,
    createHash('sha256')
      .update(readFileSync(join(root, path)))
      .digest('hex'),
  ]),
);
const string = '"(?:[^"\\\\]|\\\\.)*"';
function setting(body) {
  function literal(name) {
    const value = body.match(new RegExp(`\\b${name}:\\s*(${string})\\s*,`));
    if (!value) throw new Error(`Unresolved Setting ${name}`);
    return JSON.parse(value[1]);
  }
  const defaultValue = body.match(
    new RegExp(`\\bdefault:\\s*(None|Some\\((${string})\\))\\s*,`),
  );
  const secret = body.match(/\bsecret:\s*(true|false)\s*,/);
  if (!defaultValue || !secret)
    throw new Error('Unresolved Setting default or secret');
  return {
    name: literal('name'),
    default: defaultValue[1] === 'None' ? null : JSON.parse(defaultValue[2]),
    secret: secret[1] === 'true',
    description: literal('description'),
    descriptionZh: literal('description_zh'),
  };
}
const fields = chain.flatMap(([path, name]) => {
  const source = readFileSync(join(root, path), 'utf8');
  const declaration = source.match(
    new RegExp(
      `pub const ${name}:\\s*&\\[[^\\]]+\\]\\s*=\\s*&\\[([\\s\\S]*?)\\];`,
    ),
  );
  if (!declaration)
    throw new Error(`Missing literal field array ${path}:${name}`);
  const body = declaration[1];
  const inline = [...body.matchAll(/\bSetting\s*\{([\s\S]*?)\n\s*\}/g)];
  if (inline.length) {
    const remainder = body
      .replace(/\b(?:[a-z_]+::)*Setting\s*\{[\s\S]*?\n\s*\}/g, '')
      .replace(/[,\s]|\/\/[^\n]*/g, '');
    if (remainder)
      throw new Error(`Unresolved inline FIELDS expression: ${path}`);
    return inline.map((match) => setting(match[1]));
  }
  return body
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((constant) => {
      if (!/^[A-Z0-9_]+$/.test(constant))
        throw new Error('Unresolved constant FIELDS expression');
      const value = source.match(
        new RegExp(
          `const ${constant}:\\s*Setting\\s*=\\s*Setting\\s*\\{([\\s\\S]*?)\\n\\};`,
        ),
      );
      if (!value) throw new Error(`Unknown Setting constant ${constant}`);
      return setting(value[1]);
    });
});
if (new Set(fields.map((field) => field.name)).size !== fields.length)
  throw new Error('Duplicate legacy field');
const output = join(root, 'docs/reference/frozen-legacy-config.json');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(
  output,
  JSON.stringify(
    {
      sourceRef: 'cd28bb03c60ad05d01be83288bc24e2f0a90cdb1',
      provenance:
        'Frozen literal Setting/FIELDS declarations in config-reference order; no Rust execution. Node foundation configuration lives in apps/server/src/config.ts.',
      sourceHashes,
      fieldsChecksum: createHash('sha256')
        .update(JSON.stringify(fields))
        .digest('hex'),
      fields,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  `Frozen ${fields.length} legacy configuration fields with exact source hashes.`,
);
