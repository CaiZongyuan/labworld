import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { createApiClient, type EntityTrend } from '@labos-threejs/sdk';
import { render, screen, within } from '@testing-library/react';
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
      HttpResponse.json({
        version: '1',
        lab,
        entities: [entity],
        nodes: [],
        assets: [],
        relationships: [],
      }),
    ),
    http.get(
      'http://api.test/api/v1/lab/labs/trend-lab/world/subscribe',
      () =>
        new HttpResponse(
          new ReadableStream({
            start(controller) {
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
  return { user: userEvent.setup(), queries, trend: () => trend };
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
