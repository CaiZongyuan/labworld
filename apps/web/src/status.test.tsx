import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import {
  createApiClient,
  type ApiClient,
  type CurrentSession,
} from '@labos-threejs/sdk';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { createAppRouter } from './router';

// UI11 brings the public system-status landing into the universal shell.
// The page stays readable with the API down: the session is resolved
// opportunistically for the sidebar's role, and its failure never hides
// the status content. Interface text is bilingual; protocol values
// (service name, version, migration version) stay raw.

const readyStatus = {
  database: 'connected',
  schema_version: 1,
  service: 'labos-threejs-api',
  status: 'ok',
  version: '0.1.0',
} satisfies import('@labos-threejs/sdk').SystemStatus;
const identity = {
  user: {
    id: 'owner',
    email: 'owner@example.com',
    display_name: null,
    role: 'owner',
  },
  csrf_token: 'csrf-proof',
} satisfies CurrentSession;

function open(
  locale: 'zh' | 'en' = 'zh',
  currentIdentity: CurrentSession | null = null,
  apiClient: ApiClient = createApiClient('http://api.test'),
) {
  window.localStorage.setItem('labos-threejs.locale', locale);
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json(currentIdentity),
    ),
  );
  const router = createAppRouter(
    {
      apiClient,
      docsUrl: 'https://docs.test',
    },
    createMemoryHistory({ initialEntries: ['/system'] }),
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

test('a signed-out visitor reads the ready status inside the shell', async () => {
  server.use(
    http.get('http://api.test/api/v1/system/status', () =>
      HttpResponse.json(readyStatus),
    ),
  );
  open();
  const navigation = await screen.findByRole('navigation', {
    name: '主菜单',
  });
  expect(
    within(screen.getByRole('navigation', { name: '设置目录' })).getByRole(
      'link',
      { name: '系统状态' },
    ),
  ).toBeVisible();
  expect(within(navigation).getByRole('link', { name: '首页' })).toBeVisible();
  expect(screen.getByRole('link', { name: '设置' })).toBeVisible();
  expect(
    within(navigation).queryByRole('link', { name: '通知' }),
  ).not.toBeInTheDocument();
  expect(
    await screen.findByRole('heading', { name: '服务已就绪', level: 2 }),
  ).toBeVisible();
  expect(
    screen.getByRole('heading', { name: '系统状态', level: 1 }),
  ).toBeVisible();
  expect(screen.getByText('PostgreSQL 已连接')).toBeVisible();
  expect(screen.getByText('迁移版本 1')).toBeVisible();
  expect(screen.getByText('版本 0.1.0')).toBeVisible();
  expect(screen.getByRole('link', { name: '阅读入门教程' })).toHaveAttribute(
    'href',
    'https://docs.test',
  );
  expect(screen.getByRole('button', { name: '重新检查' })).toBeVisible();
  // Core copy stays example-neutral: no knowledge-base naming in Core.
  expect(screen.queryByText(/知识库/)).not.toBeInTheDocument();
  expect(screen.getByText('03 / 扩展')).toBeVisible();
});

test('a failing service shows a correlated alert and recovers on explicit recheck', async () => {
  server.use(
    http.get('http://api.test/api/v1/system/status', () =>
      HttpResponse.json(
        {
          error: {
            code: 'database.unavailable',
            details: {},
            message: 'Database is not ready',
            request_id: 'req-503-test',
          },
        },
        { status: 503 },
      ),
    ),
  );
  const user = open();
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '暂时无法连接服务',
  );
  expect(screen.getByText(/req-503-test/)).toBeVisible();
  server.use(
    http.get('http://api.test/api/v1/system/status', () =>
      HttpResponse.json(readyStatus),
    ),
  );
  await user.click(screen.getByRole('button', { name: '重新检查' }));
  expect(
    await screen.findByRole('heading', { name: '服务已就绪' }),
  ).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('a non-responding service reaches an error state and enables retry', async () => {
  server.use(
    http.get(
      'http://api.test/api/v1/system/status',
      () => new Promise<Response>(() => {}),
    ),
  );
  open('zh', null, createApiClient('http://api.test', { timeoutMs: 30 }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '暂时无法连接服务',
  );
  expect(screen.getByRole('button', { name: '重新检查' })).toBeEnabled();
});

test('the workspace reports status in English with the raw protocol values', async () => {
  server.use(
    http.get('http://api.test/api/v1/system/status', () =>
      HttpResponse.json(readyStatus),
    ),
  );
  open('en');
  await screen.findByRole('navigation', { name: 'Main menu' });
  expect(
    within(
      screen.getByRole('navigation', { name: 'Settings sections' }),
    ).getByRole('link', { name: 'System status' }),
  ).toBeVisible();
  expect(
    await screen.findByRole('heading', { name: 'Service is ready', level: 2 }),
  ).toBeVisible();
  expect(screen.getByText('PostgreSQL connected')).toBeVisible();
  expect(screen.getByText('Migration version 1')).toBeVisible();
  expect(screen.getByText('Version 0.1.0')).toBeVisible();
  expect(
    screen.getByRole('link', { name: 'Read the getting-started tutorial' }),
  ).toHaveAttribute('href', 'https://docs.test');
  expect(screen.getByRole('button', { name: 'Recheck' })).toBeVisible();
  expect(screen.getByText('01 / Run')).toBeVisible();
  expect(screen.getByText('labos-threejs-api')).toBeVisible();
});

test('a signed-in administrator keeps the administration group on the status page', async () => {
  server.use(
    http.get('http://api.test/api/v1/system/status', () =>
      HttpResponse.json(readyStatus),
    ),
  );
  open('zh', identity);
  const navigation = await screen.findByRole('navigation', {
    name: '主菜单',
  });
  expect(
    await within(navigation).findByRole('link', { name: '后台任务' }),
  ).toBeVisible();
  expect(
    await screen.findByRole('heading', { name: '服务已就绪', level: 2 }),
  ).toBeVisible();
});
