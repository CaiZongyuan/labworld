import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import vectors from './fixtures/golden-v1.json';
import {
  decodeMotionSnapshot,
  encodeMotionSnapshot,
  MOTION_LIMITS,
  MotionProtocolError,
  parseMotionControl,
  parseMotionHello,
  parseMotionU64,
  parseMotionWelcome,
  type MotionSnapshot,
  type MotionWelcome,
} from './index.ts';

const python =
  process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const oracle = resolve('tools/synthetic-motion/motion_codec.py');
function crossLanguage(input: object) {
  return JSON.parse(
    execFileSync(python, [oracle], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      timeout: 10_000,
    }),
  );
}
function fromJson(
  value: (typeof vectors.vectors)[number]['snapshot'],
): MotionSnapshot {
  return {
    ...value,
    epoch: BigInt(value.epoch),
    sequence: BigInt(value.sequence),
    sim_time_ns: BigInt(value.sim_time_ns),
    poses: value.poses.map((pose) => ({
      position: [pose.position[0], pose.position[1], pose.position[2]],
      quaternion: [
        pose.quaternion[0],
        pose.quaternion[1],
        pose.quaternion[2],
        pose.quaternion[3],
      ],
    })),
  };
}
function fails(action: () => unknown, code: string) {
  expect(action).toThrow(MotionProtocolError);
  try {
    action();
  } catch (error) {
    expect((error as MotionProtocolError).code).toBe(code);
  }
}

for (const vector of vectors.vectors) {
  test(`literal golden vector crosses TS and Python in both directions: ${vector.name}`, () => {
    const snapshot = fromJson(vector.snapshot);
    const tsBytes = encodeMotionSnapshot(snapshot);
    expect(Buffer.from(tsBytes).toString('hex')).toBe(vector.hex);
    expect(tsBytes.byteLength).toBe(
      48 + 28 * snapshot.poses.length + 4 * snapshot.joints.length,
    );
    expect(decodeMotionSnapshot(Buffer.from(vector.hex, 'hex'))).toEqual(
      snapshot,
    );
    expect(
      crossLanguage({
        operation: 'decode',
        hex: Buffer.from(tsBytes).toString('hex'),
      }).snapshot,
    ).toEqual(vector.snapshot);
    const pythonHex = crossLanguage({
      operation: 'encode',
      snapshot: vector.snapshot,
    }).hex;
    expect(pythonHex).toBe(vector.hex);
    expect(decodeMotionSnapshot(Buffer.from(pythonHex, 'hex'))).toEqual(
      snapshot,
    );
  });
}

for (const specimen of vectors.malformed) {
  test(`both codecs reject malformed ${specimen.name}`, () => {
    const bytes = Buffer.from(vectors.vectors[0].hex, 'hex');
    bytes.set(Buffer.from(specimen.hex, 'hex'), specimen.offset);
    fails(() => decodeMotionSnapshot(bytes), specimen.code);
    expect(
      crossLanguage({ operation: 'decode', hex: bytes.toString('hex') }),
    ).toEqual({ error: specimen.code });
  });
}

test('decoder honors pooled Buffer, typed-array subview and DataView offsets', () => {
  const bytes = Buffer.from(vectors.vectors[0].hex, 'hex');
  const pooled = Buffer.allocUnsafe(4096);
  pooled.fill(0xa5);
  bytes.copy(pooled, 73);
  const subview = pooled.subarray(73, 73 + bytes.byteLength);
  for (const source of [
    subview,
    new Uint8Array(subview.buffer, subview.byteOffset, subview.byteLength),
    new DataView(subview.buffer, subview.byteOffset, subview.byteLength),
  ])
    expect(decodeMotionSnapshot(source)).toEqual(
      fromJson(vectors.vectors[0].snapshot),
    );
});

test('full snapshot rejects trailing/truncated bytes, oversized messages and mismatched admission', () => {
  const bytes = Buffer.from(vectors.vectors[0].hex, 'hex');
  for (const source of [
    bytes.subarray(0, 47),
    bytes.subarray(0, 79),
    Buffer.concat([bytes, Buffer.of(0)]),
  ]) {
    fails(() => decodeMotionSnapshot(source), 'invalid_length');
    expect(
      crossLanguage({ operation: 'decode', hex: source.toString('hex') }),
    ).toEqual({ error: 'invalid_length' });
  }
  fails(
    () => decodeMotionSnapshot(new Uint8Array(MOTION_LIMITS.binary_bytes + 1)),
    'limit_exceeded',
  );
  const expected = {
    epoch: 9007199254740993n,
    mapping_revision: 16909060,
    body_count: 1,
    joint_count: 1,
  };
  expect(decodeMotionSnapshot(bytes, expected).epoch).toBe(expected.epoch);
  for (const field of [
    'mapping_revision',
    'body_count',
    'joint_count',
  ] as const) {
    const mismatch = { ...expected, [field]: expected[field] + 1 };
    fails(() => decodeMotionSnapshot(bytes, mismatch), 'mapping_mismatch');
    expect(
      crossLanguage({
        operation: 'decode',
        hex: bytes.toString('hex'),
        expected: { ...mismatch, epoch: String(mismatch.epoch) },
      }),
    ).toEqual({ error: 'mapping_mismatch' });
  }
  fails(
    () => decodeMotionSnapshot(bytes, { ...expected, epoch: 1n }),
    'epoch_mismatch',
  );
  expect(
    crossLanguage({
      operation: 'decode',
      hex: bytes.toString('hex'),
      expected: { ...expected, epoch: '1' },
    }),
  ).toEqual({ error: 'epoch_mismatch' });
});

test('encoder rejects u64 wrap/number coercion and invalid floats without normalizing quaternion', () => {
  const base = fromJson(vectors.vectors[0].snapshot);
  for (const integer of [-1n, 1n << 64n, 1 as unknown as bigint])
    fails(
      () => encodeMotionSnapshot({ ...base, epoch: integer }),
      'invalid_u64',
    );
  for (const value of [
    '-1',
    '01',
    '+1',
    '1e3',
    '18446744073709551616',
    '9007199254740993.0',
  ])
    fails(() => parseMotionU64(value), 'invalid_u64');
  expect(parseMotionU64('18446744073709551615')).toBe((1n << 64n) - 1n);
  fails(
    () =>
      encodeMotionSnapshot({
        ...base,
        poses: [{ position: [0, 0, 0], quaternion: [0, 0, 0, 0.9] }],
      }),
    'invalid_quaternion',
  );
  fails(
    () => encodeMotionSnapshot({ ...base, joints: [Infinity] }),
    'invalid_number',
  );
  fails(
    () =>
      encodeMotionSnapshot({
        ...base,
        poses: Array(MOTION_LIMITS.bodies + 1).fill(base.poses[0]),
      }),
    'limit_exceeded',
  );
});

const id = '12345678-1234-1234-1234-123456789abc';
const welcome: MotionWelcome = {
  type: 'motion.welcome',
  version: 1,
  session_id: id,
  scene_hash: `sha256:${'a'.repeat(64)}`,
  epoch: '9007199254740993',
  mapping_revision: 1,
  codec: 'pose-f32-v1',
  coordinate_frame: 'rh-y-up-m',
  pose_keys: ['synthetic/body/00'],
  joint_keys: [],
  targets: [
    {
      pose_key: 'synthetic/body/00',
      entity_id: id,
      node_id: id,
      visual_target: 'node-root',
    },
  ],
  rate_hz: 30,
  simulation_rate: 1,
};
test('typed admission and immutable WELCOME are bounded and cross-language validated', () => {
  const json = JSON.stringify(welcome);
  const parsed = parseMotionWelcome(json);
  expect(parsed).toEqual(welcome);
  expect(Object.isFrozen(parsed.targets[0])).toBe(true);
  expect(Object.isFrozen(parsed.pose_keys)).toBe(true);
  expect(parseMotionControl(json)).toEqual(welcome);
  expect(crossLanguage({ operation: 'welcome', text: json }).welcome).toEqual(
    welcome,
  );
  const hello = {
    type: 'motion.hello',
    version: 1,
    role: 'viewer',
    session_id: id,
    codec: 'pose-f32-v1',
    ticket: 'a'.repeat(32),
    preferred_rate_hz: 15,
  };
  expect(parseMotionHello(JSON.stringify(hello))).toEqual(hello);
  expect(
    parseMotionHello(
      JSON.stringify({
        ...hello,
        role: 'publisher',
        scene_hash: welcome.scene_hash,
      }),
    ).role,
  ).toBe('publisher');
  fails(
    () => parseMotionHello(JSON.stringify({ ...hello, role: 'publisher' })),
    'invalid_message',
  );
  fails(
    () =>
      parseMotionHello(JSON.stringify({ ...hello, preferred_rate_hz: 120 })),
    'invalid_message',
  );
  fails(
    () => parseMotionHello(' '.repeat(MOTION_LIMITS.hello_bytes + 1)),
    'limit_exceeded',
  );
  expect(
    parseMotionControl('{"type":"motion.status","state":"live","rate_hz":30}')
      .type,
  ).toBe('motion.status');
  expect(
    parseMotionControl(
      '{"type":"motion.error","code":"unauthorized","message":"Admission rejected"}',
    ).type,
  ).toBe('motion.error');
});

test('WELCOME rejects dictionary ambiguity, target mismatch, invalid integers and excessive control data', () => {
  for (const invalid of [
    { ...welcome, epoch: '01' },
    { ...welcome, pose_keys: ['x', 'x'] },
    { ...welcome, targets: [] },
    { ...welcome, targets: [{ ...welcome.targets[0], pose_key: 'wrong' }] },
    { ...welcome, simulation_rate: 0 },
    { ...welcome, scene_hash: 'private-not-hashed' },
    { ...welcome, joint_keys: ['\ud800'] },
  ]) {
    expect(() => parseMotionWelcome(JSON.stringify(invalid))).toThrow(
      MotionProtocolError,
    );
    expect(
      crossLanguage({ operation: 'welcome', text: JSON.stringify(invalid) })
        .error,
    ).toBeTruthy();
  }
  fails(
    () => parseMotionWelcome(' '.repeat(MOTION_LIMITS.control_bytes + 1)),
    'limit_exceeded',
  );
  fails(() => parseMotionControl('{}'), 'invalid_message');
  fails(() => parseMotionControl('null'), 'invalid_message');
});
