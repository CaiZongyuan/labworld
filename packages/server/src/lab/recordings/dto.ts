import { z } from '@hono/zod-openapi';
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/),
  u64 = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const RecordingPrefix = z
  .object({
    source_packet_sequence: u64,
    source_prefix_sha256: digest.nullable(),
    last_source_sequence: u64,
    last_source_event_sequence: u64,
    last_sim_time_ns: u64,
    source_ended: z.boolean(),
  })
  .openapi('RecordingPrefix');
export const LabRecording = z
  .object({
    id: z.string().uuid(),
    session_id: z.string().uuid(),
    lab_id: z.string().uuid(),
    snapshot_hash: digest,
    manifest_sha256: digest.nullable(),
    status: z.enum([
      'preparing',
      'open',
      'complete',
      'incomplete',
      'deleting',
      'deleted',
    ]),
    reason: z.string().nullable(),
    gaps: z.array(
      z.object({
        reason: z.string(),
        after_source_sequence: u64,
        after_server_event_sequence: u64,
        until: z.null(),
      }),
    ),
    started_at: z.string(),
    ended_at: z.string().nullable(),
    integrity: z.enum(['recording', 'complete', 'incomplete']),
    prefix: RecordingPrefix,
    seal: z.record(z.string(), z.unknown()).nullable(),
  })
  .openapi('LabRecording');
export const LabRecordingPage = z
  .object({ data: z.array(LabRecording), next_cursor: z.string().nullable() })
  .openapi('LabRecordingPage');
export const RecordingSegment = z
  .object({
    id: z.string().uuid(),
    index: z.number().int(),
    file_id: z.string().uuid().nullable(),
    sealed: z.boolean(),
    size: z.number().int(),
    sha256: digest,
    first_ordinal: u64,
    last_ordinal: u64,
  })
  .openapi('RecordingSegment');
export const RecordingSegmentPage = z
  .object({
    data: z.array(RecordingSegment),
    next_cursor: z.string().nullable(),
  })
  .openapi('RecordingSegmentPage');
export const RecordingEvent = z
  .object({
    ordinal: u64,
    event_id: z.string().uuid(),
    event_type: z.string(),
    entity_id: z.string().uuid().nullable(),
    recorded_at: z.string(),
    sim_time_ns: u64.nullable(),
    event: z.record(z.string(), z.unknown()),
  })
  .openapi('RecordingEvent');
export const RecordingEventPage = z
  .object({
    data: z.array(RecordingEvent),
    next_cursor: z.string().nullable(),
    integrity: z.enum(['recording', 'complete', 'incomplete']),
  })
  .openapi('RecordingEventPage');
export const RecordingManifest = z
  .object({
    format: z.literal('lab-word-recording-manifest-v1'),
    recording_id: z.string().uuid(),
    session_id: z.string().uuid(),
    snapshot_hash: digest,
    snapshot: z.record(z.string(), z.unknown()),
    capture_baseline: z.record(z.string(), z.unknown()),
    capture_entity_ids: z.array(z.string().uuid()),
    physics_entity_ids: z.array(z.string().uuid()),
    versions: z.record(z.string(), z.unknown()),
  })
  .openapi('RecordingManifest');
export type RecordingMetadata = z.infer<typeof LabRecording>;
