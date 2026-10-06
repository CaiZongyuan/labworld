import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Database,
  SqlBudgetExceeded,
  type DbMeasurement,
  sql,
} from '../../packages/server/src/platform/db/index.ts';

test('real executor applies retained migrations and meters statement/control results', async () => {
  const measured: DbMeasurement[] = [];
  const db = new Database(undefined, (m) => measured.push(m));
  try {
    await db.initialize();
    assert.equal(await db.ready('ready'), true);
    await db.read({ id: 'one', kind: 'request' }, async (tx) => {
      await tx.execute(sql`select 1`);
    });
    assert.equal(measured.at(-1)!.statements, 1);
    await db.transaction({ id: 'commit', kind: 'background' }, async (tx) => {
      await tx.execute(sql`select 1`);
    });
    assert.equal(measured.at(-1)!.statements, 3);
    await assert.rejects(
      db.transaction({ id: 'rollback', kind: 'request' }, async (tx) => {
        await tx.execute(sql`select 1`);
        throw new Error('intentional');
      }),
    );
    assert.equal(measured.at(-1)!.statements, 3);
    assert.ok(measured.at(-1)!.commands.some((x) => x.startsWith('ROLLBACK')));
    await assert.rejects(
      db.read({ id: 'regression', kind: 'request', budget: 10 }, async (tx) => {
        for (let i = 0; i < 11; i++) await tx.execute(sql`select 1`);
      }),
      SqlBudgetExceeded,
    );
  } finally {
    await db.close();
  }
});

test('expired sessions cannot dispatch SQL outside their admitted operation or borrow another operation', async () => {
  const db = new Database();
  try {
    await db.initialize();
    const escaped = await db.read(
      { id: 'escape', kind: 'request' },
      async (tx) => tx,
    );
    await assert.rejects(
      escaped.execute(sql`create table lab.illegal_escape(id integer)`),
      (error: unknown) => String((error as Error).cause).includes('expired'),
    );
    await db.read({ id: 'other', kind: 'request' }, async (tx) => {
      await assert.rejects(
        escaped.execute(sql`create table lab.illegal_escape(id integer)`),
        (error: unknown) => String((error as Error).cause).includes('expired'),
      );
      const result = await tx.execute<{ found: string | null }>(
        sql`select to_regclass('lab.illegal_escape') as found`,
      );
      assert.equal(result.rows[0].found, null);
    });
  } finally {
    await db.close();
  }
});

test('lease loss during an admitted transaction prevents the next write and commit, then rollback preserves prior state', async () => {
  const measured: DbMeasurement[] = [];
  const db = new Database(undefined, (m) => measured.push(m));
  try {
    await db.initialize();
    await db.read({ id: 'setup', kind: 'request' }, async (tx) => {
      await tx.execute(sql`create table lab.lease_probe(id integer)`);
    });
    await assert.rejects(
      db.transaction({ id: 'lost', kind: 'background' }, async (tx) => {
        await tx.execute(sql`insert into lab.lease_probe values(1)`);
        db.loseLease();
        await tx.execute(sql`insert into lab.lease_probe values(2)`);
      }),
      /lease/,
    );
    const result = measured.find((m) => m.id === 'lost')!;
    assert.deepEqual(result.commands, ['BEGIN', 'INSERT 0 1', 'ROLLBACK']);
    assert.equal(result.outcome, 'error');
  } finally {
    await db.close();
  }
});

test('a budget-rejected write transaction rolls back instead of acknowledging a failed durable commit', async () => {
  const db = new Database();
  try {
    await db.initialize();
    await db.read({ id: 'setup', kind: 'request' }, async (tx) => {
      await tx.execute(sql`create table lab.budget_probe(id integer)`);
    });
    await assert.rejects(
      db.transaction(
        { id: 'overbudget-write', kind: 'request', budget: 2 },
        async (tx) => {
          await tx.execute(sql`insert into lab.budget_probe values(1)`);
        },
      ),
      SqlBudgetExceeded,
    );
    const rows = await db.readSQL<{ count: number }>(
      { id: 'verify', kind: 'request' },
      'select count(*)::integer as count from lab.budget_probe',
    );
    assert.equal(rows[0].count, 0);
    await db.transaction(
      { id: 'recovery', kind: 'request', budget: 3 },
      async (tx) => {
        await tx.execute(sql`insert into lab.budget_probe values(2)`);
      },
    );
    assert.deepEqual(
      await db.readSQL(
        { id: 'recover-read', kind: 'request' },
        'select id from lab.budget_probe',
      ),
      [{ id: 2 }],
    );
  } finally {
    await db.close();
  }
});
