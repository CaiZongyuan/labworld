export type FilePolicy = {
  maxBytes: number;
  uploadSecs: number;
  downloadSecs: number;
};
export const defaultFilePolicy: FilePolicy = {
  maxBytes: 20 * 1024 * 1024,
  uploadSecs: 900,
  downloadSecs: 60,
};
export type UploadInput = {
  file_name: string;
  content_type: string;
  size: number;
  sha256: string;
};
export type FileInfo = {
  id: string;
  file_name: string;
  content_type: string;
  size: number;
  sha256: string;
  created_at: string;
  previewable: boolean;
};
export type ObjectCapability = {
  url: string;
  method: string;
  headers: Record<string, string>;
  expires_at: string;
};
export type UploadCapability = {
  upload_id: string;
  state: string;
  upload: ObjectCapability | null;
};
export type DownloadCapability = ObjectCapability & { file: FileInfo };
export function normalizeUpload(input: UploadInput, policy: FilePolicy) {
  const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
  const media = new RegExp(
    `^(${token})/(${token})(?:\\s*;\\s*${token}\\s*=\\s*(?:${token}|"(?:[^"\\\\\\r\\n]|\\\\[^\\r\\n])*"))*\\s*$`,
  ).exec(input.content_type);
  if (
    !Number.isSafeInteger(input.size) ||
    input.size < 0 ||
    !input.file_name.trim() ||
    [...input.file_name].length > 255 ||
    /[\p{Cc}/\\]/u.test(input.file_name) ||
    ['.', '..'].includes(input.file_name) ||
    input.content_type.length > 127 ||
    !media ||
    media[1] === '*' ||
    media[2] === '*' ||
    !/^[0-9a-fA-F]{64}$/.test(input.sha256)
  )
    return undefined;
  if (input.size > policy.maxBytes) return 'too_large';
  return {
    ...input,
    content_type: `${media[1]}/${media[2]}`.toLowerCase(),
    sha256: input.sha256.toLowerCase(),
  };
}
export function validContents(contentType: string, prefix: Uint8Array) {
  const begins = (expected: number[]) =>
    expected.every((value, index) => prefix[index] === value);
  const text = (start: number, length: number) =>
    String.fromCharCode(...prefix.slice(start, start + length));
  switch (contentType) {
    case 'image/png':
      return begins([137, 80, 78, 71, 13, 10, 26, 10]);
    case 'image/jpeg':
      return begins([255, 216, 255]);
    case 'image/gif':
      return ['GIF87a', 'GIF89a'].includes(text(0, 6));
    case 'image/webp':
      return text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP';
    case 'application/pdf':
      return text(0, 5) === '%PDF-';
    default:
      return true;
  }
}
