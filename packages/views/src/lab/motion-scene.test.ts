import { Group, Quaternion, Vector3 } from 'three';
import { expect, test } from 'vitest';
import { MotionBuffer } from '@labos-threejs/sdk';
import { MotionSceneController } from './motion-scene';
import {
  motionWelcome,
  motionSnapshot,
} from '../../../../tests/frontend/motion-fixture';

test('node-root world transforms account for parents while preserving GLB pivot, scale, identity and Placement', () => {
  const parent = new Group();
  parent.position.set(8, 2, -3);
  parent.rotation.y = 0.6;
  parent.scale.setScalar(2);
  const node = new Group();
  node.userData = {
    nodeId: motionWelcome.targets[0].node_id,
    entityId: motionWelcome.targets[0].entity_id,
  };
  node.scale.setScalar(0.35);
  const centeredGlb = new Group();
  centeredGlb.position.set(-7, -2, -4);
  node.add(centeredGlb);
  parent.add(node);
  const placement = {
    position: [1, 2, 3],
    rotation: [0, 0.2, 0],
    scale: [0.35, 0.35, 0.35],
  };
  const original = structuredClone(placement);
  const scene = new MotionSceneController();
  const unregister = scene.register(
    motionWelcome.targets[0].node_id,
    motionWelcome.targets[0].entity_id,
    node,
    placement,
  );
  const buffer = new MotionBuffer();
  buffer.configure(motionWelcome);
  const quaternion = new Quaternion().setFromAxisAngle(
    new Vector3(0, 1, 0),
    1.2,
  );
  buffer.push(
    motionSnapshot({
      poses: [{ position: [3, 4, 5], quaternion: quaternion.toArray() }],
    }),
    1000,
  );
  scene.update(buffer, 1000);
  const position = node.getWorldPosition(new Vector3());
  expect(position.distanceTo(new Vector3(3, 4, 5))).toBeLessThan(1e-10);
  expect(
    node.getWorldQuaternion(new Quaternion()).angleTo(quaternion),
  ).toBeLessThan(1e-7);
  expect(centeredGlb.position.toArray()).toEqual([-7, -2, -4]);
  expect(node.scale.toArray()).toEqual([0.35, 0.35, 0.35]);
  expect(node.userData.nodeId).toBe(motionWelcome.targets[0].node_id);
  expect(scene.inspect()?.nodes[0].sim_time_ns).toBe('9007199254740993');
  expect(placement).toEqual(original);
  // Inspect reads the scene itself, so a bad renderer transform cannot pass via cached protocol values.
  node.position.x += 1;
  node.updateMatrixWorld(true);
  const diagnostic = scene.inspect()!;
  expect(diagnostic.rendered_at_ms).toBe(1000);
  expect(diagnostic.nodes[0].position).toEqual(
    node.getWorldPosition(new Vector3()).toArray(),
  );
  expect(
    new Vector3()
      .fromArray(diagnostic.nodes[0].position)
      .distanceTo(new Vector3(3, 4, 5)),
  ).toBeCloseTo(2);
  scene.update(null, 1010);
  expect(node.position.toArray()).toEqual(original.position);
  expect(node.userData.motion).toBeUndefined();
  expect(scene.inspect()).toBeNull();
  unregister();
});

test('changing mapping restores old model associations and refuses mismatched Entity targets', () => {
  const scene = new MotionSceneController();
  const node = new Group();
  const placement = {
    position: [5, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  };
  scene.register(
    motionWelcome.targets[0].node_id,
    motionWelcome.targets[0].entity_id,
    node,
    placement,
  );
  const buffer = new MotionBuffer();
  buffer.configure(motionWelcome);
  buffer.push(motionSnapshot(), 0);
  scene.update(buffer, 0);
  expect(node.position.x).toBe(0);
  buffer.configure({
    ...motionWelcome,
    mapping_revision: 2,
    targets: [{ ...motionWelcome.targets[0], entity_id: 'other-entity' }],
  });
  buffer.push(motionSnapshot({ mapping_revision: 2 }), 100);
  scene.update(buffer, 100);
  expect(node.position.x).toBe(5);
  expect(node.userData.motion).toBeUndefined();
});

test('association cleanup does not overwrite layout edits when motion never owned the node', () => {
  const scene = new MotionSceneController();
  const node = new Group();
  const unregister = scene.register('node', 'entity', node, {
    position: [1, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  });
  node.position.set(4, 2, 1);
  unregister();
  expect(node.position.toArray()).toEqual([4, 2, 1]);
});

test('renderer userData replacement cannot erase displayed provenance or stop actual Object3D progress', () => {
  const scene = new MotionSceneController();
  const node = new Group();
  const target = motionWelcome.targets[0];
  const placement = {
    position: [1, 2, 3],
    rotation: [0, 0, 0],
    scale: [0.35, 0.35, 0.35],
  };
  const unregister = scene.register(
    target.node_id,
    target.entity_id,
    node,
    placement,
  );
  const buffer = new MotionBuffer();
  buffer.configure(motionWelcome);
  const first = motionSnapshot({
    poses: [{ position: [2, 4, 6], quaternion: [0, 0, 0, 1] }],
  });
  buffer.push(first, 1000);
  scene.update(buffer, 1000);
  // This is the identity userData object assigned by R3F's real group prop.
  node.userData = { nodeId: target.node_id, entityId: target.entity_id };
  const rendererData = node.userData;
  const displayed = scene.inspect()!;
  expect(displayed.nodes[0]).toMatchObject({
    position: [2, 4, 6],
    sequence: first.sequence.toString(),
    sim_time_ns: first.sim_time_ns.toString(),
  });
  expect(node.userData).toBe(rendererData);
  const next = motionSnapshot({
    sequence: first.sequence + 1n,
    sim_time_ns: first.sim_time_ns + 100_000_000n,
    poses: [
      { position: [4, 6, 8], quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2] },
    ],
  });
  buffer.push(next, 1100);
  scene.update(buffer, 1200);
  node.userData = { nodeId: target.node_id, entityId: target.entity_id };
  const current = scene.inspect()!;
  expect(current.rendered_at_ms).toBe(1200);
  expect(current.nodes[0].sequence).toBe(next.sequence.toString());
  expect(current.nodes[0].sim_time_ns).toBe(next.sim_time_ns.toString());
  expect(current.nodes[0].position).toEqual(
    node.getWorldPosition(new Vector3()).toArray(),
  );
  expect(current.nodes[0].position).toEqual([4, 6, 8]);
  expect(current.nodes[0].quaternion).toEqual(
    node.getWorldQuaternion(new Quaternion()).toArray(),
  );
  expect(node.userData).toEqual({
    nodeId: target.node_id,
    entityId: target.entity_id,
  });
  scene.reset();
  expect(scene.inspect()).toBeNull();
  expect(node.position.toArray()).toEqual(placement.position);
  expect(node.userData).toEqual({
    nodeId: target.node_id,
    entityId: target.entity_id,
  });
  scene.update(buffer, 1200);
  expect(scene.inspect()?.nodes[0].sequence).toBe(next.sequence.toString());
  unregister();
  expect(scene.inspect()).toBeNull();
  expect(node.position.toArray()).toEqual(placement.position);
  scene.update(buffer, 1210);
  expect(scene.inspect()).toBeNull();
});

test('replacing or renewing a model association restores the prior pose and rejects obsolete cleanup ownership', () => {
  const scene = new MotionSceneController();
  const firstObject = new Group();
  const replacement = new Group();
  const target = motionWelcome.targets[0];
  const placement = {
    position: [1, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  };
  const originalCleanup = scene.register(
    target.node_id,
    target.entity_id,
    firstObject,
    placement,
  );
  const buffer = new MotionBuffer();
  buffer.configure(motionWelcome);
  buffer.push(
    motionSnapshot({
      poses: [{ position: [5, 0, 0], quaternion: [0, 0, 0, 1] }],
    }),
    1000,
  );
  scene.update(buffer, 1000);
  const replacementCleanup = scene.register(
    target.node_id,
    target.entity_id,
    replacement,
    { ...placement, position: [10, 0, 0] },
  );
  expect(firstObject.position.toArray()).toEqual([1, 0, 0]);
  expect(scene.inspect()).toBeNull();
  originalCleanup();
  scene.update(buffer, 1000);
  expect(scene.inspect()?.nodes[0].position).toEqual([5, 0, 0]);
  expect(firstObject.position.toArray()).toEqual([1, 0, 0]);
  const renewedCleanup = scene.register(
    target.node_id,
    target.entity_id,
    replacement,
    { ...placement, position: [12, 0, 0] },
  );
  replacementCleanup();
  scene.update(buffer, 1000);
  expect(scene.inspect()?.nodes[0].position).toEqual([5, 0, 0]);
  renewedCleanup();
  expect(replacement.position.toArray()).toEqual([12, 0, 0]);
  expect(scene.inspect()).toBeNull();
  scene.reset();
  expect(scene.inspect()).toBeNull();
});

test('frozen body-to-visual correction is composed once in world space before the parent inverse', () => {
  const scene = new MotionSceneController();
  const parent = new Group();
  parent.position.set(5, -2, 3);
  parent.rotation.y = Math.PI / 2;
  const node = new Group();
  parent.add(node);
  const child = new Group();
  child.position.set(-7, -2, -4);
  node.add(child);
  const target = motionWelcome.targets[0];
  const placement = {
    position: [40, 20, 10],
    rotation: [0, 0, 0],
    scale: [0.35, 0.35, 0.35],
  };
  scene.register(target.node_id, target.entity_id, node, placement);
  const buffer = new MotionBuffer();
  buffer.configure({
    ...motionWelcome,
    targets: [
      {
        ...target,
        body_to_visual: {
          position: [2, 0, 0],
          quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
        },
      },
    ],
  });
  buffer.push(
    motionSnapshot({
      poses: [
        { position: [3, 4, 5], quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2] },
      ],
    }),
    1000,
  );
  scene.update(buffer, 1000);
  // Body yaw90 rotates correction +X into -Z: expected node world position=(3,4,3), yaw180.
  expect(
    node.getWorldPosition(new Vector3()).distanceTo(new Vector3(3, 4, 3)),
  ).toBeLessThan(1e-10);
  expect(
    node
      .getWorldQuaternion(new Quaternion())
      .angleTo(new Quaternion(0, 1, 0, 0)),
  ).toBeLessThan(1e-7);
  expect(node.scale.toArray()).toEqual([0.35, 0.35, 0.35]);
  expect(child.position.toArray()).toEqual([-7, -2, -4]);
  scene.update(buffer, 1010);
  expect(
    node.getWorldPosition(new Vector3()).distanceTo(new Vector3(3, 4, 3)),
  ).toBeLessThan(1e-10);
});

test('Stop releases the frozen association and restores latest saved Placement; Reset keeps the startup Placement', () => {
  const scene = new MotionSceneController();
  const node = new Group();
  const target = motionWelcome.targets[0];
  const startup = {
    position: [1, 0, 0],
    rotation: [0, 0, 0],
    scale: [0.35, 0.35, 0.35],
  };
  const cleanup = scene.register(
    target.node_id,
    target.entity_id,
    node,
    startup,
  );
  const buffer = new MotionBuffer();
  buffer.configure(motionWelcome);
  buffer.push(
    motionSnapshot({
      poses: [{ position: [5, 0, 0], quaternion: [0, 0, 0, 1] }],
    }),
    1000,
  );
  scene.update(buffer, 1000);
  const saved = {
    position: [8, 2, 1],
    rotation: [0, 0.5, 0],
    scale: [0.8, 0.8, 0.8],
  };
  // R3F applies next props before the old passive-effect cleanup.
  node.position.fromArray(saved.position);
  cleanup();
  scene.register(target.node_id, target.entity_id, node, saved);
  scene.update(null, 1010);
  expect(node.position.toArray()).toEqual(saved.position);
  expect(node.scale.toArray()).toEqual(saved.scale);
  scene.register(target.node_id, target.entity_id, node, startup);
  buffer.configure({
    ...motionWelcome,
    session_id: 'successor-session',
    epoch: '2',
  });
  expect(scene.inspect()).toBeNull();
  expect(node.position.toArray()).toEqual(startup.position);
  expect(saved.position).toEqual([8, 2, 1]);
});
