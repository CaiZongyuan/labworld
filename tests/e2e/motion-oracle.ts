import { expect, type Page } from '@playwright/test';

export type Diagnostic = {
  session_id: string;
  epoch: string;
  mapping_revision: number;
  rendered_at_ms: number;
  nodes: {
    node_id: string;
    entity_id: string;
    pose_key: string;
    position: number[];
    quaternion: number[];
    sequence: string;
    sim_time_ns: string;
  }[];
};

// Fixed before execution: float32 plus <=250 ms valid interpolation segments.
export const positionToleranceM = 0.0051;
export const rotationToleranceRad = 0.0002;
export function expectedBody(index: number, timeNs: string) {
  const t = Number(BigInt(timeNs)) / 1e9;
  const phase = index * 0.2;
  const yaw = t * 0.4 + index * 0.1;
  return {
    position: [
      ((index % 5) - 2) * 1.6 + 0.45 * Math.sin(t + phase),
      0.65 + 0.15 * Math.sin(t * 2 + phase),
      (Math.floor(index / 5) - 1.5) * 1.4 + 0.35 * Math.cos(t + phase),
    ],
    quaternion: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
  };
}
export async function displayed(page: Page): Promise<Diagnostic | null> {
  return page.locator('canvas').evaluate((canvas) => {
    const target = canvas as HTMLCanvasElement & {
      getMotionDiagnostics?: () => unknown;
    };
    return target.getMotionDiagnostics?.() ?? null;
  }) as Promise<Diagnostic | null>;
}
export function assertTrajectory(value: Diagnostic, session: string) {
  expect(value.session_id).toBe(session);
  expect(value.nodes).toHaveLength(20);
  let maximumPositionError = 0;
  let maximumRotationError = 0;
  for (const node of value.nodes) {
    expect(node.pose_key).toMatch(/^synthetic\/body\/\d{2}$/);
    const index = Number(node.pose_key.split('/').at(-1));
    const expected = expectedBody(index, node.sim_time_ns);
    for (let axis = 0; axis < 3; axis++) {
      const error = Math.abs(node.position[axis] - expected.position[axis]);
      maximumPositionError = Math.max(maximumPositionError, error);
      expect(error).toBeLessThanOrEqual(positionToleranceM);
    }
    const norm = Math.hypot(...node.quaternion);
    expect(Math.abs(norm - 1)).toBeLessThanOrEqual(0.00001);
    const dot = node.quaternion.reduce(
      (sum, item, i) => sum + item * expected.quaternion[i],
      0,
    );
    const angle = 2 * Math.acos(Math.min(1, Math.abs(dot) / norm));
    maximumRotationError = Math.max(maximumRotationError, angle);
    expect(angle).toBeLessThanOrEqual(rotationToleranceRad);
  }
  return { maximumPositionError, maximumRotationError };
}
export function assertAdvanced(
  before: Diagnostic,
  after: Diagnostic,
  minimumDeltaNs = 1n,
) {
  expect(after.session_id).toBe(before.session_id);
  expect(after.epoch).toBe(before.epoch);
  expect(after.mapping_revision).toBe(before.mapping_revision);
  let movingNodes = 0;
  for (let i = 0; i < before.nodes.length; i++) {
    const previous = before.nodes[i],
      current = after.nodes[i];
    expect(current.pose_key).toBe(previous.pose_key);
    expect(
      BigInt(current.sim_time_ns) - BigInt(previous.sim_time_ns),
    ).toBeGreaterThanOrEqual(minimumDeltaNs);
    expect(BigInt(current.sequence)).toBeGreaterThan(BigInt(previous.sequence));
    const distance = Math.hypot(
      ...current.position.map((value, axis) => value - previous.position[axis]),
    );
    const dot = current.quaternion.reduce(
      (sum, value, axis) => sum + value * previous.quaternion[axis],
      0,
    );
    const angle =
      2 *
      Math.acos(
        Math.min(
          1,
          Math.abs(dot) /
            (Math.hypot(...current.quaternion) *
              Math.hypot(...previous.quaternion)),
        ),
      );
    if (distance > 0.05 || angle > 0.05) movingNodes++;
  }
  expect(movingNodes).toBe(20);
  return {
    movingNodes,
    elapsedSimulationNs: (
      BigInt(after.nodes[0].sim_time_ns) - BigInt(before.nodes[0].sim_time_ns)
    ).toString(),
  };
}
export function rawHeader(bytes: Buffer) {
  expect(bytes.length).toBe(632);
  expect(bytes.subarray(0, 4).toString('ascii')).toBe('LWM1');
  expect(bytes[4]).toBe(1);
  expect(bytes[5]).toBe(1);
  expect(bytes.readUInt16LE(6)).toBe(0);
  expect(bytes.readUInt32LE(36)).toBe(20);
  expect(bytes.readUInt32LE(40)).toBe(6);
  expect(bytes.readUInt32LE(44)).toBe(584);
  const epoch = bytes.readBigUInt64LE(8).toString();
  const sequence = bytes.readBigUInt64LE(16);
  const time = bytes.readBigUInt64LE(24);
  expect(time).toBe(((sequence - 1n) * 1_000_000_000n) / 30n);
  for (let i = 0; i < 20; i++) {
    const expected = expectedBody(i, time.toString());
    const values = [...expected.position, ...expected.quaternion];
    values.forEach((value, axis) => {
      expect(
        Math.abs(bytes.readFloatLE(48 + i * 28 + axis * 4) - value),
      ).toBeLessThanOrEqual(0.000001);
    });
  }
  for (let i = 0; i < 6; i++) {
    const expected = 0.5 * Math.sin(Number(time) / 1e9 + i * 0.2);
    expect(
      Math.abs(bytes.readFloatLE(608 + i * 4) - expected),
    ).toBeLessThanOrEqual(0.000001);
  }
  return { epoch, sequence: sequence.toString(), time: time.toString() };
}
