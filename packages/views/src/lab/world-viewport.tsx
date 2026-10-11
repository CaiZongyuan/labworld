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
import { Canvas, useFrame, useThree, type RootState } from '@react-three/fiber';
import {
  Edges,
  Environment,
  Grid,
  OrbitControls,
  TransformControls,
} from '@react-three/drei';
import {
  Box3,
  Group,
  Mesh,
  PerspectiveCamera,
  Vector3,
  type WebGLRenderer,
  type Camera,
} from 'three';
import type {
  LabEntity,
  LabWorld,
  SceneNode,
  Placement,
  MotionBuffer,
} from '@labos-threejs/sdk';
import type { ModelAsset } from './catalog';
import { useLoadedModel, disposeModel } from './model-loader';
import {
  builtinKinds,
  createBuiltinModel,
  type BuiltinKind,
} from './builtin-models';
import { useAppMessage } from '../shell/messages';
import { MetricSampler } from './metric-sampler';
import type { RenderMetrics } from './viewport-state';
import { Alert, AlertDescription } from '@labos-threejs/ui/components/alert';
import { readEntityObservations } from './observation-state';
import { frameBounds } from './camera-framing';
import { WorldLabels } from './world-labels';
import {
  MotionSceneController,
  type MotionDiagnosticCanvas,
} from './motion-scene';

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
function CentrifugeRotor({
  entity,
  connected,
}: {
  entity: LabEntity;
  connected: boolean;
}) {
  const rotor = useRef<Group>(null);
  const reading = readEntityObservations(entity, connected).properties.speed;
  const speed = reading?.property;
  const rpm =
    reading?.currentValid && speed && typeof speed.value === 'number'
      ? speed.value
      : 0;
  useFrame((_, delta) => {
    if (rotor.current)
      rotor.current.rotation.y =
        (rotor.current.rotation.y + ((rpm * Math.PI * 2) / 60) * delta) %
        (Math.PI * 2);
  });
  return (
    <group ref={rotor} name="centrifuge-rotor" position={[0, 0.57, 0]}>
      <Cylinder
        radius={0.13}
        height={0.035}
        color={rpm > 0 ? '#279a79' : '#9eafb2'}
      />
      {[0, (Math.PI * 2) / 3, (Math.PI * 4) / 3].map((angle) => (
        <group key={angle} rotation={[0, angle, 0]}>
          <Block
            position={[0.17, 0.01, 0]}
            size={[0.2, 0.025, 0.07]}
            color={rpm > 0 ? '#5fbbc7' : '#c4d4d6'}
          />
          <Cylinder
            position={[0.25, 0.018, 0]}
            radius={0.035}
            height={0.045}
            color="#e8f1ef"
          />
        </group>
      ))}
    </group>
  );
}
function Builtin({
  entity,
  connected,
}: {
  entity: LabEntity;
  connected: boolean;
}) {
  const kind = builtinKinds.includes(entity.definition_id as BuiltinKind)
    ? (entity.definition_id as BuiltinKind)
    : null;
  const model = useMemo(() => (kind ? createBuiltinModel(kind) : null), [kind]);
  useEffect(
    () => () => {
      if (model) disposeModel(model.scene);
    },
    [model],
  );
  const readings = readEntityObservations(entity, connected).properties;
  const on = readings.on;
  const brightness = readings.brightness;
  const intensity =
    on?.hasValue &&
    brightness?.hasValue &&
    on.property?.value === true &&
    typeof brightness.property?.value === 'number'
      ? brightness.property.value / 100
      : 0;
  useEffect(() => {
    if (model?.glow) model.glow.emissiveIntensity = intensity * 2;
  }, [model, intensity]);
  if (!model)
    return (
      <Block position={[0, 0.25, 0]} size={[0.5, 0.5, 0.5]} color="#7795b4" />
    );
  return (
    <group>
      <primitive object={model.scene} dispose={null} />
      {kind === 'light' ? (
        <pointLight
          position={[0.38, 1.76, 0]}
          color="#ffe8b1"
          intensity={intensity * 8}
          distance={4.2}
          decay={2}
        />
      ) : null}
      {kind === 'centrifuge' ? (
        <CentrifugeRotor entity={entity} connected={connected} />
      ) : null}
    </group>
  );
}
const ignoreInfo = () => {};
function appearanceKey(node: SceneNode, entity: LabEntity) {
  return (
    node.representation_id ??
    `${entity.definition_id}@${entity.definition_version}`
  );
}
function Imported({
  asset,
  nodeId,
  renderer,
  onReady,
  onError,
  appearance,
}: {
  asset: ModelAsset;
  nodeId: string;
  renderer: WebGLRenderer | null;
  onReady: () => void;
  onError: (id: string, appearance: string, error: boolean) => void;
  appearance: string;
}) {
  const { model, error } = useLoadedModel(asset, renderer, ignoreInfo);
  useEffect(() => {
    model?.scene.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const materials = Array.isArray(object.material)
        ? object.material
        : [object.material];
      object.castShadow = materials.every((material) => !material.transparent);
      object.receiveShadow = true;
    });
  }, [model]);
  useEffect(() => {
    if (model?.id === asset.id) onReady();
  }, [model, asset.id, onReady]);
  useEffect(
    () => onError(nodeId, appearance, !!error),
    [nodeId, appearance, error, onError],
  );
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
  connected,
  asset,
  renderer,
  selected,
  onSelect,
  onReady,
  onError,
  active,
  onTarget,
  onLocate,
  motionScene,
}: {
  node: SceneNode;
  entity: LabEntity;
  connected: boolean;
  asset?: ModelAsset;
  renderer: WebGLRenderer | null;
  selected: boolean;
  onSelect: (id: string, additive: boolean, nodeId?: string) => void;
  onReady: (id: string, appearance: string) => void;
  onError: (id: string, appearance: string, error: boolean) => void;
  active: boolean;
  onTarget: (id: string, object: Group | null) => void;
  onLocate: (nodeId: string) => void;
  motionScene: MotionSceneController;
}) {
  const group = useRef<Group>(null);
  const outer = useRef<Group>(null);
  useEffect(() => {
    if (!outer.current) return;
    return motionScene.register(
      node.id,
      entity.id,
      outer.current,
      node.placement,
    );
  }, [motionScene, node.id, entity.id, node.placement]);
  const appearance = appearanceKey(node, entity);
  useEffect(() => {
    if (!active || !outer.current) return;
    onTarget(node.id, outer.current);
    return () => onTarget(node.id, null);
  }, [active, node.id, onTarget]);
  const [bounds, setBounds] = useState<{ center: Tuple; size: Tuple } | null>(
    null,
  );
  const userData = useMemo(
    () => ({
      nodeId: node.id,
      entityId: entity.id,
      labelAnchor: bounds
        ? new Vector3(
            bounds.center[0],
            bounds.center[1] + bounds.size[1] / 2 + 0.1,
            bounds.center[2],
          )
        : undefined,
    }),
    [node.id, entity.id, bounds],
  );
  const measure = useCallback(() => {
    if (!group.current) return;
    group.current.updateWorldMatrix(true, true);
    const box = new Box3().setFromObject(group.current);
    const center = group.current.worldToLocal(box.getCenter(new Vector3()));
    const worldScale = group.current.getWorldScale(new Vector3());
    const size = box.getSize(new Vector3()).divide(worldScale);
    setBounds({ center: center.toArray(), size: size.toArray() });
    onReady(node.id, appearance);
  }, [onReady, node.id, appearance]);
  useEffect(() => {
    if (!asset) measure();
  }, [asset, measure]);
  return (
    <group
      ref={outer}
      name={node.id}
      userData={userData}
      position={node.placement.position as Tuple}
      rotation={node.placement.rotation as Tuple}
      scale={node.placement.scale as Tuple}
      onClick={(event) => {
        if (event.delta <= 5) {
          event.stopPropagation();
          onSelect(entity.id, event.shiftKey, node.id);
        }
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onSelect(entity.id, false, node.id);
        onLocate(node.id);
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
            appearance={appearance}
          />
        ) : (
          <Builtin entity={entity} connected={connected} />
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
  connected,
  assets,
  frozenAssets,
  renderer,
  selected,
  onSelect,
  dark,
  grid,
  fit,
  fitNodeId,
  top,
  reducedMotion,
  contentReady,
  onError,
  onReady,
  activeNodeId,
  transformMode,
  onPlacement,
  onOpenRecentMinute,
  onLocate,
  motion,
}: {
  world: LabWorld;
  connected: boolean;
  assets: ModelAsset[];
  frozenAssets?: Map<string, ModelAsset>;
  renderer: WebGLRenderer | null;
  selected: string[];
  onSelect: (id: string, additive: boolean, nodeId?: string) => void;
  dark: boolean;
  grid: boolean;
  fit: number;
  fitNodeId: string | null;
  top: boolean;
  reducedMotion: boolean;
  contentReady: boolean;
  onError: (id: string, appearance: string, error: boolean) => void;
  onReady: (id: string, appearance: string) => void;
  activeNodeId?: string;
  transformMode: 'translate' | 'rotate' | 'scale' | null;
  onPlacement: (id: string, placement: Placement) => void;
  onOpenRecentMinute?: (entityId: string) => void;
  onLocate: (nodeId: string) => void;
  motion?: MotionBuffer | null;
}) {
  const motionScene = useMemo(() => new MotionSceneController(), []);
  useFrame(() => motionScene.update(motion ?? null, performance.now()));
  useEffect(() => () => motionScene.reset(), [motionScene]);
  const root = useRef<Group>(null);
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const { camera, size, gl } = useThree();
  useEffect(() => {
    if (!motion) return;
    const canvas = gl.domElement as MotionDiagnosticCanvas;
    const inspect = () => (motion.welcome ? motionScene.inspect() : null);
    canvas.getMotionDiagnostics = inspect;
    return () => {
      if (canvas.getMotionDiagnostics === inspect)
        delete canvas.getMotionDiagnostics;
    };
  }, [gl, motion, motionScene]);
  const [loaded, setLoaded] = useState(0);
  const transition = useRef<{
    from: Vector3;
    fromTarget: Vector3;
    to: Vector3;
    target: Vector3;
    elapsed: number;
  } | null>(null);
  useFrame((_, delta) => {
    const moving = transition.current;
    if (!moving || !controls.current) return;
    moving.elapsed = Math.min(moving.elapsed + delta, 0.32);
    const progress = reducedMotion ? 1 : moving.elapsed / 0.32;
    const ease = 1 - (1 - progress) ** 3;
    camera.position.lerpVectors(moving.from, moving.to, ease);
    controls.current.target.lerpVectors(moving.fromTarget, moving.target, ease);
    controls.current.update();
    if (progress === 1) transition.current = null;
  });
  const framing = useRef<{
    framed: boolean;
    fit: number;
    camera: Camera;
  } | null>(null);
  const [transformTarget, setTransformTarget] = useState<{
    id: string;
    object: Group;
  } | null>(null);
  const transformObject =
    transformTarget && transformTarget.id === activeNodeId
      ? transformTarget.object
      : null;
  const targetReady = useCallback(
    (id: string, object: Group | null) =>
      setTransformTarget((previous) =>
        object ? { id, object } : previous?.id === id ? null : previous,
      ),
    [],
  );
  const entityById = useMemo(
    () => new Map(world.entities.map((entity) => [entity.id, entity])),
    [world.entities],
  );
  const nodeStructure = world.nodes
    .filter((node) => !entityById.get(node.entity_id)?.archived_at)
    .map((node) => node.id)
    .join(',');
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
    (id: string, appearance: string) => {
      setLoaded((value) => value + 1);
      onReady(id, appearance);
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
    // After the first usable scene, only an explicit Fit owns the camera pose.
    const previous = framing.current;
    if (previous?.framed && previous.fit === fit && previous.camera === camera)
      return;
    if (!contentReady && (!previous || previous.fit === fit)) return;
    root.current.updateWorldMatrix(true, true);
    const target = root.current.children.find(
      (object) => object.name === fitNodeId,
    );
    const box = new Box3().setFromObject(target ?? root.current);
    const hasGeometry = !box.isEmpty();
    if (!hasGeometry && previous?.fit === fit && previous.camera === camera)
      return;
    framing.current = {
      framed: hasGeometry || !!previous?.framed,
      fit,
      camera,
    };
    if (!hasGeometry)
      box.setFromCenterAndSize(new Vector3(0, 0.5, 0), new Vector3(2, 1, 2));
    const pose = frameBounds(box, camera, size.width, size.height, top);
    camera.near = pose.near;
    camera.far = pose.far;
    camera.updateProjectionMatrix();
    if (!previous?.framed || reducedMotion) {
      transition.current = null;
      camera.position.copy(pose.position);
      controls.current.target.copy(pose.target);
      controls.current.update();
    } else
      transition.current = {
        from: camera.position.clone(),
        fromTarget: controls.current.target.clone(),
        to: pose.position,
        target: pose.target,
        elapsed: 0,
      };
  }, [
    nodeStructure,
    loaded,
    camera,
    size.width,
    size.height,
    fit,
    fitNodeId,
    top,
    reducedMotion,
    contentReady,
  ]);
  return (
    <>
      <color attach="background" args={[dark ? '#292c2e' : '#edf0f1']} />
      <ambientLight intensity={0.45} />
      <directionalLight
        position={[4, 8, 5]}
        intensity={1.4}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-12}
        shadow-camera-right={12}
        shadow-camera-top={12}
        shadow-camera-bottom={-12}
        shadow-camera-near={0.1}
        shadow-camera-far={40}
        shadow-normalBias={0.02}
      />
      <Suspense fallback={null}>
        <Environment
          files={`${import.meta.env.BASE_URL}lab-assets/hdr/studio.hdr`}
          environmentIntensity={0.45}
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
      <mesh
        position={[0, -0.009, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
      >
        <planeGeometry args={[30, 30]} />
        <shadowMaterial transparent opacity={0.18} />
      </mesh>
      <group ref={root}>
        {world.nodes.map((node) => {
          const entity = entityById.get(node.entity_id);
          if (!entity || entity.archived_at) return null;
          const asset =
            frozenAssets?.get(node.id) ??
            (node.representation_id
              ? assetByRepresentation.get(node.representation_id)
              : undefined);
          return (
            <NodeModel
              key={node.id}
              node={node}
              entity={entity}
              connected={connected}
              asset={asset}
              renderer={renderer}
              selected={selected.includes(entity.id)}
              onSelect={onSelect}
              onReady={ready}
              onError={onError}
              active={!!transformMode && node.id === activeNodeId}
              onTarget={targetReady}
              onLocate={onLocate}
              motionScene={motionScene}
            />
          );
        })}
      </group>
      <WorldLabels
        world={world}
        connected={connected}
        selected={selected}
        activeNodeId={activeNodeId}
        root={root}
        onSelect={onSelect}
        onLocate={onLocate}
        onOpenRecentMinute={onOpenRecentMinute}
      />
      {transformMode && transformObject && activeNodeId ? (
        <TransformControls
          object={transformObject}
          mode={transformMode}
          size={0.85}
          onObjectChange={() => {
            transformObject.position.clampScalar(-10000, 10000);
            transformObject.scale.clampScalar(0.001, 1000);
            onPlacement(activeNodeId, {
              position: transformObject.position.toArray(),
              rotation: [
                transformObject.rotation.x,
                transformObject.rotation.y,
                transformObject.rotation.z,
              ],
              scale: transformObject.scale.toArray(),
            });
          }}
        />
      ) : null}
      <OrbitControls
        ref={controls}
        makeDefault
        enableDamping={!reducedMotion}
        onStart={() => {
          transition.current = null;
        }}
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
  connected: boolean;
  assets: ModelAsset[];
  frozenAssets?: Map<string, ModelAsset>;
  selected: string[];
  onSelect: (id: string | null, additive: boolean, nodeId?: string) => void;
  activeNodeId?: string;
  transformMode: 'translate' | 'rotate' | 'scale' | null;
  onPlacement: (id: string, placement: Placement) => void;
  dark: boolean;
  grid: boolean;
  fit: number;
  fitNodeId: string | null;
  top: boolean;
  onLocate: (nodeId: string) => void;
  onOpenRecentMinute?: (entityId: string) => void;
  label: string;
  performance: boolean;
  onMetrics: (metrics: RenderMetrics) => void;
  onBusy: (busy: boolean) => void;
  motion?: MotionBuffer | null;
}) {
  const message = useAppMessage('lab');
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const changed = () => setReducedMotion(preference.matches);
    changed();
    preference.addEventListener('change', changed);
    return () => preference.removeEventListener('change', changed);
  }, []);
  const [renderer, setRenderer] = useState<WebGLRenderer | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [readyIds, setReadyIds] = useState<Record<string, string>>({});
  const pointer = useRef({ x: 0, y: 0 });
  const onReady = useCallback(
    (id: string, appearance: string) =>
      setReadyIds((previous) =>
        previous[id] === appearance
          ? previous
          : { ...previous, [id]: appearance },
      ),
    [],
  );
  const created = useCallback(({ gl }: RootState) => {
    gl.domElement.tabIndex = 0;
    setRenderer(gl);
  }, []);
  const onError = useCallback(
    (id: string, appearance: string, error: boolean) =>
      setFailed((previous) => {
        if (error)
          return previous[id] === appearance
            ? previous
            : { ...previous, [id]: appearance };
        if (!previous[id]) return previous;
        const next = { ...previous };
        delete next[id];
        return next;
      }),
    [],
  );
  useEffect(() => {
    renderer?.domElement.setAttribute('aria-label', props.label);
  }, [renderer, props.label]);
  const onBusy = props.onBusy;
  const entityById = new Map(
    props.world.entities.map((entity) => [entity.id, entity]),
  );
  const pending = props.world.nodes.some((node) => {
    const entity = entityById.get(node.entity_id);
    if (!entity || entity.archived_at) return false;
    const appearance = appearanceKey(node, entity);
    return readyIds[node.id] !== appearance && failed[node.id] !== appearance;
  });
  const hasFailure = props.world.nodes.some((node) => {
    const entity = entityById.get(node.entity_id);
    return (
      entity &&
      !entity.archived_at &&
      failed[node.id] === appearanceKey(node, entity)
    );
  });
  useEffect(() => onBusy(pending), [pending, onBusy]);
  return (
    <>
      <Canvas
        shadows
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
          reducedMotion={reducedMotion}
          contentReady={!pending}
          renderer={renderer}
          onError={onError}
          onReady={onReady}
        />
        {props.performance ? (
          <MetricSampler onMetrics={props.onMetrics} />
        ) : null}
      </Canvas>
      {hasFailure ? (
        <Alert className="world-render-error">
          <AlertDescription>{message('import.failed')}</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}
