import {
  memo,
  useEffect,
  useMemo,
  useRef,
  type ComponentRef,
  type RefObject,
} from 'react';
import {
  Canvas,
  useFrame,
  useThree,
  type ThreeEvent,
} from '@react-three/fiber';
import {
  Edges,
  Grid,
  OrbitControls,
  RoundedBox,
  TransformControls,
} from '@react-three/drei';
import { CanvasTexture, Group, OrthographicCamera, Vector3 } from 'three';
import type { Device, Position } from './simulator';
import { active, phaseLabels } from './simulator';

export type CameraAction = {
  key: number;
  kind: 'reset' | 'focus' | 'top' | 'in' | 'out';
  position?: Position;
};
function Block({
  position = [0, 0, 0],
  size,
  color = '#eef0f1',
  radius = 0.035,
}: {
  position?: Position;
  size: Position;
  color?: string;
  radius?: number;
}) {
  return (
    <RoundedBox
      args={size}
      position={position}
      radius={radius}
      smoothness={2}
      castShadow
      receiveShadow
    >
      <meshStandardMaterial color={color} roughness={0.48} metalness={0.12} />
    </RoundedBox>
  );
}
function Cylinder({
  position = [0, 0, 0],
  radius,
  height,
  color = '#a7b4bc',
  rotation,
}: {
  position?: Position;
  radius: number;
  height: number;
  color?: string;
  rotation?: Position;
}) {
  return (
    <mesh position={position} rotation={rotation} castShadow receiveShadow>
      <cylinderGeometry args={[radius, radius, height, 24]} />
      <meshStandardMaterial color={color} metalness={0.35} roughness={0.42} />
    </mesh>
  );
}
function Sign({
  label,
  position,
  width = 1.8,
  height = 0.45,
  color = '#485365',
}: {
  label: string;
  position: Position;
  width?: number;
  height?: number;
  color?: string;
}) {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 768;
    canvas.height = 192;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = color;
    ctx.font = '600 74px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 384, 96);
    return new CanvasTexture(canvas);
  }, [label, color]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <mesh position={position}>
      <planeGeometry args={[width, height]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} />
    </mesh>
  );
}
const Room = memo(function Room({
  dark,
  grid,
}: {
  dark: boolean;
  grid: boolean;
}) {
  return (
    <group>
      <Block
        position={[0, -0.18, 0]}
        size={[11.5, 0.32, 8]}
        color={dark ? '#50545b' : '#e0e5e9'}
        radius={0.07}
      />
      <Block
        position={[0, -0.005, 0]}
        size={[11.35, 0.03, 7.85]}
        color={dark ? '#656a70' : '#f3f5f6'}
        radius={0.015}
      />
      <Block
        position={[0, 1.35, -3.94]}
        size={[11.5, 2.7, 0.16]}
        color={dark ? '#747d88' : '#e9edf0'}
      />
      <Block
        position={[-5.64, 1.35, -1.05]}
        size={[0.17, 2.7, 5.8]}
        color={dark ? '#858b94' : '#f7f8f9'}
      />
      <Block
        position={[0, 0.12, -3.81]}
        size={[11.3, 0.18, 0.06]}
        color="#bac3cc"
        radius={0.005}
      />
      <Block
        position={[-5.53, 0.12, -1.1]}
        size={[0.06, 0.18, 5.65]}
        color="#bac3cc"
        radius={0.005}
      />
      {[-3, -1, 1, 3].map((x) => (
        <Block
          key={x}
          position={[x, 0.018, 0]}
          size={[0.012, 0.008, 7.8]}
          color={dark ? '#717981' : '#dce2e7'}
          radius={0.001}
        />
      ))}
      {[-2, 0, 2].map((z) => (
        <Block
          key={z}
          position={[0, 0.018, z]}
          size={[11.3, 0.008, 0.012]}
          color={dark ? '#717981' : '#dce2e7'}
          radius={0.001}
        />
      ))}
      <Sign
        label="LAB WORD"
        position={[-2.75, 2.08, -3.83]}
        width={2.8}
        height={0.55}
        color={dark ? '#f5f6f7' : '#536475'}
      />
      <Sign
        label="B2 / 07"
        position={[-2.75, 1.55, -3.82]}
        width={1.45}
        height={0.29}
        color={dark ? '#c5d1de' : '#8b99a7'}
      />
      <Block
        position={[4.35, 1.3, -3.81]}
        size={[1.3, 2.55, 0.12]}
        color="#aebbc7"
      />
      <Block
        position={[4.35, 1.28, -3.72]}
        size={[1.17, 2.4, 0.06]}
        color="#d8e2e8"
      />
      <Block
        position={[4.35, 1.63, -3.67]}
        size={[0.86, 1.18, 0.025]}
        color="#95b9cd"
        radius={0.008}
      />
      <Block
        position={[4.78, 0.97, -3.65]}
        size={[0.06, 0.28, 0.05]}
        color="#647b8a"
        radius={0.009}
      />
      <Sign
        label="07"
        position={[4.35, 2.57, -3.65]}
        width={0.42}
        height={0.22}
      />
      {[-0.1, 1.4, 2.9].map((x) => (
        <group key={x} position={[x, 0, -3.25]}>
          <Block
            position={[0, 1.13, 0]}
            size={[1.32, 2.25, 0.95]}
            color="#d8e1e7"
          />
          <Block
            position={[0, 0.4, 0.49]}
            size={[1.22, 0.68, 0.035]}
            color="#e9eef1"
            radius={0.006}
          />
          <Block
            position={[0, 1.42, 0.49]}
            size={[1.17, 1.24, 0.035]}
            color="#99bccc"
            radius={0.006}
          />
          <Block
            position={[0, 1.42, 0.52]}
            size={[0.025, 1.3, 0.025]}
            color="#d9e5ea"
            radius={0.002}
          />
          {[1.0, 1.5, 1.96].map((y) => (
            <Block
              key={y}
              position={[0, y, 0.515]}
              size={[1.16, 0.025, 0.026]}
              color="#d0dfe7"
              radius={0.002}
            />
          ))}
          <Block
            position={[0.1, 1.35, 0.55]}
            size={[0.035, 0.28, 0.03]}
            color="#657f91"
            radius={0.004}
          />
        </group>
      ))}
      <Block
        position={[-4.95, 0.72, -2.85]}
        size={[1, 1.4, 1.1]}
        color="#f4f5f6"
      />
      <Block
        position={[-4.95, 0.75, -2.27]}
        size={[0.88, 1.2, 0.04]}
        color="#d9e2e6"
        radius={0.012}
      />
      <Block
        position={[-4.61, 0.95, -2.23]}
        size={[0.045, 0.4, 0.05]}
        color="#7a91a1"
      />
      <Sign
        label="4°C"
        position={[-4.95, 1.8, -3.82]}
        width={0.75}
        height={0.3}
      />
      <Block
        position={[0, 0.025, 3.15]}
        size={[10.1, 0.01, 0.055]}
        color="#d5b46d"
        radius={0.002}
      />
      <Block
        position={[5.05, 0.025, -0.2]}
        size={[0.055, 0.01, 6.7]}
        color="#d5b46d"
        radius={0.002}
      />
      {grid && (
        <Grid
          position={[0, 0.032, 0]}
          args={[11.3, 7.8]}
          cellSize={0.5}
          cellThickness={0.6}
          cellColor="#a4b7cb"
          sectionSize={2}
          sectionColor="#6f94b4"
          fadeDistance={25}
        />
      )}
    </group>
  );
});
function Bench({
  position,
  width,
  label,
}: {
  position: Position;
  width: number;
  label: string;
}) {
  return (
    <group position={position}>
      <Block
        position={[0, 0.97, 0]}
        size={[width, 0.13, 1.32]}
        color="#f6f8f9"
      />
      <Block
        position={[0, 0.89, 0]}
        size={[width - 0.06, 0.045, 1.2]}
        color="#6c808d"
        radius={0.008}
      />
      {[-1, 1].map((side) => (
        <group key={side} position={[side * (width / 2 - 0.52), 0, 0]}>
          <Block
            position={[0, 0.46, 0]}
            size={[0.88, 0.87, 1.13]}
            color="#cfdae1"
          />
          {[0.28, 0.55, 0.79].map((y) => (
            <group key={y}>
              <Block
                position={[0, y, 0.58]}
                size={[0.79, 0.21, 0.025]}
                color="#e7edf1"
                radius={0.006}
              />
              <Block
                position={[0, y + 0.06, 0.602]}
                size={[0.28, 0.026, 0.025]}
                color="#8fa3b1"
                radius={0.003}
              />
            </group>
          ))}
        </group>
      ))}
      <Block
        position={[0, 0.18, 0.4]}
        size={[width - 0.3, 0.055, 0.055]}
        color="#8ba0af"
      />
      <Sign
        label={label}
        position={[0, 0.87, 0.685]}
        width={0.8}
        height={0.17}
      />
    </group>
  );
}
function Centrifuge({ device }: { device: Device }) {
  const rotor = useRef<Group>(null);
  useFrame((_, delta) => {
    if (rotor.current) rotor.current.rotation.y += (delta * device.rpm) / 650;
  });
  return (
    <group>
      <Block
        position={[0, 0.3, 0]}
        size={[1.05, 0.58, 0.92]}
        color="#f1f4f6"
        radius={0.085}
      />
      <Block position={[0, 0.09, 0]} size={[0.98, 0.1, 0.87]} color="#a2b6c6" />
      <Block
        position={[0, 0.29, 0.46]}
        size={[0.91, 0.23, 0.025]}
        color="#d0dfe9"
        radius={0.025}
      />
      <Block
        position={[-0.14, 0.32, 0.48]}
        size={[0.31, 0.12, 0.022]}
        color="#294954"
        radius={0.008}
      />
      <Block
        position={[-0.15, 0.33, 0.496]}
        size={[0.22, 0.015, 0.01]}
        color="#75d4bd"
        radius={0.002}
      />
      <Cylinder
        position={[0.31, 0.31, 0.49]}
        radius={0.04}
        height={0.024}
        rotation={[Math.PI / 2, 0, 0]}
        color="#7794a8"
      />
      <Cylinder
        position={[0, 0.6, 0]}
        radius={0.36}
        height={0.035}
        color="#7392a3"
      />
      <Cylinder
        position={[0, 0.63, 0]}
        radius={0.3}
        height={0.035}
        color="#38546a"
      />
      <group ref={rotor} position={[0, 0.66, 0]}>
        <Cylinder radius={0.11} height={0.045} color="#abc2d0" />
        {[0, 1, 2, 3, 4, 5].map((n) => (
          <group key={n} rotation={[0, (n * Math.PI) / 3, 0]}>
            <Block
              position={[0.16, 0, 0]}
              size={[0.23, 0.027, 0.08]}
              color="#a8c3d0"
              radius={0.008}
            />
            <Cylinder
              position={[0.25, 0.015, 0]}
              radius={0.027}
              height={0.052}
              color="#a8d4cf"
            />
          </group>
        ))}
      </group>
      <mesh position={[0, 0.69, 0]}>
        <cylinderGeometry args={[0.33, 0.33, 0.025, 32]} />
        <meshPhysicalMaterial
          transparent
          opacity={0.24}
          color="#cce9f5"
          roughness={0.2}
          depthWrite={false}
        />
      </mesh>
      <Block
        position={[0, 0.71, -0.37]}
        size={[0.28, 0.05, 0.1]}
        color="#8aa9ba"
      />
    </group>
  );
}
function Robot() {
  return (
    <group>
      <Block
        position={[0, 0.16, 0]}
        size={[0.85, 0.32, 0.85]}
        color="#d3dee6"
        radius={0.05}
      />
      <Cylinder
        position={[0, 0.39, 0]}
        radius={0.27}
        height={0.16}
        color="#5c788b"
      />
      <Cylinder
        position={[0, 0.7, 0]}
        radius={0.17}
        height={0.48}
        color="#eef2f5"
      />
      <Cylinder
        position={[0, 0.99, 0]}
        radius={0.21}
        height={0.3}
        color="#cfad63"
        rotation={[Math.PI / 2, 0, 0]}
      />
      <group position={[0, 1.03, 0]} rotation={[0, 0, -0.7]}>
        <Cylinder
          position={[0, 0.4, 0]}
          radius={0.13}
          height={0.68}
          color="#e8eff3"
        />
        <Cylinder
          position={[0, 0.76, 0]}
          radius={0.18}
          height={0.25}
          color="#d3b570"
          rotation={[Math.PI / 2, 0, 0]}
        />
        <group position={[0, 0.75, 0]} rotation={[0, 0, 1.45]}>
          <Cylinder
            position={[0, 0.34, 0]}
            radius={0.11}
            height={0.56}
            color="#f0f3f5"
          />
          <Cylinder
            position={[0, 0.64, 0]}
            radius={0.14}
            height={0.16}
            color="#7b99ac"
          />
          <Block
            position={[0, 0.79, 0]}
            size={[0.21, 0.22, 0.16]}
            color="#4f697d"
          />
          {[-0.11, 0.11].map((x) => (
            <Block
              key={x}
              position={[x, 0.94, 0]}
              size={[0.055, 0.21, 0.08]}
              color="#9aadb9"
            />
          ))}
        </group>
      </group>
    </group>
  );
}
function Equipment({ device }: { device: Device }) {
  if (device.kind === 'centrifuge') return <Centrifuge device={device} />;
  if (device.kind === 'robot') return <Robot />;
  if (device.kind === 'sensor')
    return (
      <group>
        <Block
          position={[0, 0.22, 0]}
          size={[0.44, 0.42, 0.26]}
          color="#f1f4f6"
        />
        <Block
          position={[0, 0.25, 0.14]}
          size={[0.3, 0.17, 0.025]}
          color="#284b55"
        />
        <Sign
          label={device.temperature.toFixed(1)}
          position={[0, 0.25, 0.159]}
          width={0.23}
          height={0.08}
          color="#95dfc4"
        />
        <Cylinder position={[0, 0.52, 0]} radius={0.02} height={0.22} />
      </group>
    );
  if (device.kind === 'light')
    return (
      <group>
        <Cylinder
          position={[0, 0.04, 0]}
          radius={0.22}
          height={0.06}
          color="#7c97a9"
        />
        <Cylinder position={[0, 0.48, 0]} radius={0.025} height={0.9} />
        <Block
          position={[0.17, 0.96, 0]}
          size={[0.55, 0.085, 0.25]}
          color="#cad8e2"
        />
        <mesh position={[0.17, 0.913, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[0.46, 0.18]} />
          <meshStandardMaterial
            color="#fff9de"
            emissive="#ffe9ae"
            emissiveIntensity={device.on ? device.brightness / 35 : 0}
          />
        </mesh>
        <pointLight
          position={[0.2, 0.83, 0]}
          color="#fff3d0"
          intensity={device.on ? device.brightness / 18 : 0}
          distance={3}
        />
      </group>
    );
  return (
    <group>
      <mesh position={[0, 0.2, 0]}>
        <cylinderGeometry args={[0.15, 0.14, 0.38, 24, 1, true]} />
        <meshPhysicalMaterial
          color="#c8e2ec"
          roughness={0.2}
          transparent
          opacity={0.42}
          side={2}
          depthWrite={false}
        />
      </mesh>
      <Cylinder
        position={[0, 0.1, 0]}
        radius={0.135}
        height={0.13}
        color="#7fb8ad"
      />
    </group>
  );
}
function ObjectView({
  device,
  selected,
  onSelect,
  onFocus,
  editing,
  onMove,
}: {
  device: Device;
  selected: boolean;
  onSelect: (id: string) => void;
  onFocus: (position: Position) => void;
  editing: boolean;
  onMove: (id: string, position: Position) => void;
}) {
  const ref = useRef<Group>(null);
  const body = (
    <group
      ref={ref}
      position={device.position}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        onSelect(device.id);
      }}
      onDoubleClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        onFocus(device.position);
      }}
      onPointerOver={(event) => {
        event.stopPropagation();
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        document.body.style.cursor = '';
      }}
    >
      <Equipment device={device} />
      {selected && (
        <mesh position={[0, device.kind === 'robot' ? 0.9 : 0.36, 0]}>
          <boxGeometry
            args={device.kind === 'robot' ? [1.4, 2, 1.2] : [1.25, 0.9, 1.12]}
          />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          <Edges color="#2479d3" lineWidth={1.8} />
        </mesh>
      )}
    </group>
  );
  return selected && editing ? (
    <TransformControls
      mode="translate"
      showY={false}
      onMouseUp={() => {
        if (ref.current)
          onMove(device.id, ref.current.position.toArray() as Position);
      }}
    >
      {body}
    </TransformControls>
  ) : (
    body
  );
}
function LabelProjection({
  devices,
  layer,
}: {
  devices: Device[];
  layer: RefObject<HTMLDivElement | null>;
}) {
  const { camera, size } = useThree();
  const point = useMemo(() => new Vector3(), []);
  useFrame(() => {
    if (!layer.current) return;
    const occupied: { x: number; y: number; width: number; height: number }[] =
      [];
    const elements = Array.from(layer.current.children).sort(
      (a, b) =>
        Number((b as HTMLElement).dataset.selected === 'true') -
        Number((a as HTMLElement).dataset.selected === 'true'),
    );
    for (const element of elements) {
      const button = element as HTMLButtonElement;
      const device = devices.find((item) => item.id === button.dataset.device);
      if (!device) continue;
      point.set(...device.position);
      point.y += device.kind === 'robot' ? 2.5 : 1.16;
      point.project(camera);
      const width = button.offsetWidth;
      const height = button.offsetHeight;
      const x = ((point.x + 1) * size.width) / 2 - width / 2;
      const y = ((1 - point.y) * size.height) / 2 - height / 2;
      const collision = occupied.some(
        (rect) =>
          x < rect.x + rect.width + 6 &&
          x + width + 6 > rect.x &&
          y < rect.y + rect.height + 6 &&
          y + height + 6 > rect.y,
      );
      const visible =
        !collision &&
        point.z >= -1 &&
        point.z <= 1 &&
        x >= 0 &&
        x + width <= size.width &&
        y >= 0 &&
        y + height <= size.height;
      button.style.transform = `translate3d(${Math.round(x * 2) / 2}px, ${Math.round(y * 2) / 2}px, 0)`;
      button.style.visibility = visible ? 'visible' : 'hidden';
      if (visible) occupied.push({ x, y, width, height });
    }
  });
  return null;
}
function CameraRig({ action }: { action: CameraAction }) {
  const { camera, size } = useThree();
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const goal = useRef<{
    position: Vector3;
    target: Vector3;
    zoom: number;
  } | null>(null);
  const zoom = Math.min(size.width / 15.2, size.height / 11.5);
  useEffect(() => {
    if (camera instanceof OrthographicCamera) {
      camera.zoom = zoom;
      camera.updateProjectionMatrix();
    }
  }, [camera, zoom]);
  useEffect(() => {
    const target =
      action.kind === 'focus' && action.position
        ? new Vector3(...action.position)
        : new Vector3(0, 0.7, 0);
    const offset =
      action.kind === 'top'
        ? new Vector3(0, 20, 0.01)
        : new Vector3(12, 11, 14);
    if (action.kind === 'in' || action.kind === 'out') {
      goal.current = {
        position: camera.position.clone(),
        target: controls.current!.target.clone(),
        zoom: Math.max(
          15,
          Math.min(180, camera.zoom * (action.kind === 'in' ? 1.2 : 0.83)),
        ),
      };
    } else
      goal.current = {
        position: target.clone().add(offset),
        target,
        zoom: action.kind === 'focus' ? zoom * 1.7 : zoom,
      };
  }, [action, camera]);
  useFrame((_, dt) => {
    if (!goal.current || !controls.current) return;
    const amount = 1 - Math.exp(-dt * 9);
    camera.position.lerp(goal.current.position, amount);
    controls.current.target.lerp(goal.current.target, amount);
    camera.zoom += (goal.current.zoom - camera.zoom) * amount;
    camera.updateProjectionMatrix();
    controls.current.update();
    if (
      camera.position.distanceTo(goal.current.position) < 0.005 &&
      Math.abs(camera.zoom - goal.current.zoom) < 0.02
    )
      goal.current = null;
  });
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      target={[0, 0.7, 0]}
      minZoom={15}
      maxZoom={180}
      maxPolarAngle={Math.PI / 2.03}
      enableDamping
      dampingFactor={0.1}
      onStart={() => {
        goal.current = null;
      }}
    />
  );
}
export default function LabScene({
  devices,
  selected,
  onSelect,
  onFocus,
  onMove,
  dark,
  editing,
  grid,
  action,
}: {
  devices: Device[];
  selected: string;
  onSelect: (id: string) => void;
  onFocus: (position: Position) => void;
  onMove: (id: string, position: Position) => void;
  dark: boolean;
  editing: boolean;
  grid: boolean;
  action: CameraAction;
}) {
  const layer = useRef<HTMLDivElement>(null);
  return (
    <>
      <Canvas
        orthographic
        shadows
        dpr={[1, 1.5]}
        camera={{ position: [12, 11.7, 14], zoom: 60, near: 0.1, far: 100 }}
        gl={{ antialias: true, preserveDrawingBuffer: true }}
        onPointerMissed={() => {
          if (!editing) onSelect('');
        }}
        aria-label="实验室三维场景"
      >
        <color attach="background" args={[dark ? '#292d33' : '#edf1f5']} />
        <ambientLight intensity={dark ? 1.2 : 1.8} />
        <directionalLight
          position={[5, 12, 6]}
          intensity={dark ? 2 : 2.6}
          castShadow
          shadow-mapSize={[1024, 1024]}
          shadow-camera-left={-12}
          shadow-camera-right={12}
          shadow-camera-top={12}
          shadow-camera-bottom={-12}
          shadow-bias={-0.001}
        />
        <directionalLight
          position={[-6, 5, -4]}
          intensity={1.2}
          color="#c5e0ff"
        />
        <mesh
          position={[0, -0.37, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
          receiveShadow
        >
          <planeGeometry args={[100, 100]} />
          <meshBasicMaterial
            color={dark ? '#292d33' : '#edf1f5'}
            toneMapped={false}
          />
        </mesh>
        <Room dark={dark} grid={editing && grid} />
        <Bench position={[-1.5, 0, -1.3]} width={4.5} label="PREP / A" />
        <Bench position={[1.95, 0, 1.2]} width={3.65} label="TEST / B" />
        <group position={[3.08, 1.08, 0.85]}>
          <Block size={[0.55, 0.12, 0.32]} color="#c4a46b" />
          {[0, 1, 2, 3].map((i) => (
            <Cylinder
              key={i}
              position={[-0.18 + i * 0.12, 0.15, 0]}
              radius={0.025}
              height={0.28}
              color={i % 2 ? '#d5c7dd' : '#a4d0bd'}
            />
          ))}
        </group>
        <Cylinder
          position={[2.1, 0.58, 2.7]}
          radius={0.29}
          height={0.08}
          color="#829da6"
        />
        <Cylinder
          position={[2.1, 0.3, 2.7]}
          radius={0.04}
          height={0.5}
          color="#b3bec9"
        />
        <Cylinder
          position={[2.1, 0.04, 2.7]}
          radius={0.31}
          height={0.04}
          color="#99aebc"
        />
        {devices.map((device) => (
          <ObjectView
            key={device.id}
            device={device}
            selected={device.id === selected}
            onSelect={onSelect}
            onFocus={onFocus}
            editing={editing}
            onMove={onMove}
          />
        ))}
        <CameraRig action={action} />
        <LabelProjection devices={devices} layer={layer} />
      </Canvas>
      <div className="scene-label-layer" ref={layer}>
        {!editing &&
          devices
            .filter(
              (device) =>
                device.id === selected ||
                device.kind === 'centrifuge' ||
                device.kind === 'sensor',
            )
            .map((device) => (
              <button
                key={device.id}
                data-device={device.id}
                data-selected={device.id === selected}
                className={`scene-label${device.id === selected ? ' is-selected' : ''}`}
                onClick={() => onSelect(device.id)}
                onDoubleClick={() => onFocus(device.position)}
                aria-label={`选择 ${device.name}`}
              >
                <span
                  className={`label-dot${active(device) ? ' is-active' : ''}`}
                />
                <span>
                  {device.kind === 'sensor'
                    ? `${device.temperature.toFixed(1)}°C`
                    : device.name.replace('冷冻', '')}
                </span>
                {(device.id === selected || active(device)) && (
                  <small>
                    {device.kind === 'robot'
                      ? '未接入'
                      : device.kind === 'centrifuge'
                        ? active(device)
                          ? phaseLabels[device.task!.phase]
                          : '空闲'
                        : '当前观测'}
                  </small>
                )}
              </button>
            ))}
      </div>
    </>
  );
}
