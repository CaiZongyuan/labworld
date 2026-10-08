import type { LabEntity, ObservationProperty } from '@labos-threejs/sdk';

export type PropertyReading = {
  property?: ObservationProperty;
  hasValue: boolean;
  currentValid: boolean;
  reason: string;
};

/** Read only property facts. A heartbeat or another property's report changes none of them. */
export function readEntityObservations(entity: LabEntity, connected = true) {
  const schema = entity.definition.state as {
    properties?: Record<string, { type?: string; enum?: unknown[] }>;
  };
  const reported = entity.observation?.properties ?? {};
  const keyProperties = Object.keys(schema.properties ?? {}).filter(
    (name) => !['phase', 'elapsed_seconds'].includes(name),
  );
  const names = [
    ...new Set([
      ...keyProperties,
      ...Object.keys(schema.properties ?? {}),
      ...Object.keys(reported),
    ]),
  ];
  const properties: Record<string, PropertyReading> = {};
  for (const name of names) {
    const property = reported[name];
    const expected = schema.properties?.[name];
    const value = property?.value;
    const hasValue =
      value !== null &&
      value !== undefined &&
      (expected?.enum
        ? expected.enum.includes(value)
        : expected?.type === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : expected?.type
            ? typeof value === expected.type
            : typeof value === 'boolean' ||
              typeof value === 'string' ||
              (typeof value === 'number' && Number.isFinite(value)));
    const reason =
      !hasValue || !property
        ? 'unknown'
        : !connected
          ? 'offline'
          : !entity.binding
            ? 'unbound'
            : entity.program_run?.status !== 'running'
              ? (entity.program_run?.status ?? 'not_started')
              : property.binding_id !== entity.binding.id ||
                  entity.program_run.binding_id !== entity.binding.id
                ? 'previous_binding'
                : property.run_id !== entity.program_run.id
                  ? 'previous_run'
                  : property.freshness !== 'current'
                    ? property.freshness
                    : !property.observed_at ||
                        !Number.isFinite(Date.parse(property.observed_at))
                      ? 'source_time_unknown'
                      : property.quality !== 'good'
                        ? `quality_${property.quality}`
                        : 'current';
    properties[name] = {
      property,
      hasValue,
      currentValid: reason === 'current',
      reason,
    };
  }

  return {
    properties,
    keyProperties,
    currentValid:
      keyProperties.length > 0 &&
      keyProperties.every((name) => properties[name].currentValid),
  };
}
