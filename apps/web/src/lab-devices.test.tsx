import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { createApiClient, type CurrentSession } from '@labos-threejs/sdk';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { createAppRouter } from './router';
const identity = {
  user: {
    id: 'device-user',
    email: 'lights@example.test',
    display_name: 'Lights',
    role: 'member',
  },
  csrf_token: 'device-csrf',
} satisfies CurrentSession;
function openLights() {
  const definitions = JSON.parse(
    readFileSync('crates/app/src/modules/lab/definitions.json', 'utf8'),
  );
  const definition = definitions.find(
    (entry: { id: string }) => entry.id === 'light',
  );
  const lab = { id: 'lighting-lab', name: 'Lighting lab', layout_version: 2 };
  const entities = ['Light A', 'Light B'].map((name, index) => ({
    id: `light-${index}`,
    lab_id: lab.id,
    name,
    kind: 'iot',
    reality: 'simulated',
    definition_id: 'light',
    definition_version: '1.0',
    definition,
    configuration: { brightness: 100 },
    representation_id: null,
    binding: {
      id: `binding-${index}`,
      entity_id: `light-${index}`,
      program_id: 'light.v1',
      source: `simulated:light:${index}`,
    },
    program_run: null as Record<string, unknown> | null,
    observation: null as Record<string, unknown> | null,
    capabilities: definition.capabilities.map(
      (capability: Record<string, unknown>) => ({
        ...capability,
        definition_supported: true,
        binding_implemented: true,
        executable: false,
        reason: 'program_not_running',
      }),
    ),
  }));
  let command: Record<string, unknown> | null = null;
  let resolveSubmission!: () => void;
  const submission = new Promise<void>((resolve) => {
    resolveSubmission = resolve;
  });
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
    http.get('http://api.test/api/v1/lab/labs/lighting-lab/world', () =>
      HttpResponse.json({ lab, entities, nodes: [], assets: [] }),
    ),
    http.post(
      'http://api.test/api/v1/lab/labs/lighting-lab/entities/:entity/program/start',
      ({ params, request }) => {
        expect(request.headers.get('x-csrf-token')).toBe(identity.csrf_token);
        const entity = entities.find((entry) => entry.id === params.entity)!;
        entity.program_run = { id: `run-${entity.id}`, status: 'running' };
        entity.capabilities = entity.capabilities.map(
          (capability: Record<string, unknown>) => ({
            ...capability,
            executable: true,
            reason: 'ready',
          }),
        );
        return HttpResponse.json(entity.program_run, { status: 201 });
      },
    ),
    http.post(
      'http://api.test/api/v1/lab/labs/lighting-lab/entities/:entity/actions',
      async ({ request, params }) => {
        expect(request.headers.get('x-csrf-token')).toBe(identity.csrf_token);
        expect(request.headers.get('idempotency-key')).toBeTruthy();
        const input = (await request.json()) as Record<string, unknown>;
        await submission;
        command = {
          id: 'command-1',
          entity_id: params.entity,
          run_id: `run-${params.entity}`,
          status: 'accepted',
          actor_id: identity.user.id,
          actor_source: 'member',
          parameters: input.parameters,
          capability: input.capability,
        };
        return HttpResponse.json(command, { status: 202 });
      },
    ),
    http.get(
      'http://api.test/api/v1/lab/labs/lighting-lab/entities/:entity/commands/command-1',
      () => HttpResponse.json(command),
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
    resolveSubmission,
    complete() {
      command!['status'] = 'succeeded';
      entities[0].observation = {
        values: { on: true, brightness: 100 },
        source: 'simulated:light:0',
        run_id: 'run-light-0',
        observed_at: '2026-10-03T06:00:00Z',
        received_at: '2026-10-03T06:00:01Z',
        updated_at: '2026-10-03T06:00:01Z',
        quality: 'good',
        freshness: 'current',
      };
    },
  };
}
test('a member sees submission and waiting separately from measured power', async () => {
  const { user, resolveSubmission, complete } = openLights();
  await user.click(await screen.findByRole('button', { name: '选择 Light A' }));
  const inspector = screen.getByRole('complementary', { name: '对象信息' });
  expect(within(inspector).getByText('未知 · 无观测')).toBeVisible();
  await user.click(within(inspector).getByRole('button', { name: '启动程序' }));
  await user.click(
    await within(inspector).findByRole('switch', { name: '电源' }),
  );
  expect(await within(inspector).findByText('正在提交命令')).toBeVisible();
  expect(within(inspector).getByText('未知 · 无观测')).toBeVisible();
  resolveSubmission();
  expect(await within(inspector).findByText('等待设备执行')).toBeVisible();
  expect(
    within(inspector).getByRole('switch', { name: '电源' }),
  ).not.toBeChecked();
  complete();
  await user.click(within(inspector).getByRole('button', { name: '刷新命令' }));
  expect(await within(inspector).findByText('执行完成')).toBeVisible();
  expect(
    await within(inspector).findByRole('switch', { name: '电源' }),
  ).toBeChecked();
  await user.click(screen.getByRole('button', { name: '选择 Light B' }));
  expect(within(inspector).getByText('未知 · 无观测')).toBeVisible();
});

test('a rejected command leaves the last observation intact and allows correction', async () => {
  const { user } = openLights();
  server.use(
    http.post(
      'http://api.test/api/v1/lab/labs/lighting-lab/entities/light-0/actions',
      () =>
        HttpResponse.json(
          {
            error: {
              code: 'lab.program_not_running',
              message:
                'Start the device program explicitly before sending a command',
              request_id: 'rejected',
            },
          },
          { status: 422 },
        ),
    ),
  );
  await user.click(await screen.findByRole('button', { name: '选择 Light A' }));
  const inspector = screen.getByRole('complementary', { name: '对象信息' });
  await user.click(within(inspector).getByRole('button', { name: '启动程序' }));
  await waitFor(() =>
    expect(
      within(inspector).getByRole('switch', { name: '电源' }),
    ).toBeEnabled(),
  );
  await user.click(within(inspector).getByRole('switch', { name: '电源' }));
  expect(await within(inspector).findByText('命令被拒绝')).toBeVisible();
  expect(within(inspector).getByText('未知 · 无观测')).toBeVisible();
  expect(within(inspector).getByRole('switch', { name: '电源' })).toBeEnabled();
});
test('a lost response keeps the original key across object selection until an explicit retry', async () => {
  const { user } = openLights();
  const requests: { key: string | null; input: unknown }[] = [];
  server.use(
    http.post(
      'http://api.test/api/v1/lab/labs/lighting-lab/entities/light-0/actions',
      async ({ request }) => {
        requests.push({
          key: request.headers.get('idempotency-key'),
          input: await request.json(),
        });
        return requests.length === 1
          ? HttpResponse.error()
          : HttpResponse.json(
              {
                id: 'lost-command',
                status: 'succeeded',
                parameters: { on: true },
              },
              { status: 202 },
            );
      },
    ),
    http.get(
      'http://api.test/api/v1/lab/labs/lighting-lab/entities/light-0/commands/lost-command',
      () =>
        HttpResponse.json({
          id: 'lost-command',
          status: 'succeeded',
          parameters: { on: true },
        }),
    ),
  );
  await user.click(await screen.findByRole('button', { name: '选择 Light A' }));
  const inspector = screen.getByRole('complementary', { name: '对象信息' });
  await user.click(within(inspector).getByRole('button', { name: '启动程序' }));
  await waitFor(() =>
    expect(
      within(inspector).getByRole('switch', { name: '电源' }),
    ).toBeEnabled(),
  );
  await user.click(within(inspector).getByRole('switch', { name: '电源' }));
  expect(await within(inspector).findByText('提交结果不确定')).toBeVisible();
  expect(
    within(inspector).getByRole('switch', { name: '电源' }),
  ).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '选择 Light B' }));
  await user.click(screen.getByRole('button', { name: '选择 Light A' }));
  expect(within(inspector).getByText('提交结果不确定')).toBeVisible();
  expect(requests).toHaveLength(1);
  await user.click(
    within(inspector).getByRole('button', { name: '重试同一命令' }),
  );
  expect(await within(inspector).findByText('执行完成')).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
});

test('an interrupted command remains uncertain until explicit program startup and is never automatically resubmitted', async () => {
  const { user, entities } = openLights();
  let submissions = 0;
  server.use(
    http.post(
      'http://api.test/api/v1/lab/labs/lighting-lab/entities/light-0/actions',
      () => {
        submissions++;
        entities[0].program_run = { id: 'old-run', status: 'interrupted' };
        entities[0].capabilities = entities[0].capabilities.map(
          (capability: Record<string, unknown>) => ({
            ...capability,
            executable: false,
            reason: 'program_not_running',
          }),
        );
        return HttpResponse.json(
          {
            id: 'interrupted-command',
            status: 'unknown',
            result: { reason: 'runtime_interrupted' },
          },
          { status: 202 },
        );
      },
    ),
    http.get(
      'http://api.test/api/v1/lab/labs/lighting-lab/entities/light-0/commands/interrupted-command',
      () =>
        HttpResponse.json({
          id: 'interrupted-command',
          status: 'unknown',
          result: { reason: 'runtime_interrupted' },
        }),
    ),
  );
  await user.click(await screen.findByRole('button', { name: '选择 Light A' }));
  const inspector = screen.getByRole('complementary', { name: '对象信息' });
  await user.click(within(inspector).getByRole('button', { name: '启动程序' }));
  await waitFor(() =>
    expect(
      within(inspector).getByRole('switch', { name: '电源' }),
    ).toBeEnabled(),
  );
  await user.click(within(inspector).getByRole('switch', { name: '电源' }));
  expect(await within(inspector).findByText('结果不确定')).toBeVisible();
  await waitFor(() =>
    expect(
      within(inspector).getByRole('switch', { name: '电源' }),
    ).toBeDisabled(),
  );
  await user.click(within(inspector).getByRole('button', { name: '启动程序' }));
  await waitFor(() =>
    expect(
      within(inspector).getByRole('switch', { name: '电源' }),
    ).toBeEnabled(),
  );
  expect(within(inspector).getByText('结果不确定')).toBeVisible();
  expect(submissions).toBe(1);
});
