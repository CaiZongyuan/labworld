import { useState } from 'react';
import type { Document } from '@labos-threejs/sdk';
import { Button } from '@labos-threejs/ui/components/button';
import { ConflictSection, Failure } from './document-feedback';
import { MarkdownPreview } from './markdown-preview';
import { choiceRowClass } from '../shell/rows';
import { useAppMessage } from '../shell/messages';

// The design-system scene for UI07: the editor's four save outcomes run on
// demo data and local state — the failure alert and the version-conflict
// reconcile section are the production components, nothing is written
// (docs/ui/design.md §6 Q9).

type Scenario = 'success' | 'failure' | 'conflict' | 'disabled';

const SCENARIOS: { id: Scenario; labelKey: string }[] = [
  { id: 'success', labelKey: 'scene.saveConflict.stateSuccess' },
  { id: 'failure', labelKey: 'scene.saveConflict.stateFailure' },
  { id: 'conflict', labelKey: 'scene.saveConflict.stateConflict' },
  { id: 'disabled', labelKey: 'scene.saveConflict.stateDisabled' },
];

// An error code the production mapping does not know, so the alert shows
// the fallback text; the request id stays reportable exactly as in the app.
const DEMO_FAILURE = {
  error: { code: 'knowledge.scene.unmapped', request_id: 'scene-demo-request' },
};

export function SaveConflictScene() {
  const message = useAppMessage('knowledge');
  const [scenario, setScenario] = useState<Scenario>('success');
  const [saved, setSaved] = useState(false);
  // Mirrors production reconcile(true): taking the latest replaces the draft
  // body with the latest content.
  const [draftTaken, setDraftTaken] = useState(false);
  const [latest, setLatest] = useState<
    Pick<Document, 'version' | 'title' | 'markdown'> | undefined
  >();

  const select = (next: Scenario) => {
    setScenario(next);
    setSaved(false);
    if (next === 'conflict') {
      setLatest(undefined);
      setDraftTaken(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <fieldset
        aria-label={message('scene.saveConflict.title')}
        className="flex flex-col gap-1"
      >
        {SCENARIOS.map(({ id, labelKey }) => (
          <label key={id} className={choiceRowClass}>
            <input
              type="radio"
              name="knowledge-save-conflict-scene"
              value={id}
              checked={scenario === id}
              onChange={() => select(id)}
              className="accent-[var(--primary)]"
            />
            {message(labelKey)}
          </label>
        ))}
      </fieldset>

      {scenario === 'disabled' ? (
        <>
          <p role="status">{message('documents.saveDenied')}</p>
          <div>
            <Button variant="outline" onClick={() => select('success')}>
              {message('documents.retryPermissions')}
            </Button>
          </div>
        </>
      ) : null}

      <div className="rounded-lg border border-border p-3">
        <MarkdownPreview
          markdown={message(
            draftTaken
              ? 'scene.saveConflict.latestMarkdown'
              : 'scene.saveConflict.draftMarkdown',
          )}
        />
      </div>

      {scenario === 'failure' ? <Failure error={DEMO_FAILURE} /> : null}

      {scenario === 'conflict' ? (
        <ConflictSection
          latest={latest}
          onReadLatest={() =>
            setLatest({
              version: 2,
              title: message('scene.saveConflict.demoTitle'),
              markdown: message('scene.saveConflict.latestMarkdown'),
            })
          }
          onKeep={() => select('success')}
          onTake={() => {
            setDraftTaken(true);
            select('success');
          }}
        />
      ) : null}

      <div>
        {/* Saving only succeeds in the success scenario; every other state
            keeps the button disabled exactly like the guarded production
            paths do. */}
        <Button
          type="button"
          disabled={scenario !== 'success'}
          onClick={() => setSaved(true)}
        >
          {message('documents.save')}
        </Button>
      </div>
      {saved ? (
        <p role="status" className="text-sm">
          {message('scene.saveConflict.saved')}
        </p>
      ) : null}
    </div>
  );
}
