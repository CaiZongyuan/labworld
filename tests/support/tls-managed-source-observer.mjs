import { constants } from 'node:os';

const codes = new Set([
  'ack_timeout',
  'recorder_capacity',
  'source_capacity',
  'source_disconnected',
  'session_closed',
  'unauthorized',
  'mapping_mismatch',
  'invalid_message',
  'invalid_packet',
  'invalid_ack',
  'invalid_sequence',
  'invalid_number',
  'invalid_length',
  'invalid_magic',
  'invalid_flags',
  'invalid_quaternion',
  'invalid_u64',
  'unsupported_version',
  'limit_exceeded',
  'epoch_mismatch',
  'sequence_gap',
  'altered_duplicate',
  'time_rollback',
  'recording_ack_timeout',
  'recording_closed',
  'recording_source_ended',
  'recording_source_rate',
  'recording_sequence_gap',
  'recording_altered_duplicate',
  'recording_time_rollback',
  'recording_initial_state_rejected',
  'recording_lifecycle_event_rejected',
  'recording_source_end_rejected',
]);
const classes = new Set([
  'RuntimeError',
  'ValueError',
  'ImportError',
  'TimeoutError',
  'OSError',
  'ConnectionClosedError',
  'ConnectionClosedOK',
  'InvalidStatus',
  'MotionProtocolError',
  'CancelledError',
  'BrokenPipeError',
]);
for (const code of [...codes]) codes.add('lab.' + code);

export function observeTlsManagedSources() {
  const records = new Map();
  let omitted = 0;
  const key = Symbol.for('labos.tls.managed-source-observer');
  globalThis[key] = (sessionId, event, child) => {
    try {
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return;
      let record = records.get(sessionId);
      if (!record) {
        if (records.size >= 16) {
          omitted++;
          return;
        }
        record = {
          sessionId,
          ownerPid: process.pid,
          nodeEpoch: performance.timeOrigin,
          childPid: null,
          spawnAt: null,
          stopInvokedAt: null,
          closeAt: null,
          exitCode: null,
          signal: null,
          publisherStopped: null,
          truncatedLines: 0,
        };
        records.set(sessionId, record);
      }
      if (event === 'stop') {
        record.stopInvokedAt ??= performance.now();
        return;
      }
      if (event !== 'spawn' || !child || record.spawnAt !== null) return;
      record.spawnAt = performance.now();
      record.childPid = Number.isSafeInteger(child.pid) ? child.pid : null;
      let buffer = '';
      const parse = (line) => {
        const match =
          /^Publisher stopped: ([A-Za-z_][A-Za-z0-9_.]{0,95})\r?$/.exec(line);
        if (!match || record.publisherStopped) return;
        const value = match[1];
        record.publisherStopped = {
          at: performance.now(),
          value: codes.has(value) || classes.has(value) ? value : 'unknown',
          kind: codes.has(value)
            ? 'code'
            : classes.has(value)
              ? 'class'
              : 'unknown',
        };
      };
      child.stderr?.on('data', (chunk) => {
        try {
          buffer += String(chunk);
          while (buffer.includes('\n')) {
            const end = buffer.indexOf('\n');
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            if (line.length <= 256) parse(line);
            else record.truncatedLines++;
          }
          if (buffer.length > 256) {
            buffer = '';
            record.truncatedLines++;
          }
        } catch {
          /* No stderr/parser failure changes the child. */
        }
      });
      child.once('close', (code, signal) => {
        parse(buffer);
        buffer = '';
        record.closeAt = performance.now();
        record.exitCode =
          Number.isInteger(code) && code >= 0 && code <= 255 ? code : null;
        record.signal =
          signal == null
            ? null
            : Object.hasOwn(constants.signals, signal)
              ? signal
              : 'unknown';
      });
    } catch {
      /* Observation cannot affect the original launcher. */
    }
  };
  return () => ({ omitted, records: [...records.values()].slice(0, 16) });
}

export function observeTlsRecordingDisconnects() {
  const records = new Map();
  let omitted = 0;
  const transportClasses = new Set([
    'Error',
    'TypeError',
    'RangeError',
    'SyntaxError',
    'AggregateError',
    'DOMException',
  ]);
  const transportCodes = new Set([
    'ECONNRESET',
    'EPIPE',
    'ETIMEDOUT',
    'ECONNABORTED',
    'ENETDOWN',
    'ENETRESET',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'EBADF',
    'EPROTO',
    'WS_ERR_TOO_MANY_BUFFERED_PARTS',
    'WS_ERR_UNEXPECTED_RSV_2_3',
    'WS_ERR_UNEXPECTED_RSV_1',
    'WS_ERR_INVALID_OPCODE',
    'WS_ERR_EXPECTED_FIN',
    'WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH',
    'WS_ERR_EXPECTED_MASK',
    'WS_ERR_UNEXPECTED_MASK',
    'WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH',
    'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH',
    'WS_ERR_INVALID_UTF8',
    'WS_ERR_INVALID_CLOSE_CODE',
  ]);
  const number = (value) => (Number.isFinite(value) ? value : null);
  const uuid = (value) =>
    typeof value === 'string' &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
      ? value
      : null;
  globalThis[Symbol.for('labos.tls.recording-disconnect-observer')] = (
    observation,
    error,
  ) => {
    try {
      const recordingId = uuid(observation.recordingId);
      if (
        !recordingId ||
        !['heartbeat-age', 'transport-error'].includes(observation.branch) ||
        records.has(recordingId)
      )
        return;
      if (records.size >= 16) {
        omitted++;
        return;
      }
      let transportError = null;
      if (observation.branch === 'transport-error') {
        transportError = { class: 'unknown', code: 'unknown' };
        try {
          if (error instanceof Error && transportClasses.has(error.name))
            transportError.class = error.name;
          if (error && transportCodes.has(error.code))
            transportError.code = error.code;
        } catch {
          // Unknown or throwing properties never retain error messages.
        }
      }
      records.set(recordingId, {
        recordingId,
        sessionId: uuid(observation.sessionId),
        ownerPid: Number.isSafeInteger(observation.ownerPid)
          ? observation.ownerPid
          : null,
        nodeEpoch: number(observation.nodeEpoch),
        branch: observation.branch,
        faultWallAt: number(observation.faultWallAt),
        faultMonotonicAt: number(observation.faultMonotonicAt),
        checkedLastPongWallAt: number(observation.checkedLastPongWallAt),
        checkedWallAgeMs: number(observation.checkedWallAgeMs),
        heartbeatGraceMs: number(observation.heartbeatGraceMs),
        wsReadyState: [0, 1, 2, 3].includes(observation.wsReadyState)
          ? observation.wsReadyState
          : null,
        admitted: observation.admitted === true,
        lastActualPongWallAt: number(observation.lastActualPongWallAt),
        lastActualPongMonotonicAt: number(
          observation.lastActualPongMonotonicAt,
        ),
        transportError,
      });
    } catch {
      // A diagnostic callback cannot alter the original fail call.
    }
  };
  return () => ({ omitted, records: [...records.values()].slice(0, 16) });
}
