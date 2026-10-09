import { useRef, useState } from 'react';
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
import CentrifugePanel, { activeTask } from './centrifuge-panel';
import { readEntityObservations } from './observation-state';
import CommandFeedback, { commandAttemptStatus } from './command-feedback';
import { sessionKey } from '../identity/session';

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
  brightness: string;
  rpm: string;
  temperature: string;
  duration: string;
  power?: boolean;
};
export const defaultDeviceInput: DeviceInput = {
  brightness: '100',
  rpm: '6000',
  temperature: '4',
  duration: '60',
};
export type ProgramAttempt = {
  key: string;
  operation: 'start' | 'stop' | 'restart';
  phase: 'submitting' | 'succeeded' | 'failed' | 'uncertain';
  stopSucceeded?: boolean;
  error?: unknown;
};
export default function DevicePanel({
  entity,
  apiClient,
  identity,
  attempt,
  attempts: storedAttempts,
  onAttempt,
  onRefresh,
  runtimeAvailable,
  input: storedInput,
  onInput,
  programAttempt: storedProgramAttempt,
  onProgramAttempt,
  connected = true,
  lastSyncedAt,
}: {
  entity: LabEntity;
  apiClient: ApiClient;
  identity: CurrentSession;
  attempt?: CommandAttempt;
  attempts?: EntityCommandAttempts;
  onAttempt: (attempt: CommandAttempt) => void;
  onRefresh: () => Promise<unknown>;
  runtimeAvailable: boolean;
  input?: DeviceInput;
  onInput?: (input: DeviceInput) => void;
  programAttempt?: ProgramAttempt;
  onProgramAttempt?: (attempt: ProgramAttempt) => void;
  connected?: boolean;
  lastSyncedAt?: number;
}) {
  const message = useAppMessage('lab');
  const queryClient = useQueryClient();
  async function refreshIdentity(error: unknown) {
    if (['auth.unauthorized', 'auth.csrf'].includes(errorCodeOf(error) ?? ''))
      await queryClient.invalidateQueries({ queryKey: sessionKey(apiClient) });
  }
  const readings = readEntityObservations(entity, connected);
  const errorCodes = {
    'lab.device_busy': message('task.busy'),
    'lab.invalid_parameters': message('device.invalidParameters'),
    'lab.program_not_running': message('device.startRequired'),
    'lab.runtime_unavailable': message('device.runtimeUnavailable'),
    'idempotency.conflict': message('device.keyConflict'),
    'lab.command_expired': message('device.commandExpired'),
  };
  const [localProgramAttempt, setLocalProgramAttempt] =
    useState<ProgramAttempt>();
  const programAttempt = storedProgramAttempt ?? localProgramAttempt;
  const changeProgramAttempt = onProgramAttempt ?? setLocalProgramAttempt;
  const programPending = programAttempt?.phase === 'submitting';
  const programSubmission = useRef(false);
  const [confirmProgram, setConfirmProgram] = useState<
    'stop' | 'restart' | null
  >(null);
  const [localInput, setLocalInput] = useState(defaultDeviceInput);
  const input = storedInput ?? localInput;
  const changeInput = onInput ?? setLocalInput;
  const submission = useRef<Record<string, boolean>>({});
  const attempts =
    storedAttempts ?? (attempt ? { [attempt.input.capability]: attempt } : {});
  const path = { lab_id: entity.lab_id, entity_id: entity.id };
  const running = entity.program_run?.status === 'running';
  const sourceBlocked =
    !connected ||
    !!entity.archived_at ||
    programPending ||
    !runtimeAvailable ||
    activeTask(entity);
  const executableCapability = (id: string) =>
    connected &&
    runtimeAvailable &&
    !entity.archived_at &&
    entity.capabilities.some(
      (capability) =>
        capability.id === id &&
        capability.binding_implemented &&
        capability.executable,
    );
  const brightnessLimits = (
    entity.capabilities.find(
      (capability) => capability.id === 'light.set_brightness',
    )?.parameters as
      | { properties?: { brightness?: { minimum?: number; maximum?: number } } }
      | undefined
  )?.properties?.brightness;
  const pendingAttempt = (value: CommandAttempt) => {
    const status = commandAttemptStatus(value);
    if (status === 'unknown')
      return (value.command?.run_id ?? value.runId) === entity.program_run?.id;
    return !['succeeded', 'failed', 'rejected'].includes(status);
  };
  const locked = Object.values(attempts).some(pendingAttempt);
  async function program(operation: ProgramAttempt['operation']) {
    if (programSubmission.current || sourceBlocked) return;
    programSubmission.current = true;
    let next: ProgramAttempt = {
      key: crypto.randomUUID(),
      operation,
      phase: 'submitting',
    };
    changeProgramAttempt(next);
    try {
      const options = {
        client: apiClient,
        path,
        headers: { 'x-csrf-token': identity.csrf_token },
        throwOnError: true as const,
      };
      if (operation !== 'start') {
        await stopLabDeviceProgram(options);
        next = { ...next, stopSucceeded: true };
        changeProgramAttempt(next);
        await onRefresh();
      }
      if (operation !== 'stop') await startLabDeviceProgram(options);
      await onRefresh();
      changeProgramAttempt({ ...next, phase: 'succeeded' });
    } catch (error) {
      const code = errorCodeOf(error);
      changeProgramAttempt({
        ...next,
        error,
        phase:
          code && !['lab.unavailable', 'auth.unavailable'].includes(code)
            ? 'failed'
            : 'uncertain',
      });
      await refreshIdentity(error);
      await onRefresh().catch(() => undefined);
    } finally {
      programSubmission.current = false;
    }
  }
  async function submit(input: EntityAction, previous?: CommandAttempt) {
    const same = attempts[input.capability];
    if (
      submission.current[input.capability] ||
      !connected ||
      !runtimeAvailable ||
      programPending ||
      entity.archived_at ||
      (!previous && same && pendingAttempt(same)) ||
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
      runId: entity.program_run?.id,
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
      await refreshIdentity(error);
    } finally {
      delete submission.current[input.capability];
    }
  }
  return (
    <>
      {!connected ? (
        <Alert className="device-connection">
          <AlertDescription>
            <span>{message('device.readonlySnapshot')}</span>
            {lastSyncedAt ? (
              <time dateTime={new Date(lastSyncedAt).toISOString()}>
                {message('device.lastSync')}{' '}
                {new Date(lastSyncedAt).toLocaleString()}
              </time>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      <section className="lab-inspector-section device-readings">
        <div className="lab-section-heading">
          <h3>{message('world.observation')}</h3>
          {readings.keyProperties.length ? (
            <Badge
              variant="outline"
              aria-label={message('device.observationValidity')}
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
        {!readings.keyProperties.length ? (
          <p>{message('world.unknown')}</p>
        ) : null}
      </section>
      {!entity.binding && entity.capabilities.length ? (
        <section
          className="lab-inspector-section"
          aria-label={message('device.capabilityFacts')}
        >
          <h3>{message('device.capabilityFacts')}</h3>
          <p>{message('device.unbound')}</p>
          {entity.capabilities.map((capability) => (
            <div className="device-capability-summary" key={capability.id}>
              <code>{capability.id}</code>
              <div className="entity-detail-tags">
                <Badge variant="outline">
                  {message(
                    capability.definition_supported
                      ? 'device.declared'
                      : 'device.notDeclared',
                  )}
                </Badge>
                <Badge variant="outline">
                  {message(
                    capability.binding_implemented
                      ? 'assets.implemented'
                      : 'assets.declared',
                  )}
                </Badge>
                <Badge variant="outline">
                  {message(
                    connected && runtimeAvailable && capability.executable
                      ? 'device.executable'
                      : 'device.notExecutable',
                  )}
                </Badge>
              </div>
            </div>
          ))}
        </section>
      ) : null}
      {entity.binding ? (
        <section className="lab-inspector-section device-panel">
          <div className="lab-section-heading">
            <h3>{message('device.program')}</h3>
            <Badge variant="outline">
              {message(`device.${entity.program_run?.status ?? 'not_started'}`)}
            </Badge>
          </div>
          {connected && !runtimeAvailable ? (
            <Alert>
              <AlertDescription>
                {message('device.runtimeUnavailable')}
              </AlertDescription>
            </Alert>
          ) : null}
          <details className="device-source-trace">
            <summary>{message('detail.sourceTrace')}</summary>
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
          </details>
          <Dialog
            open={confirmProgram !== null}
            onOpenChange={(open) => {
              if (!open) setConfirmProgram(null);
            }}
          >
            <div className="device-program-actions">
              {running ? (
                <>
                  <DialogTrigger
                    render={
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={sourceBlocked}
                        onClick={() => setConfirmProgram('stop')}
                      />
                    }
                  >
                    <Square data-icon="inline-start" />
                    {message('device.stop')}
                  </DialogTrigger>
                  {!readings.currentValid ? (
                    <DialogTrigger
                      render={
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={sourceBlocked}
                          onClick={() => setConfirmProgram('restart')}
                        />
                      }
                    >
                      <RefreshCw data-icon="inline-start" />
                      {message('device.restart')}
                    </DialogTrigger>
                  ) : null}
                </>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={sourceBlocked}
                  onClick={() => void program('start')}
                >
                  <Play data-icon="inline-start" />
                  {message('device.start')}
                </Button>
              )}
            </div>
            <DialogContent>
              <DialogTitle>
                {message(
                  confirmProgram === 'restart'
                    ? 'device.confirmRestart'
                    : 'device.confirmStop',
                )}
              </DialogTitle>
              <DialogDescription>
                {message('device.confirmProgramDescription', {
                  name: entity.name,
                })}
              </DialogDescription>
              <div className="device-program-actions">
                <DialogClose
                  render={<Button type="button" variant="outline" />}
                >
                  {message('assets.cancel')}
                </DialogClose>
                <Button
                  type="button"
                  disabled={sourceBlocked}
                  onClick={() => {
                    const operation = confirmProgram;
                    setConfirmProgram(null);
                    if (operation) void program(operation);
                  }}
                >
                  <Square data-icon="inline-start" />
                  {message(
                    confirmProgram === 'restart'
                      ? 'device.restart'
                      : 'device.stop',
                  )}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
          {programAttempt ? (
            <div role="status" className="device-source-result">
              {message(
                programAttempt.phase === 'submitting'
                  ? 'device.source.submitting'
                  : programAttempt.operation === 'restart'
                    ? `device.source.${programAttempt.stopSucceeded ? 'restart_stopped' : 'restart_stop'}.${programAttempt.phase}`
                    : `device.source.${programAttempt.operation}.${programAttempt.phase}`,
              )}
            </div>
          ) : null}
          {programAttempt?.error ? (
            <ErrorAlert
              error={programAttempt.error}
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
                  checked={
                    readings.properties.on?.hasValue &&
                    readings.properties.on.property?.value === true
                  }
                  disabled={
                    !executableCapability('light.set_power') ||
                    locked ||
                    programPending
                  }
                  onCheckedChange={(on) => {
                    changeInput({ ...input, power: on });
                    void submit({
                      capability: 'light.set_power',
                      parameters: { on },
                    });
                  }}
                />
                <output aria-label={message('device.requestedPower')}>
                  {message('device.requestedPower')}:{' '}
                  {input.power === undefined
                    ? message('device.notRequested')
                    : message(input.power ? 'device.on' : 'device.off')}
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
                      min={brightnessLimits?.minimum}
                      max={brightnessLimits?.maximum}
                      step="any"
                      required
                      value={input.brightness}
                      onChange={(event) =>
                        changeInput({
                          ...input,
                          brightness: event.target.value,
                        })
                      }
                      disabled={
                        !executableCapability('light.set_brightness') ||
                        locked ||
                        programPending
                      }
                    />
                    <Button
                      type="submit"
                      size="sm"
                      disabled={
                        !executableCapability('light.set_brightness') ||
                        locked ||
                        programPending
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
              available={connected && running && runtimeAvailable}
              submit={submit}
              input={input}
              onInput={changeInput}
              startAvailable={executableCapability('centrifuge.start')}
              stopAvailable={
                executableCapability('centrifuge.stop') &&
                !programPending &&
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
              attempt={value}
              entity={entity}
              apiClient={apiClient}
              identity={identity}
              onAttempt={onAttempt}
              onRefresh={onRefresh}
              errorCodes={errorCodes}
              connected={connected}
              onRetry={() => void submit(value.input, value)}
            />
          ))}
        </section>
      ) : null}
    </>
  );
}
