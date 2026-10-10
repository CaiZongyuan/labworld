import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { MotionBuffer, type LabWorld } from '@labos-threejs/sdk';
import { MotionControls } from './motion-controls';
import { AppMessagesProvider } from '../shell/messages';
import { PreferencesProvider } from '../shell/preferences';
import { labApp } from './app';

test('motion dialog joins at a chosen rate, prepares with a real representation, and closing leaves the stream independently operable', async () => {
  window.localStorage.setItem('labos-threejs.locale', 'en');
  const user = userEvent.setup();
  const join = vi.fn();
  const leave = vi.fn();
  const motion = {
    buffer: new MotionBuffer(),
    state: 'disconnected' as const,
    fixture: null,
    error: null,
    rate: 30 as const,
    join,
    leave,
  };
  const world = {
    assets: [{ name: 'Test GLB', representation: { id: 'representation-id' } }],
  } as LabWorld;
  render(
    <PreferencesProvider>
      <AppMessagesProvider app={labApp}>
        <MotionControls motion={motion} world={world} disabled={false} />
      </AppMessagesProvider>
    </PreferencesProvider>,
  );
  await user.click(screen.getByRole('button', { name: /Synthetic motion/ }));
  expect(screen.getByRole('dialog')).toHaveAccessibleName('Synthetic motion');
  await user.selectOptions(screen.getByLabelText('Receive rate'), '15');
  await user.click(
    screen.getByRole('button', { name: 'Join existing session' }),
  );
  expect(join).toHaveBeenLastCalledWith(15);
  await user.click(
    screen.getByRole('button', { name: 'Prepare and join test session' }),
  );
  expect(join).toHaveBeenLastCalledWith(15, 'representation-id');
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(leave).not.toHaveBeenCalled();
});

test('a stale stream exposes frozen status and Leave while preparation is unavailable without a model', async () => {
  window.localStorage.setItem('labos-threejs.locale', 'zh');
  const user = userEvent.setup();
  const leave = vi.fn();
  render(
    <PreferencesProvider>
      <AppMessagesProvider app={labApp}>
        <MotionControls
          motion={{
            buffer: new MotionBuffer(),
            state: 'stale',
            fixture: null,
            error: null,
            rate: 15,
            join: vi.fn(),
            leave,
          }}
          world={{ assets: [] } as unknown as LabWorld}
          disabled={false}
        />
      </AppMessagesProvider>
    </PreferencesProvider>,
  );
  await user.click(screen.getByRole('button', { name: /合成运动/ }));
  expect(screen.getByRole('status')).toHaveTextContent('运动过期 · 位姿已冻结');
  expect(
    screen.getByRole('button', { name: '准备并加入测试会话' }),
  ).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '离开运动' }));
  expect(leave).toHaveBeenCalledOnce();
});
