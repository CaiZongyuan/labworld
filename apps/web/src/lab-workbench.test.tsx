import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { createApiClient, type CurrentSession } from '@labos-threejs/sdk';
import { render, screen, within, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { createAppRouter, navigateExample } from './router';

const identity = {
  user: {
    id: 'workbench-member',
    email: 'workbench@example.test',
    display_name: 'Workbench member',
    role: 'member',
  },
  csrf_token: 'workbench-csrf',
} satisfies CurrentSession;

function open(path = '/lab') {
  let currentIdentity: CurrentSession = identity;
  const lab = { id: 'lab-one', name: 'Spatial lab', layout_version: 0 };
  const secondLab = { id: 'lab-two', name: 'Second lab', layout_version: 0 };
  const definitions = JSON.parse(
    readFileSync('packages/server/src/lab/world/catalog.json', 'utf8'),
  );
  const definition = definitions.find(
    (entry: { id: string }) => entry.id === 'bench',
  );
  const entity = {
    id: 'bench-two',
    lab_id: secondLab.id,
    name: 'Second bench',
    kind: 'furniture',
    reality: 'physical',
    definition_id: 'bench',
    definition_version: '1.0',
    definition,
    configuration: {},
    representation_id: null,
    binding: null,
    observation: null,
    capabilities: [],
  };
  const subscriptions: {
    labId: string;
    signal: AbortSignal;
    emit: (event: unknown) => void;
  }[] = [];
  const secondWorld = {
    version: '1',
    lab: secondLab,
    entities: [entity],
    nodes: [
      {
        id: 'node-two',
        entity_id: entity.id,
        lab_id: secondLab.id,
        representation_id: null,
        placement: {
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      },
    ],
    assets: [],
    relationships: [],
  };
  const firstEntity = {
    ...entity,
    id: 'bench-one',
    lab_id: lab.id,
    name: 'First bench',
  };
  const firstWorld = {
    version: '1',
    lab,
    entities: [firstEntity],
    nodes: [
      {
        ...secondWorld.nodes[0],
        id: 'node-one',
        entity_id: firstEntity.id,
        lab_id: lab.id,
      },
    ],
    assets: [],
    relationships: [],
  };
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json(currentIdentity),
    ),
    http.get('http://api.test/api/v1/lab/labs', () =>
      HttpResponse.json({ data: [lab, secondLab] }),
    ),
    http.get('http://api.test/api/v1/lab/assets', () =>
      HttpResponse.json({ data: [] }),
    ),
    http.get('http://api.test/api/v1/lab/asset-definitions', () =>
      HttpResponse.json({ data: definitions }),
    ),
    http.get('http://api.test/api/v1/lab/labs/lab-one/world', () =>
      HttpResponse.json(firstWorld),
    ),
    http.get('http://api.test/api/v1/lab/labs/lab-two/world', () =>
      HttpResponse.json(secondWorld),
    ),
    http.get('http://api.test/api/v1/lab/labs/:labId/world', () =>
      HttpResponse.json(
        {
          error: {
            code: 'lab.world_not_found',
            message: 'World not found',
            request_id: 'missing-world',
          },
        },
        { status: 404 },
      ),
    ),
    http.get(
      'http://api.test/api/v1/lab/labs/:labId/world/subscribe',
      ({ request, params }) => {
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        const subscription = {
          labId: String(params.labId),
          signal: request.signal,
          emit: (event: unknown) =>
            stream.enqueue(
              new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
            ),
        };
        subscriptions.push(subscription);
        return new HttpResponse(
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
        );
      },
    ),
  );
  const router = createAppRouter(
    {
      apiClient: createApiClient('http://api.test'),
      docsUrl: 'https://docs.test',
    },
    createMemoryHistory({ initialEntries: [path] }),
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
  return {
    user: userEvent.setup(),
    router,
    view,
    subscriptions,
    firstWorld,
    secondWorld,
    setIdentity(next: CurrentSession) {
      currentIdentity = next;
    },
  };
}

function deferredRegistration(
  world: ReturnType<typeof open>['secondWorld'],
  id: string,
  name: string,
) {
  let release!: () => void, started!: () => void, responded!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const responseSent = new Promise<void>((resolve) => {
    responded = resolve;
  });
  const path = `/api/v1/lab/labs/${world.lab.id}/entities`;
  const observeResponse = ({ request }: { request: Request }) => {
    if (request.method === 'POST' && new URL(request.url).pathname === path)
      responded();
  };
  server.events.on('response:mocked', observeResponse);
  server.use(
    http.post(`http://api.test${path}`, async () => {
      started();
      await pending;
      const registered = { ...world.entities[0], id, name };
      world.entities.push(registered);
      world.version = '2';
      return HttpResponse.json(registered, { status: 201 });
    }),
  );
  return {
    release,
    requestStarted,
    responseSent,
    dispose() {
      release();
      server.events.removeListener('response:mocked', observeResponse);
    },
  };
}

function narrowViewport() {
  const previous = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === '(max-width: 560px)',
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = previous;
  };
}

test('opening Lab starts in space with auxiliary panels closed and the directory can return focus', async () => {
  const { user } = open();
  await screen.findByRole('heading', { name: 'Spatial lab' });
  expect(screen.queryByRole('complementary', { name: '对象目录' })).toBeNull();
  expect(screen.queryByRole('complementary', { name: '对象信息' })).toBeNull();
  const directory = screen.getByRole('button', { name: '打开对象目录' });
  await user.click(directory);
  expect(screen.getByRole('complementary', { name: '对象目录' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: '关闭对象目录' }));
  expect(directory).toHaveFocus();
  expect(screen.queryByRole('complementary', { name: '对象目录' })).toBeNull();
});

test('the narrow Inspector command replaces the directory and announces the visible panel', async () => {
  const restore = narrowViewport();
  try {
    const { user } = open('/lab?lab=lab-two&entity=bench-two');
    await screen.findByRole('complementary', { name: '对象信息' });
    await user.click(screen.getByRole('button', { name: '打开对象目录' }));
    const inspector = screen.getByRole('button', { name: '打开对象信息' });
    expect(inspector).toHaveAttribute('aria-expanded', 'false');
    await user.click(inspector);
    expect(
      screen.queryByRole('complementary', { name: '对象目录' }),
    ).toBeNull();
    expect(
      screen.getByRole('complementary', { name: '对象信息' }),
    ).toBeVisible();
    expect(inspector).toHaveAttribute('aria-expanded', 'true');
  } finally {
    restore();
  }
});

test('narrow history queries and pages its records, then restores the selected Entity and focus', async () => {
  const restore = narrowViewport();
  try {
    const { user } = open('/lab?lab=lab-two&entity=bench-two');
    server.use(
      http.get(
        'http://api.test/api/v1/lab/labs/lab-two/entities/bench-two/history',
        ({ request }) => {
          const more = new URL(request.url).searchParams.has('cursor');
          return HttpResponse.json({
            record_type: 'event',
            from: '2026-10-03T00:00:00Z',
            to: '2026-10-05T00:00:00Z',
            available_since: '2026-10-03T00:00:00Z',
            gap: false,
            retention: { observation_seconds: 86400, record_seconds: 2592000 },
            items: [
              {
                id: more ? 'older-event' : 'recent-event',
                recorded_at: '2026-10-04T00:00:00Z',
                data: {
                  values: {
                    message: more ? 'Older event page' : 'Recent event page',
                  },
                },
              },
            ],
            next_cursor: more ? null : 'next-page',
            max_range_seconds: 2678400,
            max_response_bytes: 262144,
          });
        },
      ),
    );
    await screen.findByRole('complementary', { name: '对象信息' });
    const historyTrigger = screen.getByRole('button', { name: '打开运行历史' });
    await user.click(historyTrigger);
    expect(
      screen.queryByRole('complementary', { name: '对象信息' }),
    ).toBeNull();
    const history = screen.getByRole('region', { name: '运行历史' });
    await within(history).findByText('Recent event page');
    await user.click(within(history).getByRole('button', { name: '查询历史' }));
    await user.click(within(history).getByRole('button', { name: '更早记录' }));
    expect(await within(history).findByText('Older event page')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '关闭运行历史' }));
    expect(
      screen.getByRole('complementary', { name: '对象信息' }),
    ).toHaveTextContent('bench-two');
    expect(historyTrigger).toHaveFocus();
  } finally {
    restore();
  }
});

test('an old identity cannot apply a pending registration to the new identity context', async () => {
  const { user, router, secondWorld, subscriptions, setIdentity } =
    open('/lab?lab=lab-two');
  const pending = deferredRegistration(
    secondWorld,
    'previous-user-bench',
    'Previous user bench',
  );
  try {
    await screen.findByRole('heading', { name: 'Second lab' });
    const register = screen.getByRole('button', { name: '登记对象' });
    await waitFor(() => expect(register).toBeEnabled());
    await user.click(register);
    const dialog = screen.getByRole('dialog');
    await user.selectOptions(
      within(dialog).getByLabelText('定义版本'),
      'bench@1.0',
    );
    await user.type(
      within(dialog).getByLabelText('名称'),
      'Previous user bench',
    );
    await user.click(within(dialog).getByRole('button', { name: '登记' }));
    await pending.requestStarted;
    setIdentity({
      ...identity,
      user: {
        ...identity.user,
        id: 'second-member',
        display_name: 'Second member',
      },
      csrf_token: 'second-csrf',
    });
    await act(async () => {
      subscriptions[0].emit({ type: 'access_ended', reason: 'revoked' });
    });
    await screen.findByText('Second member');
    await act(async () => {
      await navigateExample(router, {
        path: '/lab',
        search: { lab: 'lab-one', entity: 'bench-one' },
      });
    });
    await screen.findByRole('heading', { name: 'Spatial lab' });
    await user.click(screen.getByRole('tab', { name: '编辑布局' }));
    await user.clear(screen.getByLabelText('X (m)'));
    await user.type(screen.getByLabelText('X (m)'), '7');
    pending.release();
    await pending.responseSent;
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(router.state.location.search).toMatchObject({
      lab: 'lab-one',
      entity: 'bench-one',
    });
    expect(screen.getByLabelText('X (m)')).toHaveValue(7);
    expect(
      screen.getByRole('status', { name: '布局保存状态' }),
    ).toHaveTextContent('未保存');
  } finally {
    pending.dispose();
  }
});

test('a valid deep link restores its Lab and Entity rather than the first Lab', async () => {
  const { user } = open('/lab?lab=lab-two&entity=bench-two&view=space');
  await screen.findByRole('heading', { name: 'Second lab' });
  const inspector = screen.getByRole('complementary', { name: '对象信息' });
  await user.click(within(inspector).getByRole('tab', { name: '详情' }));
  expect(
    within(inspector).getByText('bench-two', { exact: true }),
  ).toBeVisible();
  expect(
    within(inspector).getAllByRole('heading', { name: 'Second bench' })[0],
  ).toBeVisible();
});

test('an unknown Entity is explicit and clearing its link leaves the requested Lab usable', async () => {
  const { user, router } = open('/lab?lab=lab-two&entity=missing-entity');
  await screen.findByRole('heading', { name: 'Second lab' });
  expect(await screen.findByText('找不到此对象。')).toBeVisible();
  expect(screen.queryByRole('complementary', { name: '对象信息' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '清除对象链接' }));
  expect(router.state.location.search).toMatchObject({ lab: 'lab-two' });
  expect(router.state.location.search).not.toHaveProperty('entity');
  await user.click(screen.getByRole('button', { name: '打开对象目录' }));
  await user.click(screen.getByRole('button', { name: '选择 Second bench' }));
  expect(
    await screen.findByRole('complementary', { name: '对象信息' }),
  ).toBeVisible();
});

test('an unknown Lab does not fall back to another world and can be explicitly replaced', async () => {
  const { user, router } = open('/lab?lab=missing-lab&entity=bench-two');
  expect(await screen.findByText('找不到此 Lab。')).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'Spatial lab' })).toBeNull();
  expect(screen.queryByRole('complementary', { name: '对象信息' })).toBeNull();
  expect(router.state.location.search).toMatchObject({
    lab: 'missing-lab',
    entity: 'bench-two',
  });
  await user.selectOptions(screen.getByLabelText('打开 Lab'), 'lab-one');
  expect(
    await screen.findByRole('heading', { name: 'Spatial lab' }),
  ).toBeVisible();
  expect(router.state.location.search).not.toHaveProperty('entity');
});

test('an undelivered work view stays explicit and can return to the same Lab space', async () => {
  const { user, router } = open('/lab?lab=lab-two&view=overview');
  expect(await screen.findByText('此工作视图尚不可用。')).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'Second lab' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '打开三维空间' }));
  expect(
    await screen.findByRole('heading', { name: 'Second lab' }),
  ).toBeVisible();
  expect(router.state.location.search).toMatchObject({ lab: 'lab-two' });
  expect(router.state.location.search).not.toHaveProperty('view');
});

test('mode and panel changes retain a private layout draft without creating another subscription', async () => {
  const { user, subscriptions, secondWorld } = open(
    '/lab?lab=lab-two&entity=bench-two',
  );
  await screen.findByRole('heading', { name: 'Second lab' });
  await user.click(screen.getByRole('tab', { name: '编辑布局' }));
  await user.clear(screen.getByLabelText('X (m)'));
  await user.type(screen.getByLabelText('X (m)'), '3');
  await user.click(screen.getByRole('tab', { name: '运行查看' }));
  await user.click(screen.getByRole('button', { name: '关闭对象信息' }));
  await user.click(screen.getByRole('button', { name: '打开对象信息' }));
  await user.click(screen.getByRole('tab', { name: '编辑布局' }));
  expect(screen.getByLabelText('X (m)')).toHaveValue(3);
  expect(
    screen.getByRole('status', { name: '布局保存状态' }),
  ).toHaveTextContent('未保存');
  expect(subscriptions).toHaveLength(1);
  expect(secondWorld.nodes[0].placement.position).toEqual([0, 0, 0]);
  await user.selectOptions(screen.getByLabelText('打开 Lab'), 'lab-one');
  await screen.findByRole('heading', { name: 'Spatial lab' });
  expect(screen.queryByRole('complementary', { name: '对象信息' })).toBeNull();
  expect(
    screen.getByRole('status', { name: '布局保存状态' }),
  ).toHaveTextContent('布局已同步');
  await waitFor(() =>
    expect(
      subscriptions.filter((entry) => entry.labId === 'lab-one'),
    ).toHaveLength(1),
  );
  await user.selectOptions(screen.getByLabelText('打开 Lab'), 'lab-two');
  await screen.findByRole('heading', { name: 'Second lab' });
  await user.click(screen.getByRole('button', { name: '打开对象目录' }));
  await user.click(screen.getByRole('button', { name: '选择 Second bench' }));
  await user.click(screen.getByRole('tab', { name: '编辑布局' }));
  expect(screen.getByLabelText('X (m)')).toHaveValue(3);
});

test('a save that completes after changing Lab clears only its original draft', async () => {
  const { user, router, secondWorld } = open(
    '/lab?lab=lab-two&entity=bench-two',
  );
  let release!: () => void;
  let started!: () => void;
  let responded!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const responseSent = new Promise<void>((resolve) => {
    responded = resolve;
  });
  const observeResponse = ({ request }: { request: Request }) => {
    if (request.method === 'PUT' && request.url.endsWith('/lab-two/layout'))
      responded();
  };
  server.events.on('response:mocked', observeResponse);
  server.use(
    http.put(
      'http://api.test/api/v1/lab/labs/lab-two/layout',
      async ({ request }) => {
        const input = (await request.json()) as {
          nodes: typeof secondWorld.nodes;
        };
        started();
        await pending;
        secondWorld.nodes = input.nodes;
        secondWorld.lab.layout_version = 1;
        secondWorld.version = '2';
        return HttpResponse.json({
          layout_version: 1,
          nodes: input.nodes,
          relationships: [],
        });
      },
    ),
  );
  try {
    await screen.findByRole('heading', { name: 'Second lab' });
    await user.click(screen.getByRole('tab', { name: '编辑布局' }));
    await user.clear(screen.getByLabelText('X (m)'));
    await user.type(screen.getByLabelText('X (m)'), '3');
    await user.click(screen.getByRole('button', { name: '保存布局' }));
    await requestStarted;
    await act(async () => {
      await navigateExample(router, {
        path: '/lab',
        search: { lab: 'lab-one', entity: 'bench-one' },
      });
    });
    await screen.findByRole('heading', { name: 'Spatial lab' });
    await user.click(screen.getByRole('tab', { name: '编辑布局' }));
    await user.clear(screen.getByLabelText('X (m)'));
    await user.type(screen.getByLabelText('X (m)'), '7');
    release();
    await responseSent;
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(router.state.location.search).toMatchObject({
      lab: 'lab-one',
      entity: 'bench-one',
    });
    expect(screen.getByLabelText('X (m)')).toHaveValue(7);
    expect(
      screen.getByRole('status', { name: '布局保存状态' }),
    ).toHaveTextContent('未保存');
    await user.selectOptions(screen.getByLabelText('打开 Lab'), 'lab-two');
    await screen.findByRole('heading', { name: 'Second lab' });
    expect(
      screen.getByRole('status', { name: '布局保存状态' }),
    ).not.toHaveTextContent('未保存');
    expect(secondWorld.nodes[0].placement.position[0]).toBe(3);
  } finally {
    release();
    server.events.removeListener('response:mocked', observeResponse);
  }
});

test('a late registration updates its original Lab without selecting it in a different Lab', async () => {
  const { user, router, secondWorld } = open('/lab?lab=lab-two');
  const pending = deferredRegistration(secondWorld, 'late-bench', 'Late bench');
  try {
    await screen.findByRole('heading', { name: 'Second lab' });
    const register = screen.getByRole('button', { name: '登记对象' });
    await waitFor(() => expect(register).toBeEnabled());
    await user.click(register);
    const dialog = screen.getByRole('dialog');
    await user.selectOptions(
      within(dialog).getByLabelText('定义版本'),
      'bench@1.0',
    );
    await user.type(within(dialog).getByLabelText('名称'), 'Late bench');
    await user.click(within(dialog).getByRole('button', { name: '登记' }));
    await pending.requestStarted;
    await act(async () => {
      await navigateExample(router, {
        path: '/lab',
        search: { lab: 'lab-one' },
      });
    });
    await screen.findByRole('heading', { name: 'Spatial lab' });
    pending.release();
    await pending.responseSent;
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(router.state.location.search).toMatchObject({ lab: 'lab-one' });
    expect(router.state.location.search).not.toHaveProperty('entity');
    expect(
      screen.queryByRole('complementary', { name: '对象信息' }),
    ).toBeNull();
    expect(
      secondWorld.entities.find((entry) => entry.id === 'late-bench'),
    ).toBeDefined();
  } finally {
    pending.dispose();
  }
});

test('returning to a Lab retains its conflict recovery and can save the rebased draft', async () => {
  const { user, secondWorld } = open('/lab?lab=lab-two&entity=bench-two');
  server.use(
    http.put(
      'http://api.test/api/v1/lab/labs/lab-two/layout',
      async ({ request }) => {
        const input = (await request.json()) as {
          expected_version: number;
          nodes: typeof secondWorld.nodes;
        };
        if (input.expected_version === 0) {
          secondWorld.lab.layout_version = 1;
          secondWorld.version = '2';
          return HttpResponse.json(
            {
              error: {
                code: 'lab.layout_conflict',
                message: 'Layout changed',
                request_id: 'conflict',
              },
            },
            { status: 409 },
          );
        }
        secondWorld.nodes = input.nodes;
        secondWorld.lab.layout_version = 2;
        secondWorld.version = '3';
        return HttpResponse.json({
          layout_version: 2,
          nodes: input.nodes,
          relationships: [],
        });
      },
    ),
  );
  await screen.findByRole('heading', { name: 'Second lab' });
  await user.click(screen.getByRole('tab', { name: '编辑布局' }));
  await user.clear(screen.getByLabelText('X (m)'));
  await user.type(screen.getByLabelText('X (m)'), '3');
  await user.click(screen.getByRole('button', { name: '保存布局' }));
  await screen.findByRole('button', { name: '重新载入并保留草稿' });
  await user.selectOptions(screen.getByLabelText('打开 Lab'), 'lab-one');
  await screen.findByRole('heading', { name: 'Spatial lab' });
  await user.selectOptions(screen.getByLabelText('打开 Lab'), 'lab-two');
  await screen.findByRole('heading', { name: 'Second lab' });
  await user.click(screen.getByRole('button', { name: '重新载入并保留草稿' }));
  await user.click(screen.getByRole('tab', { name: '编辑布局' }));
  await user.click(screen.getByRole('button', { name: '打开对象目录' }));
  await user.click(screen.getByRole('button', { name: '选择 Second bench' }));
  expect(screen.getByLabelText('X (m)')).toHaveValue(3);
  await user.click(screen.getByRole('button', { name: '重试保存' }));
  await waitFor(() =>
    expect(
      screen.getByRole('status', { name: '布局保存状态' }),
    ).toHaveTextContent('已保存'),
  );
  expect(secondWorld.nodes[0].placement.position[0]).toBe(3);
});
