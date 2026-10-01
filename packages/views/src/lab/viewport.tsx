import {
  Suspense,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
} from 'react';
import { Canvas, useFrame, useThree, type RootState } from '@react-three/fiber';
import {
  ContactShadows,
  Edges,
  Environment,
  Grid,
  OrbitControls,
} from '@react-three/drei';
import {
  PerspectiveCamera,
  Vector3,
  type Vector3Tuple,
  type WebGLRenderer,
} from 'three';
import type { ModelAsset, ModelInfo } from './catalog';
import { useLoadedModel, type LoadedModel } from './model-loader';
import type { RenderMetrics, ViewSettings, ViewStatus } from './viewport-state';

const environmentUrl = `${import.meta.env.BASE_URL}lab-assets/hdr/studio.hdr`;
const cameraOptions = { position: [0.9, 0.6, 1.2] as Vector3Tuple, fov: 38 };
const rendererOptions = { antialias: true };
const pixelRatio: [number, number] = [1, 1.5];

function MetricSampler({
  onMetrics,
}: {
  onMetrics: (metrics: RenderMetrics) => void;
}) {
  const sample = useRef({ elapsed: 0, frames: 0 });
  useFrame(({ gl }, delta) => {
    sample.current.elapsed += delta;
    sample.current.frames++;
    if (sample.current.elapsed < 0.6) return;
    const fps = sample.current.frames / sample.current.elapsed;
    const memory = (
      performance as Performance & { memory?: { usedJSHeapSize?: number } }
    ).memory;
    const heap = memory?.usedJSHeapSize;
    onMetrics({
      fps,
      frameMs: 1000 / fps,
      calls: gl.info.render.calls,
      triangles: gl.info.render.triangles,
      geometries: gl.info.memory.geometries,
      textures: gl.info.memory.textures,
      heapMiB:
        typeof heap === 'number' && Number.isFinite(heap)
          ? heap / 1024 / 1024
          : null,
    });
    sample.current = { elapsed: 0, frames: 0 };
  });
  return null;
}

const Scene = memo(function Scene({
  model,
  settings,
  selected,
  onSelect,
}: {
  model: LoadedModel | null;
  settings: ViewSettings;
  selected: boolean;
  onSelect: (selected: boolean) => void;
}) {
  const { camera, size } = useThree();
  const controls = useRef<ComponentRef<typeof OrbitControls> | null>(null);
  const view = useRef({ modelId: '', reset: settings.reset });
  const offset = useMemo<Vector3Tuple>(() => {
    if (!model) return [0, 0, 0];
    const center = model.bounds.getCenter(new Vector3());
    return [-center.x, -model.bounds.min.y, -center.z];
  }, [model]);
  const extent = model
    ? Math.max(model.size.x, model.size.y, model.size.z)
    : 0.5;
  useEffect(() => {
    if (
      !model ||
      !controls.current ||
      !(camera instanceof PerspectiveCamera) ||
      !size.width ||
      !size.height
    )
      return;
    const target = new Vector3(0, model.size.y / 2, 0);
    const verticalHalfFov = (camera.fov * Math.PI) / 360;
    const horizontalHalfFov = Math.atan(
      (Math.tan(verticalHalfFov) * size.width) / size.height,
    );
    const radius = model.size.length() / 2;
    const distance =
      (radius / Math.sin(Math.min(verticalHalfFov, horizontalHalfFov))) * 1.12;
    const direction =
      view.current.modelId !== model.id || view.current.reset !== settings.reset
        ? new Vector3(0.95, 0.6, 1.25).normalize()
        : camera.position.clone().sub(controls.current.target).normalize();
    camera.position.copy(target).addScaledVector(direction, distance);
    camera.near = extent / 500;
    camera.far = extent * 200;
    camera.updateProjectionMatrix();
    controls.current.target.copy(target);
    controls.current.update();
    view.current = { modelId: model.id, reset: settings.reset };
  }, [
    model,
    camera,
    extent,
    size.width,
    size.height,
    settings.fit,
    settings.reset,
  ]);
  useEffect(
    () => () => {
      document.body.style.cursor = '';
    },
    [model],
  );
  return (
    <>
      <color
        attach="background"
        args={[settings.dark ? '#292c2e' : '#edf0f1']}
      />
      <Suspense fallback={null}>
        <Environment
          files={environmentUrl}
          environmentIntensity={settings.intensity}
        />
      </Suspense>
      {settings.grid ? (
        <Grid
          position={[0, -extent * 0.004, 0]}
          args={[extent * 12, extent * 12]}
          cellSize={extent / 10}
          sectionSize={extent / 2}
          cellThickness={0.55}
          sectionThickness={0.9}
          cellColor={settings.dark ? '#45494c' : '#cbd1d4'}
          sectionColor={settings.dark ? '#697075' : '#a4b0b5'}
          fadeDistance={extent * 8}
          fadeStrength={2}
          infiniteGrid
        />
      ) : null}
      {model ? (
        <>
          <group
            position={offset}
            onClick={(event) => {
              if (event.delta <= 5) {
                event.stopPropagation();
                onSelect(true);
              }
            }}
            onPointerOver={(event) => {
              event.stopPropagation();
              document.body.style.cursor = 'pointer';
            }}
            onPointerOut={() => {
              document.body.style.cursor = '';
            }}
          >
            <primitive object={model.scene} dispose={null} />
          </group>
          {selected ? (
            <mesh position={[0, model.size.y / 2, 0]}>
              <boxGeometry
                args={[
                  model.size.x * 1.035,
                  model.size.y * 1.025,
                  model.size.z * 1.025,
                ]}
              />
              <meshBasicMaterial visible={false} />
              <Edges color={settings.dark ? '#80cdb4' : '#23896f'} />
            </mesh>
          ) : null}
        </>
      ) : null}
      <group
        position={[0, -extent * 0.002, 0]}
        scale={extent}
        visible={!!model}
      >
        <ContactShadows
          opacity={settings.dark ? 0.45 : 0.28}
          scale={4}
          blur={2.5}
          far={1.4}
          resolution={256}
          frames={1}
          color="#23313c"
        />
      </group>
      <OrbitControls
        ref={controls}
        makeDefault
        enableDamping
        dampingFactor={0.08}
        minDistance={extent * 0.35}
        maxDistance={extent * 15}
        maxPolarAngle={Math.PI * 0.48}
        autoRotate={settings.rotate}
        autoRotateSpeed={0.6}
        keyEvents
      />
    </>
  );
});

export default function Viewport({
  asset,
  settings,
  selected,
  label,
  onSelect,
  onMetrics,
  onStatus,
  onInfo,
}: {
  asset: ModelAsset;
  settings: ViewSettings;
  selected: boolean;
  label: string;
  onSelect: (value: boolean) => void;
  onMetrics: (metrics: RenderMetrics) => void;
  onStatus: (status: ViewStatus) => void;
  onInfo: (id: string, info: ModelInfo) => void;
}) {
  const [renderer, setRenderer] = useState<WebGLRenderer | null>(null);
  const { model, loading, error } = useLoadedModel(asset, renderer, onInfo);
  const pointer = useRef({ x: 0, y: 0 });
  const created = useCallback(({ gl }: RootState) => {
    gl.domElement.tabIndex = 0;
    setRenderer(gl);
  }, []);
  useEffect(() => {
    renderer?.domElement.setAttribute('aria-label', label);
  }, [renderer, label]);
  useEffect(() => {
    onStatus({
      renderedId: model?.id ?? null,
      info: model?.info ?? null,
      loading,
      error,
    });
  }, [model, loading, error, onStatus]);
  return (
    <Canvas
      camera={cameraOptions}
      dpr={pixelRatio}
      gl={rendererOptions}
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
          onSelect(false);
      }}
    >
      <Scene
        model={model}
        settings={settings}
        selected={selected}
        onSelect={onSelect}
      />
      <MetricSampler onMetrics={onMetrics} />
    </Canvas>
  );
}
