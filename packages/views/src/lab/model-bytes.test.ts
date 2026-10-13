import { expect, test } from 'vitest';
import { http, HttpResponse } from 'msw';
import { createApiClient, type LabAsset } from '@labos-threejs/sdk';
import { server } from '../../../../tests/frontend/server';
import { acquireModelBytes } from './model-bytes';

const content = new Uint8Array([10, 20, 30, 40]);
const asset = {
  id: '30000000-0000-0000-0000-000000000001',
  name: 'Lease model',
  source: 'fixture',
  license: 'CC0',
  version: '1',
  created_at: '2026-10-14T00:00:00Z',
  updated_at: '2026-10-14T00:00:00Z',
  representation: {
    id: '30000000-0000-0000-0000-000000000002',
    file_id: '30000000-0000-0000-0000-000000000003',
    file_name: 'lease.glb',
    size: 4,
    sha256: '0'.repeat(64),
    content_type: 'model/gltf-binary',
  },
} as LabAsset;

function served(failFirst = false) {
  let authorizations = 0,
    reads = 0,
    abortedReads = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(
    http.get('http://api.test/api/v1/lab/assets/:id/download', () => {
      authorizations++;
      if (failFirst && authorizations === 1)
        return new HttpResponse(null, { status: 503 });
      return HttpResponse.json({
        url: 'http://api.test/objects/model',
        method: 'GET',
        headers: {},
        expires_at: '2026-10-14T00:01:00Z',
        file: {
          id: asset.representation.file_id,
          file_name: 'lease.glb',
          content_type: 'model/gltf-binary',
          size: 4,
          sha256: asset.representation.sha256,
          created_at: asset.created_at,
          previewable: true,
        },
      });
    }),
    http.get('http://api.test/objects/model', async ({ request }) => {
      reads++;
      request.signal.addEventListener(
        'abort',
        () => {
          abortedReads++;
        },
        { once: true },
      );
      await held;
      return HttpResponse.arrayBuffer(content.buffer);
    }),
  );
  return {
    release,
    counts: () => ({ authorizations, reads }),
    abortedReads: () => abortedReads,
  };
}

test('simultaneous same-Canvas consumers authorize and retrieve one immutable resource once', async () => {
  const transport = served();
  const source = {
    asset,
    apiClient: createApiClient('http://api.test'),
    authority: {},
  };
  const owner = {};
  const first = acquireModelBytes(owner, source, new AbortController().signal);
  const second = acquireModelBytes(owner, source, new AbortController().signal);
  await expect.poll(() => transport.counts().reads).toBeGreaterThan(0);
  transport.release();
  try {
    expect(Array.from(new Uint8Array(await first.bytes))).toEqual([
      10, 20, 30, 40,
    ]);
    expect(Array.from(new Uint8Array(await second.bytes))).toEqual([
      10, 20, 30, 40,
    ]);
    expect(transport.counts()).toEqual({ authorizations: 1, reads: 1 });
  } finally {
    first.release();
    second.release();
  }
});

test('the last consumer cancels pending I/O and a new consumer can reacquire immediately', async () => {
  const transport = served();
  const source = {
    asset,
    apiClient: createApiClient('http://api.test'),
    authority: {},
  };
  const owner = {};
  const controller = new AbortController();
  const first = acquireModelBytes(owner, source, controller.signal);
  const cancelled = first.bytes.catch((error: Error) => error.name);
  await expect.poll(() => transport.counts().reads).toBe(1);
  controller.abort();
  first.release();
  expect(await cancelled).toBe('AbortError');
  const replacement = acquireModelBytes(
    owner,
    source,
    new AbortController().signal,
  );
  await expect.poll(() => transport.counts().reads).toBe(2);
  expect(transport.abortedReads()).toBe(1);
  transport.release();
  try {
    expect(Array.from(new Uint8Array(await replacement.bytes))).toEqual([
      10, 20, 30, 40,
    ]);
    expect(transport.counts()).toEqual({ authorizations: 2, reads: 2 });
  } finally {
    replacement.release();
  }
});

test('one pending consumer can leave while the surviving consumer retrieves its bytes', async () => {
  const transport = served();
  const source = {
    asset,
    apiClient: createApiClient('http://api.test'),
    authority: {},
  };
  const owner = {};
  const firstAbort = new AbortController();
  const first = acquireModelBytes(owner, source, firstAbort.signal);
  const second = acquireModelBytes(owner, source, new AbortController().signal);
  const cancelled = first.bytes.catch((error: Error) => error.name);
  await expect.poll(() => transport.counts().reads).toBe(1);
  firstAbort.abort();
  expect(await cancelled).toBe('AbortError');
  transport.release();
  try {
    expect(Array.from(new Uint8Array(await second.bytes))).toEqual([
      10, 20, 30, 40,
    ]);
    expect(transport.counts()).toEqual({ authorizations: 1, reads: 1 });
  } finally {
    first.release();
    second.release();
  }
});

test('a settled byte read never grants a new consumer access without authorization', async () => {
  const transport = served();
  const source = {
    asset,
    apiClient: createApiClient('http://api.test'),
    authority: {},
  };
  const owner = {};
  const first = acquireModelBytes(owner, source, new AbortController().signal);
  await expect.poll(() => transport.counts().reads).toBe(1);
  transport.release();
  await first.bytes;
  const later = acquireModelBytes(owner, source, new AbortController().signal);
  try {
    expect(Array.from(new Uint8Array(await later.bytes))).toEqual([
      10, 20, 30, 40,
    ]);
    expect(transport.counts()).toEqual({ authorizations: 2, reads: 2 });
  } finally {
    first.release();
    later.release();
  }
});

test.each([
  'Canvas',
  'authority',
  'client',
  'asset',
  'representation',
] as const)(
  'simultaneous consumers with different %s owners authorize independently',
  async (difference) => {
    const transport = served();
    const source = {
      asset,
      apiClient: createApiClient('http://api.test'),
      authority: {},
    };
    const other = {
      ...source,
      ...(difference === 'authority' ? { authority: {} } : {}),
      ...(difference === 'client'
        ? { apiClient: createApiClient('http://api.test') }
        : {}),
      ...(difference === 'representation'
        ? {
            asset: {
              ...asset,
              representation: {
                ...asset.representation,
                id: '30000000-0000-0000-0000-000000000004',
              },
            },
          }
        : {}),
      ...(difference === 'asset'
        ? { asset: { ...asset, id: '30000000-0000-0000-0000-000000000005' } }
        : {}),
    };
    const owner = {};
    const first = acquireModelBytes(
      owner,
      source,
      new AbortController().signal,
    );
    const second = acquireModelBytes(
      difference === 'Canvas' ? {} : owner,
      other,
      new AbortController().signal,
    );
    await expect.poll(() => transport.counts().reads).toBe(2);
    transport.release();
    try {
      await Promise.all([first.bytes, second.bytes]);
      expect(transport.counts()).toEqual({ authorizations: 2, reads: 2 });
    } finally {
      first.release();
      second.release();
    }
  },
);

test('a failed attempt retires and an explicit acquisition retries authorization', async () => {
  const transport = served(true);
  const source = {
    asset,
    apiClient: createApiClient('http://api.test'),
    authority: {},
  };
  const owner = {};
  const first = acquireModelBytes(owner, source, new AbortController().signal);
  await expect(first.bytes).rejects.toBeDefined();
  const retry = acquireModelBytes(owner, source, new AbortController().signal);
  await expect.poll(() => transport.counts().reads).toBe(1);
  transport.release();
  try {
    expect(Array.from(new Uint8Array(await retry.bytes))).toEqual([
      10, 20, 30, 40,
    ]);
    expect(transport.counts()).toEqual({ authorizations: 2, reads: 1 });
  } finally {
    first.release();
    retry.release();
  }
});

test('an already-aborted consumer makes no request and does not poison a valid acquisition', async () => {
  const transport = served();
  const source = {
    asset,
    apiClient: createApiClient('http://api.test'),
    authority: {},
  };
  const owner = {};
  const controller = new AbortController();
  controller.abort();
  const cancelled = acquireModelBytes(owner, source, controller.signal);
  await expect(cancelled.bytes).rejects.toHaveProperty('name', 'AbortError');
  cancelled.release();
  const active = acquireModelBytes(owner, source, new AbortController().signal);
  await expect.poll(() => transport.counts().reads).toBe(1);
  transport.release();
  try {
    expect(Array.from(new Uint8Array(await active.bytes))).toEqual([
      10, 20, 30, 40,
    ]);
    expect(transport.counts()).toEqual({ authorizations: 1, reads: 1 });
  } finally {
    active.release();
  }
});

test.each(['file_id', 'sha256', 'size'] as const)(
  'a changed %s cannot reuse old pending bytes or mismatched capability metadata',
  async (field) => {
    const transport = served();
    const source = {
      asset,
      apiClient: createApiClient('http://api.test'),
      authority: {},
    };
    const owner = {};
    const changed = {
      ...source,
      asset: {
        ...asset,
        representation: {
          ...asset.representation,
          ...(field === 'file_id'
            ? { file_id: '30000000-0000-0000-0000-000000000006' }
            : {}),
          ...(field === 'sha256' ? { sha256: '1'.repeat(64) } : {}),
          ...(field === 'size' ? { size: 5 } : {}),
        },
      },
    };
    const first = acquireModelBytes(
      owner,
      source,
      new AbortController().signal,
    );
    const second = acquireModelBytes(
      owner,
      changed,
      new AbortController().signal,
    );
    const mismatch = second.bytes.catch((error: { key: string }) => error.key);
    await expect.poll(() => transport.counts().authorizations).toBe(2);
    expect(await mismatch).toBe('invalid');
    transport.release();
    try {
      expect(Array.from(new Uint8Array(await first.bytes))).toEqual([
        10, 20, 30, 40,
      ]);
      expect(transport.counts()).toEqual({ authorizations: 2, reads: 1 });
    } finally {
      first.release();
      second.release();
    }
  },
);
