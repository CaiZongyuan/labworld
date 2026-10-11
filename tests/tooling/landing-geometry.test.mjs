import assert from 'node:assert/strict';
import test from 'node:test';
import {
  B,
  prism,
  cyl,
  cone,
} from '../../apps/docs/.vitepress/theme/landing/geo.js';
import {
  serverCabinet,
  bioBin,
} from '../../apps/docs/.vitepress/theme/landing/models.js';

const rounded = (value) => Math.round(value * 1e8) / 1e8 || 0;
const localFaces = (solid, origin) =>
  solid.faces.map((face) => ({
    ...face,
    p: face.p.map((point) =>
      point.map((value, axis) => rounded(value - origin[axis])),
    ),
  }));

test('scene models provide finite depth and coordinates to the animated renderer', () => {
  for (const [model, x, y] of [
    [serverCabinet, 22.2, 2.6],
    [bioBin, 17.4, 12.8],
  ]) {
    const builder = new B('fixture');
    model(builder, x, y, 'fixture');
    for (const solid of builder.out) {
      assert.ok(
        Number.isFinite(solid.key),
        `${model.name} has an invalid depth`,
      );
      const points = [
        ...solid.faces.flatMap((face) => face.p),
        ...solid.lines.flat(),
      ];
      assert.ok(
        points.every((point) => point.every(Number.isFinite)),
        `${model.name} has invalid coordinates`,
      );
    }
  }
});

test('a moving prism keeps its front sides and top at every world position', () => {
  const footprint = [
    [-0.3, -0.15, 0],
    [0.3, -0.15, 0],
    [0.3, 0.15, 0],
    [-0.3, 0.15, 0],
  ];
  for (const origin of [
    [0, 0, 0.6],
    [3, 3, 0.6],
    [14, 10, 0.6],
    [-4, 7, 0.6],
  ]) {
    const solid = prism(
      footprint.map((point) =>
        point.map((value, axis) => value + origin[axis]),
      ),
      [0, 0, 0.12],
      'k',
    );
    const faces = localFaces(solid, origin);
    assert.equal(
      faces.length,
      3,
      'only the top and two front sides face the camera',
    );
    assert.ok(faces.some((face) => face.p.every((point) => point[2] === 0.12)));
    assert.ok(faces.some((face) => face.p.every((point) => point[0] === 0.3)));
    assert.ok(faces.some((face) => face.p.every((point) => point[1] === 0.15)));
  }
});

test('rotating cylinders and tapered cones keep their visible faces when moved', () => {
  for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
    const direction = [Math.cos(angle), Math.sin(angle), 0.2];
    for (const origin of [
      [3, 4, 0.6],
      [14, 10, 0.6],
      [-4, 7, 0.6],
    ]) {
      assert.deepEqual(
        localFaces(cyl(origin, direction, 0.15, 'k'), origin),
        localFaces(cyl([0, 0, 0], direction, 0.15, 'k'), [0, 0, 0]),
        'translation must not flip a rotating cylinder face',
      );
      assert.deepEqual(
        localFaces(cone(...origin, 0.25, 0.1, 0.4, 'k'), origin),
        localFaces(cone(0, 0, 0, 0.25, 0.1, 0.4, 'k'), [0, 0, 0]),
        'translation must not flip a tapered cone face',
      );
    }
  }
});
