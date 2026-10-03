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
      HttpResponse.json({ lab, entities, nodes, assets: [] }),
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
  let inspector = screen.getByRole('complementary', { name: '对象信息' });
  expect(
    within(inspector).getByText('entity-1', { exact: true }),
  ).toBeVisible();
  expect(within(inspector).getByText('robot.pick')).toBeVisible();
  expect(within(inspector).getAllByText('尚未实现').length).toBe(3);
  expect(within(inspector).getByText('未知 · 无观测')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '选择 Robot B' }));
  inspector = screen.getByRole('complementary', { name: '对象信息' });
  expect(
    within(inspector).getByText('entity-2', { exact: true }),
  ).toBeVisible();
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
