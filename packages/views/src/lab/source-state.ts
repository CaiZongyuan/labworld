import type { DeviceProgramRun, LabEntity } from '@labos-threejs/sdk';

export type SourceAttempt = {
  key: string;
  operation: 'start' | 'stop' | 'restart';
  phase: 'submitting' | 'succeeded' | 'failed' | 'uncertain';
  originRunId?: string;
  stopSucceeded?: boolean;
  confirmedRun?: DeviceProgramRun;
  error?: unknown;
};

/** A confirmed mutation can precede its World snapshot. Runs are identities, not timestamps. */
export function entityWithConfirmedRun(
  entity: LabEntity,
  attempt?: SourceAttempt,
) {
  const confirmed = attempt?.confirmedRun;
  const current = entity.program_run;
  if (!confirmed || confirmed.binding_id !== entity.binding?.id) return entity;
  const replacesOrigin =
    current?.id === attempt.originRunId && current?.id !== confirmed.id;
  const endedCurrent =
    current?.id === confirmed.id &&
    current.status === 'running' &&
    confirmed.status !== 'running';
  return !current || replacesOrigin || endedCurrent
    ? { ...entity, program_run: confirmed }
    : entity;
}
