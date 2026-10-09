import { errorCodeOf } from '@labos-threejs/core';
import { Progress } from '@labos-threejs/ui/components/progress';
import { RequestErrorAlert } from './request-error';
import { useAppMessage } from '../shell/messages';

// Transfer feedback shared by the attachment panel and the design-system
// scene: the failure alert maps server codes to catalog text, and the
// progress block renders the hashing/uploading/completing statuses.

const FAILURE_KEYS: Record<string, string> = {
  'files.too_large': 'attachments.tooLarge',
  'files.upload_expired': 'attachments.uploadExpired',
  'files.upload_rejected': 'attachments.uploadRejected',
  'files.invalid_input': 'attachments.invalidInput',
  'knowledge.forbidden': 'attachments.forbidden',
  'knowledge.not_found': 'errors.docAccessLost',
  'auth.unauthorized': 'errors.unauthorized',
};

export function AttachmentFailure({ error }: { error: unknown }) {
  const message = useAppMessage('knowledge');
  return (
    <RequestErrorAlert
      title={message('attachments.errorTitle')}
      text={message(
        FAILURE_KEYS[errorCodeOf(error) ?? ''] ?? 'attachments.fallback',
      )}
      error={error}
    />
  );
}

export type UploadPhase = 'hashing' | 'uploading' | 'completing';

export function UploadProgress({
  phase,
  progress,
}: {
  phase: UploadPhase;
  progress: number;
}) {
  const message = useAppMessage('knowledge');
  return (
    <>
      <Progress aria-label={message('attachments.progress')} value={progress} />
      <p role="status">
        {phase === 'hashing'
          ? message('attachments.preparing')
          : phase === 'completing'
            ? message('attachments.verifying')
            : message('attachments.uploading', { percent: progress })}
      </p>
    </>
  );
}
