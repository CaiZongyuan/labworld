import { useState } from 'react';
import { Button } from '@labos-threejs/ui/components/button';
import { MaterialFileIcon } from '@labos-threejs/ui/components/material-file-icon';
import { AttachmentFailure, UploadProgress } from './attachment-feedback';
import { choiceRowClass } from '../shell/rows';
import { useAppMessage } from '../shell/messages';

// The design-system scene for UI08: the attachment list's file icons and
// the upload lifecycle feedback run on demo data and local state — the
// progress block and the failure alert are the production components, no
// real file is created (docs/ui/design.md §6 Q9).

type Scenario = 'uploading' | 'done' | 'failed';

const SCENARIOS: { id: Scenario; labelKey: string }[] = [
  { id: 'uploading', labelKey: 'scene.attachments.stateUploading' },
  { id: 'done', labelKey: 'scene.attachments.stateDone' },
  { id: 'failed', labelKey: 'scene.attachments.stateFailed' },
];

// An expired upload session: the production copy for a mapped failure and
// its reportable request id, without touching real storage.
const DEMO_FAILURE = {
  error: {
    code: 'files.upload_expired',
    request_id: 'scene-demo-request',
  },
};

export function AttachmentScene() {
  const message = useAppMessage('knowledge');
  const [scenario, setScenario] = useState<Scenario>('uploading');

  return (
    <div className="flex flex-col gap-3">
      <div aria-label={message('scene.attachments.galleryTitle')}>
        <p className="text-sm font-medium">
          {message('scene.attachments.galleryTitle')}
        </p>
        <ul className="mt-1 flex flex-col gap-1 text-sm text-muted-foreground">
          <li className="flex items-center gap-2">
            <MaterialFileIcon name="scan.png" className="size-5 shrink-0" />
            {message('scene.attachments.iconImage')} · image
          </li>
          <li className="flex items-center gap-2">
            <MaterialFileIcon name="report.pdf" className="size-5 shrink-0" />
            {message('scene.attachments.iconDocument')} · description
          </li>
        </ul>
      </div>

      <fieldset aria-label={message('scene.attachments.title')}>
        {SCENARIOS.map(({ id, labelKey }) => (
          <label key={id} className={choiceRowClass}>
            <input
              type="radio"
              name="knowledge-attachment-scene"
              value={id}
              checked={scenario === id}
              onChange={() => setScenario(id)}
              className="accent-[var(--primary)]"
            />
            {message(labelKey)}
          </label>
        ))}
      </fieldset>

      {scenario === 'uploading' ? (
        <>
          <UploadProgress phase="uploading" progress={60} />
          <p className="text-sm">
            <MaterialFileIcon
              name={message('scene.attachments.demoImageName')}
              className="mr-2 inline size-5 align-text-bottom"
            />
            {message('scene.attachments.demoImageName')} ·{' '}
            {message('scene.attachments.demoImageMeta')}
          </p>
        </>
      ) : null}

      {scenario === 'done' ? (
        <>
          <p role="status">{message('attachments.uploaded')}</p>
          <p className="text-sm">
            <MaterialFileIcon
              name={message('scene.attachments.demoDocName')}
              className="mr-2 inline size-5 align-text-bottom"
            />
            {message('scene.attachments.demoDocName')} ·{' '}
            {message('scene.attachments.demoDocMeta')}
          </p>
        </>
      ) : null}

      {scenario === 'failed' ? (
        <>
          <AttachmentFailure error={DEMO_FAILURE} />
          <div>
            <Button variant="outline" onClick={() => setScenario('uploading')}>
              {message('attachments.retryUpload')}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
