import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import {
  createApiClient,
  type CurrentSession,
  type Document,
  type KnowledgeBase,
  type Member,
} from '@labos-threejs/sdk';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { createAppRouter } from './router';

// UI06: the knowledge workspace renders through the universal shell in
// both languages. Representative pages assert the localized fixed copy,
// dates and accessible names while user content stays in its original
// language; the narrow-screen journey drives the drawer instead of the
// persistent sidebar (jsdom applies no stylesheet, so state is asserted
// through ARIA and the sidebar's own hidden class).

const identity = {
  user: {
    id: 'member-one',
    email: 'writer@example.com',
    display_name: '写作者',
    role: 'member',
  },
  csrf_token: 'csrf-proof',
} satisfies CurrentSession;
const doc = {
  can_edit: true,
  id: '018f0000-0000-7000-8000-000000000001',
  knowledge_base_id: '018f0000-0000-7000-8000-000000000002',
  title: '团队手册',
  markdown: '# 欢迎\n第一篇正文',
  version: 1,
  created_by: identity.user.id,
  updated_by: identity.user.id,
  created_at: '2026-09-25T00:00:00Z',
  updated_at: '2026-09-25T00:00:00Z',
} satisfies Document;
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

function localeDateTime(locale: 'zh' | 'en', value: string) {
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function open(path: string, locale: 'zh' | 'en') {
  window.localStorage.setItem('labos-threejs.locale', locale);
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json(identity),
    ),
    http.get('http://api.test/api/v1/knowledge/documents', ({ request }) => {
      if (new URL(request.url).searchParams.get('knowledge_base_id'))
        return HttpResponse.json({
          data: [],
          next_cursor: null,
          has_more: false,
        });
      return HttpResponse.json({
        data: [doc],
        next_cursor: null,
        can_create: true,
        has_more: false,
      });
    }),
    http.get(`http://api.test/api/v1/knowledge/documents/${doc.id}`, () =>
      HttpResponse.json(doc),
    ),
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
    http.get('http://api.test/api/v1/knowledge/bases', () =>
      HttpResponse.json({
        data: [base],
        next_cursor: null,
        has_more: false,
      }),
    ),
    http.get('http://api.test/api/v1/knowledge/bases/library-one', () =>
      HttpResponse.json(base),
    ),
    http.get('http://api.test/api/v1/knowledge/bases/library-one/grants', () =>
      HttpResponse.json({
        data: [
          { user_id: member.user_id, email: member.email, access: 'reader' },
        ],
        next_cursor: null,
        has_more: false,
      }),
    ),
    http.get('http://api.test/api/v1/organization/members', () =>
      HttpResponse.json({
        data: [member],
        next_cursor: null,
        has_more: false,
        assignable_roles: ['owner', 'admin', 'member'],
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

test('the documents page renders the zh workspace with localized dates and names', async () => {
  open('/documents', 'zh');
  const navigation = await screen.findByRole('navigation', {
    name: '主菜单',
  });
  expect(
    await within(navigation).findByRole('link', { name: 'Lab' }),
  ).toBeVisible();
  for (const label of ['资产库', '首页'])
    expect(within(navigation).getByRole('link', { name: label })).toBeVisible();
  expect(
    await screen.findByRole('heading', { name: '我的文档' }),
  ).toBeVisible();
  expect(document.documentElement.lang).toBe('zh-CN');
  const item = (
    await screen.findByRole('button', { name: '团队手册' })
  ).closest('li');
  expect(item).toHaveTextContent(localeDateTime('zh', doc.updated_at));
  expect(screen.getByText('已显示 1 篇文档。')).toBeVisible();
  expect(screen.getByLabelText('标题关键词')).toBeVisible();
  expect(screen.getByRole('button', { name: '新建文档' })).toBeVisible();
});

test('the en workspace renders the documents page and reader with localized chrome around original content', async () => {
  const { user } = open('/documents', 'en');
  const navigation = await screen.findByRole('navigation', {
    name: 'Main menu',
  });
  expect(
    await within(navigation).findByRole('link', { name: 'Lab' }),
  ).toBeVisible();
  for (const label of ['Asset library', 'Home'])
    expect(within(navigation).getByRole('link', { name: label })).toBeVisible();
  expect(
    await screen.findByRole('heading', { name: 'My documents' }),
  ).toBeVisible();
  expect(document.documentElement.lang).toBe('en');
  const item = (
    await screen.findByRole('button', { name: '团队手册' })
  ).closest('li');
  expect(item).toHaveTextContent(localeDateTime('en', doc.updated_at));
  expect(screen.getByText('Documents shown: 1.')).toBeVisible();
  expect(screen.getByLabelText('Title keywords')).toBeVisible();

  await user.click(screen.getByRole('button', { name: '团队手册' }));
  // The reader's Markdown renderer is a lazy chunk; under a loaded machine
  // the dynamic import can outlast findByRole's default one-second window.
  expect(
    await screen.findByRole(
      'heading',
      { name: '欢迎', level: 1 },
      { timeout: 5000 },
    ),
  ).toBeVisible();
  expect(screen.getByText('第一篇正文')).toBeVisible();
  expect(
    await screen.findByRole('button', { name: 'Edit document' }),
  ).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Attachments' })).toBeVisible();
  expect(
    screen.getByRole('heading', { name: 'Export the document' }),
  ).toBeVisible();
  expect(screen.queryByLabelText('Title keywords')).toBeNull();
});

test('the en library page names grants, access and revocation in English', async () => {
  open('/knowledge-bases', 'en');
  expect(
    await screen.findByRole('heading', { name: 'Knowledge bases' }),
  ).toBeVisible();
  expect(
    await screen.findByRole('button', { name: '共享知识库' }),
  ).toBeVisible();
  expect(screen.getByText('Shared · Editable')).toBeVisible();

  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '共享知识库' }));
  expect(
    await screen.findByRole('heading', { name: '共享知识库' }),
  ).toBeVisible();
  const grants = await screen.findByRole('region', {
    name: 'Knowledge base access',
  });
  expect(within(grants).getByLabelText('Select member')).toBeVisible();
  expect(within(grants).getByLabelText('Access')).toBeVisible();
  expect(
    within(grants).getByRole('button', { name: 'Save grant' }),
  ).toBeDisabled();
  expect(
    within(grants).getByText('member@example.com · Read-only'),
  ).toBeVisible();
  expect(
    within(grants).getByRole('button', {
      name: 'Revoke member@example.com’s access',
    }),
  ).toBeVisible();
});

test('the zh library page keeps the grant contract bilingual-consistent', async () => {
  const user = userEvent.setup();
  open('/knowledge-bases', 'zh');
  await user.click(await screen.findByRole('button', { name: '共享知识库' }));
  const grants = await screen.findByRole('region', { name: '知识库授权' });
  expect(within(grants).getByLabelText('选择成员')).toBeVisible();
  expect(within(grants).getByLabelText('访问权限')).toBeVisible();
  expect(
    within(grants).getByRole('button', { name: '保存授权' }),
  ).toBeDisabled();
  expect(within(grants).getByText('member@example.com · 只读')).toBeVisible();
  expect(
    within(grants).getByRole('button', {
      name: '撤销 member@example.com 的授权',
    }),
  ).toBeVisible();
});

test('a narrow screen reaches the asset library through the drawer from a legacy document route', async () => {
  const { user, router } = open('/documents', 'zh');
  await screen.findByRole('main');
  const toggle = screen.getByRole('button', { name: '打开导航菜单' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(document.getElementById('app-sidebar')).toHaveClass('hidden');

  await user.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const drawer = document.getElementById('app-sidebar');
  expect(drawer).not.toHaveClass('hidden');
  await user.click(
    within(screen.getByRole('navigation', { name: '主菜单' })).getByRole(
      'link',
      { name: '资产库' },
    ),
  );
  expect(router.state.location.pathname).toBe('/assets');
  // The shell remounts with the route, so the state is re-read live.
  const resetToggle = screen.getByRole('button', { name: '打开导航菜单' });
  expect(resetToggle).toHaveAttribute('aria-expanded', 'false');
  expect(document.getElementById('app-sidebar')).toHaveClass('hidden');

  expect(
    await screen.findByRole('heading', { name: '资产库', level: 1 }),
  ).toBeVisible();
  expect(await screen.findByText('工业显微镜')).toBeVisible();
});

test('existing library URLs stay compatible as deep links', async () => {
  open(`/knowledge-bases/${base.id}`, 'zh');
  expect(
    await screen.findByRole('heading', { name: '共享知识库' }),
  ).toBeVisible();
  expect(
    await screen.findByRole('region', { name: '知识库授权' }),
  ).toBeVisible();
});
