import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import fixture from './fixtures/session-boundary-v1.json';
import {
  MOTION_LIMITS,
  MotionProtocolError,
  parseMotionControl,
  parseMotionSessionAck,
  parseMotionSessionControl,
  parseMotionWelcome,
  type MotionWelcome,
} from './index.ts';

function python(operation: string, value: unknown) {
  return JSON.parse(
    execFileSync(
      process.env.PYTHON ??
        (process.platform === 'win32' ? 'python' : 'python3'),
      [resolve('tools/synthetic-motion/motion_codec.py')],
      {
        input: JSON.stringify({ operation, text: JSON.stringify(value) }),
        encoding: 'utf8',
        timeout: 10_000,
      },
    ),
  );
}

test('literal source boundary envelopes preserve u64 values across TS and Python', () => {
  expect(parseMotionSessionControl(JSON.stringify(fixture.control))).toEqual(
    fixture.control,
  );
  expect(python('session_control', fixture.control).control).toEqual(
    fixture.control,
  );
  expect(parseMotionSessionAck(JSON.stringify(fixture.ack))).toEqual(
    fixture.ack,
  );
  expect(python('session_ack', fixture.ack).ack).toEqual(fixture.ack);
  for (const action of ['pause', 'resume', 'stop']) {
    const control = { ...fixture.control, action };
    expect(python('session_control', control).control).toEqual(
      parseMotionSessionControl(JSON.stringify(control)),
    );
  }
  expect(() => parseMotionControl(JSON.stringify(fixture.control))).toThrow(
    MotionProtocolError,
  );
});

test('both lifecycle parsers reject invalid scope, unsafe revision, malformed u64 and oversized envelopes', () => {
  for (const field of [
    { session_id: 'other' },
    { transition_id: '' },
    { epoch: '01' },
    { epoch: 1 },
    { revision: true },
    { revision: -1 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { action: 'reset' },
  ]) {
    for (const [operation, parse, value] of [
      ['session_control', parseMotionSessionControl, fixture.control],
      ['session_ack', parseMotionSessionAck, fixture.ack],
    ] as const) {
      const invalid = { ...value, ...field };
      expect(() => parse(JSON.stringify(invalid))).toThrow(MotionProtocolError);
      expect(python(operation, invalid).error).toBeTruthy();
    }
  }
  for (const field of [
    { result: 'requested' },
    { last_sequence: '18446744073709551616' },
    { sim_time_ns: '-1' },
  ]) {
    const invalid = { ...fixture.ack, ...field };
    expect(() => parseMotionSessionAck(JSON.stringify(invalid))).toThrow(
      MotionProtocolError,
    );
    expect(python('session_ack', invalid).error).toBeTruthy();
  }
  const oversized = {
    ...fixture.control,
    padding: 'x'.repeat(MOTION_LIMITS.session_control_bytes),
  };
  expect(() => parseMotionSessionControl(JSON.stringify(oversized))).toThrow(
    MotionProtocolError,
  );
  expect(python('session_control', oversized)).toEqual({
    error: 'limit_exceeded',
  });
});

const welcome: MotionWelcome = {
  type: 'motion.welcome',
  version: 1,
  session_id: fixture.control.session_id,
  scene_hash: `sha256:${'a'.repeat(64)}`,
  epoch: fixture.control.epoch,
  mapping_revision: 1,
  codec: 'pose-f32-v1',
  coordinate_frame: 'rh-y-up-m',
  pose_keys: ['body'],
  joint_keys: [],
  targets: [
    {
      pose_key: 'body',
      entity_id: fixture.control.session_id,
      node_id: fixture.control.session_id,
      visual_target: 'node-root',
      body_to_visual: {
        position: [1, 2, 3],
        quaternion: [0, 1, 0, 0],
      },
    },
  ],
  rate_hz: 30,
  simulation_rate: 1,
};

test('WELCOME retains directed correction once, with frozen validated components and legacy omission', () => {
  const parsed = parseMotionWelcome(JSON.stringify(welcome));
  expect(parsed).toEqual(welcome);
  expect(python('welcome', welcome).welcome).toEqual(welcome);
  expect(Object.isFrozen(parsed.targets[0].body_to_visual?.position)).toBe(
    true,
  );
  const legacy = { ...welcome.targets[0] };
  delete legacy.body_to_visual;
  const omitted = { ...welcome, targets: [legacy] };
  expect(parseMotionWelcome(JSON.stringify(omitted))).toEqual(omitted);
  for (const correction of [
    null,
    { position: [0, 0], quaternion: [0, 0, 0, 1] },
    { position: [0, 0, 0], quaternion: [0, 0, 0, 0.5] },
    // f32 rounding crosses the tolerance; both parsers use actual wire validation.
    { position: [0, 0, 0], quaternion: [0, 0, 0, 1.001] },
    { position: [10_001, 0, 0], quaternion: [0, 0, 0, 1] },
  ]) {
    const invalid = {
      ...welcome,
      targets: [{ ...welcome.targets[0], body_to_visual: correction }],
    };
    expect(() => parseMotionWelcome(JSON.stringify(invalid))).toThrow(
      MotionProtocolError,
    );
    expect(python('welcome', invalid).error).toBeTruthy();
  }
  expect(
    parseMotionControl(
      JSON.stringify({ type: 'motion.status', state: 'paused', rate_hz: 30 }),
    ),
  ).toEqual({ type: 'motion.status', state: 'paused', rate_hz: 30 });
});
