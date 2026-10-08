import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import {
  createApiClient,
  type AssetDefinition,
  type CurrentSession,
  type LabEntity,
  type ObservationProperty,
} from '@labos-threejs/sdk';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { createAppRouter } from './router';

const identity = {
  user: {
    id: 'detail-user',
    email: 'details@example.test',
    display_name: 'Details',
    role: 'member',
  },
  csrf_token: 'detail-csrf',
} satisfies CurrentSession;
const observedAt = '2026-10-03T06:00:00Z';
const receivedAt = '2026-10-03T06:00:01Z';

function openDetails(definitionId = 'light') {
  const definitions = JSON.parse(
    readFileSync('packages/server/src/lab/world/catalog.json', 'utf8'),
  ) as AssetDefinition[];
  const definition = definitions.find((entry) => entry.id === definitionId)!;
  const lab = { id: 'detail-lab', name: 'Details Lab', layout_version: 1 };
  const names =
    definitionId === 'centrifuge'
      ? ['Centrifuge A', 'Centrifuge B']
      : ['Light A', 'Light B'];
  const entities: LabEntity[] = names.map((name, index) => {
    const id = `${definitionId}-${index}`;
    const binding = {
      id: `binding-${index}`,
      entity_id: id,
      program_id: `${definitionId}.v1`,
      source: `simulated:${definitionId}:${index}`,
      definition_id: definition.id,
      definition_version: definition.version,
      definition,
    };
    const property = (value: unknown, unit?: string): ObservationProperty => ({
      value,
      unit,
      binding_id: binding.id,
      run_id: `run-original-${index}`,
      sequence: 1,
      source: binding.source,
      observed_at: observedAt,
      received_at: receivedAt,
      updated_at: receivedAt,
      expires_at: '2026-10-03T06:00:10Z',
      quality: 'good',
      freshness: 'current',
    });
    return {
      id,
      lab_id: lab.id,
      name,
      kind: 'iot',
      reality: 'simulated',
      definition_id: definition.id,
      definition_version: definition.version,
      definition,
      configuration: {},
      created_by: identity.user.id,
      updated_by: identity.user.id,
      created_at: observedAt,
      updated_at: receivedAt,
      binding,
      program_run: {
        ...binding,
        id: `run-original-${index}`,
        binding_id: binding.id,
        configuration: {},
        status: 'running',
        started_by: identity.user.id,
        started_at: observedAt,
      },
      observation: {
        entity_id: id,
        run_id: `run-original-${index}`,
        sequence: 1,
        source: binding.source,
        values:
          definitionId === 'centrifuge'
            ? { speed: 0, temperature: 22, phase: 'idle', elapsed_seconds: 0 }
            : { on: false, brightness: 0 },
        observed_at: observedAt,
        received_at: receivedAt,
        updated_at: receivedAt,
        quality: 'good',
        freshness: 'current',
        properties: { on: property(false), brightness: property(0, 'percent') },
      },
      capabilities: definition.capabilities.map((capability) => ({
        ...capability,
        version: '1.0',
        result: capability.result ?? {},
        definition_supported: true,
        binding_implemented: true,
        executable: true,
        reason: 'ready',
      })),
    };
  });
  let version = 0;
  const sourceCalls: string[] = [];
  const sourceFailures = { stop: false, start: false };
  const unavailable = () =>
    HttpResponse.json(
      {
        error: {
          code: 'lab.runtime_unavailable',
          message: 'Runtime unavailable',
          request_id: 'source-failure',
        },
      },
      { status: 503 },
    );
  let stream: ReadableStreamDefaultController<Uint8Array>;
  const world = () => ({
    version: String(++version),
    lab,
    entities,
    nodes: [],
    assets: [],
    relationships: [],
  });
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json(identity),
    ),
    http.get('http://api.test/api/v1/lab/labs', () =>
      HttpResponse.json({ data: [lab], has_more: false }),
    ),
    http.get('http://api.test/api/v1/lab/assets', () =>
      HttpResponse.json({ data: [], has_more: false }),
    ),
    http.get('http://api.test/api/v1/lab/asset-definitions', () =>
      HttpResponse.json({ data: definitions }),
    ),
    http.get('http://api.test/api/v1/lab/labs/detail-lab/world', () =>
      HttpResponse.json(world()),
    ),
    http.get(
      'http://api.test/api/v1/lab/labs/detail-lab/world/subscribe',
      () =>
        new HttpResponse(
          new ReadableStream({
            start(controller) {
              stream = controller;
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
    http.post(
      'http://api.test/api/v1/lab/labs/detail-lab/entities/:entity/program/stop',
      ({ params }) => {
        sourceCalls.push('stop');
        if (sourceFailures.stop) return unavailable();
        const entity = entities.find((entry) => entry.id === params.entity)!;
        entity.program_run!.status = 'stopped';
        entity.capabilities.forEach((capability) => {
          capability.executable = false;
        });
        return HttpResponse.json(entity.program_run);
      },
    ),
    http.post(
      'http://api.test/api/v1/lab/labs/detail-lab/entities/:entity/program/start',
      ({ params }) => {
        sourceCalls.push('start');
        if (sourceFailures.start) return unavailable();
        const entity = entities.find((entry) => entry.id === params.entity)!;
        entity.program_run = {
          ...entity.program_run!,
          id: `run-new-${entity.id}`,
          status: 'running',
        };
        entity.capabilities.forEach((capability) => {
          capability.executable = true;
        });
        return HttpResponse.json(entity.program_run, { status: 201 });
      },
    ),
  );
  const router = createAppRouter(
    {
      apiClient: createApiClient('http://api.test'),
      docsUrl: 'https://docs.test',
    },
    createMemoryHistory({ initialEntries: ['/lab'] }),
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
    entities,
    sourceCalls,
    sourceFailures,
    publish() {
      stream.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({ type: 'snapshot', world: world() })}\n\n`,
        ),
      );
    },
  };
}

test('stopping and starting a source preserves last property values and their original provenance', async () => {
  const { user, entities, publish } = openDetails();
  await user.click(await screen.findByRole('button', { name: '打开对象目录' }));
  await user.click(await screen.findByRole('button', { name: '选择 Light A' }));
  const inspector = screen.getByRole('complementary', { name: '对象信息' });
  const power = within(inspector).getByRole('region', { name: '观测电源' });
  expect(within(power).getByText('关闭')).toBeVisible();
  expect(within(power).getByText('当前观测')).toBeVisible();
  expect(
    within(inspector).getByRole('region', { name: '观测亮度' }),
  ).toHaveTextContent('0 percent');
  await user.click(within(inspector).getByRole('button', { name: '停止程序' }));
  await user.click(
    await within(inspector).findByRole('button', { name: '启动程序' }),
  );
  await waitFor(() =>
    expect(within(power).getByText('最后报告值')).toBeVisible(),
  );
  expect(within(power).queryByText('当前观测')).not.toBeInTheDocument();
  expect(within(power).getByText('关闭')).toBeVisible();
  expect(power.querySelector('time')).toHaveAttribute('datetime', observedAt);

  // A heartbeat and a brightness-only report from the new Run cannot refresh power.
  entities[0].observation!.updated_at = '2026-10-03T06:00:09Z';
  entities[0].observation!.properties.brightness = {
    ...entities[0].observation!.properties.brightness,
    value: 50,
    run_id: 'run-new-light-0',
    observed_at: '2026-10-03T06:00:08Z',
  };
  publish();
  await waitFor(() =>
    expect(
      within(inspector).getByRole('region', { name: '观测亮度' }),
    ).toHaveTextContent('50 percent'),
  );
  expect(within(power).getByText('最后报告值')).toBeVisible();
  expect(power.querySelector('time')).toHaveAttribute('datetime', observedAt);
  await user.click(within(inspector).getByRole('tab', { name: '详情' }));
  const details = within(inspector).getByRole('tabpanel', { name: '详情' });
  expect(within(details).getAllByText('run-new-light-0')).toHaveLength(2);
  expect(within(details).getByText('run-original-0')).toBeVisible();
  expect(within(details).getByText(observedAt)).toBeVisible();
});

test('each light retains its requested brightness when selection changes', async () => {
  const { user } = openDetails();
  await user.click(await screen.findByRole('button', { name: '打开对象目录' }));
  await user.click(await screen.findByRole('button', { name: '选择 Light A' }));
  const inspector = screen.getByRole('complementary', { name: '对象信息' });
  let target = within(inspector).getByRole('spinbutton', {
    name: '目标亮度 (%)',
  });
  await user.clear(target);
  await user.type(target, '23');
  await user.click(screen.getByRole('button', { name: '选择 Light B' }));
  target = within(inspector).getByRole('spinbutton', { name: '目标亮度 (%)' });
  await user.clear(target);
  await user.type(target, '77');
  await user.click(screen.getByRole('button', { name: '选择 Light A' }));
  expect(
    within(inspector).getByRole('spinbutton', { name: '目标亮度 (%)' }),
  ).toHaveValue(23);
  expect(
    within(inspector).getByRole('region', { name: '观测亮度' }),
  ).toHaveTextContent('0 percent');
  await user.click(screen.getByRole('button', { name: '选择 Light B' }));
  expect(
    within(inspector).getByRole('spinbutton', { name: '目标亮度 (%)' }),
  ).toHaveValue(77);
});

test('source restart stops before starting, preserves a failed Stop, and recovers partial success with explicit Start', async () => {
  const { user, sourceCalls, sourceFailures } = openDetails();
  await user.click(await screen.findByRole('button', { name: '打开对象目录' }));
  await user.click(await screen.findByRole('button', { name: '选择 Light A' }));
  const inspector = screen.getByRole('complementary', { name: '对象信息' });
  sourceFailures.stop = true;
  await user.click(within(inspector).getByRole('button', { name: '重启来源' }));
  await user.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: '确认重启来源',
    }),
  );
  expect(
    await within(inspector).findByText('停止来源失败；未启动新 Run。'),
  ).toBeVisible();
  expect(sourceCalls).toEqual(['stop']);
  expect(
    within(inspector).getByRole('button', { name: '停止程序' }),
  ).toBeEnabled();
  sourceFailures.stop = false;
  sourceFailures.start = true;
  await user.click(within(inspector).getByRole('button', { name: '重启来源' }));
  await user.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: '确认重启来源',
    }),
  );
  expect(
    await within(inspector).findByText(
      '来源已停止，但启动失败。请显式启动；旧任务不会续跑。',
    ),
  ).toBeVisible();
  expect(sourceCalls).toEqual(['stop', 'stop', 'start']);
  expect(
    within(inspector).getByRole('region', { name: '观测电源' }),
  ).toHaveTextContent('最后报告值');
  sourceFailures.start = false;
  await user.click(within(inspector).getByRole('button', { name: '启动程序' }));
  expect(
    await within(inspector).findByText('来源已启动，等待此 Run 的新观测。'),
  ).toBeVisible();
  expect(sourceCalls).toEqual(['stop', 'stop', 'start', 'start']);
  expect(
    within(inspector).getByRole('region', { name: '观测电源' }),
  ).toHaveTextContent('最后报告值');
});

test('power and brightness outcomes remain independent when another action and another Entity are selected', async () => {
  const { user } = openDetails();
  const commands: Record<string, Record<string, unknown>> = {};
  server.use(
    http.post(
      'http://api.test/api/v1/lab/labs/detail-lab/entities/:entity/actions',
      async ({ request, params }) => {
        const input = (await request.json()) as {
          capability: string;
          parameters: unknown;
        };
        const id = `${params.entity}-${input.capability}`;
        commands[id] = {
          id,
          entity_id: params.entity,
          run_id: `run-original-${params.entity === 'light-0' ? '0' : '1'}`,
          status: 'succeeded',
          capability: input.capability,
          parameters: input.parameters,
          actor_id: identity.user.id,
          actor_source: 'member',
        };
        return HttpResponse.json(commands[id], { status: 202 });
      },
    ),
    http.get(
      'http://api.test/api/v1/lab/labs/detail-lab/entities/:entity/commands/:command',
      ({ params }) => HttpResponse.json(commands[String(params.command)]),
    ),
  );
  await user.click(await screen.findByRole('button', { name: '打开对象目录' }));
  await user.click(await screen.findByRole('button', { name: '选择 Light A' }));
  const inspector = screen.getByRole('complementary', { name: '对象信息' });
  await user.click(within(inspector).getByRole('switch', { name: '电源' }));
  expect(
    await within(inspector).findByText('light-0-light.set_power'),
  ).toBeVisible();
  await user.click(within(inspector).getByRole('button', { name: '设置' }));
  expect(
    await within(inspector).findByText('light-0-light.set_brightness'),
  ).toBeVisible();
  expect(within(inspector).getByText('light-0-light.set_power')).toBeVisible();
  expect(
    within(inspector).getByRole('region', { name: '观测电源' }),
  ).toHaveTextContent('关闭');
  await user.click(screen.getByRole('button', { name: '选择 Light B' }));
  expect(
    within(inspector).queryByText('light-0-light.set_power'),
  ).not.toBeInTheDocument();
  await user.click(within(inspector).getByRole('switch', { name: '电源' }));
  expect(
    await within(inspector).findByText('light-1-light.set_power'),
  ).toBeVisible();
  await user.click(screen.getByRole('button', { name: '选择 Light A' }));
  expect(within(inspector).getByText('light-0-light.set_power')).toBeVisible();
  expect(
    within(inspector).getByText('light-0-light.set_brightness'),
  ).toBeVisible();
  expect(
    within(inspector).queryByText('light-1-light.set_power'),
  ).not.toBeInTheDocument();
});

test('a centrifuge shows fixed backend Task parameters and retains its ended result across idle and a new Run', async () => {
  const { user, entities, publish } = openDetails('centrifuge');
  entities[0].task = {
    id: 'task-a',
    entity_id: entities[0].id,
    run_id: 'run-original-0',
    command_id: 'task-command-a',
    result_id: 'result-a',
    parameters: { rpm: 2000, temperature: 22, duration_seconds: 6 },
    status: 'preparing',
    elapsed_seconds: 0,
    created_at: observedAt,
  };
  entities[0].task_result = {
    id: 'result-a',
    task_id: 'task-a',
    status: 'pending',
  };
  await user.click(await screen.findByRole('button', { name: '打开对象目录' }));
  await user.click(
    await screen.findByRole('button', { name: '选择 Centrifuge A' }),
  );
  const inspector = screen.getByRole('complementary', { name: '对象信息' });
  expect(
    within(inspector).getByRole('spinbutton', { name: '目标转速 (rpm)' }),
  ).toHaveValue(2000);
  expect(
    within(inspector).getByRole('spinbutton', { name: '任务时长 (s)' }),
  ).toHaveValue(6);
  expect(
    within(inspector).getByRole('spinbutton', { name: '目标温度 (degC)' }),
  ).toBeDisabled();
  expect(
    within(inspector).getByRole('button', { name: '停止程序' }),
  ).toBeDisabled();
  const task = within(inspector).getByRole('region', {
    name: '当前 / 最近任务',
  });
  expect(task).toHaveTextContent('准备中');
  expect(task).toHaveTextContent('0.0 s');
  entities[0].task!.status = 'running';
  entities[0].task!.elapsed_seconds = 3;
  publish();
  await waitFor(() => expect(task).toHaveTextContent('3.0 s'));
  entities[0].task!.status = 'completed';
  entities[0].task!.elapsed_seconds = 6;
  entities[0].task_result = {
    id: 'result-a',
    task_id: 'task-a',
    status: 'completed',
    ended_at: receivedAt,
  };
  publish();
  await waitFor(() => expect(task).toHaveTextContent('已完成'));
  await user.click(within(inspector).getByRole('button', { name: '停止程序' }));
  await user.click(
    await within(inspector).findByRole('button', { name: '启动程序' }),
  );
  expect(task).toHaveTextContent('已完成');
  expect(task).toHaveTextContent('6.0 s');
  await user.click(within(inspector).getByRole('tab', { name: '详情' }));
  const details = within(inspector).getByRole('tabpanel', { name: '详情' });
  expect(within(details).getAllByText('task-a')).toHaveLength(2);
  expect(within(details).getByText('result-a')).toBeVisible();
  expect(within(details).getByText('task-command-a')).toBeVisible();
  expect(within(details).getAllByText('run-original-0').length).toBeGreaterThan(
    0,
  );
});

test.each([
  ['missing property', undefined, false],
  ['null', { value: null }, false],
  ['wrong type', { value: '0' }, false],
  ['expired', { freshness: 'stale' }, true],
  ['unknown source time', { observed_at: null }, true],
  ['bad quality', { quality: 'bad' }, true],
  ['earlier Binding', { binding_id: 'binding-previous' }, true],
  ['earlier Run', { run_id: 'run-previous' }, true],
] as const)(
  'brightness with %s stays unknown or last while valid false power remains current',
  async (_name, patch, hasValue) => {
    const { user, entities } = openDetails();
    if (patch)
      entities[0].observation!.properties.brightness = {
        ...entities[0].observation!.properties.brightness,
        ...patch,
      };
    else delete entities[0].observation!.properties.brightness;
    await user.click(
      await screen.findByRole('button', { name: '打开对象目录' }),
    );
    await user.click(
      await screen.findByRole('button', { name: '选择 Light A' }),
    );
    const inspector = screen.getByRole('complementary', { name: '对象信息' });
    const brightness = within(inspector).getByRole('region', {
      name: '观测亮度',
    });
    expect(brightness).toHaveTextContent(
      hasValue ? '最后报告值' : '未知 · 无观测',
    );
    expect(within(brightness).queryByText('当前观测')).not.toBeInTheDocument();
    const power = within(inspector).getByRole('region', { name: '观测电源' });
    expect(power).toHaveTextContent('关闭');
    expect(power).toHaveTextContent('当前观测');
    expect(
      within(inspector).getByLabelText('关键观测有效性'),
    ).toHaveTextContent('尚无当前有效关键观测');
  },
);

test('Records reads the selected Entity history and leaves its target intact after an error and retry', async () => {
  const { user } = openDetails();
  const requests: string[] = [];
  let fail = true;
  server.use(
    http.get(
      'http://api.test/api/v1/lab/labs/detail-lab/entities/:entity/history',
      ({ params, request }) => {
        requests.push(String(params.entity));
        if (fail)
          return HttpResponse.json(
            {
              error: {
                code: 'lab.unavailable',
                message: 'Unavailable',
                request_id: 'history-failure',
              },
            },
            { status: 503 },
          );
        const query = new URL(request.url).searchParams;
        return HttpResponse.json({
          record_type: 'event',
          from: query.get('from'),
          to: query.get('to'),
          available_since: observedAt,
          gap: false,
          retention: { observation_seconds: 86400, record_seconds: 2592000 },
          items: [],
          next_cursor: null,
          max_range_seconds: 2678400,
          max_response_bytes: 262144,
        });
      },
    ),
  );
  await user.click(await screen.findByRole('button', { name: '打开对象目录' }));
  await user.click(await screen.findByRole('button', { name: '选择 Light A' }));
  const inspector = screen.getByRole('complementary', { name: '对象信息' });
  const input = within(inspector).getByRole('spinbutton', {
    name: '目标亮度 (%)',
  });
  await user.clear(input);
  await user.type(input, '23');
  expect(requests).toEqual([]);
  await user.click(within(inspector).getByRole('tab', { name: '记录' }));
  const records = within(inspector).getByRole('tabpanel', { name: '记录' });
  await user.click(
    await within(records).findByRole('button', { name: '重试历史查询' }),
  );
  fail = false;
  await user.click(
    await within(records).findByRole('button', { name: '重试历史查询' }),
  );
  expect(await within(records).findByText('没有保留期内记录')).toBeVisible();
  expect(requests.every((id) => id === 'light-0')).toBe(true);
  await user.click(within(inspector).getByRole('tab', { name: '操作' }));
  expect(
    within(inspector).getByRole('spinbutton', { name: '目标亮度 (%)' }),
  ).toHaveValue(23);
});

test('confirmed Stop and new Run remain honest while World revalidation is pending, even at the same source timestamp', async () => {
  const { user, entities, publish } = openDetails();
  await user.click(await screen.findByRole('button', { name: '打开对象目录' }));
  await user.click(await screen.findByRole('button', { name: '选择 Light A' }));
  const inspector = screen.getByRole('complementary', { name: '对象信息' });
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  server.use(
    http.get(
      'http://api.test/api/v1/lab/labs/detail-lab/world',
      () =>
        new HttpResponse(
          new ReadableStream({
            start(controller) {
              controllers.push(controller);
              controller.enqueue(new TextEncoder().encode('{'));
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    ),
  );
  try {
    await user.click(
      within(inspector).getByRole('button', { name: '停止程序' }),
    );
    expect(
      await within(inspector).findByText('来源已停止，最后观测保留。'),
    ).toBeVisible();
    await user.click(
      within(inspector).getByRole('button', { name: '启动程序' }),
    );
    expect(
      await within(inspector).findByText('来源已启动，等待此 Run 的新观测。'),
    ).toBeVisible();
    const power = within(inspector).getByRole('region', { name: '观测电源' });
    expect(within(power).queryByText('当前观测')).not.toBeInTheDocument();
    expect(within(power).getByText('最后报告值')).toBeVisible();
    await user.click(within(inspector).getByRole('tab', { name: '详情' }));
    expect(
      within(
        within(inspector).getByRole('tabpanel', { name: '详情' }),
      ).getByText('run-new-light-0'),
    ).toBeVisible();
    entities[0].program_run = {
      ...entities[0].program_run!,
      id: 'run-other-actor',
    };
    publish();
    const details = within(inspector).getByRole('tabpanel', { name: '详情' });
    expect(await within(details).findByText('run-other-actor')).toBeVisible();
    expect(
      within(details).queryByText('run-new-light-0'),
    ).not.toBeInTheDocument();
  } finally {
    controllers.forEach((controller) => {
      try {
        controller.error(new Error('Owned pending refresh released'));
      } catch {
        // Query cancellation can already have closed this owned body.
      }
    });
  }
});
