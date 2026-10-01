import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { getAttachmentDownload, type ApiClient } from '@labos-threejs/sdk';
import { Button } from '@labos-threejs/ui/components/button';
import { retryAfterSeconds } from '@labos-threejs/core';
import { RateLimitHint, useRetryDelay } from '../system/rate-limit';
import type { FileTransfer } from './file-transfer';
import { useAppMessage } from '../shell/messages';

export type AttachmentContextValue = {
  apiClient: ApiClient;
  userId: string;
  documentId: string;
  transfer: FileTransfer;
};
export const AttachmentContext = createContext<AttachmentContextValue | null>(
  null,
);
export function attachmentId(url: string | undefined): string | undefined {
  return /^attachment:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
    url ?? '',
  )?.[1];
}

export function AttachmentImage({ id, alt }: { id: string; alt: string }) {
  const message = useAppMessage('knowledge');
  const context = useContext(AttachmentContext);
  const element = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(
    typeof IntersectionObserver === 'undefined',
  );
  const [imageFailed, setImageFailed] = useState(false);
  const cooldown = useRetryDelay();
  useEffect(() => {
    if (visible || !element.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [visible]);
  const download = useQuery({
    queryKey: [
      'knowledge',
      'attachment-preview',
      context?.userId,
      context?.documentId,
      id,
    ],
    enabled: !!context && visible,
    queryFn: async ({ signal }) => {
      try {
        return (
          await getAttachmentDownload({
            client: context!.apiClient,
            path: { id: context!.documentId, file_id: id },
            query: { inline: true },
            signal,
            throwOnError: true,
          })
        ).data;
      } catch (error) {
        if (!signal.aborted) cooldown.start(error);
        throw error;
      }
    },
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    staleTime: 30_000,
    gcTime: 0,
  });
  return (
    <span ref={element}>
      {!context ? (
        message('reader.attachmentImage', { alt })
      ) : download.isError || imageFailed ? (
        <>
          <RateLimitHint error={download.error} inline />
          <Button
            variant="link"
            disabled={download.isFetching || cooldown.remaining > 0}
            onClick={async () => {
              const refreshed = await download.refetch();
              if (refreshed.isSuccess) setImageFailed(false);
            }}
          >
            {cooldown.remaining > 0
              ? message('reader.waitRetry', { seconds: cooldown.remaining })
              : message('reader.retryImage')}
            {message('reader.nameSuffix', { alt })}
          </Button>
        </>
      ) : download.data?.file.previewable ? (
        <img
          src={download.data.url}
          alt={alt}
          crossOrigin="anonymous"
          referrerPolicy="no-referrer"
          loading="lazy"
          className="max-w-full rounded-md"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <span>{message('reader.attachmentImage', { alt })}</span>
      )}
    </span>
  );
}

export function AttachmentLink({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  const message = useAppMessage('knowledge');
  const context = useContext(AttachmentContext);
  const controller = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  const cooldown = useRetryDelay();
  useEffect(() => () => controller.current?.abort(), []);
  async function download() {
    if (!context || controller.current || cooldown.remaining > 0) return;
    const request = new AbortController();
    controller.current = request;
    setPending(true);
    setFailure(null);
    try {
      const capability = (
        await getAttachmentDownload({
          client: context.apiClient,
          path: { id: context.documentId, file_id: id },
          signal: request.signal,
          throwOnError: true,
        })
      ).data;
      await context.transfer.download(
        capability,
        capability.file,
        request.signal,
      );
    } catch (error) {
      if (!request.signal.aborted) {
        setFailure({ error });
        cooldown.start(error);
      }
    } finally {
      controller.current = null;
      if (!request.signal.aborted) setPending(false);
    }
  }
  if (!context) return <span>{children}</span>;
  return (
    <span>
      <Button
        variant="link"
        disabled={pending || cooldown.remaining > 0}
        onClick={() => {
          void download();
        }}
      >
        {children}
        {pending
          ? message('reader.downloadingInline')
          : cooldown.remaining > 0
            ? message('reader.waitInline', { seconds: cooldown.remaining })
            : ''}
      </Button>
      {failure ? (
        <span role="status">
          {retryAfterSeconds(failure.error) ? (
            <RateLimitHint error={failure.error} inline />
          ) : (
            message('reader.downloadFailed')
          )}
        </span>
      ) : null}
    </span>
  );
}
