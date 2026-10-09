import { useState } from 'react';
import { Play, Square } from 'lucide-react';
import type { EntityAction, LabEntity } from '@labos-threejs/sdk';
import { Button } from '@labos-threejs/ui/components/button';
import { Input } from '@labos-threejs/ui/components/input';
import { Badge } from '@labos-threejs/ui/components/badge';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@labos-threejs/ui/components/field';
import { useAppMessage } from '../shell/messages';

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
}: {
  entity: LabEntity;
  locked: boolean;
  available: boolean;
  submit: (input: EntityAction) => Promise<void>;
}) {
  const message = useAppMessage('lab');
  const [rpm, setRpm] = useState('6000');
  const [temperature, setTemperature] = useState('4');
  const [duration, setDuration] = useState('60');
  const [stopping, setStopping] = useState(false);
  const busy = activeTask(entity);
  const disabled = locked || busy || !available;
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
              rpm: Number(rpm),
              temperature: Number(temperature),
              duration_seconds: Number(duration),
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
              value={rpm}
              onChange={(event) => setRpm(event.target.value)}
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
              value={temperature}
              onChange={(event) => setTemperature(event.target.value)}
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
              value={duration}
              onChange={(event) => setDuration(event.target.value)}
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
            disabled={!available || stopping}
            onClick={async () => {
              setStopping(true);
              try {
                await submit({ capability: 'centrifuge.stop', parameters: {} });
              } finally {
                setStopping(false);
              }
            }}
          >
            <Square data-icon="inline-start" />
            {message('task.stop')}
          </Button>
        </div>
      </form>
      {entity.task ? (
        <section
          className="centrifuge-task"
          aria-label={message('task.current')}
        >
          <div className="lab-section-heading">
            <h3>{message('task.current')}</h3>
            <Badge variant="outline">
              {message(`task.${entity.task.status}`)}
            </Badge>
          </div>
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
              {message(`task.${entity.task_result?.status ?? 'pending'}`)}
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
