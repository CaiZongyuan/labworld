import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import {
  createApiClient,
  type CurrentSession,
  type Document,
  type DocumentExport,
} from '@labos-threejs/sdk';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { createAppRouter } from './router';

const identity = {
  user: {
    id: 'writer',
    email: 'writer@example.com',
    display_name: null,
    role: 'member',
  },
  csrf_token: 'csrf-proof',
} satisfies CurrentSession;
const document = {
  id: 'doc-one',
  knowledge_base_id: 'base-one',
  title: '导出页面',
  markdown: '正文',
  can_edit: false,
  version: 1,
  created_by: 'writer',
  updated_by: 'writer',
  created_at: '2026-09-26T00:00:00Z',
  updated_at: '2026-09-26T00:00:00Z',
} satisfies Document;
const exported = {
  id: 'export-one',
  document_id: 'doc-one',
  document_version: 1,
  status: 'queued',
  last_error: null,
  can_download: false,
  created_at: '2026-09-26T00:00:00Z',
  expires_at: '2026-09-27T00:00:00Z',
} satisfies DocumentExport;
function open(readable = () => true) {
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json(identity),
    ),
    http.get('http://api.test/api/v1/knowledge/documents/doc-one', () =>
      readable()
        ? HttpResponse.json(document)
        : HttpResponse.json(
            { error: { code: 'knowledge.not_found', message: 'Not found' } },
            { status: 404 },
          ),
    ),
    http.get(
      'http://api.test/api/v1/knowledge/documents/doc-one/attachments',
      () =>
        HttpResponse.json({
          data: [],
          can_upload: false,
          can_delete: false,
          max_upload_bytes: 20971520,
          next_cursor: null,
          has_more: false,
        }),
    ),
  );
  const router = createAppRouter(
    {
      apiClient: createApiClient('http://api.test'),
      docsUrl: 'https://docs.test',
    },
    createMemoryHistory({ initialEntries: ['/documents/doc-one'] }),
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

test('a Reader requests an export and can refresh its progress to the downloadable snapshot', async () => {
  let status: string | undefined;
  server.use(
    http.get('http://api.test/api/v1/knowledge/documents/doc-one/exports', () =>
      HttpResponse.json({
        data: status
          ? [{ ...exported, status, can_download: status === 'succeeded' }]
          : [],
        next_cursor: null,
        has_more: false,
      }),
    ),
    http.post(
      'http://api.test/api/v1/knowledge/documents/doc-one/exports',
      ({ request }) => {
        expect(request.headers.get('x-csrf-token')).toBe(identity.csrf_token);
        expect(request.headers.get('idempotency-key')).toBeTruthy();
        status = 'queued';
        return HttpResponse.json(exported, { status: 202 });
      },
    ),
  );
  const user = open();
  await user.click(await screen.findByRole('button', { name: '导出当前文档' }));
  expect(await screen.findByText('等待处理')).toBeVisible();
  expect(
    screen.queryByRole('button', { name: '下载 ZIP' }),
  ).not.toBeInTheDocument();
  status = 'succeeded';
  await user.click(screen.getByRole('button', { name: '刷新导出状态' }));
  expect(await screen.findByRole('button', { name: '下载 ZIP' })).toBeEnabled();
});

test('a failed request retries the same identity, then exposes job failure and expiration without download', async () => {
  const keys: string[] = [];
  let status: string | undefined;
  server.use(
    http.get('http://api.test/api/v1/knowledge/documents/doc-one/exports', () =>
      HttpResponse.json({
        data: status ? [{ ...exported, status }] : [],
        next_cursor: null,
        has_more: false,
      }),
    ),
    http.post(
      'http://api.test/api/v1/knowledge/documents/doc-one/exports',
      ({ request }) => {
        keys.push(request.headers.get('idempotency-key')!);
        if (keys.length === 1)
          return HttpResponse.json(
            {
              error: {
                code: 'knowledge.unavailable',
                request_id: 'export-retry',
                details: {},
                message: 'Try later',
              },
            },
            { status: 503 },
          );
        status = 'failed';
        return HttpResponse.json(
          { ...exported, status, last_error: 'knowledge.export_input_missing' },
          { status: 202 },
        );
      },
    ),
  );
  const user = open();
  await user.click(await screen.findByRole('button', { name: '导出当前文档' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('export-retry');
  await user.click(screen.getByRole('button', { name: '重试申请导出' }));
  expect(await screen.findByText('导出失败')).toBeVisible();
  expect(keys[1]).toBe(keys[0]);
  expect(
    screen.queryByRole('button', { name: '下载 ZIP' }),
  ).not.toBeInTheDocument();
  status = 'expired';
  await user.click(screen.getByRole('button', { name: '刷新导出状态' }));
  expect(await screen.findByText('已过期')).toBeVisible();
});

test('a completed export reports a later permission denial when requesting its download', async () => {
  let readable = true;
  server.use(
    http.get('http://api.test/api/v1/knowledge/documents/doc-one/exports', () =>
      HttpResponse.json({
        data: [{ ...exported, status: 'succeeded', can_download: true }],
        next_cursor: null,
        has_more: false,
      }),
    ),
    http.get(
      'http://api.test/api/v1/knowledge/documents/doc-one/exports/export-one/download',
      () => {
        readable = false;
        return HttpResponse.json(
          {
            error: {
              code: 'knowledge.not_found',
              request_id: 'denied',
              message: 'Not found',
            },
          },
          { status: 404 },
        );
      },
    ),
  );
  const user = open(() => readable);
  await user.click(await screen.findByRole('button', { name: '下载 ZIP' }));
  expect(
    await screen.findByText('文档不存在，或你已失去访问权限。'),
  ).toBeVisible();
  expect(
    screen.queryByRole('heading', { name: document.title }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: '下载 ZIP' }),
  ).not.toBeInTheDocument();
});

test('a new export returns to the newest page after older pages exceed the cache limit', async () => {
  let created = false;
  server.use(
    http.get(
      'http://api.test/api/v1/knowledge/documents/doc-one/exports',
      ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        const page = cursor ? Number(cursor) : 0;
        return HttpResponse.json({
          data:
            created && !cursor
              ? [exported]
              : [
                  {
                    ...exported,
                    id: `history-${page}`,
                    document_version: page + 1,
                    status: 'succeeded',
                    can_download: true,
                  },
                ],
          next_cursor: page < 5 ? String(page + 1) : null,
          has_more: page < 5,
        });
      },
    ),
    http.post(
      'http://api.test/api/v1/knowledge/documents/doc-one/exports',
      () => {
        created = true;
        return HttpResponse.json(exported, { status: 202 });
      },
    ),
  );
  const user = open();
  for (let page = 1; page <= 5; page++) {
    const load = await screen.findByRole('button', { name: '加载更多导出' });
    await waitFor(() => expect(load).toBeEnabled());
    await user.click(load);
    await screen.findByText(`版本 ${page + 1}`);
  }
  await user.click(screen.getByRole('button', { name: '导出当前文档' }));
  expect(await screen.findByText('等待处理')).toBeVisible();
});
