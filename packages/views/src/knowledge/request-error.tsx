import { requestIdFromError } from '@labos-threejs/core';
import { Alert, AlertDescription, AlertTitle } from '@labos-threejs/ui/components/alert';
import { RateLimitHint } from '../system/rate-limit';
import { useAppMessage } from '../shell/messages';

// The knowledge example's one failure alert: the caller resolves the
// localized title and the mapped message for its error domain; the
// component appends the rate-limit hint and the server request id so
// every rejection stays reportable (docs/ui/design.md §6 Q1).
export function RequestErrorAlert({
  title,
  text,
  error,
}: {
  title: string;
  text: string;
  error: unknown;
}) {
  const message = useAppMessage('knowledge');
  const id = requestIdFromError(error);
  return (
    <Alert variant="destructive">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        {text}
        <RateLimitHint error={error} />
        {id ? <p>{message('errors.requestId', { id })}</p> : null}
      </AlertDescription>
    </Alert>
  );
}
