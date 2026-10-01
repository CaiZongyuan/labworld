import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { createApiClient, type CurrentSession } from '@labos-threejs/sdk';
import { render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { createAppRouter } from './router';

const identity = {
  user: {
    id: 'lab-user',
    email: 'lab-user@example.test',
    display_name: 'Lab 用户',
    role: 'member',
  },
  csrf_token: 'lab-test-csrf',
} satisfies CurrentSession;

function open(path = '/assets') {
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json(identity),
    ),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const router = createAppRouter(
    {
      apiClient: createApiClient('http://api.test'),
      docsUrl: 'https://docs.test',
    },
    createMemoryHistory({ initialEntries: [path] }),
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient, user: userEvent.setup() };
}

test('the asset library lists the real preset model and replaces knowledge in business navigation', async () => {
  open();
  expect(await screen.findByRole('heading', { name: '资产库' })).toBeVisible();
  expect(await screen.findByText('工业显微镜')).toBeVisible();
  expect(screen.getByText('industrial-microscope.glb')).toBeVisible();
  expect(screen.getByRole('link', { name: 'Lab' })).toHaveAttribute(
    'href',
    '/lab',
  );
  expect(screen.getByRole('link', { name: '资产库' })).toHaveAttribute(
    'href',
    '/assets',
  );
  expect(screen.queryByRole('link', { name: '知识库' })).toBeNull();
});

test('a local GLB stays in the asset library while opening Lab and navigating back', async () => {
  const { router, user } = open();
  await screen.findByText('工业显微镜');
  const bytes = readFileSync(
    'apps/web/public/lab-assets/models/industrial-microscope.glb',
  );
  const file = new File([new Uint8Array(bytes)], 'my-microscope.glb', {
    type: 'model/gltf-binary',
  });
  await user.upload(screen.getByLabelText('GLB 文件'), file);
  expect(await screen.findByText('my-microscope.glb')).toBeVisible();
  await user.type(
    screen.getByRole('searchbox', { name: '搜索资产' }),
    'my-microscope',
  );
  expect(screen.queryByText('工业显微镜')).toBeNull();
  await user.click(
    screen.getByRole('button', { name: '在 Lab 中打开 my-microscope' }),
  );
  await waitFor(() => expect(router.state.location.pathname).toBe('/lab'));
  await user.click(screen.getByRole('link', { name: '资产库' }));
  expect(await screen.findByText('my-microscope.glb')).toBeVisible();
  expect(screen.getByText('工业显微镜')).toBeVisible();
});

test('local assets can be removed after confirmation while the bundled preset remains', async () => {
  const { user } = open();
  await screen.findByText('工业显微镜');
  const bytes = readFileSync(
    'apps/web/public/lab-assets/models/industrial-microscope.glb',
  );
  await user.upload(
    screen.getByLabelText('GLB 文件'),
    new File([new Uint8Array(bytes)], 'temporary.glb'),
  );
  await screen.findByText('temporary.glb');
  await user.click(screen.getByRole('button', { name: '移除 temporary' }));
  const dialog = await screen.findByRole('alertdialog');
  await user.click(within(dialog).getByRole('button', { name: '移除' }));
  await waitFor(() => expect(screen.queryByText('temporary.glb')).toBeNull());
  expect(screen.getByText('工业显微镜')).toBeVisible();
});

test('invalid GLB imports leave the catalog intact and a valid retry succeeds', async () => {
  const { user } = open();
  await screen.findByText('工业显微镜');
  await user.upload(
    screen.getByLabelText('GLB 文件'),
    new File(['invalid'], 'broken.glb'),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '文件不是有效的 glTF 2.0 GLB',
  );
  expect(screen.queryByText('broken.glb')).toBeNull();
  expect(screen.getByText('工业显微镜')).toBeVisible();
  const bytes = readFileSync(
    'apps/web/public/lab-assets/models/industrial-microscope.glb',
  );
  await user.upload(
    screen.getByLabelText('GLB 文件'),
    new File([new Uint8Array(bytes)], 'recovered.glb'),
  );
  expect(await screen.findByText('recovered.glb')).toBeVisible();
  expect(screen.queryByRole('alert')).toBeNull();
});
