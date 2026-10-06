import type { UploadInput } from '../../core/files/domain.ts';
export type CreateAssetUpload = {
  name: string;
  source: string;
  license: string;
  version: string;
  file: UploadInput;
};
export type LabAsset = {
  id: string;
  name: string;
  source: string;
  license: string;
  version: string;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  representation: {
    id: string;
    file_id: string;
    file_name: string;
    size: number;
    sha256: string;
    content_type: string;
  };
};
export function validText(text: string, max: number, required: boolean) {
  return (
    (!required || text.trim().length > 0) &&
    [...text].length <= max &&
    !/[\p{Cc}]/u.test(text)
  );
}
export function normalizeAssetUpload(input: CreateAssetUpload) {
  const value = { ...input, name: input.name.trim() };
  return validText(value.name, 120, true) &&
    validText(value.source, 2048, false) &&
    validText(value.license, 200, false) &&
    validText(value.version, 80, true) &&
    value.file.file_name.toLowerCase().endsWith('.glb') &&
    value.file.content_type === 'model/gltf-binary'
    ? value
    : undefined;
}
