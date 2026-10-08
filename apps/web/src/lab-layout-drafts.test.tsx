import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import {
  createApiClient,
  type CurrentSession,
  type SaveLabLayout,
  type SceneNode,
} from '@labos-threejs/sdk';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { expect, test, vi } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { createAppRouter } from './router';

const identity: CurrentSession = {
  user: {
    id: 'draft-member',
    email: 'draft@example.test',
    display_name: 'Draft member',
    role: 'member',
  },
  csrf_token: 'draft-csrf',
};

function fixture() {
  const definitions = JSON.parse(
    readFileSync('packages/server/src/lab/world/catalog.json', 'utf8'),
  );
  const definition = definitions.find(
    (item: { id: string }) => item.id === 'bench',
  );
  function world(labId: string, entityId: string) {
    return {
      version: '1',
      lab: { id: labId, name: labId, layout_version: 0 },
      entities: [
        {
          id: entityId,
          lab_id: labId,
          name: entityId,
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
        },
      ],
      nodes: [
        {
          id: `node-${entityId}`,
          entity_id: entityId,
          lab_id: labId,
          representation_id: null,
          placement: {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
        },
      ] as SceneNode[],
      assets: [],
      relationships: [],
    };
  }
  const worlds = {
    'lab-one': world('lab-one', 'entity-one'),
    'lab-two': world('lab-two', 'entity-two'),
  };
  let currentIdentity = identity;
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json(currentIdentity),
    ),
    http.get('http://api.test/api/v1/lab/labs', () =>
      HttpResponse.json({
        data: Object.values(worlds).map((entry) => entry.lab),
      }),
    ),
    http.get('http://api.test/api/v1/lab/asset-definitions', () =>
      HttpResponse.json({ data: definitions }),
    ),
    http.get('http://api.test/api/v1/lab/assets', () =>
      HttpResponse.json({ data: [] }),
    ),
    http.get('http://api.test/api/v1/lab/labs/:labId/world', ({ params }) =>
      HttpResponse.json(worlds[params.labId as keyof typeof worlds]),
    ),
    http.get(
      'http://api.test/api/v1/lab/labs/:labId/world/subscribe',
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
    http.put(
      'http://api.test/api/v1/lab/labs/:labId/layout',
      async ({ request, params }) => {
        const input = (await request.json()) as SaveLabLayout;
        const target = worlds[params.labId as keyof typeof worlds];
        if (input.expected_version !== target.lab.layout_version)
          return HttpResponse.json(
            {
              error: {
                code: 'lab.layout_conflict',
                message: 'Layout changed',
                request_id: 'draft-conflict',
              },
            },
            { status: 409 },
          );
        target.nodes = input.nodes.map((node) => ({
          ...node,
          lab_id: target.lab.id,
          representation_id: node.representation_id ?? null,
        }));
        target.lab.layout_version++;
        target.version = String(Number(target.version) + 1);
        return HttpResponse.json({
          layout_version: target.lab.layout_version,
          nodes: target.nodes,
          relationships: [],
        });
      },
    ),
  );
  return {
    mount(path = '/lab?lab=lab-one&entity=entity-one') {
      const router = createAppRouter(
        {
          apiClient: createApiClient('http://api.test'),
          docsUrl: 'https://docs.test',
        },
        createMemoryHistory({ initialEntries: [path] }),
      );
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const view = render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
      return { user: userEvent.setup(), view, router };
    },
    setIdentity(next: CurrentSession) {
      currentIdentity = next;
    },
  };
}

async function edit(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { name: 'lab-one' });
  await user.click(screen.getByRole('tab', { name: '编辑布局' }));
  return screen.getByLabelText<HTMLInputElement>('X (m)');
}

async function savedWorld(lab = 'lab-one') {
  return (await fetch(`http://api.test/api/v1/lab/labs/${lab}/world`)).json();
}

test('a fresh application restores a private draft without saving the shared World', async () => {
  const app = fixture();
  const first = app.mount();
  const x = await edit(first.user);
  await first.user.clear(x);
  await first.user.type(x, '-.25');
  expect((await savedWorld()).nodes[0].placement.position).toEqual([0, 0, 0]);
  first.view.unmount();
  const returned = app.mount();
  expect((await edit(returned.user)).value).toBe('-.25');
  expect(
    screen.getByRole('status', { name: '布局保存状态' }),
  ).toHaveTextContent('未保存');
  expect((await savedWorld()).nodes[0].placement.position).toEqual([0, 0, 0]);
  await returned.user.click(screen.getByRole('button', { name: '保存布局' }));
  await waitFor(() =>
    expect(
      screen.getByRole('status', { name: '布局保存状态' }),
    ).toHaveTextContent('已保存'),
  );
  returned.view.unmount();
  const saved = app.mount();
  expect((await edit(saved.user)).value).toBe('-0.25');
  expect(
    screen.getByRole('status', { name: '布局保存状态' }),
  ).toHaveTextContent('布局已同步');
  expect((await savedWorld()).nodes[0].placement.position).toEqual([
    -0.25, 0, 0,
  ]);
});

test('restoration retains its old version through 409 until explicit rebase and save', async () => {
  const app = fixture();
  const first = app.mount();
  const x = await edit(first.user);
  await first.user.clear(x);
  await first.user.type(x, '2');
  const before = await savedWorld();
  const remote = {
    ...before.nodes[0],
    id: 'remote-node',
    placement: { position: [4, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  };
  const changed = await fetch(
    'http://api.test/api/v1/lab/labs/lab-one/layout',
    {
      method: 'PUT',
      body: JSON.stringify({
        expected_version: 0,
        nodes: [before.nodes[0], remote],
      }),
    },
  );
  expect(changed.status).toBe(200);
  first.view.unmount();
  const returned = app.mount();
  expect((await edit(returned.user)).value).toBe('2');
  await screen.findByText('布局已改变，草稿已保留');
  await returned.user.click(screen.getByRole('button', { name: '重试保存' }));
  expect(screen.getByLabelText<HTMLInputElement>('X (m)').value).toBe('2');
  expect((await savedWorld()).nodes[0].placement.position).toEqual([0, 0, 0]);
  await returned.user.click(
    screen.getByRole('button', { name: '重新载入并保留草稿' }),
  );
  await returned.user.click(screen.getByRole('button', { name: '重试保存' }));
  await waitFor(() =>
    expect(
      screen.getByRole('status', { name: '布局保存状态' }),
    ).toHaveTextContent('已保存'),
  );
  const saved = await savedWorld();
  expect(
    saved.nodes.map(
      (node: { placement: { position: number[] } }) => node.placement.position,
    ),
  ).toEqual([
    [2, 0, 0],
    [4, 0, 0],
  ]);
  expect(saved.relationships).toEqual(before.relationships);
  const edited = screen.getByLabelText('X (m)');
  await returned.user.clear(edited);
  await returned.user.type(edited, '5');
  await returned.user.click(
    screen.getByRole('button', { name: '放弃草稿并重新载入' }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole('status', { name: '布局保存状态' }),
    ).toHaveTextContent('布局已同步'),
  );
  expect((await savedWorld()).lab.layout_version).toBe(
    saved.lab.layout_version,
  );
  returned.view.unmount();
  const discarded = app.mount();
  expect((await edit(discarded.user)).value).toBe('2');
  expect(
    screen.queryByText('已恢复本浏览器的私人布局草稿；恢复不会提交共享布局。'),
  ).toBeNull();
});

test('another user and Lab do not inherit the first user’s unsaved browser draft', async () => {
  const app = fixture();
  const first = app.mount();
  const x = await edit(first.user);
  await first.user.clear(x);
  await first.user.type(x, '3');
  first.view.unmount();
  app.setIdentity({
    ...identity,
    user: { ...identity.user, id: 'second-member' },
    csrf_token: 'second-csrf',
  });
  const other = app.mount();
  expect((await edit(other.user)).value).toBe('0');
  expect(
    screen.getByRole('status', { name: '布局保存状态' }),
  ).toHaveTextContent('布局已同步');
  other.view.unmount();
  app.setIdentity(identity);
  const anotherLab = app.mount('/lab?lab=lab-two&entity=entity-two');
  await screen.findByRole('heading', { name: 'lab-two' });
  await anotherLab.user.click(screen.getByRole('tab', { name: '编辑布局' }));
  expect(screen.getByLabelText<HTMLInputElement>('X (m)').value).toBe('0');
  anotherLab.view.unmount();
  const original = app.mount();
  expect((await edit(original.user)).value).toBe('3');
  expect((await savedWorld()).nodes[0].placement.position).toEqual([0, 0, 0]);
});

test('changing language preserves the coordinate spelling and insertion position', async () => {
  const app = fixture();
  const first = app.mount();
  const x = await edit(first.user);
  await first.user.clear(x);
  await first.user.type(x, '-1.20');
  await first.user.keyboard('{ArrowLeft}');
  const cursor = x.selectionStart;
  await first.user.click(screen.getByRole('button', { name: 'English' }));
  expect(x.value).toBe('-1.20');
  expect(x.selectionStart).toBe(cursor);
  expect((await savedWorld()).nodes[0].placement.position).toEqual([0, 0, 0]);
});

test('unfinished text survives refresh and prevents saving a different valid Placement', async () => {
  const app = fixture();
  const first = app.mount();
  const x = await edit(first.user);
  await first.user.clear(x);
  await first.user.type(x, '-');
  expect(screen.getByRole('button', { name: '保存布局' })).toBeDisabled();
  first.view.unmount();
  const returned = app.mount();
  const restored = await edit(returned.user);
  expect(restored.value).toBe('-');
  expect(restored).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByRole('button', { name: '保存布局' })).toBeDisabled();
  expect((await savedWorld()).nodes[0].placement.position).toEqual([0, 0, 0]);
  await returned.user.type(restored, '.25');
  expect(screen.getByRole('button', { name: '保存布局' })).toBeEnabled();
});

test('storage failure preserves input and can recover after browser storage becomes writable', async () => {
  const app = fixture();
  const first = app.mount();
  const x = await edit(first.user);
  const failure = vi
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation(() => {
      throw new DOMException('Quota', 'QuotaExceededError');
    });
  await first.user.clear(x);
  await first.user.type(x, '2.5');
  expect(x.value).toBe('2.5');
  expect(
    await screen.findByText(
      '浏览器存储不可用。离开前请核对保存结果；未保存输入仍在本页。',
    ),
  ).toBeVisible();
  expect((await savedWorld()).nodes[0].placement.position).toEqual([0, 0, 0]);
  failure.mockRestore();
  await first.user.type(x, '0');
  await waitFor(() =>
    expect(
      screen.queryByText(
        '浏览器存储不可用。离开前请核对保存结果；未保存输入仍在本页。',
      ),
    ).toBeNull(),
  );
  first.view.unmount();
  const returned = app.mount();
  expect((await edit(returned.user)).value).toBe('2.50');
});

test('a lost save response retains the draft and restores committed World without automatic resubmission', async () => {
  const app = fixture();
  const first = app.mount();
  const x = await edit(first.user);
  await first.user.clear(x);
  await first.user.type(x, '2');
  server.use(
    http.put(
      'http://api.test/api/v1/lab/labs/lab-one/layout',
      async ({ request }) => {
        const body = await request.text();
        const committed = await fetch(
          'http://api.test/api/v1/lab/labs/lab-one/layout',
          { method: 'PUT', body },
        );
        expect(committed.status).toBe(200);
        return HttpResponse.error();
      },
      { once: true },
    ),
  );
  await first.user.click(screen.getByRole('button', { name: '保存布局' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '保存布局' })).toBeEnabled(),
  );
  expect(x.value).toBe('2');
  expect(
    screen.getByRole('status', { name: '布局保存状态' }),
  ).toHaveTextContent('未保存');
  expect((await savedWorld()).lab.layout_version).toBe(1);
  first.view.unmount();
  const returned = app.mount();
  expect((await edit(returned.user)).value).toBe('2');
  await screen.findByText('布局已改变，草稿已保留');
  expect((await savedWorld()).lab.layout_version).toBe(1);
  await returned.user.click(
    screen.getByRole('button', { name: '放弃草稿并重新载入' }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole('status', { name: '布局保存状态' }),
    ).toHaveTextContent('布局已同步'),
  );
  expect((await savedWorld()).lab.layout_version).toBe(1);
});

test('reload keeps matching spelling and unfinished text while showing the merged remote coordinate', async () => {
  const app = fixture();
  const first = app.mount();
  const x = await edit(first.user);
  await first.user.clear(x);
  await first.user.type(x, '0.00');
  await first.user.clear(screen.getByLabelText('Y (m)'));
  await first.user.type(screen.getByLabelText('Y (m)'), '0.00');
  await first.user.clear(screen.getByLabelText('Z (m)'));
  await first.user.type(screen.getByLabelText('Z (m)'), '-');
  const before = await savedWorld();
  const response = await fetch(
    'http://api.test/api/v1/lab/labs/lab-one/layout',
    {
      method: 'PUT',
      body: JSON.stringify({
        expected_version: 0,
        nodes: [
          {
            ...before.nodes[0],
            placement: { ...before.nodes[0].placement, position: [4, 0, 0] },
          },
        ],
      }),
    },
  );
  expect(response.status).toBe(200);
  first.view.unmount();
  const returned = app.mount();
  await edit(returned.user);
  await returned.user.click(
    await screen.findByRole('button', { name: '重新载入并保留草稿' }),
  );
  expect(screen.getByLabelText<HTMLInputElement>('X (m)').value).toBe('4');
  expect(screen.getByLabelText<HTMLInputElement>('Y (m)').value).toBe('0.00');
  expect(screen.getByLabelText<HTMLInputElement>('Z (m)').value).toBe('-');
  returned.view.unmount();
  const restored = app.mount();
  expect((await edit(restored.user)).value).toBe('4');
  expect(screen.getByLabelText<HTMLInputElement>('Y (m)').value).toBe('0.00');
  const z = screen.getByLabelText<HTMLInputElement>('Z (m)');
  expect(z.value).toBe('-');
  expect((await savedWorld()).nodes[0].placement.position).toEqual([4, 0, 0]);
  await restored.user.clear(z);
  await restored.user.type(z, '0');
  await restored.user.click(screen.getByRole('button', { name: '保存布局' }));
  await waitFor(() =>
    expect(
      screen.getByRole('status', { name: '布局保存状态' }),
    ).toHaveTextContent('已保存'),
  );
  expect((await savedWorld()).nodes[0].placement.position).toEqual([4, 0, 0]);
});

test('reload removes orphan text without losing another node’s input on refresh', async () => {
  const app = fixture();
  const original = await savedWorld();
  const second = {
    ...original.nodes[0],
    id: 'second-node',
    placement: { ...original.nodes[0].placement, position: [4, 0, 0] },
  };
  const seeded = await fetch('http://api.test/api/v1/lab/labs/lab-one/layout', {
    method: 'PUT',
    body: JSON.stringify({
      expected_version: 0,
      nodes: [original.nodes[0], second],
    }),
  });
  expect(seeded.status).toBe(200);
  const first = app.mount();
  await edit(first.user);
  await first.user.clear(screen.getByLabelText('Y (m)'));
  await first.user.type(screen.getByLabelText('Y (m)'), '-');
  const selectors = screen.getAllByRole('button', { name: '编辑节点' });
  expect(selectors).toHaveLength(2);
  await first.user.click(selectors[1]);
  const x = screen.getByLabelText('X (m)');
  await first.user.clear(x);
  await first.user.type(x, '9.00');
  const removed = await fetch(
    'http://api.test/api/v1/lab/labs/lab-one/layout',
    {
      method: 'PUT',
      body: JSON.stringify({ expected_version: 1, nodes: [second] }),
    },
  );
  expect(removed.status).toBe(200);
  first.view.unmount();
  const returned = app.mount();
  await edit(returned.user);
  await returned.user.click(
    await screen.findByRole('button', { name: '重新载入并保留草稿' }),
  );
  expect(screen.getAllByRole('button', { name: '编辑节点' })).toHaveLength(1);
  expect(screen.getByLabelText<HTMLInputElement>('X (m)').value).toBe('9.00');
  returned.view.unmount();
  const restored = app.mount();
  expect((await edit(restored.user)).value).toBe('9.00');
  expect(
    screen.queryByText(
      '本浏览器的布局草稿格式无效，未恢复。已保存的共享布局未改变。',
    ),
  ).toBeNull();
  expect((await savedWorld()).nodes[0].placement.position).toEqual([4, 0, 0]);
  await restored.user.click(screen.getByRole('button', { name: '保存布局' }));
  await waitFor(() =>
    expect(
      screen.getByRole('status', { name: '布局保存状态' }),
    ).toHaveTextContent('已保存'),
  );
  const saved = await savedWorld();
  expect(saved.nodes).toHaveLength(1);
  expect(saved.nodes[0].id).toBe('second-node');
  expect(saved.nodes[0].placement.position).toEqual([9, 0, 0]);
});
