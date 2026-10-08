import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import {
  getLabDeviceCommand,
  type ApiClient,
  type CurrentSession,
  type LabEntity,
} from '@labos-threejs/sdk';
import { errorCodeOf } from '@labos-threejs/core';
import { Button } from '@labos-threejs/ui/components/button';
import { ErrorAlert } from '../shell/error-alert';
import { useAppMessage } from '../shell/messages';
import { sessionKey } from '../identity/session';
import type { CommandAttempt } from './device-panel';

export function commandAttemptStatus(attempt: CommandAttempt) {
  return attempt.phase === 'accepted'
    ? (attempt.command?.status ?? 'accepted')
    : attempt.phase;
}

export default function CommandFeedback({
  entity,
  apiClient,
  identity,
  attempt,
  onAttempt,
  onRefresh,
  onRetry,
  retryAvailable,
  errorCodes,
}: {
  entity: LabEntity;
  apiClient: ApiClient;
  identity: CurrentSession;
  attempt: CommandAttempt;
  onAttempt: (attempt: CommandAttempt) => void;
  onRefresh: () => Promise<unknown>;
  onRetry: () => void;
  retryAvailable: boolean;
  errorCodes: Record<string, string>;
}) {
  const message = useAppMessage('lab');
  const client = useQueryClient();
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
    enabled: !!attempt.command,
    initialData: attempt.command,
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        const { data } = await getLabDeviceCommand({
          client: apiClient,
          path: {
            lab_id: entity.lab_id,
            entity_id: entity.id,
            command_id: attempt.command!.id,
          },
          signal,
          throwOnError: true,
        });
        if (data.status !== attempt.command?.status)
          onAttempt({ ...attempt, command: data });
        if (!['accepted', 'executing'].includes(data.status))
          void onRefresh().catch(() => {});
        return data;
      } catch (error) {
        if (
          ['auth.unauthorized', 'auth.csrf'].includes(errorCodeOf(error) ?? '')
        )
          void client.invalidateQueries({ queryKey: sessionKey(apiClient) });
        throw error;
      }
    },
    refetchInterval: (query) =>
      query.state.data &&
      ['accepted', 'executing'].includes(query.state.data.status) &&
      Date.now() - attempt.submittedAt < 30000
        ? 500
        : false,
  });
  const data = command.data ?? attempt.command;
  const status =
    attempt.phase === 'accepted' ? (data?.status ?? 'accepted') : attempt.phase;
  const result = data?.result as { reason?: string } | undefined;
  return (
    <section
      className="device-command"
      aria-label={message(`device.action.${attempt.input.capability}`)}
    >
      <h4>{message(`device.action.${attempt.input.capability}`)}</h4>
      <p role="status">
        <strong>{message(`device.command.${status}`)}</strong>
      </p>
      <code>{data?.id ?? attempt.key}</code>
      <small>
        {message('device.requested')}:{' '}
        {JSON.stringify(attempt.input.parameters)}
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
          disabled={!retryAvailable}
          onClick={onRetry}
        >
          <RefreshCw data-icon="inline-start" />
          {message('device.retrySame')}
        </Button>
      ) : data ? (
        <Button
          size="sm"
          variant="outline"
          disabled={command.isFetching}
          onClick={() => void command.refetch()}
        >
          <RefreshCw data-icon="inline-start" />
          {message('device.refreshCommand')}
        </Button>
      ) : null}
      <details>
        <summary>{message('device.commandDetails')}</summary>
        <dl className="world-properties">
          <dt>{message('device.requestKey')}</dt>
          <dd>{attempt.key}</dd>
          <dt>Run</dt>
          <dd>{data?.run_id ?? attempt.runId ?? '-'}</dd>
          {data ? (
            <>
              <dt>{message('device.actor')}</dt>
              <dd>
                {data.actor_id} · {data.actor_source}
              </dd>
            </>
          ) : null}
        </dl>
      </details>
    </section>
  );
}
