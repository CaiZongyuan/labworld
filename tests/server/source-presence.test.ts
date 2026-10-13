import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { publishAsset } from '../support/lab-assets-http.ts';
import { sourceHttpFixture } from '../support/source-http.ts';
import { ServerProcess } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';

type Source = {
  id: string;
  lab_id: string;
  name: string;
  connection_state: 'offline' | 'connected';
  phase: 'initializing' | 'ready' | null;
  authorization: 'unconfigured' | 'authorized' | 'expired' | 'revoked';
  source_run_id: string | null;
  connection_id: string | null;
  epoch: string;
  last_seen_at: string | null;
};
type Configuration = {
  format: 'lab-world-source-v1';
  server_url: string;
  lab_id: string;
  source_id: string;
  machine_id: string;
  credential: string;
  expires_at: string;
};
type Connection = {
  connection_id: string;
  epoch: string;
  heartbeat_interval_ms: number;
};

test('a Member configures a source and its authenticated heartbeat becomes visible without a scene or Session', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    const member = new CoreHttp(target.url);
    await member.register('source-owner@example.test');
    const lab = await member.json<{ id: string }>(
      'POST',
      '/api/v1/lab/labs',
      { name: 'Source Lab' },
      201,
    );
    const base = `/api/v1/lab/labs/${lab.id}/sources`;
    const registered = await member.json<Source>(
      'POST',
      base,
      { name: 'Original Newton world' },
      201,
    );
    assert.equal(registered.connection_state, 'offline');
    assert.equal(registered.authorization, 'unconfigured');
    const config = await member.json<Configuration>(
      'POST',
      `${base}/${registered.id}/configuration`,
      {},
      201,
    );
    assert.equal(config.format, 'lab-world-source-v1');
    assert.equal(config.lab_id, lab.id);
    assert.equal(config.source_id, registered.id);
    const producer = new CoreHttp(target.url, {
      authorization: `Bearer ${config.credential}`,
    });
    const sourceRun = randomUUID();
    const connected = await producer.json<Connection>(
      'POST',
      `${base}/${registered.id}/connections`,
      {
        machine_id: config.machine_id,
        source_run_id: sourceRun,
        phase: 'initializing',
      },
      201,
    );
    await producer.json('POST', `${base}/${registered.id}/heartbeat`, {
      machine_id: config.machine_id,
      connection_id: connected.connection_id,
      epoch: connected.epoch,
      phase: 'ready',
    });
    const visible = await member.json<{ data: Source[] }>('GET', base);
    assert.equal(visible.data.length, 1);
    assert.equal(visible.data[0].connection_state, 'connected');
    assert.equal(visible.data[0].phase, 'ready');
    assert.equal(visible.data[0].source_run_id, sourceRun);
    assert.equal(visible.data[0].authorization, 'authorized');
    assert.equal(JSON.stringify(visible).includes(config.credential), false);
    const world = await member.json<{ entities: unknown[]; nodes: unknown[] }>(
      'GET',
      `/api/v1/lab/labs/${lab.id}/world`,
    );
    assert.deepEqual(world.entities, []);
    assert.deepEqual(world.nodes, []);
    assert.equal(target.logs.includes(config.credential), false);
  } finally {
    await target.cleanup();
  }
});

test('missing heartbeats go offline and expired credentials cannot restore a source or refresh device facts', async () => {
  const f = await sourceHttpFixture();
  try {
    const base = `/api/v1/lab/labs/${f.lab.id}/sources`;
    const source = await f.member.json<Source>(
      'POST',
      base,
      { name: 'Independent heartbeat' },
      201,
    );
    const path = `${base}/${source.id}`;
    const config = await f.member.json<Configuration>(
      'POST',
      path + '/configuration',
      {},
      201,
    );
    const producer = new CoreHttp(f.target.url, {
      authorization: `Bearer ${config.credential}`,
    });
    const run = randomUUID();
    const input = {
      machine_id: config.machine_id,
      source_run_id: run,
      phase: 'ready',
    };
    const before = await f.member.json<{ version: string }>(
      'GET',
      `/api/v1/lab/labs/${f.lab.id}/world`,
    );
    const first = await producer.json<Connection>(
      'POST',
      path + '/connections',
      input,
      201,
    );
    const seen = await f.member.json<Source>('GET', path);
    f.advance(5001);
    const stale = await f.member.json<Source>('GET', path);
    assert.equal(stale.connection_state, 'offline');
    assert.equal(stale.last_seen_at, seen.last_seen_at);
    assert.equal(stale.authorization, 'authorized');
    await producer.error(
      'POST',
      path + '/heartbeat',
      {
        machine_id: config.machine_id,
        connection_id: first.connection_id,
        epoch: first.epoch,
        phase: 'ready',
      },
      403,
      'lab.source_unauthorized',
    );
    const next = await producer.json<Connection>(
      'POST',
      path + '/connections',
      input,
      201,
    );
    assert(BigInt(next.epoch) > BigInt(first.epoch));
    f.advance(31 * 24 * 60 * 60 * 1000);
    const expired = await f.member.json<Source>('GET', path);
    assert.equal(expired.authorization, 'expired');
    assert.equal(expired.connection_state, 'offline');
    await producer.error(
      'POST',
      path + '/connections',
      input,
      403,
      'identity.machine_unauthorized',
    );
    const world = await f.member.json<{ version: string; entities: unknown[] }>(
      'GET',
      `/api/v1/lab/labs/${f.lab.id}/world`,
    );
    assert.equal(world.version, before.version);
    assert.deepEqual(world.entities, []);
  } finally {
    await f.close();
  }
});

test('Member and Agent administration stay separate from source grants, Lab scope and legacy publisher admission', async () => {
  const target = await new ServerProcess().create();
  target.env = {
    APP_ORIGIN: target.url,
    LAB_WORD_SYNTHETIC_SESSION: 'true',
    LAB_WORD_SYNTHETIC_MANAGED: 'false',
  };
  try {
    await target.start();
    const member = new CoreHttp(target.url);
    await member.register('source-scope@example.test');
    const lab = await member.json<{ id: string }>(
      'POST',
      '/api/v1/lab/labs',
      { name: 'Scoped Lab' },
      201,
    );
    const otherLab = await member.json<{ id: string }>(
      'POST',
      '/api/v1/lab/labs',
      { name: 'Other Lab' },
      201,
    );
    const base = `/api/v1/lab/labs/${lab.id}/sources`;
    await member.error('POST', base, { name: 'Denied' }, 403, 'auth.csrf', {
      'x-csrf-token': '',
    });
    const key = await member.json<{ secret: string }>(
      'POST',
      '/api/v1/api-keys',
      {
        name: 'Source administrator',
        scopes: ['lab:full'],
        expires_in_days: 1,
      },
      201,
    );
    const agent = new CoreHttp(target.url, {
      authorization: `Bearer ${key.secret}`,
    });
    const source = await agent.json<Source>(
      'POST',
      base,
      { name: 'Scoped source' },
      201,
    );
    const path = `${base}/${source.id}`;
    const config = await agent.json<Configuration>(
      'POST',
      path + '/configuration',
      {},
      201,
    );
    const producer = new CoreHttp(target.url, {
      authorization: `Bearer ${config.credential}`,
    });
    const input = {
      machine_id: config.machine_id.toUpperCase(),
      source_run_id: randomUUID(),
      phase: 'initializing',
    };
    await producer.error('GET', base, undefined, 401, 'auth.unauthorized');
    await producer.error(
      'POST',
      `/api/v1/lab/labs/${otherLab.id}/sources/${source.id}/connections`,
      input,
      403,
      'lab.source_unauthorized',
    );
    await member.error(
      'POST',
      path + '/connections',
      input,
      403,
      'identity.machine_unauthorized',
    );
    const asset = await publishAsset(
      member,
      await readFile('tests/fixtures/lab/cube.glb'),
    );
    const installation = await member.json<{ id: string }>(
      'POST',
      `/api/v1/lab/labs/${lab.id}/installations`,
      { representation_id: asset.representation.id },
      201,
    );
    const session = await member.json<{ id: string }>(
      'POST',
      `/api/v1/lab/labs/${lab.id}/sessions`,
      { installation_id: installation.id, machine_id: config.machine_id },
      201,
    );
    await producer.error(
      'POST',
      `/api/v1/lab/labs/${lab.id}/sessions/${session.id}/publisher-admissions`,
      { machine_id: config.machine_id },
      403,
      'identity.machine_unauthorized',
    );
    await producer.error(
      'POST',
      path + '/connections',
      input,
      404,
      'lab.source_transport_required',
      { 'x-forwarded-proto': 'https' },
    );
    const connected = await producer.json<Connection>(
      'POST',
      path + '/connections',
      input,
      201,
    );
    const reading = await producer.json<Source>('POST', path + '/heartbeat', {
      machine_id: config.machine_id.toUpperCase(),
      connection_id: connected.connection_id.toUpperCase(),
      epoch: connected.epoch,
      phase: 'ready',
    });
    assert.equal(reading.source_run_id, input.source_run_id);
    assert.equal(reading.phase, 'ready');
  } finally {
    await target.cleanup();
  }
});

test('source disconnect and Server restart preserve identity and source run while fencing old connection generations', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    const member = new CoreHttp(target.url);
    await member.register('source-restart@example.test');
    const lab = await member.json<{ id: string }>(
      'POST',
      '/api/v1/lab/labs',
      { name: 'Reconnect Lab' },
      201,
    );
    const base = `/api/v1/lab/labs/${lab.id}/sources`;
    const source = await member.json<Source>(
      'POST',
      base,
      { name: 'Continuing program' },
      201,
    );
    const path = `${base}/${source.id}`;
    const config = await member.json<Configuration>(
      'POST',
      path + '/configuration',
      {},
      201,
    );
    const producer = new CoreHttp(target.url, {
      authorization: `Bearer ${config.credential}`,
    });
    const run = randomUUID();
    const input = {
      machine_id: config.machine_id,
      source_run_id: run,
      phase: 'ready',
    };
    const connection = await producer.json<Connection>(
      'POST',
      path + '/connections',
      input,
      201,
    );
    const identity = {
      machine_id: config.machine_id,
      connection_id: connection.connection_id,
      epoch: connection.epoch,
    };
    await producer.json('POST', path + '/disconnect', identity, 204);
    assert.equal(
      (await member.json<Source>('GET', path)).connection_state,
      'offline',
    );
    const reconnect = await producer.json<Connection>(
      'POST',
      path + '/connections',
      input,
      201,
    );
    assert(BigInt(reconnect.epoch) > BigInt(connection.epoch));
    await producer.error(
      'POST',
      path + '/heartbeat',
      { ...identity, phase: 'ready' },
      403,
      'lab.source_unauthorized',
    );
    await target.stop();
    await target.start();
    const recovered = await member.json<Source>('GET', path);
    assert.equal(recovered.id, source.id);
    assert.equal(recovered.source_run_id, run);
    assert.equal(recovered.authorization, 'authorized');
    assert.equal(recovered.connection_state, 'offline');
    await producer.error(
      'POST',
      path + '/heartbeat',
      {
        ...identity,
        connection_id: reconnect.connection_id,
        epoch: reconnect.epoch,
        phase: 'ready',
      },
      403,
      'lab.source_unauthorized',
    );
    const current = await producer.json<Connection>(
      'POST',
      path + '/connections',
      input,
      201,
    );
    assert(BigInt(current.epoch) > BigInt(reconnect.epoch));
  } finally {
    await target.cleanup();
  }
});

test('live duplicates are refused and credential rotation and revoke fence previous source connections without changing identity', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    const member = new CoreHttp(target.url);
    await member.register('source-rotation@example.test');
    const lab = await member.json<{ id: string }>(
      'POST',
      '/api/v1/lab/labs',
      { name: 'Rotation Lab' },
      201,
    );
    const base = `/api/v1/lab/labs/${lab.id}/sources`;
    const source = await member.json<Source>(
      'POST',
      base,
      { name: 'Persistent world' },
      201,
    );
    const path = `${base}/${source.id}`;
    const first = await member.json<Configuration>(
      'POST',
      path + '/configuration',
      {},
      201,
    );
    const producer = new CoreHttp(target.url, {
      authorization: `Bearer ${first.credential}`,
    });
    const sourceRun = randomUUID();
    const input = {
      machine_id: first.machine_id,
      source_run_id: sourceRun,
      phase: 'ready',
    };
    const connected = await producer.json<Connection>(
      'POST',
      path + '/connections',
      input,
      201,
    );
    await producer.error(
      'POST',
      path + '/connections',
      { ...input, source_run_id: randomUUID() },
      409,
      'lab.source_connection_conflict',
    );
    const rotated = await member.json<Configuration>(
      'POST',
      path + '/configuration',
      {},
      201,
    );
    assert.equal(rotated.source_id, first.source_id);
    assert.notEqual(rotated.credential, first.credential);
    const heartbeat = {
      machine_id: first.machine_id,
      connection_id: connected.connection_id,
      epoch: connected.epoch,
      phase: 'ready',
    };
    await producer.error(
      'POST',
      path + '/heartbeat',
      heartbeat,
      403,
      'identity.machine_unauthorized',
    );
    const current = new CoreHttp(target.url, {
      authorization: `Bearer ${rotated.credential}`,
    });
    const next = await current.json<Connection>(
      'POST',
      path + '/connections',
      { ...input, machine_id: rotated.machine_id },
      201,
    );
    assert(BigInt(next.epoch) > BigInt(connected.epoch));
    await current.error(
      'POST',
      path + '/heartbeat',
      { ...heartbeat, machine_id: rotated.machine_id },
      403,
      'lab.source_unauthorized',
    );
    await member.json('POST', path + '/revoke', {}, 204);
    await current.error(
      'POST',
      path + '/heartbeat',
      {
        ...heartbeat,
        machine_id: rotated.machine_id,
        connection_id: next.connection_id,
        epoch: next.epoch,
      },
      403,
      'identity.machine_unauthorized',
    );
    const visible = await member.json<{ data: Source[] }>('GET', base);
    assert.equal(visible.data[0].id, source.id);
    assert.equal(visible.data[0].authorization, 'revoked');
    assert.equal(visible.data[0].connection_state, 'offline');
    assert.equal(visible.data[0].source_run_id, sourceRun);
    assert.equal(visible.data.length, 1);
  } finally {
    await target.cleanup();
  }
});
