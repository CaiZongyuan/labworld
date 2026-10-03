import {
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
} from 'react';
import { Canvas, useThree, type RootState } from '@react-three/fiber';
import { Edges, Environment, Grid, OrbitControls } from '@react-three/drei';
import {
  Box3,
  Group,
  PerspectiveCamera,
  Vector3,
  type WebGLRenderer,
} from 'three';
import type { LabEntity, LabWorld, SceneNode } from '@labos-threejs/sdk';
import type { ModelAsset } from './catalog';
import { useLoadedModel } from './model-loader';
import { useAppMessage } from '../shell/messages';
import { MetricSampler } from './metric-sampler';
import type { RenderMetrics } from './viewport-state';
import { Alert, AlertDescription } from '@labos-threejs/ui/components/alert';

type Tuple = [number, number, number];
function Block({
  position = [0, 0, 0],
  size = [1, 1, 1],
  color = '#d8e0df',
}: {
  position?: Tuple;
  size?: Tuple;
  color?: string;
}) {
  return (
    <mesh position={position} castShadow receiveShadow>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} roughness={0.55} metalness={0.1} />
    </mesh>
  );
}
function Cylinder({
  position = [0, 0, 0],
  radius = 0.2,
  height = 0.1,
  color = '#8fa2a4',
}: {
  position?: Tuple;
  radius?: number;
  height?: number;
  color?: string;
}) {
  return (
    <mesh position={position} castShadow receiveShadow>
      <cylinderGeometry args={[radius, radius, height, 32]} />
      <meshStandardMaterial color={color} roughness={0.4} metalness={0.25} />
    </mesh>
  );
}
function Builtin({ definition }: { definition: string }) {
  if (definition === 'bench')
    return (
      <group>
        <Block
          position={[0, 0.84, 0]}
          size={[1.25, 0.12, 0.75]}
          color="#e8eceb"
        />
        {[-0.43, 0.43].map((x) => (
          <group key={x}>
            <Block position={[x, 0.41, 0]} size={[0.34, 0.74, 0.64]} />
            {[0.25, 0.46, 0.67].map((y) => (
              <Block
                key={y}
                position={[x, y, 0.33]}
                size={[0.29, 0.13, 0.035]}
                color="#bacbc8"
              />
            ))}
          </group>
        ))}
      </group>
    );
  if (definition === 'robot')
    return (
      <group>
        <Cylinder position={[0, 0.07, 0]} radius={0.24} height={0.14} />
        <Cylinder
          position={[0, 0.3, 0]}
          radius={0.12}
          height={0.4}
          color="#446a75"
        />
        <group position={[0, 0.46, 0]} rotation={[0, 0, -0.45]}>
          <Block
            position={[0, 0.27, 0]}
            size={[0.16, 0.55, 0.18]}
            color="#c5d3d8"
          />
          <Cylinder
            position={[0, 0.56, 0]}
            radius={0.12}
            height={0.18}
            color="#557d89"
          />
          <group position={[0, 0.55, 0]} rotation={[0, 0, -1]}>
            <Block position={[0, 0.22, 0]} size={[0.12, 0.45, 0.14]} />
            <Block
              position={[0, 0.48, 0]}
              size={[0.22, 0.08, 0.18]}
              color="#384b52"
            />
            {[-0.08, 0.08].map((x) => (
              <Block
                key={x}
                position={[x, 0.56, 0]}
                size={[0.035, 0.14, 0.1]}
                color="#758b91"
              />
            ))}
          </group>
        </group>
      </group>
    );
  if (definition === 'light')
    return (
      <group>
        <Cylinder position={[0, 0.04, 0]} radius={0.21} height={0.08} />
        <Cylinder position={[0, 0.59, 0]} radius={0.035} height={1.1} />
        <mesh position={[0, 1.15, 0]}>
          <cylinderGeometry args={[0.19, 0.28, 0.2, 32]} />
          <meshStandardMaterial color="#d6dfbd" roughness={0.6} />
        </mesh>
      </group>
    );
  if (definition === 'sensor')
    return (
      <group>
        <Block position={[0, 0.3, 0]} size={[0.35, 0.52, 0.24]} />
        <Block
          position={[0, 0.37, 0.128]}
          size={[0.24, 0.15, 0.02]}
          color="#405d65"
        />
        {[-0.06, 0, 0.06].map((x) => (
          <Block
            key={x}
            position={[x, 0.18, 0.128]}
            size={[0.025, 0.08, 0.01]}
            color="#839795"
          />
        ))}
      </group>
    );
  if (definition === 'labware')
    return (
      <group>
        <mesh position={[0, 0.22, 0]}>
          <cylinderGeometry args={[0.15, 0.14, 0.42, 32, 1, true]} />
          <meshPhysicalMaterial
            color="#87c4d1"
            transparent
            opacity={0.55}
            roughness={0.15}
            side={2}
          />
        </mesh>
        <Cylinder
          position={[0, 0.012, 0]}
          radius={0.14}
          height={0.024}
          color="#75a8b5"
        />
      </group>
    );
  if (definition === 'environment')
    return (
      <group>
        <Block
          position={[0, 0.015, 0]}
          size={[1.2, 0.03, 1.2]}
          color="#b9d3bd"
        />
        <Cylinder
          position={[0, 0.25, 0]}
          radius={0.065}
          height={0.45}
          color="#667b64"
        />
        <mesh position={[0, 0.53, 0]}>
          <sphereGeometry args={[0.11, 24, 16]} />
          <meshStandardMaterial color="#82a176" />
        </mesh>
      </group>
    );
  if (definition === 'centrifuge')
    return (
      <group>
        <Block
          position={[0, 0.28, 0]}
          size={[0.8, 0.5, 0.75]}
          color="#e0e6e5"
        />
        <Block
          position={[0, 0.25, 0.39]}
          size={[0.65, 0.18, 0.035]}
          color="#b5cac7"
        />
        <Block
          position={[-0.1, 0.28, 0.415]}
          size={[0.24, 0.09, 0.01]}
          color="#39555a"
        />
        <Cylinder
          position={[0, 0.54, 0]}
          radius={0.3}
          height={0.045}
          color="#5d7d83"
        />
        <Cylinder
          position={[0, 0.57, 0]}
          radius={0.13}
          height={0.035}
          color="#9eafb2"
        />
      </group>
    );
  return (
    <Block position={[0, 0.25, 0]} size={[0.5, 0.5, 0.5]} color="#7795b4" />
  );
}

const ignoreInfo = () => {};
function Imported({
  asset,
  nodeId,
  renderer,
  onReady,
  onError,
}: {
  asset: ModelAsset;
  nodeId: string;
  renderer: WebGLRenderer | null;
  onReady: () => void;
  onError: (id: string, error: boolean) => void;
}) {
  const { model, error } = useLoadedModel(asset, renderer, ignoreInfo);
  useEffect(() => {
    if (model) onReady();
  }, [model, onReady]);
  useEffect(() => onError(nodeId, !!error), [nodeId, error, onError]);
  if (!model) return null;
  const center = model.bounds.getCenter(new Vector3());
  return (
    <group position={[-center.x, -model.bounds.min.y, -center.z]}>
      <primitive object={model.scene} dispose={null} />
    </group>
  );
}

const NodeModel = memo(function NodeModel({
  node,
  entity,
  asset,
  renderer,
  selected,
  onSelect,
  onReady,
  onError,
}: {
  node: SceneNode;
  entity: LabEntity;
  asset?: ModelAsset;
  renderer: WebGLRenderer | null;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
  onReady: (id: string) => void;
  onError: (id: string, error: boolean) => void;
}) {
  const group = useRef<Group>(null);
  const [bounds, setBounds] = useState<{ center: Tuple; size: Tuple } | null>(
    null,
  );
  const measure = useCallback(() => {
    if (!group.current) return;
    group.current.updateWorldMatrix(true, true);
    const box = new Box3().setFromObject(group.current);
    const center = group.current.worldToLocal(box.getCenter(new Vector3()));
    const worldScale = group.current.getWorldScale(new Vector3());
    const size = box.getSize(new Vector3()).divide(worldScale);
    setBounds({ center: center.toArray(), size: size.toArray() });
    onReady(node.id);
  }, [onReady, node.id]);
  useEffect(() => {
    if (!asset) measure();
  }, [asset, measure]);
  return (
    <group
      position={node.placement.position as Tuple}
      rotation={node.placement.rotation as Tuple}
      scale={node.placement.scale as Tuple}
      onClick={(event) => {
        if (event.delta <= 5) {
          event.stopPropagation();
          onSelect(entity.id, event.shiftKey);
        }
      }}
    >
      <group ref={group}>
        {asset ? (
          <Imported
            asset={asset}
            nodeId={node.id}
            renderer={renderer}
            onReady={measure}
            onError={onError}
          />
        ) : (
          <Builtin definition={entity.definition_id} />
        )}
      </group>
      {selected && bounds ? (
        <mesh position={bounds.center}>
          <boxGeometry
            args={bounds.size.map((value) => value * 1.05) as Tuple}
          />
          <meshBasicMaterial visible={false} />
          <Edges color="#278c75" />
        </mesh>
      ) : null}
    </group>
  );
});

function Scene({
  world,
  assets,
  renderer,
  selected,
  onSelect,
  dark,
  grid,
  fit,
  onError,
  onReady,
}: {
  world: LabWorld;
  assets: ModelAsset[];
  renderer: WebGLRenderer | null;
  selected: string[];
  onSelect: (id: string, additive: boolean) => void;
  dark: boolean;
  grid: boolean;
  fit: number;
  onError: (id: string, error: boolean) => void;
  onReady: (id: string) => void;
}) {
  const root = useRef<Group>(null);
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const { camera, size } = useThree();
  const [loaded, setLoaded] = useState(0);
  const entityById = useMemo(
    () => new Map(world.entities.map((entity) => [entity.id, entity])),
    [world.entities],
  );
  const assetByRepresentation = useMemo(
    () =>
      new Map(
        assets.flatMap((asset) =>
          asset.source === 'remote'
            ? [[asset.asset.representation.id, asset] as const]
            : [],
        ),
      ),
    [assets],
  );
  const ready = useCallback(
    (id: string) => {
      setLoaded((value) => value + 1);
      onReady(id);
    },
    [onReady],
  );
  useEffect(() => {
    if (
      !root.current ||
      !controls.current ||
      !(camera instanceof PerspectiveCamera) ||
      !size.width ||
      !size.height
    )
      return;
    root.current.updateWorldMatrix(true, true);
    const box = new Box3().setFromObject(root.current);
    if (box.isEmpty())
      box.setFromCenterAndSize(new Vector3(0, 0.5, 0), new Vector3(2, 1, 2));
    const dimensions = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const vertical = (camera.fov * Math.PI) / 360;
    const horizontal = Math.atan(
      (Math.tan(vertical) * size.width) / size.height,
    );
    const radius = Math.max(dimensions.length() / 2, 0.5);
    const distance = (radius / Math.sin(Math.min(vertical, horizontal))) * 1.18;
    camera.position
      .copy(center)
      .addScaledVector(new Vector3(0.95, 0.7, 1.25).normalize(), distance);
    camera.near = Math.max(radius / 500, 0.001);
    camera.far = radius * 200;
    camera.updateProjectionMatrix();
    controls.current.target.copy(center);
    controls.current.update();
  }, [world.nodes, loaded, camera, size.width, size.height, fit]);
  return (
    <>
      <color attach="background" args={[dark ? '#292c2e' : '#edf0f1']} />
      <ambientLight intensity={0.45} />
      <directionalLight position={[4, 8, 5]} intensity={2} />
      <Suspense fallback={null}>
        <Environment
          files={`${import.meta.env.BASE_URL}lab-assets/hdr/studio.hdr`}
          environmentIntensity={0.8}
        />
      </Suspense>
      {grid ? (
        <Grid
          position={[0, -0.008, 0]}
          args={[30, 30]}
          cellSize={0.25}
          sectionSize={1}
          cellColor={dark ? '#45494c' : '#ccd3d4'}
          sectionColor={dark ? '#697075' : '#a8b7bc'}
          fadeDistance={30}
          infiniteGrid
        />
      ) : null}
      <group ref={root}>
        {world.nodes.map((node) => {
          const entity = entityById.get(node.entity_id);
          if (!entity) return null;
          const asset = node.representation_id
            ? assetByRepresentation.get(node.representation_id)
            : undefined;
          return (
            <NodeModel
              key={node.id}
              node={node}
              entity={entity}
              asset={asset}
              renderer={renderer}
              selected={selected.includes(entity.id)}
              onSelect={onSelect}
              onReady={ready}
              onError={onError}
            />
          );
        })}
      </group>
      <OrbitControls
        ref={controls}
        makeDefault
        enableDamping
        maxPolarAngle={Math.PI * 0.48}
        minDistance={0.1}
        maxDistance={10000}
        keyEvents
      />
    </>
  );
}

export default function WorldViewport(props: {
  world: LabWorld;
  assets: ModelAsset[];
  selected: string[];
  onSelect: (id: string | null, additive: boolean) => void;
  dark: boolean;
  grid: boolean;
  fit: number;
  label: string;
  onMetrics: (metrics: RenderMetrics) => void;
  onBusy: (busy: boolean) => void;
}) {
  const message = useAppMessage('lab');
  const [renderer, setRenderer] = useState<WebGLRenderer | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const [readyIds, setReadyIds] = useState<string[]>([]);
  const pointer = useRef({ x: 0, y: 0 });
  const onReady = useCallback(
    (id: string) =>
      setReadyIds((previous) =>
        previous.includes(id) ? previous : [...previous, id],
      ),
    [],
  );
  const created = useCallback(({ gl }: RootState) => {
    gl.domElement.tabIndex = 0;
    setRenderer(gl);
  }, []);
  const onError = useCallback(
    (id: string, error: boolean) =>
      setFailed((previous) =>
        error
          ? previous.includes(id)
            ? previous
            : [...previous, id]
          : previous.filter((entry) => entry !== id),
      ),
    [],
  );
  useEffect(() => {
    renderer?.domElement.setAttribute('aria-label', props.label);
  }, [renderer, props.label]);
  const onBusy = props.onBusy;
  useEffect(
    () =>
      onBusy(
        props.world.nodes.some(
          (node) => !readyIds.includes(node.id) && !failed.includes(node.id),
        ),
      ),
    [props.world.nodes, readyIds, failed, onBusy],
  );
  return (
    <>
      <Canvas
        camera={{ position: [4, 3, 5], fov: 38 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true }}
        onCreated={created}
        onPointerDown={(event) => {
          pointer.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerMissed={(event) => {
          if (
            Math.hypot(
              event.clientX - pointer.current.x,
              event.clientY - pointer.current.y,
            ) <= 5
          )
            props.onSelect(null, false);
        }}
      >
        <Scene
          {...props}
          renderer={renderer}
          onError={onError}
          onReady={onReady}
        />
        <MetricSampler onMetrics={props.onMetrics} />
      </Canvas>
      {failed.length ? (
        <Alert className="world-render-error">
          <AlertDescription>{message('import.failed')}</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}
