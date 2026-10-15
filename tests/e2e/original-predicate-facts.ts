import type { Locator } from '@playwright/test';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

type Case =
  'layout' | 'geometries' | 'history' | 'observation' | 'motion' | 'recording';
const rows: Partial<Record<Case, number>> = {};

/** Owned, best-effort evidence; a failed write never changes the original verdict. */
export function predicateFact(name: Case, fact: object) {
  const directory = process.env.LAB_NODE_EVIDENCE;
  if (!directory || (rows[name] ?? 0) >= 256) return;
  rows[name] = (rows[name] ?? 0) + 1;
  try {
    appendFileSync(
      join(directory, `original-${name}-facts.jsonl`),
      JSON.stringify({ nodeMonotonicMs: performance.now(), ...fact }) + '\n',
      { mode: 0o600 },
    );
  } catch {
    // Missing evidence remains unknown; do not replace a product/test failure.
  }
}

/** Closed public lifecycle fields only; never export a response body or identity. */
export function lifecycleFacts(value: unknown) {
  const body = value as { status?: unknown; reason?: unknown } | null;
  const code = (value: unknown, known: string) => {
    if (value === null) return null;
    if (typeof value !== 'string') return 'UNKNOWN';
    return known.split(/\s+/).includes(value) ? value : 'OTHER';
  };
  return {
    status: code(
      body?.status,
      'starting running pausing paused resuming stopping stopped reset interrupted preparing open complete incomplete deleting deleted',
    ),
    reason: code(
      body?.reason,
      `reset_requested reset_source_drain_incomplete source_disconnected recorder_capacity recording_capacity
       invalid_packet altered_duplicate recording_ack_timeout recording_drain_timeout recording_seal_failed recording_seal_timeout
       recording_event_prepare_failed recording_event_commit_failed recording_event_prepare_timeout recording_event_commit_timeout
       recording_session_event_commit_failed recording_prepare_failed recording_abort_failed recording_event_bytes_missing
       server_shutdown publisher_disconnected source_ack_timeout source_progress_timeout machine_revoked machine_expired source_unavailable`,
    ),
  };
}

/** One DOM read replaces the original innerText read, with the same return value. */
export async function geometryFact(
  locator: Locator,
  stage: string,
  loop: number | null = null,
) {
  const sample = await locator.evaluate((element) => {
    const panel = element.closest<HTMLElement>('.lab-perf');
    const numeric = (value: string | undefined) =>
      value !== undefined &&
      value.trim() !== '' &&
      Number.isFinite(Number(value)) &&
      Math.abs(Number(value)) <= 1e12
        ? Number(value)
        : null;
    return {
      text: (element as HTMLElement).innerText,
      browserMonotonicMs: performance.now(),
      sampledAt: numeric(panel?.dataset.sampledAt),
      completedRenderFrame: numeric(panel?.dataset.completedRenderFrame),
      geometries: numeric(panel?.dataset.geometries),
      textures: numeric(panel?.dataset.textures),
    };
  });
  const { text, ...fields } = sample;
  predicateFact('geometries', {
    stage,
    loop,
    ...fields,
    originalCount: Number.isFinite(Number(text)) ? Number(text) : null,
  });
  return text;
}

export function historyWorldProjection(value: unknown, entityId: string) {
  const body = value as {
    entities?: {
      id?: string;
      archived_at?: unknown;
      binding?: { id?: string };
      program_run?: { id?: string; binding_id?: string; status?: string };
      task?: { status?: string };
      capabilities?: { id?: string; executable?: boolean; reason?: string }[];
    }[];
  } | null;
  const entity = Array.isArray(body?.entities)
    ? body.entities.find((item) => item?.id === entityId)
    : undefined;
  const capability = Array.isArray(entity?.capabilities)
    ? entity.capabilities.find((item) => item?.id === 'centrifuge.start')
    : undefined;
  const run = entity?.program_run;
  const status = ['running', 'stopped', 'failed', 'interrupted'].includes(
    run?.status ?? '',
  )
    ? run!.status
    : run
      ? 'unknown'
      : null;
  const reason = [
    'program_not_running',
    'binding_not_implemented',
    'runtime_unavailable',
  ].includes(capability?.reason ?? '')
    ? capability!.reason
    : capability?.reason
      ? 'unknown'
      : null;
  return {
    // Identity references are used only for comparisons, never exported to receipts.
    identity: { run: run?.id, binding: entity?.binding?.id },
    facts: {
      targetPresent: !!entity,
      programStatus: status,
      bindingMatches:
        run?.binding_id && entity?.binding?.id
          ? run.binding_id === entity.binding.id
          : null,
      executable:
        typeof capability?.executable === 'boolean'
          ? capability.executable
          : null,
      capabilityReason: reason,
      archived: entity ? !!entity.archived_at : null,
      activeTask: entity?.task
        ? ['pending', 'preparing', 'running', 'decelerating'].includes(
            entity.task.status ?? '',
          )
        : false,
    },
  };
}
