import type { FileTransfer } from '@labos-threejs/views';

// Covers the entire transfer, including a response body that stops progressing.
async function withTransferDeadline<T>(
  signal: AbortSignal,
  operation: (bounded: AbortSignal) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        new DOMException('文件传输超时，请重试。', 'TimeoutError'),
      ),
    120_000,
  );
  try {
    return await operation(AbortSignal.any([signal, deadline.signal]));
  } finally {
    clearTimeout(timer);
  }
}

function readFile(file: File, signal: AbortSignal): Promise<ArrayBuffer> {
  signal.throwIfAborted();
  if (typeof file.arrayBuffer === 'function')
    return file.arrayBuffer().then((bytes) => {
      signal.throwIfAborted();
      return bytes;
    });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => reader.abort();
    const cleanup = () => {
      signal.removeEventListener('abort', abort);
      reader.onload = null;
      reader.onerror = null;
      reader.onabort = null;
    };
    reader.onload = () => {
      const bytes = reader.result;
      cleanup();
      if (bytes !== null && typeof bytes !== 'string') resolve(bytes);
      else reject(new Error('无法读取文件。'));
    };
    reader.onerror = () => {
      cleanup();
      reject(new Error('无法读取文件，请重新选择。'));
    };
    reader.onabort = () => {
      cleanup();
      reject(new DOMException('操作已取消', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    reader.readAsArrayBuffer(file);
  });
}

export const browserFileTransfer: FileTransfer = {
  async hash(file, signal) {
    const bytes = await readFile(file, signal);
    signal.throwIfAborted();
    const digest = await globalThis.crypto.subtle.digest(
      'SHA-256',
      new Uint8Array(bytes),
    );
    signal.throwIfAborted();
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  },
  upload(capability, file, progress, signal) {
    return withTransferDeadline(
      signal,
      (signal) =>
        new Promise((resolve, reject) => {
          if (capability.method !== 'PUT') {
            reject(new Error('上传请求无效。'));
            return;
          }
          const xhr = new XMLHttpRequest();
          let settled = false;
          const abort = () => {
            cleanup();
            xhr.abort();
            reject(signal.reason);
          };
          const cleanup = () => {
            settled = true;
            signal.removeEventListener('abort', abort);
            xhr.upload.removeEventListener('progress', onProgress);
            xhr.removeEventListener('load', onLoad);
            xhr.removeEventListener('error', onError);
            xhr.removeEventListener('abort', onAbort);
          };
          xhr.open('PUT', capability.url);
          xhr.withCredentials = false;
          for (const [name, value] of Object.entries(capability.headers))
            xhr.setRequestHeader(name, value);
          const onProgress = (event: ProgressEvent) => {
            if (!settled && event.lengthComputable && event.total)
              progress(
                Math.min(100, Math.round((event.loaded * 100) / event.total)),
              );
          };
          const onLoad = () => {
            const ok = xhr.status >= 200 && xhr.status < 300;
            cleanup();
            if (ok) resolve();
            else reject(new Error('上传失败，请重试。'));
          };
          const onError = () => {
            cleanup();
            reject(new Error('上传失败，请检查网络后重试。'));
          };
          const onAbort = () => {
            cleanup();
            reject(new DOMException('上传已取消', 'AbortError'));
          };
          signal.addEventListener('abort', abort, { once: true });
          xhr.upload.addEventListener('progress', onProgress);
          xhr.addEventListener('load', onLoad);
          xhr.addEventListener('error', onError);
          xhr.addEventListener('abort', onAbort);
          try {
            xhr.send(file);
          } catch {
            cleanup();
            reject(new Error('无法开始上传，请重试。'));
          }
        }),
    );
  },
  download(capability, file, signal) {
    return withTransferDeadline(signal, async (signal) => {
      if (
        capability.method !== 'GET' ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0
      )
        throw new Error('下载信息无效。');
      const response = await fetch(capability.url, {
        headers: capability.headers,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal,
      });
      if (!response.ok) throw new Error('下载失败，请重新获取下载链接。');
      const chunks: BlobPart[] = [];
      const reader = response.body?.getReader();
      let received = 0;
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (received > file.size) throw new Error('下载内容大小不符。');
            chunks.push(new Uint8Array(value));
          }
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
      }
      if (received !== file.size) throw new Error('下载内容不完整，请重试。');
      signal.throwIfAborted();
      const url = URL.createObjectURL(
        new Blob(chunks, { type: 'application/octet-stream' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = file.file_name;
      link.hidden = true;
      document.body.append(link);
      try {
        link.click();
      } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    });
  },
};
