import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  LabEntity,
  PersistentLab,
  DeviceProgramRun,
} from '../../packages/contracts/src/generated/types.gen.ts';
import { DirectoryLease } from '../../packages/server/src/platform/db/lease.ts';
import { ServerProcess, until } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
test('admitted trusted report keeps the actual process database lease through shutdown until the producer settles', async () => {
  const target = await new ServerProcess().create();
  target.entry = 'tests/support/device-report-process.ts';
  target.ipc = true;
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    const messages: Array<{ event: string; result?: string }> = [];
    target.child!.on('message', (value) =>
      messages.push(value as { event: string; result?: string }),
    );
    const client = new CoreHttp(target.url);
    await client.register('owner@example.test');
    const lab = await client.json<PersistentLab>(
        'POST',
        '/api/v1/lab/labs',
        { name: 'Drained report' },
        201,
      ),
      entity = await client.json<LabEntity>(
        'POST',
        '/api/v1/lab/labs/' + lab.id + '/entities',
        {
          name: 'Light',
          definition_id: 'light',
          definition_version: '1.0',
          reality: 'simulated',
          configuration: {},
          representation_id: null,
        },
        201,
      ),
      path = '/api/v1/lab/labs/' + lab.id + '/entities/' + entity.id,
      run = await client.json<DeviceProgramRun>(
        'POST',
        path + '/program/start',
        undefined,
        201,
      );
    target.child!.send({
      operation: 'report',
      binding: run.binding_id,
      run: run.id,
    });
    await until(
      async () =>
        messages.some((message) => message.event === 'report-admitted'),
      Boolean,
    );
    target.child!.send({ operation: 'stop' });
    await until(
      async () => messages.some((message) => message.event === 'stop-started'),
      Boolean,
    );
    await assert.rejects(DirectoryLease.acquire(target.directory));
    target.child!.send({ operation: 'release' });
    await until(
      async () => messages.some((message) => message.event === 'closed'),
      Boolean,
    );
    assert.ok(
      messages.some(
        (message) =>
          message.event === 'report-result' && message.result === 'applied',
      ),
    );
    await target.stop();
    const lease = await DirectoryLease.acquire(target.directory);
    await lease.release();
    target.entry = 'apps/server/src/main.ts';
    await target.start();
    const recovered = await client.json<LabEntity>('GET', path);
    assert.equal(recovered.program_run!.status, 'interrupted');
    assert.equal(recovered.observation!.properties.on.value, true);
  } finally {
    await target.cleanup();
  }
});
