import { readFileSync } from 'node:fs';
import { render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { StrictMode, useEffect } from 'react';
import { Mesh, type WebGLRenderer } from 'three';
import {
  createApiClient,
  type CurrentSession,
  type LabAsset,
} from '@labos-threejs/sdk';
import { server } from '../../../../tests/frontend/server';
import type { ModelAsset } from './catalog';
import { useLoadedModel, type LoadedModel } from './model-loader';
import { useModelAuthority } from './model-authority';

const file = readFileSync('tests/fixtures/lab/cube.glb');
const bytes = file.buffer.slice(
  file.byteOffset,
  file.byteOffset + file.byteLength,
);
const remote = {
  id: '30000000-0000-0000-0000-000000000001',
  name: 'Cube',
  source: 'fixture',
  license: 'CC0',
  version: '1',
  created_at: '2026-10-14T00:00:00Z',
  updated_at: '2026-10-14T00:00:00Z',
  representation: {
    id: '30000000-0000-0000-0000-000000000002',
    file_id: '30000000-0000-0000-0000-000000000003',
    file_name: 'cube.glb',
    size: file.byteLength,
    sha256: '0'.repeat(64),
    content_type: 'model/gltf-binary',
  },
} as LabAsset;
const client = createApiClient('http://api.test');
// A plain GLB needs no compressed textures. This adapter supplies the renderer's
// documented capability lookup; loading and parsing use their real implementations.
const renderer = {
  extensions: { has: () => false },
} as unknown as WebGLRenderer;
const ignoreInfo = () => {};
function modelAsset(
  authority: object,
): Extract<ModelAsset, { source: 'remote' }> {
  return {
    id: remote.id,
    name: remote.name,
    fileName: 'cube.glb',
    bytes: file.byteLength,
    source: 'remote',
    asset: remote,
    apiClient: client,
    authority,
  };
}
function Probe({
  asset,
  label = 'model',
  onModel,
  modelRenderer = renderer,
}: {
  asset: ModelAsset;
  label?: string;
  onModel?: (model: LoadedModel) => void;
  modelRenderer?: WebGLRenderer;
}) {
  const result = useLoadedModel(asset, modelRenderer, ignoreInfo);
  useEffect(() => {
    if (result.model) onModel?.(result.model);
  }, [result.model, onModel]);
  return (
    <output aria-label={label}>
      {result.model?.scene.uuid ?? 'none'}|{result.model?.info.triangles ?? 0}|
      {result.loading ? 'loading' : (result.error ?? 'idle')}
    </output>
  );
}
function SessionProbe({ identity }: { identity: CurrentSession }) {
  const authority = useModelAuthority(client, identity);
  return <Probe asset={modelAsset(authority)} />;
}
function serve(failFirst = false) {
  let authorizations = 0;
  let hold = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(
    http.get('http://api.test/api/v1/lab/assets/:id/download', async () => {
      authorizations++;
      if (failFirst && authorizations === 1)
        return new HttpResponse(null, { status: 403 });
      if (hold) await held;
      return HttpResponse.json({
        url: 'http://api.test/objects/cube',
        method: 'GET',
        headers: {},
        expires_at: '2026-10-14T00:01:00Z',
        file: {
          id: remote.representation.file_id,
          file_name: 'cube.glb',
          content_type: 'model/gltf-binary',
          size: file.byteLength,
          sha256: remote.representation.sha256,
          created_at: remote.created_at,
          previewable: true,
        },
      });
    }),
    http.get('http://api.test/objects/cube', () =>
      HttpResponse.arrayBuffer(bytes),
    ),
  );
  return {
    hold: () => {
      hold = true;
    },
    release,
    authorizations: () => authorizations,
  };
}

test.each(['authority', 'representation', 'client', 'renderer'] as const)(
  'a %s change hides the old same-asset model before the next load completes',
  async (change) => {
    const transport = serve();
    const asset = modelAsset({});
    const view = render(<Probe asset={asset} />);
    await waitFor(() =>
      expect(screen.getByLabelText('model')).toHaveTextContent(
        /^[^|]+\|12\|idle$/,
      ),
    );
    const previous = screen.getByLabelText('model').textContent;
    transport.hold();
    const next = {
      ...asset,
      ...(change === 'authority' ? { authority: {} } : {}),
      ...(change === 'client'
        ? { apiClient: createApiClient('http://api.test') }
        : {}),
      ...(change === 'representation'
        ? {
            asset: {
              ...remote,
              representation: {
                ...remote.representation,
                id: '30000000-0000-0000-0000-000000000004',
              },
            },
          }
        : {}),
    };
    const nextRenderer =
      change === 'renderer'
        ? ({ extensions: { has: () => false } } as unknown as WebGLRenderer)
        : renderer;
    view.rerender(<Probe asset={next} modelRenderer={nextRenderer} />);
    expect(screen.getByLabelText('model')).toHaveTextContent('none|0|loading');
    await waitFor(() => expect(transport.authorizations()).toBe(2));
    transport.release();
    await waitFor(() =>
      expect(screen.getByLabelText('model')).toHaveTextContent(
        /^[^|]+\|12\|idle$/,
      ),
    );
    expect(screen.getByLabelText('model').textContent).not.toBe(previous);
  },
);

test('a same-authority metadata refresh retains the displayed model and authorization', async () => {
  const transport = serve();
  const asset = modelAsset({});
  const view = render(<Probe asset={asset} />);
  await waitFor(() =>
    expect(screen.getByLabelText('model')).toHaveTextContent(
      /^[^|]+\|12\|idle$/,
    ),
  );
  const previous = screen.getByLabelText('model').textContent;
  view.rerender(
    <Probe asset={{ ...asset, asset: { ...remote, name: 'Renamed cube' } }} />,
  );
  expect(screen.getByLabelText('model').textContent).toBe(previous);
  expect(transport.authorizations()).toBe(1);
});

test('same-session refresh keeps the model while same-user session replacement hides it', async () => {
  const transport = serve();
  const identity: CurrentSession = {
    user: { id: 'member', email: 'member@example.com', role: 'member' },
    csrf_token: 'fixture-session-a',
  };
  const view = render(<SessionProbe identity={identity} />);
  await waitFor(() =>
    expect(screen.getByLabelText('model')).toHaveTextContent(
      /^[^|]+\|12\|idle$/,
    ),
  );
  const previous = screen.getByLabelText('model').textContent;
  view.rerender(
    <SessionProbe identity={{ ...identity, user: { ...identity.user } }} />,
  );
  expect(screen.getByLabelText('model').textContent).toBe(previous);
  expect(transport.authorizations()).toBe(1);
  transport.hold();
  view.rerender(
    <SessionProbe
      identity={{ ...identity, csrf_token: 'fixture-session-b' }}
    />,
  );
  expect(screen.getByLabelText('model')).toHaveTextContent('none|0|loading');
  await waitFor(() => expect(transport.authorizations()).toBe(2));
  transport.release();
  await waitFor(() =>
    expect(screen.getByLabelText('model')).toHaveTextContent(
      /^[^|]+\|12\|idle$/,
    ),
  );
  expect(screen.getByLabelText('model').textContent).not.toBe(previous);
});

test('concurrent consumers parse and dispose independent scenes from one byte acquisition', async () => {
  const transport = serve();
  const asset = modelAsset({});
  let first: LoadedModel | undefined, second: LoadedModel | undefined;
  const firstLoaded = (model: LoadedModel) => {
    first = model;
  };
  const secondLoaded = (model: LoadedModel) => {
    second = model;
  };
  const view = render(
    <>
      <Probe key="first" label="first" asset={asset} onModel={firstLoaded} />
      <Probe key="second" label="second" asset={asset} onModel={secondLoaded} />
    </>,
  );
  await waitFor(() =>
    expect(screen.getByLabelText('first')).toHaveTextContent(
      /^[^|]+\|12\|idle$/,
    ),
  );
  await waitFor(() =>
    expect(screen.getByLabelText('second')).toHaveTextContent(
      /^[^|]+\|12\|idle$/,
    ),
  );
  expect(transport.authorizations()).toBe(1);
  expect(first!.scene).not.toBe(second!.scene);
  let firstMesh!: Mesh, secondMesh!: Mesh;
  first!.scene.traverse((object) => {
    if (object instanceof Mesh) firstMesh = object;
  });
  second!.scene.traverse((object) => {
    if (object instanceof Mesh) secondMesh = object;
  });
  expect(firstMesh.geometry).not.toBe(secondMesh.geometry);
  expect(firstMesh.material).not.toBe(secondMesh.material);
  let firstDisposals = 0,
    secondDisposals = 0;
  firstMesh.geometry.addEventListener('dispose', () => {
    firstDisposals++;
  });
  secondMesh.geometry.addEventListener('dispose', () => {
    secondDisposals++;
  });
  view.rerender(
    <>
      <Probe key="second" label="second" asset={asset} onModel={secondLoaded} />
    </>,
  );
  expect(firstDisposals).toBe(1);
  expect(secondDisposals).toBe(0);
  expect(screen.getByLabelText('second')).toHaveTextContent(
    /^[^|]+\|12\|idle$/,
  );
  view.unmount();
  expect(secondDisposals).toBe(1);
});

test('StrictMode cleanup can reacquire and finish a real model load', async () => {
  const transport = serve();
  const view = render(
    <StrictMode>
      <Probe asset={modelAsset({})} />
    </StrictMode>,
  );
  await waitFor(() =>
    expect(screen.getByLabelText('model')).toHaveTextContent(
      /^[^|]+\|12\|idle$/,
    ),
  );
  expect(transport.authorizations()).toBeGreaterThan(0);
  view.unmount();
});

test('a replacement authority hides old errors and can authorize a fresh successful load', async () => {
  const transport = serve(true);
  const view = render(<Probe asset={modelAsset({})} />);
  await waitFor(() =>
    expect(screen.getByLabelText('model')).toHaveTextContent('none|0|failed'),
  );
  transport.hold();
  view.rerender(<Probe asset={modelAsset({})} />);
  expect(screen.getByLabelText('model')).toHaveTextContent('none|0|loading');
  await waitFor(() => expect(transport.authorizations()).toBe(2));
  transport.release();
  await waitFor(() =>
    expect(screen.getByLabelText('model')).toHaveTextContent(
      /^[^|]+\|12\|idle$/,
    ),
  );
});

test('late bytes from a released authority cannot publish a stale scene', async () => {
  const transport = serve();
  transport.hold();
  const seen: LoadedModel[] = [];
  const loaded = (model: LoadedModel) => {
    seen.push(model);
  };
  const view = render(<Probe asset={modelAsset({})} onModel={loaded} />);
  await waitFor(() => expect(transport.authorizations()).toBe(1));
  view.rerender(<Probe asset={modelAsset({})} onModel={loaded} />);
  await waitFor(() => expect(transport.authorizations()).toBe(2));
  transport.release();
  await waitFor(() =>
    expect(screen.getByLabelText('model')).toHaveTextContent(
      /^[^|]+\|12\|idle$/,
    ),
  );
  expect(seen).toHaveLength(1);
  expect(screen.getByLabelText('model')).toHaveTextContent(seen[0].scene.uuid);
});
