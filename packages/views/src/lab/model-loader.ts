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
import { useEffect, useState } from 'react';
import type { ModelAsset, ModelInfo } from './catalog';
import {
  ModelImportError,
  readModelFile,
  validateGLB,
  type ModelErrorKey,
} from './glb';

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
): Promise<LoadedModel> {
  validateGLB(buffer);
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
    const gltf = await loader.parseAsync(buffer, '');
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

export function useLoadedModel(
  asset: ModelAsset,
  renderer: WebGLRenderer | null,
  onInfo: (id: string, info: ModelInfo) => void,
) {
  const input = asset.source === 'preset' ? asset.url : asset.file;
  const id = asset.id;
  const [model, setModel] = useState<LoadedModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ModelErrorKey | null>(null);
  useEffect(() => {
    if (!renderer) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        let buffer: ArrayBuffer;
        if (typeof input === 'string') {
          const response = await fetch(input, { signal: controller.signal });
          if (!response.ok) throw new ModelImportError('failed');
          buffer = await response.arrayBuffer();
        } else buffer = await readModelFile(input, controller.signal);
        const next = await parseModel(buffer, id, renderer);
        if (controller.signal.aborted) {
          disposeModel(next.scene);
          return;
        }
        setModel(next);
        onInfo(id, next.info);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof ModelImportError ? cause.key : 'failed');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [id, input, renderer, onInfo]);
  useEffect(
    () => () => {
      if (model) disposeModel(model.scene);
    },
    [model],
  );
  return { model, loading, error };
}
