import { expect, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

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
  try {
    return (await page.locator('canvas').evaluate((canvas) => {
      const target = canvas as HTMLCanvasElement & {
        getMotionDiagnostics?: () => unknown;
      };
      return target.getMotionDiagnostics?.() ?? null;
    })) as Diagnostic | null;
  } catch (error) {
    // This read-only seam contains no credential form or auth operation. Keep
    // its failure distinguishable without swallowing it or advancing motion.
    const sanitize = (value: string) =>
      value
        .replace(/https?:\/\/[^\s)]+/g, '<url>')
        .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '<uuid>')
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
        .replace(/[A-Za-z0-9_-]{40,}/g, '<redacted>')
        .slice(0, 500);
    const canvases = await page
      .locator('canvas')
      .evaluateAll((nodes) =>
        nodes.map((canvas) => {
          const box = canvas.getBoundingClientRect();
          return {
            connected: canvas.isConnected,
            worldCanvas: !!canvas.closest('.world-page'),
            width: box.width,
            height: box.height,
            getterType: typeof (
              canvas as HTMLCanvasElement & { getMotionDiagnostics?: unknown }
            ).getMotionDiagnostics,
          };
        }),
      )
      .catch(() => null);
    const evidence = process.env.LAB_NODE_EVIDENCE;
    if (evidence) {
      try {
        appendFileSync(
          join(evidence, 'motion-renderer-read-errors.jsonl'),
          JSON.stringify({
            boundary:
              'canvas locator/evaluation or actual getter; original error rethrown',
            at: new Date().toISOString(),
            name: error instanceof Error ? error.name : 'UnknownError',
            message: sanitize(
              error instanceof Error ? error.message : String(error),
            ),
            locations:
              error instanceof Error
                ? [
                    ...(error.stack ?? '').matchAll(
                      /([A-Za-z0-9_.-]+\.(?:ts|js):\d+:\d+)/g,
                    ),
                  ]
                    .map((match) => match[1])
                    .slice(0, 8)
                : [],
            canvases,
          }) + '\n',
          { mode: 0o600 },
        );
      } catch {
        /* Evidence failure must not replace the original failure. */
      }
    }
    throw error;
  }
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
  // These synchronous sampled frame checks must not accumulate Playwright
  // reporter steps for every component during the 600-second observation.
  assert.equal(bytes.length, 632);
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'LWM1');
  assert.equal(bytes[4], 1);
  assert.equal(bytes[5], 1);
  assert.equal(bytes.readUInt16LE(6), 0);
  assert.equal(bytes.readUInt32LE(36), 20);
  assert.equal(bytes.readUInt32LE(40), 6);
  assert.equal(bytes.readUInt32LE(44), 584);
  const epoch = bytes.readBigUInt64LE(8).toString();
  const sequence = bytes.readBigUInt64LE(16);
  const time = bytes.readBigUInt64LE(24);
  assert.equal(time, ((sequence - 1n) * 1_000_000_000n) / 30n);
  for (let i = 0; i < 20; i++) {
    const expected = expectedBody(i, time.toString());
    const values = [...expected.position, ...expected.quaternion];
    values.forEach((value, axis) => {
      assert(
        Math.abs(bytes.readFloatLE(48 + i * 28 + axis * 4) - value) <= 0.000001,
      );
    });
  }
  for (let i = 0; i < 6; i++) {
    const expected = 0.5 * Math.sin(Number(time) / 1e9 + i * 0.2);
    assert(Math.abs(bytes.readFloatLE(608 + i * 4) - expected) <= 0.000001);
  }
  return { epoch, sequence: sequence.toString(), time: time.toString() };
}
