import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import {
  completeAttachmentUpload,
  getAttachmentDownload,
  listAttachments,
  startAttachmentUpload,
  type ApiClient,
  type CurrentSession,
  type FileInfo,
} from '@labos-threejs/sdk';
import { errorCodeOf } from '@labos-threejs/core';
import { Button } from '@labos-threejs/ui/components/button';
import { Empty, EmptyHeader, EmptyTitle } from '@labos-threejs/ui/components/empty';
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from '@labos-threejs/ui/components/field';
import { Input } from '@labos-threejs/ui/components/input';
import { MaterialFileIcon } from '@labos-threejs/ui/components/material-file-icon';
import type { FileTransfer } from './file-transfer';
import { AttachmentFailure, UploadProgress } from './attachment-feedback';
import type { UploadPhase } from './attachment-feedback';
import { DeleteResource } from './delete-resource';
import { sessionKey } from '../identity';
import { useAppMessage } from '../shell/messages';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

type Phase = UploadPhase | 'idle' | 'done' | 'failed';

export function AttachmentsPanel({
  apiClient,
  identity,
  documentId,
  canEdit,
  transfer,
  onInsert,
}: {
  apiClient: ApiClient;
  identity: CurrentSession;
  documentId: string;
  canEdit: boolean;
  transfer: FileTransfer;
  onInsert?: (markdown: string) => void;
}) {
  const message = useAppMessage('knowledge');
  const queryClient = useQueryClient();
  const attachments = useInfiniteQuery({
    queryKey: ['knowledge', 'attachments', identity.user.id, documentId],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      (
        await listAttachments({
          client: apiClient,
          path: { id: documentId },
          query: { cursor: pageParam, limit: 50 },
          signal,
          throwOnError: true,
        })
      ).data,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    maxPages: 10,
    retry: false,
  });
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<unknown>();
  const [denied, setDenied] = useState(false);
  const [downloading, setDownloading] = useState<string>();
  const attempt = useRef<{ file: File; key: string; sha256?: string } | null>(
    null,
  );
  const uploadAbort = useRef<AbortController | null>(null);
  const downloadAbort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      uploadAbort.current?.abort();
      downloadAbort.current?.abort();
    };
  }, []);
  const busy =
    phase === 'hashing' || phase === 'uploading' || phase === 'completing';
  const canUpload =
    canEdit &&
    !!attachments.data?.pages[0]?.can_upload &&
    !attachments.isError &&
    !denied;
  const serverCanDelete = attachments.data?.pages[0]?.can_delete;
  const canDelete =
    canEdit && serverCanDelete === true && !attachments.isError && !denied;
  const accessError = errorCodeOf(attachments.error);
  useEffect(() => {
    if (
      (canEdit && serverCanDelete === false) ||
      [
        'knowledge.not_found',
        'knowledge.forbidden',
        'auth.unauthorized',
      ].includes(accessError ?? '')
    ) {
      void queryClient.invalidateQueries({
        queryKey: ['knowledge', 'document', identity.user.id, documentId],
      });
      if (accessError === 'auth.unauthorized')
        void queryClient.invalidateQueries({ queryKey: sessionKey(apiClient) });
    }
  }, [
    canEdit,
    serverCanDelete,
    accessError,
    queryClient,
    identity.user.id,
    documentId,
    apiClient,
  ]);
  const maxBytes = attachments.data?.pages[0]?.max_upload_bytes ?? 0;
  const items = attachments.data?.pages.flatMap((page) => page.data) ?? [];

  function reject(error: unknown) {
    if (!mounted.current) return;
    setError(error);
    if (
      [
        'knowledge.forbidden',
        'knowledge.not_found',
        'auth.unauthorized',
      ].includes(errorCodeOf(error) ?? '')
    ) {
      setDenied(true);
      void queryClient.invalidateQueries({
        queryKey: ['knowledge', 'document', identity.user.id, documentId],
      });
      void attachments.refetch();
    }
  }
  async function upload() {
    if (!file || busy || !canUpload) return;
    if (file.size > maxBytes) {
      setError({ error: { code: 'files.too_large' } });
      return;
    }
    if (attempt.current?.file !== file)
      attempt.current = { file, key: crypto.randomUUID() };
    const active = attempt.current;
    const controller = new AbortController();
    uploadAbort.current = controller;
    setError(undefined);
    setPhase('hashing');
    setProgress(0);
    try {
      active.sha256 ??= await transfer.hash(file, controller.signal);
      const upload = (
        await startAttachmentUpload({
          client: apiClient,
          path: { id: documentId },
          headers: {
            'x-csrf-token': identity.csrf_token,
            'idempotency-key': active.key,
          },
          body: {
            file_name: file.name,
            content_type: file.type || 'application/octet-stream',
            size: file.size,
            sha256: active.sha256,
          },
          signal: controller.signal,
          throwOnError: true,
        })
      ).data;
      if (upload.upload) {
        setPhase('uploading');
        await transfer.upload(
          upload.upload,
          file,
          (value) => {
            if (mounted.current) setProgress(value);
          },
          controller.signal,
        );
      }
      controller.signal.throwIfAborted();
      setPhase('completing');
      setProgress(100);
      await completeAttachmentUpload({
        client: apiClient,
        path: { id: documentId, upload_id: upload.upload_id },
        headers: { 'x-csrf-token': identity.csrf_token },
        signal: controller.signal,
        throwOnError: true,
      });
      await queryClient.invalidateQueries({
        queryKey: ['knowledge', 'attachments', identity.user.id, documentId],
      });
      if (mounted.current) {
        setPhase('done');
        setFile(null);
        attempt.current = null;
        if (input.current) input.current.value = '';
      }
    } catch (error) {
      if (controller.signal.aborted || !mounted.current) return;
      if (
        ['files.upload_expired', 'files.upload_rejected'].includes(
          errorCodeOf(error) ?? '',
        )
      )
        attempt.current = null;
      setPhase('failed');
      reject(error);
    } finally {
      if (uploadAbort.current === controller) uploadAbort.current = null;
    }
  }
  async function download(file: FileInfo) {
    if (downloadAbort.current) return;
    const controller = new AbortController();
    downloadAbort.current = controller;
    setDownloading(file.id);
    setError(undefined);
    try {
      const capability = (
        await getAttachmentDownload({
          client: apiClient,
          path: { id: documentId, file_id: file.id },
          signal: controller.signal,
          throwOnError: true,
        })
      ).data;
      await transfer.download(capability, file, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) reject(error);
    } finally {
      downloadAbort.current = null;
      if (mounted.current) setDownloading(undefined);
    }
  }

  return (
    <section
      aria-label={message('attachments.section')}
      className="flex flex-col gap-4"
    >
      <h2 className="text-xl font-semibold">
        {message('attachments.heading')}
      </h2>
      <Button
        variant="outline"
        disabled={attachments.isFetching}
        onClick={async () => {
          const refreshed = await attachments.refetch();
          if (refreshed.isSuccess)
            setDenied(!refreshed.data.pages[0]?.can_delete);
        }}
      >
        {message('attachments.retry')}
      </Button>
      {attachments.isPending ? (
        <p role="status">{message('attachments.loading')}</p>
      ) : null}
      {attachments.isError ? (
        <AttachmentFailure error={attachments.error} />
      ) : null}
      {canEdit ? (
        <FieldGroup>
          <Field data-disabled={busy || !canUpload}>
            <FieldLabel htmlFor="attachment-file">
              {message('attachments.fileLabel')}
            </FieldLabel>
            <Input
              ref={input}
              id="attachment-file"
              type="file"
              disabled={busy || !canUpload}
              onChange={(event) => {
                setFile(event.currentTarget.files?.[0] ?? null);
                attempt.current = null;
                setPhase('idle');
                setError(undefined);
              }}
            />
            <FieldDescription>
              {message('attachments.hint', { size: formatBytes(maxBytes) })}
            </FieldDescription>
          </Field>
          <Button
            disabled={!file || busy || !canUpload}
            onClick={() => {
              void upload();
            }}
          >
            {phase === 'failed'
              ? message('attachments.retryUpload')
              : message('attachments.upload')}
          </Button>
        </FieldGroup>
      ) : null}
      {busy ? <UploadProgress phase={phase} progress={progress} /> : null}
      {phase === 'done' ? (
        <p role="status">{message('attachments.uploaded')}</p>
      ) : null}
      {error ? <AttachmentFailure error={error} /> : null}
      {!attachments.isPending && !attachments.isError && items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{message('attachments.empty')}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : null}
      {!attachments.isError ? (
        <ul className="flex flex-col gap-3">
          {items.map((file) => (
            <li key={file.id} className="flex flex-wrap items-center gap-3">
              <MaterialFileIcon
                name={file.file_name}
                mimeType={file.content_type}
                className="size-5 shrink-0"
              />
              <span>
                {file.file_name} · {formatBytes(file.size)}
              </span>
              <Button
                variant="outline"
                disabled={!!downloading}
                aria-label={message('attachments.download', {
                  name: file.file_name,
                })}
                onClick={() => {
                  void download(file);
                }}
              >
                {downloading === file.id
                  ? message('common.downloading')
                  : message('attachments.downloadAction')}
              </Button>
              {canDelete ? (
                <DeleteResource
                  apiClient={apiClient}
                  identity={identity}
                  resource={{
                    kind: 'attachment',
                    id: file.id,
                    documentId,
                    name: file.file_name,
                  }}
                  disabled={busy || !!downloading}
                />
              ) : null}
              {onInsert && canUpload ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    const label = file.file_name.replace(/[\\[\]]/g, '\\$&');
                    onInsert(
                      `${file.previewable ? '!' : ''}[${label}](attachment:${file.id})`,
                    );
                  }}
                >
                  {message('attachments.insertRef')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {attachments.hasNextPage ? (
        <Button
          variant="outline"
          disabled={attachments.isFetching}
          onClick={() => {
            void attachments.fetchNextPage();
          }}
        >
          {message('attachments.loadMore')}
        </Button>
      ) : null}
    </section>
  );
}
