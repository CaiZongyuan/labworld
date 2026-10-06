export type DeviceCommand = {
  id: string;
  entity_id: string;
  run_id: string;
  actor_id: string;
  actor_source: string;
  request_key: string;
  capability: string;
  parameters: unknown;
  status: string;
  result: unknown | null;
  task_id: string | null;
  created_at: string;
  updated_at: string;
};
export type ObservationReport = {
  sequence: number;
  values: Record<string, unknown>;
  observed_at: string | null;
  quality: string;
};
export type ObservationProperty = {
  value: unknown;
  unit: string | null;
  binding_id: string;
  run_id: string;
  sequence: number;
  source: string;
  observed_at: string | null;
  received_at: string;
  updated_at: string;
  expires_at: string;
  quality: string;
  freshness: string;
};
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function validLightConfiguration(
  configuration: Record<string, unknown>,
) {
  return (
    (configuration.on === undefined || typeof configuration.on === 'boolean') &&
    (configuration.brightness === undefined ||
      (typeof configuration.brightness === 'number' &&
        Number.isFinite(configuration.brightness) &&
        configuration.brightness >= 0 &&
        configuration.brightness <= 100))
  );
}
export function validLightParameters(capability: string, parameters: unknown) {
  return (
    object(parameters) &&
    Object.keys(parameters).length === 1 &&
    (capability === 'light.set_power'
      ? typeof parameters.on === 'boolean'
      : capability === 'light.set_brightness' &&
        typeof parameters.brightness === 'number' &&
        Number.isFinite(parameters.brightness) &&
        parameters.brightness >= 0 &&
        parameters.brightness <= 100)
  );
}
export function activeTask(task: Record<string, unknown> | null) {
  return (
    !!task &&
    ['pending', 'preparing', 'running', 'decelerating'].includes(
      String(task.status),
    )
  );
}
