import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldEvent } from '../../packages/contracts/src/generated/types.gen.ts';
import { WorldSubscriptions } from '../../packages/server/src/lab/world/subscriptions.ts';
import { WorldService } from '../../packages/server/src/lab/world/use-cases.ts';
import { deviceHttpFixture } from '../support/device-http.ts';
type Fixture = Awaited<ReturnType<typeof deviceHttpFixture>>;
const headers = (f: Fixture) =>
  new Headers({ cookie: f.client.cookie!, origin: f.target.url });
async function frame(
  manager: WorldSubscriptions,
  reader: ReadableStreamDefaultReader<Uint8Array>,
) {
  const pending = reader.read();
  await Promise.resolve();
  await manager.tick();
  const chunk = await pending;
  if (chunk.done) return undefined;
  const data = new TextDecoder().decode(chunk.value).trim().slice(6);
  assert.ok(Buffer.byteLength(data) <= 1024 * 1024);
  return JSON.parse(data) as WorldEvent;
}
test(
  'internal.sse-queue: logout before first Body transfer discards snapshot; a later login cannot revive its original credential',
  { timeout: 10000 },
  async () => {
    const f = await deviceHttpFixture(),
      manager = new WorldSubscriptions(
        new WorldService(f.context, f.policy),
        () => f.runtime.ready,
      );
    try {
      const response = await manager.subscribe(
        headers(f),
        'original-cookie-snapshot',
        f.lab.id,
      );
      await f.client.json('POST', '/api/v1/auth/logout', {}, 204);
      await f.client.login('member@example.test');
      const reader = response.body!.getReader();
      assert.deepEqual(await frame(manager, reader), { type: 'access_ended' });
      assert.equal((await reader.read()).done, true);
      const recovered = await manager.subscribe(
          headers(f),
          'new-cookie-snapshot',
          f.lab.id,
        ),
        fresh = recovered.body!.getReader();
      assert.equal((await frame(manager, fresh))!.type, 'snapshot');
      await fresh.cancel();
    } finally {
      await manager.stop();
      await f.close();
    }
  },
);
test(
  'internal.sse-queue: an actual unread Body permits eight pending events and discards them when a ninth event arrives',
  { timeout: 10000 },
  async () => {
    const f = await deviceHttpFixture(),
      manager = new WorldSubscriptions(
        new WorldService(f.context, f.policy),
        () => f.runtime.ready,
      );
    try {
      const eight = await manager.subscribe(
        headers(f),
        'eight-pending',
        f.lab.id,
      );
      for (let index = 0; index < 6; index++) await manager.tick();
      const reader = eight.body!.getReader();
      assert.equal((await frame(manager, reader))!.type, 'snapshot');
      await reader.cancel();
      const ninth = await manager.subscribe(
        headers(f),
        'ninth-pending',
        f.lab.id,
      );
      for (let index = 0; index < 7; index++) await manager.tick();
      const overflow = ninth.body!.getReader();
      const first = await overflow.read();
      assert.deepEqual(
        JSON.parse(new TextDecoder().decode(first.value).trim().slice(6)),
        { type: 'resync', reason: 'slow_client' },
      );
      assert.equal((await overflow.read()).done, true);
    } finally {
      await manager.stop();
      await f.close();
    }
  },
);
test(
  'internal.sse-queue: a commit after snapshot preparation appears after snapshot and runtime status with the original base version',
  { timeout: 10000 },
  async () => {
    const f = await deviceHttpFixture(),
      manager = new WorldSubscriptions(
        new WorldService(f.context, f.policy),
        () => f.runtime.ready,
      );
    try {
      const response = await manager.subscribe(
          headers(f),
          'snapshot-handoff',
          f.lab.id,
        ),
        entity = await f.register('labware'),
        reader = response.body!.getReader();
      const initial = await frame(manager, reader);
      assert.equal(initial!.type, 'snapshot');
      if (initial?.type !== 'snapshot') throw new Error('Expected snapshot');
      assert.equal(initial.world.entities.length, 0);
      assert.deepEqual(await frame(manager, reader), {
        type: 'runtime_status',
        available: true,
      });
      const update = await frame(manager, reader);
      assert.equal(update!.type, 'update');
      if (update?.type !== 'update') throw new Error('Expected update');
      assert.equal(update.base_version, initial.world.version);
      assert.ok(
        update.changes.some(
          (change) =>
            change.collection === 'entities' && change.id === entity.id,
        ),
      );
      await reader.cancel();
    } finally {
      await manager.stop();
      await f.close();
    }
  },
);
