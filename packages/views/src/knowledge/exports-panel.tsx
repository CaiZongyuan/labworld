import { useRef } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import {
  listDocumentExports,
  requestDocumentExport,
  type ApiClient,
  type CurrentSession,
} from '@labos-threejs/sdk';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Button } from '@labos-threejs/ui/components/button';
import type { FileTransfer } from './file-transfer';
import { useExportDownload } from './export-download';
import {
  ExportFailure,
  exportLabelKeys,
  exportPending,
} from './export-feedback';
import { sessionKey } from '../identity/session';
import { errorCodeOf } from '@labos-threejs/core';
import { useAppMessage } from '../shell/messages';
import { useAppFormat } from '../shell/format';

export function ExportsPanel({
  apiClient,
  identity,
  documentId,
  transfer,
}: {
  apiClient: ApiClient;
  identity: CurrentSession;
  documentId: string;
  transfer: FileTransfer;
}) {
  const message = useAppMessage('knowledge');
  const { formatDateTime } = useAppFormat();
  const queryClient = useQueryClient();
  const queryKey = ['knowledge', 'exports', identity.user.id, documentId];
  const exports = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      (
        await listDocumentExports({
          client: apiClient,
          path: { id: documentId },
          query: { cursor: pageParam, limit: 20 },
          signal,
          throwOnError: true,
        })
      ).data,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    maxPages: 5,
    retry: false,
    refetchInterval: (query) =>
      !query.state.error &&
      query.state.data?.pages.some((page) =>
        page.data.some((item) => exportPending.has(item.status)),
      )
        ? 1500
        : false,
  });
  function refreshAccess(error: unknown) {
    const code = errorCodeOf(error);
    if (
      [
        'knowledge.forbidden',
        'knowledge.not_found',
        'auth.unauthorized',
      ].includes(code ?? '')
    ) {
      for (const resource of ['document', 'attachments', 'exports']) {
        void queryClient.invalidateQueries({
          queryKey: ['knowledge', resource, identity.user.id, documentId],
        });
      }
      if (code === 'auth.unauthorized')
        void queryClient.invalidateQueries({ queryKey: sessionKey(apiClient) });
    }
  }
  const key = useRef(crypto.randomUUID());
  const create = useMutation({
    mutationFn: async () =>
      (
        await requestDocumentExport({
          client: apiClient,
          path: { id: documentId },
          headers: {
            'x-csrf-token': identity.csrf_token,
            'idempotency-key': key.current,
          },
          signal: AbortSignal.timeout(10_000),
          throwOnError: true,
        })
      ).data,
    retry: false,
    onError: refreshAccess,
    onSuccess: async () => {
      key.current = crypto.randomUUID();
      await queryClient.resetQueries({ queryKey, exact: true });
    },
  });
  const { error, clearError, downloading, download } = useExportDownload({
    apiClient,
    documentId,
    transfer,
    onFailure: (error) => {
      refreshAccess(error);
      void exports.refetch();
    },
  });
  const items = exports.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <section
      aria-label={message('exports.section')}
      className="flex flex-col gap-4"
    >
      <h2 className="text-xl font-semibold">{message('exports.heading')}</h2>
      <p className="text-sm text-muted-foreground">{message('exports.hint')}</p>
      <div className="flex flex-wrap gap-3">
        <Button
          disabled={create.isPending || exports.isPending || exports.isError}
          onClick={() => {
            clearError();
            create.mutate();
          }}
        >
          {create.isPending
            ? message('exports.requesting')
            : create.isError
              ? message('exports.retryRequest')
              : message('exports.request')}
        </Button>
        <Button
          variant="outline"
          disabled={exports.isFetching}
          onClick={() => {
            void exports.refetch();
          }}
        >
          {message('exports.refresh')}
        </Button>
      </div>
      {exports.isPending ? (
        <p role="status">{message('exports.loading')}</p>
      ) : null}
      {exports.isError ? <ExportFailure error={exports.error} /> : null}
      {create.isError ? <ExportFailure error={create.error} /> : null}
      {error ? <ExportFailure error={error} /> : null}
      {!exports.isPending && !exports.isError && items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {message('exports.empty')}
        </p>
      ) : null}
      {!exports.isError ? (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border p-4"
            >
              <span>
                {message('common.version', { version: item.document_version })}
              </span>
              <Badge
                variant={item.status === 'failed' ? 'destructive' : 'secondary'}
              >
                {message(
                  exportLabelKeys[item.status] ?? 'exports.statusUpdating',
                )}
              </Badge>
              {item.status === 'failed' ? (
                <span className="text-sm">{message('exports.failedNote')}</span>
              ) : null}
              <span className="text-sm text-muted-foreground">
                {message('exports.expires', {
                  date: formatDateTime(item.expires_at),
                })}
              </span>
              {item.can_download ? (
                <Button
                  variant="outline"
                  disabled={!!downloading}
                  onClick={() => {
                    void download(item.id);
                  }}
                >
                  {downloading === item.id
                    ? message('common.downloading')
                    : message('exports.downloadZip')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {exports.hasNextPage ? (
        <Button
          variant="outline"
          disabled={exports.isFetching}
          onClick={() => {
            void exports.fetchNextPage();
          }}
        >
          {message('exports.loadMore')}
        </Button>
      ) : null}
    </section>
  );
}
