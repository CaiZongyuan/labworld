import { contextBridge, ipcRenderer } from 'electron';
import {
  CHANNELS,
  DESKTOP_BRIDGE_NAME,
  validateDesktopPreferences,
  validateDownloadState,
  type DownloadStateEvent,
} from './ipc-contract';

/**
 * The only bridge between the shell and the shared views. Every payload is
 * validated before it reaches page code; nothing here carries session
 * secrets, tokens or raw file contents.
 */

function subscribe<T>(
  channel: string,
  adapt: (raw: unknown) => T | null,
  listener: (event: T) => void,
): () => void {
  const wrapped = (_event: unknown, raw: unknown): void => {
    const payload = adapt(raw);
    if (payload !== null) listener(payload);
  };
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_NAME, {
  getInfo: () => ipcRenderer.invoke(CHANNELS.getInfo),
  retryLoad: () => ipcRenderer.invoke(CHANNELS.retryLoad),
  openDownloadsFolder: () => ipcRenderer.invoke(CHANNELS.openDownloadsFolder),
  // Both directions are validated: pages only ever pass or receive the
  // two preference enums, never anything else.
  getPreferences: async () =>
    validateDesktopPreferences(
      await ipcRenderer.invoke(CHANNELS.getPreferences),
    ),
  setPreferences: async (next: unknown) => {
    const validated = validateDesktopPreferences(next);
    if (!validated) throw new Error('Rejected desktop preferences payload');
    await ipcRenderer.invoke(CHANNELS.setPreferences, validated);
  },
  onDownloadState: (listener: (event: DownloadStateEvent) => void) =>
    subscribe(CHANNELS.downloadState, validateDownloadState, listener),
});
