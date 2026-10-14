import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants } from 'node:os';

/** Owned exit-boundary facts only; no new waits, process control or error replacement. */
export function browserExitFacts(directory) {
  const started = performance.now(),
    backendExits = [],
    controls = [];
  let failure = null,
    backendTruncated = false,
    controlsTruncated = false,
    controlPhase = 'unknown';
  const controlPhases = [
    'read-control',
    'parse-control',
    'validate-revision',
    'clock-send',
    'clock-ack',
    'reply-write',
    'rename',
  ];
  const errorNames = [
    'Error',
    'TypeError',
    'SyntaxError',
    'RangeError',
    'AggregateError',
    'TimeoutError',
    'SystemError',
  ];
  const errorCodes = [
    'ENOENT',
    'EACCES',
    'EPERM',
    'EISDIR',
    'ENOTDIR',
    'EBUSY',
    'EMFILE',
    'ENFILE',
    'EIO',
    'EINVAL',
    'ERR_IPC_CHANNEL_CLOSED',
    'ERR_IPC_DISCONNECTED',
    'ERR_INVALID_ARG_TYPE',
    'ERR_INVALID_STATE',
  ];
  const now = () => performance.now() - started;
  const code = (value) =>
    Number.isInteger(value) && value >= 0 && value <= 255 ? value : null;
  const signal = (value) =>
    value == null
      ? null
      : Object.hasOwn(constants.signals, value)
        ? value
        : 'unknown';
  const actions = [
    'inspect-store',
    'close-store',
    'restart-service',
    'expire-machine-clock',
    'reset-machine-clock',
  ];
  return {
    controlPhase(phase) {
      controlPhase = controlPhases.includes(phase) ? phase : 'unknown';
    },
    backendExit(exitCode, exitSignal, state) {
      if (backendExits.length >= 16) {
        backendTruncated = true;
        return;
      }
      backendExits.push({
        monotonicMs: now(),
        code: code(exitCode),
        signal: signal(exitSignal),
        closed: state.closed,
        failed: state.failed,
      });
    },
    control(action, stage) {
      if (controls.length >= 32) {
        controlsTruncated = true;
        return;
      }
      controls.push({
        monotonicMs: now(),
        action: actions.includes(action) ? action : 'unknown',
        stage: ['begun', 'completed'].includes(stage) ? stage : 'unknown',
      });
    },
    failure(kind, error) {
      if (failure) return;
      failure = {
        monotonicMs: now(),
        kind: ['backend-exit', 'backend-restart', 'controlled-action'].includes(
          kind,
        )
          ? kind
          : 'unknown',
      };
      if (kind === 'controlled-action') {
        failure.phase = controlPhase;
        failure.errorName = 'OtherError';
        failure.errorCode = null;
        try {
          const name = error?.name,
            code = error?.code;
          failure.errorName = errorNames.includes(name) ? name : 'OtherError';
          failure.errorCode = errorCodes.includes(code) ? code : null;
        } catch {
          // Arbitrary error properties cannot change supervisor failure behavior.
        }
      }
    },
    browserExit(exitCode, exitSignal, state) {
      try {
        const owned = directory();
        if (!owned) return;
        writeFileSync(
          join(owned, 'browser-exit-facts.json'),
          JSON.stringify({
            scope:
              'Original browser exit boundary; backend/control events already observed, no future shutdown wait',
            monotonicMs: now(),
            browser: { code: code(exitCode), signal: signal(exitSignal) },
            failed: state.failed,
            closed: state.closed,
            failure,
            backendExits,
            backendTruncated,
            controls,
            controlsTruncated,
            summaryInference:
              'UNKNOWN; missing summary does not establish zero collection',
          }) + '\n',
          { mode: 0o600 },
        );
      } catch {
        /* Evidence write failure never changes the original verdict. */
      }
    },
  };
}
