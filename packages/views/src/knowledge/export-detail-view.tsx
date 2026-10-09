import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getDocumentExport,
  type ApiClient,
  type CurrentSession,
} from '@labos-threejs/sdk';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Button } from '@labos-threejs/ui/components/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@labos-threejs/ui/components/card';
import { sessionQuery } from '../identity';
import {
  ExportFailure,
  exportLabelKeys,
  exportPending,
} from './export-feedback';
import { useExportDownload } from './export-download';
import type { FileTransfer } from './file-transfer';
import { useAppMessage } from '../shell/messages';
import { useAppFormat } from '../shell/format';

export function DocumentExportView({
  apiClient,
  documentId,
  exportId,
  transfer,
  onBack,
}: {
  apiClient: ApiClient;
  documentId: string;
  exportId: string;
  transfer: FileTransfer;
  onBack: () => void;
}) {
  const message = useAppMessage('knowledge');
  const client = useQueryClient();
  const session = useQuery(sessionQuery(apiClient, client));
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">
          {message('exports.detailTitle')}
        </h1>
        <Button variant="link" onClick={onBack}>
          {message('exports.backToNotifications')}
        </Button>
      </header>
      {session.isPending ? (
        <p role="status">{message('common.readingSession')}</p>
      ) : session.isError ? (
        <ExportFailure error={session.error} />
      ) : !session.data ? (
        <p>{message('exports.signInFirst')}</p>
      ) : (
        <Result
          key={`${session.data.user.id}:${documentId}:${exportId}`}
          apiClient={apiClient}
          identity={session.data}
          documentId={documentId}
          exportId={exportId}
          transfer={transfer}
        />
      )}
    </div>
  );
}
function Result({
  apiClient,
  identity,
  documentId,
  exportId,
  transfer,
}: {
  apiClient: ApiClient;
  identity: CurrentSession;
  documentId: string;
  exportId: string;
  transfer: FileTransfer;
}) {
  const result = useQuery({
    queryKey: ['knowledge', 'export', identity.user.id, documentId, exportId],
    queryFn: async ({ signal }) =>
      (
        await getDocumentExport({
          client: apiClient,
          path: { id: documentId, export_id: exportId },
          signal,
          throwOnError: true,
        })
      ).data,
    retry: false,
    refetchInterval: (query) =>
      !query.state.error && exportPending.has(query.state.data?.status ?? '')
        ? 1500
        : false,
  });
  const message = useAppMessage('knowledge');
  const { formatDateTime } = useAppFormat();
  const { error, clearError, downloading, download } = useExportDownload({
    apiClient,
    documentId,
    transfer,
    onFailure: () => {
      void result.refetch();
    },
  });
  const item = result.data;
  return (
    <>
      <Button
        variant="outline"
        disabled={result.isFetching}
        onClick={() => {
          clearError();
          void result.refetch();
        }}
      >
        {message('exports.refresh')}
      </Button>
      {result.isPending ? (
        <p role="status">{message('exports.detailLoading')}</p>
      ) : result.isError ? (
        <ExportFailure error={result.error} />
      ) : item ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {message('common.version', { version: item.document_version })}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div>
              <Badge
                variant={item.status === 'failed' ? 'destructive' : 'secondary'}
              >
                {message(
                  exportLabelKeys[item.status] ?? 'exports.statusUpdating',
                )}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {message('exports.expires', {
                date: formatDateTime(item.expires_at),
              })}
            </p>
            {item.status === 'failed' || item.status === 'expired' ? (
              <p>{message('exports.reusableHint')}</p>
            ) : null}
            {item.can_download ? (
              <Button
                disabled={!!downloading}
                onClick={() => {
                  void download(exportId);
                }}
              >
                {downloading
                  ? message('common.downloading')
                  : message('exports.downloadZip')}
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
      {error ? <ExportFailure error={error} /> : null}
    </>
  );
}
