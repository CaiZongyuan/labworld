import type { LabWorld, WorldEvent } from '@labos-threejs/contracts';
import type { Client } from './generated/client';
import { streamLabWorld } from './generated/sdk.gen';

const MAX_EVENT_BYTES = 1024 * 1024 + 64;
const collections = ['entities', 'nodes', 'assets', 'relationships'] as const;

export class WorldSyncError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

/** Apply only complete versioned facts. A missing base requires a fresh subscription. */
export function applyLabWorldEvent(
  current: LabWorld | undefined,
  event: WorldEvent,
): LabWorld | undefined {
  if (event.type === 'snapshot') {
    if (!/^\d+$/.test(event.world.version))
      throw new WorldSyncError('invalid_version');
    return current && BigInt(current.version) >= BigInt(event.world.version)
      ? current
      : event.world;
  }
  if (event.type !== 'update') return current;
  if (!/^\d+$/.test(event.version) || !/^\d+$/.test(event.base_version))
    throw new WorldSyncError('invalid_version');
  if (current && BigInt(event.version) <= BigInt(current.version))
    return current;
  if (!current || current.version !== event.base_version)
    throw new WorldSyncError('version_gap');
  let next = {
    ...current,
    version: event.version,
    lab: event.lab ?? current.lab,
  };
  for (const change of event.changes) {
    if (!collections.includes(change.collection))
      throw new WorldSyncError('invalid_collection');
    const items = next[change.collection];
    if (change.patch === null) {
      next = {
        ...next,
        [change.collection]: items.filter((item) => item.id !== change.id),
      };
    } else {
      if (typeof change.patch !== 'object' || Array.isArray(change.patch))
        throw new WorldSyncError('invalid_patch');
      const patch = change.patch as Record<string, unknown>;
      if (patch.id !== undefined && patch.id !== change.id)
        throw new WorldSyncError('invalid_identity');
      const existing = items.find((item) => item.id === change.id);
      const replacement = { ...existing, ...patch };
      if (!existing && patch.id !== change.id)
        throw new WorldSyncError('missing_identity');
      next = {
        ...next,
        [change.collection]: existing
          ? items.map((item) => (item.id === change.id ? replacement : item))
          : [...items, replacement],
      };
    }
  }
  for (const collection of collections) {
    if (next[collection] !== current[collection])
      next = {
        ...next,
        [collection]: [...next[collection]].sort((left, right) =>
          left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
        ),
      };
  }
  return next;
}

export async function subscribeLabWorld(options: {
  client: Client;
  labId: string;
  signal: AbortSignal;
  headers?: HeadersInit;
  onEvent?: (event: WorldEvent) => void;
  onWorld?: (world: LabWorld) => void;
}): Promise<void> {
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  let idleTimer = setTimeout(
    () => controller.abort(new WorldSyncError('connection_idle')),
    10000,
  );
  let current: LabWorld | undefined;
  try {
    const { stream } = await streamLabWorld({
      client: options.client,
      path: { lab_id: options.labId },
      headers: options.headers,
      signal,
      sseMaxRetryAttempts: 1,
      onSseError(error) {
        if (!options.signal.aborted) throw error;
      },
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (!response.ok) {
          throw await response
            .json()
            .catch(() => new WorldSyncError(`http_${response.status}`));
        }
        if (
          !response.headers
            .get('content-type')
            ?.startsWith('text/event-stream') ||
          !response.body
        )
          throw new WorldSyncError('invalid_stream');
        // Bound the generated SSE parser's unfinished frame, including malformed servers.
        let bytes = 0;
        let newline = false;
        const bounded = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, target) {
              for (const byte of chunk) {
                bytes++;
                if (bytes > MAX_EVENT_BYTES)
                  throw new WorldSyncError('payload_limit');
                if (byte === 10) {
                  if (newline) {
                    bytes = 0;
                    newline = false;
                  } else newline = true;
                } else if (byte !== 13) newline = false;
              }
              target.enqueue(chunk);
            },
          }),
        );
        return new Response(bounded, {
          headers: response.headers,
          status: response.status,
        });
      },
    });
    for await (const raw of stream) {
      if (signal.aborted) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => controller.abort(new WorldSyncError('connection_idle')),
        10000,
      );
      const event = raw;
      if (event.type === 'snapshot' && event.world.lab.id !== options.labId)
        throw new WorldSyncError('wrong_lab');
      const next = applyLabWorldEvent(current, event);
      options.onEvent?.(event);
      if (next && next !== current) options.onWorld?.(next);
      current = next;
      if (event.type === 'resync') throw new WorldSyncError(event.reason);
      if (event.type === 'access_ended') return;
    }
  } finally {
    clearTimeout(idleTimer);
    controller.abort();
  }
}
