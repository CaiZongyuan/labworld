import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createApiClient, type LabEntity } from '@labos-threejs/sdk';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { server } from '../../../tests/frontend/server';
import HistoryPanel from '../../../packages/views/src/lab/history-panel';
import { AppMessagesProvider } from '../../../packages/views/src/shell/messages';
import { PreferencesProvider } from '../../../packages/views/src/shell/preferences';
import { labMessages } from '../../../packages/views/src/lab/messages';

function panel() {
  const prefix = (entries: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(entries).map(([key, value]) => [`lab.${key}`, value]),
    );
  const messages = { zh: prefix(labMessages.zh), en: prefix(labMessages.en) };
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <PreferencesProvider>
        <AppMessagesProvider app={{ messages }}>
          <HistoryPanel
            labId="lab"
            entities={[{ id: 'device', name: 'Centrifuge A' } as LabEntity]}
            selectedId="device"
            apiClient={createApiClient('http://api.test')}
          />
        </AppMessagesProvider>
      </PreferencesProvider>
    </QueryClientProvider>,
  );
}
const page = {
  record_type: 'event',
  from: '2026-10-03T00:00:00Z',
  to: '2026-10-04T00:00:00Z',
  available_since: '2026-10-03T12:00:00Z',
  gap: true,
  retention: { observation_seconds: 86400, record_seconds: 2592000 },
  items: [],
  next_cursor: null,
  max_range_seconds: 2678400,
  max_response_bytes: 262144,
};
test('history retries an error, marks gaps, and applies a new time range', async () => {
  const calls: URL[] = [];
  let fails = true;
  server.use(
    http.get(
      'http://api.test/api/v1/lab/labs/lab/entities/device/history',
      ({ request }) => {
        calls.push(new URL(request.url));
        if (fails)
          return HttpResponse.json(
            {
              error: {
                code: 'lab.unavailable',
                message: 'Unavailable',
                request_id: 'history-error',
              },
            },
            { status: 503 },
          );
        return HttpResponse.json(page);
      },
    ),
  );
  panel();
  const user = userEvent.setup();
  expect(
    await screen.findByRole('button', { name: '重试历史查询' }),
  ).toBeEnabled();
  fails = false;
  await user.click(screen.getByRole('button', { name: '重试历史查询' }));
  expect(await screen.findByText('没有保留期内记录')).toBeVisible();
  expect(screen.getByRole('status', { name: '历史缺口' })).toHaveTextContent(
    '2026',
  );
  await user.clear(screen.getByLabelText('开始时间'));
  await user.type(screen.getByLabelText('开始时间'), '2026-10-03T01:00');
  await user.clear(screen.getByLabelText('结束时间'));
  await user.type(screen.getByLabelText('结束时间'), '2026-10-04T01:00');
  await user.click(screen.getByRole('button', { name: '查询历史' }));
  await waitFor(() =>
    expect(calls.at(-1)?.searchParams.get('from')).toBe(
      new Date('2026-10-03T01:00').toISOString(),
    ),
  );
});

test('history keeps the first page during a later-page failure and retries its cursor', async () => {
  let failed = false;
  const cursors: (string | null)[] = [];
  const record = (id: string) => ({
    id,
    entity_id: 'device',
    run_id: 'run',
    recorded_at: '2026-10-03T20:00:00Z',
    observed_at: null,
    received_at: '2026-10-03T20:00:00Z',
    data: {
      status: 'completed',
      parameters: { rpm: 6000, temperature: 4, duration_seconds: 6 },
    },
  });
  server.use(
    http.get(
      'http://api.test/api/v1/lab/labs/lab/entities/device/history',
      ({ request }) => {
        const url = new URL(request.url);
        const cursor = url.searchParams.get('cursor');
        cursors.push(cursor);
        if (cursor && !failed) {
          failed = true;
          return HttpResponse.json(
            { error: { code: 'lab.unavailable', message: 'Unavailable' } },
            { status: 503 },
          );
        }
        return HttpResponse.json({
          ...page,
          gap: false,
          items: [record(cursor ? 'older-task' : 'newer-task')],
          next_cursor: cursor ? null : 'earlier',
        });
      },
    ),
  );
  panel();
  const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name: '任务' }));
  await screen.findByRole('button', { name: '更早记录' });
  await user.click(screen.getByRole('button', { name: '更早记录' }));
  expect(
    await screen.findByRole('button', { name: '重试历史查询' }),
  ).toBeEnabled();
  expect(screen.getAllByText('6000 rpm')).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: '重试历史查询' }));
  await waitFor(() => expect(screen.getAllByText('6000 rpm')).toHaveLength(2));
  expect(cursors.slice(-2)).toEqual(['earlier', 'earlier']);
  expect(
    screen.queryByRole('button', { name: '更早记录' }),
  ).not.toBeInTheDocument();
});
