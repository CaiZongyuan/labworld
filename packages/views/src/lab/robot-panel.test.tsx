import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import {
  createApiClient,
  type LabEntity,
  type DeviceTask,
} from '@labos-threejs/sdk';
import { server } from '../../../../tests/frontend/server';
import {
  simulationSession,
  sessionWorld,
} from '../../../../tests/frontend/session-fixture';
import { PreferencesProvider } from '../shell/preferences';
import { AppMessagesProvider } from '../shell/messages';
import { labApp } from './app';
import DevicePanel, {
  defaultDeviceInput,
  type EntityCommandAttempts,
} from './device-panel';

const capabilities = [
  'robot.home',
  'robot.move_joints',
  'robot.set_gripper',
  'robot.cancel',
];
const entity: LabEntity = {
  ...sessionWorld.entities[0],
  binding: {
    id: 'binding',
    entity_id: sessionWorld.entities[0].id,
    program_id: 'newton.so101.v1',
    source: 'newton',
    definition_id: 'robot',
    definition_version: '2',
    definition: sessionWorld.entities[0].definition,
  },
  program_run: {
    id: 'run',
    entity_id: sessionWorld.entities[0].id,
    binding_id: 'binding',
    program_id: 'newton.so101.v1',
    source: 'newton',
    definition_id: 'robot',
    definition_version: '2',
    definition: sessionWorld.entities[0].definition,
    configuration: {},
    status: 'running',
    started_by: 'member',
    started_at: '2026-10-13T00:00:00Z',
  },
  capabilities: capabilities.map((id) => ({
    id,
    version: '1',
    definition_supported: true,
    binding_implemented: true,
    executable: true,
    reason: 'available',
    parameters: {},
    result: {},
  })),
};
const session = {
  ...simulationSession,
  snapshot: {
    ...simulationSession.snapshot,
    initial_joints: [0, 0, 0, 0, 0, 0.7],
    physics: {
      source_kind: 'newton' as const,
      profile_id: 'so101-vial-v1' as const,
      profile_sha256: 'fixed-profile',
      live_rate_hz: 30 as const,
      control_mode: 'controlled' as const,
      profile: {
        joint_order: [
          'shoulder_pan',
          'shoulder_lift',
          'elbow_flex',
          'wrist_flex',
          'wrist_roll',
          'gripper',
        ],
        joint_limits: [
          [-1.9, 1.9],
          [-1.7, 1.7],
          [-1.69, 1.69],
          [-1.65, 1.65],
          [-2.7, 2.8],
          [-0.17, 1.74],
        ],
      },
    },
  },
};
const task: DeviceTask = {
  id: 'task',
  entity_id: entity.id,
  run_id: 'run',
  command_id: 'command',
  result_id: 'result',
  parameters: {},
  status: 'running',
  elapsed_seconds: 0,
  created_at: '2026-10-13T00:00:00Z',
};
const apiClient = createApiClient('http://localhost');
const identity = {
  user: { id: 'member', email: 'member@example.com', role: 'member' as const },
  csrf_token: 'csrf-robot',
};

function Panel({
  current = entity,
  paused = false,
}: {
  current?: LabEntity;
  paused?: boolean;
}) {
  const [attempts, setAttempts] = useState<EntityCommandAttempts>({});
  const [input, setInput] = useState(defaultDeviceInput);
  return (
    <DevicePanel
      entity={current}
      apiClient={apiClient}
      identity={identity}
      attempts={attempts}
      onAttempt={(attempt) =>
        setAttempts((previous) => ({
          ...previous,
          [attempt.input.capability]: attempt,
        }))
      }
      onRefresh={async () => {}}
      runtimeAvailable
      input={input}
      onInput={setInput}
      onSourceAttempt={() => {}}
      simulationSession={paused ? { ...session, status: 'paused' } : session}
    />
  );
}
function Wrapper({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <PreferencesProvider>
        <AppMessagesProvider app={labApp}>{children}</AppMessagesProvider>
      </PreferencesProvider>
    </QueryClientProvider>
  );
}

test('joint draft uses named profile bounds and submits only on Apply through the formal action route', async () => {
  const requests: { body: unknown; csrf: string | null; key: string | null }[] =
    [];
  server.use(
    http.post(
      'http://localhost/api/v1/lab/labs/:lab/entities/:entity/actions',
      async ({ request }) => {
        requests.push({
          body: await request.json(),
          csrf: request.headers.get('x-csrf-token'),
          key: request.headers.get('Idempotency-Key'),
        });
        return HttpResponse.json(
          {
            error: {
              code: 'lab.device_busy',
              message: 'busy',
              details: {},
              request_id: 'r',
            },
          },
          { status: 409 },
        );
      },
    ),
  );
  const user = userEvent.setup();
  render(<Panel />, { wrapper: Wrapper });
  const shoulder =
    screen.getByLabelText<HTMLInputElement>('shoulder_pan (rad)');
  expect(shoulder).toHaveAttribute('min', '-1.9');
  expect(shoulder).toHaveAttribute('max', '1.9');
  await user.clear(shoulder);
  expect(screen.getByRole('button', { name: '应用六关节目标' })).toBeDisabled();
  await user.type(shoulder, '0.5');
  expect(requests).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: '应用六关节目标' }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]).toEqual({
    body: {
      capability: 'robot.move_joints',
      parameters: { joints: [0.5, 0, 0, 0, 0, 0.7] },
    },
    csrf: 'csrf-robot',
    key: expect.any(String),
  });
  expect(await screen.findByText('请求被拒绝')).toBeVisible();
  expect(shoulder).toHaveValue(0.5);
  expect(
    screen.queryByRole('button', { name: '启动程序' }),
  ).not.toBeInTheDocument();
});

test('busy and paused tasks retain Cancel while an accepted cancellation awaits a real terminal result', () => {
  const current = { ...entity, task };
  const { rerender } = render(<Panel current={current} paused />, {
    wrapper: Wrapper,
  });
  expect(screen.getByRole('button', { name: /Home/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: /Cancel/ })).toBeEnabled();
  expect(screen.getByText(/Cancel 不会自动恢复物理/)).toBeVisible();
  rerender(
    <Panel
      current={{ ...current, task: { ...task, status: 'decelerating' } }}
      paused
    />,
  );
  expect(screen.getByText('已请求取消 · 等待结束')).toBeVisible();
  expect(screen.getByRole('button', { name: /Cancel/ })).toBeDisabled();
  expect(screen.queryByText('取消已结束')).not.toBeInTheDocument();
  rerender(
    <Panel
      current={{
        ...current,
        task: { ...task, status: 'cancelled' },
        task_result: { id: 'result', task_id: task.id, status: 'cancelled' },
      }}
    />,
  );
  expect(screen.getAllByText('取消已结束')).toHaveLength(2);
});

test('uncertain submission keeps the same key and parameters even when the server now reports a busy robot', async () => {
  const requests: { key: string | null; body: unknown }[] = [];
  server.use(
    http.post(
      'http://localhost/api/v1/lab/labs/:lab/entities/:entity/actions',
      async ({ request }) => {
        requests.push({
          key: request.headers.get('Idempotency-Key'),
          body: await request.json(),
        });
        return HttpResponse.error();
      },
    ),
  );
  const user = userEvent.setup();
  const { rerender } = render(<Panel />, { wrapper: Wrapper });
  await user.click(screen.getByRole('button', { name: /Home/ }));
  expect(
    await screen.findByText('请求受理结果未知 · 保留原请求键'),
  ).toBeVisible();
  const busy = {
    ...entity,
    task,
    capabilities: entity.capabilities.map((item) => ({
      ...item,
      executable: item.id === 'robot.cancel',
    })),
  };
  rerender(<Panel current={busy} />);
  await user.click(screen.getByRole('button', { name: '重试同一命令' }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[1]).toEqual(requests[0]);
});

test('declared capability without an implemented binding does not expose robot action controls', () => {
  render(
    <Panel
      current={{
        ...entity,
        capabilities: entity.capabilities.map((item) => ({
          ...item,
          binding_implemented: false,
          executable: false,
        })),
      }}
    />,
    { wrapper: Wrapper },
  );
  expect(
    screen.queryByRole('button', { name: /Home/ }),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText('shoulder_pan (rad)')).not.toBeInTheDocument();
});

test('interrupted source results stay unknown and a previous task result cannot label the new task completed', () => {
  render(
    <Panel
      current={{
        ...entity,
        task: { ...task, status: 'interrupted' },
        task_result: {
          id: 'old-result',
          task_id: 'old-task',
          status: 'completed',
        },
      }}
    />,
    { wrapper: Wrapper },
  );
  const status = screen.getByRole('region', { name: '当前 / 最近机器人任务' });
  expect(within(status).getByText('已中断 · 结果未知')).toBeVisible();
  expect(within(status).queryByText('动作已完成')).not.toBeInTheDocument();
  expect(within(status).getByText(/旧动作不会自动重放/)).toBeVisible();
});

test('losing the runtime binding hides controls while retaining the interrupted Task result', () => {
  render(
    <Panel
      current={{
        ...entity,
        binding: null,
        definition: {
          ...entity.definition,
          capabilities: [
            { id: 'robot.home', implemented: true, parameters: {} },
          ],
        },
        task: { ...task, status: 'interrupted' },
        task_result: {
          id: 'result',
          task_id: task.id,
          status: 'interrupted',
          reason: 'runtime_interrupted',
        },
      }}
    />,
    { wrapper: Wrapper },
  );
  expect(
    screen.queryByRole('button', { name: /Home/ }),
  ).not.toBeInTheDocument();
  expect(screen.getAllByText('已中断 · 结果未知')).toHaveLength(2);
  expect(screen.getByText(/旧动作不会自动重放/)).toBeVisible();
});

test('actual numeric joint observations remain separate from the target draft', () => {
  const values = {
    joints: [0.2, 0, 0, 0, 0, 0.7],
    velocity: [0, 0, 0, 0, 0, 0],
    phase: 'moving',
  };
  const properties = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      {
        value,
        unit: name === 'joints' ? 'rad' : name === 'velocity' ? 'rad/s' : null,
        binding_id: 'binding',
        run_id: 'run',
        sequence: 1,
        source: 'newton',
        observed_at: '2026-10-13T00:00:00Z',
        received_at: '2026-10-13T00:00:00Z',
        updated_at: '2026-10-13T00:00:00Z',
        expires_at: '2026-10-13T00:00:05Z',
        quality: 'good',
        freshness: 'current',
      },
    ]),
  );
  render(
    <Panel
      current={{
        ...entity,
        definition: {
          ...entity.definition,
          state: {
            properties: {
              joints: { type: 'array' },
              velocity: { type: 'array' },
              phase: { type: 'string' },
            },
          },
        },
        observation: {
          entity_id: entity.id,
          run_id: 'run',
          sequence: 1,
          source: 'newton',
          values,
          properties,
          received_at: '2026-10-13T00:00:00Z',
          updated_at: '2026-10-13T00:00:00Z',
          quality: 'good',
          freshness: 'current',
        },
      }}
    />,
    { wrapper: Wrapper },
  );
  expect(
    within(screen.getByRole('region', { name: '实际关节 (rad)' })).getByText(
      '0.200, 0.000, 0.000, 0.000, 0.000, 0.700 rad',
    ),
  ).toBeVisible();
  expect(screen.getByLabelText('shoulder_pan (rad)')).toHaveValue(0);
  expect(screen.getByText('移动中')).toBeVisible();
});
