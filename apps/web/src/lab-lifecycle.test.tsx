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

const identity = {
  user: {
    id: 'member',
    email: 'lifecycle@example.test',
    display_name: 'Member',
    role: 'member',
  },
  csrf_token: 'csrf',
} satisfies CurrentSession;
function open() {
  const definitions = JSON.parse(
    readFileSync('packages/server/src/lab/world/catalog.json', 'utf8'),
  );
  const lab = { id: 'lab-one', name: 'Lifecycle lab', layout_version: 1 };
  const entity = {
    id: 'device',
    lab_id: lab.id,
    name: 'Device A',
    kind: 'iot',
    reality: 'simulated',
    definition_id: 'light',
    definition_version: '1.0',
    definition: definitions.find((d: { id: string }) => d.id === 'light'),
    configuration: {},
    representation_id: null as string | null,
    archived_at: null as string | null,
    binding: { id: 'binding', program_id: 'light.v1' },
    program_run: { id: 'run-one', status: 'running' },
    capabilities: [],
    observation: null,
  };
  const asset = {
    id: 'appearance',
    name: 'Imported GLB',
    version: '1.0',
    representation: { id: 'representation', file_name: 'model.glb', size: 100 },
  };
  let version = 0;
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json(identity),
    ),
    http.get('http://api.test/api/v1/lab/labs', () =>
      HttpResponse.json({ data: [lab] }),
    ),
    http.get('http://api.test/api/v1/lab/asset-definitions', () =>
      HttpResponse.json({ data: definitions }),
    ),
    http.get('http://api.test/api/v1/lab/assets', () =>
      HttpResponse.json({ data: [asset], has_more: false, next_cursor: null }),
    ),
    http.get('http://api.test/api/v1/lab/labs/lab-one/world', () =>
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
      'http://api.test/api/v1/lab/labs/lab-one/entities/device/history',
      () =>
        HttpResponse.json({
          items: [],
          gap: false,
          available_since: '2026-10-04T00:00:00Z',
          next_cursor: null,
          retention: { observation_seconds: 86400, record_seconds: 2592000 },
        }),
    ),
    http.get(
      'http://api.test/api/v1/lab/labs/lab-one/world/subscribe',
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
      'http://api.test/api/v1/lab/labs/lab-one/entities/device/program/stop',
      () => {
        entity.program_run.status = 'stopped';
        return HttpResponse.json(entity.program_run);
      },
    ),
    http.post(
      'http://api.test/api/v1/lab/labs/lab-one/entities/device/archive',
      ({ request }) => {
        expect(request.headers.get('x-csrf-token')).toBe('csrf');
        if (entity.program_run.status === 'running')
          return HttpResponse.json(
            {
              error: {
                code: 'lab.entity_in_use',
                message: 'Busy',
                request_id: 'busy',
              },
            },
            { status: 409 },
          );
        entity.archived_at = '2026-10-04T00:00:00Z';
        return HttpResponse.json(entity);
      },
    ),
    http.put(
      'http://api.test/api/v1/lab/labs/lab-one/entities/device/appearance',
      async ({ request }) => {
        expect(request.headers.get('x-csrf-token')).toBe('csrf');
        const input = (await request.json()) as { representation_id: string };
        entity.representation_id = input.representation_id;
        return HttpResponse.json(entity);
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
  return { user: userEvent.setup(), entity };
}
test('running appearance changes keep identity and archive rejection recovers after StopProgram', async () => {
  const { user, entity } = open();
  await user.click(await screen.findByRole('button', { name: '打开对象目录' }));
  await user.click(
    await screen.findByRole('button', { name: '选择 Device A' }),
  );
  await user.click(screen.getByRole('button', { name: '更换外观' }));
  let dialog = screen.getByRole('dialog');
  await user.selectOptions(
    within(dialog).getByLabelText('外观表示'),
    'representation',
  );
  await user.click(within(dialog).getByRole('button', { name: '保存' }));
  expect(entity.representation_id).toBe('representation');
  expect(entity.program_run.id).toBe('run-one');
  await user.click(await screen.findByRole('button', { name: '归档对象' }));
  dialog = screen.getByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: '归档' }));
  expect(
    await within(dialog).findByText('结束任务并停止程序后重试。'),
  ).toBeVisible();
  expect(entity.archived_at).toBeNull();
  await user.click(within(dialog).getByRole('button', { name: '取消' }));
  await user.click(screen.getByRole('button', { name: '停止程序' }));
  await user.click(screen.getByRole('button', { name: '归档对象' }));
  await user.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: '归档' }),
  );
  const inspector = screen.getByRole('complementary', { name: '对象信息' });
  expect(
    await within(inspector).findByText('已归档', { exact: true }),
  ).toBeVisible();
  expect(within(inspector).getByText('device', { exact: true })).toBeVisible();
  expect(
    within(inspector).getByRole('button', { name: '启动程序' }),
  ).toBeDisabled();
  expect(screen.getByRole('button', { name: '已归档对象' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.getByRole('button', { name: '选择 Device A' })).toBeVisible();
});
