import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import {
  createApiClient,
  type CurrentSession,
  type Document,
  type FileInfo,
} from '@labos-threejs/sdk';
import { render, screen, waitFor, within } from '@testing-library/react';
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
    role: 'owner',
  },
  csrf_token: 'csrf-proof',
} satisfies CurrentSession;
const document = {
  id: 'doc-one',
  knowledge_base_id: 'base-one',
  title: '删除测试',
  markdown: '原始正文',
  can_edit: true,
  version: 1,
  created_by: 'writer',
  updated_by: 'writer',
  created_at: '2026-09-26T00:00:00Z',
  updated_at: '2026-09-26T00:00:00Z',
} satisfies Document;
const file = {
  id: 'file-one',
  file_name: 'notes.txt',
  content_type: 'text/plain',
  size: 3,
  sha256: 'a'.repeat(64),
  previewable: false,
  created_at: '2026-09-26T00:00:00Z',
} satisfies FileInfo;
function open(path = '/documents/doc-one', canEdit = true) {
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json(identity),
    ),
    http.get('http://api.test/api/v1/knowledge/documents/doc-one', () =>
      HttpResponse.json({ ...document, can_edit: canEdit }),
    ),
    http.get('http://api.test/api/v1/knowledge/documents/doc-one/exports', () =>
      HttpResponse.json({ data: [], has_more: false, next_cursor: null }),
    ),
    http.get('http://api.test/api/v1/knowledge/documents', () =>
      HttpResponse.json({
        data: [],
        can_create: true,
        has_more: false,
        next_cursor: null,
      }),
    ),
  );
  const router = createAppRouter(
    {
      apiClient: createApiClient('http://api.test'),
      docsUrl: 'https://docs.test',
    },
    createMemoryHistory({ initialEntries: [path] }),
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
  return { user: userEvent.setup(), router };
}

test('document deletion requires confirmation and cancel leaves the document intact', async () => {
  let deleted = false;
  server.use(
    http.get(
      'http://api.test/api/v1/knowledge/documents/doc-one/attachments',
      () =>
        HttpResponse.json({
          data: [],
          can_upload: true,
          can_delete: true,
          max_upload_bytes: 20971520,
          has_more: false,
          next_cursor: null,
        }),
    ),
    http.delete(
      'http://api.test/api/v1/knowledge/documents/doc-one',
      ({ request }) => {
        expect(request.headers.get('x-csrf-token')).toBe(identity.csrf_token);
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      },
    ),
  );
  const { user, router } = open();
  await user.click(await screen.findByRole('button', { name: '删除文档' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog).toHaveTextContent('删除后无法恢复');
  expect(deleted).toBe(false);
  await user.click(within(dialog).getByRole('button', { name: '取消' }));
  expect(deleted).toBe(false);
  expect(screen.getByRole('heading', { name: document.title })).toBeVisible();
  await user.click(screen.getByRole('button', { name: '删除文档' }));
  await user.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', {
      name: '确认删除',
    }),
  );
  await waitFor(() =>
    expect(router.state.location.pathname).toBe('/documents'),
  );
  expect(deleted).toBe(true);
});

test('removing an attachment preserves an unsaved Markdown draft', async () => {
  let deleted = false;
  server.use(
    http.get(
      'http://api.test/api/v1/knowledge/documents/doc-one/attachments',
      () =>
        HttpResponse.json({
          data: deleted ? [] : [file],
          can_upload: true,
          can_delete: true,
          max_upload_bytes: 20971520,
          has_more: false,
          next_cursor: null,
        }),
    ),
    http.delete(
      'http://api.test/api/v1/knowledge/documents/doc-one/attachments/file-one',
      () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      },
    ),
  );
  const { user } = open('/documents/doc-one/edit');
  const input = await screen.findByLabelText('Markdown 正文');
  await user.clear(input);
  await user.type(input, '仍未保存的正文');
  await user.click(
    await screen.findByRole('button', { name: '删除附件 notes.txt' }),
  );
  await user.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', {
      name: '确认删除',
    }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: '下载 notes.txt' }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByLabelText('Markdown 正文')).toHaveValue('仍未保存的正文');
  expect(screen.getByRole('button', { name: '保存文档' })).toBeEnabled();
});

test('a Reader gets neither document nor attachment deletion controls', async () => {
  server.use(
    http.get(
      'http://api.test/api/v1/knowledge/documents/doc-one/attachments',
      () =>
        HttpResponse.json({
          data: [file],
          can_upload: false,
          can_delete: false,
          max_upload_bytes: 20971520,
          has_more: false,
          next_cursor: null,
        }),
    ),
  );
  open('/documents/doc-one', false);
  await screen.findByRole('button', { name: '下载 notes.txt' });
  expect(
    screen.queryByRole('button', { name: '删除文档' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: '删除附件 notes.txt' }),
  ).not.toBeInTheDocument();
});

test('an administrator confirms that deleting a personal library will not recreate it', async () => {
  server.use(
    http.get('http://api.test/api/v1/knowledge/bases/base-one', () =>
      HttpResponse.json({
        id: 'base-one',
        name: '我的知识库',
        personal: true,
        can_edit: true,
        can_manage: true,
      }),
    ),
    http.get('http://api.test/api/v1/knowledge/bases', () =>
      HttpResponse.json({
        data: [],
        can_create: true,
        has_more: false,
        next_cursor: null,
      }),
    ),
    http.get('http://api.test/api/v1/knowledge/bases/base-one/grants', () =>
      HttpResponse.json({ data: [], has_more: false, next_cursor: null }),
    ),
    http.get('http://api.test/api/v1/organization/members', () =>
      HttpResponse.json({
        data: [],
        assignable_roles: ['owner', 'admin', 'member'],
        has_more: false,
        next_cursor: null,
      }),
    ),
    http.delete(
      'http://api.test/api/v1/knowledge/bases/base-one',
      () => new HttpResponse(null, { status: 204 }),
    ),
  );
  const { user, router } = open('/knowledge-bases/base-one');
  await user.click(await screen.findByRole('button', { name: '删除知识库' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog).toHaveTextContent('不会自动重建');
  await user.click(within(dialog).getByRole('button', { name: '确认删除' }));
  await waitFor(() =>
    expect(router.state.location.pathname).toBe('/knowledge-bases'),
  );
});

test('refreshed attachment permissions remove delete controls and keep a downgraded editing draft', async () => {
  server.use(
    http.get(
      'http://api.test/api/v1/knowledge/documents/doc-one/attachments',
      () =>
        HttpResponse.json({
          data: [file],
          can_upload: true,
          can_delete: true,
          max_upload_bytes: 20971520,
          has_more: false,
          next_cursor: null,
        }),
    ),
  );
  const { user } = open('/documents/doc-one/edit');
  const input = await screen.findByLabelText('Markdown 正文');
  await user.clear(input);
  await user.type(input, '仍需保留的草稿');
  await screen.findByRole('button', { name: '删除附件 notes.txt' });
  server.use(
    http.get('http://api.test/api/v1/knowledge/documents/doc-one', () =>
      HttpResponse.json({ ...document, can_edit: false }),
    ),
    http.get(
      'http://api.test/api/v1/knowledge/documents/doc-one/attachments',
      () =>
        HttpResponse.json({
          data: [file],
          can_upload: false,
          can_delete: false,
          max_upload_bytes: 20971520,
          has_more: false,
          next_cursor: null,
        }),
    ),
  );
  await user.click(screen.getByRole('button', { name: '重新查询附件' }));
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: '删除附件 notes.txt' }),
    ).not.toBeInTheDocument(),
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '保存文档' })).toBeDisabled(),
  );
  expect(screen.getByLabelText('Markdown 正文')).toHaveValue('仍需保留的草稿');
});

test('storage being disabled does not remove the authorized logical delete action', async () => {
  server.use(
    http.get(
      'http://api.test/api/v1/knowledge/documents/doc-one/attachments',
      () =>
        HttpResponse.json({
          data: [file],
          can_upload: false,
          can_delete: true,
          max_upload_bytes: 0,
          has_more: false,
          next_cursor: null,
        }),
    ),
  );
  const { user } = open();
  expect(
    await screen.findByRole('button', { name: '删除附件 notes.txt' }),
  ).toBeEnabled();
  expect(screen.getByLabelText('选择附件')).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '重新查询附件' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: '删除附件 notes.txt' }),
    ).toBeEnabled(),
  );
});
