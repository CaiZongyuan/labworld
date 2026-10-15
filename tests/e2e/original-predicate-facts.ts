import type { Locator } from '@playwright/test';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

type Case = 'layout' | 'geometries' | 'history' | 'observation';
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
