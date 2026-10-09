import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { createApiClient, type CurrentSession } from '@labos-threejs/sdk';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { createAppRouter } from './router';
import { assembledApp } from './app-examples';

const session = {
  user: {
    id: 'user-1',
    email: 'learner@example.com',
    display_name: '学习者',
    role: 'member',
  },
  csrf_token: 'csrf-test',
} satisfies CurrentSession;

function registrationPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const router = createAppRouter(
    {
      apiClient: createApiClient('http://api.test'),
      docsUrl: 'https://docs.test',
    },
    createMemoryHistory({ initialEntries: ['/register'] }),
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, user: userEvent.setup() };
}

test('registers with the generated contract and navigates to the default entry', async () => {
  server.use(
    http.post('http://api.test/api/v1/auth/register', async ({ request }) => {
      expect(await request.json()).toEqual({
        email: 'learner@example.com',
        password: 'a-long-test-password',
        display_name: '学习者',
      });
      return HttpResponse.json(session, { status: 201 });
    }),
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json(session),
    ),
  );
  const { router, user } = registrationPage();
  await user.type(await screen.findByLabelText('邮箱'), 'learner@example.com');
  await user.type(screen.getByLabelText('密码'), 'a-long-test-password');
  await user.type(screen.getByLabelText('显示名（可选）'), '学习者');
  await user.click(screen.getByRole('button', { name: '创建账号' }));
  // Registration selects the assembled app's business default entry
  // (design.md §5), not the Core home; the assertion reads the assembly so
  // every source combination passes.
  await waitFor(() =>
    expect(router.state.location.pathname).toBe(assembledApp.defaultEntry),
  );
  expect(screen.queryByLabelText('密码')).toBeNull();
});

test('shows pending and correlated errors, retains input and allows retry', async () => {
  let release!: (value: Response) => void;
  const response = new Promise<Response>((resolve) => {
    release = resolve;
  });
  server.use(http.post('http://api.test/api/v1/auth/register', () => response));
  const { router, user } = registrationPage();
  await user.type(await screen.findByLabelText('邮箱'), 'existing@example.com');
  await user.type(screen.getByLabelText('密码'), 'a-long-test-password');
  await user.click(screen.getByRole('button', { name: '创建账号' }));
  expect(screen.getByRole('button', { name: '正在创建账号…' })).toBeDisabled();
  release(
    HttpResponse.json(
      {
        error: {
          code: 'auth.email_exists',
          message: 'Email exists',
          details: {},
          request_id: 'registration-conflict',
        },
      },
      { status: 409 },
    ),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('这个邮箱已注册');
  expect(screen.getByRole('alert')).toHaveTextContent('registration-conflict');
  expect(screen.getByLabelText('邮箱')).toHaveValue('existing@example.com');
  expect(screen.getByRole('button', { name: '创建账号' })).toBeEnabled();
  expect(router.state.location.pathname).toBe('/register');
});

test('empty and malformed email input prevents submitting the registration form', async () => {
  const { user } = registrationPage();
  await screen.findByLabelText('邮箱');
  await user.click(screen.getByRole('button', { name: '创建账号' }));
  expect(screen.getByLabelText('邮箱')).toBeInvalid();
  await user.type(screen.getByLabelText('邮箱'), 'not-an-email');
  expect(screen.getByLabelText('邮箱')).toBeInvalid();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
