import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import {
  createApiClient,
  type CurrentSession,
  type KnowledgeBase,
  type Member,
} from '@labos-threejs/sdk';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { createAppRouter } from './router';

const identity = {
  user: {
    id: 'owner',
    email: 'owner@example.com',
    display_name: null,
    role: 'owner',
  },
  csrf_token: 'csrf-proof',
} satisfies CurrentSession;
const base = {
  id: 'library-one',
  name: '共享知识库',
  personal: false,
  can_edit: true,
  can_manage: true,
} satisfies KnowledgeBase;
const member = {
  user_id: 'member',
  email: 'member@example.com',
  display_name: null,
  role: 'member',
  active: true,
  version: 1,
  can_edit: true,
} satisfies Member;
function open(path: string) {
  server.use(
    http.get('http://api.test/api/v1/knowledge/documents/:id/exports', () =>
      HttpResponse.json({ data: [], next_cursor: null, has_more: false }),
    ),
    http.get('http://api.test/api/v1/knowledge/documents/:id/attachments', () =>
      HttpResponse.json({
        data: [],
        can_upload: true,
        can_delete: true,
        max_upload_bytes: 20971520,
        next_cursor: null,
        has_more: false,
      }),
    ),
  );
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json(identity),
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

test('a knowledge-base icon is a local preference and keeps its selected glyph and color', async () => {
  server.use(
    http.get('http://api.test/api/v1/knowledge/bases', () =>
      HttpResponse.json({
        data: [base],
        next_cursor: null,
        has_more: false,
        can_create: false,
      }),
    ),
  );
  const { user } = open('/knowledge-bases');
  await user.click(
    await screen.findByRole('button', { name: '更换共享知识库图标' }),
  );
  await user.click(screen.getByRole('radio', { name: '图标' }));
  await user.click(screen.getByRole('button', { name: '研究' }));
  await user.click(screen.getByRole('radio', { name: '蓝色' }));
  await user.click(screen.getByRole('button', { name: '使用此图案' }));
  await user.click(screen.getByRole('button', { name: '更换共享知识库图标' }));
  expect(screen.getByRole('radio', { name: '图标' })).toBeChecked();
  expect(screen.getByRole('button', { name: '研究' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.getByRole('radio', { name: '蓝色' })).toBeChecked();
});

test('an administrator grants a member Reader access and revokes it through the library page', async () => {
  let granted = false;
  server.use(
    http.get('http://api.test/api/v1/knowledge/bases/library-one', () =>
      HttpResponse.json(base),
    ),
    http.get('http://api.test/api/v1/knowledge/documents', ({ request }) => {
      expect(new URL(request.url).searchParams.get('knowledge_base_id')).toBe(
        base.id,
      );
      return HttpResponse.json({
        data: [],
        next_cursor: null,
        has_more: false,
      });
    }),
    http.get('http://api.test/api/v1/organization/members', () =>
      HttpResponse.json({
        data: [member],
        next_cursor: null,
        has_more: false,
        assignable_roles: ['owner', 'admin', 'member'],
      }),
    ),
    http.get('http://api.test/api/v1/knowledge/bases/library-one/grants', () =>
      HttpResponse.json({
        data: granted
          ? [{ user_id: member.user_id, email: member.email, access: 'reader' }]
          : [],
        next_cursor: null,
        has_more: false,
      }),
    ),
    http.put(
      'http://api.test/api/v1/knowledge/bases/library-one/grants/member',
      async ({ request }) => {
        expect(request.headers.get('x-csrf-token')).toBe(identity.csrf_token);
        expect(await request.json()).toEqual({ access: 'reader' });
        granted = true;
        return HttpResponse.json({ user_id: member.user_id, access: 'reader' });
      },
    ),
    http.delete(
      'http://api.test/api/v1/knowledge/bases/library-one/grants/member',
      () => {
        granted = false;
        return new HttpResponse(null, { status: 204 });
      },
    ),
  );
  const { user } = open('/knowledge-bases/library-one');
  await user.selectOptions(
    await screen.findByLabelText('选择成员'),
    member.user_id,
  );
  await user.click(screen.getByRole('button', { name: '保存授权' }));
  expect(await screen.findByText('member@example.com · 只读')).toBeVisible();
  await user.click(
    screen.getByRole('button', { name: '撤销 member@example.com 的授权' }),
  );
  expect(await screen.findByText('还没有额外授权')).toBeVisible();
});

test('a new shared library leads to a document saved in that library', async () => {
  let created = false;
  const document = {
    id: 'shared-document',
    knowledge_base_id: base.id,
    title: '共享文档',
    markdown: '共享正文',
    version: 1,
    can_edit: true,
    created_by: identity.user.id,
    updated_by: identity.user.id,
    created_at: '2026-09-26T00:00:00Z',
    updated_at: '2026-09-26T00:00:00Z',
  };
  server.use(
    http.get('http://api.test/api/v1/knowledge/bases', () =>
      HttpResponse.json({
        data: created ? [base] : [],
        can_create: true,
        next_cursor: null,
        has_more: false,
      }),
    ),
    http.post('http://api.test/api/v1/knowledge/bases', async ({ request }) => {
      expect(await request.json()).toEqual({ name: base.name });
      expect(request.headers.get('idempotency-key')).toBeTruthy();
      created = true;
      return HttpResponse.json(base, { status: 201 });
    }),
    http.get('http://api.test/api/v1/knowledge/bases/library-one', () =>
      HttpResponse.json(base),
    ),
    http.get('http://api.test/api/v1/knowledge/documents', () =>
      HttpResponse.json({ data: [], next_cursor: null, has_more: false }),
    ),
    http.get('http://api.test/api/v1/organization/members', () =>
      HttpResponse.json({
        data: [member],
        next_cursor: null,
        has_more: false,
        assignable_roles: ['owner', 'admin', 'member'],
      }),
    ),
    http.get('http://api.test/api/v1/knowledge/bases/library-one/grants', () =>
      HttpResponse.json({ data: [], next_cursor: null, has_more: false }),
    ),
    http.post(
      'http://api.test/api/v1/knowledge/documents',
      async ({ request }) => {
        expect(await request.json()).toEqual({
          title: document.title,
          markdown: document.markdown,
          knowledge_base_id: base.id,
        });
        return HttpResponse.json(document, { status: 201 });
      },
    ),
    http.get('http://api.test/api/v1/knowledge/documents/shared-document', () =>
      HttpResponse.json(document),
    ),
  );
  const { user, router } = open('/knowledge-bases');
  await user.type(await screen.findByLabelText('知识库名称'), base.name);
  await user.click(screen.getByRole('button', { name: '创建共享知识库' }));
  await screen.findByRole('heading', { name: base.name });
  await user.click(screen.getByRole('button', { name: '新建文档' }));
  await user.type(await screen.findByLabelText('标题'), document.title);
  await user.type(screen.getByLabelText('Markdown 正文'), document.markdown);
  await user.click(screen.getByRole('button', { name: '保存文档' }));
  expect(
    await screen.findByRole('heading', { name: document.title }),
  ).toBeVisible();
  expect(router.state.location.pathname).toBe('/documents/shared-document');
});

test('a Reader library hides creation and grant management using the server capabilities', async () => {
  server.use(
    http.get('http://api.test/api/v1/knowledge/bases/library-one', () =>
      HttpResponse.json({ ...base, can_edit: false, can_manage: false }),
    ),
    http.get('http://api.test/api/v1/knowledge/documents', () =>
      HttpResponse.json({ data: [], next_cursor: null, has_more: false }),
    ),
  );
  open('/knowledge-bases/library-one');
  expect(await screen.findByText('只读知识库')).toBeVisible();
  expect(
    screen.queryByRole('button', { name: '新建文档' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText('选择成员')).not.toBeInTheDocument();
});

test('a manager renames the library and sees the updated heading', async () => {
  let current = base;
  server.use(
    http.get('http://api.test/api/v1/knowledge/bases/library-one', () =>
      HttpResponse.json(current),
    ),
    http.put(
      'http://api.test/api/v1/knowledge/bases/library-one',
      async ({ request }) => {
        expect(await request.json()).toEqual({ name: '新库名' });
        current = { ...base, name: '新库名' };
        return HttpResponse.json(current);
      },
    ),
    http.get('http://api.test/api/v1/knowledge/documents', () =>
      HttpResponse.json({ data: [], next_cursor: null, has_more: false }),
    ),
    http.get('http://api.test/api/v1/organization/members', () =>
      HttpResponse.json({
        data: [member],
        next_cursor: null,
        has_more: false,
        assignable_roles: ['owner', 'admin', 'member'],
      }),
    ),
    http.get('http://api.test/api/v1/knowledge/bases/library-one/grants', () =>
      HttpResponse.json({ data: [], next_cursor: null, has_more: false }),
    ),
  );
  const { user } = open('/knowledge-bases/library-one');
  await user.clear(await screen.findByLabelText('知识库名称'));
  await user.type(screen.getByLabelText('知识库名称'), '新库名');
  await user.click(screen.getByRole('button', { name: '保存库名' }));
  expect(await screen.findByRole('heading', { name: '新库名' })).toBeVisible();
});
