import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { createApiClient, type CurrentSession } from '@labos-threejs/sdk';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { createAppRouter } from './router';

test('a member keeps the last observation through duplicate, old, interrupted and reconnected updates', async () => {
  const definitions = JSON.parse(
    readFileSync('crates/app/src/modules/lab/definitions.json', 'utf8'),
  );
  const definition = definitions.find(
    (entry: { id: string }) => entry.id === 'light',
  );
  const identity = {
    user: {
      id: 'sync-user',
      email: 'sync@example.test',
      display_name: 'Sync',
      role: 'member',
    },
    csrf_token: 'csrf',
  } satisfies CurrentSession;
  const lab = { id: 'shared', name: 'Shared lab', layout_version: 0 };
  const observation = {
    values: { on: false, brightness: 35 },
    source: 'simulated:light',
    run_id: 'run',
    sequence: 1,
    quality: 'good',
    freshness: 'current',
    observed_at: '2026-10-03T06:00:00Z',
    received_at: '2026-10-03T06:00:00Z',
    updated_at: '2026-10-03T06:00:00Z',
    properties: {
      on: {
        value: false,
        binding_id: 'binding',
        run_id: 'run',
        source: 'simulated:light',
        sequence: 1,
        quality: 'good',
        freshness: 'current',
        unit: null,
        observed_at: '2026-10-03T06:00:00Z',
        received_at: '2026-10-03T06:00:00Z',
        updated_at: '2026-10-03T06:00:00Z',
        expires_at: '2026-10-03T06:00:05Z',
      },
      brightness: {
        value: 35,
        binding_id: 'binding',
        run_id: 'run',
        source: 'simulated:light',
        sequence: 1,
        quality: 'good',
        freshness: 'current',
        unit: '%',
        observed_at: '2026-10-03T06:00:00Z',
        received_at: '2026-10-03T06:00:00Z',
        updated_at: '2026-10-03T06:00:00Z',
        expires_at: '2026-10-03T06:00:05Z',
      },
    },
  };
  const entity = {
    id: 'light',
    lab_id: lab.id,
    name: 'Light A',
    kind: 'iot',
    reality: 'simulated',
    definition_id: 'light',
    definition_version: '1.0',
    definition,
    configuration: {},
    representation_id: null,
    binding: {
      id: 'binding',
      program_id: 'light.v1',
      source: 'simulated:light',
    },
    program_run: { id: 'run', status: 'running' },
    observation,
    capabilities: definition.capabilities.map(
      (entry: Record<string, unknown>) => ({
        ...entry,
        definition_supported: true,
        binding_implemented: true,
        executable: true,
        reason: 'ready',
      }),
    ),
  };
  let world = {
    version: '10',
    lab,
    entities: [entity],
    nodes: [],
    assets: [],
    relationships: [],
  };
  let controller!: ReadableStreamDefaultController;
  let connectionCount = 0;
  let releaseHttp!: () => void;
  let httpReplied!: () => void;
  const httpGate = new Promise<void>((resolve) => {
    releaseHttp = resolve;
  });
  const httpReply = new Promise<void>((resolve) => {
    httpReplied = resolve;
  });
  const signals: AbortSignal[] = [];
  const send = (event: unknown) =>
    controller.enqueue(
      new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
    );
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
    http.get('http://api.test/api/v1/lab/labs/shared/world', async () => {
      const initial = structuredClone(world);
      await httpGate;
      httpReplied();
      return HttpResponse.json(initial, {
        headers: { 'x-lab-runtime': 'unavailable' },
      });
    }),
    http.get(
      'http://api.test/api/v1/lab/labs/shared/world/subscribe',
      ({ request }) => {
        connectionCount++;
        signals.push(request.signal);
        const stream = new ReadableStream({
          start(target) {
            controller = target;
            send({ type: 'snapshot', world });
            send({ type: 'runtime_status', available: true });
          },
        });
        return new HttpResponse(stream, {
          headers: { 'content-type': 'text/event-stream' },
        });
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
  const view = render(
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
  await waitFor(() => expect(connectionCount).toBe(1), { timeout: 5000 });
  await user.click(await screen.findByRole('button', { name: '打开对象目录' }));
  await user.click(await screen.findByRole('button', { name: '选择 Light A' }));
  expect(await screen.findByText('实时同步')).toBeVisible();
  const inspector = screen.getByRole('complementary', { name: '对象信息' });
  const power = within(inspector).getByRole('switch', { name: '电源' });
  expect(power).not.toBeChecked();
  const update = {
    type: 'update',
    version: '11',
    base_version: '10',
    lab: null,
    changes: [
      {
        collection: 'entities',
        id: 'light',
        patch: {
          observation: {
            ...observation,
            values: { on: true, brightness: 35 },
            properties: {
              ...observation.properties,
              on: { ...observation.properties.on, value: true },
            },
          },
        },
      },
    ],
  };
  send(update);
  await waitFor(() => expect(power).toBeChecked());
  await act(async () => {
    releaseHttp();
    await httpReply;
  });
  expect(power).toBeChecked();
  expect(power).toBeEnabled();
  send({
    ...update,
    changes: [{ collection: 'entities', id: 'light', patch: { observation } }],
  });
  send({ ...update, version: '9' });
  send({ type: 'heartbeat', version: '11' });
  await waitFor(() =>
    expect(screen.getByLabelText('世界版本')).toHaveTextContent('11'),
  );
  expect(power).toBeChecked();
  controller.close();
  expect(await screen.findByText('连接中断')).toBeVisible();
  expect(power).toBeChecked();
  world = { ...world, version: '20' };
  await user.click(screen.getByRole('button', { name: '重新连接' }));
  await waitFor(() => expect(power).not.toBeChecked());
  expect(screen.getByText('实时同步')).toBeVisible();
  expect(connectionCount).toBe(2);
  view.unmount();
  await waitFor(() => expect(signals.at(-1)?.aborted).toBe(true));
});
