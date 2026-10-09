import { useState } from 'react';
import { Play, Square } from 'lucide-react';
import type { EntityAction, LabEntity } from '@labos-threejs/sdk';
import { Button } from '@labos-threejs/ui/components/button';
import { Input } from '@labos-threejs/ui/components/input';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Progress } from '@labos-threejs/ui/components/progress';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
  DialogClose,
} from '@labos-threejs/ui/components/dialog';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@labos-threejs/ui/components/field';
import { useAppMessage } from '../shell/messages';
import type { DeviceInput } from './device-panel';

export function activeTask(entity: LabEntity) {
  return (
    !!entity.task &&
    ['pending', 'preparing', 'running', 'decelerating'].includes(
      entity.task.status,
    )
  );
}
export default function CentrifugePanel({
  entity,
  locked,
  available,
  submit,
  input,
  onInput,
  startAvailable = true,
  stopAvailable = true,
}: {
  entity: LabEntity;
  locked: boolean;
  available: boolean;
  submit: (input: EntityAction) => Promise<void>;
  input: DeviceInput;
  onInput: (input: DeviceInput) => void;
  startAvailable?: boolean;
  stopAvailable?: boolean;
}) {
  const message = useAppMessage('lab');
  const [stopping, setStopping] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const busy = activeTask(entity);
  const disabled = locked || busy || !available || !startAvailable;
  const parameters = entity.task?.parameters as
    { rpm: number; temperature: number; duration_seconds: number } | undefined;
  const specification = entity.capabilities.find(
    (capability) => capability.id === 'centrifuge.start',
  )?.parameters as
    | {
        properties?: Record<
          string,
          { minimum?: number; maximum?: number; type?: string }
        >;
      }
    | undefined;
  const limits = specification?.properties ?? {};
  return (
    <section aria-label={message('task.title')} className="centrifuge-panel">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit({
            capability: 'centrifuge.start',
            parameters: {
              rpm: Number(input.rpm),
              temperature: Number(input.temperature),
              duration_seconds: Number(input.duration),
            },
          });
        }}
      >
        <FieldGroup>
          <Field data-disabled={disabled}>
            <FieldLabel htmlFor={`rpm-${entity.id}`}>
              {message('task.targetRpm')}
            </FieldLabel>
            <Input
              id={`rpm-${entity.id}`}
              type="number"
              min={limits.rpm?.minimum}
              max={limits.rpm?.maximum}
              step={1}
              required
              value={busy ? (parameters?.rpm ?? '') : input.rpm}
              onChange={(event) =>
                onInput({ ...input, rpm: event.target.value })
              }
              disabled={disabled}
            />
          </Field>
          <Field data-disabled={disabled}>
            <FieldLabel htmlFor={`temperature-${entity.id}`}>
              {message('task.targetTemperature')}
            </FieldLabel>
            <Input
              id={`temperature-${entity.id}`}
              type="number"
              min={limits.temperature?.minimum}
              max={limits.temperature?.maximum}
              step="any"
              required
              value={busy ? (parameters?.temperature ?? '') : input.temperature}
              onChange={(event) =>
                onInput({ ...input, temperature: event.target.value })
              }
              disabled={disabled}
            />
          </Field>
          <Field data-disabled={disabled}>
            <FieldLabel htmlFor={`duration-${entity.id}`}>
              {message('task.duration')}
            </FieldLabel>
            <Input
              id={`duration-${entity.id}`}
              type="number"
              min={limits.duration_seconds?.minimum}
              max={limits.duration_seconds?.maximum}
              step={1}
              required
              value={
                busy ? (parameters?.duration_seconds ?? '') : input.duration
              }
              onChange={(event) =>
                onInput({ ...input, duration: event.target.value })
              }
              disabled={disabled}
            />
          </Field>
        </FieldGroup>
        <div className="centrifuge-actions">
          <Button size="sm" type="submit" disabled={disabled}>
            <Play data-icon="inline-start" />
            {message('task.start')}
          </Button>
          <Dialog open={confirmStop} onOpenChange={setConfirmStop}>
            <DialogTrigger
              render={
                <Button
                  size="sm"
                  type="button"
                  variant="outline"
                  disabled={
                    !available ||
                    !stopAvailable ||
                    stopping ||
                    entity.task?.status === 'decelerating'
                  }
                />
              }
            >
              <Square data-icon="inline-start" />
              {message('task.stop')}
            </DialogTrigger>
            <DialogContent>
              <DialogTitle>{message('task.confirmStop')}</DialogTitle>
              <DialogDescription>
                {message('task.confirmStopDescription', { name: entity.name })}
              </DialogDescription>
              <div className="centrifuge-actions">
                <DialogClose
                  render={<Button type="button" variant="outline" />}
                >
                  {message('task.continue')}
                </DialogClose>
                <Button
                  type="button"
                  disabled={!available || !stopAvailable || stopping}
                  onClick={async () => {
                    setConfirmStop(false);
                    setStopping(true);
                    try {
                      await submit({
                        capability: 'centrifuge.stop',
                        parameters: {},
                      });
                    } finally {
                      setStopping(false);
                    }
                  }}
                >
                  <Square data-icon="inline-start" />
                  {message('task.stop')}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </form>
      {entity.task ? (
        <section
          className="centrifuge-task"
          aria-label={message('task.current')}
        >
          <div className="lab-section-heading">
            <h3>{message(busy ? 'task.current' : 'task.recent')}</h3>
            <Badge variant="outline">
              {message(`task.${entity.task.status}`)}
            </Badge>
          </div>
          <Progress
            aria-label={message('task.effectiveTime')}
            value={
              parameters?.duration_seconds
                ? Math.min(
                    100,
                    Math.max(
                      0,
                      (100 * entity.task.elapsed_seconds) /
                        parameters.duration_seconds,
                    ),
                  )
                : null
            }
          />
          <p className="task-counted-time">
            {message('task.effectiveTime')}{' '}
            {entity.task.elapsed_seconds.toFixed(1)} /{' '}
            {parameters?.duration_seconds ?? message('world.unknown')} s
          </p>
          <dl className="world-properties">
            <dt>Task</dt>
            <dd>{entity.task.id}</dd>
            <dt>Command</dt>
            <dd>{entity.task.command_id}</dd>
            <dt>Run</dt>
            <dd>{entity.task.run_id}</dd>
            <dt>{message('task.targetRpm')}</dt>
            <dd>{parameters?.rpm} rpm</dd>
            <dt>{message('task.targetTemperature')}</dt>
            <dd>{parameters?.temperature} degC</dd>
            <dt>{message('task.duration')}</dt>
            <dd>{parameters?.duration_seconds} s</dd>
            <dt>{message('task.elapsed')}</dt>
            <dd>{entity.task.elapsed_seconds.toFixed(1)} s</dd>
            <dt>{message('task.result')}</dt>
            <dd>{entity.task.result_id}</dd>
            <dt>{message('task.resultStatus')}</dt>
            <dd>
              {message(`task.${entity.task_result?.status ?? 'unknown'}`)}
            </dd>
            {entity.task_result?.reason ? (
              <>
                <dt>{message('task.reason')}</dt>
                <dd>{message(`task.reason.${entity.task_result.reason}`)}</dd>
              </>
            ) : null}
          </dl>
        </section>
      ) : null}
    </section>
  );
}
