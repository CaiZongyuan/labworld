import { Play, Square } from 'lucide-react';
import type { EntityAction, LabEntity } from '@labos-threejs/sdk';
import { Button } from '@labos-threejs/ui/components/button';
import { Input } from '@labos-threejs/ui/components/input';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Progress } from '@labos-threejs/ui/components/progress';
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
  const busy = activeTask(entity);
  const disabled = locked || busy || !available || !startAvailable;
  const parameters = entity.task?.parameters as
    { rpm: number; temperature: number; duration_seconds: number } | undefined;
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
              min={500}
              max={15000}
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
              min={-10}
              max={40}
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
              min={6}
              max={3600}
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
          <Button
            size="sm"
            type="button"
            variant="outline"
            disabled={!available || !stopAvailable}
            onClick={() =>
              void submit({ capability: 'centrifuge.stop', parameters: {} })
            }
          >
            <Square data-icon="inline-start" />
            {message('task.stop')}
          </Button>
        </div>
      </form>
      {entity.task || entity.task_result ? (
        <section
          className="centrifuge-task"
          aria-label={message('task.current')}
        >
          <div className="lab-section-heading">
            <h3>{message('task.current')}</h3>
            <Badge variant="outline">
              {message(
                `task.${entity.task?.status ?? entity.task_result?.status}`,
              )}
            </Badge>
          </div>
          <dl className="world-properties">
            <dt>{message('task.targetRpm')}</dt>
            <dd>{parameters?.rpm} rpm</dd>
            <dt>{message('task.targetTemperature')}</dt>
            <dd>{parameters?.temperature} degC</dd>
            <dt>{message('task.duration')}</dt>
            <dd>{parameters?.duration_seconds} s</dd>
            <dt>{message('task.elapsed')}</dt>
            <dd>{entity.task?.elapsed_seconds.toFixed(1) ?? '-'} s</dd>
            <dt>{message('task.resultStatus')}</dt>
            <dd>
              {entity.task_result
                ? message(`task.${entity.task_result.status}`)
                : message('detail.noResult')}
            </dd>
            {entity.task_result?.reason ? (
              <>
                <dt>{message('task.reason')}</dt>
                <dd>{message(`task.reason.${entity.task_result.reason}`)}</dd>
              </>
            ) : null}
          </dl>
          {entity.task && parameters && parameters.duration_seconds > 0 ? (
            <Progress
              aria-label={message('task.progress')}
              value={Math.max(
                0,
                Math.min(
                  100,
                  (entity.task.elapsed_seconds / parameters.duration_seconds) *
                    100,
                ),
              )}
            />
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
