import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { createApiClient, type CurrentSession } from '@labos-threejs/sdk';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { createAppRouter } from './router';

test('the temperature Inspector keeps expired measurements and shows source time honestly after recovery', async () => {
  const identity = {
    user: {
      id: 'sensor-member',
      email: 'sensors@example.test',
      display_name: 'Sensors',
      role: 'member',
    },
    csrf_token: 'sensor-csrf',
  } satisfies CurrentSession;
  const definitions = JSON.parse(
    readFileSync('packages/server/src/lab/world/catalog.json', 'utf8'),
  );
  const definition = definitions.find(
    (entry: { id: string }) => entry.id === 'sensor',
  );
  const lab = {
    id: 'temperature-lab',
    name: 'Temperature lab',
    layout_version: 1,
  };
  const entity = {
    id: 'sensor-a',
    lab_id: lab.id,
    name: 'Sensor A',
    kind: 'sensor',
    reality: 'simulated',
    definition_id: 'sensor',
    definition_version: '1.0',
    definition,
    configuration: {},
    representation_id: null,
    binding: {
      id: 'sensor-binding',
      entity_id: 'sensor-a',
      program_id: 'sensor.v1',
      source: 'simulated:sensor.v1:sensor-binding',
    },
    program_run: null as Record<string, unknown> | null,
    observation: null as Record<string, unknown> | null,
    capabilities: [],
  };
  let version = 0;
  let starts = 0;
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json(identity),
    ),
    http.get('http://api.test/api/v1/lab/labs', () =>
      HttpResponse.json({ data: [lab] }),
    ),
    http.get('http://api.test/api/v1/lab/assets', () =>
      HttpResponse.json({ data: [], has_more: false, next_cursor: null }),
    ),
    http.get('http://api.test/api/v1/lab/asset-definitions', () =>
      HttpResponse.json({ data: definitions }),
    ),
    http.get('http://api.test/api/v1/lab/labs/temperature-lab/world', () =>
      HttpResponse.json({
        version: String(++version),
        lab,
        entities: [entity],
        nodes: [],
        assets: [],
        relationships: [],
      }),
    ),
    http.get(
      'http://api.test/api/v1/lab/labs/temperature-lab/world/subscribe',
      () =>
        new HttpResponse(
          new ReadableStream({
            start(controller) {
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
      'http://api.test/api/v1/lab/labs/temperature-lab/entities/sensor-a/program/start',
      ({ request }) => {
        expect(request.headers.get('x-csrf-token')).toBe(identity.csrf_token);
        starts++;
        entity.program_run = {
          id: `sensor-run-${starts}`,
          binding_id: entity.binding.id,
          status: 'running',
        };
        const observed_at = starts === 1 ? '2026-10-03T06:00:00Z' : null;
        const freshness = starts === 1 ? 'current' : 'source_time_unknown';
        const quality = starts === 1 ? 'good' : 'uncertain';
        const value = starts === 1 ? 21.5 : 22.4;
        const property = {
          value,
          unit: 'degC',
          binding_id: 'sensor-binding',
          run_id: entity.program_run.id,
          sequence: 1,
          source: entity.binding.source,
          observed_at,
          received_at: '2026-10-03T06:00:01Z',
          updated_at: '2026-10-03T06:00:01Z',
          expires_at: '2026-10-03T06:00:06Z',
          quality,
          freshness,
        };
        entity.observation = {
          entity_id: entity.id,
          run_id: entity.program_run.id,
          sequence: 1,
          source: entity.binding.source,
          values: { temperature: value },
          observed_at,
          received_at: property.received_at,
          updated_at: property.updated_at,
          quality,
          freshness,
          properties: { temperature: property },
        };
        return HttpResponse.json(entity.program_run, { status: 201 });
      },
    ),
    http.post(
      'http://api.test/api/v1/lab/labs/temperature-lab/entities/sensor-a/program/stop',
      () => {
        entity.program_run!['status'] = 'stopped';
        entity.observation!['freshness'] = 'stale';
        (
          entity.observation!['properties'] as {
            temperature: { freshness: string };
          }
        ).temperature.freshness = 'stale';
        return HttpResponse.json(entity.program_run);
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
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '打开对象目录' }));
  await user.click(
    await screen.findByRole('button', { name: '选择 Sensor A' }),
  );
  const inspector = screen.getByRole('complementary', { name: '对象信息' });
  expect(
    within(
      within(inspector).getByRole('region', { name: '观测温度' }),
    ).getByText('未知 · 无观测', { exact: true }),
  ).toBeVisible();
  await user.click(within(inspector).getByRole('button', { name: '启动程序' }));
  expect(
    await within(
      within(inspector).getByRole('region', { name: '观测温度' }),
    ).findByText('21.5 degC', { exact: true }),
  ).toBeVisible();
  expect(
    within(inspector).getByRole('region', { name: '观测温度' }),
  ).toBeVisible();
  expect(
    within(
      within(inspector).getByRole('region', { name: '观测温度' }),
    ).getByText(entity.binding.source, { exact: true }),
  ).toBeVisible();
  expect(
    within(inspector).queryByRole('switch', { name: '电源' }),
  ).not.toBeInTheDocument();
  expect(
    within(inspector).queryByRole('spinbutton', { name: '目标亮度' }),
  ).not.toBeInTheDocument();
  await user.click(within(inspector).getByRole('button', { name: '停止程序' }));
  expect(
    await within(
      within(inspector).getByRole('region', { name: '观测温度' }),
    ).findByText('观测已过期 · 保留最后值', { exact: true }),
  ).toBeVisible();
  expect(
    within(
      within(inspector).getByRole('region', { name: '观测温度' }),
    ).getByText('21.5 degC', { exact: true }),
  ).toBeVisible();
  await user.click(within(inspector).getByRole('button', { name: '启动程序' }));
  expect(
    await within(
      within(inspector).getByRole('region', { name: '观测温度' }),
    ).findByText('22.4 degC', { exact: true }),
  ).toBeVisible();
  const temperature = within(inspector).getByRole('region', {
    name: '观测温度',
  });
  expect(
    within(temperature).getAllByText('来源时间未知', { exact: true }),
  ).toHaveLength(2);
  expect(
    within(temperature).getByText('不确定', { exact: true }),
  ).toBeVisible();
  expect(temperature.querySelector('time')).toHaveAttribute(
    'datetime',
    '2026-10-03T06:00:01Z',
  );
  await user.click(screen.getByRole('button', { name: 'English' }));
  const english = within(
    screen.getByRole('complementary', { name: 'Object info' }),
  ).getByRole('region', { name: 'Reported temperature' });
  expect(english).toBeVisible();
  expect(within(english).getByText('Uncertain', { exact: true })).toBeVisible();
});
