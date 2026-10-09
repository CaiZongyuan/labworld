import {
  DocumentExportView,
  DocumentsView,
  NewDocumentView,
  DocumentView,
  EditDocumentView,
  KnowledgeBaseView,
  KnowledgeBasesView,
  type FileTransfer,
} from './index';
import { BookOpenIcon } from 'lucide-react';
import { useDocumentGuard } from './document-guard';
import { knowledgeMessages } from './messages';
import { SaveConflictScene } from './save-conflict-scene';
import { AttachmentScene } from './attachment-scene';
import { ExportStatesScene } from './export-scene';
import type {
  AppPageProps,
  ExampleContribution,
  NotificationDisplay,
} from '../shell/app-contract';
import type { Notification, NotificationTarget } from '@labos-threejs/sdk';

// The knowledge-base example's application contribution: its pages,
// business navigation, bilingual messages, default entry and notification
// target parsing live here so the app assembly point registers one value
// instead of editing shared files (docs/ui/design.md §4.1). Routes keep
// their published paths so existing deep links stay valid. Navigation
// blocking is consumed through the example's portable guard context; the
// app adapter provides the router-backed implementation.

type PageProps = AppPageProps<Record<string, string>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Notification display for this example's business, resolved from the
// structured target type and outcome — never by matching the stored
// subject, and without rewriting history records (docs/ui/design.md §6).
// The inbox and the export-states scene share this one mapping.
function knowledgeNotificationDisplay(
  notice: Notification,
): NotificationDisplay | undefined {
  if (notice.target.kind !== 'knowledge.export') return undefined;
  return {
    titleKey:
      notice.outcome === 'succeeded'
        ? 'knowledge.notifications.exportSucceeded'
        : 'knowledge.notifications.exportFailed',
  };
}

function GuardedNewDocument({
  apiClient,
  navigate,
  baseId,
}: PageProps & { baseId?: string }) {
  const guard = useDocumentGuard();
  return (
    <>
      {guard.prompt}
      <NewDocumentView
        apiClient={apiClient}
        knowledgeBaseId={baseId}
        onDirtyChange={guard.onDirtyChange}
        onBack={() =>
          baseId
            ? navigate({ path: '/knowledge-bases/$baseId', params: { baseId } })
            : navigate({ path: '/documents' })
        }
        onCreated={(documentId) =>
          navigate({
            path: '/documents/$documentId',
            params: { documentId },
            ignoreBlocker: true,
          })
        }
      />
    </>
  );
}

function GuardedEditDocument({
  params,
  navigate,
  apiClient,
  fileTransfer,
}: PageProps & { fileTransfer: FileTransfer }) {
  const guard = useDocumentGuard();
  return (
    <>
      {guard.prompt}
      <EditDocumentView
        apiClient={apiClient}
        fileTransfer={fileTransfer}
        documentId={params.documentId}
        onDirtyChange={guard.onDirtyChange}
        onBack={() => navigate({ path: '/documents/$documentId', params })}
        onSaved={(documentId) =>
          navigate({
            path: '/documents/$documentId',
            params: { documentId },
            ignoreBlocker: true,
          })
        }
      />
    </>
  );
}

export function createKnowledgeExample({
  fileTransfer,
  provide,
}: {
  fileTransfer: FileTransfer;
  provide?: ExampleContribution['provide'];
}): ExampleContribution {
  return {
    id: 'knowledge',
    defaultEntry: '/documents',
    provide,
    routes: [
      {
        path: '/documents/$documentId/exports/$exportId',
        component: ({ params, navigate, apiClient }) => (
          <DocumentExportView
            apiClient={apiClient}
            documentId={params.documentId}
            exportId={params.exportId}
            transfer={fileTransfer}
            onBack={() => navigate({ path: '/notifications' })}
          />
        ),
      },
      {
        path: '/knowledge-bases/$baseId',
        component: ({ params, navigate, apiClient }) => (
          <KnowledgeBaseView
            apiClient={apiClient}
            baseId={params.baseId}
            onBack={() => navigate({ path: '/knowledge-bases' })}
            onLogin={() => navigate({ path: '/login' })}
            onNew={() =>
              navigate({ path: '/knowledge-bases/$baseId/new', params })
            }
            onOpen={(documentId) =>
              navigate({
                path: '/documents/$documentId',
                params: { documentId },
              })
            }
          />
        ),
      },
      {
        path: '/knowledge-bases',
        component: ({ navigate, apiClient }) => (
          <KnowledgeBasesView
            apiClient={apiClient}
            onBack={() => navigate({ path: '/' })}
            onLogin={() => navigate({ path: '/login' })}
            onOpen={(baseId) =>
              navigate({ path: '/knowledge-bases/$baseId', params: { baseId } })
            }
          />
        ),
      },
      {
        path: '/knowledge-bases/$baseId/new',
        component: (props) => (
          <GuardedNewDocument {...props} baseId={props.params.baseId} />
        ),
      },
      {
        path: '/documents/$documentId/edit',
        component: (props) => (
          <GuardedEditDocument {...props} fileTransfer={fileTransfer} />
        ),
      },
      {
        path: '/documents',
        component: ({ navigate, apiClient }) => (
          <DocumentsView
            apiClient={apiClient}
            onNew={() => navigate({ path: '/documents/new' })}
            onOpen={(documentId) =>
              navigate({
                path: '/documents/$documentId',
                params: { documentId },
              })
            }
          />
        ),
      },
      {
        path: '/documents/new',
        component: (props) => <GuardedNewDocument {...props} />,
      },
      {
        path: '/documents/$documentId',
        component: ({ params, navigate, apiClient }) => (
          <DocumentView
            apiClient={apiClient}
            fileTransfer={fileTransfer}
            onLibrary={(baseId) =>
              navigate({ path: '/knowledge-bases/$baseId', params: { baseId } })
            }
            documentId={params.documentId}
            onEdit={() =>
              navigate({ path: '/documents/$documentId/edit', params })
            }
            onBack={() => navigate({ path: '/documents' })}
          />
        ),
      },
    ],
    navigation: [
      {
        id: 'library',
        labelKey: 'group.label',
        items: [
          { id: 'documents', labelKey: 'nav.documents', path: '/documents' },
          {
            id: 'knowledge-bases',
            labelKey: 'nav.knowledge-bases',
            path: '/knowledge-bases',
          },
        ],
      },
    ],
    // The module colors of this example's own sidebar entries (docs/ui/
    // design.md §6 Q9); removing the example removes them with it.
    moduleIcons: {
      '/documents': { icon: BookOpenIcon, variant: 'teal' },
      '/knowledge-bases': { icon: BookOpenIcon, variant: 'teal' },
    },
    messages: {
      zh: {
        ...knowledgeMessages.zh,
        'group.label': '知识库',
        'nav.documents': '我的文档',
        'nav.knowledge-bases': '知识库',
      },
      en: {
        ...knowledgeMessages.en,
        'group.label': 'Knowledge base',
        'nav.documents': 'My documents',
        'nav.knowledge-bases': 'Knowledge bases',
      },
    },
    resolveNotificationTarget: (target: NotificationTarget, { navigate }) => {
      const documentId = target.context.document_id;
      const exportId = target.resource_id;
      if (
        target.kind !== 'knowledge.export' ||
        !UUID.test(documentId ?? '') ||
        !UUID.test(exportId)
      )
        return undefined;
      return () => {
        navigate({
          path: '/documents/$documentId/exports/$exportId',
          params: { documentId, exportId },
        });
      };
    },
    describeNotification: knowledgeNotificationDisplay,
    // The save-conflict (UI07), attachment (UI08) and export-states (UI09)
    // scenes: demo feedback runs on the design-system page through the
    // same registration channel as every example scene.
    scenes: [
      {
        id: 'save-conflict',
        titleKey: 'scene.saveConflict.title',
        descriptionKey: 'scene.saveConflict.description',
        render: () => <SaveConflictScene />,
      },
      {
        id: 'attachment-states',
        titleKey: 'scene.attachments.title',
        descriptionKey: 'scene.attachments.description',
        render: () => <AttachmentScene />,
      },
      {
        id: 'export-states',
        titleKey: 'scene.exportStates.title',
        descriptionKey: 'scene.exportStates.description',
        render: () => (
          <ExportStatesScene describe={knowledgeNotificationDisplay} />
        ),
      },
    ],
  };
}
