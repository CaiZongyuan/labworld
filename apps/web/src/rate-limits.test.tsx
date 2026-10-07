import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { createApiClient, type CurrentSession } from '@labos-threejs/sdk';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, test, vi } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { createAppRouter } from './router';
import { app } from './app';
const identity = {
  user: {
    id: 'rate-user',
    email: 'rate@example.com',
    display_name: null,
    role: 'member',
  },
  csrf_token: 'csrf-proof',
} satisfies CurrentSession;
function open(path: string) {
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
test.each([
  ['/login', '登录', 'login', 200],
  ['/register', '创建账号', 'register', 201],
] as const)(
  'the %s form waits for the server budget without automatically retrying',
  async (path, button, endpoint, status) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      let attempts = 0;
      server.use(
        http.post(`http://api.test/api/v1/auth/${endpoint}`, () => {
          attempts++;
          return attempts === 1
            ? HttpResponse.json(
                {
                  error: {
                    code: 'rate_limit.exceeded',
                    message: 'Wait',
                    request_id: 'limited-request',
                    details: { retry_after_seconds: '2' },
                  },
                },
                { status: 429, headers: { 'Retry-After': '2' } },
              )
            : HttpResponse.json(identity, { status });
        }),
        http.get('http://api.test/api/v1/auth/session', () =>
          HttpResponse.json(identity),
        ),
      );
      const { user, router } = open(path);
      await user.type(await screen.findByLabelText('邮箱'), 'rate@example.com');
      await user.type(screen.getByLabelText('密码'), 'a-long-test-password');
      await user.click(screen.getByRole('button', { name: button }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        '请求过于频繁',
      );
      expect(screen.getByRole('button', { name: /请等待/ })).toBeDisabled();
      expect(screen.getByLabelText('邮箱')).toHaveValue('rate@example.com');
      expect(attempts).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });
      expect(screen.getByRole('button', { name: button })).toBeEnabled();
      expect(attempts).toBe(1);
      await user.click(screen.getByRole('button', { name: button }));
      // Success lands on the assembled app's business default entry; the
      // assertion reads the assembly so every source combination passes.
      await waitFor(() =>
        expect(router.state.location.pathname).toBe(app.defaultEntry),
      );
      expect(screen.queryByLabelText('密码')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  },
);

test('resource failures show the server wait hint without automatic retries', async () => {
  let attempts = 0;
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json(identity),
    ),
    http.get('http://api.test/api/v1/lab/assets', () => {
      attempts++;
      return HttpResponse.json(
        {
          error: {
            code: 'rate_limit.exceeded',
            message: 'Wait',
            request_id: 'resource-limited',
            details: { retry_after_seconds: '3' },
          },
        },
        { status: 429, headers: { 'Retry-After': '3' } },
      );
    }),
  );
  open('/assets');
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '请求过于频繁，请 3 秒后重试',
  );
  expect(attempts).toBe(1);
});
