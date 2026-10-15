import {
  Box3,
  InstancedMesh,
  LoadingManager,
  Line,
  Mesh,
  Points,
  SkinnedMesh,
  Texture,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D,
  type Skeleton,
  type WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { useEffect, useEffectEvent, useMemo, useState } from 'react';
import type { ModelAsset, ModelInfo } from './catalog';
import type { ReadinessObserver } from './readiness-observer';
import { ModelImportError, validateGLB, type ModelErrorKey } from './glb';
import {
  acquireModelBytes,
  modelResourceKey,
  type ModelByteLease,
} from './model-bytes';

export type LoadedModel = {
  id: string;
  scene: Object3D;
  bounds: Box3;
  size: Vector3;
  info: ModelInfo;
};

export function disposeModel(scene: Object3D): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  const skeletons = new Set<Skeleton>();
  scene.traverse((object) => {
    if (!(
      object instanceof Mesh ||
      object instanceof Line ||
      object instanceof Points
    ))
      return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material)
      ? object.material
      : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material) as unknown[])
        if (value instanceof Texture) textures.add(value);
    }
    if (object instanceof SkinnedMesh) skeletons.add(object.skeleton);
    if (object instanceof InstancedMesh) object.dispose();
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const skeleton of skeletons) skeleton.dispose();
  const images = new Set<unknown>();
  for (const texture of textures) {
    images.add(texture.source.data);
    texture.dispose();
  }
  for (const image of images)
    if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap)
      image.close();
}

async function parseModel(
  buffer: ArrayBuffer,
  id: string,
  renderer: WebGLRenderer,
  observation?: { observer: ReadinessObserver; attempt: number },
): Promise<LoadedModel> {
  observation?.observer.emit('validate-start', {
    attempt: observation.attempt,
  });
  validateGLB(buffer);
  observation?.observer.emit('validate-ready', {
    attempt: observation.attempt,
  });
  const decoderPath = `${import.meta.env.BASE_URL}lab-assets/decoders/`;
  const draco = new DRACOLoader().setDecoderPath(`${decoderPath}draco/`);
  const ktx = new KTX2Loader()
    .setTranscoderPath(`${decoderPath}basis/`)
    .detectSupport(renderer);
  let resourceFailed = false;
  const manager = new LoadingManager();
  manager.onError = () => {
    resourceFailed = true;
  };
  try {
    const loader = new GLTFLoader(manager)
      .setDRACOLoader(draco)
      .setKTX2Loader(ktx)
      .setMeshoptDecoder(MeshoptDecoder);
    observation?.observer.emit('gltf-parse-start', {
      attempt: observation.attempt,
    });
    const gltf = await loader.parseAsync(buffer, '');
    observation?.observer.emit('gltf-parse-ready', {
      attempt: observation.attempt,
    });
    if (resourceFailed) {
      disposeModel(gltf.scene);
      throw new ModelImportError('failed');
    }
    gltf.scene.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(gltf.scene);
    const size = bounds.getSize(new Vector3());
    const materials = new Set<Material>();
    const textures = new Set<Texture>();
    let meshes = 0;
    let renderables = 0;
    let triangles = 0;
    gltf.scene.traverse((object) => {
      if (!(
        object instanceof Mesh ||
        object instanceof Line ||
        object instanceof Points
      ))
        return;
      renderables++;
      if (object instanceof Mesh) {
        meshes++;
        triangles +=
          ((object.geometry.index?.count ??
            object.geometry.getAttribute('position')?.count ??
            0) /
            3) *
          (object instanceof InstancedMesh ? object.count : 1);
      }
      for (const material of Array.isArray(object.material)
        ? object.material
        : [object.material]) {
        materials.add(material);
        for (const value of Object.values(material) as unknown[])
          if (value instanceof Texture) textures.add(value);
      }
    });
    if (
      !renderables ||
      bounds.isEmpty() ||
      !Number.isFinite(size.length()) ||
      size.length() <= 0
    ) {
      disposeModel(gltf.scene);
      throw new ModelImportError('empty');
    }
    observation?.observer.emit('geometry-ready', {
      attempt: observation.attempt,
    });
    return {
      id,
      scene: gltf.scene,
      bounds,
      size,
      info: {
        meshes,
        materials: materials.size,
        textures: textures.size,
        triangles: Math.round(triangles),
        dimensions: size.toArray(),
      },
    };
  } finally {
    draco.dispose();
    ktx.dispose();
  }
}

type ModelInstance = {
  owner: ModelOwner;
  resource: string;
  model: LoadedModel;
};
type ModelOwner = {
  active: boolean;
  instances: Set<ModelInstance>;
  latest: ModelInstance | null;
};
function usableInstance(
  instance: ModelInstance | null,
  owner: ModelOwner,
  id: string,
  resource: string,
) {
  return (
    instance !== null &&
    instance.owner === owner &&
    owner.instances.has(instance) &&
    (instance.model.id !== id || instance.resource === resource)
  );
}
function releaseInstance(instance: ModelInstance) {
  if (!instance.owner.instances.delete(instance)) return;
  if (instance.owner.latest === instance) instance.owner.latest = null;
  disposeModel(instance.model.scene);
}

export function useLoadedModel(
  asset: ModelAsset,
  renderer: WebGLRenderer | null,
  onInfo: (id: string, info: ModelInfo) => void,
  readiness?: ReadinessObserver,
) {
  const input =
    asset.source === 'preset' ? asset.url : modelResourceKey(asset.asset);
  const currentRemoteAsset = useEffectEvent(() =>
    asset.source === 'remote' ? asset.asset : null,
  );
  const apiClient = asset.source === 'remote' ? asset.apiClient : null;
  const authority = asset.source === 'remote' ? asset.authority : null;
  const id = asset.id;
  const owner = useMemo<ModelOwner>(
    () => ({ active: true, instances: new Set(), latest: null }),
    [apiClient, authority, renderer],
  );
  const identity = useMemo(
    () => ({}),
    [id, input, apiClient, authority, renderer],
  );
  const [state, setState] = useState<{
    identity: object | null;
    instance: ModelInstance | null;
    loading: boolean;
    error: ModelErrorKey | null;
  }>({ identity: null, instance: null, loading: false, error: null });
  const instance = usableInstance(state.instance, owner, id, input)
    ? state.instance
    : null;
  useEffect(() => {
    owner.active = true;
    return () => {
      owner.active = false;
      for (const loaded of owner.instances) releaseInstance(loaded);
    };
  }, [owner]);
  useEffect(() => {
    // Keep the displayed instance until its replacement commits. The latest
    // parsed candidate stays owned even if it has not committed yet.
    const latest = usableInstance(owner.latest, owner, id, input)
      ? owner.latest
      : null;
    for (const loaded of owner.instances)
      if (loaded !== instance && loaded !== latest) releaseInstance(loaded);
  }, [owner, instance, id, input]);
  useEffect(() => {
    if (!renderer) return;
    const remoteAsset = currentRemoteAsset();
    const controller = new AbortController();
    const attempt = readiness?.nextAttempt();
    const observed =
      attempt !== undefined && readiness
        ? { observer: readiness, attempt }
        : undefined;
    const observe = (
      phase: Parameters<ReadinessObserver['emit']>[0],
      bytes?: number,
    ) =>
      readiness?.emit(phase, {
        attempt,
        bytes,
        cancelled: controller.signal.aborted || !owner.active,
      });
    observe('body-start');
    let lease: ModelByteLease | undefined;
    setState((previous) => ({
      identity,
      instance: usableInstance(previous.instance, owner, id, input)
        ? previous.instance
        : null,
      loading: true,
      error: null,
    }));
    void (async () => {
      try {
        let buffer: ArrayBuffer;
        if (remoteAsset && apiClient && authority) {
          lease = acquireModelBytes(
            renderer,
            { asset: remoteAsset, apiClient, authority },
            controller.signal,
          );
          buffer = await lease.bytes;
        } else {
          const response = await fetch(input, { signal: controller.signal });
          if (!response.ok) throw new ModelImportError('failed');
          buffer = await response.arrayBuffer();
        }
        observe('body-ready', buffer.byteLength);
        const next = await parseModel(buffer.slice(0), id, renderer, observed);
        if (controller.signal.aborted || !owner.active) {
          observe('discarded');
          disposeModel(next.scene);
          return;
        }
        const loaded: ModelInstance = {
          owner,
          resource: input,
          model: next,
        };
        owner.instances.add(loaded);
        owner.latest = loaded;
        setState({ identity, instance: loaded, loading: false, error: null });
        observe('commit-enqueued');
        onInfo(id, next.info);
      } catch (cause) {
        observe('error');
        if (!controller.signal.aborted)
          setState((previous) => ({
            identity,
            instance: usableInstance(previous.instance, owner, id, input)
              ? previous.instance
              : null,
            loading: false,
            error: cause instanceof ModelImportError ? cause.key : 'failed',
          }));
      } finally {
        lease?.release();
        lease = undefined;
      }
    })();
    return () => {
      controller.abort();
      observe('cancel');
      lease?.release();
    };
  }, [
    owner,
    identity,
    id,
    input,
    apiClient,
    authority,
    renderer,
    onInfo,
    readiness,
  ]);
  return state.identity === identity
    ? {
        model: instance?.model ?? null,
        loading: state.loading,
        error: state.error,
      }
    : { model: instance?.model ?? null, loading: !!renderer, error: null };
}
