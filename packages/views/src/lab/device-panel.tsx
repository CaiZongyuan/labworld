import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Play, RefreshCw, Square } from 'lucide-react';
import {
  getLabDeviceCommand,
  invokeLabEntityAction,
  startLabDeviceProgram,
  stopLabDeviceProgram,
  type ApiClient,
  type CurrentSession,
  type DeviceCommand,
  type EntityAction,
  type LabEntity,
} from '@labos-threejs/sdk';
import { errorCodeOf } from '@labos-threejs/core';
import { Button } from '@labos-threejs/ui/components/button';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Input } from '@labos-threejs/ui/components/input';
import { Switch } from '@labos-threejs/ui/components/switch';
import {
  Field,
  FieldLabel,
  FieldGroup,
} from '@labos-threejs/ui/components/field';
import { Alert, AlertDescription } from '@labos-threejs/ui/components/alert';
import { ErrorAlert } from '../shell/error-alert';
import { useAppMessage } from '../shell/messages';
import ObservationReading from './observation-reading';

export type CommandAttempt = {
  key: string;
  input: EntityAction;
  phase: 'submitting' | 'accepted' | 'rejected' | 'uncertain';
  submittedAt: number;
  command?: DeviceCommand;
  error?: unknown;
};
export default function DevicePanel({
  entity,
  apiClient,
  identity,
  attempt,
  onAttempt,
  onRefresh,
  runtimeAvailable,
}: {
  entity: LabEntity;
  apiClient: ApiClient;
  identity: CurrentSession;
  attempt?: CommandAttempt;
  onAttempt: (attempt: CommandAttempt) => void;
  onRefresh: () => Promise<unknown>;
  runtimeAvailable: boolean;
}) {
  const message = useAppMessage('lab');
  const [programPending, setProgramPending] = useState(false);
  const [programError, setProgramError] = useState<unknown>(null);
  const [brightness, setBrightness] = useState('100');
  const path = { lab_id: entity.lab_id, entity_id: entity.id };
  const running = entity.program_run?.status === 'running';
  const executable =
    entity.capabilities.some((capability) => capability.executable) &&
    runtimeAvailable;
  const command = useQuery({
    queryKey: [
      'lab',
      'command',
      apiClient.getConfig().baseUrl,
      identity.user.id,
      entity.id,
      attempt?.command?.id,
    ],
    enabled: !!attempt?.command,
    initialData: attempt?.command,
    retry: false,
    queryFn: async ({ signal }) => {
      const { data } = await getLabDeviceCommand({
        client: apiClient,
        path: { ...path, command_id: attempt!.command!.id },
        signal,
        throwOnError: true,
      });
      if (!['accepted', 'executing'].includes(data.status)) await onRefresh();
      return data;
    },
    refetchInterval: (query) =>
      query.state.data &&
      ['accepted', 'executing'].includes(query.state.data.status) &&
      Date.now() - (attempt?.submittedAt ?? 0) < 30000
        ? 500
        : false,
  });
  const status =
    attempt?.phase === 'accepted'
      ? (command.data?.status ?? 'accepted')
      : attempt?.phase;
  const locked =
    !!status &&
    !['succeeded', 'failed', 'rejected', 'unknown'].includes(status);
  async function program() {
    setProgramPending(true);
    setProgramError(null);
    try {
      await (running ? stopLabDeviceProgram : startLabDeviceProgram)({
        client: apiClient,
        path,
        headers: { 'x-csrf-token': identity.csrf_token },
        throwOnError: true,
      });
      await onRefresh();
    } catch (error) {
      setProgramError(error);
    } finally {
      setProgramPending(false);
    }
  }
  async function submit(input: EntityAction, previous?: CommandAttempt) {
    const pending: CommandAttempt = {
      key: previous?.key ?? crypto.randomUUID(),
      input,
      phase: 'submitting',
      submittedAt: Date.now(),
    };
    onAttempt(pending);
    try {
      const { data } = await invokeLabEntityAction({
        client: apiClient,
        path,
        headers: {
          'x-csrf-token': identity.csrf_token,
          'Idempotency-Key': pending.key,
        },
        body: input,
        throwOnError: true,
      });
      onAttempt({ ...pending, phase: 'accepted', command: data });
      await onRefresh();
    } catch (error) {
      const code = errorCodeOf(error);
      const rejected =
        !!code && code !== 'lab.unavailable' && code !== 'auth.unavailable';
      onAttempt({
        ...pending,
        phase: rejected ? 'rejected' : 'uncertain',
        error,
      });
    }
  }
  const values = entity.observation?.values as
    { on?: boolean; brightness?: number } | undefined;
  const result = command.data?.result as { reason?: string } | undefined;
  const time = (value: string | null | undefined) =>
    value
      ? new Date(value).toLocaleString()
      : message('device.sourceTimeUnknown');
  return (
    <>
      {entity.binding ? (
        <section className="lab-inspector-section device-panel">
          <div className="lab-section-heading">
            <h3>{message('device.program')}</h3>
            <Badge variant="outline">
              {message(`device.${entity.program_run?.status ?? 'not_started'}`)}
            </Badge>
          </div>
          {!runtimeAvailable ? (
            <Alert>
              <AlertDescription>
                {message('device.runtimeUnavailable')}
              </AlertDescription>
            </Alert>
          ) : null}
          <dl className="world-properties">
            <dt>Binding</dt>
            <dd>{entity.binding.id}</dd>
            <dt>Program</dt>
            <dd>{entity.binding.program_id}</dd>
            {entity.program_run ? (
              <>
                <dt>Run</dt>
                <dd>{entity.program_run.id}</dd>
              </>
            ) : null}
          </dl>
          <Button
            size="sm"
            variant="outline"
            disabled={programPending || !runtimeAvailable}
            onClick={() => void program()}
          >
            {running ? (
              <Square data-icon="inline-start" />
            ) : (
              <Play data-icon="inline-start" />
            )}
            {message(running ? 'device.stop' : 'device.start')}
          </Button>
          {programError ? (
            <ErrorAlert error={programError} title={message('assets.error')} />
          ) : null}
          {entity.binding.program_id === 'light.v1' ? (
            <FieldGroup>
              <Field orientation="horizontal">
                <FieldLabel htmlFor={`power-${entity.id}`}>
                  {message('device.power')}
                </FieldLabel>
                <Switch
                  id={`power-${entity.id}`}
                  nativeButton
                  render={<button />}
                  checked={values?.on === true}
                  disabled={!executable || locked || programPending}
                  onCheckedChange={(on) =>
                    void submit({
                      capability: 'light.set_power',
                      parameters: { on },
                    })
                  }
                />
              </Field>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit({
                    capability: 'light.set_brightness',
                    parameters: { brightness: Number(brightness) },
                  });
                }}
              >
                <Field>
                  <FieldLabel htmlFor={`brightness-${entity.id}`}>
                    {message('device.targetBrightness')}
                  </FieldLabel>
                  <div className="device-brightness">
                    <Input
                      id={`brightness-${entity.id}`}
                      type="number"
                      min={0}
                      max={100}
                      step="any"
                      required
                      value={brightness}
                      onChange={(event) => setBrightness(event.target.value)}
                      disabled={!executable || locked}
                    />
                    <Button
                      type="submit"
                      size="sm"
                      disabled={!executable || locked}
                    >
                      <Check data-icon="inline-start" />
                      {message('device.apply')}
                    </Button>
                  </div>
                </Field>
              </form>
            </FieldGroup>
          ) : null}
          {attempt ? (
            <div className="device-command" role="status">
              <strong>{message(`device.command.${status}`)}</strong>
              <code>{command.data?.id ?? attempt.key}</code>
              <small>{JSON.stringify(attempt.input.parameters)}</small>
              {result?.reason ? (
                <small>{message(`device.reason.${result.reason}`)}</small>
              ) : null}
              {attempt.error ? (
                <ErrorAlert
                  error={attempt.error}
                  title={message('assets.error')}
                />
              ) : null}
              {command.error ? (
                <ErrorAlert
                  error={command.error}
                  title={message('assets.error')}
                />
              ) : null}
              {status === 'uncertain' ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void submit(attempt.input, attempt)}
                >
                  <RefreshCw data-icon="inline-start" />
                  {message('device.retrySame')}
                </Button>
              ) : attempt.command ? (
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
            </div>
          ) : null}
        </section>
      ) : null}
      {entity.observation ? (
        <section className="lab-inspector-section">
          <h3>{message('world.observation')}</h3>
          {entity.observation.properties ? (
            Object.entries(entity.observation.properties).map(
              ([name, property]) => (
                <ObservationReading
                  key={name}
                  name={name}
                  property={property}
                />
              ),
            )
          ) : (
            <dl className="world-properties">
              <dt>{message('device.actualPower')}</dt>
              <dd>{message(values?.on ? 'device.on' : 'device.off')}</dd>
              <dt>{message('device.actualBrightness')}</dt>
              <dd>{values?.brightness ?? '-'} %</dd>
              <dt>{message('assets.source')}</dt>
              <dd>{entity.observation.source}</dd>
              <dt>{message('device.observedAt')}</dt>
              <dd>{time(entity.observation.observed_at)}</dd>
              <dt>{message('device.receivedAt')}</dt>
              <dd>{time(entity.observation.received_at)}</dd>
              <dt>{message('device.updatedAt')}</dt>
              <dd>{time(entity.observation.updated_at)}</dd>
              <dt>{message('device.quality')}</dt>
              <dd>{message(`device.quality.${entity.observation.quality}`)}</dd>
              <dt>{message('device.freshness')}</dt>
              <dd>
                {message(`device.freshness.${entity.observation.freshness}`)}
              </dd>
            </dl>
          )}
          {!entity.observation.properties &&
          entity.observation.freshness !== 'current' ? (
            <Alert>
              <AlertDescription>
                {message(`device.freshness.${entity.observation.freshness}`)}
              </AlertDescription>
            </Alert>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
