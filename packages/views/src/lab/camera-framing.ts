import { Box3, PerspectiveCamera, Vector3 } from 'three';

/** Fit actual representation bounds; this is a view command, not a layout mutation. */
export function frameBounds(
  box: Box3,
  camera: PerspectiveCamera,
  width: number,
  height: number,
  top: boolean,
) {
  const target = box.getCenter(new Vector3());
  const radius = Math.max(box.getSize(new Vector3()).length() / 2, 0.02);
  const direction = (
    top ? new Vector3(0.00001, 1, 0.00001) : new Vector3(0.95, 0.7, 1.25)
  ).normalize();
  const right = new Vector3(0, 1, 0).cross(direction).normalize();
  const up = direction.clone().cross(right).normalize();
  const vertical = Math.tan((camera.fov * Math.PI) / 360);
  const horizontal = (vertical * width) / height;
  const corners: Vector3[] = [];
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z])
        corners.push(new Vector3(x, y, z));
  let distance = radius;
  for (let iteration = 0; iteration < 3; iteration++) {
    distance = Math.max(
      radius * 0.5,
      ...corners.flatMap((corner) => {
        const relative = corner.clone().sub(target);
        const depth = relative.dot(direction);
        return [
          depth + (Math.abs(relative.dot(right)) * 1.1) / horizontal,
          depth + (Math.abs(relative.dot(up)) * 1.1) / vertical,
        ];
      }),
    );
    if (iteration === 2) break;
    const verticalPositions = corners.map((corner) => {
      const relative = corner.clone().sub(target);
      return relative.dot(up) / (distance - relative.dot(direction));
    });
    const middle =
      (Math.min(...verticalPositions) + Math.max(...verticalPositions)) / 2;
    target.addScaledVector(up, middle * distance * 0.75);
  }
  return {
    target,
    position: target.clone().addScaledVector(direction, distance),
    near: Math.max(radius / 1000, 0.00001),
    far: Math.max(radius * 200, distance * 4),
  };
}
