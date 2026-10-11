import type {
  SimulationSessionEvent,
  SimulationSessionSnapshot,
  LabWorld,
} from '@labos-threejs/contracts';
import type { Client } from './generated/client';
import { streamLabSimulationSessions } from './generated/sdk.gen';
import { WorldSyncError } from './lab-world';

/** Only the bound Installation's render identities are frozen; other Lab objects remain current. */
export function projectSessionWorld(
  current: LabWorld,
  snapshot: SimulationSessionSnapshot,
): LabWorld {
  const nodeIds = new Set(
    snapshot.installation.targets.map((target) => target.node_id),
  );
  const entityIds = new Set(
    snapshot.installation.targets.map((target) => target.entity_id),
  );
  const fixedNodes = snapshot.world.nodes.filter((node) =>
    nodeIds.has(node.id),
  );
  const fixedEntities = new Map(
    snapshot.world.entities
      .filter((entity) => entityIds.has(entity.id))
      .map((entity) => [entity.id, entity]),
  );
  return {
    ...current,
    nodes: [
      ...current.nodes.filter((node) => !nodeIds.has(node.id)),
      ...fixedNodes,
    ],
    entities: current.entities.map((entity) => {
      const fixed = fixedEntities.get(entity.id);
      return fixed
        ? {
            ...entity,
            definition_id: fixed.definition_id,
            definition_version: fixed.definition_version,
            definition: fixed.definition,
            configuration: fixed.configuration,
            representation_id: fixed.representation_id,
          }
        : entity;
    }),
  };
}

/** Caller owns reconnection. This low-frequency stream never carries pose frames. */
export async function subscribeSimulationSessions(options: {
  client: Client;
  labId: string;
  signal: AbortSignal;
  onReady?: () => void;
  onSession: (event: SimulationSessionEvent) => void;
}): Promise<void> {
  if (options.signal.aborted) return;
  const owner = new AbortController();
  const signal = AbortSignal.any([options.signal, owner.signal]);
  try {
    const { stream } = await streamLabSimulationSessions({
      client: options.client,
      path: { lab_id: options.labId },
      signal,
      sseMaxRetryAttempts: 1,
      onSseError(error) {
        if (!options.signal.aborted) throw error;
      },
      fetch: async (input, init) => {
        const response = await fetch(input, { ...init, signal });
        if (!response.ok)
          throw await response
            .json()
            .catch(() => new WorldSyncError(`http_${response.status}`));
        if (
          !response.headers
            .get('content-type')
            ?.startsWith('text/event-stream') ||
          !response.body
        )
          throw new WorldSyncError('invalid_stream');
        options.onReady?.();
        let bytes = 0;
        let newline = false;
        const bounded = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, target) {
              for (const byte of chunk) {
                if (++bytes > 1024 * 1024 + 64)
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
          status: response.status,
          headers: response.headers,
        });
      },
    });
    for await (const event of stream) {
      if (signal.aborted) return;
      if (event.type !== 'session' || event.session.lab_id !== options.labId)
        throw new WorldSyncError('wrong_lab');
      options.onSession(event);
    }
  } finally {
    owner.abort();
  }
}
