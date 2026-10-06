import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  Database,
  SqlBudgetExceeded,
  sql,
  type DbMeasurement,
  type DbSession,
} from '../../packages/server/src/platform/db/index.ts';
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

test('authentication and business statements share the declared budget and rejection rolls back before COMMIT', async () => {
  const measurements: DbMeasurement[] = [];
  const db = new Database(undefined, (measurement) =>
    measurements.push(measurement),
  );
  try {
    await db.initialize();
    await db.script(
      { id: 'setup', kind: 'startup' },
      'create table labos_threejs_core.budget_probe(id integer)',
    );
    await assert.rejects(
      db.operation({ id: 'whole-request', kind: 'request' }, async () => {
        await db.read({ id: 'auth-phase', kind: 'request' }, async (tx) => {
          await tx.execute(sql`select 1`);
        });
        await db.transaction(
          { id: 'business-phase', kind: 'request', budget: 10 },
          async (tx) => {
            await tx.execute(
              sql`insert into labos_threejs_core.budget_probe values(1)`,
            );
            for (let index = 0; index < 7; index++)
              await tx.execute(sql`select 1`);
          },
        );
      }),
      SqlBudgetExceeded,
    );
    const rows = await db.readSQL<{ count: number }>(
      { id: 'verify', kind: 'request' },
      'select count(*)::integer as count from labos_threejs_core.budget_probe',
    );
    assert.equal(rows[0].count, 0);
    const measured = measurements.filter(
      (measurement) => measurement.id === 'whole-request',
    );
    assert.equal(measured.length, 1);
    assert.equal(measured[0].statements, 11);
    assert.equal(measured[0].outcome, 'error');
    assert.equal(measured[0].commands.includes('COMMIT'), false);
    assert.equal(measured[0].commands.includes('ROLLBACK'), true);
    await db.operation(
      { id: 'recovered-request', kind: 'request' },
      async () => {
        await db.read({ id: 'auth-recovered', kind: 'request' }, async (tx) => {
          await tx.execute(sql`select 1`);
        });
        await db.transaction(
          { id: 'business-recovered', kind: 'request', budget: 10 },
          async (tx) => {
            await tx.execute(
              sql`insert into labos_threejs_core.budget_probe values(2)`,
            );
            for (let index = 0; index < 6; index++)
              await tx.execute(sql`select 1`);
          },
        );
      },
    );
    const accepted = measurements.find(
      (measurement) => measurement.id === 'recovered-request',
    )!;
    assert.equal(accepted.statements, 10);
    assert.equal(accepted.outcome, 'ok');
    assert.equal(accepted.commands.includes('COMMIT'), true);
    assert.deepEqual(
      await db.readSQL(
        { id: 'read-recovered', kind: 'request' },
        'select id from labos_threejs_core.budget_probe',
      ),
      [{ id: 2 }],
    );
  } finally {
    await db.close();
  }
});

test('concurrent operation totals stay separate and expired scope/session capabilities cannot borrow later work', async () => {
  const measurements: DbMeasurement[] = [];
  const db = new Database(undefined, (measurement) =>
    measurements.push(measurement),
  );
  const first = barrier();
  const resume = barrier();
  let late: (() => Promise<unknown>) | undefined;
  let escaped: DbSession | undefined;
  try {
    await db.initialize();
    const a = db.operation({ id: 'request-a', kind: 'request' }, async () => {
      const captured = AsyncLocalStorage.snapshot();
      late = () =>
        captured(() =>
          db.read({ id: 'late-phase', kind: 'request' }, async (tx) => {
            await tx.execute(sql`select 99`);
          }),
        );
      escaped = await db.read({ id: 'auth-a', kind: 'request' }, async (tx) => {
        await tx.execute(sql`select 1`);
        return tx;
      });
      first.resolve();
      await resume.promise;
      await db.read({ id: 'read-a', kind: 'request' }, async (tx) => {
        await tx.execute(sql`select 2`);
      });
    });
    await Promise.race([first.promise, a]);
    await db.operation({ id: 'request-b', kind: 'request' }, () =>
      db.transaction({ id: 'read-b', kind: 'request' }, async (tx) => {
        await assert.rejects(escaped!.execute(sql`select 99`), (error) =>
          String((error as Error).cause).includes('expired'),
        );
        await tx.execute(sql`select 3`);
      }),
    );
    resume.resolve();
    await a;
    assert.equal(
      measurements.find((value) => value.id === 'request-a')!.statements,
      2,
    );
    assert.equal(
      measurements.find((value) => value.id === 'request-b')!.statements,
      3,
    );
    assert.equal(
      measurements.filter((value) => value.id.startsWith('request-')).length,
      2,
    );
    assert.ok(late);
    await assert.rejects(late(), /scope has expired/);
    assert.equal(
      measurements.some((value) => value.id === 'late-phase'),
      false,
    );
  } finally {
    resume.resolve();
    await db.close();
  }
});
