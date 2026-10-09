import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import {
  createApiClient,
  type AssetDefinition,
  type CurrentSession,
  type LabEntity,
  type ObservationProperty,
} from '@labos-threejs/sdk';
import { act, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { createAppRouter } from './router';

const identity = {
  user: {
    id: 'details-member',
    email: 'details@example.test',
    display_name: 'Details member',
    role: 'member',
  },
  csrf_token: 'details-csrf',
} satisfies CurrentSession;
const definitions: AssetDefinition[] = JSON.parse(
  readFileSync('crates/app/src/modules/lab/definitions.json', 'utf8'),
);
function device(id: string, definitionId = 'sensor'): LabEntity {
  const definition = definitions.find((entry) => entry.id === definitionId)!;
  return {
    id,
    lab_id: 'details-lab',
    name: id,
    kind: definition.category,
    reality: 'simulated',
    definition_id: definitionId,
    definition_version: definition.version,
    definition,
    configuration: {},
    representation_id: null,
    created_by: identity.user.id,
    updated_by: identity.user.id,
    created_at: '2026-10-04T06:00:00Z',
    updated_at: '2026-10-04T06:00:00Z',
    archived_at: null,
    binding: {
      id: `binding-${id}`,
      entity_id: id,
      program_id: `${definitionId}.v1`,
      source: `simulated:${id}`,
      definition_id: definitionId,
      definition_version: definition.version,
      definition,
    },
    program_run: {
      id: `run-${id}`,
      entity_id: id,
      binding_id: `binding-${id}`,
      program_id: `${definitionId}.v1`,
      source: `simulated:${id}`,
      definition_id: definitionId,
      definition_version: definition.version,
      definition,
      configuration: {},
      status: 'running',
      started_by: identity.user.id,
      started_at: '2026-10-04T06:00:00Z',
      ended_at: null,
    },
    observation: null,
    task: null,
    task_result: null,
    capabilities: definition.capabilities.map((capability) => ({
      ...capability,
      version: capability.version ?? '1.0',
      result: capability.result ?? null,
      definition_supported: true,
      binding_implemented: true,
      executable: true,
      reason: 'ready',
    })),
  };
}
function report(entity: LabEntity, name: string, value: unknown) {
  const property: ObservationProperty = {
    value,
    unit: name === 'on' ? null : name === 'brightness' ? '%' : 'degC',
    binding_id: entity.binding!.id,
    run_id: entity.program_run!.id,
    sequence: 1,
    source: entity.binding!.source,
    observed_at: '2026-10-04T06:00:01.123456789Z',
    received_at: '2026-10-04T06:00:02.123456789Z',
    updated_at: '2026-10-04T06:00:02.123456789Z',
    expires_at: '2026-10-04T06:00:07.123456789Z',
    quality: 'good',
    freshness: 'current',
  };
  entity.observation = {
    entity_id: entity.id,
    run_id: entity.program_run!.id,
    sequence: 1,
    source: property.source,
    values: {
      ...(entity.observation?.values as Record<string, unknown> | undefined),
      [name]: value,
    },
    observed_at: property.observed_at,
    received_at: property.received_at,
    updated_at: property.updated_at,
    quality: 'good',
    freshness: 'current',
    properties: { ...entity.observation?.properties, [name]: property },
  };
  return property;
}
function openDetails(entities: LabEntity[]) {
  const lab = { id: 'details-lab', name: 'Details lab', layout_version: 0 };
  let version = 0;
  const world = () => ({
    version: String(++version),
    lab,
    entities,
    nodes: [],
    assets: [],
    relationships: [],
  });
  let publish: (() => void) | undefined;
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
    http.get('http://api.test/api/v1/lab/labs/details-lab/world', () =>
      HttpResponse.json(world()),
    ),
    http.get(
      'http://api.test/api/v1/lab/labs/details-lab/world/subscribe',
      () =>
        new HttpResponse(
          new ReadableStream({
            start(controller) {
              publish = () =>
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({ type: 'snapshot', world: world() })}\n\n`,
                  ),
                );
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"runtime_status","available":true}\n\n',
                ),
              );
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ type: 'snapshot', world: world() })}\n\n`,
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
    createMemoryHistory({
      initialEntries: [`/lab?lab=details-lab&entity=${entities[0].id}`],
    }),
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
  return { user: userEvent.setup(), publish: () => publish?.() };
}

test('Details identifies a newly started light Run before its first property report', async () => {
  const light = device('New light', 'light');
  const run = { ...light.program_run!, id: 'unreported-light-run' };
  light.program_run = null;
  server.use(
    http.post(
      'http://api.test/api/v1/lab/labs/details-lab/entities/:id/program/start',
      () => {
        light.program_run = run;
        return HttpResponse.json(run, { status: 201 });
      },
    ),
  );
  const { user } = openDetails([light]);
  await user.click(await screen.findByRole('button', { name: '启动程序' }));
  await screen.findByRole('button', { name: '停止程序' });
  await user.click(screen.getByRole('tab', { name: '详情' }));
  const details = screen.getByRole('tabpanel', { name: '详情' });
  expect(await within(details).findByText(run.id)).toBeVisible();
  expect(within(details).getAllByText(light.binding!.id)[0]).toBeVisible();
  expect(within(details).getAllByText(light.id)[0]).toBeVisible();
  expect(within(details).getByText('light · 1.0')).toBeVisible();
  expect(light.observation).toBeNull();
});

test('Details distinguishes current source identities from an old report and retained task result after restart', async () => {
  const centrifuge = device('Retained centrifuge', 'centrifuge');
  const property = report(centrifuge, 'temperature', 4);
  property.freshness = 'stale';
  const oldRun = centrifuge.program_run!.id;
  centrifuge.task = {
    id: 'retained-task',
    entity_id: centrifuge.id,
    run_id: oldRun,
    command_id: 'retained-command',
    result_id: 'retained-result',
    status: 'completed',
    elapsed_seconds: 30,
    parameters: { rpm: 7000, temperature: 4, duration_seconds: 30 },
    created_at: property.received_at,
    ended_at: property.received_at,
  };
  centrifuge.task_result = {
    id: 'retained-result',
    task_id: 'retained-task',
    status: 'completed',
    reason: null,
    ended_at: property.received_at,
  };
  server.use(
    http.post(
      'http://api.test/api/v1/lab/labs/details-lab/entities/:id/program/stop',
      () => {
        centrifuge.program_run!.status = 'stopped';
        return HttpResponse.json(centrifuge.program_run);
      },
    ),
    http.post(
      'http://api.test/api/v1/lab/labs/details-lab/entities/:id/program/start',
      () => {
        centrifuge.program_run = {
          ...centrifuge.program_run!,
          id: 'current-restarted-run',
          status: 'running',
        };
        return HttpResponse.json(centrifuge.program_run, { status: 201 });
      },
    ),
  );
  const { user } = openDetails([centrifuge]);
  await user.click(await screen.findByRole('button', { name: '重新启动程序' }));
  await user.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: '重新启动程序',
    }),
  );
  await screen.findByText('已启动新程序，旧任务结果保留');
  await user.click(screen.getByRole('tab', { name: '详情' }));
  const details = screen.getByRole('tabpanel', { name: '详情' });
  expect(
    await within(details).findByText('current-restarted-run'),
  ).toBeVisible();
  expect(within(details).getAllByText(oldRun)[0]).toBeVisible();
  expect(within(details).getByText('retained-task')).toBeVisible();
  expect(within(details).getByText('retained-result')).toBeVisible();
  expect(within(details).getAllByText(property.received_at)[0]).toBeVisible();
});

test('a source confirmation cannot submit after another member stops and archives the entity', async () => {
  const sensor = device('Archived sensor');
  let stops = 0;
  server.use(
    http.post(
      'http://api.test/api/v1/lab/labs/details-lab/entities/:id/program/stop',
      () => {
        stops++;
        return HttpResponse.json(sensor.program_run);
      },
    ),
  );
  const { user, publish } = openDetails([sensor]);
  await user.click(await screen.findByRole('button', { name: '停止程序' }));
  const dialog = screen.getByRole('dialog');
  sensor.program_run!.status = 'stopped';
  sensor.archived_at = '2026-10-04T06:05:00Z';
  await act(async () => publish());
  await waitFor(() =>
    expect(
      within(dialog).getByRole('button', { name: '停止程序' }),
    ).toBeDisabled(),
  );
  expect(stops).toBe(0);
});

test('stopping a source preserves zero and its original property provenance as a last report', async () => {
  const sensor = device('Sensor A');
  const property = report(sensor, 'temperature', 0);
  server.use(
    http.post(
      'http://api.test/api/v1/lab/labs/details-lab/entities/:id/program/stop',
      () => {
        sensor.program_run!.status = 'stopped';
        sensor.observation!.freshness = 'stopped';
        return HttpResponse.json(sensor.program_run);
      },
    ),
  );
  const { user } = openDetails([sensor]);
  const inspector = await screen.findByRole('complementary', {
    name: '对象信息',
  });
  await user.click(
    await within(inspector).findByRole('button', { name: '停止程序' }),
  );
  await user.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: '停止程序',
    }),
  );
  const reading = await within(inspector).findByRole('region', {
    name: '观测温度',
  });
  expect(await within(reading).findByText('最后报告值')).toBeVisible();
  expect(within(reading).getByText('0 degC')).toBeVisible();
  expect(within(reading).getByText(property.source)).toBeVisible();
  expect(
    reading.querySelector(`time[datetime="${property.received_at}"]`),
  ).toBeVisible();
  expect(within(reading).queryByText('当前观测')).not.toBeInTheDocument();
});

test('an uncertain quality reading stays visible without being called current', async () => {
  const sensor = device('Sensor A');
  const property = report(sensor, 'temperature', 21.5);
  property.quality = 'uncertain';
  openDetails([sensor]);
  const reading = await screen.findByRole('region', { name: '观测温度' });
  expect(await within(reading).findByText('最后报告值')).toBeVisible();
  expect(within(reading).getByText('21.5 degC')).toBeVisible();
  expect(within(reading).getByText('不确定')).toBeVisible();
  expect(within(reading).queryByText('当前观测')).not.toBeInTheDocument();
});

test('a missing actual value is unknown rather than a current null or invented zero', async () => {
  const sensor = device('Sensor A');
  report(sensor, 'temperature', null);
  openDetails([sensor]);
  const reading = await screen.findByRole('region', { name: '观测温度' });
  expect(
    (await within(reading).findAllByText('未知 · 无观测'))[0],
  ).toBeVisible();
  expect(within(reading).queryByText('null degC')).not.toBeInTheDocument();
  expect(within(reading).queryByText('当前观测')).not.toBeInTheDocument();
});

test('each centrifuge keeps its own task input when the member switches devices', async () => {
  const a = device('Centrifuge A', 'centrifuge');
  const b = device('Centrifuge B', 'centrifuge');
  const { user } = openDetails([a, b]);
  const input = await screen.findByLabelText('目标转速 (rpm)');
  await user.clear(input);
  await user.type(input, '7000');
  await user.click(screen.getByRole('button', { name: '打开对象目录' }));
  await user.click(screen.getByRole('button', { name: '选择 Centrifuge B' }));
  const second = screen.getByLabelText('目标转速 (rpm)');
  expect(second).toHaveValue(6000);
  await user.clear(second);
  await user.type(second, '8000');
  await user.click(screen.getByRole('button', { name: '选择 Centrifuge A' }));
  expect(screen.getByLabelText('目标转速 (rpm)')).toHaveValue(7000);
  await user.click(screen.getByRole('button', { name: '选择 Centrifuge B' }));
  expect(screen.getByLabelText('目标转速 (rpm)')).toHaveValue(8000);
});

test('the same detail exposes operations, retained records and full identity in separate tabs', async () => {
  const sensor = device('Sensor A');
  report(sensor, 'temperature', 21.5);
  server.use(
    http.get(
      'http://api.test/api/v1/lab/labs/details-lab/entities/:id/history',
      () =>
        HttpResponse.json({
          items: [],
          next_cursor: null,
          retention: { observation_seconds: 86400, record_seconds: 2592000 },
          available_from: null,
          available_to: null,
          gaps: [],
        }),
    ),
  );
  const { user } = openDetails([sensor]);
  expect(await screen.findByRole('tab', { name: '操作' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await user.click(screen.getByRole('tab', { name: '详情' }));
  expect(screen.getByText('Entity')).toBeVisible();
  await user.click(screen.getByRole('tab', { name: '记录' }));
  expect(await screen.findByText('没有保留期内记录')).toBeVisible();
  await user.click(screen.getByRole('tab', { name: '操作' }));
  expect(screen.getByRole('region', { name: '观测温度' })).toBeVisible();
});

test('stopping a task requires confirmation and keeps program stop constrained while the task is active', async () => {
  const centrifuge = device('Centrifuge A', 'centrifuge');
  centrifuge.task = {
    id: 'task-a',
    entity_id: centrifuge.id,
    run_id: centrifuge.program_run!.id,
    command_id: 'start-a',
    result_id: 'result-a',
    status: 'running',
    elapsed_seconds: 3,
    parameters: { rpm: 7000, temperature: 8, duration_seconds: 30 },
    created_at: '2026-10-04T06:00:00Z',
    timer_started_at: '2026-10-04T06:00:02Z',
    ended_at: null,
  };
  const commands: unknown[] = [];
  server.use(
    http.post(
      'http://api.test/api/v1/lab/labs/details-lab/entities/:id/actions',
      async ({ request }) => {
        commands.push(await request.json());
        centrifuge.task!.status = 'decelerating';
        return HttpResponse.json(
          { id: 'stop-a', status: 'succeeded' },
          { status: 202 },
        );
      },
    ),
    http.get(
      'http://api.test/api/v1/lab/labs/details-lab/entities/:id/commands/stop-a',
      () => HttpResponse.json({ id: 'stop-a', status: 'succeeded' }),
    ),
  );
  const { user } = openDetails([centrifuge]);
  const stop = await screen.findByRole('button', { name: '停止离心' });
  expect(screen.getByRole('button', { name: '停止程序' })).toBeDisabled();
  await user.click(stop);
  const confirmation = await screen.findByRole('dialog', {
    name: '停止当前离心任务？',
  });
  expect(commands).toHaveLength(0);
  await user.click(
    within(confirmation).getByRole('button', { name: '继续运行' }),
  );
  expect(stop).toHaveFocus();
  await user.click(stop);
  await user.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: '停止离心',
    }),
  );
  expect(
    await within(screen.getByRole('tabpanel', { name: '操作' })).findByText(
      '减速中',
    ),
  ).toBeVisible();
  expect(commands).toEqual([{ capability: 'centrifuge.stop', parameters: {} }]);
});

test.each([
  ['old Run', { run_id: 'retired-run' }],
  ['old Binding', { binding_id: 'retired-binding' }],
  ['expired', { freshness: 'stale' }],
  ['bad quality', { quality: 'bad' }],
  ['unknown source time', { observed_at: null }],
  ['absent source time', { observed_at: undefined }],
  ['wrong value type', { value: '0' }],
] satisfies [string, Partial<ObservationProperty>][])(
  '%s cannot make a property current',
  async (_name, change) => {
    const sensor = device('Sensor A');
    const property = report(sensor, 'temperature', 0);
    Object.assign(property, change);
    openDetails([sensor]);
    const reading = await screen.findByRole('region', { name: '观测温度' });
    expect(within(reading).queryByText('当前观测')).not.toBeInTheDocument();
  },
);

test('a new running program keeps the previous property identity and timestamps until a new report arrives', async () => {
  const sensor = device('Sensor A');
  const property = report(sensor, 'temperature', 0);
  sensor.program_run!.status = 'stopped';
  server.use(
    http.post(
      'http://api.test/api/v1/lab/labs/details-lab/entities/:id/program/start',
      () => {
        sensor.program_run = {
          ...sensor.program_run!,
          id: 'new-run',
          status: 'running',
        };
        return HttpResponse.json(sensor.program_run, { status: 201 });
      },
    ),
  );
  const { user } = openDetails([sensor]);
  await user.click(await screen.findByRole('button', { name: '启动程序' }));
  const reading = screen.getByRole('region', { name: '观测温度' });
  expect(
    await within(reading).findByText('当前程序尚未报告 · 保留旧运行值'),
  ).toBeVisible();
  expect(within(reading).getByText('0 degC')).toBeVisible();
  expect(
    reading.querySelector(`time[datetime="${property.received_at}"]`),
  ).toBeVisible();
  await user.click(screen.getByRole('tab', { name: '详情' }));
  const details = screen.getByRole('tabpanel', { name: '详情' });
  expect(within(details).getByText(property.run_id)).toBeVisible();
  expect(within(details).getAllByText(property.received_at)[0]).toBeVisible();
});

test('source restart stops before starting and a failed stop preserves the report without starting', async () => {
  const sensor = device('Sensor A');
  const property = report(sensor, 'temperature', 21.5);
  property.freshness = 'stale';
  let starts = 0;
  server.use(
    http.post(
      'http://api.test/api/v1/lab/labs/details-lab/entities/:id/program/stop',
      () =>
        HttpResponse.json(
          {
            error: {
              code: 'lab.device_busy',
              message: 'Device busy',
              request_id: 'stop-failed',
            },
          },
          { status: 409 },
        ),
    ),
    http.post(
      'http://api.test/api/v1/lab/labs/details-lab/entities/:id/program/start',
      () => {
        starts++;
        return HttpResponse.json(sensor.program_run);
      },
    ),
  );
  const { user } = openDetails([sensor]);
  await user.click(await screen.findByRole('button', { name: '重新启动程序' }));
  await user.click(
    within(
      await screen.findByRole('dialog', { name: '重新启动设备程序？' }),
    ).getByRole('button', { name: '重新启动程序' }),
  );
  expect(await screen.findByText('停止失败，程序未重新启动')).toBeVisible();
  expect(starts).toBe(0);
  const reading = screen.getByRole('region', { name: '观测温度' });
  expect(within(reading).getByText('21.5 degC')).toBeVisible();
  expect(
    reading.querySelector(`time[datetime="${property.received_at}"]`),
  ).toBeVisible();
});

test('a partial source restart stays stopped and requires an explicit start while retaining the old task result', async () => {
  const centrifuge = device('Centrifuge A', 'centrifuge');
  const property = report(centrifuge, 'temperature', 4);
  property.freshness = 'stale';
  centrifuge.task = {
    id: 'old-task',
    entity_id: centrifuge.id,
    run_id: centrifuge.program_run!.id,
    command_id: 'old-command',
    result_id: 'old-result',
    status: 'interrupted',
    elapsed_seconds: 7,
    parameters: { rpm: 7000, temperature: 8, duration_seconds: 30 },
    created_at: property.received_at,
  };
  centrifuge.task_result = {
    id: 'old-result',
    task_id: 'old-task',
    status: 'interrupted',
    reason: 'runtime_interrupted',
  };
  const requests: string[] = [];
  server.use(
    http.post(
      'http://api.test/api/v1/lab/labs/details-lab/entities/:id/program/stop',
      () => {
        requests.push('stop');
        centrifuge.program_run!.status = 'stopped';
        return HttpResponse.json(centrifuge.program_run);
      },
    ),
    http.post(
      'http://api.test/api/v1/lab/labs/details-lab/entities/:id/program/start',
      () => {
        requests.push('start');
        if (requests.length === 2)
          return HttpResponse.json(
            {
              error: {
                code: 'lab.runtime_unavailable',
                message: 'Runtime not ready',
                request_id: 'start-failed',
              },
            },
            { status: 503 },
          );
        centrifuge.program_run = {
          ...centrifuge.program_run!,
          id: 'new-run',
          status: 'running',
        };
        return HttpResponse.json(centrifuge.program_run, { status: 201 });
      },
    ),
  );
  const { user } = openDetails([
    centrifuge,
    device('Centrifuge B', 'centrifuge'),
  ]);
  await user.click(await screen.findByRole('button', { name: '重新启动程序' }));
  await user.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: '重新启动程序',
    }),
  );
  expect(await screen.findByText('程序已停止，启动失败')).toBeVisible();
  expect(requests).toEqual(['stop', 'start']);
  expect(
    within(screen.getByRole('tabpanel', { name: '操作' })).getByText(
      'old-result',
    ),
  ).toBeVisible();
  await user.click(screen.getByRole('button', { name: '打开对象目录' }));
  await user.click(screen.getByRole('button', { name: '选择 Centrifuge B' }));
  expect(screen.queryByText('程序已停止，启动失败')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '选择 Centrifuge A' }));
  expect(screen.getByText('程序已停止，启动失败')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '启动程序' }));
  expect(await screen.findByText('程序已启动，等待实际报告')).toBeVisible();
  expect(requests).toEqual(['stop', 'start', 'start']);
  expect(
    within(screen.getByRole('tabpanel', { name: '操作' })).getByText(
      'old-result',
    ),
  ).toBeVisible();
  expect(centrifuge.task?.id).toBe('old-task');
  expect(centrifuge.task_result?.status).toBe('interrupted');
});

test('cancelling while task acceptance is pending keeps both original Command identities', async () => {
  const centrifuge = device('Centrifuge A', 'centrifuge');
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const startRequested = new Promise<void>((resolve) => {
    started = resolve;
  });
  const requests: { capability: string; key: string | null }[] = [];
  server.use(
    http.post(
      'http://api.test/api/v1/lab/labs/details-lab/entities/:id/actions',
      async ({ request }) => {
        const input = (await request.json()) as { capability: string };
        requests.push({
          capability: input.capability,
          key: request.headers.get('idempotency-key'),
        });
        if (input.capability === 'centrifuge.start') {
          started();
          await pending;
        }
        return HttpResponse.json(
          {
            id:
              input.capability === 'centrifuge.start'
                ? 'original-start'
                : 'explicit-stop',
            status: 'succeeded',
            ...input,
          },
          { status: 202 },
        );
      },
    ),
    http.get(
      'http://api.test/api/v1/lab/labs/details-lab/entities/:id/commands/:command',
      ({ params }) =>
        HttpResponse.json({ id: params.command, status: 'succeeded' }),
    ),
  );
  const { user } = openDetails([centrifuge]);
  try {
    await user.click(await screen.findByRole('button', { name: '开始离心' }));
    await startRequested;
    expect(screen.getByRole('button', { name: '开始离心' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '停止离心' }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: '停止离心',
      }),
    );
    expect(await screen.findByText('explicit-stop')).toBeVisible();
    release();
    expect(await screen.findByText('original-start')).toBeVisible();
    expect(screen.getByText('explicit-stop')).toBeVisible();
    expect(requests.map((entry) => entry.capability)).toEqual([
      'centrifuge.start',
      'centrifuge.stop',
    ]);
    expect(requests[0].key).not.toBe(requests[1].key);
  } finally {
    release();
  }
});

test('an active task displays its fixed submitted targets rather than new-task defaults', async () => {
  const centrifuge = device('Centrifuge A', 'centrifuge');
  centrifuge.task = {
    id: 'task-a',
    entity_id: centrifuge.id,
    run_id: centrifuge.program_run!.id,
    command_id: 'start-a',
    result_id: 'result-a',
    status: 'preparing',
    elapsed_seconds: 0,
    parameters: { rpm: 7000, temperature: 8, duration_seconds: 30 },
    created_at: '2026-10-04T06:00:00Z',
  };
  openDetails([centrifuge]);
  expect(await screen.findByLabelText('目标转速 (rpm)')).toHaveValue(7000);
  expect(screen.getByLabelText('目标温度 (degC)')).toHaveValue(8);
  expect(screen.getByLabelText('任务时长 (s)')).toHaveValue(30);
  expect(screen.getByLabelText('目标转速 (rpm)')).toBeDisabled();
});

test('a light requires both typed key properties, with false and zero retained as valid observations', async () => {
  const light = device('Light A', 'light');
  report(light, 'on', false);
  const { user } = openDetails([light]);
  const validity = await screen.findByLabelText('关键观测有效性');
  expect(validity).toHaveTextContent('关键观测尚不可用');
  expect(screen.getByRole('region', { name: '观测电源' })).toHaveTextContent(
    '关闭',
  );
  report(light, 'brightness', 0);
  await user.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByLabelText('关键观测有效性')).toHaveTextContent(
    '当前关键观测有效',
  );
  const brightness = screen.getByRole('region', { name: '观测亮度' });
  expect(within(brightness).getByText('0 %')).toBeVisible();
  expect(within(brightness).getByText('当前观测')).toBeVisible();
});

test('disconnection freezes a last-report snapshot and inputs, then actual reconnect restores the new World', async () => {
  const light = device('Light A', 'light');
  report(light, 'on', false);
  const last = report(light, 'brightness', 0);
  const { user } = openDetails([light]);
  const brightnessInput = await screen.findByLabelText('目标亮度 (%)');
  await user.clear(brightnessInput);
  await user.type(brightnessInput, '37');
  await act(async () => window.dispatchEvent(new Event('offline')));
  expect(await screen.findByText('连接中断，保留最后快照')).toBeVisible();
  const reading = screen.getByRole('region', { name: '观测亮度' });
  expect(within(reading).getByText('最后报告值')).toBeVisible();
  expect(within(reading).getByText('0 %')).toBeVisible();
  expect(
    reading.querySelector(`time[datetime="${last.received_at}"]`),
  ).toBeVisible();
  expect(screen.getByRole('button', { name: '设置' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '配置对象' })).toBeDisabled();
  const latest = report(light, 'brightness', 55);
  latest.received_at = '2026-10-04T06:00:04.123456789Z';
  await act(async () => window.dispatchEvent(new Event('online')));
  await waitFor(() =>
    expect(screen.getByRole('region', { name: '观测亮度' })).toHaveTextContent(
      '55 %',
    ),
  );
  expect(screen.getByLabelText('目标亮度 (%)')).toHaveValue(37);
  expect(screen.getByRole('button', { name: '设置' })).toBeEnabled();
});

test('a credential rejected by the action ends protected access and recovery uses the existing login flow', async () => {
  const light = device('Light A', 'light');
  report(light, 'on', false);
  report(light, 'brightness', 0);
  const { user } = openDetails([light]);
  const power = await screen.findByRole('switch', { name: '电源' });
  let active = false;
  let submissions = 0;
  const unauthorized = {
    error: {
      code: 'auth.unauthorized',
      message: 'Authentication required',
      request_id: 'credential-ended',
    },
  };
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      active
        ? HttpResponse.json(identity)
        : HttpResponse.json(unauthorized, { status: 401 }),
    ),
    http.post(
      'http://api.test/api/v1/lab/labs/details-lab/entities/:id/actions',
      () => {
        submissions++;
        return HttpResponse.json(unauthorized, { status: 401 });
      },
    ),
    http.post('http://api.test/api/v1/auth/login', () => {
      active = true;
      return HttpResponse.json(identity);
    }),
  );
  await user.click(power);
  await waitFor(() =>
    expect(
      screen.queryByRole('complementary', { name: '对象信息' }),
    ).not.toBeInTheDocument(),
  );
  await user.click(screen.getByRole('button', { name: '登录' }));
  await user.type(screen.getByLabelText('邮箱'), identity.user.email);
  await user.type(screen.getByLabelText('密码'), 'restored-password');
  await user.click(screen.getByRole('button', { name: '登录' }));
  await user.click(await screen.findByRole('button', { name: '打开对象目录' }));
  await user.click(screen.getByRole('button', { name: '选择 Light A' }));
  expect(
    await screen.findByRole('region', { name: '观测电源' }),
  ).toHaveTextContent('关闭');
  expect(screen.queryByText('命令被拒绝')).not.toBeInTheDocument();
  expect(submissions).toBe(1);
});

test('an unbound physical robot exposes declared, implemented and executable capability facts in the normal detail', async () => {
  const robot = device('Physical robot', 'robot');
  robot.reality = 'physical';
  robot.binding = null;
  robot.program_run = null;
  robot.capabilities = robot.capabilities.map((capability) => ({
    ...capability,
    binding_implemented: false,
    executable: false,
    reason: 'binding_not_implemented',
  }));
  openDetails([robot]);
  const capabilities = await screen.findByRole('region', { name: '设备能力' });
  expect(within(capabilities).getByText('robot.pick')).toBeVisible();
  expect(within(capabilities).getAllByText('已声明')).toHaveLength(3);
  expect(within(capabilities).getAllByText('尚未实现')).toHaveLength(3);
  expect(within(capabilities).getAllByText('当前不可执行')).toHaveLength(3);
  expect(
    screen.queryByRole('button', { name: '启动程序' }),
  ).not.toBeInTheDocument();
});

test('a Command with an unknown result in the same Run is queried by its original identity without another action', async () => {
  const light = device('Light A', 'light');
  report(light, 'on', false);
  report(light, 'brightness', 0);
  let submissions = 0,
    queries = 0;
  const command = {
    id: 'unknown-command',
    run_id: light.program_run!.id,
    status: 'unknown',
    result: { reason: 'execution_uncertain' },
  };
  server.use(
    http.post(
      'http://api.test/api/v1/lab/labs/details-lab/entities/:id/actions',
      () => {
        submissions++;
        return HttpResponse.json(command, { status: 202 });
      },
    ),
    http.get(
      'http://api.test/api/v1/lab/labs/details-lab/entities/:id/commands/unknown-command',
      () => {
        queries++;
        return HttpResponse.json(command);
      },
    ),
  );
  const { user } = openDetails([light]);
  const input = await screen.findByLabelText('目标亮度 (%)');
  await user.clear(input);
  await user.type(input, '37');
  await user.click(screen.getByRole('button', { name: '设置' }));
  expect(await screen.findByText('unknown-command')).toBeVisible();
  expect(screen.getByRole('button', { name: '设置' })).toBeDisabled();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '刷新命令' })).toBeEnabled(),
  );
  const previousQueries = queries;
  await user.click(screen.getByRole('button', { name: '刷新命令' }));
  await waitFor(() => expect(queries).toBeGreaterThan(previousQueries));
  expect(submissions).toBe(1);
  expect(screen.getByLabelText('目标亮度 (%)')).toHaveValue(37);
  expect(screen.getByRole('region', { name: '观测亮度' })).toHaveTextContent(
    '0 %',
  );
  expect(screen.getByText('结果不确定')).toBeVisible();
});
