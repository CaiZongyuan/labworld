import {
  Box3,
  CatmullRomCurve3,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Path,
  Shape,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  type BufferGeometry,
  type Material,
  type MeshStandardMaterialParameters,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

type Triple = [number, number, number];
export const builtinKinds = [
  'bench',
  'light',
  'sensor',
  'robot',
  'labware',
  'centrifuge',
  'environment',
] as const;
export type BuiltinKind = (typeof builtinKinds)[number];

// Static representation geometry. Identity, placement and observations remain outside.
class Builder {
  readonly scene = new Group();
  private readonly geometries = new Map<string, BufferGeometry>();
  private readonly materials = new Map<string, MeshStandardMaterial>();
  material(
    name: string,
    color: string,
    parameters: MeshStandardMaterialParameters = {},
  ) {
    if (!this.materials.has(name))
      this.materials.set(
        name,
        new MeshStandardMaterial({
          name,
          color,
          roughness: 0.5,
          metalness: 0.12,
          ...parameters,
        }),
      );
    return this.materials.get(name)!;
  }
  mesh(
    parent: Group,
    name: string,
    geometry: BufferGeometry,
    material: Material,
    position: Triple = [0, 0, 0],
    rotation: Triple = [0, 0, 0],
  ) {
    const mesh = new Mesh(geometry, material);
    mesh.name = name;
    mesh.position.fromArray(position);
    mesh.rotation.set(...rotation);
    mesh.castShadow = !material.transparent;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }
  cached(key: string, create: () => BufferGeometry) {
    if (!this.geometries.has(key)) this.geometries.set(key, create());
    return this.geometries.get(key)!;
  }
  block(
    parent: Group,
    name: string,
    size: Triple,
    position: Triple,
    material: Material,
    radius = 0.025,
  ) {
    const r = Math.min(radius, Math.min(...size) / 2.05);
    return this.mesh(
      parent,
      name,
      this.cached(
        `block:${size}:${r}`,
        () => new RoundedBoxGeometry(...size, 1, r),
      ),
      material,
      position,
    );
  }
  cylinder(
    parent: Group,
    name: string,
    radius: number,
    height: number,
    position: Triple,
    material: Material,
    rotation: Triple = [0, 0, 0],
    segments = 24,
    open = false,
  ) {
    return this.mesh(
      parent,
      name,
      this.cached(
        `cylinder:${radius}:${height}:${segments}:${open}`,
        () => new CylinderGeometry(radius, radius, height, segments, 1, open),
      ),
      material,
      position,
      rotation,
    );
  }
  ring(
    parent: Group,
    name: string,
    radius: number,
    tube: number,
    position: Triple,
    material: Material,
  ) {
    return this.mesh(
      parent,
      name,
      this.cached(
        `ring:${radius}:${tube}`,
        () => new TorusGeometry(radius, tube, 8, 40),
      ),
      material,
      position,
      [Math.PI / 2, 0, 0],
    );
  }
  group(
    parent: Group,
    name: string,
    position: Triple = [0, 0, 0],
    rotation: Triple = [0, 0, 0],
  ) {
    const group = new Group();
    group.name = name;
    group.position.fromArray(position);
    group.rotation.set(...rotation);
    parent.add(group);
    return group;
  }
}

export function createBuiltinModel(kind: BuiltinKind) {
  const b = new Builder(),
    root = b.scene;
  root.name = `lab-native-v1:${kind}`;
  const ivory = b.material('ivory enamel', '#d9dfd6');
  const steel = b.material('brushed steel', '#7e9596', {
    metalness: 0.62,
    roughness: 0.34,
  });
  const dark = b.material('graphite joints', '#405053', {
    metalness: 0.12,
    roughness: 0.7,
  });
  const teal = b.material('muted teal enamel', '#4d8380', { metalness: 0.2 });
  const mint = b.material('sage trim', '#8ca99d');
  let worktopHeight: number | null = null;
  let glow: MeshStandardMaterial | null = null;
  if (kind === 'bench') {
    const width = 2.8;
    worktopHeight = 0.96;
    b.block(
      root,
      'rounded solid surface worktop',
      [width, 0.14, 1.25],
      [0, 0.89, 0],
      b.material('ivory worktop', '#e1e5dd', { roughness: 0.42 }),
      0.035,
    );
    b.block(
      root,
      'worktop shadow line',
      [width - 0.08, 0.055, 1.13],
      [0, 0.795, 0],
      dark,
      0.01,
    );
    b.block(
      root,
      'teal front edge',
      [width - 0.08, 0.02, 0.025],
      [0, 0.825, 0.578],
      teal,
      0.003,
    );
    const cabinet = b.material('sage cabinet body', '#a9beb2');
    const drawer = b.material('ivory drawer fronts', '#c1cdc4');
    for (const side of [-1, 1]) {
      const unit = b.group(root, 'three drawer cabinet', [
        side * (width / 2 - 0.49),
        0,
        0,
      ]);
      b.block(
        unit,
        'cabinet enclosure',
        [0.77, 0.78, 1.04],
        [0, 0.43, 0],
        cabinet,
      );
      b.block(
        unit,
        'recessed plinth',
        [0.71, 0.07, 0.94],
        [0, 0.095, -0.01],
        teal,
        0.008,
      );
      for (const [y, height] of [
        [0.235, 0.24],
        [0.485, 0.22],
        [0.715, 0.18],
      ]) {
        b.block(
          unit,
          'drawer front',
          [0.69, height, 0.029],
          [0, y, 0.535],
          drawer,
          0.008,
        );
        b.block(
          unit,
          'handle recess',
          [0.35, 0.043, 0.006],
          [0, y + 0.045, 0.552],
          dark,
          0.007,
        );
        b.block(
          unit,
          'steel drawer pull',
          [0.29, 0.019, 0.026],
          [0, y + 0.052, 0.567],
          steel,
          0.006,
        );
      }
      for (const x of [-0.28, 0.28])
        for (const z of [-0.36, 0.36]) {
          b.cylinder(
            unit,
            'adjustable rubber foot',
            0.053,
            0.06,
            [x, 0.03, z],
            dark,
          );
          b.cylinder(unit, 'foot collar', 0.044, 0.022, [x, 0.073, z], steel);
        }
    }
    b.block(
      root,
      'rear cross brace',
      [width - 0.15, 0.09, 0.06],
      [0, 0.23, -0.38],
      steel,
      0.015,
    );
  } else if (kind === 'sensor') {
    b.block(
      root,
      'sensor enclosure',
      [0.28, 0.37, 0.15],
      [0, 0.225, 0],
      b.material('sensor housing', '#bed0c6'),
    );
    b.block(
      root,
      'screen bezel',
      [0.215, 0.173, 0.022],
      [0, 0.275, 0.086],
      dark,
      0.008,
    );
    b.block(
      root,
      'unmarked screen',
      [0.182, 0.135, 0.005],
      [0, 0.276, 0.1],
      b.material('screen glass', '#4c6466', { roughness: 0.22 }),
      0.004,
    );
    for (const x of [-0.055, 0.005, 0.065])
      b.cylinder(root, 'sensor button', 0.012, 0.01, [x, 0.117, 0.085], steel, [
        Math.PI / 2,
        0,
        0,
      ]);
    b.block(
      root,
      'sensor foot',
      [0.2, 0.03, 0.13],
      [0, 0.015, 0],
      steel,
      0.006,
    );
    b.cylinder(root, 'probe socket', 0.017, 0.024, [0.151, 0.09, 0], steel, [
      0,
      0,
      Math.PI / 2,
    ]);
    for (let i = 0; i < 4; i++)
      b.block(
        root,
        'rear vent',
        [0.15, 0.006, 0.002],
        [0, 0.18 + i * 0.026, -0.076],
        dark,
        0.001,
      );
  } else if (kind === 'light') {
    b.cylinder(root, 'lamp weighted base', 0.3, 0.09, [0, 0.045, 0], mint);
    b.cylinder(root, 'lamp upright', 0.035, 2, [0, 1.03, 0], steel);
    b.block(root, 'lamp arm', [0.4, 0.055, 0.055], [0.17, 2.02, 0], steel);
    const head = b.group(root, 'lamp shade', [0.38, 1.99, 0], [0, 0, -0.2]);
    b.mesh(
      head,
      'open ivory shade',
      new ConeGeometry(0.25, 0.24, 32, 1, true),
      b.material('shade ivory', '#dfdbc9', { side: DoubleSide }),
    );
    glow = b.material('lamp glow', '#fff2cd', {
      emissive: '#ffe8b1',
      emissiveIntensity: 0,
      side: DoubleSide,
    });
    b.cylinder(head, 'lamp diffuser', 0.225, 0.01, [0, -0.105, 0], glow);
  } else if (kind === 'robot') {
    b.cylinder(root, 'robot mounting base', 0.31, 0.08, [0, 0.04, 0], dark);
    b.cylinder(root, 'steel base ring', 0.255, 0.026, [0, 0.088, 0], steel);
    b.cylinder(root, 'ivory pedestal', 0.2, 0.32, [0, 0.24, 0], ivory);
    b.cylinder(root, 'pedestal collar', 0.203, 0.045, [0, 0.4, 0], teal);
    const joint = (parent: Group, radius: number, width: number) => {
      b.cylinder(parent, 'joint drum', radius, width, [0, 0, 0], teal, [
        Math.PI / 2,
        0,
        0,
      ]);
      for (const side of [-1, 1])
        b.cylinder(
          parent,
          'joint end cap',
          radius * 0.72,
          0.019,
          [0, 0, side * (width / 2 + 0.003)],
          steel,
          [Math.PI / 2, 0, 0],
        );
    };
    const shoulder = b.group(root, 'shoulder', [0, 0.41, 0], [0, 0, -0.4]);
    joint(shoulder, 0.145, 0.33);
    b.block(
      shoulder,
      'upper arm',
      [0.19, 0.6, 0.23],
      [0, 0.34, 0],
      ivory,
      0.06,
    );
    const elbow = b.group(shoulder, 'elbow', [0, 0.64, 0], [0, 0, 1.15]);
    joint(elbow, 0.135, 0.27);
    b.block(elbow, 'forearm', [0.15, 0.56, 0.18], [0, 0.31, 0], ivory, 0.055);
    const wrist = b.group(elbow, 'wrist', [0, 0.6, 0], [0, 0, 1.25]);
    joint(wrist, 0.095, 0.19);
    b.block(wrist, 'gripper carriage', [0.15, 0.17, 0.12], [0, 0.13, 0], dark);
    for (const side of [-1, 1])
      b.block(
        wrist,
        'parallel steel gripper jaw',
        [0.025, 0.15, 0.065],
        [side * 0.075, 0.25, 0],
        steel,
        0.005,
      );
    b.mesh(
      root,
      'flexible service cable',
      new TubeGeometry(
        new CatmullRomCurve3([
          new Vector3(-0.16, 0.45, -0.15),
          new Vector3(0.2, 0.89, -0.16),
          new Vector3(0.36, 1.13, -0.14),
          new Vector3(0.1, 1.3, -0.13),
          new Vector3(-0.19, 1.25, -0.12),
        ]),
        20,
        0.014,
        6,
        false,
      ),
      dark,
    );
  } else if (kind === 'labware') {
    const glass = new MeshPhysicalMaterial({
      name: 'pale laboratory glass',
      color: '#b2d1cb',
      transparent: true,
      opacity: 0.34,
      roughness: 0.12,
      metalness: 0.02,
      side: DoubleSide,
    });
    b.mesh(
      root,
      'open glass vessel',
      new LatheGeometry(
        [
          new Vector2(0, 0),
          new Vector2(0.142, 0),
          new Vector2(0.154, 0.01),
          new Vector2(0.16, 0.085),
          new Vector2(0.172, 0.4),
          new Vector2(0.168, 0.409),
          new Vector2(0.163, 0.406),
          new Vector2(0.153, 0.075),
          new Vector2(0.148, 0.014),
          new Vector2(0, 0.014),
        ],
        40,
      ),
      glass,
    );
    b.ring(
      root,
      'glass lip',
      0.167,
      0.007,
      [0, 0.408, 0],
      b.material('glass edge', '#cadfda', { transparent: true, opacity: 0.7 }),
    );
    b.cylinder(
      root,
      'static sample liquid',
      0.145,
      0.205,
      [0, 0.117, 0],
      b.material('sample liquid', '#70a49f', {
        transparent: true,
        opacity: 0.68,
        roughness: 0.18,
        metalness: 0,
      }),
    );
    for (let i = 0; i < 7; i++)
      b.block(
        root,
        'volume graduation',
        [i % 2 ? 0.024 : 0.043, 0.004, 0.002],
        [0.08, 0.075 + i * 0.044, 0.146],
        b.material('graduation ink', '#f0f2e8'),
        0.001,
      );
  } else if (kind === 'centrifuge') {
    b.block(
      root,
      'bottom chassis',
      [0.88, 0.1, 0.82],
      [0, 0.07, 0],
      mint,
      0.03,
    );
    b.block(
      root,
      'left curved side',
      [0.085, 0.43, 0.82],
      [-0.423, 0.285, 0],
      ivory,
      0.035,
    );
    b.block(
      root,
      'right curved side',
      [0.085, 0.43, 0.82],
      [0.423, 0.285, 0],
      ivory,
      0.035,
    );
    b.block(
      root,
      'rear enclosure',
      [0.84, 0.43, 0.085],
      [0, 0.285, -0.392],
      ivory,
      0.03,
    );
    b.block(
      root,
      'front enclosure',
      [0.84, 0.39, 0.085],
      [0, 0.265, 0.392],
      ivory,
      0.03,
    );
    const deck = new Shape();
    deck.moveTo(-0.424, -0.385);
    deck.lineTo(0.424, -0.385);
    deck.lineTo(0.424, 0.385);
    deck.lineTo(-0.424, 0.385);
    deck.closePath();
    const aperture = new Path();
    aperture.absarc(0, 0, 0.303, 0, Math.PI * 2, true);
    deck.holes.push(aperture);
    b.mesh(
      root,
      'open rotor deck',
      new ExtrudeGeometry(deck, {
        depth: 0.025,
        bevelEnabled: true,
        bevelSegments: 1,
        steps: 1,
        bevelSize: 0.007,
        bevelThickness: 0.006,
        curveSegments: 32,
      }),
      ivory,
      [0, 0.491, 0],
      [-Math.PI / 2, 0, 0],
    );
    b.ring(root, 'steel aperture rim', 0.316, 0.015, [0, 0.53, 0], steel);
    b.block(
      root,
      'mint control fascia',
      [0.8, 0.21, 0.03],
      [0, 0.265, 0.449],
      mint,
      0.02,
    );
    b.block(
      root,
      'unmarked control screen',
      [0.29, 0.11, 0.014],
      [-0.1, 0.295, 0.47],
      dark,
      0.007,
    );
    b.cylinder(
      root,
      'speed control knob',
      0.037,
      0.026,
      [0.27, 0.29, 0.475],
      steel,
      [Math.PI / 2, 0, 0],
    );
    for (const x of [-0.31, 0.31])
      for (const z of [-0.28, 0.28])
        b.cylinder(root, 'rubber foot', 0.045, 0.035, [x, 0.0175, z], dark);
  } else {
    // Existing Environment/location marker remains a marker, not a room shell.
    b.block(
      root,
      'environment marker plate',
      [1.2, 0.03, 1.2],
      [0, 0.015, 0],
      b.material('marker sage', '#a8c1ad'),
      0.01,
    );
    b.cylinder(
      root,
      'environment marker upright',
      0.065,
      0.45,
      [0, 0.25, 0],
      mint,
    );
    b.mesh(
      root,
      'environment marker head',
      new SphereGeometry(0.11, 16, 12),
      teal,
      [0, 0.53, 0],
    );
  }
  root.updateMatrixWorld(true);
  const bounds = new Box3().setFromObject(root);
  if (kind === 'centrifuge') bounds.expandByPoint(new Vector3(0, 0.611, 0));
  return { scene: root, bounds, worktopHeight, glow };
}
