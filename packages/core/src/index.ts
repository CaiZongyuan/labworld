/** Extract the server's public correlation identifier without exposing arbitrary error text. */
export function requestIdFromError(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('error' in value))
    return;
  const body = value.error;
  if (typeof body !== 'object' || body === null || !('request_id' in body))
    return;
  return typeof body.request_id === 'string' ? body.request_id : undefined;
}

/** The API's stable error code (the translation key input), or nothing for non-API values. */
export function errorCodeOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('error' in value))
    return;
  const body = value.error;
  if (typeof body !== 'object' || body === null || !('code' in body)) return;
  return typeof body.code === 'string' ? body.code : undefined;
}

/** Only the public limiter code can supply a bounded wait hint; never show arbitrary errors. */
export function retryAfterSeconds(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || !('error' in value)) return;
  const error = value.error;
  if (
    !error ||
    typeof error !== 'object' ||
    !('code' in error) ||
    error.code !== 'rate_limit.exceeded' ||
    !('details' in error)
  )
    return;
  const details = error.details;
  if (
    !details ||
    typeof details !== 'object' ||
    !('retry_after_seconds' in details)
  )
    return;
  const raw = details.retry_after_seconds;
  if (typeof raw !== 'string' || !/^[0-9]{1,4}$/.test(raw)) return;
  const seconds = Number(raw);
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= 3600
    ? seconds
    : undefined;
}
