#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { withTestPostgres } from './lib/postgres.mjs';
import { root } from './lib/process.mjs';

// The deterministic query-plan report of spec §17.2: seed a disposable
// database with three fixed dataset sizes, run the two public list shapes
// under EXPLAIN ANALYZE, and write what the planner actually did to
// .scratch/perf/query-plans.json. This is report material, not a hard gate
// — a Seq Scan is recorded with the numbers around it, never failed, per
// spec §17.2 ("not all Seq Scans are errors"). The hard gates live in the
// perf_* integration tests and scripts/perf-bundle.mjs (just perf-ci).
// One caveat to keep in mind while reading plans: psql inlines the
// parameters as literals, so the planner may pick differently than it does
// for sqlx's prepared statements — the report shows plan shapes at scale,
// not a replica of the production path.

const TIERS = [10, 1_000, 100_000];

// The two list shapes of the visible-document contract (spec §17.1),
// mirrored from crates/app/src/modules/knowledge/application.rs
// (list_documents). Parameters follow that query's slot order: owner, grant
// bypass, cursor time, cursor id, limit, title pattern, base id. Keep in
// sync with the source.
const LIST_SQL = `
SELECT d.id::text, d.knowledge_base_id::text, d.title, d.version, d.created_at, d.updated_at
FROM knowledge.documents d
JOIN knowledge.knowledge_bases b ON b.id = d.knowledge_base_id
WHERE d.deleted_at IS NULL
  AND b.deleted_at IS NULL
  AND (($7::uuid IS NULL AND b.personal_owner = $1::uuid) OR b.id = $7::uuid)
  AND ($2 OR EXISTS (
        SELECT 1 FROM knowledge.grants g
        WHERE g.knowledge_base_id = b.id AND g.user_id = $1::uuid))
  AND ($3::timestamptz IS NULL OR (d.created_at, d.id) < ($3::timestamptz, $4::uuid))
  AND d.title ILIKE $6
ORDER BY d.created_at DESC, d.id DESC
LIMIT $5`;

const OWNER = '11111111-1111-1111-1111-111111111111';
const READER = '22222222-2222-2222-2222-222222222222';
const BASE = '33333333-3333-3333-3333-333333333333';

function psql(name, sql) {
  return execFileSync(
    'docker',
    [
      'exec',
      name,
      'psql',
      '-U',
      'postgres',
      '-d',
      'labos_threejs_test',
      '-v',
      'ON_ERROR_STOP=1',
      '-qAt',
      '-c',
      sql,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
}

function applyMigrations(name) {
  const migrations = readdirSync(join(root, 'migrations'))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const file of migrations) {
    execFileSync(
      'docker',
      [
        'exec',
        '-i',
        name,
        'psql',
        '-U',
        'postgres',
        '-d',
        'labos_threejs_test',
        '-v',
        'ON_ERROR_STOP=1',
        '-q',
        '-f',
        '-',
      ],
      {
        input: readFileSync(join(root, 'migrations', file)),
        stdio: ['pipe', 'ignore', 'inherit'],
      },
    );
  }
  return migrations.length;
}

function seed(name, rows) {
  // One psql batch, so the seed lands as a single transaction.
  psql(
    name,
    `SET client_min_messages = warning;
     TRUNCATE labos_threejs_core.users CASCADE;
     INSERT INTO labos_threejs_core.users (id, email, normalized_email, display_name)
     VALUES ('${OWNER}', 'perf-owner@example.test', 'perf-owner@example.test', '性能样本作者'),
            ('${READER}', 'perf-reader@example.test', 'perf-reader@example.test', '性能样本读者');
     INSERT INTO labos_threejs_core.credentials (user_id, password_hash)
     VALUES ('${OWNER}', 'not-a-real-hash'), ('${READER}', 'not-a-real-hash');
     INSERT INTO knowledge.knowledge_bases (id, name, personal_owner, created_by)
     VALUES ('${BASE}', '我的知识库', '${OWNER}', '${OWNER}');
     INSERT INTO knowledge.grants (knowledge_base_id, user_id, access)
     VALUES ('${BASE}', '${READER}', 'reader');
     INSERT INTO knowledge.documents
       (id, knowledge_base_id, title, markdown, version, created_by, updated_by, created_at, updated_at)
     SELECT gen_random_uuid(), '${BASE}', '性能样本 ' || g, '正文', 1,
            '${OWNER}', '${OWNER}',
            now() - (g || ' milliseconds')::interval,
            now() - (g || ' milliseconds')::interval
     FROM generate_series(1, ${rows}) g;
     ANALYZE knowledge.documents;`,
  );
}

function explain(name, params) {
  const withParams = LIST_SQL.replace(
    /\$(\d)(?:::([a-z]+))?/g,
    (_, slot, cast) => {
      const value = params[Number(slot) - 1];
      const literal = typeof value === 'string' ? `'${value}'` : String(value);
      return cast ? `${literal}::${cast}` : literal;
    },
  );
  const raw = psql(
    name,
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${withParams}`,
  ).trim();
  let report;
  try {
    [report] = JSON.parse(raw);
  } catch {
    throw new Error(`EXPLAIN output was not JSON: ${raw.slice(0, 400)}`);
  }
  const nodeTypes = {};
  let seqScans = 0;
  const walk = (node) => {
    nodeTypes[node['Node Type']] = (nodeTypes[node['Node Type']] ?? 0) + 1;
    if (node['Node Type'] === 'Seq Scan') seqScans += 1;
    if (node.Plans) node.Plans.forEach(walk);
  };
  walk(report.Plan);
  return {
    // EXPLAIN's Planning/Execution Time are already milliseconds.
    planningMs: +report['Planning Time'].toFixed(2),
    executionMs: +report['Execution Time'].toFixed(2),
    rootNode: report.Plan['Node Type'],
    rowsReturned: report.Plan['Actual Rows'],
    nodeTypes,
    seqScans,
    plan: report,
  };
}

const report = { generatedBy: 'scripts/perf-query-plans.mjs', tiers: [] };

await withTestPostgres(async ({ name }) => {
  const applied = applyMigrations(name);
  console.log(`Applied ${applied} migrations to a disposable database.`);

  for (const rows of TIERS) {
    seed(name, rows);
    const personal = explain(name, [
      OWNER,
      true,
      null,
      '44444444-4444-4444-4444-444444444444',
      51,
      '%',
      null,
    ]);
    const byBase = explain(name, [
      READER,
      false,
      null,
      '44444444-4444-4444-4444-444444444444',
      51,
      '%',
      BASE,
    ]);
    report.tiers.push({ rows, personalList: personal, byBaseList: byBase });
    const line = (label, shape) =>
      `${label}: ${shape.executionMs} ms, ${shape.rootNode}, ` +
      `seq scans ${shape.seqScans}`;
    console.log(`\n${rows} rows`);
    console.log(`  personal list  ${line('', personal).trim()}`);
    console.log(`  by-base list   ${line('', byBase).trim()}`);
  }
});

const reportPath = join(root, '.scratch', 'perf', 'query-plans.json');
mkdirSync(join(root, '.scratch', 'perf'), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nQuery-plan report written to ${reportPath}`);
