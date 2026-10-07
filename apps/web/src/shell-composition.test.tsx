import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { createApiClient, type CurrentSession } from '@labos-threejs/sdk';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { app } from './app';
import { createAppRouter } from './router';

// Shell composition (UI-R4, docs/ui/design.md §4): the shell mounts once
// on the router's layout route — page components render content only —
// so navigation between shell routes never remounts the sidebar, and the
// permission-gated navigation (assembled business groups for signed-in
// users, none signed out) is identical on every shell route. Auth pages
// stay outside the shell.

const signedIn = {
  user: {
    id: 'composition-user',
    email: 'composition@example.com',
    display_name: '组合用户',
    role: 'member',
  },
  csrf_token: 'composition-csrf',
} satisfies CurrentSession;

function open(path = '/', session: 'anonymous' | CurrentSession = 'anonymous') {
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      session === 'anonymous'
        ? HttpResponse.json(null, { status: 401 })
        : HttpResponse.json(session),
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
  return { user: userEvent.setup() };
}

// Derived, not named: the example-removal CI builds copies with examples
// stripped, so the business-group assertions follow whatever this copy
// assembles instead of naming the knowledge example's entry.
const businessPaths = app.navigation.flatMap((group) =>
  group.items.map((item) => item.path),
);

test('the shell mounts once: navigating between shell routes keeps the sidebar node', async () => {
  const { user } = open('/', signedIn);
  expect(await screen.findByText('composition@example.com')).toBeVisible();
  const sidebar = document.getElementById('app-sidebar');
  expect(sidebar).not.toBeNull();
  await user.click(screen.getByRole('link', { name: '设置' }));
  expect(await screen.findByRole('heading', { name: '设置' })).toBeVisible();
  // The exact DOM node survives the navigation: the page swapped under a
  // persistent shell instead of mounting a second one.
  expect(document.getElementById('app-sidebar')).toBe(sidebar);
});

test('signed in, assembled business groups appear on every shell route', async () => {
  open('/settings', signedIn);
  expect(await screen.findByRole('heading', { name: '设置' })).toBeVisible();
  const navigation = screen.getByRole('navigation', { name: '主菜单' });
  // The groups mount with the resolved session on the shared shell.
  await waitFor(() => {
    const hrefs = within(navigation)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'));
    for (const path of businessPaths) expect(hrefs).toContain(path);
  });
});

test('signed out, no assembled business groups render on any shell route', async () => {
  open('/settings');
  expect(await screen.findByRole('heading', { name: '设置' })).toBeVisible();
  const navigation = screen.getByRole('navigation', { name: '主菜单' });
  const hrefs = within(navigation)
    .getAllByRole('link')
    .map((link) => link.getAttribute('href'));
  for (const path of businessPaths) expect(hrefs).not.toContain(path);
});

test('removed modules leave no navigation entry for a signed-in owner', async () => {
  open('/settings', { ...signedIn, user: { ...signedIn.user, role: 'owner' } });
  await screen.findByRole('heading', { name: '设置' });
  const navigation = screen.getByRole('navigation', { name: '主菜单' });
  await within(navigation).findByRole('link', { name: '企业成员' });
  const paths = within(navigation)
    .getAllByRole('link')
    .map((link) => link.getAttribute('href'));
  for (const path of [
    '/notifications',
    '/jobs',
    '/documents',
    '/knowledge-bases',
  ])
    expect(paths).not.toContain(path);
});

test('a removed module bookmark displays the unavailable page and permits recovery', async () => {
  const { user } = open('/notifications', signedIn);
  expect(
    await screen.findByRole('heading', { name: '相关功能当前不可用' }),
  ).toBeVisible();
  await user.click(screen.getByRole('button', { name: '返回首页' }));
  expect(await screen.findByText('你好，组合用户')).toBeVisible();
});

test('auth pages stay outside the shell', async () => {
  open('/login');
  expect(await screen.findByRole('button', { name: '登录' })).toBeVisible();
  expect(screen.queryByRole('navigation', { name: '主菜单' })).toBeNull();
  expect(document.getElementById('app-sidebar')).toBeNull();
  expect(screen.queryByRole('link', { name: '忘记密码？' })).toBeNull();
});
