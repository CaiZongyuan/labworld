import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import {
  createApiClient,
  type AssetDefinition,
  type CurrentSession,
  type LabEntity,
  type LabWorld,
  type LabRecord,
  type ObservationProperty,
} from '@labos-threejs/sdk';
import { act, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { createAppRouter, navigateExample } from './router';

const identity: CurrentSession = {
  user: {
    id: 'operations-member',
    email: 'operations@example.test',
    display_name: 'Operations member',
    role: 'member',
  },
  csrf_token: 'operations-csrf',
};
const definitions = JSON.parse(
  readFileSync('packages/server/src/lab/world/catalog.json', 'utf8'),
) as AssetDefinition[];
const lab = {
  id: 'operations-lab',
  name: 'Operations Lab',
  layout_version: 1,
  created_by: identity.user.id,
  created_at: '2026-10-09T01:00:00Z',
};
const time = '2026-10-09T01:00:00Z';
function entity(id: string, definitionId = 'light'): LabEntity {
  const definition = definitions.find((entry) => entry.id === definitionId)!;
  const binding = {
    id: `binding-${id}`,
    entity_id: id,
    program_id: `${definitionId}.v1`,
    source: `simulated:${id}`,
    definition_id: definitionId,
    definition_version: definition.version,
    definition,
  };
  const properties: Record<string, ObservationProperty> = Object.fromEntries(
    Object.entries(
      (definition.state as { properties: Record<string, { type: string }> })
        .properties,
    ).map(([name, schema]) => [
      name,
      {
        value:
          schema.type === 'boolean'
            ? false
            : schema.type === 'number'
              ? 0
              : 'idle',
        unit: name === 'temperature' ? 'degC' : name === 'speed' ? 'rpm' : null,
        binding_id: binding.id,
        run_id: `run-${id}`,
        sequence: 1,
        source: binding.source,
        observed_at: time,
        received_at: time,
        updated_at: time,
        expires_at: time,
        quality: 'good',
        freshness: 'current',
      },
    ]),
  );
  return {
    id,
    lab_id: lab.id,
    name: id,
    kind: definition.category,
    reality: 'simulated',
    definition_id: definitionId,
    definition_version: definition.version,
    definition,
    configuration: {},
    created_by: identity.user.id,
    updated_by: identity.user.id,
    created_at: time,
    updated_at: time,
    binding,
    program_run: {
      ...binding,
      id: `run-${id}`,
      binding_id: binding.id,
      configuration: {},
      status: 'running',
      started_by: identity.user.id,
      started_at: time,
    },
    observation: {
      entity_id: id,
      run_id: `run-${id}`,
      sequence: 1,
      source: binding.source,
      values: {},
      observed_at: time,
      received_at: time,
      updated_at: time,
      quality: 'good',
      freshness: 'current',
      properties,
    },
    capabilities: [],
  };
}
function open(
  path = '/lab?view=overview',
  configure?: (world: LabWorld) => void,
) {
  const valid = entity('zero-light');
  const partial = entity('partial-light');
  delete partial.observation!.properties.on;
  const expired = entity('expired-light');
  expired.observation!.properties.brightness.freshness = 'expired';
  const stopped = entity('stopped-light');
  stopped.program_run!.status = 'stopped';
  const notStarted = entity('not-started-light');
  notStarted.program_run = null;
  const unbound = entity('unbound-light');
  unbound.binding = null;
  unbound.program_run = null;
  const archived = entity('archived-light');
  archived.archived_at = time;
  const furniture = entity('bench-one', 'bench');
  furniture.binding = null;
  furniture.program_run = null;
  const taskDevice = entity('task-centrifuge', 'centrifuge');
  taskDevice.task = {
    id: 'task-one',
    entity_id: taskDevice.id,
    run_id: taskDevice.program_run!.id,
    command_id: 'command-one',
    result_id: 'result-one',
    parameters: {},
    status: 'preparing',
    elapsed_seconds: 0,
    created_at: time,
  };
  const world: LabWorld = {
    version: '1',
    lab,
    entities: [
      valid,
      partial,
      expired,
      stopped,
      notStarted,
      unbound,
      archived,
      furniture,
      taskDevice,
    ],
    nodes: [0, 1].map((i) => ({
      id: `node-${i}`,
      lab_id: lab.id,
      entity_id: valid.id,
      placement: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    })),
    assets: [],
    relationships: [],
  };
  configure?.(world);
  const subscriptions: {
    signal: AbortSignal;
    controller: ReadableStreamDefaultController<Uint8Array>;
  }[] = [];
  const recordItems: LabRecord[] = [];
  const recordRequests: URL[] = [];
  const trendRequests: URL[] = [];
  let worldReads = 0;
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json(identity),
    ),
    http.get('http://api.test/api/v1/lab/labs', () =>
      HttpResponse.json({ data: [lab] }),
    ),
    http.get('http://api.test/api/v1/lab/assets', () =>
      HttpResponse.json({ data: [] }),
    ),
    http.get('http://api.test/api/v1/lab/asset-definitions', () =>
      HttpResponse.json({ data: definitions }),
    ),
    http.get('http://api.test/api/v1/lab/labs/operations-lab/world', () => {
      worldReads++;
      return HttpResponse.json(world);
    }),
    http.get(
      'http://api.test/api/v1/lab/labs/operations-lab/entities/:entityId/trend',
      ({ request, params }) => {
        const url = new URL(request.url);
        trendRequests.push(url);
        return HttpResponse.json({
          entity_id: params.entityId,
          property: 'temperature',
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
          queried_at: time,
          unit: 'degC',
          segments: [],
          gaps: [],
          returned_sample_count: 0,
          raw_sample_count: 0,
          plot_item_count: 0,
          sampling_strategy: 'first_last_min_max',
          resolution_seconds: 0,
          available_since: null,
          retained_since: null,
          captured_since: null,
          first_report_at: null,
          last_report_at: null,
        });
      },
    ),
    http.get(
      'http://api.test/api/v1/lab/labs/operations-lab/records',
      ({ request }) => {
        const url = new URL(request.url);
        recordRequests.push(url);
        return HttpResponse.json({
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
          queried_at: time,
          query_upper_bound: time,
          entity_id: url.searchParams.get('entity_id'),
          record_type: url.searchParams.get('record_type'),
          retention: { observation_seconds: 86400, record_seconds: 2592000 },
          coverage: [],
          items: recordItems.slice(0, Number(url.searchParams.get('limit'))),
          next_cursor: null,
        });
      },
    ),
    http.get(
      'http://api.test/api/v1/lab/labs/operations-lab/world/subscribe',
      ({ request }) =>
        new HttpResponse(
          new ReadableStream({
            start(controller) {
              subscriptions.push({ signal: request.signal, controller });
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"runtime_status","available":true}\n\n',
                ),
              );
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    ),
  );
  const router = createAppRouter(
    {
      apiClient: createApiClient('http://api.test'),
      docsUrl: 'https://docs.test',
    },
    createMemoryHistory({ initialEntries: [path] }),
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        })
      }
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return {
    user: userEvent.setup(),
    world,
    subscriptions,
    router,
    recordRequests,
    recordItems,
    trendRequests,
    worldReads: () => worldReads,
  };
}

test('explicit overview counts distinct active devices, Tasks and all required current property facts', async () => {
  const { user, subscriptions } = open();
  await screen.findByRole('heading', { name: 'Operations Lab' });
  const summary = await screen.findByRole('region', { name: '运行汇总' });
  expect(
    within(summary).getByRole('button', { name: '已登记设备 7' }),
  ).toBeVisible();
  expect(
    within(summary).getByRole('button', { name: '进行中任务 1' }),
  ).toBeVisible();
  expect(
    within(summary).getByRole('button', { name: '当前有效观测 2' }),
  ).toBeVisible();
  expect(
    within(summary).getByRole('button', { name: '待关注设备 1' }),
  ).toBeVisible();
  await user.click(
    within(summary).getByRole('button', { name: '进行中任务 1' }),
  );
  expect(screen.getByRole('tab', { name: '设备' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const directory = screen.getByRole('region', { name: '设备目录' });
  expect(
    within(directory).getByRole('button', { name: '选择 task-centrifuge' }),
  ).toBeVisible();
  expect(
    within(directory).queryByRole('button', { name: '选择 zero-light' }),
  ).toBeNull();
  expect(subscriptions).toHaveLength(1);
});

test('attention merges retained facts and prioritizes interrupted or uncertain outcomes before oldest key reports', async () => {
  open('/lab?view=overview', (world) => {
    const expired = world.entities.find(
      (entry) => entry.id === 'expired-light',
    )!;
    expired.observation!.properties.brightness.observed_at =
      '2026-10-09T00:00:00Z';
    const interrupted = world.entities.find(
      (entry) => entry.id === 'stopped-light',
    )!;
    interrupted.program_run!.status = 'interrupted';
    interrupted.program_run!.ended_at = '2026-10-09T02:00:00Z';
    const uncertain = world.entities.find(
      (entry) => entry.id === 'task-centrifuge',
    )!;
    uncertain.task!.status = 'uncertain';
    uncertain.task!.ended_at = '2026-10-09T01:30:00Z';
    uncertain.observation!.properties.speed.quality = 'bad';
    uncertain.observation!.properties.temperature.observed_at = null;
  });
  const attention = await screen.findByRole('list', { name: '需要关注' });
  const items = within(attention).getAllByRole('listitem');
  expect(items).toHaveLength(3);
  expect(items[0]).toHaveTextContent('task-centrifuge');
  expect(items[0]).toHaveTextContent('任务结果不确定');
  expect(items[0]).toHaveTextContent('属性质量较差');
  expect(items[0]).toHaveTextContent('属性来源时间未知');
  expect(items[1]).toHaveTextContent('stopped-light');
  expect(items[2]).toHaveTextContent('expired-light');
  expect(screen.getByRole('button', { name: '待关注设备 3' })).toBeVisible();
  expect(screen.getByRole('button', { name: '进行中任务 0' })).toBeVisible();
});

test('device filters follow identity and nearest manual Location rather than Placement, while static and archived objects remain reachable', async () => {
  const { user, router } = open('/lab?view=devices', (world) => {
    const region = entity('registered-room', 'environment');
    region.name = 'Registered room';
    const elsewhere = entity('placement-room', 'environment');
    elsewhere.name = 'Placement room';
    const bench = world.entities.find((entry) => entry.id === 'bench-one')!;
    world.entities.push(region, elsewhere);
    world.relationships = [
      {
        id: 'child',
        lab_id: lab.id,
        source_id: bench.id,
        target_id: 'zero-light',
        kind: 'contains',
        source: 'manual',
        registered_by: identity.user.id,
        registered_at: time,
      },
      {
        id: 'region',
        lab_id: lab.id,
        source_id: bench.id,
        target_id: region.id,
        kind: 'located_in',
        source: 'manual',
        registered_by: identity.user.id,
        registered_at: time,
      },
    ];
    world.nodes.forEach((node) => (node.placement.position = [500, 0, 500]));
    world.entities.find((entry) => entry.id === 'zero-light')!.name =
      'Renamed lamp';
  });
  const directory = await screen.findByRole('region', { name: '设备目录' });
  await user.type(screen.getByLabelText('搜索名称或身份'), 'zero-light');
  expect(within(directory).getAllByRole('row')).toHaveLength(2);
  await user.selectOptions(
    screen.getByLabelText('登记区域'),
    'registered-room',
  );
  expect(
    within(directory).getByRole('button', { name: '选择 Renamed lamp' }),
  ).toBeVisible();
  await user.click(
    within(directory).getByRole('checkbox', { name: '仅未放置对象' }),
  );
  expect(
    within(directory).queryByRole('button', { name: '选择 Renamed lamp' }),
  ).toBeNull();
  await user.click(
    within(directory).getByRole('checkbox', { name: '仅未放置对象' }),
  );
  await user.click(
    within(directory).getByRole('button', { name: '选择 Renamed lamp' }),
  );
  expect(router.state.location.search).toMatchObject({
    view: 'devices',
    entity: 'zero-light',
  });
  expect(
    await screen.findByRole('complementary', { name: '对象信息' }),
  ).toHaveTextContent('Renamed lamp');
  await user.click(screen.getByRole('button', { name: '关闭对象信息' }));
  expect(
    within(directory).getByRole('button', { name: '选择 Renamed lamp' }),
  ).toHaveFocus();
  await user.click(screen.getByRole('button', { name: '完整对象目录' }));
  expect(screen.getByRole('tab', { name: '三维空间' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(
    screen.getByRole('complementary', { name: '对象目录' }),
  ).toHaveTextContent('bench-one');
  await user.click(screen.getByRole('tab', { name: '设备' }));
  expect(screen.getByLabelText('搜索名称或身份')).toHaveValue('zero-light');
  await user.click(screen.getByRole('button', { name: '已归档对象' }));
  expect(
    screen.getByRole('complementary', { name: '对象目录' }),
  ).toHaveTextContent('archived-light');
});

test('a view-less Lab opens space and an explicit device deep link restores the same shared detail', async () => {
  const { user, router, subscriptions } = open(
    '/lab?lab=operations-lab&entity=zero-light',
  );
  await screen.findByRole('complementary', { name: '对象信息' });
  expect(screen.getByRole('tab', { name: '三维空间' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await user.click(screen.getByRole('tab', { name: '设备' }));
  expect(router.state.location.search).toMatchObject({
    lab: lab.id,
    entity: 'zero-light',
    view: 'devices',
  });
  await act(() =>
    navigateExample(router, {
      path: '/lab',
      search: { lab: lab.id, entity: 'missing-entity', view: 'devices' },
    }),
  );
  expect(await screen.findByText('找不到此对象。')).toBeVisible();
  expect(screen.queryByRole('complementary', { name: '对象信息' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '清除对象链接' }));
  expect(screen.getByRole('tab', { name: '设备' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(subscriptions).toHaveLength(1);
});

test('offline preserves the last synchronized snapshot and filters while disabling new writes, then reconnects the current world and recent activity', async () => {
  const { user, world, subscriptions, recordRequests, worldReads } =
    open('/lab?view=devices');
  await screen.findByRole('region', { name: '设备目录' });
  await user.type(screen.getByLabelText('搜索名称或身份'), 'zero-light');
  await user.click(screen.getByRole('tab', { name: '运行总览' }));
  await waitFor(() => expect(recordRequests).toHaveLength(1));
  await act(() => window.dispatchEvent(new Event('offline')));
  expect(
    await screen.findByText('最后同步快照 · 只读', { exact: false }),
  ).toBeVisible();
  expect(screen.getByRole('button', { name: '登记对象' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '创建 Lab' })).toBeDisabled();
  const reads = worldReads();
  const oldRequests = recordRequests.length;
  world.version = '2';
  world.entities.find((entry) => entry.id === 'zero-light')!.name =
    'Reconnected light';
  await act(() => window.dispatchEvent(new Event('online')));
  await waitFor(() => expect(worldReads()).toBeGreaterThan(reads));
  await waitFor(() =>
    expect(recordRequests.length).toBeGreaterThan(oldRequests),
  );
  expect(
    screen.queryByText('最后同步快照 · 只读', { exact: false }),
  ).toBeNull();
  await user.click(screen.getByRole('tab', { name: '设备' }));
  expect(screen.getByLabelText('搜索名称或身份')).toHaveValue('zero-light');
  expect(screen.getByRole('region', { name: '设备目录' })).toHaveTextContent(
    'Reconnected light',
  );
  expect(subscriptions.filter((entry) => !entry.signal.aborted)).toHaveLength(
    1,
  );
});

test('overview selects real registered sensors, retains trend range, and follows a bounded recent Task to its original result', async () => {
  const { user, trendRequests, recordRequests, recordItems, router } = open(
    '/lab?view=overview',
    (world) =>
      world.entities.push(
        entity('sensor-alpha', 'sensor'),
        entity('sensor-beta', 'sensor'),
      ),
  );
  recordItems.push({
    id: 'old-task',
    record_type: 'task',
    entity_id: 'task-centrifuge',
    entity_name: 'task-centrifuge',
    reality: 'simulated',
    archived_at: null,
    run_id: 'old-run',
    binding_id: 'old-binding',
    command_id: 'old-command',
    task_id: 'old-task',
    result_id: 'old-result',
    recorded_at: time,
    ended_at: time,
    state: 'interrupted',
    summary: 'Original interrupted task',
    source: 'simulated:old',
    actor_id: identity.user.id,
    actor_source: 'member',
    actor_role: 'Member',
    data: {
      result: { id: 'old-result', status: 'interrupted', task_id: 'old-task' },
    },
  });
  const sensors = await screen.findByLabelText('环境传感器');
  await waitFor(() =>
    expect(
      trendRequests.some((url) => url.pathname.includes('sensor-alpha')),
    ).toBe(true),
  );
  await user.selectOptions(sensors, 'sensor-beta');
  await waitFor(() =>
    expect(
      trendRequests.some((url) => url.pathname.includes('sensor-beta')),
    ).toBe(true),
  );
  await user.click(screen.getByRole('button', { name: '6 小时' }));
  await waitFor(() =>
    expect(
      trendRequests.some(
        (url) =>
          Date.parse(url.searchParams.get('to')!) -
            Date.parse(url.searchParams.get('from')!) ===
          21600000,
      ),
    ).toBe(true),
  );
  await user.click(screen.getByRole('tab', { name: '设备' }));
  await user.click(screen.getByRole('tab', { name: '运行总览' }));
  expect(screen.getByLabelText('环境传感器')).toHaveValue('sensor-beta');
  expect(screen.getByRole('button', { name: '6 小时' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const recent = screen.getByRole('region', { name: '最近活动' });
  expect(
    await within(recent).findByText('Original interrupted task'),
  ).toBeVisible();
  expect(recordRequests[0].searchParams.get('limit')).toBe('5');
  expect(recordRequests[0].searchParams.get('cursor')).toBeNull();
  await user.click(
    within(recent).getByRole('button', { name: '打开原对象 task-centrifuge' }),
  );
  const detail = await screen.findByRole('complementary', { name: '对象信息' });
  expect(detail).toHaveTextContent('old-result');
  expect(detail).toHaveTextContent('interrupted');
  expect(router.state.location.search).toMatchObject({
    view: 'space',
    entity: 'task-centrifuge',
  });
});

test('revoked access removes the overview and stops its World subscription', async () => {
  const { subscriptions } = open();
  await screen.findByRole('region', { name: '运行汇总' });
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json(
        {
          error: {
            code: 'auth.unauthorized',
            message: 'Session expired',
            request_id: 'revoked',
          },
        },
        { status: 401 },
      ),
    ),
  );
  await act(() =>
    subscriptions[0].controller.enqueue(
      new TextEncoder().encode(
        'data: {"type":"access_ended","reason":"revoked"}\n\n',
      ),
    ),
  );
  await screen.findByRole('button', { name: '登录' });
  expect(screen.queryByRole('region', { name: '运行汇总' })).toBeNull();
  await waitFor(() => expect(subscriptions[0].signal.aborted).toBe(true));
});

test('full record filters remain valid when visiting the overview and device views', async () => {
  const { user, recordRequests } = open('/lab?view=records');
  const records = await screen.findByRole('region', { name: '运行记录' });
  await user.selectOptions(
    within(records).getByLabelText('设备'),
    'zero-light',
  );
  await waitFor(() =>
    expect(recordRequests.at(-1)?.searchParams.get('entity_id')).toBe(
      'zero-light',
    ),
  );
  await user.click(screen.getByRole('tab', { name: '运行总览' }));
  await user.click(screen.getByRole('tab', { name: '设备' }));
  await user.click(screen.getByRole('tab', { name: '运行记录' }));
  expect(
    within(screen.getByRole('region', { name: '运行记录' })).getByLabelText(
      '设备',
    ),
  ).toHaveValue('zero-light');
});
