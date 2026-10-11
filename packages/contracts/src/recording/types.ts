/** Reliable selected-source contract; independent of the live LWM1 stream. */
export const RECORDING_CODEC = 'lwr1-source-v1';
export const RECORDING_HEADER_BYTES = 96;
export const RECORDING_WIRE_LIMITS = Object.freeze({
  packet_bytes: 65536,
  frame_batch_frames: 32,
  event_bytes: 16384,
  end_bytes: 4096,
  hello_bytes: 16384,
  ack_bytes: 4096,
});
export const RECORDING_CAPTURE_POLICY = Object.freeze({
  selection: 'all-selected',
  sample_hz: 30,
  motion_codec: 'pose-f32-v1',
  first_source_sequence: '1',
  first_source_event_sequence: '1',
} as const);
export type RecordingCapturePolicy = typeof RECORDING_CAPTURE_POLICY;
export interface RecordingLimits {
  source_frames: number;
  source_events: number;
  source_bytes: number;
  packet_bytes: number;
  frame_batch_frames: number;
  event_bytes: number;
  end_bytes: number;
  hello_bytes: number;
  ack_bytes: number;
  server_records: number;
  server_bytes: number;
  durability_timeout_ms: number;
  retry_attempts: number;
  retry_first_ms: number;
  retry_second_ms: number;
  sync_flush_ms: number;
  segment_bytes: number;
  segment_ms: number;
  lifecycle_ack_timeout_ms: number;
  heartbeat_grace_ms: number;
}
export function recordingLimits(
  lifecycleAckTimeoutMs = 3000,
  heartbeatGraceMs = 5000,
): RecordingLimits {
  if (
    !Number.isInteger(lifecycleAckTimeoutMs) ||
    lifecycleAckTimeoutMs < 1000 ||
    !Number.isInteger(heartbeatGraceMs) ||
    heartbeatGraceMs < 1000
  )
    throw new RecordingProtocolError(
      'invalid_message',
      'Unsupported Session deadlines',
    );
  const deadline = Math.min(1000, Math.floor(lifecycleAckTimeoutMs / 3));
  return {
    source_frames: 120,
    source_events: 32,
    source_bytes: 4 * 1024 * 1024,
    ...RECORDING_WIRE_LIMITS,
    server_records: 256,
    server_bytes: 8 * 1024 * 1024,
    durability_timeout_ms: deadline,
    retry_attempts: 2,
    retry_first_ms: Math.floor(deadline / 3),
    retry_second_ms: Math.floor((2 * deadline) / 3),
    sync_flush_ms: Math.min(100, Math.floor(deadline / 4)),
    segment_bytes: 1024 * 1024,
    segment_ms: 5000,
    lifecycle_ack_timeout_ms: lifecycleAckTimeoutMs,
    heartbeat_grace_ms: heartbeatGraceMs,
  };
}
export interface RecordingImplementation {
  name: string;
  version: string | null;
  sha256: string | null;
}
export interface RecordingSourceHeader {
  source_kind: 'synthetic' | 'newton';
  implementation: RecordingImplementation;
  python_version: string | null;
  dependencies: readonly RecordingImplementation[];
  capture_policy: RecordingCapturePolicy;
}
export interface RecordingIdentity {
  recording_id: string;
  session_id: string;
  lease_id: string;
  epoch: string;
  snapshot_hash: string;
  manifest_sha256: string;
  scene_hash: string;
  mapping_revision: number;
  mapping_sha256: string;
}
export interface RecordingBootstrap extends RecordingIdentity {
  websocket_path: string;
  ticket: string;
  expires_in_seconds: 30;
  capture_policy: RecordingCapturePolicy;
  limits: RecordingLimits;
}
export interface RecordingHello extends RecordingIdentity {
  type: 'recording.hello';
  version: 1;
  codec: typeof RECORDING_CODEC;
  ticket: string;
  source_header: RecordingSourceHeader;
}
export interface RecordingReady extends RecordingIdentity {
  type: 'recording.ready';
  version: 1;
  codec: typeof RECORDING_CODEC;
  source_header_sha256: string;
  source_prefix_sha256: string;
  capture_policy: RecordingCapturePolicy;
  limits: RecordingLimits;
}
export type RecordingPacketKind = 1 | 2 | 3;
export interface RecordingPacket {
  kind: RecordingPacketKind;
  recording_id: string;
  session_id: string;
  epoch: bigint;
  source_packet_sequence: bigint;
  packet_sha256: string;
  payload: Uint8Array;
}
export interface RecordingSourceEvent {
  source_event_sequence: string;
  event_id: string;
  event_type: 'lifecycle.applied';
  subject: { session_id: string };
  sim_time_ns: string;
  observed_at: string | null;
  event: {
    transition_id: string;
    revision: number;
    action: 'pause' | 'resume' | 'stop';
    boundary_source_sequence: string;
  };
}
export interface RecordingSourceEnd {
  transition_id: string;
  revision: number;
  reason: 'stop';
  last_source_sequence: string;
  last_source_event_sequence: string;
  sim_time_ns: string;
}
export interface RecordingAck {
  type: 'recording.ack';
  version: 1;
  recording_id: string;
  session_id: string;
  lease_id: string;
  epoch: string;
  source_packet_sequence: string;
  packet_sha256: string;
  source_prefix_sha256: string;
  durable_source_sequence: string;
  durable_source_event_sequence: string;
  source_ended: boolean;
}
export class RecordingProtocolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'RecordingProtocolError';
  }
}
