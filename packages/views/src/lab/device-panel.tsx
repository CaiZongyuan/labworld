import { useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Play, RefreshCw, Square } from 'lucide-react';
import {
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
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
  DialogClose,
} from '@labos-threejs/ui/components/dialog';
import { ErrorAlert } from '../shell/error-alert';
import { useAppMessage } from '../shell/messages';
import ObservationReading from './observation-reading';
import { readEntityObservations } from './observation-state';
import CentrifugePanel, { activeTask } from './centrifuge-panel';
import CommandFeedback, { commandAttemptStatus } from './command-feedback';
import { sessionKey } from '../identity/session';
import { entityWithConfirmedRun, type SourceAttempt } from './source-state';
export type { SourceAttempt } from './source-state';

export type CommandAttempt = {
  key: string;
  input: EntityAction;
  phase: 'submitting' | 'accepted' | 'rejected' | 'uncertain';
  submittedAt: number;
  command?: DeviceCommand;
  error?: unknown;
  runId?: string;
};
export type EntityCommandAttempts = Record<string, CommandAttempt>;
export type DeviceInput = {
  power?: boolean;
  brightness: string;
  rpm: string;
  temperature: string;
  duration: string;
};
export const defaultDeviceInput: DeviceInput = {
  brightness: '100',
  rpm: '6000',
  temperature: '4',
  duration: '60',
};
export default function DevicePanel({
  entity,
  apiClient,
  identity,
  attempts,
  onAttempt,
  onRefresh,
  runtimeAvailable,
  input,
  onInput,
  sourceAttempt,
  onSourceAttempt,
}: {
  entity: LabEntity;
  apiClient: ApiClient;
  identity: CurrentSession;
  attempts: EntityCommandAttempts;
  onAttempt: (attempt: CommandAttempt) => void;
  onRefresh: () => Promise<unknown>;
  runtimeAvailable: boolean;
  input: DeviceInput;
  onInput: (input: DeviceInput) => void;
  sourceAttempt?: SourceAttempt;
  onSourceAttempt: (attempt: SourceAttempt) => void;
}) {
  const message = useAppMessage('lab');
  const client = useQueryClient();
  function refreshIdentity(error: unknown) {
    if (['auth.unauthorized', 'auth.csrf'].includes(errorCodeOf(error) ?? ''))
      void client.invalidateQueries({ queryKey: sessionKey(apiClient) });
  }
  const errorCodes = {
    'lab.device_busy': message('task.busy'),
    'lab.invalid_parameters': message('device.invalidParameters'),
    'lab.program_not_running': message('device.startRequired'),
    'lab.runtime_unavailable': message('device.runtimeUnavailable'),
    'idempotency.conflict': message('device.keyConflict'),
    'lab.command_expired': message('device.commandExpired'),
  };
  const programPending = sourceAttempt?.phase === 'submitting';
  const programSubmission = useRef(false);
  const submission = useRef<Record<string, boolean>>({});
  const path = { lab_id: entity.lab_id, entity_id: entity.id };
  const programRun = entityWithConfirmedRun(entity, sourceAttempt).program_run;
  const running = programRun?.status === 'running';
  const executableCapability = (id: string) =>
    running &&
    !programPending &&
    !entity.archived_at &&
    entity.capabilities.some(
      (capability) =>
        capability.id === id &&
        capability.binding_implemented &&
        capability.executable,
    ) &&
    runtimeAvailable;
  const pendingAttempt = (value: CommandAttempt) => {
    const status = commandAttemptStatus(value);
    if (status === 'uncertain')
      return (value.command?.run_id ?? value.runId) === programRun?.id;
    return !['succeeded', 'failed', 'rejected', 'unknown'].includes(status);
  };
  const locked = Object.values(attempts).some(pendingAttempt);
  async function program(operation: SourceAttempt['operation']) {
    if (
      programSubmission.current ||
      programPending ||
      !runtimeAvailable ||
      entity.archived_at ||
      activeTask(entity)
    )
      return;
    programSubmission.current = true;
    let next: SourceAttempt = {
      key: crypto.randomUUID(),
      operation,
      phase: 'submitting',
      originRunId: programRun?.id,
      confirmedRun: programRun ?? undefined,
    };
    onSourceAttempt(next);
    try {
      const options = {
        client: apiClient,
        path,
        headers: { 'x-csrf-token': identity.csrf_token },
        throwOnError: true as const,
      };
      if (operation !== 'start') {
        const { data } = await stopLabDeviceProgram(options);
        next = { ...next, stopSucceeded: true, confirmedRun: data };
        onSourceAttempt(next);
      }
      if (operation !== 'stop') {
        const { data } = await startLabDeviceProgram(options);
        next = { ...next, confirmedRun: data };
      }
      onSourceAttempt({ ...next, phase: 'succeeded' });
    } catch (error) {
      const code = errorCodeOf(error);
      refreshIdentity(error);
      onSourceAttempt({
        ...next,
        error,
        phase:
          code && !['lab.unavailable', 'auth.unavailable'].includes(code)
            ? 'failed'
            : 'uncertain',
      });
    } finally {
      programSubmission.current = false;
    }
    // World query errors remain visible through their owner after the mutation commits.
    void onRefresh().catch(() => {});
  }
  async function submit(input: EntityAction, previous?: CommandAttempt) {
    if (
      submission.current[input.capability] ||
      !executableCapability(input.capability) ||
      programPending ||
      (previous && previous.runId !== programRun?.id) ||
      (!previous &&
        attempts[input.capability] &&
        pendingAttempt(attempts[input.capability])) ||
      (!previous &&
        input.capability !== 'centrifuge.stop' &&
        (locked || Object.values(submission.current).some(Boolean)))
    )
      return;
    submission.current[input.capability] = true;
    const pending: CommandAttempt = {
      key: previous?.key ?? crypto.randomUUID(),
      input,
      phase: 'submitting',
      submittedAt: Date.now(),
      runId: previous?.runId ?? programRun?.id,
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
    } catch (error) {
      const code = errorCodeOf(error);
      const rejected =
        !!code && code !== 'lab.unavailable' && code !== 'auth.unavailable';
      refreshIdentity(error);
      onAttempt({
        ...pending,
        phase: rejected ? 'rejected' : 'uncertain',
        error,
      });
    } finally {
      submission.current[input.capability] = false;
    }
    void onRefresh().catch(() => {});
  }
  const readings = readEntityObservations(
    { ...entity, program_run: programRun },
    runtimeAvailable,
  );
  const power = readings.properties.on;
  return (
    <>
      <section className="lab-inspector-section device-observations">
        <div className="lab-section-heading">
          <h3>{message('world.observation')}</h3>
          {readings.keyProperties.length ? (
            <Badge
              aria-label={message('device.observationValidity')}
              variant="outline"
            >
              {message(
                readings.currentValid
                  ? 'device.validObservation'
                  : 'device.noValidObservation',
              )}
            </Badge>
          ) : null}
        </div>
        <div className="device-key-readings">
          {Object.entries(readings.properties)
            .filter(([name]) => name !== 'elapsed_seconds')
            .map(([name, reading]) => (
              <ObservationReading key={name} name={name} reading={reading} />
            ))}
        </div>
        {!Object.keys(readings.properties).length ? (
          <p>{message('world.unknown')}</p>
        ) : null}
      </section>
      {entity.binding ? (
        <section
          className="lab-inspector-section device-panel"
          aria-label={message('device.program')}
        >
          <div className="lab-section-heading">
            <h3>{message('device.program')}</h3>
            <Badge variant="outline">
              {message(`device.${programRun?.status ?? 'not_started'}`)}
            </Badge>
          </div>
          {!runtimeAvailable ? (
            <Alert>
              <AlertDescription>
                {message('device.runtimeUnavailable')}
              </AlertDescription>
            </Alert>
          ) : null}

          <Button
            size="sm"
            variant="outline"
            disabled={
              !!entity.archived_at ||
              programPending ||
              !runtimeAvailable ||
              activeTask(entity)
            }
            onClick={() => void program(running ? 'stop' : 'start')}
          >
            {running ? (
              <Square data-icon="inline-start" />
            ) : (
              <Play data-icon="inline-start" />
            )}
            {message(running ? 'device.stop' : 'device.start')}
          </Button>
          {running ? (
            <Dialog>
              <DialogTrigger
                render={
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      programPending ||
                      !runtimeAvailable ||
                      !!entity.archived_at ||
                      activeTask(entity)
                    }
                  />
                }
              >
                <RefreshCw data-icon="inline-start" />
                {message('device.restart')}
              </DialogTrigger>
              <DialogContent>
                <DialogTitle>{message('device.restart')}</DialogTitle>
                <DialogDescription>
                  {message('device.restartNote')}
                </DialogDescription>
                <DialogClose render={<Button variant="outline" />}>
                  {message('viewer.cancel')}
                </DialogClose>
                <DialogClose
                  render={<Button />}
                  onClick={() => void program('restart')}
                >
                  {message('device.confirmRestart')}
                </DialogClose>
              </DialogContent>
            </Dialog>
          ) : null}
          {sourceAttempt ? (
            <p role="status">
              {message(
                sourceAttempt.phase === 'submitting'
                  ? 'device.sourcePending'
                  : sourceAttempt.phase === 'succeeded'
                    ? `device.source.${sourceAttempt.operation === 'stop' ? 'stopped' : 'started'}`
                    : sourceAttempt.phase === 'uncertain'
                      ? 'device.sourceUncertain'
                      : sourceAttempt.operation === 'restart'
                        ? `device.source.${sourceAttempt.stopSucceeded ? 'startFailed' : 'stopFailed'}`
                        : `device.source.${sourceAttempt.operation}Failed`,
              )}
            </p>
          ) : null}
          {sourceAttempt?.phase === 'uncertain' ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void onRefresh().catch(() => {})}
            >
              <RefreshCw data-icon="inline-start" />
              {message('device.refreshSource')}
            </Button>
          ) : null}
          {sourceAttempt?.error ? (
            <ErrorAlert
              error={sourceAttempt.error}
              title={message('assets.error')}
              codes={errorCodes}
            />
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
                  checked={power?.hasValue && power.property?.value === true}
                  disabled={
                    !executableCapability('light.set_power') ||
                    locked ||
                    programPending
                  }
                  onCheckedChange={(on) => {
                    onInput({ ...input, power: on });
                    void submit({
                      capability: 'light.set_power',
                      parameters: { on },
                    });
                  }}
                />
                <output aria-label={message('device.requestedPower')}>
                  {message('device.requestedPower')}:{' '}
                  {message(
                    input.power === undefined
                      ? 'device.notRequested'
                      : input.power
                        ? 'device.on'
                        : 'device.off',
                  )}
                </output>
              </Field>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit({
                    capability: 'light.set_brightness',
                    parameters: { brightness: Number(input.brightness) },
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
                      value={input.brightness}
                      onChange={(event) =>
                        onInput({ ...input, brightness: event.target.value })
                      }
                      disabled={
                        !executableCapability('light.set_brightness') || locked
                      }
                    />
                    <Button
                      type="submit"
                      size="sm"
                      disabled={
                        !executableCapability('light.set_brightness') || locked
                      }
                    >
                      <Check data-icon="inline-start" />
                      {message('device.apply')}
                    </Button>
                  </div>
                </Field>
              </form>
            </FieldGroup>
          ) : null}
          {entity.binding.program_id === 'centrifuge.v1' ? (
            <CentrifugePanel
              entity={entity}
              locked={locked || programPending}
              available={running && runtimeAvailable}
              submit={submit}
              input={input}
              onInput={onInput}
              startAvailable={executableCapability('centrifuge.start')}
              stopAvailable={
                executableCapability('centrifuge.stop') &&
                !(
                  attempts['centrifuge.stop'] &&
                  pendingAttempt(attempts['centrifuge.stop'])
                )
              }
            />
          ) : null}
          {Object.values(attempts).map((value) => (
            <CommandFeedback
              key={value.key}
              entity={entity}
              apiClient={apiClient}
              identity={identity}
              attempt={value}
              onAttempt={onAttempt}
              onRefresh={onRefresh}
              onRetry={() => void submit(value.input, value)}
              retryAvailable={
                executableCapability(value.input.capability) &&
                !programPending &&
                value.runId === programRun?.id
              }
              errorCodes={errorCodes}
            />
          ))}
        </section>
      ) : null}
    </>
  );
}
