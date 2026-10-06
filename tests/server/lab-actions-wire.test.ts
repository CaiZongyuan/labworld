import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  LabEntity,
  PersistentLab,
  DeviceCommand,
  LabWorld,
} from '../../packages/contracts/src/generated/types.gen.ts';
import { ServerProcess, until } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
test('unknown action envelope field refuses before Command creation; removing it permits the same-key actual execution', async () => {
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
      { name: 'Typed action envelope' },
      201,
    );
    const entity = await client.json<LabEntity>(
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
    );
    const path = '/api/v1/lab/labs/' + lab.id + '/entities/' + entity.id;
    await client.json('POST', path + '/program/start', undefined, 201);
    const read = () =>
        client.json<LabWorld>('GET', '/api/v1/lab/labs/' + lab.id + '/world'),
      before = await read(),
      headers = { 'idempotency-key': 'same-envelope-attempt' };
    await client.error(
      'POST',
      path + '/actions',
      {
        capability: 'light.set_power',
        parameters: { on: true },
        unexpected: true,
      },
      400,
      'http.invalid_json',
      headers,
    );
    assert.deepEqual(await read(), before);
    const command = await client.json<DeviceCommand>(
      'POST',
      path + '/actions',
      { capability: 'light.set_power', parameters: { on: true } },
      202,
      headers,
    );
    const result = await until(
      () => client.json<DeviceCommand>('GET', path + '/commands/' + command.id),
      (value) => value.status === 'succeeded',
    );
    assert.equal(result.id, command.id);
    assert.equal(
      (await client.json<LabEntity>('GET', path)).observation!.properties.on
        .value,
      true,
    );
  } finally {
    await target.cleanup();
  }
});
