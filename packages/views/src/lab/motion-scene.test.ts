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
  expect(node.userData.motion.sim_time_ns).toBe('9007199254740993');
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
