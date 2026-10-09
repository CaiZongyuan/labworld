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
    id: 'world-user',
    email: 'world@example.test',
    display_name: 'World user',
    role: 'member',
  },
  csrf_token: 'world-csrf',
} satisfies CurrentSession;

function open() {
  const definitions = JSON.parse(
    readFileSync('crates/app/src/modules/lab/definitions.json', 'utf8'),
  );
  let lab: { id: string; name: string; layout_version: number } | null = null;
  const entities: Record<string, unknown>[] = [];
  const nodes: Record<string, unknown>[] = [];
  let relationships: Record<string, unknown>[] = [];
  let version = 0;
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json(identity),
    ),
    http.get('http://api.test/api/v1/lab/labs', () =>
      HttpResponse.json({ data: lab ? [lab] : [] }),
    ),
    http.post('http://api.test/api/v1/lab/labs', async ({ request }) => {
      expect(request.headers.get('x-csrf-token')).toBe(identity.csrf_token);
      const input = (await request.json()) as { name: string };
      lab = { id: 'lab-one', name: input.name, layout_version: 0 };
      return HttpResponse.json(lab, { status: 201 });
    }),
    http.get('http://api.test/api/v1/lab/asset-definitions', () =>
      HttpResponse.json({ data: definitions }),
    ),
    http.get('http://api.test/api/v1/lab/assets', () =>
      HttpResponse.json({
        data: [],
        has_more: false,
        next_cursor: null,
        max_upload_bytes: 20000000,
      }),
    ),
    http.get('http://api.test/api/v1/lab/labs/lab-one/world', () =>
      HttpResponse.json({
        version: String(++version),
        lab,
        entities,
        nodes,
        assets: [],
        relationships,
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
    http.put(
      'http://api.test/api/v1/lab/labs/lab-one/layout',
      async ({ request }) => {
        const input = (await request.json()) as {
          expected_version: number;
          nodes: Record<string, unknown>[];
          relationships?: Record<string, unknown>[];
        };
        if (input.expected_version !== lab?.layout_version)
          return HttpResponse.json(
            {
              error: {
                code: 'lab.layout_conflict',
                message: 'Changed',
                request_id: 'layout-conflict',
              },
            },
            { status: 409 },
          );
        nodes.splice(
          0,
          nodes.length,
          ...input.nodes.map((node) => ({ ...node, lab_id: 'lab-one' })),
        );
        if (input.relationships)
          relationships = input.relationships.map(
            (relation) =>
              relationships.find((existing) => existing.id === relation.id) ?? {
                ...relation,
                lab_id: 'lab-one',
                source: 'manual',
                registered_by: identity.user.id,
                registered_at: '2026-10-03T06:00:00Z',
              },
          );
        lab.layout_version++;
        return HttpResponse.json({
          layout_version: lab.layout_version,
          nodes,
          relationships,
        });
      },
    ),
    http.post(
      'http://api.test/api/v1/lab/labs/lab-one/entities',
      async ({ request }) => {
        expect(request.headers.get('x-csrf-token')).toBe(identity.csrf_token);
        const input = (await request.json()) as {
          name: string;
          definition_id: string;
          definition_version: string;
        };
        const definition = definitions.find(
          (entry: { id: string; version: string }) =>
            entry.id === input.definition_id &&
            entry.version === input.definition_version,
        );
        const id = `entity-${entities.length + 1}`;
        const entity = {
          ...input,
          id,
          lab_id: 'lab-one',
          definition,
          kind: definition.category,
          binding: null,
          observation: null,
          capabilities: definition.capabilities.map(
            (capability: { id: string }) => ({
              ...capability,
              definition_supported: true,
              binding_implemented: false,
              executable: false,
              reason: 'binding_not_implemented',
            }),
          ),
        };
        entities.push(entity);
        nodes.push({
          id: `node-${id}`,
          entity_id: id,
          lab_id: 'lab-one',
          representation_id: null,
          placement: {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
        });
        if (lab) lab.layout_version++;
        return HttpResponse.json(entity, { status: 201 });
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
  return userEvent.setup();
}

test('a member creates a Lab and selects two independent Robots from the object directory', async () => {
  const user = open();
  await user.click(await screen.findByRole('button', { name: '创建 Lab' }));
  let dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText('名称'), 'Identity lab');
  await user.click(within(dialog).getByRole('button', { name: '创建' }));
  await screen.findByRole('heading', { name: 'Identity lab' });
  for (const name of ['Robot A', 'Robot B']) {
    await user.click(screen.getByRole('button', { name: '登记对象' }));
    dialog = await screen.findByRole('dialog');
    await user.selectOptions(
      within(dialog).getByLabelText('定义版本'),
      'robot@1.0',
    );
    await user.type(within(dialog).getByLabelText('名称'), name);
    await user.click(within(dialog).getByRole('button', { name: '登记' }));
    await screen.findByRole('button', { name: `选择 ${name}` });
  }
  await user.click(screen.getByRole('button', { name: '选择 Robot A' }));
  await user.click(screen.getByRole('tab', { name: '详情' }));
  let inspector = screen.getByRole('tabpanel', { name: '详情' });
  expect(
    within(inspector).getByText('entity-1', { exact: true }),
  ).toBeVisible();
  expect(within(inspector).getByText('robot.pick')).toBeVisible();
  expect(within(inspector).getAllByText('尚未实现').length).toBe(3);
  expect(within(inspector).getByText('未知 · 无观测')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '选择 Robot B' }));
  await user.click(screen.getByRole('tab', { name: '详情' }));
  inspector = screen.getByRole('tabpanel', { name: '详情' });
  expect(
    within(inspector).getByText('entity-2', { exact: true }),
  ).toBeVisible();
});

test('explicit location registration preserves its manual source after coordinates change', async () => {
  const user = open();
  await user.click(await screen.findByRole('button', { name: '创建 Lab' }));
  let dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText('名称'), 'Location lab');
  await user.click(within(dialog).getByRole('button', { name: '创建' }));
  await screen.findByRole('heading', { name: 'Location lab' });
  for (const [definition, name] of [
    ['bench', 'North bench'],
    ['labware', 'Beaker'],
  ]) {
    await user.click(screen.getByRole('button', { name: '登记对象' }));
    dialog = await screen.findByRole('dialog');
    await user.selectOptions(
      within(dialog).getByLabelText('定义版本'),
      `${definition}@1.0`,
    );
    await user.type(within(dialog).getByLabelText('名称'), name);
    await user.click(within(dialog).getByRole('button', { name: '登记' }));
    await screen.findByRole('button', { name: `选择 ${name}` });
  }
  await user.click(screen.getByRole('tab', { name: '编辑布局' }));
  await user.selectOptions(screen.getByLabelText('关系对象'), 'entity-1');
  await user.click(screen.getByRole('button', { name: '登记关系' }));
  await user.click(screen.getByRole('button', { name: '保存布局' }));
  await waitFor(() =>
    expect(
      screen.getByRole('status', { name: '布局保存状态' }),
    ).toHaveTextContent('已保存'),
  );
  expect(screen.getByText('人工登记', { exact: true })).toBeVisible();
  const before = await (
    await fetch('http://api.test/api/v1/lab/labs/lab-one/world')
  ).json();
  const x = screen.getByLabelText('X (m)');
  await user.clear(x);
  await user.type(x, '3');
  await user.click(screen.getByRole('button', { name: '保存布局' }));
  await waitFor(() =>
    expect(
      screen.getByRole('status', { name: '布局保存状态' }),
    ).toHaveTextContent('已保存'),
  );
  const after = await (
    await fetch('http://api.test/api/v1/lab/labs/lab-one/world')
  ).json();
  expect(after.relationships).toEqual(before.relationships);
  expect(after.relationships[0]).toMatchObject({
    source_id: 'entity-2',
    target_id: 'entity-1',
    kind: 'located_in',
    source: 'manual',
    registered_by: identity.user.id,
  });
  expect(after.nodes[1].placement.position[0]).toBe(3);
});

test('removing a scene node leaves an unplaced object that can be added with the same identity', async () => {
  const user = open();
  await user.click(await screen.findByRole('button', { name: '创建 Lab' }));
  let dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText('名称'), 'Unplaced lab');
  await user.click(within(dialog).getByRole('button', { name: '创建' }));
  await screen.findByRole('heading', { name: 'Unplaced lab' });
  await user.click(screen.getByRole('button', { name: '登记对象' }));
  dialog = await screen.findByRole('dialog');
  await user.selectOptions(
    within(dialog).getByLabelText('定义版本'),
    'labware@1.0',
  );
  await user.type(within(dialog).getByLabelText('名称'), 'Unplaced beaker');
  await user.click(within(dialog).getByRole('button', { name: '登记' }));
  await screen.findByRole('button', { name: '选择 Unplaced beaker' });
  await user.click(screen.getByRole('tab', { name: '编辑布局' }));
  await user.click(screen.getByRole('button', { name: '移除节点' }));
  await user.click(screen.getByRole('button', { name: '保存布局' }));
  await waitFor(() =>
    expect(
      screen.getByRole('status', { name: '布局保存状态' }),
    ).toHaveTextContent('已保存'),
  );
  await user.click(screen.getByRole('checkbox', { name: '仅未放置对象' }));
  expect(
    screen.getByRole('button', { name: '选择 Unplaced beaker' }),
  ).toBeVisible();
  const empty = await (
    await fetch('http://api.test/api/v1/lab/labs/lab-one/world')
  ).json();
  expect(empty.nodes).toEqual([]);
  expect(empty.entities[0].id).toBe('entity-1');
  await user.click(screen.getByRole('button', { name: '新增同一对象表示' }));
  await user.click(screen.getByRole('button', { name: '保存布局' }));
  await waitFor(() =>
    expect(
      screen.getByRole('status', { name: '布局保存状态' }),
    ).toHaveTextContent('已保存'),
  );
  const restored = await (
    await fetch('http://api.test/api/v1/lab/labs/lab-one/world')
  ).json();
  expect(restored.nodes).toHaveLength(1);
  expect(restored.nodes[0].entity_id).toBe('entity-1');
  expect(restored.entities).toHaveLength(1);
});

test('a failed registration retains the name and definition for a successful retry', async () => {
  const user = open();
  await user.click(await screen.findByRole('button', { name: '创建 Lab' }));
  let dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText('名称'), 'Retry lab');
  await user.click(within(dialog).getByRole('button', { name: '创建' }));
  await screen.findByRole('heading', { name: 'Retry lab' });
  let failed = true;
  server.use(
    http.post('http://api.test/api/v1/lab/labs/lab-one/entities', () =>
      failed
        ? HttpResponse.json(
            {
              error: {
                code: 'lab.unavailable',
                message: 'Unavailable',
                request_id: 'retry',
              },
            },
            { status: 503 },
          )
        : undefined,
    ),
  );
  await user.click(screen.getByRole('button', { name: '登记对象' }));
  dialog = await screen.findByRole('dialog');
  await user.selectOptions(
    within(dialog).getByLabelText('定义版本'),
    'bench@1.0',
  );
  await user.type(within(dialog).getByLabelText('名称'), 'North bench');
  await user.click(within(dialog).getByRole('button', { name: '登记' }));
  expect(await within(dialog).findByRole('alert')).toBeVisible();
  expect(within(dialog).getByLabelText('名称')).toHaveValue('North bench');
  expect(within(dialog).getByLabelText('定义版本')).toHaveValue('bench@1.0');
  failed = false;
  await user.click(within(dialog).getByRole('button', { name: '登记' }));
  expect(
    await screen.findByRole('button', { name: '选择 North bench' }),
  ).toBeVisible();
});

test('a layout conflict keeps the coordinate draft and reloads additions before an explicit retry', async () => {
  const user = open();
  await user.click(await screen.findByRole('button', { name: '创建 Lab' }));
  let dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText('名称'), 'Draft lab');
  await user.click(within(dialog).getByRole('button', { name: '创建' }));
  await screen.findByRole('heading', { name: 'Draft lab' });
  await user.click(screen.getByRole('button', { name: '登记对象' }));
  dialog = await screen.findByRole('dialog');
  await user.selectOptions(
    within(dialog).getByLabelText('定义版本'),
    'labware@1.0',
  );
  await user.type(within(dialog).getByLabelText('名称'), 'Draft beaker');
  await user.click(within(dialog).getByRole('button', { name: '登记' }));
  await screen.findByRole('button', { name: '选择 Draft beaker' });
  await user.click(screen.getByRole('tab', { name: '编辑布局' }));
  const x = screen.getByLabelText('X (m)');
  await user.clear(x);
  await user.type(x, '2');
  const remote = await (
    await fetch('http://api.test/api/v1/lab/labs/lab-one/world')
  ).json();
  const added = {
    ...remote.nodes[0],
    id: 'added-by-other',
    placement: { position: [4, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  };
  await fetch('http://api.test/api/v1/lab/labs/lab-one/layout', {
    method: 'PUT',
    body: JSON.stringify({
      expected_version: 1,
      nodes: [remote.nodes[0], added],
    }),
  });
  await user.click(screen.getByRole('button', { name: '保存布局' }));
  expect(await screen.findByText('布局已改变，草稿已保留')).toBeVisible();
  expect(x).toHaveValue(2);
  await user.clear(x);
  await user.type(x, '3');
  await user.click(screen.getByRole('button', { name: '重新载入并保留草稿' }));
  expect(await screen.findByText('added-by-other')).toBeVisible();
  expect(screen.getByLabelText('X (m)')).toHaveValue(3);
  await user.click(screen.getByRole('button', { name: '重试保存' }));
  await waitFor(() =>
    expect(
      screen.getByRole('status', { name: '布局保存状态' }),
    ).toHaveTextContent('已保存'),
  );
  const reopened = await (
    await fetch('http://api.test/api/v1/lab/labs/lab-one/world')
  ).json();
  expect(reopened.nodes).toHaveLength(2);
  expect(reopened.nodes[0].placement.position).toEqual([3, 0, 0]);
  expect(reopened.nodes[1].id).toBe('added-by-other');
});
