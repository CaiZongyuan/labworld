import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerProcess } from '../support/server-process.ts';
import { Database } from '../../packages/server/src/platform/db/index.ts';
import { utcInstant } from '../../packages/server/src/platform/db/instant.ts';

test('direct driver timestamps preserve distinct microseconds and UTC offsets', async () => {
  const db = new Database();
  try {
    await db.initialize();
    const rows = await db.readSQL<{
      first: string;
      second: string;
      offset: string;
    }>(
      { id: 'precision', kind: 'request' },
      "select '2026-10-05T00:00:00.123456Z'::timestamptz as first,'2026-10-05T00:00:00.123457Z'::timestamptz as second,'2026-10-05T08:00:00.123457+08:00'::timestamptz as offset",
    );
    assert.equal(utcInstant(rows[0].first), '2026-10-05T00:00:00.123456Z');
    assert.equal(utcInstant(rows[0].second), '2026-10-05T00:00:00.123457Z');
    assert.equal(utcInstant(rows[0].offset), '2026-10-05T00:00:00.123457Z');
  } finally {
    await db.close();
  }
});

test(
  'Drizzle persistence, public serialization, ordering and opaque cursors preserve same-millisecond instants after reopen',
  { timeout: 60000 },
  async () => {
    const target = await new ServerProcess().create();
    target.entry = 'tests/support/spike-process.ts';
    try {
      await target.start();
      const seed = (await (
        await fetch(`${target.url}/proof/devices`)
      ).json()) as { devices: Array<{ entity_id: string }> };
      const entityId = seed.devices[0].entity_id;
      const older = {
        id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        entity_id: entityId,
        received_at: '2026-10-05T00:00:00.123456Z',
        value: 1,
        sequence: 1,
      };
      const newer = {
        id: '00000000-0000-4000-8000-000000000001',
        entity_id: entityId,
        received_at: '2026-10-05T08:00:00.123457+08:00',
        value: 2,
        sequence: 2,
      };
      for (const sample of [older, newer])
        assert.equal(
          (
            await fetch(`${target.url}/proof/samples`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify([sample]),
            })
          ).status,
          201,
        );
      for (let attempt = 0; attempt < 2; attempt++) {
        const first = (await (
          await fetch(
            `${target.url}/proof/history?entity_id=${entityId}&limit=1`,
          )
        ).json()) as {
          items: Array<{
            id: string;
            received_at: string;
            data: { received_at: string };
          }>;
          next_cursor: string;
        };
        assert.equal(first.items[0].id, newer.id);
        assert.equal(first.items[0].received_at, '2026-10-05T00:00:00.123457Z');
        assert.equal(first.items[0].data.received_at, newer.received_at);
        assert.ok(first.next_cursor);
        const next = (await (
          await fetch(
            `${target.url}/proof/history?entity_id=${entityId}&limit=1&cursor=${first.next_cursor}`,
          )
        ).json()) as typeof first;
        assert.equal(next.items[0].id, older.id);
        assert.equal(next.items[0].received_at, older.received_at);
        assert.equal(next.items[0].data.received_at, older.received_at);
        assert.equal(next.next_cursor, null);
        if (!attempt) {
          await target.stop();
          await target.start();
        }
      }
    } finally {
      await target.cleanup();
    }
  },
);
