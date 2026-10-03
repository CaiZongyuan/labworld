import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleAlert, X } from 'lucide-react';
import { errorCodeOf } from '@labos-threejs/core';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@labos-threejs/ui/components/alert';
import { Button } from '@labos-threejs/ui/components/button';
import { useAppMessage } from '../shell/messages';
import { ModelImportError, readModelFile, type ModelErrorKey } from './glb';

const importFailures: Record<string, ModelErrorKey> = {
  'files.too_large': 'tooLarge',
  'files.upload_rejected': 'invalid',
  'auth.unauthorized': 'denied',
  'auth.csrf': 'denied',
};

export function useModelImport(
  onFile: (
    file: File,
    buffer: ArrayBuffer,
    signal: AbortSignal,
  ) => unknown | Promise<unknown>,
  maxBytes: number,
) {
  const input = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ModelErrorKey | 'single' | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const cancel = useCallback(() => {
    request.current?.abort();
    setPending(false);
  }, []);
  const importFile = useCallback(
    async (file: File) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setPending(true);
      setError(null);
      try {
        if (!maxBytes) throw new ModelImportError('storage');
        if (file.size > maxBytes) throw new ModelImportError('tooLarge');
        const buffer = await readModelFile(file, controller.signal);
        if (!controller.signal.aborted)
          await onFile(file, buffer, controller.signal);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(
            cause instanceof ModelImportError
              ? cause.key
              : (importFailures[errorCodeOf(cause) ?? ''] ?? 'storage'),
          );
      } finally {
        if (!controller.signal.aborted) setPending(false);
      }
    },
    [onFile, maxBytes],
  );
  return { input, pending, error, setError, importFile, cancel };
}

export function ModelFileInput({
  importer,
}: {
  importer: ReturnType<typeof useModelImport>;
}) {
  const message = useAppMessage('lab');
  return (
    <input
      ref={importer.input}
      hidden
      type="file"
      accept=".glb,model/gltf-binary"
      aria-label={message('import.fileLabel')}
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) void importer.importFile(file);
      }}
    />
  );
}

export function ImportFeedback({
  error,
  onDismiss,
}: {
  error: ModelErrorKey | 'single' | null;
  onDismiss: () => void;
}) {
  const message = useAppMessage('lab');
  if (!error) return null;
  return (
    <div className="flex items-center gap-2">
      <Alert variant="destructive">
        <CircleAlert aria-hidden="true" />
        <AlertTitle>{message('import.errorTitle')}</AlertTitle>
        <AlertDescription>{message(`import.${error}`)}</AlertDescription>
      </Alert>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={message('import.dismiss')}
        onClick={onDismiss}
      >
        <X />
      </Button>
    </div>
  );
}
