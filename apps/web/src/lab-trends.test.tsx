import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { createApiClient, type EntityTrend } from '@labos-threejs/sdk';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { expect, test, vi } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { createAppRouter } from './router';

function openTrends(shape?: (trend: EntityTrend) => EntityTrend) {
  const definitions = JSON.parse(
    readFileSync('packages/server/src/lab/world/catalog.json', 'utf8'),
  );
  const definition = definitions.find(
    (value: { id: string }) => value.id === 'sensor',
  );
  const lab = { id: 'trend-lab', name: 'Trend Lab', layout_version: 1 };
  const received = '2026-10-08T12:00:00Z';
  const entity = {
    id: 'trend-sensor',
    lab_id: lab.id,
    name: 'Trend Sensor',
    kind: 'sensor',
    reality: 'simulated',
    definition_id: 'sensor',
    definition_version: '1.0',
    definition,
    configuration: {},
    capabilities: [],
    binding: null,
    program_run: null,
    observation: {
      entity_id: 'trend-sensor',
      properties: {
        temperature: {
          value: 19,
          unit: 'degC',
          binding_id: 'old-binding',
          run_id: 'old-run',
          sequence: 1,
          source: 'world-source',
          observed_at: received,
          received_at: received,
          updated_at: received,
          expires_at: received,
          quality: 'good',
          freshness: 'stale',
        },
      },
    },
  };
  const queries: URL[] = [];
  const otherEntity = {
    ...entity,
    id: 'other-sensor',
    name: 'Other Sensor',
    observation: { ...entity.observation, entity_id: 'other-sensor' },
  };
  let version = 1;
  let stream: ReadableStreamDefaultController<Uint8Array>;
  const world = () => ({
    version: String(version),
    lab,
    entities: [entity, otherEntity],
    nodes: [],
    assets: [],
    relationships: [],
  });
  let trend: EntityTrend;
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json({
        user: {
          id: 'trend-member',
          email: 'trend@example.test',
          display_name: 'Trend',
          role: 'member',
        },
        csrf_token: 'trend-csrf',
      }),
    ),
    http.get('http://api.test/api/v1/lab/labs', () =>
      HttpResponse.json({ data: [lab], has_more: false }),
    ),
    http.get('http://api.test/api/v1/lab/assets', () =>
      HttpResponse.json({ data: [], has_more: false }),
    ),
    http.get('http://api.test/api/v1/lab/asset-definitions', () =>
      HttpResponse.json({ data: definitions }),
    ),
    http.get('http://api.test/api/v1/lab/labs/trend-lab/world', () =>
      HttpResponse.json(world()),
    ),
    http.get(
      'http://api.test/api/v1/lab/labs/trend-lab/world/subscribe',
      () =>
        new HttpResponse(
          new ReadableStream({
            start(controller) {
              stream = controller;
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"runtime_status","available":true}\n\n',
                ),
              );
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    ),
    http.get(
      'http://api.test/api/v1/lab/labs/trend-lab/entities/trend-sensor/trend',
      ({ request }) => {
        const query = new URL(request.url);
        queries.push(query);
        const from = query.searchParams.get('from')!;
        const to = query.searchParams.get('to')!;
        const time = (seconds: number) =>
          new Date(Date.parse(to) - seconds * 1000).toISOString();
        const sample = (id: string, value: number, seconds: number) => ({
          id,
          value,
          sequence: 1,
          observed_at: time(seconds + 2),
          received_at: time(seconds),
          expires_at: time(seconds - 5),
        });
        trend = {
          property: 'temperature',
          from,
          to,
          max_points: 600,
          raw_sample_count: 500,
          returned_sample_count: 3,
          plot_item_count: 4,
          sampling_strategy: 'first_last_min_max',
          segments: [
            {
              binding_id: 'history-binding',
              run_id: 'history-run',
              source: 'history-source',
              unit: 'degC',
              quality: 'good',
              source_time_known: true,
              resolution_seconds: 60,
              samples: [sample('first', 20, 3500), sample('spike', 1000, 3000)],
            },
            {
              binding_id: 'new-binding',
              run_id: 'new-run',
              source: 'new-source',
              unit: 'degC',
              quality: 'uncertain',
              source_time_known: false,
              resolution_seconds: 0,
              samples: [{ ...sample('isolated', 23, 30), observed_at: null }],
            },
          ],
          gaps: [
            {
              from: time(2900),
              to: time(30),
              reasons: ['collection_gap', 'run_changed'],
            },
          ],
          first_report_at: time(3500),
          last_report_at: time(30),
          retained_since: from,
          captured_since: from,
          available_since: from,
          observation_retention_seconds: 86400,
          max_response_bytes: 262144,
          max_range_seconds: 86400,
        };
        if (shape) trend = shape(trend);
        return HttpResponse.json(trend);
      },
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const router = createAppRouter(
    {
      apiClient: createApiClient('http://api.test'),
      docsUrl: 'https://docs.test',
    },
    createMemoryHistory({
      initialEntries: ['/lab?lab=trend-lab&entity=trend-sensor'],
    }),
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return {
    user: userEvent.setup(),
    queries,
    trend: () => trend,
    publish() {
      version++;
      stream.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({ type: 'snapshot', world: world() })}\n\n`,
        ),
      );
      return version;
    },
  };
}

test('ordinary device trends expose original spike, isolated sample, gaps and UTC provenance without replacing World readings', async () => {
  const { user, queries, trend } = openTrends();
  const inspector = await screen.findByRole('complementary', {
    name: '对象信息',
  });
  expect(queries).toHaveLength(0);
  await user.click(within(inspector).getByRole('button', { name: '查看趋势' }));
  const table = await within(inspector).findByRole('table', {
    name: '趋势读数',
  });
  expect(queries).toHaveLength(1);
  expect(queries[0].searchParams.get('property')).toBe('temperature');
  expect(within(table).getByText('1000 degC')).toBeVisible();
  expect(within(table).getAllByText('history-source')[0]).toBeVisible();
  expect(within(table).getByText('23 degC')).toBeVisible();
  expect(within(table).getByText('来源时间未知')).toBeVisible();
  expect(within(inspector).getByText('采集缺口')).toBeVisible();
  expect(within(inspector).getByText('Run 切换')).toBeVisible();
  expect(within(inspector).getByText(/60 s/)).toBeVisible();
  expect(
    within(table).getByText(trend().segments[0].samples[1].received_at),
  ).toBeVisible();
  expect(
    within(inspector).getByRole('region', { name: '观测温度' }),
  ).toHaveTextContent('19 degC');
});

test('changing Entity cancels its pending trend and late data cannot enter the new device', async () => {
  const { user } = openTrends();
  let release!: (response: Response) => void;
  let oldResponse!: EntityTrend;
  let oldRequest!: Request;
  server.use(
    http.get(
      'http://api.test/api/v1/lab/labs/trend-lab/entities/:entity/trend',
      ({ request, params }) => {
        const values = new URL(request.url).searchParams;
        const from = values.get('from')!;
        const to = values.get('to')!;
        const source = String(params.entity);
        const dto: EntityTrend = {
          property: 'temperature',
          from,
          to,
          max_points: 600,
          raw_sample_count: 1,
          returned_sample_count: 1,
          plot_item_count: 1,
          sampling_strategy: 'first_last_min_max',
          segments: [
            {
              binding_id: `${source}-binding`,
              run_id: `${source}-run`,
              source,
              quality: 'good',
              unit: 'degC',
              source_time_known: true,
              resolution_seconds: 0,
              samples: [
                {
                  id: source,
                  value: source === 'trend-sensor' ? 111 : 222,
                  sequence: 1,
                  observed_at: from,
                  received_at: from,
                  expires_at: to,
                },
              ],
            },
          ],
          gaps: [],
          first_report_at: from,
          last_report_at: from,
          retained_since: from,
          captured_since: from,
          available_since: from,
          observation_retention_seconds: 86400,
          max_response_bytes: 262144,
          max_range_seconds: 86400,
        };
        if (source === 'trend-sensor') {
          oldResponse = dto;
          oldRequest = request;
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        }
        return HttpResponse.json(dto);
      },
    ),
  );
  let inspector = await screen.findByRole('complementary', {
    name: '对象信息',
  });
  await user.click(within(inspector).getByRole('button', { name: '查看趋势' }));
  await waitFor(() => expect(release).toBeDefined());
  try {
    await user.click(screen.getByRole('button', { name: '打开对象目录' }));
    await user.click(screen.getByRole('button', { name: '选择 Other Sensor' }));
    inspector = screen.getByRole('complementary', { name: '对象信息' });
    await user.click(
      within(inspector).getByRole('button', { name: '查看趋势' }),
    );
    expect(await within(inspector).findByText('222 degC')).toBeVisible();
    await waitFor(() => expect(oldRequest.signal.aborted).toBe(true));
  } finally {
    release(HttpResponse.json(oldResponse));
  }
  await user.click(within(inspector).getByRole('tab', { name: '详情' }));
  await user.click(within(inspector).getByRole('tab', { name: '操作' }));
  expect(
    within(inspector).getByRole('heading', { name: 'Other Sensor' }),
  ).toBeVisible();
  expect(
    within(inspector).getByRole('table', { name: '趋势读数' }),
  ).toHaveTextContent('222 degC');
  expect(within(inspector).queryByText('111 degC')).not.toBeInTheDocument();
});

test('an expired trend identity leaves the private workspace and a new login can open its own readings', async () => {
  const { user } = openTrends();
  let inspector = await screen.findByRole('complementary', {
    name: '对象信息',
  });
  await user.click(within(inspector).getByRole('button', { name: '查看趋势' }));
  await within(inspector).findByRole('table', { name: '趋势读数' });
  let authenticated = false;
  const identity = {
    user: {
      id: 'new-trend-member',
      email: 'new-trend@example.test',
      display_name: 'New Trend',
      role: 'member',
    },
    csrf_token: 'new-trend-csrf',
  };
  const denied = () =>
    HttpResponse.json(
      {
        error: {
          code: 'auth.unauthorized',
          message: 'Sign in',
          request_id: 'trend-expired',
        },
      },
      { status: 401 },
    );
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      authenticated ? HttpResponse.json(identity) : denied(),
    ),
    http.post('http://api.test/api/v1/auth/login', () => {
      authenticated = true;
      return HttpResponse.json(identity);
    }),
    http.get(
      'http://api.test/api/v1/lab/labs/trend-lab/entities/trend-sensor/trend',
      ({ request }) => {
        if (!authenticated) return denied();
        const params = new URL(request.url).searchParams;
        const from = params.get('from')!;
        const to = params.get('to')!;
        return HttpResponse.json({
          property: 'temperature',
          from,
          to,
          max_points: 600,
          raw_sample_count: 1,
          returned_sample_count: 1,
          plot_item_count: 1,
          sampling_strategy: 'first_last_min_max',
          segments: [
            {
              binding_id: 'new-identity-binding',
              run_id: 'new-identity-run',
              source: 'new-identity-source',
              quality: 'good',
              unit: 'degC',
              source_time_known: true,
              resolution_seconds: 0,
              samples: [
                {
                  id: 'new-identity-sample',
                  value: 222,
                  sequence: 1,
                  received_at: from,
                  observed_at: from,
                  expires_at: to,
                },
              ],
            },
          ],
          gaps: [],
          first_report_at: from,
          last_report_at: from,
          retained_since: from,
          captured_since: from,
          available_since: from,
          observation_retention_seconds: 86400,
          max_response_bytes: 262144,
          max_range_seconds: 86400,
        } satisfies EntityTrend);
      },
    ),
  );
  await user.click(within(inspector).getByRole('button', { name: '刷新趋势' }));
  await user.click(await screen.findByRole('button', { name: '登录' }));
  expect(
    screen.queryByRole('table', { name: '趋势读数' }),
  ).not.toBeInTheDocument();
  await user.type(screen.getByLabelText('邮箱'), 'new-trend@example.test');
  await user.type(
    screen.getByLabelText('密码', { exact: true }),
    'new-trend-password',
  );
  await user.click(screen.getByRole('button', { name: '登录' }));
  await user.click(await screen.findByRole('button', { name: '打开对象目录' }));
  await user.click(screen.getByRole('button', { name: '选择 Trend Sensor' }));
  inspector = screen.getByRole('complementary', { name: '对象信息' });
  await user.click(within(inspector).getByRole('button', { name: '查看趋势' }));
  expect(await within(inspector).findByText('222 degC')).toBeVisible();
  expect(within(inspector).queryByText('1000 degC')).not.toBeInTheDocument();
});

test('the recent-minute range queries the selected real Entity over exactly sixty seconds', async () => {
  const { user, queries } = openTrends((trend) =>
    Date.parse(trend.to) - Date.parse(trend.from) === 60000
      ? {
          ...trend,
          raw_sample_count: 1,
          returned_sample_count: 1,
          plot_item_count: 1,
          gaps: [],
          segments: [trend.segments[1]],
        }
      : trend,
  );
  const inspector = await screen.findByRole('complementary', {
    name: '对象信息',
  });
  await user.click(within(inspector).getByRole('button', { name: '查看趋势' }));
  await within(inspector).findByRole('table', { name: '趋势读数' });
  await user.click(within(inspector).getByRole('button', { name: '1 分钟' }));
  await waitFor(() => expect(queries).toHaveLength(2));
  const last = queries.at(-1)!;
  expect(last.pathname).toBe(
    '/api/v1/lab/labs/trend-lab/entities/trend-sensor/trend',
  );
  expect(
    Date.parse(last.searchParams.get('to')!) -
      Date.parse(last.searchParams.get('from')!),
  ).toBe(60000);
  expect(
    within(inspector).getByRole('table', { name: '趋势读数' }),
  ).not.toHaveTextContent('1000 degC');
});

test('only visible trends refresh from World updates at five-second intervals while manual refresh remains immediate', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const start = new Date('2026-03-09T00:00:00Z');
  vi.setSystemTime(start);
  try {
    const { user, queries, publish } = openTrends();
    const inspector = await screen.findByRole('complementary', {
      name: '对象信息',
    });
    await user.click(
      within(inspector).getByRole('button', { name: '查看趋势' }),
    );
    await within(inspector).findByRole('table', { name: '趋势读数' });
    expect(queries).toHaveLength(1);
    vi.setSystemTime(new Date(start.getTime() + 4000));
    const before = publish();
    await waitFor(() =>
      expect(screen.getByLabelText('世界版本')).toHaveTextContent(`W${before}`),
    );
    expect(queries).toHaveLength(1);
    vi.setSystemTime(new Date(start.getTime() + 5000));
    publish();
    await waitFor(() => expect(queries).toHaveLength(2));
    await waitFor(() =>
      expect(
        within(inspector).getByRole('button', { name: '刷新趋势' }),
      ).toBeEnabled(),
    );
    await user.click(
      within(inspector).getByRole('button', { name: '刷新趋势' }),
    );
    await waitFor(() => expect(queries).toHaveLength(3));
    await user.click(within(inspector).getByRole('tab', { name: '详情' }));
    vi.setSystemTime(new Date(start.getTime() + 10000));
    const hiddenVersion = publish();
    await waitFor(() =>
      expect(screen.getByLabelText('世界版本')).toHaveTextContent(
        `W${hiddenVersion}`,
      ),
    );
    expect(queries).toHaveLength(3);
    await user.click(within(inspector).getByRole('tab', { name: '操作' }));
    await waitFor(() => expect(queries).toHaveLength(4));
  } finally {
    vi.useRealTimers();
  }
});

test('loading and an empty bounded response remain distinct from known history gaps', async () => {
  const { user } = openTrends();
  let release!: (response: Response) => void;
  let query!: URL;
  server.use(
    http.get(
      'http://api.test/api/v1/lab/labs/trend-lab/entities/trend-sensor/trend',
      ({ request }) => {
        query = new URL(request.url);
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      },
    ),
  );
  const inspector = await screen.findByRole('complementary', {
    name: '对象信息',
  });
  await user.click(within(inspector).getByRole('button', { name: '查看趋势' }));
  try {
    expect(
      await within(inspector).findByRole('status', { name: '趋势加载状态' }),
    ).toHaveTextContent('正在查询趋势');
  } finally {
    const from = query.searchParams.get('from')!;
    const to = query.searchParams.get('to')!;
    release(
      HttpResponse.json({
        property: 'temperature',
        from,
        to,
        max_points: 600,
        raw_sample_count: 0,
        returned_sample_count: 0,
        plot_item_count: 1,
        sampling_strategy: 'first_last_min_max',
        segments: [],
        gaps: [{ from, to, reasons: ['collection_gap'] }],
        first_report_at: null,
        last_report_at: null,
        retained_since: from,
        captured_since: from,
        available_since: from,
        observation_retention_seconds: 86400,
        max_response_bytes: 262144,
        max_range_seconds: 86400,
      } satisfies EntityTrend),
    );
  }
  expect(await within(inspector).findByText('此范围没有样本')).toBeVisible();
  expect(within(inspector).getByText('采集缺口')).toBeVisible();
  expect(within(inspector).queryByText('趋势查询失败')).not.toBeInTheDocument();
});

test('a budget failure keeps loaded readings and their cutoff, then a narrower query recovers', async () => {
  const { user, trend } = openTrends();
  const inspector = await screen.findByRole('complementary', {
    name: '对象信息',
  });
  await user.click(within(inspector).getByRole('button', { name: '查看趋势' }));
  await within(inspector).findByRole('table', { name: '趋势读数' });
  await user.click(within(inspector).getByRole('button', { name: '24 小时' }));
  await waitFor(() =>
    expect(
      within(inspector).getByRole('button', { name: '刷新趋势' }),
    ).toBeEnabled(),
  );
  const cutoff = trend().to;
  server.use(
    http.get(
      'http://api.test/api/v1/lab/labs/trend-lab/entities/trend-sensor/trend',
      () =>
        HttpResponse.json(
          {
            error: {
              code: 'lab.trend_budget_exceeded',
              message: 'Too many sample and gap items',
              request_id: 'trend-budget',
            },
          },
          { status: 413 },
        ),
    ),
  );
  await user.click(within(inspector).getByRole('button', { name: '刷新趋势' }));
  expect(
    await within(inspector).findByText(
      '样本和缺口超出查询预算。缩短时间范围后重试。',
    ),
  ).toBeVisible();
  expect(
    within(inspector).getByRole('table', { name: '趋势读数' }),
  ).toHaveTextContent('1000 degC');
  expect(within(inspector).getByText(cutoff)).toBeVisible();
  let recoveredRange = 0;
  server.use(
    http.get(
      'http://api.test/api/v1/lab/labs/trend-lab/entities/trend-sensor/trend',
      ({ request }) => {
        const params = new URL(request.url).searchParams;
        const from = params.get('from')!;
        const to = params.get('to')!;
        recoveredRange = Date.parse(to) - Date.parse(from);
        return HttpResponse.json({
          ...trend(),
          from,
          to,
          segments: trend().segments.map((segment) => ({
            ...segment,
            samples: segment.samples.map((sample) =>
              sample.id === 'spike' ? { ...sample, value: 222 } : sample,
            ),
          })),
        });
      },
    ),
  );
  await user.click(within(inspector).getByRole('button', { name: '1 小时' }));
  await user.click(within(inspector).getByRole('button', { name: '刷新趋势' }));
  expect(await within(inspector).findByText('222 degC')).toBeVisible();
  expect(recoveredRange).toBe(3600000);
  expect(within(inspector).queryByText('趋势查询失败')).not.toBeInTheDocument();
});

test('uncertain or unknown-source-time history uses hollow markers with an explicit quality key', async () => {
  const { user } = openTrends();
  const inspector = await screen.findByRole('complementary', {
    name: '对象信息',
  });
  await user.click(within(inspector).getByRole('button', { name: '查看趋势' }));
  const chart = await within(inspector).findByRole('img', {
    name: '温度趋势 · degC',
  });
  const svg =
    chart.tagName.toLowerCase() === 'svg' ? chart : chart.querySelector('svg')!;
  expect(svg.querySelectorAll('circle[fill="var(--primary)"]')).toHaveLength(2);
  expect(
    svg.querySelectorAll(
      'circle[fill="var(--background)"][stroke="var(--warning)"]',
    ),
  ).toHaveLength(1);
  expect(
    within(inspector).getByText('空心点：质量待确认、较差或来源时间未知'),
  ).toBeVisible();
});

test('different historical units get independent chart surfaces and retain their original values', async () => {
  const { user } = openTrends((trend) => ({
    ...trend,
    raw_sample_count: 4,
    returned_sample_count: 4,
    plot_item_count: 5,
    segments: [
      ...trend.segments,
      {
        ...trend.segments[0],
        unit: 'K',
        source: 'kelvin-source',
        samples: [
          { ...trend.segments[0].samples[0], id: 'kelvin', value: 300 },
        ],
      },
    ],
  }));
  const inspector = await screen.findByRole('complementary', {
    name: '对象信息',
  });
  await user.click(within(inspector).getByRole('button', { name: '查看趋势' }));
  expect(
    await within(inspector).findByRole('img', { name: '温度趋势 · degC' }),
  ).toBeVisible();
  expect(
    within(inspector).getByRole('img', { name: '温度趋势 · K' }),
  ).toBeVisible();
  const table = within(inspector).getByRole('table', { name: '趋势读数' });
  expect(within(table).getByText('300 K')).toBeVisible();
  expect(within(table).getByText('1000 degC')).toBeVisible();
});

test('a late response from the previous range cannot replace the newly selected range', async () => {
  const { user } = openTrends();
  let release!: (response: Response) => void;
  let old!: EntityTrend;
  server.use(
    http.get(
      'http://api.test/api/v1/lab/labs/trend-lab/entities/trend-sensor/trend',
      ({ request }) => {
        const params = new URL(request.url).searchParams;
        const from = params.get('from')!;
        const to = params.get('to')!;
        const dto: EntityTrend = {
          property: 'temperature',
          from,
          to,
          max_points: 600,
          raw_sample_count: 1,
          returned_sample_count: 1,
          plot_item_count: 1,
          sampling_strategy: 'first_last_min_max',
          segments: [
            {
              binding_id: 'range-binding',
              run_id: 'range-run',
              source: 'range-source',
              quality: 'good',
              unit: 'degC',
              source_time_known: true,
              resolution_seconds: 0,
              samples: [
                {
                  id: 'range',
                  value: 222,
                  sequence: 1,
                  observed_at: from,
                  received_at: from,
                  expires_at: to,
                },
              ],
            },
          ],
          gaps: [],
          first_report_at: from,
          last_report_at: from,
          retained_since: from,
          captured_since: from,
          available_since: from,
          observation_retention_seconds: 86400,
          max_response_bytes: 262144,
          max_range_seconds: 86400,
        };
        if (Date.parse(to) - Date.parse(from) === 3600000) {
          old = {
            ...dto,
            segments: dto.segments.map((segment) => ({
              ...segment,
              samples: segment.samples.map((sample) => ({
                ...sample,
                value: 111,
              })),
            })),
          };
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        }
        return HttpResponse.json(dto);
      },
    ),
  );
  const inspector = await screen.findByRole('complementary', {
    name: '对象信息',
  });
  await user.click(within(inspector).getByRole('button', { name: '查看趋势' }));
  await within(inspector).findByRole('status', { name: '趋势加载状态' });
  try {
    await waitFor(() => expect(release).toBeDefined());
    await user.click(within(inspector).getByRole('button', { name: '6 小时' }));
    expect(await within(inspector).findByText('222 degC')).toBeVisible();
  } finally {
    release(HttpResponse.json(old));
  }
  await waitFor(() =>
    expect(
      within(inspector).getByRole('table', { name: '趋势读数' }),
    ).toHaveTextContent('222 degC'),
  );
  expect(within(inspector).queryByText('111 degC')).not.toBeInTheDocument();
  expect(
    within(inspector).getByRole('button', { name: '6 小时' }),
  ).toHaveAttribute('aria-pressed', 'true');
});

test('rendered UTC ticks and separated paths preserve a daylight-saving-day gap and isolated spike', async () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-03-09T00:00:00Z'));
  try {
    const { user } = openTrends((trend) => {
      const sample = (id: string, hour: number, value: number) => ({
        id,
        value,
        sequence: hour,
        received_at: `2026-03-08T${String(hour).padStart(2, '0')}:00:00Z`,
        observed_at: `2026-03-08T${String(hour).padStart(2, '0')}:00:00Z`,
        expires_at: `2026-03-08T${String(hour).padStart(2, '0')}:00:05Z`,
      });
      const segment = trend.segments[0];
      return {
        ...trend,
        raw_sample_count: 5,
        returned_sample_count: 5,
        plot_item_count: 7,
        segments: [
          { ...segment, samples: [sample('a0', 1, 20), sample('a1', 2, 25)] },
          {
            ...segment,
            run_id: 'second-run',
            samples: [sample('b0', 15, 25), sample('b1', 16, 27)],
          },
          {
            ...segment,
            run_id: 'isolated-run',
            samples: [sample('isolated-spike', 21, 1000)],
          },
        ],
        gaps: [
          {
            from: '2026-03-08T03:00:00Z',
            to: '2026-03-08T15:00:00Z',
            reasons: ['collection_gap'],
          },
          {
            from: '2026-03-08T17:00:00Z',
            to: '2026-03-08T21:00:00Z',
            reasons: ['run_changed'],
          },
        ],
      };
    });
    const inspector = await screen.findByRole('complementary', {
      name: '对象信息',
    });
    await user.click(
      within(inspector).getByRole('button', { name: '查看趋势' }),
    );
    await user.click(
      await within(inspector).findByRole('button', { name: '24 小时' }),
    );
    const chart = await within(inspector).findByRole('img', {
      name: '温度趋势 · degC',
    });
    const svg =
      chart.tagName.toLowerCase() === 'svg'
        ? chart
        : chart.querySelector('svg')!;
    expect(svg).not.toBeNull();
    const labels = Array.from(svg.querySelectorAll('text')).map(
      (label) => label.textContent,
    );
    expect(labels).toContain('06:00');
    expect(labels).toContain('12:00');
    expect(labels).toContain('18:00');
    const paths = Array.from(
      svg.querySelectorAll('path[stroke="var(--primary)"]'),
    );
    expect(paths).toHaveLength(2);
    const coordinates = paths
      .map((path) =>
        [
          ...path
            .getAttribute('d')!
            .matchAll(/(?:M|L)\s*(-?[\d.]+)[, ]\s*(-?[\d.]+)/g),
        ].map((match) => ({ x: Number(match[1]), y: Number(match[2]) })),
      )
      .sort((a, b) => a[0].x - b[0].x);
    const dimensions = svg.getAttribute('viewBox')!.split(/\s+/).map(Number);
    expect(
      Math.min(...coordinates[1].map((point) => point.x)) -
        Math.max(...coordinates[0].map((point) => point.x)),
    ).toBeGreaterThan(dimensions[2] * 0.3);
    const dots = Array.from(
      svg.querySelectorAll('circle[fill="var(--primary)"]'),
    );
    expect(dots).toHaveLength(5);
    const spike = dots.reduce((highest, point) =>
      Number(point.getAttribute('cy')) < Number(highest.getAttribute('cy'))
        ? point
        : highest,
    );
    expect(Number(spike.getAttribute('r'))).toBeGreaterThan(0);
    expect(Number(spike.getAttribute('cy'))).toBeGreaterThanOrEqual(0);
    expect(Number(spike.getAttribute('cy'))).toBeLessThan(dimensions[3] * 0.3);
    expect(Number(spike.getAttribute('cx'))).toBeGreaterThan(
      Math.max(...coordinates[1].map((point) => point.x)),
    );
  } finally {
    vi.useRealTimers();
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});
