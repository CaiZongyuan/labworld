import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';

/** Publish a complete request before the supervisor's directory watcher sees it. */
export async function publishServiceControlRequest(
  path: string,
  request: { revision: number; action: string },
) {
  const temporary = path + '.' + randomUUID() + '.next';
  try {
    await writeFile(temporary, JSON.stringify(request));
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
