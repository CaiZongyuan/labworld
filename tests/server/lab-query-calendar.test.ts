import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  PersistentLab,
  LabWorld,
  LabRecordsPage,
} from '../../packages/contracts/src/generated/types.gen.ts';
import { ServerProcess } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
test('invalid calendar query returns 400 without changing World and a valid date retry reads records', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    await new CoreHttp(target.url).register('owner@example.test');
    const client = new CoreHttp(target.url);
    await client.register('member@example.test');
    const lab = await client.json<PersistentLab>(
        'POST',
        '/api/v1/lab/labs',
        { name: 'Calendar bounds' },
        201,
      ),
      path = '/api/v1/lab/labs/' + lab.id;
    const before = await client.json<LabWorld>('GET', path + '/world');
    await client.error(
      'GET',
      path +
        '/records?' +
        new URLSearchParams({
          from: '2026-02-30T00:00:00Z',
          to: '2026-03-03T00:00:00Z',
        }),
      undefined,
      400,
      'http.invalid_query',
    );
    assert.deepEqual(
      await client.json<LabWorld>('GET', path + '/world'),
      before,
    );
    assert.equal(
      (
        await client.json<LabRecordsPage>(
          'GET',
          path +
            '/records?' +
            new URLSearchParams({
              from: '2026-03-02T00:00:00Z',
              to: '2026-03-03T00:00:00Z',
            }),
        )
      ).items.length,
      0,
    );
  } finally {
    await target.cleanup();
  }
});
