import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { createApiClient, type CurrentSession } from '@labos-threejs/sdk';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { createAppRouter } from './router';
import { assembledApp } from './app-examples';

const signedIn = {
  user: {
    id: 'login-user',
    email: 'member@example.com',
    display_name: '成员甲',
    role: 'member',
  },
  csrf_token: 'session-csrf',
} satisfies CurrentSession;
const unauthorized = () =>
  HttpResponse.json(
    {
      error: {
        code: 'auth.unauthorized',
        message: 'Sign in',
        details: {},
        request_id: 'session-expired',
      },
    },
    { status: 401 },
  );

function page(path = '/login') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  queryClient.setQueryDefaults(['private-user-data'], { gcTime: Infinity });
  queryClient.setQueryData(['private-user-data'], {
    content: 'previous identity',
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
  return { user: userEvent.setup(), router, queryClient };
}

test('failed login keeps input; successful retry clears prior identity caches and navigates to the default entry', async () => {
  server.use(
    http.post('http://api.test/api/v1/auth/login', async ({ request }) => {
      const body = (await request.json()) as { password: string };
      return body.password === 'correct-long-password'
        ? HttpResponse.json(signedIn)
        : HttpResponse.json(
            {
              error: {
                code: 'auth.invalid_credentials',
                message: 'Incorrect credentials',
                details: {},
                request_id: 'wrong-login',
              },
            },
            { status: 401 },
          );
    }),
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json(signedIn),
    ),
  );
  const { user, router, queryClient } = page();
  await user.type(await screen.findByLabelText('邮箱'), 'member@example.com');
  expect(queryClient.getQueryData(['private-user-data'])).toBeDefined();
  await user.type(screen.getByLabelText('密码'), 'wrong-long-password');
  await user.click(screen.getByRole('button', { name: '登录' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '邮箱或密码不正确',
  );
  expect(screen.getByLabelText('邮箱')).toHaveValue('member@example.com');
  await user.clear(screen.getByLabelText('密码'));
  await user.type(screen.getByLabelText('密码'), 'correct-long-password');
  await user.click(screen.getByRole('button', { name: '登录' }));
  // Login selects the assembled app's business default entry (design.md
  // §5), not the Core home; the assertion reads the assembly so every
  // source combination passes.
  await waitFor(() =>
    expect(router.state.location.pathname).toBe(assembledApp.defaultEntry),
  );
  expect(screen.queryByLabelText('密码')).toBeNull();
  expect(queryClient.getQueryData(['private-user-data'])).toBeUndefined();
});

test('logout sends the current CSRF token, clears private queries and shows sign-in again', async () => {
  let authenticated = true;
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      authenticated ? HttpResponse.json(signedIn) : unauthorized(),
    ),
    http.post('http://api.test/api/v1/auth/logout', ({ request }) => {
      expect(request.headers.get('x-csrf-token')).toBe('session-csrf');
      authenticated = false;
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const { user, queryClient } = page('/');
  expect(
    await screen.findByRole('heading', { name: '你好，成员甲' }),
  ).toBeVisible();
  queryClient.setQueryData(['private-user-data'], { content: 'private to A' });
  expect(queryClient.getQueryData(['private-user-data'])).toBeDefined();
  await user.click(screen.getByRole('button', { name: '退出登录' }));
  expect(await screen.findByRole('link', { name: '登录' })).toHaveAttribute(
    'href',
    '/login',
  );
  expect(screen.queryByText('member@example.com')).not.toBeInTheDocument();
  expect(queryClient.getQueryData(['private-user-data'])).toBeUndefined();
});

test('an expired server session removes the signed-in identity and offers sign-in', async () => {
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json(signedIn),
    ),
  );
  const { queryClient } = page('/');
  expect(
    await screen.findByRole('heading', { name: '你好，成员甲' }),
  ).toBeVisible();
  queryClient.setQueryData(['private-user-data'], { content: 'private to A' });
  server.use(http.get('http://api.test/api/v1/auth/session', unauthorized));
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ['session'] });
  });
  expect(await screen.findByRole('link', { name: '登录' })).toBeVisible();
  expect(screen.queryByText('member@example.com')).not.toBeInTheDocument();
  expect(
    screen.getByText('当前没有有效会话，请登录或创建账号。'),
  ).toBeVisible();
  expect(queryClient.getQueryData(['private-user-data'])).toBeUndefined();
});

test('a session refresh after another tab switches accounts clears the former identity data', async () => {
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json(signedIn),
    ),
  );
  const { queryClient } = page('/');
  expect(
    await screen.findByRole('heading', { name: '你好，成员甲' }),
  ).toBeVisible();
  queryClient.setQueryData(['private-user-data'], { content: 'private to A' });
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json({
        ...signedIn,
        user: {
          ...signedIn.user,
          id: 'second-user',
          display_name: '成员乙',
          email: 'second@example.com',
        },
      }),
    ),
  );
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ['session'] });
  });
  expect(
    await screen.findByRole('heading', { name: '你好，成员乙' }),
  ).toBeVisible();
  expect(queryClient.getQueryData(['private-user-data'])).toBeUndefined();
  expect(screen.queryByText('member@example.com')).not.toBeInTheDocument();
});
