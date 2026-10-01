import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

export type ModelInfo = {
  meshes: number;
  materials: number;
  textures: number;
  triangles: number;
  dimensions: [number, number, number];
};

type AssetDetails = {
  id: string;
  name: string;
  fileName: string;
  bytes: number;
  info?: ModelInfo;
};

export type ModelAsset = AssetDetails &
  (
    | {
        source: 'preset';
        url: string;
        sourceUrl: string;
        author: string;
        license: string;
      }
    | { source: 'local'; file: File }
  );

export const presetAsset: ModelAsset = {
  id: 'industrial-microscope',
  name: 'Industrial Microscope',
  fileName: 'industrial-microscope.glb',
  bytes: 2454784,
  source: 'preset',
  url: `${import.meta.env.BASE_URL}lab-assets/models/industrial-microscope.glb`,
  sourceUrl: 'https://polyhaven.com/a/industrial_microscope',
  author: 'Lukas Walzer',
  license: 'CC0',
  info: {
    meshes: 2,
    materials: 1,
    textures: 3,
    triangles: 16598,
    dimensions: [0.2145, 0.4617, 0.4981],
  },
};

type Catalog = { assets: ModelAsset[]; activeId: string };
const key = (userId: string) => ['lab', 'catalog', userId] as const;
const initialCatalog = (): Catalog => ({
  assets: [presetAsset],
  activeId: presetAsset.id,
});

// The client-only catalog shares the existing identity cache lifecycle.
// Session replacement removes these queries, including their local files.
export function useCatalog(userId: string) {
  const client = useQueryClient();
  const { data } = useQuery({
    queryKey: key(userId),
    queryFn: initialCatalog,
    initialData: initialCatalog,
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const activate = useCallback(
    (id: string) => {
      client.setQueryData<Catalog>(
        key(userId),
        (previous = initialCatalog()) =>
          previous.assets.some((asset) => asset.id === id)
            ? { ...previous, activeId: id }
            : previous,
      );
    },
    [client, userId],
  );
  const addFile = useCallback(
    (file: File) => {
      const asset: ModelAsset = {
        id: crypto.randomUUID(),
        name: file.name.replace(/\.glb$/i, ''),
        fileName: file.name,
        bytes: file.size,
        source: 'local',
        file,
      };
      client.setQueryData<Catalog>(
        key(userId),
        (previous = initialCatalog()) => ({
          ...previous,
          assets: [...previous.assets, asset],
        }),
      );
      return asset.id;
    },
    [client, userId],
  );
  const removeFile = useCallback(
    (id: string) => {
      client.setQueryData<Catalog>(
        key(userId),
        (previous = initialCatalog()) => {
          const asset = previous.assets.find((entry) => entry.id === id);
          if (!asset || asset.source !== 'local') return previous;
          return {
            assets: previous.assets.filter((entry) => entry.id !== id),
            activeId:
              previous.activeId === id ? presetAsset.id : previous.activeId,
          };
        },
      );
    },
    [client, userId],
  );
  const updateInfo = useCallback(
    (id: string, info: ModelInfo) => {
      client.setQueryData<Catalog>(
        key(userId),
        (previous = initialCatalog()) => ({
          ...previous,
          assets: previous.assets.map((asset) =>
            asset.id === id ? { ...asset, info } : asset,
          ),
        }),
      );
    },
    [client, userId],
  );
  return { ...data, activate, addFile, removeFile, updateInfo };
}
