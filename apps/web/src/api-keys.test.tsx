import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { createApiClient, type CurrentSession } from '@labos-threejs/sdk';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { createAppRouter } from './router';

// UI10 keeps the API-keys page as the settings-group entry it is in the
// shell, now inside the universal navigation with the bilingual catalog.
// The one-time secret contract is unchanged: the creation response lives
// only in page state, so hiding it, leaving, refreshing or switching the
// language can never bring it back — the list shows metadata only.

const identity = {
  user: {
    id: 'reader',
    email: 'reader@example.com',
    display_name: null,
    role: 'member',
  },
  csrf_token: 'csrf-proof',
} satisfies CurrentSession;
function open(locale: 'zh' | 'en' = 'zh') {
  window.localStorage.setItem('labos-threejs.locale', locale);
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
    createMemoryHistory({ initialEntries: ['/api-keys'] }),
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

const key = {
  id: 'key-one',
  user_id: 'reader',
  name: 'My script',
  prefix: 'labos_threejs_key_abcd1234',
  scopes: ['profile:read'],
  created_at: '2026-09-26T00:00:00Z',
  expires_at: '2026-10-26T00:00:00Z',
  revoked_at: null,
  last_used_at: null,
} satisfies import('@labos-threejs/sdk').KeyInfo;
const secret = 'test-only-one-time-key';
// Scope labels are server data registered by the assembled capabilities —
// the interface around them translates, the registered labels do not.
const profileScope = { id: 'profile:read', label: '读取自己的基本资料' };

test('creating a key reveals its secret once and refresh or leaving never reveals it again', async () => {
  let created = false;
  server.use(
    http.get('http://api.test/api/v1/api-keys/scopes', () =>
      HttpResponse.json({ data: [profileScope] }),
    ),
    http.get('http://api.test/api/v1/api-keys', () =>
      HttpResponse.json({
        data: created ? [key] : [],
        next_cursor: null,
        has_more: false,
      }),
    ),
    http.post('http://api.test/api/v1/api-keys', async ({ request }) => {
      expect(request.headers.get('x-csrf-token')).toBe('csrf-proof');
      expect(await request.json()).toEqual({
        name: 'My script',
        scopes: ['profile:read'],
        expires_in_days: 30,
      });
      created = true;
      return HttpResponse.json({ key, secret }, { status: 201 });
    }),
  );
  const user = open();
  const navigation = await screen.findByRole('navigation', {
    name: '主菜单',
  });
  expect(await screen.findByText('还没有 API Key')).toBeVisible();
  await user.type(screen.getByLabelText('名称'), 'My script');
  await user.click(screen.getByRole('switch', { name: profileScope.label }));
  await user.click(screen.getByRole('button', { name: '创建密钥' }));
  expect(await screen.findByLabelText('新密钥（只显示这一次）')).toHaveValue(
    secret,
  );
  await user.click(screen.getByRole('button', { name: '复制密钥' }));
  expect(await screen.findByText('已复制')).toBeVisible();
  expect(await navigator.clipboard.readText()).toBe(secret);
  await user.click(screen.getByRole('button', { name: '我已保存，隐藏密钥' }));
  expect(
    screen.queryByLabelText('新密钥（只显示这一次）'),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '刷新密钥' }));
  expect(await screen.findByText('labos_threejs_key_abcd1234')).toBeVisible();
  expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
  // The old entry stays compatible: the settings group still reaches the
  // page, and the sidebar carries the way back home.
  await user.click(within(navigation).getByRole('link', { name: '首页' }));
  expect(
    await screen.findByRole('heading', { name: '你好，reader@example.com' }),
  ).toBeVisible();
  // The shell remounts with the route; read the live sidebar, not the
  // api-keys page's detached one.
  const homeNavigation = await screen.findByRole('navigation', {
    name: '主菜单',
  });
  expect(
    within(homeNavigation).queryByRole('link', { name: 'API Keys' }),
  ).toBeNull();
  await user.click(screen.getByRole('link', { name: '设置' }));
  expect(
    await within(
      screen.getByRole('navigation', { name: '设置目录' }),
    ).findByRole('link', { name: 'API Keys' }),
  ).toBeVisible();
});

test('switching the language after the secret was hidden never reveals it again', async () => {
  let created = false;
  server.use(
    http.get('http://api.test/api/v1/api-keys/scopes', () =>
      HttpResponse.json({ data: [profileScope] }),
    ),
    http.get('http://api.test/api/v1/api-keys', () =>
      HttpResponse.json({
        data: created ? [key] : [],
        next_cursor: null,
        has_more: false,
      }),
    ),
    http.post('http://api.test/api/v1/api-keys', () => {
      created = true;
      return HttpResponse.json({ key, secret }, { status: 201 });
    }),
  );
  const user = open();
  await screen.findByRole('navigation', { name: '主菜单' });
  await user.type(await screen.findByLabelText('名称'), 'My script');
  await user.click(screen.getByRole('switch', { name: profileScope.label }));
  await user.click(screen.getByRole('button', { name: '创建密钥' }));
  expect(await screen.findByLabelText('新密钥（只显示这一次）')).toHaveValue(
    secret,
  );
  await user.click(screen.getByRole('button', { name: '我已保存，隐藏密钥' }));
  // Language and theme changes route through settings; returning must
  // rebuild the page from metadata only — no cached secret anywhere.
  await user.click(screen.getByRole('link', { name: '设置' }));
  await user.click(await screen.findByRole('radio', { name: 'English' }));
  await user.click(
    within(
      screen.getByRole('navigation', { name: 'Settings sections' }),
    ).getByRole('link', { name: 'API Keys' }),
  );
  expect(
    await screen.findByRole('heading', { name: 'API Keys', level: 1 }),
  ).toBeVisible();
  expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
  expect(screen.getByText('labos_threejs_key_abcd1234')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Create key' })).toBeVisible();
  expect(screen.getByLabelText('Name')).toBeVisible();
});

test('the workspace renders key management in English around registered scope labels', async () => {
  server.use(
    http.get('http://api.test/api/v1/api-keys/scopes', () =>
      HttpResponse.json({ data: [profileScope] }),
    ),
    http.get('http://api.test/api/v1/api-keys', () =>
      HttpResponse.json({
        data: [key],
        next_cursor: null,
        has_more: false,
      }),
    ),
    http.post('http://api.test/api/v1/api-keys', async ({ request }) => {
      expect(request.headers.get('x-csrf-token')).toBe('csrf-proof');
      expect(await request.json()).toEqual({
        name: 'My script',
        scopes: ['profile:read'],
        expires_in_days: 30,
      });
      return HttpResponse.json({ key, secret }, { status: 201 });
    }),
  );
  open('en');
  const navigation = await screen.findByRole('navigation', {
    name: 'Settings sections',
  });
  expect(
    await within(navigation).findByRole('link', { name: 'API Keys' }),
  ).toBeVisible();
  expect(
    await screen.findByRole('heading', { name: 'API Keys', level: 1 }),
  ).toBeVisible();
  expect(screen.getByLabelText('Name')).toBeVisible();
  expect(screen.getByLabelText('Validity')).toBeVisible();
  expect(screen.getByText('Allowed operations')).toBeVisible();
  expect(
    screen.getByRole('switch', { name: profileScope.label }),
  ).toBeVisible();

  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Name'), 'My script');
  await user.click(screen.getByRole('switch', { name: profileScope.label }));
  await user.click(screen.getByRole('button', { name: 'Create key' }));
  expect(await screen.findByLabelText('New key (shown only once)')).toHaveValue(
    secret,
  );
  await user.click(screen.getByRole('button', { name: 'Copy key' }));
  expect(await screen.findByText('Copied')).toBeVisible();
  await user.click(
    screen.getByRole('button', { name: 'I saved it — hide the key' }),
  );
  // The list renders dates in the interface language; the entry itself
  // keeps its metadata.
  expect(await screen.findByText('labos_threejs_key_abcd1234')).toBeVisible();
  expect(screen.getByText('Active')).toBeVisible();
  expect(
    screen.getByRole('button', { name: 'Revoke My script' }),
  ).toBeVisible();
});

test('a failed revocation can retry and a revoked key stays visible as metadata only', async () => {
  let fail = true;
  let revokedAt: string | null = null;
  server.use(
    http.get('http://api.test/api/v1/api-keys/scopes', () =>
      HttpResponse.json({ data: [profileScope] }),
    ),
    http.get('http://api.test/api/v1/api-keys', () =>
      HttpResponse.json({
        data: [{ ...key, revoked_at: revokedAt }],
        next_cursor: null,
        has_more: false,
      }),
    ),
    http.delete('http://api.test/api/v1/api-keys/key-one', ({ request }) => {
      expect(request.headers.get('x-csrf-token')).toBe('csrf-proof');
      if (fail)
        return HttpResponse.json(
          {
            error: {
              code: 'api_keys.unavailable',
              request_id: 'revoke-retry',
              message: 'Unavailable',
            },
          },
          { status: 503 },
        );
      revokedAt = '2026-09-26T01:00:00Z';
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const user = open();
  await user.click(
    await screen.findByRole('button', { name: '撤销 My script' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('revoke-retry');
  fail = false;
  await user.click(screen.getByRole('button', { name: '撤销 My script' }));
  expect(await screen.findByText('已撤销')).toBeVisible();
  expect(
    screen.queryByRole('button', { name: '撤销 My script' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText('新密钥（只显示这一次）'),
  ).not.toBeInTheDocument();
});

test('a failed creation keeps inputs and does not automatically issue another credential', async () => {
  let attempts = 0;
  server.use(
    http.get('http://api.test/api/v1/api-keys/scopes', () =>
      HttpResponse.json({ data: [profileScope] }),
    ),
    http.get('http://api.test/api/v1/api-keys', () =>
      HttpResponse.json({ data: [], next_cursor: null, has_more: false }),
    ),
    http.post('http://api.test/api/v1/api-keys', () => {
      attempts++;
      return HttpResponse.json(
        {
          error: {
            code: 'api_keys.unavailable',
            request_id: 'create-uncertain',
            message: 'Unavailable',
          },
        },
        { status: 503 },
      );
    }),
  );
  const user = open();
  await user.type(await screen.findByLabelText('名称'), 'Keep this name');
  await user.click(
    await screen.findByRole('switch', { name: profileScope.label }),
  );
  await user.click(screen.getByRole('button', { name: '创建密钥' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '请刷新列表确认是否已创建',
  );
  expect(screen.getByLabelText('名称')).toHaveValue('Keep this name');
  await user.click(screen.getByRole('button', { name: '刷新密钥' }));
  expect(await screen.findByText('还没有 API Key')).toBeVisible();
  expect(attempts).toBe(1);
  expect(
    screen.queryByLabelText('新密钥（只显示这一次）'),
  ).not.toBeInTheDocument();
});
