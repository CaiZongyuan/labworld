import type { LabEntity, ObservationProperty } from '@labos-threejs/sdk';

export type PropertyReading = {
  property?: ObservationProperty;
  currentValid: boolean;
  hasValue: boolean;
  reason: string;
};

/** Reads versioned World facts; never refreshes property time from a heartbeat. */
export function readEntityObservations(entity: LabEntity, connected = true) {
  const lifecycle = entity.binding
    ? (entity.program_run?.status ?? 'not_started')
    : 'unbound';
  const keyProperties: string[] =
    entity.definition_id === 'light'
      ? ['on', 'brightness']
      : entity.definition_id === 'centrifuge'
        ? ['speed', 'temperature']
        : entity.definition_id === 'sensor'
          ? ['temperature']
          : [];
  const reported = entity.observation?.properties ?? {};
  const names = [...new Set([...keyProperties, ...Object.keys(reported)])];
  const properties = Object.fromEntries(
    names.map((name) => {
      const property = reported[name];
      if (!property)
        return [
          name,
          {
            property,
            hasValue: false,
            currentValid: false,
            reason: 'unknown',
          } satisfies PropertyReading,
        ];
      const hasValue =
        name === 'on'
          ? typeof property.value === 'boolean'
          : ['temperature', 'brightness', 'speed', 'elapsed_seconds'].includes(
                name,
              )
            ? typeof property.value === 'number' &&
              Number.isFinite(property.value)
            : typeof property.value === 'string';
      const reason = !hasValue
        ? 'unknown'
        : !connected
          ? 'offline'
          : lifecycle !== 'running'
            ? lifecycle
            : property.binding_id !== entity.binding?.id
              ? 'previous_binding'
              : property.run_id !== entity.program_run?.id
                ? 'previous_run'
                : property.freshness !== 'current'
                  ? property.freshness
                  : !property.observed_at
                    ? 'source_time_unknown'
                    : property.quality !== 'good'
                      ? `quality_${property.quality}`
                      : 'current';
      return [
        name,
        {
          property,
          hasValue,
          currentValid: reason === 'current',
          reason,
        } satisfies PropertyReading,
      ];
    }),
  );
  const currentValid =
    keyProperties.length > 0 &&
    keyProperties.every((name) => properties[name].currentValid);
  return { lifecycle, keyProperties, properties, currentValid };
}
