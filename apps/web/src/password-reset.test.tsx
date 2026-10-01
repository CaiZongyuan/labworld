import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { createApiClient } from '@labos-threejs/sdk';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { createAppRouter } from './router';
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
test('the forgot-password page gives neutral delivery feedback and allows explicit recovery from failure', async () => {
  let fail = true;
  server.use(
    http.post(
      'http://api.test/api/v1/auth/password-reset',
      async ({ request }) => {
        expect(await request.json()).toEqual({
          email: 'learner@example.com',
          locale: 'zh',
        });
        return fail
          ? HttpResponse.json(
              {
                error: {
                  code: 'auth.reset_unavailable',
                  message: 'Unavailable',
                  request_id: 'reset-request',
                  details: {},
                },
              },
              { status: 503 },
            )
          : HttpResponse.json({ status: 'accepted' }, { status: 202 });
      },
    ),
  );
  const { user } = open('/forgot-password');
  await user.type(await screen.findByLabelText('邮箱'), 'learner@example.com');
  await user.click(screen.getByRole('button', { name: '发送重置邮件' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('reset-request');
  expect(screen.getByLabelText('邮箱')).toHaveValue('learner@example.com');
  fail = false;
  await user.click(screen.getByRole('button', { name: '发送重置邮件' }));
  expect(
    await screen.findByText(
      '如果该账号可用，你会收到重置邮件。请检查收件箱或垃圾邮件。',
    ),
  ).toBeVisible();
});

test('a fragment link is removed from the URL, validates confirmation and permits login after consumption', async () => {
  const token = 'a'.repeat(64);
  let submissions = 0;
  server.use(
    http.post(
      'http://api.test/api/v1/auth/password-reset/complete',
      async ({ request }) => {
        submissions++;
        expect(await request.json()).toEqual({
          token,
          password: 'a-new-test-password',
        });
        return new HttpResponse(null, { status: 204 });
      },
    ),
  );
  const { user, router } = open(`/reset-password#token=${token}`);
  await user.type(
    await screen.findByLabelText('新密码'),
    'a-new-test-password',
  );
  await waitFor(() => expect(router.state.location.hash).toBe(''));
  await user.type(
    screen.getByLabelText('确认新密码'),
    'different-test-password',
  );
  await user.click(screen.getByRole('button', { name: '设置新密码' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '两次输入的密码不一致',
  );
  expect(submissions).toBe(0);
  await user.clear(screen.getByLabelText('确认新密码'));
  await user.type(screen.getByLabelText('确认新密码'), 'a-new-test-password');
  await user.click(screen.getByRole('button', { name: '设置新密码' }));
  expect(await screen.findByText('密码已重置，请重新登录。')).toBeVisible();
  expect(submissions).toBe(1);
  expect(screen.queryByLabelText('新密码')).not.toBeInTheDocument();
  expect(router.state.location.href).not.toContain(token);
  await user.click(screen.getByRole('button', { name: '返回登录' }));
  expect(
    await screen.findByRole('heading', { name: '登录企业空间' }),
  ).toBeVisible();
});

test('an expired or used link shows recovery while preserving the entered password', async () => {
  server.use(
    http.post('http://api.test/api/v1/auth/password-reset/complete', () =>
      HttpResponse.json(
        {
          error: {
            code: 'auth.reset_invalid',
            message: 'Invalid reset',
            request_id: 'expired-reset',
            details: {},
          },
        },
        { status: 401 },
      ),
    ),
  );
  const { user } = open(`/reset-password#token=${'b'.repeat(64)}`);
  await user.type(
    await screen.findByLabelText('新密码'),
    'a-new-test-password',
  );
  await user.type(screen.getByLabelText('确认新密码'), 'a-new-test-password');
  await user.click(screen.getByRole('button', { name: '设置新密码' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '重置链接无效或已失效，请重新申请。',
  );
  expect(screen.getByLabelText('新密码')).toHaveValue('a-new-test-password');
  await user.click(screen.getByRole('button', { name: '重新申请链接' }));
  expect(
    await screen.findByRole('heading', { name: '找回密码' }),
  ).toBeVisible();
});

test.each(['/reset-password', '/reset-password#token=malformed'])(
  'an incomplete link gives an explicit recovery action (%s)',
  async (path) => {
    const { router } = open(path);
    expect(await screen.findByText('重置链接不完整')).toBeVisible();
    expect(screen.queryByLabelText('新密码')).not.toBeInTheDocument();
    await waitFor(() => expect(router.state.location.hash).toBe(''));
  },
);

test('opening a fresh fragment in the same reset page replaces a consumed link and clears previous success', async () => {
  const first = 'c'.repeat(64);
  const next = 'd'.repeat(64);
  const submitted: string[] = [];
  server.use(
    http.post(
      'http://api.test/api/v1/auth/password-reset/complete',
      async ({ request }) => {
        const input = (await request.json()) as { token: string };
        submitted.push(input.token);
        return new HttpResponse(null, { status: 204 });
      },
    ),
  );
  const { user, router } = open(`/reset-password#token=${first}`);
  for (const token of [first, next]) {
    if (token === next) {
      await act(async () => {
        await router.navigate({ to: '/reset-password', hash: `token=${next}` });
      });
    }
    await user.type(
      await screen.findByLabelText('新密码'),
      'a-new-test-password',
    );
    await user.type(screen.getByLabelText('确认新密码'), 'a-new-test-password');
    await user.click(screen.getByRole('button', { name: '设置新密码' }));
    expect(await screen.findByText('密码已重置，请重新登录。')).toBeVisible();
    await waitFor(() => expect(router.state.location.hash).toBe(''));
  }
  expect(submitted).toEqual([first, next]);
});

test('the mail link language hint opens that language for this flow only', async () => {
  const token = 'e'.repeat(64);
  const { user } = open(`/reset-password#token=${token}&lang=en`);
  // The flow renders in the email's language while the saved preference
  // stays untouched (docs/ui/design.md §6 Q8).
  await screen.findByLabelText('New password');
  expect(document.documentElement.lang).toBe('en');
  expect(window.localStorage.getItem('labos-threejs.locale')).toBe('zh');
  // A language the user picks themselves follows normal preference rules.
  await user.click(screen.getByRole('button', { name: '简体中文' }));
  expect(await screen.findByLabelText('新密码')).toBeVisible();
  expect(document.documentElement.lang).toBe('zh-CN');
  expect(window.localStorage.getItem('labos-threejs.locale')).toBe('zh');
  // Leaving the flow hands the document back to the base preference.
  await user.click(screen.getByRole('button', { name: '返回登录' }));
  expect(
    await screen.findByRole('heading', { name: '登录企业空间' }),
  ).toBeVisible();
  expect(document.documentElement.lang).toBe('zh-CN');
});

test('a language the user picks inside the flow persists as the device choice', async () => {
  const token = 'f'.repeat(64);
  const { user } = open(`/reset-password#token=${token}&lang=en`);
  await screen.findByLabelText('New password');
  await user.click(screen.getByRole('button', { name: 'English' }));
  expect(window.localStorage.getItem('labos-threejs.locale')).toBe('en');
  expect(screen.getByLabelText('New password')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Back to sign-in' }));
  expect(
    await screen.findByRole('heading', { name: 'Sign in to your workspace' }),
  ).toBeVisible();
  expect(document.documentElement.lang).toBe('en');
});

test('a fresh mail link re-applies its language after the user switched inside the flow', async () => {
  const first = '1'.repeat(64);
  const next = '2'.repeat(64);
  const { user, router } = open(`/reset-password#token=${first}&lang=en`);
  await screen.findByLabelText('New password');
  await user.click(screen.getByRole('button', { name: '简体中文' }));
  expect(await screen.findByLabelText('新密码')).toBeVisible();
  await act(async () => {
    await router.navigate({
      to: '/reset-password',
      hash: `token=${next}&lang=en`,
    });
  });
  expect(await screen.findByLabelText('New password')).toBeVisible();
  expect(document.documentElement.lang).toBe('en');
  expect(window.localStorage.getItem('labos-threejs.locale')).toBe('zh');
});

test('an unknown language hint falls back to the device preference', async () => {
  open(`/reset-password#token=${'0'.repeat(64)}&lang=fr`);
  expect(await screen.findByLabelText('新密码')).toBeVisible();
  expect(document.documentElement.lang).toBe('zh-CN');
});
