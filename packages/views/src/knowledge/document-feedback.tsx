import { errorCodeOf } from '@labos-threejs/core';
import type { Document } from '@labos-threejs/sdk';
import { Button } from '@labos-threejs/ui/components/button';
import { RequestErrorAlert } from './request-error';
import { MarkdownPreview } from './markdown-preview';
import type { AttachmentContextValue } from './attachment-markdown';
import { useAppMessage } from '../shell/messages';

// The knowledge example's shared save feedback: the error-code → copy
// mapping, the failure alert built on it, and the version-conflict
// reconcile section. Both the document editor and the design-system's
// save-conflict scene render these exact components, so the showroom
// demos the production behavior (docs/ui/design.md §6 Q9).

// Server error codes carry no display text (the API's message field is a
// debug string), so the example maps each code to its own catalog key.
const ERROR_KEYS: Record<string, string> = {
  'knowledge.forbidden': 'errors.writeForbidden',
  'knowledge.not_found': 'errors.docNotFound',
  'knowledge.invalid_search': 'errors.invalidSearch',
  'knowledge.invalid_page': 'errors.invalidPage',
  'knowledge.invalid_title': 'errors.invalidTitle',
  'knowledge.too_large': 'errors.tooLarge',
  'knowledge.invalid_text': 'errors.invalidText',
  'document.version_conflict': 'errors.versionConflict',
  'idempotency.conflict': 'errors.idempotencyConflict',
  'auth.unauthorized': 'errors.unauthorized',
  'auth.csrf': 'errors.csrf',
};

// `error` carries a real request failure (scene demo fixtures included);
// `code` carries a local, pre-submit error code without a request behind it.
export function Failure({ error, code }: { error?: unknown; code?: string }) {
  const message = useAppMessage('knowledge');
  const resolved = errorCodeOf(error) ?? code;
  return (
    <RequestErrorAlert
      title={message('errors.actionIncomplete')}
      text={message(ERROR_KEYS[resolved ?? ''] ?? 'errors.fallback')}
      error={error}
    />
  );
}

export function ConflictSection({
  latest,
  latestPending = false,
  onReadLatest,
  onKeep,
  onTake,
  attachments,
}: {
  /** The freshly read version, once onReadLatest resolved. */
  latest: Pick<Document, 'version' | 'title' | 'markdown'> | undefined;
  latestPending?: boolean;
  onReadLatest: () => void;
  onKeep: () => void;
  onTake: () => void;
  attachments?: AttachmentContextValue;
}) {
  const message = useAppMessage('knowledge');
  return (
    <section
      aria-label={message('documents.conflictSection')}
      className="flex flex-col gap-3"
    >
      <Button variant="outline" disabled={latestPending} onClick={onReadLatest}>
        {latestPending
          ? message('documents.readingLatest')
          : message('documents.readLatest')}
      </Button>
      {latest ? (
        <>
          <h2 className="text-lg font-semibold">
            {message('documents.latestVersion', {
              version: latest.version,
              title: latest.title,
            })}
          </h2>
          <MarkdownPreview
            markdown={latest.markdown}
            attachments={attachments}
          />
          <p>{message('documents.conflictHint')}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={onKeep}>
              {message('documents.keepDraft')}
            </Button>
            <Button variant="outline" onClick={onTake}>
              {message('documents.takeLatest')}
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
}
