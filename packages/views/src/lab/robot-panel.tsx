import { Home, Check, Square } from 'lucide-react';
import type {
  EntityAction,
  LabEntity,
  SimulationSession,
} from '@labos-threejs/sdk';
import { Button } from '@labos-threejs/ui/components/button';
import { Input } from '@labos-threejs/ui/components/input';
import { Badge } from '@labos-threejs/ui/components/badge';
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from '@labos-threejs/ui/components/field';
import { Alert, AlertDescription } from '@labos-threejs/ui/components/alert';
import { useAppMessage } from '../shell/messages';
import { robotReasonMessage } from './messages';
import type { DeviceInput } from './device-panel';
import { activeTask } from './centrifuge-panel';

function jointProfile(session?: SimulationSession | null) {
  const profile = session?.snapshot.physics?.profile;
  if (!profile) return [];
  const names = profile.joint_order;
  const limits = profile.joint_limits;
  if (!Array.isArray(names) || !Array.isArray(limits) || names.length !== 6)
    return [];
  const joints = names.map((name, index) => {
    const limit: unknown = limits[index];
    if (
      typeof name !== 'string' ||
      !Array.isArray(limit) ||
      limit.length !== 2 ||
      !limit.every(
        (value) => typeof value === 'number' && Number.isFinite(value),
      ) ||
      limit[0] >= limit[1]
    )
      return null;
    return { name, min: limit[0] as number, max: limit[1] as number };
  });
  return joints.every((joint) => joint !== null) ? joints : [];
}

export default function RobotPanel({
  entity,
  session,
  locked,
  available,
  executable,
  submit,
  input,
  onInput,
}: {
  entity: LabEntity;
  session?: SimulationSession | null;
  locked: boolean;
  available: boolean;
  executable: (capability: string) => boolean;
  submit: (input: EntityAction) => Promise<void>;
  input: DeviceInput;
  onInput: (input: DeviceInput) => void;
}) {
  const message = useAppMessage('lab');
  const joints = jointProfile(session);
  const busy = activeTask(entity);
  const sameSession =
    !!session &&
    !session.ended_at &&
    session.snapshot.installation.targets.some(
      (target) => target.entity_id === entity.id,
    );
  const ready =
    available &&
    sameSession &&
    session?.status === 'running' &&
    joints.length === 6;
  const values =
    input.robotJoints ?? session?.snapshot.initial_joints.map(String) ?? [];
  const gripper = input.robotGripper ?? values[5] ?? '';
  function changeJoint(index: number, value: string) {
    const next = [...values];
    next[index] = value;
    onInput({ ...input, robotJoints: next });
  }
  const validJoints = joints.every((joint, index) => {
    const value = Number(values[index]);
    return (
      values[index]?.trim() !== '' &&
      Number.isFinite(value) &&
      value >= joint.min &&
      value <= joint.max
    );
  });
  const gripperLimit = joints[5];
  const validGripper =
    !!gripperLimit &&
    gripper.trim() !== '' &&
    Number.isFinite(Number(gripper)) &&
    Number(gripper) >= gripperLimit.min &&
    Number(gripper) <= gripperLimit.max;
  const disabled = locked || busy || !ready;
  const task = entity.task;
  return (
    <section className="robot-panel" aria-label={message('robot.title')}>
      <p>{message('robot.description')}</p>
      {!sameSession || !joints.length ? (
        <Alert>
          <AlertDescription>{message('robot.startRequired')}</AlertDescription>
        </Alert>
      ) : session?.status === 'paused' ? (
        <Alert>
          <AlertDescription>{message('robot.paused')}</AlertDescription>
        </Alert>
      ) : null}
      {busy ? <p role="status">{message('robot.busy')}</p> : null}
      <div className="robot-actions">
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || !executable('robot.home')}
          onClick={() =>
            void submit({ capability: 'robot.home', parameters: {} })
          }
        >
          <Home data-icon="inline-start" />
          {message('robot.home')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={
            !busy ||
            !available ||
            !sameSession ||
            !executable('robot.cancel') ||
            task?.status === 'decelerating'
          }
          onClick={() =>
            void submit({ capability: 'robot.cancel', parameters: {} })
          }
        >
          <Square data-icon="inline-start" />
          {message('robot.cancel')}
        </Button>
      </div>
      {joints.length ? (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!disabled && validJoints)
                void submit({
                  capability: 'robot.move_joints',
                  parameters: { joints: values.map(Number) },
                });
            }}
          >
            <FieldGroup>
              {joints.map((joint, index) => (
                <Field key={joint.name} data-disabled={disabled}>
                  <FieldLabel htmlFor={`robot-joint-${entity.id}-${index}`}>
                    {joint.name} (rad)
                  </FieldLabel>
                  <div className="robot-joint-inputs">
                    <Input
                      type="range"
                      aria-label={`${joint.name} ${message('robot.slider')}`}
                      min={joint.min}
                      max={joint.max}
                      step={0.01}
                      value={Number(values[index]) || 0}
                      disabled={disabled || !executable('robot.move_joints')}
                      onChange={(event) =>
                        changeJoint(index, event.target.value)
                      }
                    />
                    <Input
                      id={`robot-joint-${entity.id}-${index}`}
                      type="number"
                      min={joint.min}
                      max={joint.max}
                      step="any"
                      required
                      value={values[index] ?? ''}
                      disabled={disabled || !executable('robot.move_joints')}
                      onChange={(event) =>
                        changeJoint(index, event.target.value)
                      }
                    />
                  </div>
                  <FieldDescription>
                    {joint.min.toFixed(3)} … {joint.max.toFixed(3)} rad
                  </FieldDescription>
                </Field>
              ))}
              <Button
                type="submit"
                size="sm"
                disabled={
                  disabled || !validJoints || !executable('robot.move_joints')
                }
              >
                <Check data-icon="inline-start" />
                {message('robot.applyJoints')}
              </Button>
            </FieldGroup>
          </form>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!disabled && validGripper)
                void submit({
                  capability: 'robot.set_gripper',
                  parameters: { position: Number(gripper) },
                });
            }}
          >
            <FieldGroup>
              <Field data-disabled={disabled}>
                <FieldLabel htmlFor={`robot-gripper-${entity.id}`}>
                  {message('robot.gripper')}
                </FieldLabel>
                <div className="device-brightness">
                  <Input
                    id={`robot-gripper-${entity.id}`}
                    type="number"
                    min={gripperLimit.min}
                    max={gripperLimit.max}
                    step="any"
                    required
                    value={gripper}
                    disabled={disabled || !executable('robot.set_gripper')}
                    onChange={(event) =>
                      onInput({ ...input, robotGripper: event.target.value })
                    }
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={
                      disabled ||
                      !validGripper ||
                      !executable('robot.set_gripper')
                    }
                  >
                    {message('device.apply')}
                  </Button>
                </div>
                <FieldDescription>
                  {message('robot.gripperHint')}
                </FieldDescription>
              </Field>
            </FieldGroup>
          </form>
        </>
      ) : null}
      <RobotTaskStatus entity={entity} />
    </section>
  );
}

export function RobotTaskStatus({ entity }: { entity: LabEntity }) {
  const message = useAppMessage('lab');
  const phase = entity.observation?.properties.phase;
  const observedPhase = typeof phase?.value === 'string' ? phase.value : null;
  const task = entity.task;
  const result =
    entity.task_result?.task_id === task?.id ? entity.task_result : null;
  return (
    <section className="robot-task" aria-label={message('robot.task')}>
      <div className="lab-section-heading">
        <h4>{message('robot.task')}</h4>
        <Badge variant={task?.status === 'completed' ? 'success' : 'outline'}>
          {message(`robot.task.${task?.status ?? 'idle'}`)}
        </Badge>
      </div>
      <p role="status">{message('robot.acceptanceNote')}</p>
      {task ? (
        <dl className="world-properties">
          <dt>Task</dt>
          <dd>{task.id}</dd>
          {observedPhase ? (
            <>
              <dt>{message('robot.phase')}</dt>
              <dd>{message(`robot.phase.${observedPhase}`)}</dd>
            </>
          ) : null}
          <dt>{message('task.resultStatus')}</dt>
          <dd>
            {result
              ? message(`robot.task.${result.status}`)
              : message('robot.awaitingResult')}
          </dd>
          {result?.reason ? (
            <>
              <dt>{message('task.reason')}</dt>
              <dd>{robotReasonMessage(result.reason, message)}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {task && ['unknown', 'interrupted'].includes(task.status) ? (
        <Alert>
          <AlertDescription>{message('robot.unknown')}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}
