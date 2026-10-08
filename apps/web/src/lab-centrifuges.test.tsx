import { useState } from 'react';
import { readFileSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createApiClient,
  type CurrentSession,
  type LabEntity,
} from '@labos-threejs/sdk';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { server } from '../../../tests/frontend/server';
import DevicePanel, {
  type EntityCommandAttempts,
  type SourceAttempt,
  defaultDeviceInput,
} from '../../../packages/views/src/lab/device-panel';
import { AppMessagesProvider } from '../../../packages/views/src/shell/messages';
import { PreferencesProvider } from '../../../packages/views/src/shell/preferences';
import { labMessages } from '../../../packages/views/src/lab/messages';

const identity = {
  user: {
    id: 'member',
    email: 'member@example.test',
    display_name: 'Member',
    role: 'member',
  },
  csrf_token: 'csrf',
} satisfies CurrentSession;
function Harness() {
  const [attempts, setAttempts] = useState<EntityCommandAttempts>({});
  const [sourceAttempt, setSourceAttempt] = useState<SourceAttempt>();
  const [input, setInput] = useState(defaultDeviceInput);
  const entity = {
    id: 'centrifuge',
    lab_id: 'lab',
    name: 'Centrifuge A',
    definition: JSON.parse(
      readFileSync('packages/server/src/lab/world/catalog.json', 'utf8'),
    ).find((entry: { id: string }) => entry.id === 'centrifuge'),
    binding: { id: 'binding', program_id: 'centrifuge.v1' },
    program_run: { id: 'run', status: 'running' },
    observation: null,
    task: null,
    task_result: null,
    capabilities: [
      { id: 'centrifuge.start', executable: true, binding_implemented: true },
      { id: 'centrifuge.stop', executable: true, binding_implemented: true },
    ],
  } as unknown as LabEntity;
  return (
    <DevicePanel
      entity={entity}
      identity={identity}
      apiClient={createApiClient('http://api.test')}
      attempts={attempts}
      onAttempt={(attempt) =>
        setAttempts((previous) => ({
          ...previous,
          [attempt.input.capability]: attempt,
        }))
      }
      sourceAttempt={sourceAttempt}
      onSourceAttempt={setSourceAttempt}
      onRefresh={async () => {}}
      runtimeAvailable
      input={input}
      onInput={setInput}
    />
  );
}
function panel() {
  const messages = {
    zh: Object.fromEntries(
      Object.entries(labMessages.zh).map(([key, value]) => [
        `lab.${key}`,
        value,
      ]),
    ),
    en: Object.fromEntries(
      Object.entries(labMessages.en).map(([key, value]) => [
        `lab.${key}`,
        value,
      ]),
    ),
  };
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <PreferencesProvider>
        <AppMessagesProvider app={{ messages }}>
          <Harness />
        </AppMessagesProvider>
      </PreferencesProvider>
    </QueryClientProvider>,
  );
}
test('a concurrent busy rejection explains cancellation and idle recovery', async () => {
  server.use(
    http.post(
      'http://api.test/api/v1/lab/labs/lab/entities/centrifuge/actions',
      () =>
        HttpResponse.json(
          {
            error: {
              code: 'lab.device_busy',
              message: 'Device busy',
              request_id: 'busy-request',
            },
          },
          { status: 409 },
        ),
    ),
  );
  panel();
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: '开始离心' }));
  expect(
    await screen.findByText('设备忙碌。停止离心并等待空闲后再试。'),
  ).toBeVisible();
  expect(screen.getByRole('button', { name: '停止离心' })).toBeEnabled();
});
test('centrifuge submits fixed typed parameters and keeps Stop available while acceptance is pending', async () => {
  const calls: unknown[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(
    http.post(
      'http://api.test/api/v1/lab/labs/lab/entities/centrifuge/actions',
      async ({ request }) => {
        const input = await request.json();
        calls.push(input);
        const commandId = `command-${calls.length}`;
        if ((input as { capability: string }).capability === 'centrifuge.start')
          await pending;
        return HttpResponse.json(
          { id: commandId, status: 'succeeded', result: null },
          { status: 202 },
        );
      },
    ),
  );
  panel();
  const user = userEvent.setup();
  await user.clear(screen.getByLabelText('目标转速 (rpm)'));
  await user.type(screen.getByLabelText('目标转速 (rpm)'), '7000');
  await user.clear(screen.getByLabelText('任务时长 (s)'));
  await user.type(screen.getByLabelText('任务时长 (s)'), '12');
  await user.click(screen.getByRole('button', { name: '开始离心' }));
  await waitFor(() =>
    expect(calls).toEqual([
      {
        capability: 'centrifuge.start',
        parameters: { rpm: 7000, temperature: 4, duration_seconds: 12 },
      },
    ]),
  );
  expect(screen.getByRole('button', { name: '开始离心' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '停止离心' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: '停止离心' }));
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1]).toEqual({ capability: 'centrifuge.stop', parameters: {} });
  release();
});
