import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import {
  createApiClient,
  type CurrentSession,
  type LabAsset,
  type CreateAssetUpload,
} from '@labos-threejs/sdk';
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

function open(
  path = '/assets',
  initial: LabAsset[] = [],
  maxBytes = 20 * 1024 * 1024,
) {
  let saved = initial;
  let pending: CreateAssetUpload | null = null;
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json(identity),
    ),
    http.get('http://api.test/api/v1/lab/asset-definitions', () =>
      HttpResponse.json({
        data: JSON.parse(
          readFileSync('packages/server/src/lab/world/catalog.json', 'utf8'),
        ),
      }),
    ),
    http.get('http://api.test/api/v1/lab/assets', () =>
      HttpResponse.json({
        data: saved,
        max_upload_bytes: maxBytes,
        has_more: false,
        next_cursor: null,
      }),
    ),
    http.post(
      'http://api.test/api/v1/lab/asset-uploads',
      async ({ request }) => {
        expect(request.headers.get('x-csrf-token')).toBe('lab-test-csrf');
        expect(request.headers.get('idempotency-key')).toBeTruthy();
        pending = (await request.json()) as CreateAssetUpload;
        return HttpResponse.json(
          {
            upload_id: 'stable-file',
            state: 'pending_upload',
            upload: {
              url: 'http://storage.test/model',
              method: 'PUT',
              headers: {},
              expires_at: '2026-10-03T00:15:00Z',
            },
          },
          { status: 201 },
        );
      },
    ),
    http.put(
      'http://storage.test/model',
      () => new HttpResponse(null, { status: 200 }),
    ),
    http.post(
      'http://api.test/api/v1/lab/asset-uploads/stable-file/complete',
      () => {
        if (!pending) return new HttpResponse(null, { status: 409 });
        const asset: LabAsset = {
          id: 'saved-model',
          name: pending.name,
          source: pending.source,
          license: pending.license,
          version: pending.version,
          created_by: identity.user.id,
          updated_by: identity.user.id,
          created_at: '2026-10-03T00:00:00Z',
          updated_at: '2026-10-03T00:00:00Z',
          representation: {
            id: 'representation',
            file_id: 'stable-file',
            file_name: pending.file.file_name,
            size: pending.file.size,
            content_type: pending.file.content_type,
            sha256: pending.file.sha256,
          },
        };
        saved = [asset];
        return HttpResponse.json(asset);
      },
    ),
    http.delete('http://api.test/api/v1/lab/assets/:id', ({ params }) => {
      saved = saved.filter((asset) => asset.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
    http.patch(
      'http://api.test/api/v1/lab/assets/:id',
      async ({ request, params }) => {
        const body = (await request.json()) as { name: string };
        saved = saved.map((asset) =>
          asset.id === params.id ? { ...asset, name: body.name } : asset,
        );
        return HttpResponse.json(saved.find((asset) => asset.id === params.id));
      },
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
  await user.click(await screen.findByRole('button', { name: '发布资产' }));
  expect(await screen.findByText('my-microscope.glb')).toBeVisible();
  await user.type(
    screen.getByRole('searchbox', { name: '搜索资产' }),
    'my-microscope',
  );
  expect(screen.queryByText('工业显微镜')).toBeNull();
  await user.click(
    screen.getByRole('button', { name: '在 Lab 中打开 my-microscope' }),
  );
  await waitFor(() =>
    expect(router.state.location.pathname).toBe('/lab/asset'),
  );
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
  await user.click(await screen.findByRole('button', { name: '发布资产' }));
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
  await user.click(await screen.findByRole('button', { name: '发布资产' }));
  expect(await screen.findByText('recovered.glb')).toBeVisible();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a new browser reads saved assets and displays the configured upload limit', async () => {
  open(
    '/assets',
    [
      {
        id: 'saved-model',
        name: 'Saved centrifuge',
        source: 'Vendor',
        license: 'CC0',
        version: '1.0',
        created_by: 'lab-user',
        updated_by: 'lab-user',
        created_at: '2026-10-03T00:00:00Z',
        updated_at: '2026-10-03T00:00:00Z',
        representation: {
          id: 'representation',
          file_id: 'stable-file',
          file_name: 'saved.glb',
          size: 1234,
          content_type: 'model/gltf-binary',
          sha256: '00'.repeat(32),
        },
      },
    ],
    8 * 1024 * 1024,
  );
  expect(await screen.findByText('Saved centrifuge')).toBeVisible();
  expect(screen.getByText('saved.glb')).toBeVisible();
  expect(screen.getByText(/8\.00 MiB/)).toBeVisible();
});

test('publication failure retains metadata and retries the same upload intent', async () => {
  const { user } = open();
  await screen.findByText('工业显微镜');
  const keys: string[] = [];
  let fail = true;
  server.use(
    http.post('http://api.test/api/v1/lab/asset-uploads', ({ request }) => {
      keys.push(request.headers.get('idempotency-key') ?? '');
    }),
    http.post(
      'http://api.test/api/v1/lab/asset-uploads/stable-file/complete',
      () => {
        if (fail)
          return HttpResponse.json(
            {
              error: {
                code: 'files.unavailable',
                message: 'Unavailable',
                request_id: 'test-request',
              },
            },
            { status: 503 },
          );
      },
    ),
  );
  const bytes = readFileSync('tests/fixtures/lab/cube.glb');
  await user.upload(
    screen.getByLabelText('GLB 文件'),
    new File([new Uint8Array(bytes)], 'retry.glb'),
  );
  const dialog = await screen.findByRole('dialog');
  await user.clear(within(dialog).getByLabelText('名称'));
  await user.type(within(dialog).getByLabelText('名称'), 'My saved model');
  await user.type(within(dialog).getByLabelText('来源'), 'Bench scan');
  await user.type(within(dialog).getByLabelText('许可'), 'CC0');
  await user.click(within(dialog).getByRole('button', { name: '发布资产' }));
  expect(await within(dialog).findByRole('alert')).toBeVisible();
  expect(within(dialog).getByLabelText('名称')).toHaveValue('My saved model');
  expect(within(dialog).getByLabelText('来源')).toHaveValue('Bench scan');
  expect(within(dialog).getByLabelText('许可')).toHaveValue('CC0');
  fail = false;
  await user.click(within(dialog).getByRole('button', { name: '发布资产' }));
  expect(await screen.findByText('My saved model')).toBeVisible();
  expect(screen.getByText('Bench scan')).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
});

test('the robot definition exposes declared capabilities without a runnable action', async () => {
  const { user } = open();
  await user.click(
    await screen.findByRole('button', { name: '查看 协作机械臂 定义' }),
  );
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('robot.move')).toBeVisible();
  expect(within(dialog).getAllByText('尚未实现').length).toBeGreaterThan(0);
  expect(
    within(dialog).queryByRole('button', { name: /Start|启动/ }),
  ).toBeNull();
});

test('an expired upload starts a new intent on retry while keeping the draft', async () => {
  const { user } = open();
  await screen.findByText('工业显微镜');
  const keys: string[] = [];
  server.use(
    http.post('http://api.test/api/v1/lab/asset-uploads', ({ request }) => {
      keys.push(request.headers.get('idempotency-key') ?? '');
      if (keys.length === 1)
        return HttpResponse.json(
          {
            error: {
              code: 'files.upload_expired',
              message: 'Expired',
              request_id: 'test-expired',
            },
          },
          { status: 410 },
        );
    }),
  );
  const bytes = readFileSync('tests/fixtures/lab/cube.glb');
  await user.upload(
    screen.getByLabelText('GLB 文件'),
    new File([new Uint8Array(bytes)], 'expired.glb'),
  );
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: '发布资产' }));
  await within(dialog).findByRole('alert');
  expect(within(dialog).getByLabelText('名称')).toHaveValue('expired');
  await user.click(within(dialog).getByRole('button', { name: '发布资产' }));
  expect(await screen.findByText('expired.glb')).toBeVisible();
  expect(keys[0]).not.toBe(keys[1]);
});

test('the deployment limit rejects an oversized file before reading its format', async () => {
  const { user } = open('/assets', [], 512);
  await screen.findByText('工业显微镜');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '导入 GLB' })).toBeEnabled(),
  );
  await user.upload(
    screen.getByLabelText('GLB 文件'),
    new File([new Uint8Array(513)], 'large.glb'),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '文件超过当前部署的上传上限',
  );
  expect(screen.getByText('工业显微镜')).toBeVisible();
  expect(screen.queryByRole('dialog')).toBeNull();
});
