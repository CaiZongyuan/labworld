import type { LabEntity, LabWorld } from '@labos-threejs/sdk';
import { readEntityObservations } from './observation-state';

const activeTaskStatuses = new Set([
  'pending',
  'preparing',
  'running',
  'decelerating',
]);
const deviceKinds = new Set(['instrument', 'iot', 'sensor', 'robot']);
export type AttentionFact = {
  reason: string;
  time?: string | null;
  property?: string;
};

/** Overview facts use persisted Entity identities and individual property provenance. */
function operationFacts(entity: LabEntity) {
  const readings = readEntityObservations(entity);
  const attention: AttentionFact[] = [];
  const run = entity.program_run;
  if (run?.status === 'interrupted')
    attention.push({
      reason: 'run_interrupted',
      time: run.ended_at ?? run.started_at,
    });
  const task = entity.task;
  if (task && ['failed', 'interrupted', 'unknown'].includes(task.status))
    attention.push({
      reason: `task_${task.status}`,
      time: task.ended_at ?? task.created_at,
    });
  if (run?.status === 'running' && entity.binding?.id === run.binding_id) {
    for (const name of readings.keyProperties) {
      const reading = readings.properties[name];
      const property = reading.property;
      if (
        !property ||
        property.binding_id !== entity.binding.id ||
        property.run_id !== run.id
      )
        continue;
      if (property.freshness === 'expired')
        attention.push({
          reason: 'expired',
          property: name,
          time: property.observed_at ?? property.received_at,
        });
      if (property.quality !== 'good')
        attention.push({
          reason: `quality_${property.quality}`,
          property: name,
          time: property.observed_at ?? property.received_at,
        });
      if (
        !property.observed_at ||
        !Number.isFinite(Date.parse(property.observed_at))
      )
        attention.push({
          reason: 'source_time_unknown',
          property: name,
          time: property.received_at,
        });
    }
  }
  const priority = attention.some((fact) =>
    ['run_interrupted', 'task_interrupted', 'task_unknown'].includes(
      fact.reason,
    ),
  )
    ? 0
    : 1;
  const times = attention.flatMap((fact) =>
    fact.time && Number.isFinite(Date.parse(fact.time))
      ? [Date.parse(fact.time)]
      : [],
  );
  return {
    entity,
    readings,
    attention,
    priority,
    earliest: times.length ? Math.min(...times) : Infinity,
    taskActive: !!task && activeTaskStatuses.has(task.status),
    status: !entity.binding ? 'unbound' : (run?.status ?? 'not_started'),
  };
}
export type DeviceFacts = ReturnType<typeof operationFacts>;

export function operatingDevices(entities: LabEntity[]) {
  return [
    ...new Map(
      entities
        .filter((entity) => !entity.archived_at && deviceKinds.has(entity.kind))
        .map((entity) => [entity.id, entity]),
    ).values(),
  ].map(operationFacts);
}

/** Follow manual containment outward breadth first; the first Location is the registered region. */
export function registeredRegions(world: LabWorld) {
  const parents = new Map<string, string[]>();
  for (const relation of world.relationships) {
    if (
      relation.source !== 'manual' ||
      !['located_in', 'contains'].includes(relation.kind)
    )
      continue;
    const child =
      relation.kind === 'located_in' ? relation.source_id : relation.target_id;
    const parent =
      relation.kind === 'located_in' ? relation.target_id : relation.source_id;
    parents.set(child, [...(parents.get(child) ?? []), parent]);
  }
  const entities = new Map(world.entities.map((entity) => [entity.id, entity]));
  const regions = new Map<string, LabEntity>();
  for (const entity of world.entities) {
    const queue = [...(parents.get(entity.id) ?? [])];
    const visited = new Set([entity.id]);
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index];
      if (visited.has(id)) continue;
      visited.add(id);
      const parent = entities.get(id);
      if (parent?.kind === 'location') {
        regions.set(entity.id, parent);
        break;
      }
      queue.push(...(parents.get(id) ?? []));
    }
  }
  return regions;
}
