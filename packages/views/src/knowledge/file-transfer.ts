import type { FileInfo, ObjectCapability } from '@labos-threejs/sdk';

/** DOM hosts supply byte transfer and hashing; shared Views own the upload workflow. */
export interface FileTransfer {
  hash(file: File, signal: AbortSignal): Promise<string>;
  upload(
    capability: ObjectCapability,
    file: File,
    progress: (percent: number) => void,
    signal: AbortSignal,
  ): Promise<void>;
  download(
    capability: ObjectCapability,
    file: FileInfo,
    signal: AbortSignal,
  ): Promise<void>;
}
