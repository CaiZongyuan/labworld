import {
  RECORDING_CAPTURE_POLICY,
  RECORDING_CODEC,
  RECORDING_WIRE_LIMITS,
  RecordingProtocolError,
  recordingLimits,
  type RecordingAck,
  type RecordingBootstrap,
  type RecordingCapturePolicy,
  type RecordingHello,
  type RecordingIdentity,
  type RecordingLimits,
  type RecordingReady,
  type RecordingSourceEnd,
  type RecordingSourceEvent,
  type RecordingSourceHeader,
} from './types.ts';

export function recordingObject(
  value: unknown,
  names: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== names.length ||
    names.some((name) => !(name in value))
  )
    throw new RecordingProtocolError(
      'invalid_message',
      'Unexpected Recording fields',
    );
  return value as Record<string, unknown>;
}
export function recordingUUID(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
  )
    throw new RecordingProtocolError(
      'scope_mismatch',
      'Expected canonical UUID',
    );
  return value;
}
export function recordingDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value))
    throw new RecordingProtocolError(
      'invalid_message',
      'Expected canonical SHA-256',
    );
  return value;
}
export function recordingU64(value: unknown): bigint {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,19})$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  )
    throw new RecordingProtocolError(
      'invalid_message',
      'Expected canonical decimal u64',
    );
  return BigInt(value);
}
export function recordingInteger(value: unknown, max = 0xffff_ffff): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > max
  )
    throw new RecordingProtocolError(
      'invalid_message',
      'Expected bounded integer',
    );
  return value;
}
export function recordingJSON(text: string, bound: number): unknown {
  if (
    typeof text !== 'string' ||
    new TextEncoder().encode(text).byteLength > bound
  )
    throw new RecordingProtocolError(
      'invalid_message',
      'Recording control exceeds byte budget',
    );
  try {
    const value: unknown = JSON.parse(text);
    // JSON.parse silently overwrites duplicate fields. Reject that ambiguity at the wire boundary.
    const tokens = text.match(
      /"(?:[^"\\]|\\.)*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g,
    )!;
    const stack: (Set<string> | null)[] = [];
    tokens.forEach((token, index) => {
      if (/^-?\d/.test(token) && /[.eE]/.test(token))
        throw new Error('Recording integers use integer JSON literals');
      if (token === '{') stack.push(new Set());
      else if (token === '[') stack.push(null);
      else if (token === '}' || token === ']') stack.pop();
      else if (
        token.startsWith('"') &&
        tokens[index + 1] === ':' &&
        stack.at(-1)
      ) {
        const name = JSON.parse(token) as string;
        const keys = stack.at(-1)!;
        if (keys.has(name)) throw new Error('Duplicate field');
        keys.add(name);
      }
    });
    return value;
  } catch {
    throw new RecordingProtocolError(
      'invalid_message',
      'Invalid Recording JSON',
    );
  }
}
export function parseCapturePolicy(value: unknown): RecordingCapturePolicy {
  const object = recordingObject(value, Object.keys(RECORDING_CAPTURE_POLICY));
  if (
    Object.entries(RECORDING_CAPTURE_POLICY).some(
      ([key, expected]) => object[key] !== expected,
    )
  )
    throw new RecordingProtocolError(
      'invalid_message',
      'Unsupported capture policy',
    );
  return RECORDING_CAPTURE_POLICY;
}
export function parseRecordingLimits(value: unknown): RecordingLimits {
  const object = recordingObject(value, Object.keys(recordingLimits()));
  for (const field of Object.values(object)) recordingInteger(field);
  const expected = recordingLimits(
    object.lifecycle_ack_timeout_ms as number,
    object.heartbeat_grace_ms as number,
  );
  if (Object.entries(expected).some(([key, entry]) => object[key] !== entry))
    throw new RecordingProtocolError(
      'invalid_message',
      'Recording limits do not match Session deadlines',
    );
  return expected;
}
function sourceText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[\x20-\x21\x23-\x5b\x5d-\x7e]{1,128}$/.test(value)
  )
    throw new RecordingProtocolError(
      'invalid_message',
      'Invalid source version or name',
    );
  return value;
}
export function parseSourceHeader(value: unknown): RecordingSourceHeader {
  const header = recordingObject(value, [
    'source_kind',
    'implementation',
    'python_version',
    'dependencies',
    'capture_policy',
  ]);
  if (header.source_kind !== 'synthetic' && header.source_kind !== 'newton')
    throw new RecordingProtocolError(
      'invalid_message',
      'Unsupported source kind',
    );
  function implementation(value: unknown) {
    const object = recordingObject(value, ['name', 'version', 'sha256']);
    return {
      name: sourceText(object.name),
      version: object.version === null ? null : sourceText(object.version),
      sha256: object.sha256 === null ? null : recordingDigest(object.sha256),
    };
  }
  if (!Array.isArray(header.dependencies) || header.dependencies.length > 32)
    throw new RecordingProtocolError(
      'invalid_message',
      'Too many source dependencies',
    );
  const dependencies = header.dependencies.map(implementation);
  if (
    dependencies.some(
      (entry, index) => index > 0 && dependencies[index - 1].name >= entry.name,
    )
  )
    throw new RecordingProtocolError(
      'invalid_message',
      'Source dependencies must be unique and sorted',
    );
  return {
    source_kind: header.source_kind,
    implementation: implementation(header.implementation),
    python_version:
      header.python_version === null ? null : sourceText(header.python_version),
    dependencies,
    capture_policy: parseCapturePolicy(header.capture_policy),
  };
}
export function canonicalSourceHeader(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(parseSourceHeader(value)));
}
export const RECORDING_IDENTITY_FIELDS = [
  'recording_id',
  'session_id',
  'lease_id',
  'epoch',
  'snapshot_hash',
  'manifest_sha256',
  'scene_hash',
  'mapping_revision',
  'mapping_sha256',
] as const;
function identity(object: Record<string, unknown>): RecordingIdentity {
  recordingU64(object.epoch);
  return {
    recording_id: recordingUUID(object.recording_id),
    session_id: recordingUUID(object.session_id),
    lease_id: recordingUUID(object.lease_id),
    epoch: object.epoch as string,
    snapshot_hash: recordingDigest(object.snapshot_hash),
    manifest_sha256: recordingDigest(object.manifest_sha256),
    scene_hash: recordingDigest(object.scene_hash),
    mapping_revision: recordingInteger(object.mapping_revision),
    mapping_sha256: recordingDigest(object.mapping_sha256),
  };
}
function ticket(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,512}$/.test(value))
    throw new RecordingProtocolError(
      'invalid_message',
      'Invalid scoped capability',
    );
  return value;
}
export function parseRecordingBootstrap(value: unknown): RecordingBootstrap {
  const object = recordingObject(value, [
    ...RECORDING_IDENTITY_FIELDS,
    'websocket_path',
    'ticket',
    'expires_in_seconds',
    'capture_policy',
    'limits',
  ]);
  const scope = identity(object);
  if (
    object.websocket_path !==
      `/api/v1/lab/recordings/${scope.recording_id}/source` ||
    object.expires_in_seconds !== 30
  )
    throw new RecordingProtocolError(
      'scope_mismatch',
      'Invalid Recording source endpoint',
    );
  return {
    ...scope,
    websocket_path: object.websocket_path,
    ticket: ticket(object.ticket),
    expires_in_seconds: 30,
    capture_policy: parseCapturePolicy(object.capture_policy),
    limits: parseRecordingLimits(object.limits),
  };
}
function typed(object: Record<string, unknown>, type: string) {
  if (object.type !== type || object.version !== 1)
    throw new RecordingProtocolError(
      'invalid_message',
      'Unsupported Recording message',
    );
}
export function parseRecordingHello(text: string): RecordingHello {
  const object = recordingObject(
    recordingJSON(text, RECORDING_WIRE_LIMITS.hello_bytes),
    [
      'type',
      'version',
      'codec',
      ...RECORDING_IDENTITY_FIELDS,
      'ticket',
      'source_header',
    ],
  );
  typed(object, 'recording.hello');
  if (object.codec !== RECORDING_CODEC)
    throw new RecordingProtocolError(
      'invalid_message',
      'Unsupported Recording codec',
    );
  return {
    type: 'recording.hello',
    version: 1,
    codec: RECORDING_CODEC,
    ...identity(object),
    ticket: ticket(object.ticket),
    source_header: parseSourceHeader(object.source_header),
  };
}
export function parseRecordingReady(text: string): RecordingReady {
  const object = recordingObject(
    recordingJSON(text, RECORDING_WIRE_LIMITS.hello_bytes),
    [
      'type',
      'version',
      'codec',
      ...RECORDING_IDENTITY_FIELDS,
      'source_header_sha256',
      'source_prefix_sha256',
      'capture_policy',
      'limits',
    ],
  );
  typed(object, 'recording.ready');
  if (object.codec !== RECORDING_CODEC)
    throw new RecordingProtocolError(
      'invalid_message',
      'Unsupported Recording codec',
    );
  return {
    type: 'recording.ready',
    version: 1,
    codec: RECORDING_CODEC,
    ...identity(object),
    source_header_sha256: recordingDigest(object.source_header_sha256),
    source_prefix_sha256: recordingDigest(object.source_prefix_sha256),
    capture_policy: parseCapturePolicy(object.capture_policy),
    limits: parseRecordingLimits(object.limits),
  };
}
export function parseRecordingAck(text: string): RecordingAck {
  const object = recordingObject(
    recordingJSON(text, RECORDING_WIRE_LIMITS.ack_bytes),
    [
      'type',
      'version',
      'recording_id',
      'session_id',
      'lease_id',
      'epoch',
      'source_packet_sequence',
      'packet_sha256',
      'source_prefix_sha256',
      'durable_source_sequence',
      'durable_source_event_sequence',
      'source_ended',
    ],
  );
  typed(object, 'recording.ack');
  for (const key of [
    'epoch',
    'source_packet_sequence',
    'durable_source_sequence',
    'durable_source_event_sequence',
  ])
    recordingU64(object[key]);
  if (typeof object.source_ended !== 'boolean')
    throw new RecordingProtocolError('invalid_ack', 'Invalid terminal receipt');
  return {
    type: 'recording.ack',
    version: 1,
    recording_id: recordingUUID(object.recording_id),
    session_id: recordingUUID(object.session_id),
    lease_id: recordingUUID(object.lease_id),
    epoch: object.epoch as string,
    source_packet_sequence: object.source_packet_sequence as string,
    packet_sha256: recordingDigest(object.packet_sha256),
    source_prefix_sha256: recordingDigest(object.source_prefix_sha256),
    durable_source_sequence: object.durable_source_sequence as string,
    durable_source_event_sequence:
      object.durable_source_event_sequence as string,
    source_ended: object.source_ended,
  };
}
export function parseSourceEvent(text: string): RecordingSourceEvent {
  const object = recordingObject(
    recordingJSON(text, RECORDING_WIRE_LIMITS.event_bytes),
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
  if (recordingU64(object.source_event_sequence) === 0n)
    throw new RecordingProtocolError(
      'sequence_gap',
      'Source event sequence starts at one',
    );
  recordingU64(object.sim_time_ns);
  if (object.event_type !== 'lifecycle.applied')
    throw new RecordingProtocolError(
      'invalid_packet',
      'Source event authority is lifecycle-only',
    );
  const subject = recordingObject(object.subject, ['session_id']);
  const event = recordingObject(object.event, [
    'transition_id',
    'revision',
    'action',
    'boundary_source_sequence',
  ]);
  recordingU64(event.boundary_source_sequence);
  if (!['pause', 'resume', 'stop'].includes(event.action as string))
    throw new RecordingProtocolError(
      'invalid_packet',
      'Invalid source lifecycle action',
    );
  if (
    object.observed_at !== null &&
    (typeof object.observed_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(
        object.observed_at,
      ) ||
      !Number.isFinite(Date.parse(object.observed_at)) ||
      new Date(object.observed_at).toISOString().slice(0, 19) !==
        object.observed_at.slice(0, 19))
  )
    throw new RecordingProtocolError(
      'invalid_packet',
      'Invalid source UTC observation time',
    );
  return {
    source_event_sequence: object.source_event_sequence as string,
    event_id: recordingUUID(object.event_id),
    event_type: 'lifecycle.applied',
    subject: { session_id: recordingUUID(subject.session_id) },
    sim_time_ns: object.sim_time_ns as string,
    observed_at: object.observed_at as string | null,
    event: {
      transition_id: recordingUUID(event.transition_id),
      revision: recordingInteger(event.revision, Number.MAX_SAFE_INTEGER),
      action: event.action as 'pause' | 'resume' | 'stop',
      boundary_source_sequence: event.boundary_source_sequence as string,
    },
  };
}
export function parseSourceEnd(text: string): RecordingSourceEnd {
  const object = recordingObject(
    recordingJSON(text, RECORDING_WIRE_LIMITS.end_bytes),
    [
      'transition_id',
      'revision',
      'reason',
      'last_source_sequence',
      'last_source_event_sequence',
      'sim_time_ns',
    ],
  );
  for (const key of [
    'last_source_sequence',
    'last_source_event_sequence',
    'sim_time_ns',
  ])
    recordingU64(object[key]);
  if (object.reason !== 'stop')
    throw new RecordingProtocolError(
      'invalid_packet',
      'Source end reason must be stop',
    );
  return {
    transition_id: recordingUUID(object.transition_id),
    revision: recordingInteger(object.revision, Number.MAX_SAFE_INTEGER),
    reason: 'stop',
    last_source_sequence: object.last_source_sequence as string,
    last_source_event_sequence: object.last_source_event_sequence as string,
    sim_time_ns: object.sim_time_ns as string,
  };
}
