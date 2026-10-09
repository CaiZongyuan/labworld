import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import {
  createApiClient,
  type CurrentSession,
  type JobInfo,
  type JobDetails,
} from '@labos-threejs/sdk';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { createAppRouter } from './router';

// UI11 moves job tracking into the universal shell: the administration
// group reaches /jobs and /jobs/$jobId, every fixed string comes from the
// Core catalog, and the status filter lives in the URL so switching the
// language or theme cannot clear a legitimate query. Job states, the
// admin retry contract (idempotency key, server-decided can_retry) and
// role authorization keep their real behaviour; raw protocol values stay
// untranslated.

const time = '2026-09-26T00:00:00Z';
const identity = {
  user: {
    id: 'owner',
    email: 'owner@example.com',
    display_name: null,
    role: 'owner',
  },
  csrf_token: 'csrf-proof',
} satisfies CurrentSession;
const job = {
  id: 'job-one',
  kind: 'reports.generate',
  schema_version: 1,
  status: 'failed',
  batch: 1,
  attempts: 1,
  max_attempts: 5,
  scheduled_at: time,
  lease_expires_at: time,
  last_error: 'reports.storage_unavailable',
  correlation_id: 'request-one',
  causation_id: null,
  created_at: time,
  updated_at: time,
  can_retry: true,
} satisfies JobInfo;
function details(current: JobInfo): JobDetails {
  return {
    job: current,
    batches: [
      {
        number: 1,
        max_attempts: 5,
        attempts: 1,
        legacy_attempts: 0,
        status: 'failed',
        requested_by: null,
        last_error: 'reports.storage_unavailable',
        created_at: time,
        ended_at: time,
      },
    ],
    attempts: [
      {
        batch: 1,
        number: 1,
        worker_id: 'worker-one',
        status: 'failed',
        last_error: 'reports.storage_unavailable',
        started_at: time,
        lease_expires_at: time,
        ended_at: time,
      },
    ],
    next_before_batch: null,
  };
}
function open(
  path = '/jobs',
  currentIdentity: () => CurrentSession = () => identity,
  locale: 'zh' | 'en' = 'zh',
) {
  window.localStorage.setItem('labos-threejs.locale', locale);
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json(currentIdentity()),
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

test('an administrator tracks the job list inside the shell navigation', async () => {
  server.use(
    http.get('http://api.test/api/v1/jobs', ({ request }) => {
      const status = new URL(request.url).searchParams.get('status');
      expect(status).toBe('failed');
      expect(new URL(request.url).searchParams.has('cursor')).toBe(false);
      return HttpResponse.json({
        data: [job],
        next_cursor: null,
        has_more: false,
      });
    }),
  );
  const user = open();
  const navigation = await screen.findByRole('navigation', {
    name: '主菜单',
  });
  expect(
    await within(navigation).findByRole('link', { name: '后台任务' }),
  ).toBeVisible();
  expect(
    await screen.findByRole('heading', { name: '后台任务', level: 1 }),
  ).toBeVisible();
  // The select option and the list badge share the status name.
  expect((await screen.findAllByText('已失败')).length).toBeGreaterThan(0);
  expect(screen.getByText('任务编号：job-one')).toBeVisible();
  expect(
    screen.getByText(/错误摘要：reports\.storage_unavailable/),
  ).toBeVisible();
  expect(screen.getByText('第 1 批 · 已尝试 1 / 5 次')).toBeVisible();
  expect(
    screen.getByRole('button', { name: '查看任务 job-one' }),
  ).toBeVisible();
  // Changing the filter re-queries from the URL filter, not a cached cursor.
  server.use(
    http.get('http://api.test/api/v1/jobs', ({ request }) => {
      const status = new URL(request.url).searchParams.get('status');
      expect(status).toBe('queued');
      return HttpResponse.json({
        data: [
          { ...job, id: 'job-queued', status: 'queued', can_retry: false },
        ],
        next_cursor: null,
        has_more: false,
      });
    }),
  );
  await user.selectOptions(screen.getByLabelText('任务状态'), 'queued');
  expect((await screen.findAllByText('等待处理')).length).toBeGreaterThan(0);
  expect(screen.queryByText('任务编号：job-one')).not.toBeInTheDocument();
  // The raw job kind and identifiers are protocol values: never translated.
  expect(screen.getByText('任务编号：job-queued')).toBeVisible();
});

test('retry starts a new execution batch and keeps the server-decided facts', async () => {
  let current: JobInfo = job;
  server.use(
    http.get('http://api.test/api/v1/jobs/job-one', () =>
      HttpResponse.json(details(current)),
    ),
    http.post('http://api.test/api/v1/jobs/job-one/retry', ({ request }) => {
      expect(request.headers.get('x-csrf-token')).toBe(identity.csrf_token);
      expect(request.headers.get('idempotency-key')).toBeTruthy();
      current = {
        ...job,
        status: 'queued',
        batch: 2,
        attempts: 0,
        last_error: null,
        can_retry: false,
      };
      return HttpResponse.json(current, { status: 202 });
    }),
  );
  const user = open('/jobs/job-one');
  expect(await screen.findByText('reports.storage_unavailable')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '重试失败任务' }));
  expect(await screen.findByText('等待处理')).toBeVisible();
  expect(
    screen.queryByRole('button', { name: '重试失败任务' }),
  ).not.toBeInTheDocument();
  expect(screen.getByText('当前第 2 批 · 已尝试 0 / 5 次')).toBeVisible();
  expect(screen.getByText('关联请求：request-one')).toBeVisible();
});

test('a network failure retries the same command instead of accidentally opening two batches', async () => {
  const keys: string[] = [];
  let current: JobInfo = job;
  server.use(
    http.get('http://api.test/api/v1/jobs/job-one', () =>
      HttpResponse.json(details(current)),
    ),
    http.post('http://api.test/api/v1/jobs/job-one/retry', ({ request }) => {
      keys.push(request.headers.get('idempotency-key')!);
      if (keys.length === 1)
        return HttpResponse.json(
          {
            error: {
              code: 'jobs.unavailable',
              message: 'Try later',
              request_id: 'retry-failed',
            },
          },
          { status: 503 },
        );
      current = {
        ...job,
        status: 'queued',
        batch: 2,
        attempts: 0,
        last_error: null,
        can_retry: false,
      };
      return HttpResponse.json(current, { status: 202 });
    }),
  );
  const user = open('/jobs/job-one');
  await user.click(await screen.findByRole('button', { name: '重试失败任务' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('retry-failed');
  await user.click(screen.getByRole('button', { name: '重试失败任务' }));
  expect(await screen.findByText('等待处理')).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
});

test('a revoked administrator loses the cached job record after a rejected retry', async () => {
  let currentIdentity: CurrentSession = identity;
  server.use(
    http.get('http://api.test/api/v1/jobs/job-one', () =>
      HttpResponse.json(details(job)),
    ),
    http.post('http://api.test/api/v1/jobs/job-one/retry', () => {
      currentIdentity = {
        ...identity,
        user: { ...identity.user, role: 'member' },
      };
      return HttpResponse.json(
        {
          error: {
            code: 'jobs.forbidden',
            message: 'Forbidden',
            request_id: 'access-changed',
          },
        },
        { status: 403 },
      );
    }),
  );
  const user = open('/jobs/job-one', () => currentIdentity);
  await user.click(await screen.findByRole('button', { name: '重试失败任务' }));
  expect(
    await screen.findByText('仅企业所有者或管理员可以管理后台任务。'),
  ).toBeVisible();
  expect(
    screen.queryByRole('button', { name: '重试失败任务' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText('reports.generate')).not.toBeInTheDocument();
});

test('a plain member sees the permission message and no administration entry', async () => {
  server.use(
    http.get('http://api.test/api/v1/jobs', () =>
      HttpResponse.json({ data: [], next_cursor: null, has_more: false }),
    ),
  );
  open('/jobs', () => ({
    ...identity,
    user: { ...identity.user, id: 'member', role: 'member' },
  }));
  const navigation = await screen.findByRole('navigation', {
    name: '主菜单',
  });
  expect(
    await screen.findByText('仅企业所有者或管理员可以管理后台任务。'),
  ).toBeVisible();
  expect(
    within(navigation).queryByRole('link', { name: '后台任务' }),
  ).not.toBeInTheDocument();
});

test('the status filter survives a language switch and speaks English afterwards', async () => {
  server.use(
    http.get('http://api.test/api/v1/jobs', ({ request }) => {
      const status = new URL(request.url).searchParams.get('status');
      if (status !== 'queued')
        return HttpResponse.json({
          data: [job],
          next_cursor: null,
          has_more: false,
        });
      return HttpResponse.json({
        data: [
          { ...job, id: 'job-queued', status: 'queued', can_retry: false },
        ],
        next_cursor: null,
        has_more: false,
      });
    }),
  );
  const user = open();
  await user.selectOptions(await screen.findByLabelText('任务状态'), 'queued');
  expect(await screen.findByText('任务编号：job-queued')).toBeVisible();
  // The switch routes through settings; returning must restore the filter
  // from the URL and render the catalog in English.
  await user.click(await screen.findByRole('navigation', { name: '主菜单' }));
  await screen.findByRole('navigation', { name: '主菜单' });
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
      { name: 'Background jobs' },
    ),
  );
  expect(
    await screen.findByRole('heading', { name: 'Background jobs', level: 1 }),
  ).toBeVisible();
  expect(await screen.findByText('Job ID: job-queued')).toBeVisible();
  expect(screen.getByRole('combobox', { name: 'Job status' })).toHaveValue(
    'queued',
  );
  expect((await screen.findAllByText('Queued')).length).toBeGreaterThan(0);
  expect(screen.getByRole('option', { name: 'All statuses' })).toBeVisible();
});

test('the workspace renders job tracking in English around raw protocol values', async () => {
  let current: JobInfo = job;
  server.use(
    http.get('http://api.test/api/v1/jobs', () =>
      HttpResponse.json({
        data: [job],
        next_cursor: null,
        has_more: false,
      }),
    ),
    http.get('http://api.test/api/v1/jobs/job-one', () =>
      HttpResponse.json(details(current)),
    ),
    http.post('http://api.test/api/v1/jobs/job-one/retry', () => {
      current = {
        ...job,
        status: 'queued',
        batch: 2,
        attempts: 0,
        last_error: null,
        can_retry: false,
      };
      return HttpResponse.json(current, { status: 202 });
    }),
  );
  const user = open('/jobs', () => identity, 'en');
  const navigation = await screen.findByRole('navigation', {
    name: 'Main menu',
  });
  expect(
    await within(navigation).findByRole('link', { name: 'Background jobs' }),
  ).toBeVisible();
  expect(
    await screen.findByRole('heading', { name: 'Background jobs', level: 1 }),
  ).toBeVisible();
  expect((await screen.findAllByText('Failed')).length).toBeGreaterThan(0);
  expect(screen.getByText('Job ID: job-one')).toBeVisible();
  expect(
    screen.getByText(/Error summary: reports\.storage_unavailable/),
  ).toBeVisible();
  expect(screen.getByText('Batch 1 · 1 / 5 attempts')).toBeVisible();
  expect(screen.getByRole('option', { name: 'All statuses' })).toBeVisible();

  await user.click(screen.getByRole('button', { name: 'View job job-one' }));
  expect(
    await screen.findByRole('heading', { name: 'Job details', level: 1 }),
  ).toBeVisible();
  expect(screen.getByText('Execution history')).toBeVisible();
  expect(screen.getByText('Batch 1')).toBeVisible();
  expect(screen.getByText('Attempt 1 · Failed')).toBeVisible();
  expect(screen.getByText('Correlated request: request-one')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Retry failed job' }));
  expect(await screen.findByText('Queued')).toBeVisible();
  expect(screen.getByText('Current batch 2 · 0 / 5 attempts')).toBeVisible();
});
