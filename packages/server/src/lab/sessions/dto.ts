import { z } from '@hono/zod-openapi';
import { LabWorld } from '../world/dto.ts';
export const SessionPose = z
  .object({
    position: z.array(z.number()).length(3),
    quaternion: z.array(z.number()).length(4),
  })
  .openapi('SessionPose');
export const SessionMotionTarget = z
  .object({
    object_key: z.string(),
    pose_key: z.string(),
    entity_id: z.string().uuid(),
    node_id: z.string().uuid(),
    visual_target: z.literal('node-root'),
    body_to_visual: SessionPose,
  })
  .openapi('SessionMotionTarget');
export const SceneInstallation = z
  .object({
    id: z.string().uuid(),
    lab_id: z.string().uuid(),
    package_id: z.literal('development-synthetic'),
    package_version: z.literal('1'),
    scene_hash: z.string(),
    mapping_revision: z.number().int(),
    pose_keys: z.array(z.string()),
    joint_keys: z.array(z.string()),
    targets: z.array(SessionMotionTarget),
    created_at: z.string(),
    archived_at: z.string().nullable(),
  })
  .openapi('SceneInstallation');
export const SessionParameters = z
  .object({
    translation_amplitude: z
      .number()
      .min(0)
      .max(10)
      .describe('Displacement amplitude in metres; default 0.45.'),
    angular_speed: z
      .number()
      .min(0)
      .max(10)
      .describe(
        'Body local Y rotation speed in radians per second; default 1.',
      ),
    joint_amplitude: z
      .number()
      .min(0)
      .max(10)
      .describe('Synthetic joint angle amplitude in radians; default 1.'),
  })
  .strict()
  .openapi('SessionParameters');
export const SimulationSessionSnapshot = z
  .object({
    hash: z.string(),
    installation: SceneInstallation,
    world: LabWorld,
    parameters: SessionParameters,
    initial_poses: z.array(SessionPose),
    initial_joints: z.array(z.number()),
  })
  .openapi('SimulationSessionSnapshot');
export const SimulationSession = z
  .object({
    id: z.string().uuid(),
    lab_id: z.string().uuid(),
    installation_id: z.string().uuid(),
    machine_id: z.string().uuid(),
    status: z.enum([
      'starting',
      'running',
      'pausing',
      'paused',
      'resuming',
      'stopping',
      'stopped',
      'interrupted',
      'reset',
    ]),
    revision: z.number().int(),
    epoch: z.string().nullable(),
    lease_id: z.string().uuid().nullable(),
    snapshot: SimulationSessionSnapshot,
    started_at: z.string(),
    ended_at: z.string().nullable(),
    reason: z.string().nullable(),
    successor_session_id: z.string().uuid().nullable(),
  })
  .openapi('SimulationSession');
export const CreateSceneInstallation = z
  .object({ representation_id: z.string().uuid() })
  .strict()
  .openapi('CreateSceneInstallation');
export const StartSimulationSession = z
  .object({
    installation_id: z.string().uuid(),
    parameters: SessionParameters.partial().optional(),
    machine_id: z.string().uuid().optional(),
  })
  .strict()
  .openapi('StartSimulationSession');
export const SessionTransition = z
  .object({ expected_revision: z.number().int().nonnegative() })
  .strict()
  .openapi('SessionTransition');
export const SceneInstallationPage = z
  .object({ data: z.array(SceneInstallation) })
  .openapi('SceneInstallationPage');
export const SimulationSessionPage = z
  .object({
    data: z.array(SimulationSession),
    active_session_id: z.string().uuid().nullable(),
    development_synthetic_enabled: z.boolean(),
  })
  .openapi('SimulationSessionPage');
export const SessionViewerTicketRequest = z
  .object({ preferred_rate_hz: z.union([z.literal(15), z.literal(30)]) })
  .strict()
  .openapi('SessionViewerTicketRequest');
export const SessionMotionTicket = z
  .object({
    ticket: z.string(),
    expires_in_seconds: z.number().int(),
    websocket_path: z.string(),
  })
  .openapi('SessionMotionTicket');
export const PublisherAdmissionRequest = z
  .object({ machine_id: z.string().uuid() })
  .strict()
  .openapi('PublisherAdmissionRequest');
export const PublisherBootstrap = z
  .object({
    snapshot_hash: z.string(),
    session_id: z.string().uuid(),
    scene_hash: z.string(),
    body_order: z.array(z.string()),
    joint_order: z.array(z.string()),
    initial_poses: z.array(SessionPose),
    initial_joints: z.array(z.number()),
    parameters: SessionParameters,
  })
  .openapi('PublisherBootstrap');
export const PublisherAdmission = SessionMotionTicket.extend({
  lease_id: z.string().uuid(),
  epoch: z.string(),
  bootstrap: PublisherBootstrap,
  recording: z
    .object({
      recording_id: z.string().uuid(),
      session_id: z.string().uuid(),
      lease_id: z.string().uuid(),
      epoch: z.string(),
      snapshot_hash: z.string(),
      manifest_sha256: z.string(),
      scene_hash: z.string(),
      mapping_revision: z.number().int(),
      mapping_sha256: z.string(),
      websocket_path: z.string(),
      ticket: z.string(),
      expires_in_seconds: z.literal(30),
      capture_policy: z.object({
        selection: z.literal('all-selected'),
        sample_hz: z.literal(30),
        motion_codec: z.literal('pose-f32-v1'),
        first_source_sequence: z.literal('1'),
        first_source_event_sequence: z.literal('1'),
      }),
      limits: z.record(z.string(), z.number().int()),
    })
    .optional(),
}).openapi('PublisherAdmission');
export const SimulationSessionEvent = z
  .object({ type: z.literal('session'), session: SimulationSession })
  .openapi('SimulationSessionEvent');
export type Installation = z.infer<typeof SceneInstallation>;
export type Session = z.infer<typeof SimulationSession>;
export type Snapshot = z.infer<typeof SimulationSessionSnapshot>;
export type Parameters = z.infer<typeof SessionParameters>;
export type Start = z.infer<typeof StartSimulationSession>;
