import { beforeAll, expect, test } from 'vitest';
import type {
  Member,
  MemberPage,
} from '../../packages/contracts/src/generated/types.gen';
import { HttpClient, member } from './http';
import { createLab, register, world } from './lab';
import { WorldStream } from './sse';
let client: HttpClient;
beforeAll(async () => {
  client = await member();
});

test('SSE-01 TCP snapshot precedes versioned updates; disconnect reconnects authoritative world under event byte budget', async () => {
  const lab = await createLab(client, 'TCP world');
  const initial = await world(client, lab.id);
  const stream = await WorldStream.open(client, lab.id);
  try {
    const first = await stream.next();
    expect(first?.type).toBe('snapshot');
    if (first?.type !== 'snapshot')
      throw new Error('First event must be snapshot');
    expect(first.world).toEqual(initial);
    const status = await stream.event('runtime_status');
    expect(status).toMatchObject({ available: true });
    const entity = await register(client, lab.id, 'labware');
    const update = await stream.event('update');
    if (update.type !== 'update') throw new Error('Expected update');
    expect(update.base_version).toBe(initial.version);
    expect(update.version).not.toBe(initial.version);
    expect(update.changes).toContainEqual(
      expect.objectContaining({ collection: 'entities', id: entity.id }),
    );
    stream.close();
    await client.json(
      'PATCH',
      `/api/v1/lab/labs/${lab.id}/entities/${entity.id}`,
      { name: 'While disconnected', configuration: {} },
    );
    const current = await world(client, lab.id);
    const reconnected = await WorldStream.open(client, lab.id);
    try {
      const snapshot = await reconnected.next();
      expect(snapshot).toEqual({ type: 'snapshot', world: current });
    } finally {
      reconnected.close();
    }
  } finally {
    stream.close();
  }
});

async function terminated(stream: WorldStream) {
  const event = await stream.event('access_ended');
  expect(event).toEqual({ type: 'access_ended' });
  expect(await stream.next()).toBeUndefined();
}
test('SSE-02 Agent revocation and session logout close existing subscriptions, deny reconnect, and new credentials recover', async () => {
  const lab = await createLab(client, 'Revocable streams');
  const { client: agent, credential } = await client.agent();
  const stream = await WorldStream.open(agent, lab.id);
  try {
    expect((await stream.next())?.type).toBe('snapshot');
    await client.json(
      'DELETE',
      `/api/v1/api-keys/${credential.key.id}`,
      undefined,
      204,
    );
    await terminated(stream);
    await agent.error(
      'GET',
      `/api/v1/lab/labs/${lab.id}/world/subscribe`,
      undefined,
      401,
    );
  } finally {
    stream.close();
  }
  const observer = new HttpClient();
  await observer.login(client.session!.user.email);
  const sessionStream = await WorldStream.open(observer, lab.id);
  try {
    expect((await sessionStream.next())?.type).toBe('snapshot');
    await observer.json('POST', '/api/v1/auth/logout', {}, 204);
    await terminated(sessionStream);
    await observer.error(
      'GET',
      `/api/v1/lab/labs/${lab.id}/world/subscribe`,
      undefined,
      401,
    );
  } finally {
    sessionStream.close();
  }
  await observer.login(client.session!.user.email);
  const recovered = await WorldStream.open(observer, lab.id);
  try {
    expect((await recovered.next())?.type).toBe('snapshot');
  } finally {
    recovered.close();
  }
});

test('SSE-03 inactive membership ends Member and Agent streams; Owner reactivation plus new session recovers same world', async () => {
  const target = await member();
  const owner = new HttpClient();
  await owner.login(process.env.CONTRACT_OWNER_EMAIL!);
  const lab = await createLab(target, 'Inactive streams');
  const { client: agent } = await target.agent();
  const a = await WorldStream.open(target, lab.id),
    b = await WorldStream.open(agent, lab.id);
  try {
    expect((await a.next())?.type).toBe('snapshot');
    expect((await b.next())?.type).toBe('snapshot');
    const members = await owner.json<MemberPage>(
      'GET',
      '/api/v1/organization/members',
    );
    const current = members.data.find(
      (entry) => entry.user_id === target.session!.user.id,
    )!;
    const disabled = await owner.json<Member>(
      'PUT',
      `/api/v1/organization/members/${current.user_id}`,
      { role: current.role, active: false, version: current.version },
    );
    await Promise.all([terminated(a), terminated(b)]);
    await target.error(
      'GET',
      `/api/v1/lab/labs/${lab.id}/world/subscribe`,
      undefined,
      401,
    );
    await agent.error(
      'GET',
      `/api/v1/lab/labs/${lab.id}/world/subscribe`,
      undefined,
      401,
    );
    const retained = await world(owner, lab.id);
    expect(retained.lab.id).toBe(lab.id);
    await owner.json('PUT', `/api/v1/organization/members/${current.user_id}`, {
      role: current.role,
      active: true,
      version: disabled.version,
    });
    await target.login(target.session!.user.email);
    const restored = await WorldStream.open(target, lab.id);
    try {
      const first = await restored.next();
      expect(first?.type).toBe('snapshot');
      if (first?.type === 'snapshot') expect(first.world.lab.id).toBe(lab.id);
    } finally {
      restored.close();
    }
  } finally {
    a.close();
    b.close();
  }
});
