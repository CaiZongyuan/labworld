import type { FileService } from '../../core/files/use-cases.ts';

// Upload receipts retain terminal metadata, while representations own ready bytes.
export function registerAssetFileOwnership(files: FileService) {
  files.registerProvisionalReference({
    owner: 'Lab asset upload receipt',
    schema: 'lab',
    table: 'asset_uploads',
    column: 'upload_id',
  });
}
