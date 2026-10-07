import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { createApiClient, type CurrentSession } from '@labos-threejs/sdk';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { createAppRouter } from './router';
import { app } from './app';

// Shell behavior that must hold in every source combination (zero, one or
// two examples). The tests read the assembled app instead of naming a
// specific example, so this one file gates all four combos in CI; the
// per-example journeys live in the example-owned suites.

const signedIn = {
  user: {
    id: 'shell-user',
    email: 'shell@example.com',
    display_name: '壳用户',
    role: 'member',
  },
  csrf_token: 'shell-csrf',
} satisfies CurrentSession;

function open(
  path = '/',
  role: CurrentSession['user']['role'] = signedIn.user.role,
  { signedOut = false }: { signedOut?: boolean } = {},
) {
  if (!signedOut)
    server.use(
      http.get('http://api.test/api/v1/auth/session', () =>
        HttpResponse.json({ ...signedIn, user: { ...signedIn.user, role } }),
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
  return { user: userEvent.setup(), router };
}

test('the Core home stays put; direct visits are never forced to a business entry', async () => {
  const { router } = open('/');
  await screen.findByRole('main');
  expect(router.state.location.pathname).toBe('/');
});

test('unknown paths render the unavailable page with a way home, without a loop', async () => {
  const { user, router } = open('/no-such-business-path');
  expect(
    await screen.findByRole('heading', { name: '相关功能当前不可用' }),
  ).toBeVisible();
  // The address stays put: it may be an old bookmark of a removed example,
  // and silently rewriting it would hide that from the user.
  expect(router.state.location.pathname).toBe('/no-such-business-path');
  await user.click(screen.getByRole('button', { name: '返回首页' }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  expect(await screen.findByRole('main')).toBeVisible();
});

test('the sidebar navigation mirrors the assembled groups and opens assembled routes', async () => {
  const { user, router } = open('/');
  await screen.findByRole('main');
  // Business groups arrive with the session; await the first entry rather
  // than racing the shell's signed-out first paint.
  if (app.navigation.length === 0) return;
  const first = app.navigation[0].items[0];
  const navigation = screen.getByRole('navigation', { name: '主菜单' });
  await within(navigation).findByRole('link', {
    name: app.messages.zh[first.labelKey],
  });
  // A group label may legitimately repeat as one of its item labels, so
  // presence is asserted with getAllBy*.
  for (const group of app.navigation)
    expect(
      within(navigation).getAllByText(app.messages.zh[group.labelKey]).length,
    ).toBeGreaterThan(0);
  await user.click(
    within(navigation).getAllByRole('link', {
      name: app.messages.zh[first.labelKey],
    })[0],
  );
  await waitFor(() => expect(router.state.location.pathname).toBe(first.path));
  expect(await screen.findByRole('main')).toBeVisible();
});

test('the sidebar holds the Core entries; a member sees no administration group', async () => {
  open('/');
  // Await the session-dependent greeting so the absence assertions below
  // describe the signed-in sidebar, not the pre-session first paint.
  expect(await screen.findByText('你好，壳用户')).toBeVisible();
  const navigation = screen.getByRole('navigation', { name: '主菜单' });
  for (const label of ['首页'])
    expect(within(navigation).getByRole('link', { name: label })).toBeVisible();
  expect(screen.getByRole('link', { name: '设置' })).toBeVisible();
  for (const label of ['设置', 'API Keys', '设计系统', '系统状态'])
    expect(within(navigation).queryByRole('link', { name: label })).toBeNull();
  expect(
    within(navigation).queryByRole('link', { name: '企业成员' }),
  ).toBeNull();
});

test('a signed-out visitor sees the public Core entries only', async () => {
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json(null, { status: 401 }),
    ),
  );
  open('/', signedIn.user.role, { signedOut: true });
  // The home card settles signed-out (a login entry appears) before the
  // absence assertions describe the final sidebar.
  await screen.findByRole('link', { name: '登录' });
  const navigation = screen.getByRole('navigation', { name: '主菜单' });
  for (const label of ['首页'])
    expect(within(navigation).getByRole('link', { name: label })).toBeVisible();
  expect(screen.getByRole('link', { name: '设置' })).toBeVisible();
  // Notification, API-key and design-system surfaces are authenticated
  // capabilities; the sidebar does not advertise them before sign-in.
  // Business groups are session-scoped too, so they stay out as well.
  expect(within(navigation).queryByRole('link', { name: '通知' })).toBeNull();
  expect(
    within(navigation).queryByRole('link', { name: 'API Keys' }),
  ).toBeNull();
  expect(
    within(navigation).queryByRole('link', { name: '设计系统' }),
  ).toBeNull();
  expect(
    within(navigation).queryByRole('link', { name: '我的文档' }),
  ).toBeNull();
});

test('the administration group appears for owners', async () => {
  const { user } = open('/', 'owner');
  // The group mounts once the session resolves with the owner role.
  const membersLink = await screen.findByRole('link', { name: '企业成员' });
  const navigation = membersLink.closest('nav');
  expect(navigation).not.toBeNull();
  for (const label of ['审计记录'])
    expect(
      within(navigation as HTMLElement).getByRole('link', { name: label }),
    ).toBeVisible();
  await user.click(screen.getByRole('link', { name: '设置' }));
  expect(await screen.findByRole('heading', { name: '设置' })).toBeVisible();
});

test('the narrow-screen drawer toggles with announced state and Escape dismisses it', async () => {
  // jsdom applies no stylesheet, so visibility is asserted through the
  // sidebar's own hidden class and the toggle's ARIA state.
  const { user } = open('/');
  await screen.findByRole('main');
  const toggle = screen.getByRole('button', { name: '打开导航菜单' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(toggle).toHaveAttribute('aria-controls', 'app-sidebar');
  expect(document.getElementById('app-sidebar')).toHaveClass('hidden');
  await user.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(document.getElementById('app-sidebar')).not.toHaveClass('hidden');
  await user.keyboard('{Escape}');
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(document.getElementById('app-sidebar')).toHaveClass('hidden');
});

// The Documentation link moved into the settings page's help section
// (UI-R3); its URL shape is asserted in settings.test.tsx.

test('the business default entry is directly reachable as a deep link', async () => {
  if (app.defaultEntry === '/') return; // Core-only combo: home test covers '/'
  const { router } = open(app.defaultEntry);
  expect(await screen.findByRole('main')).toBeVisible();
  expect(router.state.location.pathname).toBe(app.defaultEntry);
});

test('compact navigation retains every assembled entry and one account entry', async () => {
  const { user } = open('/');
  await screen.findByText('你好，壳用户');
  await user.click(screen.getByRole('button', { name: '收起导航' }));
  expect(document.getElementById('app-sidebar')).toHaveAttribute(
    'data-compact',
    'true',
  );
  const navigation = screen.getByRole('navigation', { name: '主菜单' });
  for (const group of app.navigation)
    for (const item of group.items)
      expect(
        within(navigation).getByRole('link', {
          name: app.messages.zh[item.labelKey],
        }),
      ).toHaveAttribute('title', app.messages.zh[item.labelKey]);
  expect(screen.getAllByRole('link', { name: '设置' })).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: '展开导航' }));
  expect(document.getElementById('app-sidebar')).not.toHaveAttribute(
    'data-compact',
  );
});
