import { errorCodeOf } from '@labos-threejs/core';
import { useAppMessage } from '../shell/messages';
import { RequestErrorAlert } from './request-error';

export const exportPending = new Set(['queued', 'running', 'retry_wait']);
// Export status → message catalog key; consumers resolve via useAppMessage.
export const exportLabelKeys: Record<string, string> = {
  queued: 'feedback.queued',
  running: 'feedback.running',
  retry_wait: 'feedback.retryWait',
  succeeded: 'feedback.succeeded',
  failed: 'feedback.failed',
  expired: 'feedback.expired',
};
const FAILURE_KEYS: Record<string, string> = {
  'knowledge.export_too_large': 'feedback.tooLarge',
  'knowledge.export_expired': 'feedback.expiredError',
  'knowledge.export_not_ready': 'feedback.notReady',
  'knowledge.not_found': 'errors.docAccessLost',
  'knowledge.forbidden': 'feedback.forbidden',
  'auth.unauthorized': 'errors.unauthorized',
};
export function ExportFailure({ error }: { error: unknown }) {
  const message = useAppMessage('knowledge');
  return (
    <RequestErrorAlert
      title={message('feedback.errorTitle')}
      text={message(
        FAILURE_KEYS[errorCodeOf(error) ?? ''] ?? 'feedback.fallback',
      )}
      error={error}
    />
  );
}
