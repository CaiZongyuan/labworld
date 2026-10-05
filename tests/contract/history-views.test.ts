import { afterAll, beforeAll, expect, test } from 'vitest';
import type {
  LabEntity,
  HistoryPage,
  EntityTrend,
  LabRecordsPage,
  RetentionPolicy,
  DeviceProgramRun,
  ObservationProperty,
} from '../../packages/contracts/src/generated/types.gen';
import { HttpClient, member, until } from './http';
import {
  action,
  createLab,
  entityPath,
  readEntity,
  register,
  settledCommand,
  start,
  world,
} from './lab';
let client: HttpClient,
  agent: HttpClient,
  lab: string,
  sensor: LabEntity,
  light: LabEntity,
  from: string,
  to: string;
let sensorRun: DeviceProgramRun;
async function bounded<T>(path: string, actor = client) {
  const response = await actor.response('GET', path);
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(256 * 1024);
  return JSON.parse(text) as T;
}
const params = (extra: Record<string, string> = {}) =>
  new URLSearchParams({ from, to, ...extra });
const history = (
  id: string,
  kind = 'observation',
  extra: Record<string, string> = {},
) =>
  `${entityPath(lab, id)}/history?${params({ record_type: kind, ...extra })}`;
const trend = (extra: Record<string, string> = {}) =>
  `${entityPath(lab, sensor.id)}/trend?${params({ property: 'temperature', ...extra })}`;
const records = (extra: Record<string, string> = {}) =>
  `/api/v1/lab/labs/${lab}/records?${params(extra)}`;
function instant(timestamp: string) {
  const fraction =
    timestamp.match(/\.([0-9]+)(?:Z|[+-][0-9]{2}:[0-9]{2})$/)?.[1] ?? '';
  return (
    BigInt(Date.parse(timestamp)) * 1000000n +
    BigInt(fraction.padEnd(9, '0').slice(3, 9))
  );
}
beforeAll(async () => {
  client = await member();
  agent = (await client.agent()).client;
  lab = (await createLab(client, 'History read models')).id;
  from = new Date(Date.now() - 60_000).toISOString();
  sensor = await register(client, lab, 'sensor', { baseline_temperature: 20 });
  light = await register(client, lab, 'light');
  sensorRun = await start(client, lab, sensor.id);
  await start(client, lab, light.id);
  await until(
    () => readEntity(client, lab, sensor.id),
    (entity) => (entity.observation?.sequence ?? 0) >= 4,
  );
  const stopper = new HttpClient();
  await stopper.login(process.env.CONTRACT_OWNER_EMAIL!);
  expect(stopper.session!.user.id).not.toBe(client.session!.user.id);
  await stopper.json('POST', `${entityPath(lab, sensor.id)}/program/stop`);
  for (const on of [true, false, true, false]) {
    const command = await action(client, lab, light.id, 'light.set_power', {
      on,
    });
    expect(
      (await settledCommand(client, lab, light.id, command.id)).status,
    ).toBe('succeeded');
  }
  const centrifuge = await register(client, lab, 'centrifuge', {
    initial_temperature: 22,
  });
  await start(client, lab, centrifuge.id);
  const task = await action(client, lab, centrifuge.id, 'centrifuge.start', {
    rpm: 500,
    temperature: 22,
    duration_seconds: 6,
  });
  await until(
    () => readEntity(client, lab, centrifuge.id),
    (entity) => entity.task_result?.status === 'completed',
    20_000,
  );
  expect(task.task_id).toEqual(expect.any(String));
  await client.json('POST', `${entityPath(lab, centrifuge.id)}/program/stop`);
  to = new Date().toISOString();
});

afterAll(async () => {
  if (!light) return;
  await client.json('POST', `${entityPath(lab, light.id)}/program/stop`);
  await until(
    () => readEntity(client, lab, light.id),
    (entity) =>
      Object.values(entity.observation?.properties ?? {}).every(
        (property) => property.freshness === 'stale',
      ),
  );
});

test('HISTORY-01 history pages are bounded, cursor-scoped, source-preserving and recover after invalid queries; defaults are unchanged', async () => {
  const policy = await client.json<RetentionPolicy>(
    'GET',
    `/api/v1/lab/labs/${lab}/history/retention`,
  );
  expect(policy).toEqual({
    observation_seconds: 86400,
    record_seconds: 2592000,
  });
  const first = await bounded<HistoryPage>(
    history(light.id, 'command', { limit: '2' }),
  );
  expect(first.items).toHaveLength(2);
  expect(first.next_cursor).toEqual(expect.any(String));
  const second = await bounded<HistoryPage>(
    history(light.id, 'command', { limit: '2', cursor: first.next_cursor! }),
  );
  expect(second.items).toHaveLength(2);
  expect(
    new Set([...first.items, ...second.items].map((item) => item.id)).size,
  ).toBe(4);
  expect(first.max_response_bytes).toBe(256 * 1024);
  expect(first.max_range_seconds).toBe(31 * 86400);
  for (const item of [...first.items, ...second.items])
    expect(item).toMatchObject({
      entity_id: light.id,
      run_id: expect.any(String),
      received_at: expect.any(String),
    });
  const before = await world(client, lab);
  for (const invalid of [
    { limit: '101' },
    { limit: '0' },
    { cursor: 'invalid' },
    { record_type: 'unknown' },
    { to: from },
    { from: new Date(Date.parse(to) - 32 * 86400000).toISOString() },
  ] as Array<Record<string, string>>)
    await client.error(
      'GET',
      history(light.id, 'command', invalid),
      undefined,
      400,
    );
  await client.error(
    'GET',
    history(sensor.id, 'command', { cursor: first.next_cursor! }),
    undefined,
    400,
  );
  expect(await world(client, lab)).toEqual(before);
  const valid = await bounded<HistoryPage>(
    history(light.id, 'command', { limit: '100' }),
  );
  expect(valid.items).toHaveLength(4);
  expect(valid.items.length).toBeLessThanOrEqual(100);
  const observations = await bounded<HistoryPage>(history(sensor.id));
  expect(observations.items.length).toBeGreaterThanOrEqual(4);
  expect((await bounded<HistoryPage>(history(sensor.id), agent)).items).toEqual(
    observations.items,
  );
});

function assertTrendFacts(response: EntityTrend, raw: HistoryPage) {
  const reports = new Map(
    raw.items.map((item) => [
      item.id,
      (item.data as { properties: Record<string, ObservationProperty> })
        .properties.temperature,
    ]),
  );
  const samples = response.segments.flatMap((segment) => segment.samples);
  for (let index = 1; index < samples.length; index++)
    expect(
      instant(samples[index - 1].received_at) <=
        instant(samples[index].received_at),
    ).toBe(true);
  for (const segment of response.segments) {
    expect(segment.run_id).toBe(sensorRun.id);
    for (const sample of segment.samples) {
      const original = reports.get(sample.id);
      expect(original).toBeDefined();
      expect(sample).toMatchObject({
        value: original!.value,
        sequence: original!.sequence,
        received_at: original!.received_at,
        observed_at: original!.observed_at,
        expires_at: original!.expires_at,
      });
      expect(original!.run_id).toBe(sensorRun.id);
    }
  }
  expect(response.gaps.some((gap) => gap.reasons.includes('run_stopped'))).toBe(
    true,
  );
}

test('TREND-01 real received_at half-open boundaries preserve original precision, source, unit and bounded point counts', async () => {
  const raw = await bounded<HistoryPage>(
    history(sensor.id, 'observation', { limit: '100' }),
  );
  const response = await bounded<EntityTrend>(trend());
  assertTrendFacts(response, raw);
  const wrongValue = structuredClone(response);
  wrongValue.segments[0].samples[0].value += 1000;
  expect(() => assertTrendFacts(wrongValue, raw)).toThrow();
  const wrongOrder = structuredClone(response);
  wrongOrder.segments[0].samples.reverse();
  expect(() => assertTrendFacts(wrongOrder, raw)).toThrow();
  const missingGap = structuredClone(response);
  missingGap.gaps = [];
  expect(() => assertTrendFacts(missingGap, raw)).toThrow();
  expect(response.max_points).toBe(600);
  expect(response.max_range_seconds).toBe(86400);
  expect(response.max_response_bytes).toBe(262144);
  const samples = response.segments.flatMap((segment) => segment.samples);
  expect(samples.length).toBeGreaterThanOrEqual(4);
  expect(response.returned_sample_count).toBe(samples.length);
  expect(response.plot_item_count).toBe(samples.length + response.gaps.length);
  expect(response.plot_item_count).toBeLessThanOrEqual(600);
  for (const segment of response.segments) {
    expect(segment).toMatchObject({
      unit: 'degC',
      quality: 'good',
      source_time_known: true,
      binding_id: sensor.binding!.id,
    });
    expect(segment.run_id).toEqual(expect.any(String));
    expect(segment.source).toBe(sensor.binding!.source);
  }
  const ordered = samples;
  const boundary = ordered[1].received_at;
  const end = ordered.at(-1)!.received_at;
  const included = await bounded<EntityTrend>(
    trend({ from: boundary, to: end }),
  );
  const includedSamples = included.segments.flatMap(
    (segment) => segment.samples,
  );
  expect(includedSamples.some((sample) => sample.id === ordered[1].id)).toBe(
    true,
  );
  expect(
    includedSamples.some((sample) => sample.id === ordered.at(-1)!.id),
  ).toBe(false);
  const excluded = await bounded<EntityTrend>(trend({ to: boundary }));
  expect(
    excluded.segments
      .flatMap((segment) => segment.samples)
      .some((sample) => sample.id === ordered[1].id),
  ).toBe(false);
  for (const sample of includedSamples) {
    expect(instant(sample.received_at) >= instant(boundary)).toBe(true);
    expect(instant(sample.received_at) < instant(end)).toBe(true);
    expect(sample.observed_at).toEqual(expect.any(String));
  }
  expect((await bounded<EntityTrend>(trend(), agent)).segments).toEqual(
    response.segments,
  );
  expect(
    (await bounded<EntityTrend>(trend({ max_points: '1000' }))).plot_item_count,
  ).toBeLessThanOrEqual(1000);
});

test('TREND-02 invalid references,property,ranges and budgets reject without writes and correct query recovers', async () => {
  const before = await world(client, lab);
  for (const invalid of [
    { property: 'not-reported' },
    { max_points: '0' },
    { max_points: '1001' },
    { to: from },
    { from: new Date(Date.parse(to) - 86400001).toISOString() },
  ] as Array<Record<string, string>>)
    await client.error('GET', trend(invalid), undefined, 400);
  const other = await createLab(client, 'Wrong trend Lab');
  await client.error(
    'GET',
    `${entityPath(other.id, sensor.id)}/trend?${params({ property: 'temperature' })}`,
    undefined,
    404,
  );
  const anonymous = new HttpClient();
  await anonymous.error('GET', trend(), undefined, 401);
  expect((await world(client, lab)).entities).toEqual(before.entities);
  expect(
    (await bounded<EntityTrend>(trend())).returned_sample_count,
  ).toBeGreaterThan(0);
});

test('RECORDS-01 mixed records preserve actor and device identities; fixed query upper bound pages once while new records arrive', async () => {
  const path = records({ limit: '100' });
  const page = await bounded<LabRecordsPage>(path);
  expect(new Set(page.items.map((item) => item.record_type))).toEqual(
    new Set(['command', 'task', 'event', 'run']),
  );
  expect(page.max_page_items).toBe(100);
  expect(page.max_response_bytes).toBe(262144);
  expect(page.max_range_seconds).toBe(31 * 86400);
  const programEvents = page.items.filter(
    (item) =>
      item.record_type === 'event' &&
      (item.data as { record_type?: string }).record_type === 'program',
  );
  expect(programEvents.length).toBeGreaterThan(0);
  const stoppedEvents = programEvents.filter(
    (event) => event.summary === 'program_stopped',
  );
  expect(stoppedEvents.length).toBeGreaterThan(0);
  for (const event of stoppedEvents)
    expect(event).toMatchObject({
      actor_id: null,
      actor_role: 'unknown',
      actor_source: 'unknown',
    });
  const starts = programEvents.filter(
    (event) => event.summary === 'program_running',
  );
  expect(starts.length).toBeGreaterThan(0);
  for (const event of starts)
    expect(event).toMatchObject({
      actor_id: client.session!.user.id,
      actor_role: 'initiator',
      actor_source: 'unknown',
    });
  for (const run of page.items.filter((item) => item.record_type === 'run'))
    expect(run).toMatchObject({
      actor_id: client.session!.user.id,
      actor_role: 'initiator',
      actor_source: 'unknown',
    });
  const commands = page.items.filter((item) => item.record_type === 'command');
  expect(commands.length).toBeGreaterThanOrEqual(5);
  for (const command of commands)
    expect(command).toMatchObject({
      actor_id: client.session!.user.id,
      actor_source: 'member',
      binding_id: expect.any(String),
      run_id: expect.any(String),
    });
  expect((await bounded<LabRecordsPage>(path, agent)).items).toEqual(
    page.items,
  );
  const future = new Date(Date.now() + 60_000).toISOString();
  const first = await bounded<LabRecordsPage>(
    records({ to: future, limit: '2' }),
  );
  expect(first.next_cursor).toEqual(expect.any(String));
  const added = await action(client, lab, light.id, 'light.set_power', {
    on: true,
  });
  await settledCommand(client, lab, light.id, added.id);
  const items = [...first.items];
  let cursor = first.next_cursor;
  while (cursor) {
    const next = await bounded<LabRecordsPage>(
      records({ to: future, limit: '2', cursor }),
    );
    expect(next.query_upper_bound).toBe(first.query_upper_bound);
    items.push(...next.items);
    cursor = next.next_cursor;
  }
  expect(
    new Set(items.map((item) => `${item.record_type}:${item.id}`)).size,
  ).toBe(items.length);
  expect(items.some((item) => item.id === added.id)).toBe(false);
  expect(items.map((item) => `${item.record_type}:${item.id}`).sort()).toEqual(
    page.items.map((item) => `${item.record_type}:${item.id}`).sort(),
  );
});

test('RECORDS-02 filter-bound opaque cursors and archived histories reject invalid queries and recover with retained records', async () => {
  const originalWorld = await world(client, lab);
  const originalRecords = await bounded<LabRecordsPage>(
    records({ limit: '100' }),
  );
  const originalHistory = await bounded<HistoryPage>(
    history(sensor.id, 'observation', { limit: '100' }),
  );
  const first = await bounded<LabRecordsPage>(records({ limit: '1' }));
  expect(first.next_cursor).toEqual(expect.any(String));
  for (const invalid of [
    { limit: '101' },
    { record_type: 'unknown' },
    { cursor: 'bad' },
    { cursor: first.next_cursor!, record_type: 'run' },
    { to: from },
    { from: new Date(Date.parse(to) - 32 * 86400000).toISOString() },
  ] as Array<Record<string, string>>)
    await client.error('GET', records(invalid), undefined, 400);
  expect(await world(client, lab)).toEqual(originalWorld);
  expect(
    (await bounded<LabRecordsPage>(records({ limit: '100' }))).items,
  ).toEqual(originalRecords.items);
  expect(
    (
      await bounded<HistoryPage>(
        history(sensor.id, 'observation', { limit: '100' }),
      )
    ).items,
  ).toEqual(originalHistory.items);
  const before = await readEntity(client, lab, sensor.id);
  await client.json('POST', `${entityPath(lab, sensor.id)}/archive`);
  const archived = await readEntity(client, lab, sensor.id);
  expect(archived.id).toBe(before.id);
  expect(archived.archived_at).toEqual(expect.any(String));
  expect(
    (await bounded<LabRecordsPage>(records({ entity_id: sensor.id }))).items
      .length,
  ).toBeGreaterThan(0);
  expect(
    (await bounded<HistoryPage>(history(sensor.id))).items.length,
  ).toBeGreaterThan(0);
});
