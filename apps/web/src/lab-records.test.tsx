import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createApiClient,
  type LabEntity,
  type LabRecord,
} from '@labos-threejs/sdk';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, test, vi } from 'vitest';
import { server } from '../../../tests/frontend/server';
import RecordsPanel, {
  type RecordsPanelProps,
} from '../../../packages/views/src/lab/records-panel';
import RecentActivity from '../../../packages/views/src/lab/recent-activity';
import { AppMessagesProvider } from '../../../packages/views/src/shell/messages';
import { PreferencesProvider } from '../../../packages/views/src/shell/preferences';
import { labMessages } from '../../../packages/views/src/lab/messages';

const entities = [
  { id: 'light', name: 'Light A' },
  { id: 'sensor', name: 'Sensor B' },
] as LabEntity[];
const record = (id: string, kind: string): LabRecord => ({
  id,
  record_type: kind,
  entity_id: 'light',
  entity_name: 'Light A',
  reality: 'simulated',
  archived_at: null,
  run_id: 'run-original',
  binding_id: 'binding-original',
  command_id: kind === 'command' ? id : null,
  task_id: null,
  result_id: null,
  recorded_at: '2026-10-08T12:00:00.123456Z',
  ended_at: null,
  state: 'accepted',
  summary: id,
  source: 'simulated:light-original',
  actor_id: 'member-one',
  actor_source: 'member',
  actor_role: 'Member',
  data: { on: true },
});
function panel(recent = false) {
  const prefix = (entries: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(entries).map(([key, value]) => [`lab.${key}`, value]),
    );
  const Component = recent ? RecentActivity : RecordsPanel;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const initial: RecordsPanelProps = {
    apiClient: createApiClient('http://api.test'),
    userId: 'member-one',
    labId: 'lab',
    entities,
  };
  const body = (props: RecordsPanelProps) => (
    <QueryClientProvider client={queryClient}>
      <PreferencesProvider>
        <AppMessagesProvider
          app={{
            messages: {
              zh: prefix(labMessages.zh),
              en: prefix(labMessages.en),
            },
          }}
        >
          <Component {...props} />
        </AppMessagesProvider>
      </PreferencesProvider>
    </QueryClientProvider>
  );
  const result = render(body(initial));
  return {
    ...result,
    update: (next: Partial<RecordsPanelProps>) =>
      result.rerender(body({ ...initial, ...next })),
  };
}

test('a member reads mixed Lab records and applies a category as a new bounded query', async () => {
  const requests: URL[] = [];
  server.use(
    http.get('http://api.test/api/v1/lab/labs/lab/records', ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      return HttpResponse.json({
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        queried_at: '2026-10-08T12:30:00.123456Z',
        query_upper_bound: '2026-10-08T12:30:00.123456Z',
        entity_id: null,
        record_type: url.searchParams.get('record_type'),
        retention: { observation_seconds: 86400, record_seconds: 2592000 },
        coverage: [],
        max_page_items: 100,
        max_range_seconds: 2678400,
        max_response_bytes: 262144,
        items:
          url.searchParams.get('record_type') === 'command'
            ? [record('command-only', 'command')]
            : [
                record('first-command', 'command'),
                record('first-event', 'event'),
              ],
        next_cursor: null,
      });
    }),
  );
  panel();
  expect(await screen.findByText('first-command')).toBeVisible();
  expect(screen.getByText('first-event')).toBeVisible();
  await userEvent
    .setup()
    .selectOptions(screen.getByLabelText('记录类别'), 'command');
  expect(await screen.findByText('command-only')).toBeVisible();
  expect(screen.queryByText('first-event')).not.toBeInTheDocument();
  await waitFor(() =>
    expect(requests.at(-1)?.searchParams.get('record_type')).toBe('command'),
  );
  expect(requests.at(-1)?.searchParams.get('cursor')).toBeNull();
  expect(requests.at(-1)?.searchParams.get('limit')).toBe('20');
});

test('applying a valid time filter starts a first page while invalid dates keep the loaded result', async () => {
  const requests: URL[] = [];
  server.use(
    http.get('http://api.test/api/v1/lab/labs/lab/records', ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      return HttpResponse.json({
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        queried_at: '2026-10-08T12:30:00.123456Z',
        query_upper_bound: '2026-10-08T12:30:00.123456Z',
        entity_id: null,
        record_type: null,
        retention: { observation_seconds: 86400, record_seconds: 2592000 },
        coverage: [],
        max_page_items: 100,
        max_range_seconds: 2678400,
        max_response_bytes: 262144,
        items: [record('retained-time-result', 'event')],
        next_cursor: null,
      });
    }),
  );
  panel();
  await screen.findByText('retained-time-result');
  const user = userEvent.setup();
  await user.clear(screen.getByLabelText('开始时间'));
  await user.type(screen.getByLabelText('开始时间'), '2026-10-01T09:00');
  await user.clear(screen.getByLabelText('结束时间'));
  await user.type(screen.getByLabelText('结束时间'), '2026-10-02T09:00');
  await user.click(screen.getByRole('button', { name: '查询记录' }));
  await waitFor(() =>
    expect(requests.at(-1)?.searchParams.get('from')).toBe(
      new Date('2026-10-01T09:00').toISOString(),
    ),
  );
  expect(requests.at(-1)?.searchParams.get('to')).toBe(
    new Date('2026-10-02T09:00').toISOString(),
  );
  expect(requests.at(-1)?.searchParams.get('cursor')).toBeNull();
  await user.clear(screen.getByLabelText('结束时间'));
  await user.type(screen.getByLabelText('结束时间'), '2026-09-01T09:00');
  expect(screen.getByRole('button', { name: '查询记录' })).toBeDisabled();
  expect(screen.getByText('retained-time-result')).toBeVisible();
});

test('a failed older page keeps the loaded page and retries the same cursor before refresh starts a new upper bound', async () => {
  const calls: (string | null)[] = [];
  let fail = true;
  let fresh = false;
  server.use(
    http.get('http://api.test/api/v1/lab/labs/lab/records', ({ request }) => {
      const url = new URL(request.url);
      const cursor = url.searchParams.get('cursor');
      calls.push(cursor);
      if (cursor && fail)
        return HttpResponse.json(
          { error: { code: 'lab.unavailable', message: 'Unavailable' } },
          { status: 503 },
        );
      return HttpResponse.json({
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        queried_at: fresh
          ? '2026-10-08T12:31:00.654321Z'
          : '2026-10-08T12:30:00.123456Z',
        query_upper_bound: fresh
          ? '2026-10-08T12:31:00.654321Z'
          : '2026-10-08T12:30:00.123456Z',
        entity_id: null,
        record_type: null,
        retention: { observation_seconds: 86400, record_seconds: 2592000 },
        coverage: [],
        max_page_items: 100,
        max_range_seconds: 2678400,
        max_response_bytes: 262144,
        items: [
          record(
            cursor ? 'older-page' : fresh ? 'fresh-page' : 'loaded-page',
            'event',
          ),
        ],
        next_cursor: cursor ? null : 'same-query-cursor',
      });
    }),
  );
  panel();
  const user = userEvent.setup();
  await screen.findByText('loaded-page');
  await user.click(screen.getByRole('button', { name: '更早运行记录' }));
  await screen.findByRole('button', { name: '重试记录查询' });
  expect(screen.getByText('loaded-page')).toBeVisible();
  fail = false;
  await user.click(screen.getByRole('button', { name: '重试记录查询' }));
  expect(await screen.findByText('older-page')).toBeVisible();
  expect(screen.queryByText('loaded-page')).not.toBeInTheDocument();
  expect(calls.slice(-2)).toEqual(['same-query-cursor', 'same-query-cursor']);
  expect(screen.getByLabelText('查询上界')).toHaveTextContent(
    '2026-10-08T12:30:00.123456Z',
  );
  fresh = true;
  await user.click(screen.getByRole('button', { name: '刷新运行记录' }));
  expect(await screen.findByText('fresh-page')).toBeVisible();
  expect(calls.at(-1)).toBeNull();
  expect(screen.getByLabelText('查询上界')).toHaveTextContent(
    '2026-10-08T12:31:00.654321Z',
  );
});

test('a late older response cannot replace a new device filter or reuse its cursor', async () => {
  let release: () => void = () => {};
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let olderStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    olderStarted = resolve;
  });
  let completed: () => void = () => {};
  const responseCompleted = new Promise<void>((resolve) => {
    completed = resolve;
  });
  const requests: URL[] = [];
  server.use(
    http.get(
      'http://api.test/api/v1/lab/labs/lab/records',
      async ({ request }) => {
        const url = new URL(request.url);
        requests.push(url);
        const cursor = url.searchParams.get('cursor');
        if (cursor) {
          olderStarted();
          await delayed;
        }
        const sensor = url.searchParams.get('entity_id') === 'sensor';
        if (cursor) completed();
        return HttpResponse.json({
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
          queried_at: '2026-10-08T12:30:00.123456Z',
          query_upper_bound: '2026-10-08T12:30:00.123456Z',
          entity_id: sensor ? 'sensor' : null,
          record_type: null,
          retention: { observation_seconds: 86400, record_seconds: 2592000 },
          coverage: [],
          max_page_items: 100,
          max_range_seconds: 2678400,
          max_response_bytes: 262144,
          items: [
            {
              ...record(
                sensor
                  ? 'sensor-current-query'
                  : cursor
                    ? 'old-delayed-query'
                    : 'initial-all-devices',
                'event',
              ),
              entity_id: sensor ? 'sensor' : 'light',
              entity_name: sensor ? 'Sensor B' : 'Light A',
            },
          ],
          next_cursor: sensor ? null : 'all-devices-cursor',
        });
      },
    ),
  );
  panel();
  const user = userEvent.setup();
  await screen.findByText('initial-all-devices');
  await user.click(screen.getByRole('button', { name: '更早运行记录' }));
  await started;
  await user.selectOptions(screen.getByLabelText('设备'), 'sensor');
  await screen.findByText('sensor-current-query');
  expect(requests.at(-1)?.searchParams.get('cursor')).toBeNull();
  await act(async () => {
    release();
    await responseCompleted;
  });
  await waitFor(() =>
    expect(screen.queryByText('old-delayed-query')).not.toBeInTheDocument(),
  );
  expect(screen.getByText('sensor-current-query')).toBeVisible();
});

test('returning to a previous category starts a new first page instead of restoring its older cursor page', async () => {
  const requests: URL[] = [];
  server.use(
    http.get('http://api.test/api/v1/lab/labs/lab/records', ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      const cursor = url.searchParams.get('cursor');
      const kind = url.searchParams.get('record_type');
      return HttpResponse.json({
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        queried_at: '2026-10-08T12:30:00.123456Z',
        query_upper_bound: '2026-10-08T12:30:00.123456Z',
        entity_id: null,
        record_type: kind,
        retention: { observation_seconds: 86400, record_seconds: 2592000 },
        coverage: [],
        max_page_items: 100,
        max_range_seconds: 2678400,
        max_response_bytes: 262144,
        items: [
          record(
            kind
              ? 'selected-category-page'
              : cursor
                ? 'old-category-page'
                : 'all-category-first-page',
            'event',
          ),
        ],
        next_cursor: cursor ? null : 'all-category-cursor',
      });
    }),
  );
  panel();
  const user = userEvent.setup();
  await screen.findByText('all-category-first-page');
  await user.click(screen.getByRole('button', { name: '更早运行记录' }));
  await screen.findByText('old-category-page');
  await user.selectOptions(screen.getByLabelText('记录类别'), 'event');
  await screen.findByText('selected-category-page');
  const beforeReturn = requests.length;
  await user.selectOptions(screen.getByLabelText('记录类别'), '');
  expect(await screen.findByText('all-category-first-page')).toBeVisible();
  expect(requests.length).toBeGreaterThan(beforeReturn);
  expect(requests.at(-1)?.searchParams.get('cursor')).toBeNull();
  expect(screen.queryByText('old-category-page')).not.toBeInTheDocument();
});

test.each(['API', 'user', 'Lab'] as const)(
  'a late page from a previous %s scope cannot reach the new records view',
  async (scope) => {
    let release: () => void = () => {};
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let markCompleted: () => void = () => {};
    const completed = new Promise<void>((resolve) => {
      markCompleted = resolve;
    });
    let nextScope = false;
    const requests: URL[] = [];
    server.use(
      http.get(
        /http:\/\/(?:api|other-api)\.test\/api\/v1\/lab\/labs\/[^/]+\/records/,
        async ({ request }) => {
          const url = new URL(request.url);
          requests.push(url);
          const cursor = url.searchParams.get('cursor');
          const summary = nextScope
            ? 'current-scope-page'
            : cursor
              ? 'late-previous-scope'
              : 'previous-scope-page';
          if (cursor) {
            markStarted();
            await delayed;
            markCompleted();
          }
          return HttpResponse.json({
            from: url.searchParams.get('from'),
            to: url.searchParams.get('to'),
            queried_at: '2026-10-08T12:30:00.123456Z',
            query_upper_bound: '2026-10-08T12:30:00.123456Z',
            entity_id: null,
            record_type: null,
            retention: { observation_seconds: 86400, record_seconds: 2592000 },
            coverage: [],
            max_page_items: 100,
            max_range_seconds: 2678400,
            max_response_bytes: 262144,
            items: [record(summary, 'event')],
            next_cursor: cursor ? null : 'previous-scope-cursor',
          });
        },
      ),
    );
    const view = panel();
    const user = userEvent.setup();
    await screen.findByText('previous-scope-page');
    await user.click(screen.getByRole('button', { name: '更早运行记录' }));
    await started;
    nextScope = true;
    view.update(
      scope === 'API'
        ? { apiClient: createApiClient('http://other-api.test') }
        : scope === 'user'
          ? { userId: 'member-two' }
          : { labId: 'other-lab' },
    );
    expect(screen.queryByText('previous-scope-page')).not.toBeInTheDocument();
    await screen.findByText('current-scope-page');
    expect(requests.at(-1)?.searchParams.get('cursor')).toBeNull();
    await act(async () => {
      release();
      await completed;
    });
    expect(screen.queryByText('late-previous-scope')).not.toBeInTheDocument();
    expect(screen.getByText('current-scope-page')).toBeVisible();
  },
);

test('current-page CSV keeps original ISO values and safely quotes commas, newlines and formula prefixes without a request', async () => {
  const calls: URL[] = [];
  let exported: Blob | null = null;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn((blob: Blob) => {
      exported = blob;
      return 'blob:records-test';
    }),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
  server.use(
    http.get('http://api.test/api/v1/lab/labs/lab/records', ({ request }) => {
      const url = new URL(request.url);
      calls.push(url);
      return HttpResponse.json({
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        queried_at: '2026-10-08T12:30:00.123456Z',
        query_upper_bound: '2026-10-08T12:30:00.123456Z',
        entity_id: null,
        record_type: null,
        retention: { observation_seconds: 86400, record_seconds: 2592000 },
        coverage: [],
        max_page_items: 100,
        max_range_seconds: 2678400,
        max_response_bytes: 262144,
        items: [
          {
            ...record('csv-current-page', 'command'),
            entity_name: '=SUM(1,2)\n"lab"',
            summary: '+command, "quoted"',
            source: '@source',
          },
        ],
        next_cursor: null,
      });
    }),
  );
  panel();
  await screen.findByText('+command, "quoted"');
  const before = calls.length;
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: '导出当前页 CSV' }));
  expect(calls).toHaveLength(before);
  expect(exported).not.toBeNull();
  const csv = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(exported!);
  });
  expect(csv).toContain('2026-10-08T12:00:00.123456Z');
  expect(csv).toContain('"\'=SUM(1,2)\n""lab"""');
  expect(csv).toContain('"\'+command, ""quoted"""');
  expect(csv).toContain('"\'@source"');
  expect(screen.getByLabelText('设备')).toHaveValue('');
  expect(screen.getByLabelText('记录类别')).toHaveValue('');
});

test('CSV exports only the current older page in UTF-8 and caps it at one hundred records', async () => {
  let exported: Blob | null = null;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn((blob: Blob) => {
      exported = blob;
      return 'blob:bounded-page';
    }),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
  const requests: URL[] = [];
  server.use(
    http.get('http://api.test/api/v1/lab/labs/lab/records', ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      const older = url.searchParams.has('cursor');
      return HttpResponse.json({
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        queried_at: '2026-10-08T12:30:00.123456Z',
        query_upper_bound: '2026-10-08T12:30:00.123456Z',
        entity_id: null,
        record_type: null,
        retention: { observation_seconds: 86400, record_seconds: 2592000 },
        coverage: [],
        max_page_items: 100,
        max_range_seconds: 2678400,
        max_response_bytes: 262144,
        items: older
          ? Array.from({ length: 101 }, (_, index) => ({
              ...record(`older-row-${index}`, 'event'),
              entity_name: '实验室设备🧪',
              summary: index === 100 ? 'overflow-record' : `历史记录 ${index}`,
            }))
          : [record('previous-page-excluded', 'event')],
        next_cursor: older ? null : 'older-cursor',
      });
    }),
  );
  panel();
  const user = userEvent.setup();
  await screen.findByText('previous-page-excluded');
  await user.click(screen.getByRole('button', { name: '更早运行记录' }));
  await screen.findByText('历史记录 99');
  const before = requests.length;
  await user.click(screen.getByRole('button', { name: '导出当前页 CSV' }));
  expect(requests).toHaveLength(before);
  expect(exported!.type).toBe('text/csv;charset=utf-8');
  const csv = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(exported!);
  });
  expect(csv).toContain('实验室设备🧪');
  expect(csv).toContain('历史记录 99');
  expect(csv).not.toContain('previous-page-excluded');
  expect(csv).not.toContain('overflow-record');
  expect(csv.split('\r\n')).toHaveLength(102);
});

test('an inconsistent result reference reports the mismatch instead of presenting it as the recorded result', async () => {
  server.use(
    http.get('http://api.test/api/v1/lab/labs/lab/records', ({ request }) => {
      const query = new URL(request.url).searchParams;
      return HttpResponse.json({
        from: query.get('from'),
        to: query.get('to'),
        queried_at: '2026-10-08T12:30:00.123456Z',
        query_upper_bound: '2026-10-08T12:30:00.123456Z',
        entity_id: null,
        record_type: null,
        retention: { observation_seconds: 86400, record_seconds: 2592000 },
        coverage: [],
        max_page_items: 100,
        max_range_seconds: 2678400,
        max_response_bytes: 262144,
        items: [
          {
            ...record('inconsistent-record', 'task'),
            result_id: 'recorded-result',
            data: {
              result: { id: 'different-result', values: { temperature: 25 } },
            },
          },
        ],
        next_cursor: null,
      });
    }),
  );
  panel();
  const user = userEvent.setup();
  await screen.findByText('inconsistent-record');
  await user.click(screen.getByText('查看原始记录'));
  expect(
    screen.getByText('结果引用与此记录不一致，未展示为原始结果。'),
  ).toBeVisible();
  expect(screen.getByText('recorded-result', { exact: true })).toBeVisible();
  expect(screen.getByText(/different-result/)).not.toBeVisible();
});

test('a failed refresh keeps the last loaded page and retries the new query without its old cursor', async () => {
  let refresh = false;
  let fail = true;
  const calls: (string | null)[] = [];
  server.use(
    http.get('http://api.test/api/v1/lab/labs/lab/records', ({ request }) => {
      const url = new URL(request.url);
      calls.push(url.searchParams.get('cursor'));
      if (refresh && fail)
        return HttpResponse.json(
          { error: { code: 'lab.unavailable', message: 'Unavailable' } },
          { status: 503 },
        );
      return HttpResponse.json({
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        queried_at: refresh
          ? '2026-10-08T12:31:00.654321Z'
          : '2026-10-08T12:30:00.123456Z',
        query_upper_bound: refresh
          ? '2026-10-08T12:31:00.654321Z'
          : '2026-10-08T12:30:00.123456Z',
        entity_id: null,
        record_type: null,
        retention: { observation_seconds: 86400, record_seconds: 2592000 },
        coverage: [],
        max_page_items: 100,
        max_range_seconds: 2678400,
        max_response_bytes: 262144,
        items: [
          record(refresh ? 'refreshed-result' : 'last-loaded-result', 'event'),
        ],
        next_cursor: 'original-cursor',
      });
    }),
  );
  panel();
  const user = userEvent.setup();
  await screen.findByText('last-loaded-result');
  refresh = true;
  await user.click(screen.getByRole('button', { name: '刷新运行记录' }));
  await screen.findByRole('button', { name: '重试记录查询' });
  expect(screen.getByText('last-loaded-result')).toBeVisible();
  expect(screen.getByRole('status', { name: '已加载查询' })).toHaveTextContent(
    '显示上次已加载页',
  );
  fail = false;
  await user.click(screen.getByRole('button', { name: '重试记录查询' }));
  expect(await screen.findByText('refreshed-result')).toBeVisible();
  expect(calls.slice(-2)).toEqual([null, null]);
  expect(screen.queryByText('last-loaded-result')).not.toBeInTheDocument();
});

test('recent activity reads only a bounded first page and refresh replaces it with a new query', async () => {
  const requests: URL[] = [];
  server.use(
    http.get('http://api.test/api/v1/lab/labs/lab/records', ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      const fresh = requests.length > 1;
      return HttpResponse.json({
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        queried_at: fresh
          ? '2026-10-08T12:31:00.654321Z'
          : '2026-10-08T12:30:00.123456Z',
        query_upper_bound: fresh
          ? '2026-10-08T12:31:00.654321Z'
          : '2026-10-08T12:30:00.123456Z',
        entity_id: null,
        record_type: null,
        retention: { observation_seconds: 86400, record_seconds: 2592000 },
        coverage: [],
        max_page_items: 100,
        max_range_seconds: 2678400,
        max_response_bytes: 262144,
        items: [record(fresh ? 'new-activity' : 'first-activity', 'event')],
        next_cursor: 'unused-activity-cursor',
      });
    }),
  );
  panel(true);
  await screen.findByText('first-activity');
  expect(requests[0].searchParams.get('limit')).toBe('5');
  expect(requests[0].searchParams.get('cursor')).toBeNull();
  expect(
    screen.queryByRole('button', { name: '更早运行记录' }),
  ).not.toBeInTheDocument();
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: '刷新最近活动' }));
  expect(await screen.findByText('new-activity')).toBeVisible();
  expect(screen.queryByText('first-activity')).not.toBeInTheDocument();
  expect(requests.at(-1)?.searchParams.get('cursor')).toBeNull();
});

test('records expose original identities, result payload and honest unknown provenance and coverage gaps', async () => {
  server.use(
    http.get('http://api.test/api/v1/lab/labs/lab/records', ({ request }) => {
      const query = new URL(request.url).searchParams;
      return HttpResponse.json({
        from: query.get('from'),
        to: query.get('to'),
        queried_at: '2026-10-08T12:30:00.123456Z',
        query_upper_bound: '2026-10-08T12:30:00.123456Z',
        entity_id: null,
        record_type: null,
        retention: { observation_seconds: 86400, record_seconds: 2592000 },
        coverage: [
          {
            record_type: 'task',
            retention_seconds: 2592000,
            preserves_unfinished: true,
            gaps: [
              {
                from: '2026-10-07T00:00:00Z',
                to: '2026-10-07T12:00:00Z',
                reason: 'retention',
              },
            ],
          },
        ],
        max_page_items: 100,
        max_range_seconds: 2678400,
        max_response_bytes: 262144,
        items: [
          {
            ...record('original-task-record', 'task'),
            state: 'completed',
            task_id: 'original-task',
            result_id: 'original-result',
            actor_source: 'unknown',
            actor_role: 'unknown',
            actor_id: null,
            data: {
              result: {
                id: 'original-result',
                task_id: 'original-task',
                status: 'completed',
                values: { rpm: 6000 },
              },
            },
          },
        ],
        next_cursor: null,
      });
    }),
  );
  panel();
  const user = userEvent.setup();
  await screen.findByText('original-task-record');
  expect(
    screen.getByRole('status', { name: '记录保留缺口' }),
  ).toHaveTextContent('retention');
  await user.click(screen.getByText('查看原始记录'));
  expect(screen.getByText('binding-original')).toBeVisible();
  expect(screen.getByText('run-original')).toBeVisible();
  expect(screen.getByText('original-result', { exact: true })).toBeVisible();
  expect(
    screen.getByRole('region', { name: '原始记录结果' }),
  ).toHaveTextContent('6000');
  expect(
    screen.getByRole('region', { name: '原始记录结果' }),
  ).not.toHaveTextContent('current-result');
  expect(screen.getAllByText('未知').length).toBeGreaterThan(0);
});
