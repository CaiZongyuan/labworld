import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  subscribeLabWorld,
  type ApiClient,
  type LabWorld,
} from '@labos-threejs/sdk';
import { errorCodeOf } from '@labos-threejs/core';
import { sessionKey } from '../identity/session';

type Connection = {
  scope: string;
  status: 'connecting' | 'live' | 'offline' | 'ended';
  available: boolean;
  generation?: number;
  lastSyncAt?: number;
};

export function useWorldSubscription(
  apiClient: ApiClient,
  userId: string,
  labId: string,
) {
  const client = useQueryClient();
  const scope = `${apiClient.getConfig().baseUrl}:${userId}:${labId}`;
  const [connection, setConnection] = useState<Connection>({
    scope: '',
    status: 'connecting',
    available: false,
  });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!labId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = (status: Connection['status'], available?: boolean) => {
      if (!controller.signal.aborted)
        setConnection((previous) => {
          const ready =
            available ?? (previous.scope === scope && previous.available);
          return previous.scope === scope &&
            previous.status === status &&
            previous.available === ready
            ? previous
            : {
                scope,
                status,
                available: ready,
                generation:
                  status === 'live' &&
                  (previous.scope !== scope || previous.status !== 'live')
                    ? (previous.scope === scope
                        ? (previous.generation ?? 0)
                        : 0) + 1
                    : previous.scope === scope
                      ? previous.generation
                      : undefined,
                lastSyncAt:
                  previous.scope === scope ? previous.lastSyncAt : undefined,
              };
        });
    };
    async function connect() {
      let ended = false;
      let refreshed = false;
      try {
        await subscribeLabWorld({
          client: apiClient,
          labId,
          signal: controller.signal,
          onWorld(world) {
            if (controller.signal.aborted) return;
            client.setQueryData<LabWorld>(
              ['lab', 'world', apiClient.getConfig().baseUrl, userId, labId],
              (previous) =>
                previous?.version &&
                BigInt(previous.version) > BigInt(world.version)
                  ? previous
                  : world,
            );
            update('live');
            setConnection((previous) => ({
              ...previous,
              lastSyncAt: Date.now(),
            }));
          },
          onEvent(event) {
            if (controller.signal.aborted) return;
            if (event.type === 'runtime_status') {
              update('live', event.available);
              if (!refreshed)
                void client.invalidateQueries({
                  queryKey: [
                    'lab',
                    'world',
                    apiClient.getConfig().baseUrl,
                    userId,
                    labId,
                  ],
                  exact: true,
                });
              refreshed = true;
            }
            if (event.type === 'access_ended') {
              ended = true;
              update('ended', false);
              void client.invalidateQueries({
                queryKey: sessionKey(apiClient),
              });
            }
          },
        });
      } catch (error) {
        if (
          ['auth.unauthorized', 'api_keys.scope_forbidden'].includes(
            errorCodeOf(error) ?? '',
          )
        ) {
          ended = true;
          update('ended', false);
          void client.invalidateQueries({ queryKey: sessionKey(apiClient) });
        }
      }
      if (controller.signal.aborted || ended) return;
      update('offline', false);
      timer = setTimeout(() => {
        update('connecting', false);
        void connect();
      }, 1000);
    }
    const offline = () => {
      update('offline', false);
      controller.abort();
      clearTimeout(timer);
    };
    const online = () => setRetry((value) => value + 1);
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    void connect();
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
    };
  }, [apiClient, client, userId, labId, scope, retry]);
  return {
    ...(connection.scope === scope
      ? connection
      : { scope, status: 'connecting' as const, available: false }),
    reconnect: () => {
      setConnection((previous) => ({
        ...previous,
        scope,
        status: 'connecting',
        available: false,
      }));
      setRetry((value) => value + 1);
    },
  };
}
