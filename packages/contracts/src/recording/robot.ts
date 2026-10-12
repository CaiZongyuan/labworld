import {
  recordingJSON,
  recordingObject,
  recordingUUID,
  recordingU64,
} from './control.ts';
import { RecordingProtocolError, RECORDING_WIRE_LIMITS } from './types.ts';

export const ROBOT_CAPABILITIES = [
  'robot.home',
  'robot.move_joints',
  'robot.set_gripper',
  'robot.cancel',
] as const;
export type RobotCapability = (typeof ROBOT_CAPABILITIES)[number];
export type RobotIdentity = {
  entity_id: string;
  binding_id: string;
  run_id: string;
};
export type RobotCommand = RobotIdentity & {
  type: 'robot.command';
  version: 1;
  recording_id: string;
  session_id: string;
  lease_id: string;
  epoch: string;
  command_id: string;
  task_id: string | null;
  capability: RobotCapability;
  parameters: Record<string, unknown>;
};
type Base = {
  source_event_sequence: string;
  event_id: string;
  subject: RobotIdentity & { session_id: string };
  sim_time_ns: string;
  observed_at: string | null;
};
export type RobotSourceEvent = Base &
  (
    | {
        event_type: 'robot.task';
        event: {
          command_id: string;
          task_id: string | null;
          status:
            | 'running'
            | 'cancel_requested'
            | 'completed'
            | 'cancelled'
            | 'failed';
          phase: string;
          reason: string | null;
          joints: number[];
          velocity: number[];
        };
      }
    | {
        event_type: 'robot.observation';
        event: { joints: number[]; velocity: number[]; phase: string };
      }
  );
function text(value: unknown, max: number) {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > max ||
    !/^[\x20-\x7e]+$/.test(value)
  )
    throw new RecordingProtocolError(
      'invalid_packet',
      'Invalid robot phase or reason',
    );
  return value;
}
function joints(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length !== 6 ||
    value.some(
      (v) => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1000,
    )
  )
    throw new RecordingProtocolError(
      'invalid_packet',
      'Expected six measured robot joints',
    );
  return value as number[];
}
export function parseRobotSourceEvent(encoded: string): RobotSourceEvent {
  const outer = recordingObject(
    recordingJSON(encoded, RECORDING_WIRE_LIMITS.event_bytes, false),
    [
      'source_event_sequence',
      'event_id',
      'event_type',
      'subject',
      'sim_time_ns',
      'observed_at',
      'event',
    ],
  );
  if (recordingU64(outer.source_event_sequence) === 0n)
    throw new RecordingProtocolError(
      'sequence_gap',
      'Source event sequence starts at one',
    );
  recordingU64(outer.sim_time_ns);
  const subject = recordingObject(outer.subject, [
    'session_id',
    'entity_id',
    'binding_id',
    'run_id',
  ]);
  if (
    outer.observed_at !== null &&
    (typeof outer.observed_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(
        outer.observed_at,
      ) ||
      !Number.isFinite(Date.parse(outer.observed_at)) ||
      new Date(outer.observed_at).toISOString().slice(0, 19) !==
        outer.observed_at.slice(0, 19))
  )
    throw new RecordingProtocolError(
      'invalid_packet',
      'Invalid robot observation time',
    );
  const base: Base = {
    source_event_sequence: outer.source_event_sequence as string,
    event_id: recordingUUID(outer.event_id),
    sim_time_ns: outer.sim_time_ns as string,
    observed_at: outer.observed_at as string | null,
    subject: {
      session_id: recordingUUID(subject.session_id),
      entity_id: recordingUUID(subject.entity_id),
      binding_id: recordingUUID(subject.binding_id),
      run_id: recordingUUID(subject.run_id),
    },
  };
  const task = outer.event_type === 'robot.task';
  if (!task && outer.event_type !== 'robot.observation')
    throw new RecordingProtocolError(
      'invalid_packet',
      'Unsupported robot event',
    );
  const event = recordingObject(
    outer.event,
    task
      ? [
          'command_id',
          'task_id',
          'status',
          'phase',
          'reason',
          'joints',
          'velocity',
        ]
      : ['joints', 'velocity', 'phase'],
  );
  const measured = {
    joints: joints(event.joints),
    velocity: joints(event.velocity),
    phase: text(event.phase, 64),
  };
  if (!task)
    return { ...base, event_type: 'robot.observation', event: measured };
  if (
    ![
      'running',
      'cancel_requested',
      'completed',
      'cancelled',
      'failed',
    ].includes(String(event.status))
  )
    throw new RecordingProtocolError(
      'invalid_packet',
      'Invalid robot task status',
    );
  return {
    ...base,
    event_type: 'robot.task',
    event: {
      ...measured,
      command_id: recordingUUID(event.command_id),
      task_id: event.task_id === null ? null : recordingUUID(event.task_id),
      status: event.status as
        'running' | 'cancel_requested' | 'completed' | 'cancelled' | 'failed',
      reason: event.reason === null ? null : text(event.reason, 128),
    },
  };
}
