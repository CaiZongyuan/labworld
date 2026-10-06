import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Database,
  sql,
  migrationsDirectory,
  type DbMeasurement,
} from '../../packages/server/src/platform/db/index.ts';
import { DirectoryLease } from '../../packages/server/src/platform/db/lease.ts';
const retained = [
  'labos_threejs_core.api_keys',
  'labos_threejs_core.audit_events',
  'labos_threejs_core.credentials',
  'labos_threejs_core.file_candidates',
  'labos_threejs_core.file_cleanup_control',
  'labos_threejs_core.files',
  'labos_threejs_core.idempotency_records',
  'labos_threejs_core.memberships',
  'labos_threejs_core.object_cleanup',
  'labos_threejs_core.organizations',
  'labos_threejs_core.sessions',
  'labos_threejs_core.users',
  'lab.asset_representations',
  'lab.asset_uploads',
  'lab.assets',
  'lab.command_receipts',
  'lab.current_observations',
  'lab.device_commands',
  'lab.device_events',
  'lab.device_task_results',
  'lab.device_tasks',
  'lab.entities',
  'lab.entity_relationships',
  'lab.history_bounds',
  'lab.labs',
  'lab.observation_history',
  'lab.program_runs',
  'lab.runtime_bindings',
  'lab.runtime_generation',
  'lab.scene_nodes',
  'lab.world_clock',
];

test('retained qualified schema supports UUID/JSONB/CTE/RETURNING, checks, composite FKs, partial indexes and lifecycle triggers', async () => {
  const measured: DbMeasurement[] = [];
  const db = new Database(undefined, (m) => measured.push(m));
  try {
    await db.initialize();
    const catalog = await db.readSQL<{ name: string }>(
      { id: 'catalog', kind: 'request' },
      "select schemaname||'.'||tablename as name from pg_tables where schemaname in ('lab','labos_threejs_core')",
    );
    assert.deepEqual(
      catalog.map((r) => r.name).sort(),
      retained.slice().sort(),
    );
    const identity = await db.readSQL<{ id: string }>(
      { id: 'uuid-cte', kind: 'request' },
      "with inserted as (insert into labos_threejs_core.users(email,normalized_email) values('schema@example.test','schema@example.test') returning id) select id from inserted",
    );
    const actor = identity[0].id;
    assert.match(actor, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    await assert.rejects(
      db.readSQL(
        { id: 'bad-check', kind: 'request' },
        "insert into labos_threejs_core.organizations(id,name) values(2,'invalid')",
      ),
    );
    await db.readSQL(
      { id: 'valid-recovery', kind: 'request' },
      "insert into labos_threejs_core.organizations(id,name) values(1,'valid')",
    );
    const labs = await db.readSQL<{ id: string }>(
      { id: 'labs', kind: 'request' },
      "insert into lab.labs(name,created_by) values('first',$1),('second',$1) returning id",
      [actor],
    );
    const entity = await db.readSQL<{ id: string }>(
      { id: 'entity', kind: 'request' },
      "insert into lab.entities(lab_id,name,kind,reality,definition_id,definition_version,definition,configuration,created_by,updated_by) values($1,'one','equipment','simulated','sensor','1.0','{\"properties\":{\"temperature\":{\"type\":\"number\"}}}','{}',$2,$2) returning id",
      [labs[0].id, actor],
    );
    const entityId = entity[0].id;
    const bounds = await db.readSQL<{ count: number }>(
      { id: 'bounds', kind: 'request' },
      'select count(*)::integer as count from lab.history_bounds where entity_id=$1',
      [entityId],
    );
    assert.equal(bounds[0].count, 4);
    await assert.rejects(
      db.readSQL(
        { id: 'cross-lab', kind: 'request' },
        "insert into lab.scene_nodes(lab_id,entity_id,placement) values($1,$2,'{}')",
        [labs[1].id, entityId],
      ),
    );
    await assert.rejects(
      db.readSQL(
        { id: 'self-relationship', kind: 'request' },
        "insert into lab.entity_relationships(lab_id,source_id,target_id,kind,registered_by) values($1,$2,$2,'contains',$3)",
        [labs[0].id, entityId, actor],
      ),
    );
    const binding = await db.readSQL<{ id: string }>(
      { id: 'binding', kind: 'request' },
      "insert into lab.runtime_bindings(entity_id,program_id,source,definition_id,definition_version,definition) values($1,'sensor.v1','synthetic:1','sensor','1.0','{}') returning id",
      [entityId],
    );
    await assert.rejects(
      db.readSQL(
        { id: 'duplicate-current', kind: 'request' },
        "insert into lab.runtime_bindings(entity_id,program_id,source,definition_id,definition_version,definition) values($1,'sensor.v1','synthetic:2','sensor','1.0','{}')",
        [entityId],
      ),
    );
    await db.readSQL(
      { id: 'retired-binding', kind: 'request' },
      "insert into lab.runtime_bindings(entity_id,program_id,source,current,definition_id,definition_version,definition) values($1,'sensor.v1','synthetic:retired',false,'sensor','1.0','{}')",
      [entityId],
    );
    const run = await db.readSQL<{ id: string }>(
      { id: 'run', kind: 'request' },
      "insert into lab.program_runs(entity_id,binding_id,generation,configuration,status,started_by) values($1,$2,1,'{\"interval_ms\":1000}','running',$3) returning id",
      [entityId, binding[0].id, actor],
    );
    const runId = run[0].id;
    await assert.rejects(
      db.readSQL(
        { id: 'duplicate-running', kind: 'request' },
        "insert into lab.program_runs(entity_id,binding_id,generation,configuration,status,started_by) values($1,$2,1,'{}','running',$3)",
        [entityId, binding[0].id, actor],
      ),
    );
    const before = await db.readSQL<{ count: number }>(
      { id: 'events-before', kind: 'request' },
      'select count(*)::integer as count from lab.device_events where run_id=$1',
      [runId],
    );
    assert.equal(before[0].count, 1);
    await db.readSQL(
      { id: 'same-run-status', kind: 'request' },
      'update lab.program_runs set sequence=1 where id=$1',
      [runId],
    );
    const after = await db.readSQL<{ count: number }>(
      { id: 'events-after', kind: 'request' },
      'select count(*)::integer as count from lab.device_events where run_id=$1',
      [runId],
    );
    assert.equal(after[0].count, 1);
    const command = await db.readSQL<{ id: string }>(
      { id: 'command', kind: 'request' },
      "insert into lab.device_commands(entity_id,run_id,actor_id,actor_source,request_key,capability,parameters,status) values($1,$2,$3,'member','key','start','{}','accepted') returning id",
      [entityId, runId, actor],
    );
    const task = await db.transaction(
      { id: 'deferred-cycle', kind: 'request', budget: 10 },
      async (tx) => {
        const result = await tx.execute<{ task_id: string; result_id: string }>(
          sql`with ids as (select gen_random_uuid() as task_id,gen_random_uuid() as result_id), inserted as (insert into lab.device_tasks(id,entity_id,run_id,command_id,result_id,parameters,status) select task_id,${entityId}::uuid,${runId}::uuid,${command[0].id}::uuid,result_id,'{}','pending' from ids returning id,result_id) insert into lab.device_task_results(id,task_id,status) select result_id,id,'pending' from inserted returning task_id,id as result_id`,
        );
        return result.rows[0];
      },
    );
    await assert.rejects(
      db.transaction(
        { id: 'duplicate-active-task', kind: 'request' },
        async (tx) => {
          await tx.execute(
            sql`insert into lab.device_tasks(entity_id,run_id,command_id,result_id,parameters,status) values(${entityId}::uuid,${runId}::uuid,gen_random_uuid(),gen_random_uuid(),'{}','pending')`,
          );
        },
      ),
    );
    await db.readSQL(
      { id: 'link-task', kind: 'request' },
      'update lab.device_commands set task_id=$1 where id=$2',
      [task.task_id, command[0].id],
    );
    await db.readSQL(
      { id: 'expire-command', kind: 'request' },
      'delete from lab.device_commands where id=$1',
      [command[0].id],
    );
    const still = await db.readSQL<{ command_id: string }>(
      { id: 'retained-task', kind: 'request' },
      'select command_id from lab.device_tasks where id=$1',
      [task.task_id],
    );
    assert.equal(still[0].command_id, command[0].id);
    await db.readSQL(
      { id: 'remove-task', kind: 'request' },
      'delete from lab.device_tasks where id=$1',
      [task.task_id],
    );
    assert.deepEqual(
      await db.readSQL(
        { id: 'result-cascade', kind: 'request' },
        'select id from lab.device_task_results where id=$1',
        [task.result_id],
      ),
      [],
    );
    const json = await db.readSQL<{ value: string }>(
      { id: 'jsonb', kind: 'request' },
      "select definition #>> '{properties,temperature,type}' as value from lab.entities where id=$1",
      [entityId],
    );
    assert.equal(json[0].value, 'number');
    const world = await db.readSQL<{ version: number }>(
      { id: 'world-clock', kind: 'request' },
      'select version from lab.world_clock',
    );
    assert.ok(Number(world[0].version) > 0);
    await db.script(
      { id: 'quoted-calibration', kind: 'request' },
      "create function lab.meter_semicolon() returns text language plpgsql as $$begin return ';'; end;$$; select ';' as quoted; select lab.meter_semicolon();",
    );
    assert.equal(measured.at(-1)!.statements, 3);
    await assert.rejects(
      db.script(
        { id: 'failed-multi', kind: 'request' },
        "select 1; insert into labos_threejs_core.organizations(id,name) values(2,'invalid'); select 2;",
      ),
    );
    assert.equal(measured.at(-1)!.statements, 2);
    assert.equal(await db.ready('after-error'), true);
    const explain = await db.readSQL(
      { id: 'explain', kind: 'request' },
      'explain select id from lab.observation_history where entity_id=$1 order by received_at desc,id desc limit 100',
      [entityId],
    );
    assert.ok(explain.length > 0);
  } finally {
    await db.close();
  }
});

test(
  'a failed actual Drizzle migration rolls back; reopening with the bundle applies once and preserves history',
  { timeout: 60000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lab-word-migration-'));
    const migrationCopy = await mkdtemp(
      join(tmpdir(), 'lab-word-bad-migration-'),
    );
    let lease = await DirectoryLease.acquire(directory);
    let db = new Database(lease);
    try {
      await cp(migrationsDirectory, migrationCopy, { recursive: true });
      const journalPath = join(migrationCopy, 'meta/_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      const failureIndex = journal.entries.at(-1).idx + 1;
      const failureTag = `${String(failureIndex).padStart(4, '0')}_failure`;
      journal.entries.push({
        idx: failureIndex,
        version: '7',
        when: journal.entries.at(-1).when + 1,
        tag: failureTag,
        breakpoints: true,
      });
      await writeFile(journalPath, JSON.stringify(journal));
      await writeFile(
        join(migrationCopy, `${failureTag}.sql`),
        'CREATE TABLE lab.failed_migration(id integer);\n--> statement-breakpoint\nSELECT impossible_column FROM lab.failed_migration;',
      );
      await assert.rejects(db.initialize(migrationCopy));
      await db.close();
      await lease.release();
      lease = await DirectoryLease.acquire(directory);
      db = new Database(lease);
      await db.initialize();
      assert.deepEqual(
        await db.readSQL(
          { id: 'failed-table-absent', kind: 'request' },
          "select to_regclass('lab.failed_migration') as table_name",
        ),
        [{ table_name: null }],
      );
      const first = await db.readSQL(
        { id: 'first-history', kind: 'request' },
        'select hash,created_at from drizzle.__drizzle_migrations',
      );
      await db.close();
      await lease.release();
      lease = await DirectoryLease.acquire(directory);
      db = new Database(lease);
      await db.initialize();
      assert.deepEqual(
        await db.readSQL(
          { id: 'reopen-history', kind: 'request' },
          'select hash,created_at from drizzle.__drizzle_migrations',
        ),
        first,
      );
    } finally {
      await db.close();
      await lease.release();
      await rm(directory, { recursive: true, force: true });
      await rm(migrationCopy, { recursive: true, force: true });
    }
  },
);
