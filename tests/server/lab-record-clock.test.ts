import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HistoryService } from '../../packages/server/src/lab/history/use-cases.ts';
import { RecordsService } from '../../packages/server/src/lab/records/use-cases.ts';
import {
  addSeconds,
  instantNanoseconds,
} from '../../packages/server/src/lab/time.ts';
import { deviceHttpFixture } from '../support/device-http.ts';
test('internal.sql: storage clock includes an acknowledged same-millisecond Command and freezes later commits out of cursor continuation', async () => {
  const f = await deviceHttpFixture();
  try {
    const entity = await f.register('light');
    await f.start(entity.id);
    const command = await f.action(
      entity.id,
      'light.set_power',
      { on: true },
      'acknowledged-before-query',
    );
    f.setTime(new Date(Date.parse(command.created_at)).toISOString());
    const records = new RecordsService(new HistoryService(f.context, f.policy)),
      headers = new Headers({ cookie: f.client.cookie! }),
      q = {
        from: addSeconds(command.created_at, -1),
        to: addSeconds(command.created_at, 1),
        entity_id: entity.id,
        limit: '1',
      };
    const first = await records.list(
      headers,
      'first-storage-query',
      f.lab.id,
      q,
    );
    assert.ok(
      instantNanoseconds(first.queried_at) >=
        instantNanoseconds(command.created_at),
    );
    const later = await f.action(
      entity.id,
      'light.set_power',
      { on: false },
      'after-storage-query',
    );
    const items = [...first.items];
    let cursor = first.next_cursor;
    while (cursor) {
      const next = await records.list(
        headers,
        'continued-storage-query-' + items.length,
        f.lab.id,
        { ...q, cursor },
      );
      assert.equal(next.query_upper_bound, first.query_upper_bound);
      items.push(...next.items);
      cursor = next.next_cursor;
    }
    assert.ok(items.some((item) => item.id === command.id));
    assert.ok(
      items.every(
        (item) => item.id !== later.id && item.command_id !== later.id,
      ),
    );
  } finally {
    await f.close();
  }
});
