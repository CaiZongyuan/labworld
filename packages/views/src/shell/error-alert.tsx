import { errorCodeOf, requestIdFromError } from '@labos-threejs/core';
import { Alert, AlertDescription, AlertTitle } from '@labos-threejs/ui/components/alert';
import { RateLimitHint } from '../system/rate-limit';
import { useAppMessage } from './messages';

// Shared destructive alert for API failures: the module picks the title
// and maps error codes to honest sentences, while the rate-limit hint and
// the request ID correlation stay in one place. Unmapped codes fall back
// to `genericKey`; without one only the hints render.
export function ErrorAlert({
  error,
  title,
  genericKey,
  codes,
}: {
  error: unknown;
  title: string;
  genericKey?: string;
  codes?: Record<string, string>;
}) {
  const message = useAppMessage();
  const id = requestIdFromError(error);
  const mapped = codes?.[errorCodeOf(error) ?? ''];
  return (
    <Alert variant="destructive">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        {mapped ?? (genericKey ? message(genericKey) : null)}
        <RateLimitHint error={error} />
        {id ? <p>{message('common.requestId', { id })}</p> : null}
      </AlertDescription>
    </Alert>
  );
}
