// PROTOTYPE: real WebGL geometry and pointer interaction; device observations come from world.ts.
import { Suspense, memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  Canvas,
  useFrame,
  useThree,
  type ThreeEvent,
} from '@react-three/fiber';
import { Edges, Grid, OrbitControls, RoundedBox } from '@react-three/drei';
import { Box3, Color, Group, Plane, PointLight, Vector3 } from 'three';
import {
  model,
  patchEntity,
  snapshot,
  useWorld,
  type Asset,
  type Entity,
} from './world';

const material = {
  ivory: '#edece6',
  edge: '#c6ced0',
  steel: '#899c9f',
  dark: '#465357',
  teal: '#4c8786',
  blue: '#79a7b4',
};
function Block({
  position = [0, 0, 0],
  size = [1, 1, 1],
  color = material.ivory,
  radius = 0.025,
  ...props
}: any) {
  return (
    <RoundedBox
      args={size}
      radius={radius}
      smoothness={2}
      position={position}
      castShadow
      receiveShadow
      {...props}
    >
      <meshStandardMaterial color={color} roughness={0.48} metalness={0.12} />
    </RoundedBox>
  );
}
function Cylinder({
  position = [0, 0, 0],
  radius = 0.2,
  height = 0.1,
  color = material.steel,
  ...props
}: any) {
  return (
    <mesh position={position} castShadow receiveShadow {...props}>
      <cylinderGeometry args={[radius, radius, height, 32]} />
      <meshStandardMaterial color={color} roughness={0.4} metalness={0.22} />
    </mesh>
  );
}
function Bench({ id }: { id: string }) {
  const width = id === 'bench-01' ? 3.9 : 3.25;
  return (
    <group>
      <Block
        position={[0, 0.89, 0]}
        size={[width, 0.14, 1.25]}
        color="#eceeea"
        radius={0.035}
      />
      <Block
        position={[0, 0.8, 0]}
        size={[width - 0.08, 0.055, 1.13]}
        color={material.dark}
        radius={0.01}
      />
      {[-1, 1].map((side) => (
        <group key={side} position={[side * (width / 2 - 0.49), 0, 0]}>
          <Block
            position={[0, 0.43, 0]}
            size={[0.77, 0.78, 1.04]}
            color="#d4dcd9"
          />
          {[0.27, 0.53, 0.75].map((y) => (
            <group key={y}>
              <Block
                position={[0, y, 0.532]}
                size={[0.69, 0.18, 0.025]}
                color="#e0e5e2"
                radius={0.006}
              />
              <Block
                position={[0, y + 0.04, 0.556]}
                size={[0.29, 0.02, 0.025]}
                color={material.steel}
                radius={0.005}
              />
            </group>
          ))}
          {[-0.28, 0.28].map((x) => (
            <Cylinder
              key={x}
              position={[x, 0.035, 0.36]}
              radius={0.065}
              height={0.07}
              color={material.dark}
            />
          ))}
        </group>
      ))}
      <Block
        position={[0, 0.23, -0.38]}
        size={[width - 0.15, 0.09, 0.06]}
        color={material.steel}
      />
    </group>
  );
}
function Centrifuge({ id }: { id: string }) {
  const rotor = useRef<Group>(null);
  const lamp = useRef<any>(null);
  useFrame((_, delta) => {
    const d = model(id);
    if (rotor.current)
      rotor.current.rotation.y +=
        Math.min(delta, 0.1) * ((d?.rpm ?? 0) / 12000) * 17;
    if (lamp.current)
      lamp.current.color.set(d?.program ? '#4c9c8b' : '#7b8281');
  });
  return (
    <group>
      <Block
        position={[0, 0.26, 0]}
        size={[0.93, 0.5, 0.87]}
        color="#e6e8e3"
        radius={0.07}
      />
      <Block
        position={[0, 0.07, 0]}
        size={[0.88, 0.1, 0.82]}
        color="#aabdbb"
        radius={0.03}
      />
      <Block
        position={[0, 0.265, 0.443]}
        size={[0.8, 0.21, 0.035]}
        color="#cbdad6"
        radius={0.02}
      />
      <Block
        position={[-0.1, 0.295, 0.466]}
        size={[0.29, 0.11, 0.014]}
        color="#384f51"
        radius={0.007}
      />
      <Block
        position={[-0.1, 0.307, 0.477]}
        size={[0.19, 0.014, 0.005]}
        color="#9dcfbc"
        radius={0.002}
      />
      <Block
        position={[-0.15, 0.28, 0.478]}
        size={[0.1, 0.008, 0.005]}
        color="#79a998"
        radius={0.002}
      />
      <Cylinder
        position={[0.27, 0.29, 0.468]}
        radius={0.037}
        height={0.026}
        color="#839b99"
        rotation={[Math.PI / 2, 0, 0]}
      />
      <mesh position={[0.35, 0.33, 0.476]}>
        <circleGeometry args={[0.014, 12]} />
        <meshBasicMaterial ref={lamp} color="#4c9c8b" />
      </mesh>
      <Cylinder
        position={[0, 0.526, -0.025]}
        radius={0.345}
        height={0.03}
        color="#70878a"
      />
      <Cylinder
        position={[0, 0.55, -0.025]}
        radius={0.29}
        height={0.03}
        color="#344b50"
      />
      <group ref={rotor} position={[0, 0.586, -0.025]}>
        <Cylinder radius={0.115} height={0.036} color="#a9bfbe" />
        {[0, 1, 2, 3, 4, 5].map((n) => (
          <group key={n} rotation={[0, (n * Math.PI) / 3, 0]}>
            <Block
              position={[0.15, 0, 0]}
              size={[0.22, 0.036, 0.074]}
              color="#a6bfbc"
              radius={0.015}
            />
            <Cylinder
              position={[0.235, 0.005, 0]}
              radius={0.027}
              height={0.045}
              color="#d7eae0"
            />
          </group>
        ))}
      </group>
      <mesh position={[0, 0.62, -0.025]}>
        <cylinderGeometry args={[0.32, 0.32, 0.018, 48]} />
        <meshPhysicalMaterial
          color="#bbd6d4"
          transparent
          opacity={0.22}
          roughness={0.14}
          metalness={0.08}
          depthWrite={false}
        />
      </mesh>
      <Block
        position={[0, 0.645, -0.37]}
        size={[0.23, 0.045, 0.07]}
        color="#92a5a3"
      />
    </group>
  );
}
function Light({ id }: { id: string }) {
  const glow = useRef<any>(null);
  const illumination = useRef<PointLight>(null);
  useFrame(() => {
    const d = model(id);
    const amount = d?.on ? d.brightness / 100 : 0;
    if (glow.current) glow.current.emissiveIntensity = amount * 2;
    if (illumination.current) illumination.current.intensity = amount * 12;
  });
  return (
    <group>
      <Cylinder
        position={[0, 0.05, 0]}
        radius={0.3}
        height={0.09}
        color="#8caaa5"
      />
      <Cylinder
        position={[0, 1.03, 0]}
        radius={0.035}
        height={2}
        color="#9dacaa"
      />
      <Block
        position={[0.17, 2.02, 0]}
        size={[0.4, 0.055, 0.055]}
        color="#a2afac"
      />
      <group position={[0.38, 1.99, 0]} rotation={[0, 0, -0.2]}>
        <mesh castShadow>
          <coneGeometry args={[0.25, 0.24, 32, 1, true]} />
          <meshStandardMaterial color="#e5dfcc" side={2} />
        </mesh>
        <mesh position={[0, -0.1, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[0.225, 32]} />
          <meshStandardMaterial
            ref={glow}
            color="#fff2cd"
            emissive="#ffe8b1"
            emissiveIntensity={2}
            side={2}
          />
        </mesh>
        <pointLight
          ref={illumination}
          position={[0, -0.25, 0]}
          color="#ffe8b1"
          intensity={12}
          distance={4.2}
          decay={2}
        />
      </group>
    </group>
  );
}
function Sensor() {
  return (
    <group>
      <Block size={[0.28, 0.37, 0.15]} position={[0, 0.2, 0]} color="#d4e0dc" />
      <Block
        size={[0.2, 0.16, 0.018]}
        position={[0, 0.24, 0.09]}
        color="#51696b"
        radius={0.008}
      />
      <Block
        size={[0.13, 0.013, 0.003]}
        position={[0, 0.25, 0.102]}
        color="#b3d8ba"
        radius={0.002}
      />
      <Cylinder radius={0.017} height={0.05} position={[0, 0.035, 0]} />
      <mesh position={[0.085, 0.083, 0.086]}>
        <circleGeometry args={[0.012, 12]} />
        <meshBasicMaterial color="#77b395" />
      </mesh>
    </group>
  );
}
function Robot() {
  return (
    <group>
      <Cylinder
        position={[0, 0.04, 0]}
        radius={0.31}
        height={0.08}
        color="#576d70"
      />
      <Cylinder
        position={[0, 0.22, 0]}
        radius={0.2}
        height={0.32}
        color="#d5dcd6"
      />
      <group position={[0, 0.39, 0]} rotation={[0, 0, -0.4]}>
        <Cylinder
          radius={0.145}
          height={0.33}
          color="#819c98"
          rotation={[Math.PI / 2, 0, 0]}
        />
        <Block
          position={[0, 0.34, 0]}
          size={[0.19, 0.6, 0.23]}
          color="#e2e3d9"
          radius={0.06}
        />
        <group position={[0, 0.64, 0]} rotation={[0, 0, 1.15]}>
          <Cylinder
            radius={0.135}
            height={0.27}
            color="#7e9a96"
            rotation={[Math.PI / 2, 0, 0]}
          />
          <Block
            position={[0, 0.31, 0]}
            size={[0.15, 0.56, 0.18]}
            color="#e6e6db"
            radius={0.055}
          />
          <group position={[0, 0.6, 0]} rotation={[0, 0, 1.25]}>
            <Cylinder
              radius={0.095}
              height={0.19}
              color="#90aaa2"
              rotation={[Math.PI / 2, 0, 0]}
            />
            <Block
              position={[0, 0.13, 0]}
              size={[0.15, 0.17, 0.12]}
              color="#536b70"
            />
            {[-1, 1].map((side) => (
              <Block
                key={side}
                position={[side * 0.075, 0.25, 0]}
                size={[0.025, 0.15, 0.065]}
                color="#b0bdbc"
                radius={0.005}
              />
            ))}
          </group>
        </group>
      </group>
    </group>
  );
}
function Labware() {
  return (
    <group>
      <mesh position={[0, 0.2, 0]} castShadow>
        <cylinderGeometry args={[0.17, 0.155, 0.4, 32, 1, true]} />
        <meshPhysicalMaterial
          color="#b9d9d7"
          metalness={0.03}
          roughness={0.13}
          transparent
          opacity={0.32}
          side={2}
          depthWrite={false}
        />
      </mesh>
      <mesh position={[0, 0.12, 0]}>
        <cylinderGeometry args={[0.149, 0.142, 0.21, 32]} />
        <meshPhysicalMaterial
          color="#79aaa8"
          transparent
          opacity={0.64}
          roughness={0.18}
        />
      </mesh>
      <mesh position={[0, 0.41, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.169, 0.01, 8, 32]} />
        <meshStandardMaterial color="#cadfda" transparent opacity={0.7} />
      </mesh>
      {[0.1, 0.16, 0.22, 0.28, 0.34].map((y) => (
        <Block
          key={y}
          position={[0.12, y, 0.1]}
          size={[0.035, 0.005, 0.015]}
          color="#ebf1e8"
          radius={0.001}
        />
      ))}
    </group>
  );
}
function Imported({ asset }: { asset: Asset }) {
  const scene = useMemo(() => asset.scene?.clone(true), [asset.scene]);
  return scene ? (
    <primitive object={scene} dispose={null} />
  ) : (
    <Block size={[0.45, 0.45, 0.45]} position={[0, 0.225, 0]} />
  );
}
const sizes: Record<string, [number, number, number]> = {
  centrifuge: [1.03, 0.74, 0.97],
  bench: [3.94, 1.03, 1.28],
  robot: [1.1, 1.7, 0.8],
  sensor: [0.38, 0.48, 0.24],
  light: [0.9, 2.23, 0.65],
  labware: [0.42, 0.52, 0.42],
  model: [1, 1, 1],
  environment: [1, 1, 1],
};

const ObjectInWorld = memo(function ObjectInWorld({
  entity: e,
  asset,
  selected,
  edit,
  onSelect,
  onDrag,
  locale,
}: {
  entity: Entity;
  asset?: Asset;
  selected: boolean;
  edit: boolean;
  onSelect: (id: string) => void;
  onDrag: (drag: boolean) => void;
  locale: string;
}) {
  const drag = useRef<{
    point: Vector3;
    origin: [number, number, number];
  } | null>(null);
  const [hover, setHover] = useState(false);
  const plane = useMemo(
    () => new Plane(new Vector3(0, 1, 0), -e.position[1]),
    [e.position[1]],
  );
  const dimensions =
    e.kind === 'model' && asset?.bounds
      ? (asset.bounds as [number, number, number])
      : sizes[e.kind];
  const finish = (event: ThreeEvent<PointerEvent>) => {
    if (!drag.current) return;
    drag.current = null;
    (event.target as any).releasePointerCapture?.(event.pointerId);
    onDrag(false);
  };
  return (
    <group
      position={e.position}
      rotation={[0, (e.rotation * Math.PI) / 180, 0]}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(e.id);
      }}
      onPointerOver={(event) => {
        event.stopPropagation();
        setHover(true);
        document.body.style.cursor = edit ? 'grab' : 'pointer';
      }}
      onPointerOut={() => {
        setHover(false);
        if (!drag.current) document.body.style.cursor = '';
      }}
      onPointerDown={(event) => {
        if (!edit || event.button !== 0) return;
        event.stopPropagation();
        onSelect(e.id);
        const point = event.ray.intersectPlane(plane, new Vector3());
        if (!point) return;
        drag.current = { point: point.clone(), origin: [...e.position] };
        (event.target as any).setPointerCapture?.(event.pointerId);
        onDrag(true);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        event.stopPropagation();
        const point = event.ray.intersectPlane(plane, new Vector3());
        if (!point) return;
        const x = Math.max(
          -4,
          Math.min(4, drag.current.origin[0] + point.x - drag.current.point.x),
        );
        const z = Math.max(
          -2.7,
          Math.min(
            2.7,
            drag.current.origin[2] + point.z - drag.current.point.z,
          ),
        );
        try {
          patchEntity(e.id, {
            position: [
              Math.round(x * 20) / 20,
              e.position[1],
              Math.round(z * 20) / 20,
            ],
          });
        } catch {}
      }}
      onPointerUp={finish}
    >
      {e.kind === 'bench' ? (
        <Bench id={e.id} />
      ) : e.kind === 'centrifuge' ? (
        <Centrifuge id={e.id} />
      ) : e.kind === 'light' ? (
        <Light id={e.id} />
      ) : e.kind === 'sensor' ? (
        <Sensor />
      ) : e.kind === 'robot' ? (
        <Robot />
      ) : e.kind === 'labware' ? (
        <Labware />
      ) : e.kind === 'environment' ? (
        <Block size={[2, 0.05, 1.5]} color="#ccdad7" />
      ) : asset ? (
        <Imported asset={asset} />
      ) : null}
      {selected || hover ? (
        <mesh position={[0, dimensions[1] / 2, 0]}>
          <boxGeometry args={dimensions} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          <Edges
            color={selected ? '#2c8b97' : '#8da6a8'}
            lineWidth={selected ? 1.4 : 0.7}
          />
        </mesh>
      ) : null}
    </group>
  );
});
function Room({ dark }: { dark: boolean }) {
  return (
    <group>
      <Block
        size={[9.2, 0.18, 6.6]}
        position={[0, -0.1, 0]}
        color={dark ? '#434c4e' : '#e0e5e1'}
        radius={0.035}
      />
      <Grid
        position={[0, 0.006, 0]}
        args={[9, 6.4]}
        cellSize={0.5}
        cellThickness={0.4}
        cellColor={dark ? '#5a6567' : '#cbd3ce'}
        sectionSize={1}
        sectionThickness={0.55}
        sectionColor={dark ? '#738080' : '#b7c5bf'}
        fadeDistance={30}
        fadeStrength={1}
      />
      <Block
        position={[0, 1.2, -3.25]}
        size={[9.2, 2.42, 0.12]}
        color={dark ? '#65726f' : '#e8eae4'}
        radius={0.012}
      />
      <Block
        position={[-4.54, 1.2, 0]}
        size={[0.12, 2.42, 6.4]}
        color={dark ? '#586661' : '#dbe2da'}
        radius={0.012}
      />
      <Block
        position={[0, 0.11, -3.14]}
        size={[9, 0.2, 0.04]}
        color="#91a7a1"
        radius={0.005}
      />
      <Block
        position={[-4.44, 0.11, 0]}
        size={[0.04, 0.2, 6.3]}
        color="#91a7a1"
        radius={0.005}
      />
      {[-2.7, 0, 2.7].map((x) => (
        <group key={x} position={[x, 1.51, -3.17]}>
          <Block size={[1.98, 1.1, 0.065]} color="#b1c5c3" radius={0.01} />
          <Block
            size={[1.84, 0.97, 0.02]}
            position={[0, 0, 0.046]}
            color={dark ? '#69878a' : '#d1e5e2'}
            radius={0.005}
          />
          <Block
            size={[0.035, 1.0, 0.028]}
            position={[0, 0, 0.065]}
            color="#a8bcb9"
            radius={0.004}
          />
        </group>
      ))}
      <Block
        position={[-4.44, 1.48, -0.75]}
        size={[0.05, 0.72, 1.26]}
        color="#b3c9c2"
      />
      <Block
        position={[-4.405, 1.48, -0.75]}
        size={[0.012, 0.6, 1.14]}
        color="#eff0df"
      />
    </group>
  );
}
function CameraRig({ focus, reset, top, selected, dragging }: any) {
  const { camera, size, gl } = useThree();
  const controls = useRef<any>(null);
  useEffect(() => {
    (window as any).__FOUNDATION_PREVIEW__.project = (id: string) => {
      const entity = snapshot().layout.entities.find((e) => e.id === id);
      if (!entity) return null;
      const p = new Vector3(...entity.position)
        .add(new Vector3(0, sizes[entity.kind][1] / 2, 0))
        .project(camera);
      const box = gl.domElement.getBoundingClientRect();
      return {
        x: box.left + ((p.x + 1) * box.width) / 2,
        y: box.top + ((1 - p.y) * box.height) / 2,
      };
    };
  }, [camera, gl]);
  useEffect(() => {
    if (!controls.current) return;
    const narrow = size.width < 600;
    const target = new Vector3(0, 0.65, 0);
    const dist = narrow ? 1.19 : 1;
    camera.position.set(9 * dist, 8 * dist, 10 * dist);
    controls.current.target.copy(target);
    controls.current.update();
  }, [reset, size.width]);
  useEffect(() => {
    if (!top || !controls.current) return;
    camera.position.set(0.001, 14, 0.001);
    controls.current.target.set(0, 0, 0);
    controls.current.update();
  }, [top]);
  useEffect(() => {
    if (!focus || !selected || !controls.current) return;
    const target = new Vector3(...selected.position).add(
      new Vector3(0, 0.4, 0),
    );
    const distance = selected.kind === 'bench' ? 5 : 2.8;
    camera.position
      .copy(target)
      .add(new Vector3(distance, distance * 0.85, distance));
    controls.current.target.copy(target);
    controls.current.update();
  }, [focus]);
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enabled={!dragging}
      enableDamping
      dampingFactor={0.12}
      minDistance={1.3}
      maxDistance={30}
      maxPolarAngle={Math.PI / 2.05}
    />
  );
}
export default function LabScene({
  selectedId,
  onSelect,
  mode,
  locale,
  dark,
  focus,
  reset,
  top,
  grid,
}: any) {
  const entities = useWorld((s) => s.layout.entities);
  const assets = useWorld((s) => s.assets);
  const [dragging, setDragging] = useState(false);
  const selected = entities.find((e) => e.id === selectedId);
  return (
    <Canvas
      shadows
      dpr={[1, 1.5]}
      camera={{ position: [9, 8, 10], fov: 40 }}
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      onPointerMissed={() => {
        if (!dragging) onSelect('');
      }}
      onCreated={({ gl }) => {
        gl.setClearColor(new Color(dark ? '#303a3b' : '#edf0ee'));
        gl.domElement.setAttribute(
          'aria-label',
          locale === 'zh' ? '可交互三维实验室' : 'Interactive 3D laboratory',
        );
        gl.domElement.setAttribute('tabindex', '0');
      }}
    >
      <color attach="background" args={[dark ? '#303a3b' : '#edf0ee']} />
      <ambientLight intensity={dark ? 0.7 : 0.75} />
      <hemisphereLight args={['#e5f1f3', '#bdc9bc', 0.55]} />
      <directionalLight
        position={[1, 9, 3]}
        intensity={2.1}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-7}
        shadow-camera-right={7}
        shadow-camera-top={7}
        shadow-camera-bottom={-7}
        shadow-normalBias={0.025}
      />
      <directionalLight
        position={[-5, 5, -2]}
        intensity={0.65}
        color="#d5ebe9"
      />
      <Suspense fallback={null}>
        <Room dark={dark} />
        {grid ? (
          <Grid
            args={[26, 26]}
            position={[0, -0.2, 0]}
            cellSize={1}
            cellColor={dark ? '#445454' : '#dce3df'}
            sectionColor={dark ? '#52605e' : '#c9d4ce'}
            sectionSize={5}
            fadeDistance={22}
          />
        ) : null}
        {entities
          .filter((e) => e.visible && !e.archived)
          .map((e) => (
            <ObjectInWorld
              key={e.id}
              entity={e}
              asset={assets.find((a) => a.id === e.assetId)}
              selected={selectedId === e.id}
              edit={mode === 'edit'}
              onSelect={onSelect}
              onDrag={setDragging}
              locale={locale}
            />
          ))}
      </Suspense>
      <CameraRig
        focus={focus}
        reset={reset}
        top={top}
        selected={selected}
        dragging={dragging}
      />
    </Canvas>
  );
}
