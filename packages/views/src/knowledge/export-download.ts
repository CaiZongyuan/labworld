import { useEffect, useRef, useState } from 'react';
import { downloadDocumentExport, type ApiClient } from '@labos-threejs/sdk';
import type { FileTransfer } from './file-transfer';

/** One in-flight transfer per mounted export surface, cancelled on navigation. */
export function useExportDownload({
  apiClient,
  documentId,
  transfer,
  onFailure,
}: {
  apiClient: ApiClient;
  documentId: string;
  transfer: FileTransfer;
  onFailure: (error: unknown) => void;
}) {
  const abort = useRef<AbortController | null>(null);
  const [downloading, setDownloading] = useState<string>();
  const [error, setError] = useState<unknown>();
  useEffect(() => () => abort.current?.abort(), []);
  async function download(exportId: string) {
    if (abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    setDownloading(exportId);
    setError(undefined);
    try {
      const capability = (
        await downloadDocumentExport({
          client: apiClient,
          path: { id: documentId, export_id: exportId },
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10_000),
          ]),
          throwOnError: true,
        })
      ).data;
      await transfer.download(capability, capability.file, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(error);
        onFailure(error);
      }
    } finally {
      abort.current = null;
      if (!controller.signal.aborted) setDownloading(undefined);
    }
  }
  return {
    downloading,
    error,
    clearError: () => setError(undefined),
    download,
  };
}
