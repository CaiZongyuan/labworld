import { useQuery, useQueryClient } from '@tanstack/react-query';
import { errorCodeOf } from '@labos-threejs/core';
import { RefreshCw } from 'lucide-react';
import {
  getLabDeviceCommand,
  type ApiClient,
  type CurrentSession,
  type LabEntity,
} from '@labos-threejs/sdk';
import { Button } from '@labos-threejs/ui/components/button';
import { useAppMessage } from '../shell/messages';
import { ErrorAlert } from '../shell/error-alert';
import type { CommandAttempt } from './device-panel';
import { sessionKey } from '../identity/session';

export function commandAttemptStatus(attempt: CommandAttempt) {
  return attempt.phase === 'accepted'
    ? (attempt.command?.status ?? 'accepted')
    : attempt.phase;
}

export default function CommandFeedback({
  attempt,
  entity,
  apiClient,
  identity,
  onAttempt,
  onRefresh,
  onRetry,
  errorCodes,
  connected = true,
}: {
  attempt: CommandAttempt;
  entity: LabEntity;
  apiClient: ApiClient;
  identity: CurrentSession;
  onAttempt: (attempt: CommandAttempt) => void;
  onRefresh: () => Promise<unknown>;
  onRetry: () => void;
  errorCodes: Record<string, string>;
  connected?: boolean;
}) {
  const message = useAppMessage('lab');
  const queryClient = useQueryClient();
  const command = useQuery({
    queryKey: [
      'lab',
      'command',
      apiClient.getConfig().baseUrl,
      identity.user.id,
      entity.lab_id,
      entity.id,
      attempt.command?.id,
    ],
    enabled: !!attempt.command && connected,
    initialData: attempt.command,
    retry: false,
    queryFn: async ({ signal }) => {
      const { data } = await getLabDeviceCommand({
        client: apiClient,
        path: {
          lab_id: entity.lab_id,
          entity_id: entity.id,
          command_id: attempt.command!.id,
        },
        signal,
        throwOnError: true,
      }).catch(async (error: unknown) => {
        if (
          ['auth.unauthorized', 'auth.csrf'].includes(errorCodeOf(error) ?? '')
        )
          await queryClient.invalidateQueries({
            queryKey: sessionKey(apiClient),
          });
        throw error;
      });
      onAttempt({ ...attempt, command: data });
      if (!['accepted', 'executing'].includes(data.status)) await onRefresh();
      return data;
    },
    refetchInterval: (query) =>
      connected &&
      query.state.data &&
      ['accepted', 'executing'].includes(query.state.data.status) &&
      Date.now() - attempt.submittedAt < 30000
        ? 500
        : false,
  });
  const status = commandAttemptStatus(attempt);
  const result = attempt.command?.result as { reason?: string } | undefined;
  return (
    <div className="device-command" role="status">
      <strong>{message(`device.command.${status}`)}</strong>
      <code>{attempt.command?.id ?? attempt.key}</code>
      <small>
        {attempt.input.capability} · {JSON.stringify(attempt.input.parameters)}
      </small>
      {result?.reason ? (
        <small>{message(`device.reason.${result.reason}`)}</small>
      ) : null}
      {attempt.error ? (
        <ErrorAlert
          error={attempt.error}
          title={message('assets.error')}
          codes={errorCodes}
        />
      ) : null}
      {command.error ? (
        <ErrorAlert
          error={command.error}
          title={message('assets.error')}
          codes={errorCodes}
        />
      ) : null}
      {status === 'uncertain' ? (
        <Button
          size="sm"
          variant="outline"
          disabled={!connected}
          onClick={onRetry}
        >
          <RefreshCw data-icon="inline-start" />
          {message('device.retrySame')}
        </Button>
      ) : attempt.command ? (
        <Button
          size="sm"
          variant="outline"
          disabled={!connected || command.isFetching}
          onClick={() => void command.refetch()}
        >
          <RefreshCw data-icon="inline-start" />
          {message('device.refreshCommand')}
        </Button>
      ) : null}
    </div>
  );
}
