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
export function validProgramConfiguration(
  program: string,
  configuration: Record<string, unknown>,
) {
  if (program === 'light.v1') return validLightConfiguration(configuration);
  if (program === 'sensor.v1')
    return (
      configuration.baseline_temperature === undefined ||
      (typeof configuration.baseline_temperature === 'number' &&
        Number.isFinite(configuration.baseline_temperature) &&
        configuration.baseline_temperature >= -50 &&
        configuration.baseline_temperature <= 100)
    );
  if (program === 'centrifuge.v1')
    return (
      configuration.initial_temperature === undefined ||
      (typeof configuration.initial_temperature === 'number' &&
        Number.isFinite(configuration.initial_temperature) &&
        configuration.initial_temperature >= -10 &&
        configuration.initial_temperature <= 40)
    );
  return false;
}
export function validObservation(
  program: string,
  values: Record<string, unknown>,
) {
  return Object.entries(values).every(([name, value]) => {
    if (program === 'light.v1')
      return (
        (name === 'on' && typeof value === 'boolean') ||
        (name === 'brightness' && numeric(value, 0, 100))
      );
    if (program === 'sensor.v1')
      return (
        name === 'temperature' &&
        typeof value === 'number' &&
        Number.isFinite(value)
      );
    if (program === 'centrifuge.v1')
      return (
        (name === 'speed' && numeric(value, 0, 15000)) ||
        (name === 'temperature' && numeric(value, -10, 40)) ||
        (name === 'elapsed_seconds' && numeric(value, 0, Number.MAX_VALUE)) ||
        (name === 'phase' &&
          typeof value === 'string' &&
          ['idle', 'preparing', 'running', 'decelerating'].includes(value))
      );
    return false;
  });
}
function numeric(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}
export function validParameters(capability: string, parameters: unknown) {
  if (capability.startsWith('light.'))
    return validLightParameters(capability, parameters);
  if (!object(parameters)) return false;
  if (capability === 'centrifuge.stop')
    return Object.keys(parameters).length === 0;
  return (
    capability === 'centrifuge.start' &&
    Object.keys(parameters).length === 3 &&
    numeric(parameters.rpm, 500, 15000) &&
    Number.isSafeInteger(parameters.rpm) &&
    numeric(parameters.temperature, -10, 40) &&
    numeric(parameters.duration_seconds, 6, 3600) &&
    Number.isSafeInteger(parameters.duration_seconds)
  );
}
export type CentrifugeTask = {
  id: string;
  result_id: string;
  parameters: { rpm: number; temperature: number; duration_seconds: number };
  status: string;
  elapsed_seconds: number;
  last_tick_at: string | null;
  pending_outcome: string | null;
};
function approach(value: number, target: number, step: number) {
  return value < target
    ? Math.min(value + step, target)
    : Math.max(value - step, target);
}
export function advanceCentrifuge(
  task: CentrifugeTask,
  previous: Record<string, unknown>,
  now: string,
) {
  const seconds = task.last_tick_at
    ? Math.max(0, (Date.parse(now) - Date.parse(task.last_tick_at)) / 1000)
    : 0;
  let speed = Number(previous.speed ?? 0),
    temperature = Number(previous.temperature ?? 22),
    phase = task.status,
    elapsed = task.elapsed_seconds,
    outcome = task.pending_outcome;
  temperature = approach(temperature, task.parameters.temperature, 2 * seconds);
  const within = () =>
    Math.abs(speed - task.parameters.rpm) <= 50 &&
    Math.abs(temperature - task.parameters.temperature) <= 0.5;
  let timerStarted = false;
  if (phase === 'preparing') {
    speed = approach(speed, task.parameters.rpm, 3000 * seconds);
    if (within()) {
      phase = 'running';
      timerStarted = true;
    }
  } else if (phase === 'running') {
    if (within())
      elapsed = Math.min(elapsed + seconds, task.parameters.duration_seconds);
    speed = approach(speed, task.parameters.rpm, 3000 * seconds);
    if (elapsed >= task.parameters.duration_seconds) {
      phase = 'decelerating';
      outcome = 'completed';
    }
  } else if (phase === 'decelerating')
    speed = approach(speed, 0, 3000 * seconds);
  const terminal = phase === 'decelerating' && speed === 0,
    status = terminal ? (outcome ?? 'unknown') : phase;
  return {
    values: {
      speed,
      temperature,
      phase: terminal ? 'idle' : phase,
      elapsed_seconds: elapsed,
    },
    elapsed,
    outcome,
    status,
    terminal,
    timerStarted,
  };
}
