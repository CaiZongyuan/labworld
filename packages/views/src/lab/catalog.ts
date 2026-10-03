import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useMemo, useRef } from 'react';
import {
  completeAssetUpload,
  deleteLabAsset,
  listLabAssets,
  renameLabAsset,
  startAssetUpload,
  type ApiClient,
  type CurrentSession,
  type LabAsset,
} from '@labos-threejs/sdk';
import { ModelImportError } from './glb';
import { errorCodeOf } from '@labos-threejs/core';
import { sessionKey } from '../identity/session';

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
    | { source: 'remote'; asset: LabAsset; apiClient: ApiClient }
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

type Selection = { activeId: string; info: Record<string, ModelInfo> };
const initialSelection = (): Selection => ({
  activeId: presetAsset.id,
  info: {},
});
export type AssetMetadata = {
  name: string;
  source: string;
  license: string;
  version: string;
};

// Selection and rendered metrics are local; asset identity and bytes belong to the server.
export function useCatalog(apiClient: ApiClient, identity: CurrentSession) {
  const client = useQueryClient();
  const userId = identity.user.id;
  const key = useMemo(
    () => ['lab', 'assets', apiClient.getConfig().baseUrl, userId] as const,
    [apiClient, userId],
  );
  const selectionKey = useMemo(
    () => ['lab', 'selection', apiClient.getConfig().baseUrl, userId] as const,
    [apiClient, userId],
  );
  const attempts = useRef<{ fingerprint: string; key: string } | null>(null);
  const catalog = useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      (
        await listLabAssets({
          client: apiClient,
          query: { limit: 50, cursor: pageParam },
          signal,
          throwOnError: true,
        })
      ).data,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    retry: false,
  });
  const { data } = useQuery({
    queryKey: selectionKey,
    queryFn: initialSelection,
    initialData: initialSelection,
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const maxUploadBytes = catalog.data?.pages[0]?.max_upload_bytes ?? 0;
  const assets = useMemo<ModelAsset[]>(
    () => [
      presetAsset,
      ...(catalog.data?.pages.flatMap((page) => page.data) ?? []).map(
        (asset): ModelAsset => ({
          id: asset.id,
          name: asset.name,
          fileName: asset.representation.file_name,
          bytes: asset.representation.size,
          source: 'remote',
          asset,
          apiClient,
          info: data.info[asset.id],
        }),
      ),
    ],
    [apiClient, catalog.data, data.info],
  );
  const activate = useCallback(
    (id: string) => {
      client.setQueryData<Selection>(
        selectionKey,
        (previous = initialSelection()) => ({ ...previous, activeId: id }),
      );
    },
    [client, selectionKey],
  );
  const onMutationFailure = useCallback(
    (error: unknown): never => {
      const code = errorCodeOf(error);
      if (
        [
          'files.upload_expired',
          'files.upload_rejected',
          'files.not_found',
        ].includes(code ?? '')
      )
        attempts.current = null;
      if (['auth.unauthorized', 'auth.csrf'].includes(code ?? ''))
        void client.invalidateQueries({ queryKey: sessionKey(apiClient) });
      throw error;
    },
    [apiClient, client],
  );
  const updateAssetPages = useCallback(
    (update: (assets: LabAsset[], index: number) => LabAsset[]) => {
      client.setQueryData<typeof catalog.data>(key, (previous) =>
        previous
          ? {
              ...previous,
              pages: previous.pages.map((page, index) => ({
                ...page,
                data: update(page.data, index),
              })),
            }
          : previous,
      );
    },
    [client, key],
  );
  const addFile = useCallback(
    async (
      file: File,
      buffer: ArrayBuffer,
      signal: AbortSignal,
      metadata?: AssetMetadata,
    ) => {
      if (!maxUploadBytes || file.size > maxUploadBytes)
        throw new ModelImportError('tooLarge');
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      const sha256 = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      const body = {
        ...(metadata ?? {
          name: file.name.replace(/\.glb$/i, ''),
          source: '',
          license: '',
          version: '1.0',
        }),
        file: {
          file_name: file.name,
          content_type: 'model/gltf-binary',
          size: file.size,
          sha256,
        },
      };
      const fingerprint = JSON.stringify(body);
      if (attempts.current?.fingerprint !== fingerprint)
        attempts.current = { fingerprint, key: crypto.randomUUID() };
      const headers = {
        'x-csrf-token': identity.csrf_token,
        'idempotency-key': attempts.current.key,
      };
      const { data: upload } = await startAssetUpload({
        client: apiClient,
        headers,
        body,
        signal,
        throwOnError: true,
      }).catch(onMutationFailure);
      if (upload.upload) {
        const response = await fetch(upload.upload.url, {
          method: upload.upload.method,
          headers: upload.upload.headers,
          body: buffer,
          signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        });
        if (!response.ok) throw new ModelImportError('storage');
      }
      // Verification may take up to 30 seconds; override the SDK's ordinary 5 second fetch.
      const { data: asset } = await completeAssetUpload({
        client: apiClient,
        path: { id: upload.upload_id },
        headers: { 'x-csrf-token': identity.csrf_token },
        signal: AbortSignal.any([signal, AbortSignal.timeout(40_000)]),
        fetch: globalThis.fetch,
        throwOnError: true,
      }).catch(onMutationFailure);
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      updateAssetPages((rows, index) =>
        index === 0
          ? [asset, ...rows.filter((old) => old.id !== asset.id)]
          : rows.filter((old) => old.id !== asset.id),
      );
      attempts.current = null;
      return asset.id;
    },
    [
      apiClient,
      identity.csrf_token,
      maxUploadBytes,
      onMutationFailure,
      updateAssetPages,
    ],
  );
  const removeFile = useCallback(
    async (id: string) => {
      await deleteLabAsset({
        client: apiClient,
        path: { id },
        headers: { 'x-csrf-token': identity.csrf_token },
        throwOnError: true,
      }).catch(onMutationFailure);
      updateAssetPages((rows) => rows.filter((asset) => asset.id !== id));
      client.setQueryData<Selection>(
        selectionKey,
        (previous = initialSelection()) => ({
          ...previous,
          activeId:
            previous.activeId === id ? presetAsset.id : previous.activeId,
        }),
      );
    },
    [
      apiClient,
      client,
      identity.csrf_token,
      onMutationFailure,
      selectionKey,
      updateAssetPages,
    ],
  );
  const rename = useCallback(
    async (id: string, name: string) => {
      const { data: asset } = await renameLabAsset({
        client: apiClient,
        path: { id },
        body: { name },
        headers: { 'x-csrf-token': identity.csrf_token },
        throwOnError: true,
      }).catch(onMutationFailure);
      updateAssetPages((rows) =>
        rows.map((old) => (old.id === id ? asset : old)),
      );
    },
    [apiClient, identity.csrf_token, onMutationFailure, updateAssetPages],
  );
  const updateInfo = useCallback(
    (id: string, info: ModelInfo) => {
      client.setQueryData<Selection>(
        selectionKey,
        (previous = initialSelection()) => ({
          ...previous,
          info: { ...previous.info, [id]: info },
        }),
      );
    },
    [client, selectionKey],
  );
  return {
    assets,
    activeId: data.activeId,
    activate,
    addFile,
    removeFile,
    rename,
    updateInfo,
    maxUploadBytes,
    maxDecodedResourceBytes:
      catalog.data?.pages[0]?.max_decoded_resource_bytes ?? 0,
    query: catalog,
  };
}
