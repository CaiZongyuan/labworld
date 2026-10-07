import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { createApiClient, type CurrentSession } from '@labos-threejs/sdk';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { createAppRouter } from './router';

// UI11 moves the audit trail into the universal shell with the Core
// catalog. Filter conditions live in the URL, so switching the language
// or theme cannot clear a legitimate query; audit actions, resource and
// request identifiers stay raw protocol values while every fixed label,
// state and accessibility name is bilingual.

const identity = {
  user: {
    id: 'reader',
    email: 'reader@example.com',
    display_name: null,
    role: 'owner',
  },
  csrf_token: 'csrf-proof',
} satisfies CurrentSession;
function open(
  role: CurrentSession['user']['role'] = 'owner',
  locale: 'zh' | 'en' = 'zh',
  path = '/audit',
) {
  window.localStorage.setItem('labos-threejs.locale', locale);
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json({ ...identity, user: { ...identity.user, role } }),
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
  return userEvent.setup();
}

test('members cannot see the audit list while administrators can recover an empty search', async () => {
  let fail = false;
  server.use(
    http.get('http://api.test/api/v1/audit-events', () =>
      fail
        ? HttpResponse.json(
            {
              error: {
                code: 'audit.unavailable',
                request_id: 'audit-retry',
                message: 'Unavailable',
              },
            },
            { status: 503 },
          )
        : HttpResponse.json({ data: [], next_cursor: null, has_more: false }),
    ),
  );
  const user = open();
  expect(
    await screen.findByRole('heading', { name: '审计记录', level: 1 }),
  ).toBeVisible();
  expect(await screen.findByText('没有匹配的审计记录')).toBeVisible();
  fail = true;
  await user.click(screen.getByRole('button', { name: '刷新审计' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('audit-retry');
  fail = false;
  await user.click(screen.getByRole('button', { name: '刷新审计' }));
  expect(await screen.findByText('没有匹配的审计记录')).toBeVisible();
});

test('a normal member sees a clear permission message and no administration entry', async () => {
  open('member');
  const navigation = await screen.findByRole('navigation', {
    name: '主菜单',
  });
  expect(
    await screen.findByText('仅企业所有者或管理员可以查看审计记录。'),
  ).toBeVisible();
  expect(
    within(navigation).queryByRole('link', { name: '审计记录' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: '筛选记录' }),
  ).not.toBeInTheDocument();
});

const event = {
  id: 'audit-one',
  action: 'lab.lab.create',
  actor_type: 'user',
  actor_id: 'owner',
  resource_type: 'lab.lab',
  resource_id: 'doc-one',
  request_id: 'request-one',
  correlation_id: 'request-one',
  trace_id: null,
  job_id: null,
  metadata: {},
  created_at: '2026-09-26T00:00:00Z',
} satisfies import('@labos-threejs/sdk').AuditEvent;

test('an administrator filters actual fields, pages history and loses visible rows after denial', async () => {
  let forbidden = false;
  server.use(
    http.get('http://api.test/api/v1/audit-events', ({ request }) => {
      if (forbidden)
        return HttpResponse.json(
          {
            error: {
              code: 'audit.forbidden',
              message: 'Forbidden',
              request_id: 'denied',
            },
          },
          { status: 403 },
        );
      const url = new URL(request.url);
      if (url.searchParams.has('resource_id')) {
        expect(url.searchParams.get('resource_id')).toBe('doc-one');
        expect(url.searchParams.get('action')).toBe('lab.lab.create');
        return HttpResponse.json({
          data: [event],
          next_cursor: null,
          has_more: false,
        });
      }
      const more = url.searchParams.get('cursor') === 'next-audit-page';
      return HttpResponse.json({
        data: [
          {
            ...event,
            id: more ? 'earlier' : 'later',
            action: more ? 'identity.register' : 'organization.member.update',
            resource_id: 'user-one',
          },
        ],
        next_cursor: more ? null : 'next-audit-page',
        has_more: !more,
      });
    }),
  );
  const user = open();
  const navigation = await screen.findByRole('navigation', {
    name: '主菜单',
  });
  expect(
    await within(navigation).findByRole('link', { name: '审计记录' }),
  ).toBeVisible();
  expect(await screen.findByText('organization.member.update')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '加载更多审计' }));
  expect(await screen.findByText('identity.register')).toBeVisible();
  await user.type(screen.getByLabelText('资源 ID'), 'doc-one');
  await user.type(screen.getByLabelText('动作'), 'lab.lab.create');
  await user.click(screen.getByRole('button', { name: '筛选记录' }));
  expect(await screen.findByText('lab.lab.create')).toBeVisible();
  expect(screen.queryByText('identity.register')).not.toBeInTheDocument();
  expect(screen.getByText('doc-one')).toBeVisible();
  expect(screen.getAllByText('request-one').length).toBeGreaterThan(0);
  forbidden = true;
  await user.click(screen.getByRole('button', { name: '刷新审计' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('当前权限已失效');
  expect(screen.queryByText('lab.lab.create')).not.toBeInTheDocument();
});

test('the audit filter survives a language switch and speaks English afterwards', async () => {
  server.use(
    http.get('http://api.test/api/v1/audit-events', ({ request }) => {
      const url = new URL(request.url);
      if (url.searchParams.get('resource_id') === 'doc-one')
        return HttpResponse.json({
          data: [event],
          next_cursor: null,
          has_more: false,
        });
      return HttpResponse.json({
        data: [{ ...event, id: 'latest', resource_id: 'user-one' }],
        next_cursor: null,
        has_more: false,
      });
    }),
  );
  const user = open();
  await user.type(await screen.findByLabelText('资源 ID'), 'doc-one');
  await user.click(screen.getByRole('button', { name: '筛选记录' }));
  expect(await screen.findByText('lab.lab.create')).toBeVisible();
  await user.click(await screen.findByRole('navigation', { name: '主菜单' }));
  await user.click(screen.getByRole('link', { name: '设置' }));
  const settingsDirectory = screen.getByRole('navigation', {
    name: '设置目录',
  });
  await user.click(
    await within(settingsDirectory).findByRole('link', { name: '个人资料' }),
  );
  await screen.findByRole('heading', { name: '个人资料', level: 1 });
  await user.click(
    within(settingsDirectory).getByRole('link', { name: '外观与语言' }),
  );
  await user.click(await screen.findByRole('radio', { name: 'English' }));
  await user.click(
    within(screen.getByRole('navigation', { name: 'Main menu' })).getByRole(
      'link',
      { name: 'Audit trail' },
    ),
  );
  expect(
    await screen.findByRole('heading', { name: 'Audit trail', level: 1 }),
  ).toBeVisible();
  // The applied condition returns from the URL; the draft follows it.
  expect(screen.getByLabelText('Resource ID')).toHaveValue('doc-one');
  expect(await screen.findByText('lab.lab.create')).toBeVisible();
  expect(screen.queryByText('user-one')).not.toBeInTheDocument();
});

test('the workspace renders the audit trail in English around raw protocol values', async () => {
  server.use(
    http.get('http://api.test/api/v1/audit-events', () =>
      HttpResponse.json({
        data: [
          {
            ...event,
            trace_id: 'trace-one',
            job_id: 'job-one',
            metadata: { subject_user_id: 'user-two' },
          },
        ],
        next_cursor: null,
        has_more: false,
      }),
    ),
  );
  open('owner', 'en');
  const navigation = await screen.findByRole('navigation', {
    name: 'Main menu',
  });
  expect(
    await within(navigation).findByRole('link', { name: 'Audit trail' }),
  ).toBeVisible();
  expect(
    await screen.findByRole('heading', { name: 'Audit trail', level: 1 }),
  ).toBeVisible();
  expect(screen.getByLabelText('Action')).toBeVisible();
  expect(screen.getByLabelText('Resource ID')).toBeVisible();
  expect(screen.getByLabelText('Resource type')).toBeVisible();
  expect(screen.getByLabelText('Actor ID')).toBeVisible();
  expect(screen.getByLabelText('Request ID')).toBeVisible();
  expect(screen.getByLabelText('Correlation ID')).toBeVisible();
  expect(screen.getByLabelText('Job ID')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Filter records' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Refresh audit' })).toBeVisible();
  expect(await screen.findByText('lab.lab.create')).toBeVisible();
  // Entry context labels live in the result list; the filter form keeps
  // its own field labels above.
  const list = screen.getByRole('list');
  expect(within(list).getByText('Actor')).toBeVisible();
  expect(within(list).getByText('Resource type')).toBeVisible();
  expect(within(list).getByText('user-two')).toBeVisible();
  expect(within(list).getByText('Trace ID')).toBeVisible();
  expect(within(list).getByText('Affected user')).toBeVisible();
});
