import { useState } from 'react';
import type { Notification } from '@labos-threejs/sdk';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Button } from '@labos-threejs/ui/components/button';
import { exportLabelKeys } from './export-feedback';
import { notificationHeading } from '../notifications/notifications-view';
import type { NotificationDisplay } from '../shell/app-contract';
import { choiceRowClass } from '../shell/rows';
import { useAppMessage } from '../shell/messages';
import { useAppFormat } from '../shell/format';

// The design-system scene for UI09: export status feedback and the Core
// notification display contract run on demo data and local state — the
// badges reuse the production catalog keys and headings go through the
// same registered display mapping as the real inbox (docs/ui/design.md
// §6 Q9). Nothing here reads or writes real exports or notifications.

const STATUSES = [
  'queued',
  'running',
  'retry_wait',
  'succeeded',
  'failed',
  'expired',
] as const;

const DEMO_DATE = '2026-12-01T08:00:00Z';

// A history record: the server subject stays original; the heading is
// resolved from the structured type and outcome, so an English interface
// still shows an English title.
const DEMO_EXPORT_NOTICE = {
  id: 'scene-export-notice',
  subject: '文档导出',
  outcome: 'succeeded',
  read_at: null,
  created_at: DEMO_DATE,
  target: {
    kind: 'knowledge.export',
    resource_id: 'scene-export',
    context: { document_id: 'scene-document' },
  },
} satisfies Notification;

// A type no registered example claims: the original subject plus the
// outcome word, with the unavailable-target feedback instead of a button.
const DEMO_UNKNOWN_NOTICE = {
  id: 'scene-unknown-notice',
  subject: '笔记共享',
  outcome: 'failed',
  read_at: null,
  created_at: DEMO_DATE,
  target: {
    kind: 'notes.share',
    resource_id: 'scene-note',
    context: {},
  },
} satisfies Notification;

function DemoNotice({
  notice,
  describe,
  label,
  openable,
}: {
  notice: Notification;
  describe: (notice: Notification) => NotificationDisplay | undefined;
  label: string;
  /** Registered types resolve a target in production; unknown ones never do. */
  openable: boolean;
}) {
  const coreText = useAppMessage();
  const { formatDateTime } = useAppFormat();
  const [read, setRead] = useState(false);
  return (
    <div
      aria-label={label}
      className="flex flex-col gap-2 rounded-md border p-3"
    >
      <div className="flex flex-wrap items-center gap-3">
        <p className="font-semibold">
          {notificationHeading(notice, describe(notice), coreText)}
        </p>
        <Badge variant={read ? 'outline' : 'secondary'}>
          {coreText(read ? 'notifications.read' : 'notifications.unread')}
        </Badge>
      </div>
      <time
        className="text-sm text-muted-foreground"
        dateTime={notice.created_at}
      >
        {formatDateTime(notice.created_at)}
      </time>
      <div className="flex flex-wrap items-center gap-3">
        {openable ? (
          // The real button marks the notice read and navigates; the demo
          // keeps the read half on local state and stays on this page.
          <Button
            disabled={read}
            onClick={() => {
              setRead(true);
            }}
          >
            {coreText('notifications.openResult')}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            {coreText('notifications.targetUnavailable')}
          </p>
        )}
        {!read ? (
          <Button
            variant="outline"
            onClick={() => {
              setRead(true);
            }}
          >
            {coreText('notifications.markRead')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function ExportStatesScene({
  describe,
}: {
  describe: (notice: Notification) => NotificationDisplay | undefined;
}) {
  const message = useAppMessage('knowledge');
  const { formatDateTime } = useAppFormat();
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('queued');
  const [downloading, setDownloading] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <fieldset aria-label={message('scene.exportStates.statusTitle')}>
        {STATUSES.map((id) => (
          <label key={id} className={choiceRowClass}>
            <input
              type="radio"
              name="knowledge-export-scene"
              value={id}
              checked={status === id}
              onChange={() => {
                setStatus(id);
                setDownloading(false);
              }}
              className="accent-[var(--primary)]"
            />
            {id}
          </label>
        ))}
      </fieldset>

      <ul>
        <li className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
          <span>{message('common.version', { version: 3 })}</span>
          <Badge variant={status === 'failed' ? 'destructive' : 'secondary'}>
            {message(exportLabelKeys[status])}
          </Badge>
          {status === 'failed' ? (
            <span className="text-sm">{message('exports.failedNote')}</span>
          ) : null}
          <span className="text-sm text-muted-foreground">
            {message('exports.expires', { date: formatDateTime(DEMO_DATE) })}
          </span>
          {status === 'succeeded' ? (
            <Button
              variant="outline"
              onClick={() => {
                setDownloading((value) => !value);
              }}
            >
              {downloading
                ? message('common.downloading')
                : message('exports.downloadZip')}
            </Button>
          ) : null}
        </li>
      </ul>

      <p className="text-sm font-medium">
        {message('scene.exportStates.noticeTitle')}
      </p>
      <DemoNotice
        notice={DEMO_EXPORT_NOTICE}
        describe={describe}
        label={message('scene.exportStates.demoExportNotice')}
        openable
      />
      <DemoNotice
        notice={DEMO_UNKNOWN_NOTICE}
        describe={describe}
        label={message('scene.exportStates.demoUnknownNotice')}
        openable={false}
      />
    </div>
  );
}
