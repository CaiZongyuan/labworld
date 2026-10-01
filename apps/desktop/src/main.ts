import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  app,
  BrowserWindow,
  ipcMain,
  session,
  shell,
  type Session,
  type WebContents,
} from 'electron';
import {
  CHANNELS,
  DEEP_LINK_SCHEME,
  isBrowserHandoffAllowed,
  parseDeepLink,
  sanitizeDownloadFilename,
  validateDesktopPreferences,
  validateDownloadState,
  type DesktopPreferences,
  type DownloadPhase,
} from './ipc-contract';

/**
 * Electron shell around the same-origin web entry. The shell owns window
 * lifecycle, navigation limits, downloads and deep links only: business
 * surfaces come from the shared views inside the loaded web entry, and the
 * session cookie never leaves the renderer's partition.
 */

const SESSION_PARTITION = 'persist:labos-threejs-desktop';
const DOWNLOAD_DIRNAME = 'LabosThreejs';
const PREFERENCES_FILENAME = 'desktop-preferences.json';

/**
 * The desktop look lives in a two-enum JSON file inside the profile. The
 * local error page loads from a file:// origin and cannot read the app's
 * localStorage, so the app mirrors its language and theme choice here over
 * the narrow preference channels; nothing but the two enums is stored.
 */
let preferencesFile = '';

function readPreferences(): DesktopPreferences | null {
  try {
    return validateDesktopPreferences(
      JSON.parse(readFileSync(preferencesFile, 'utf8')),
    );
  } catch {
    // A missing or malformed file falls back to device defaults.
    return null;
  }
}

function readOrigin(): URL {
  const raw =
    process.env.LABOS_THREEJS_DESKTOP_ORIGIN ?? 'http://127.0.0.1:5173';
  let origin: URL;
  try {
    origin = new URL(raw);
  } catch {
    throw new Error(`LABOS_THREEJS_DESKTOP_ORIGIN is not a URL: ${raw}`);
  }
  if (origin.protocol !== 'https:' && origin.protocol !== 'http:')
    throw new Error('LABOS_THREEJS_DESKTOP_ORIGIN must use http or https');
  if (origin.pathname !== '/' && origin.pathname !== '')
    throw new Error('LABOS_THREEJS_DESKTOP_ORIGIN must not include a path');
  return origin;
}

const appOrigin = readOrigin();
// A dedicated user-data directory keeps the session partition, caches and
// the single-instance lock out of shared machine state; the smoke and
// parallel setups rely on it.
if (process.env.LABOS_THREEJS_DESKTOP_USER_DATA_DIR)
  app.setPath('userData', process.env.LABOS_THREEJS_DESKTOP_USER_DATA_DIR);
const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};
const isAppOrigin = (url: string): boolean =>
  originOf(url) === appOrigin.origin;

/** Only http(s) targets may reach the system browser, never other schemes. */
function openExternal(raw: string): void {
  if (!isBrowserHandoffAllowed(raw)) return;
  const parsed = new URL(raw);
  // Log the host only: full URLs can carry query tokens.
  console.log(
    `[desktop] external link opens in system browser: ${parsed.host}`,
  );
  void shell.openExternal(parsed.toString()).catch((error: unknown) => {
    console.error('[desktop] external link failed to open', error);
  });
}

let appSession: Session;
let mainWindow: BrowserWindow | null = null;
/** The app URL the window should show; error/retry always returns here. */
let currentTarget = appOrigin.toString();
/** Resolved after app ready; configurable for tests and custom setups. */
let downloadsDirectory = '';

/** The main window while it still exists, or null after close/destroy. */
const liveWindow = (): BrowserWindow | null =>
  mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;

function sendToWindow(channel: string, payload: unknown): void {
  const target = liveWindow();
  if (!target) return;
  target.webContents.send(channel, payload);
}

function targetUrl(path: string): string {
  return new URL(path, appOrigin).toString();
}

function showErrorPage(): void {
  const target = liveWindow();
  if (!target) return;
  void target.loadFile(join(__dirname, 'error.html')).catch(() => {});
}

function registerWebContents(contents: WebContents): void {
  // Same-origin only: any other navigation target stays in the system browser.
  contents.on('will-navigate', (event, url) => {
    if (isAppOrigin(url)) return;
    event.preventDefault();
    openExternal(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (!isAppOrigin(url)) openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('did-fail-load', (_event, code, _desc, url, isMainFrame) => {
    // -3 (ABORTED) covers superseded loads; only real main-frame failures
    // switch to the shell error page. A failing error page itself must not
    // loop the recovery path.
    if (isMainFrame && code !== -3 && !url.startsWith('file:')) {
      console.error(`[desktop] main frame failed to load (code ${code})`);
      showErrorPage();
    }
  });
  contents.on('render-process-gone', (_event, details) => {
    console.error(`[desktop] renderer gone: ${details.reason}`);
    showErrorPage();
  });
  // Track in-app navigation so retry returns to the page the user was on;
  // the error page itself (file://) never becomes the retry target.
  contents.on('did-navigate', (_event, url) => {
    if (isAppOrigin(url)) currentTarget = url;
  });
}

function uniqueSavePath(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const suffix = dot > 0 ? filename.slice(dot) : '';
  let candidate = join(downloadsDirectory, filename);
  let counter = 1;
  while (existsSync(candidate)) {
    candidate = join(downloadsDirectory, `${stem}-${counter}${suffix}`);
    counter += 1;
  }
  return candidate;
}

function registerDownloads(): void {
  appSession.on('will-download', (_event, item, contents) => {
    // Controlled entry: downloads must be started by an app-origin page,
    // which covers the shared views' blob transfers and rejects the rest.
    if (!isAppOrigin(contents.getURL())) {
      item.cancel();
      return;
    }
    const id = randomUUID();
    const filename = sanitizeDownloadFilename(item.getFilename());
    item.setSavePath(uniqueSavePath(filename));
    const emit = (phase: DownloadPhase) => {
      const payload = validateDownloadState({
        id,
        filename,
        phase,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes() > 0 ? item.getTotalBytes() : null,
      });
      if (payload) sendToWindow(CHANNELS.downloadState, payload);
    };
    emit('started');
    item.on('updated', (_e, state) => {
      emit(state === 'interrupted' ? 'failed' : 'progress');
    });
    item.once('done', (_e, state) => {
      if (state === 'completed')
        console.log(`[desktop] download saved: ${filename}`);
      emit(
        state === 'completed'
          ? 'completed'
          : state === 'cancelled'
            ? 'cancelled'
            : 'failed',
      );
    });
  });
}

function focusOrCreate(path: string): void {
  const existing = liveWindow();
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    currentTarget = targetUrl(path);
    void existing.loadURL(currentTarget).catch(() => showErrorPage());
    return;
  }
  createWindow(path);
}

function createWindow(path: string): void {
  currentTarget = targetUrl(path);
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    title: 'Lab Word',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      session: appSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  mainWindow.once('ready-to-show', () => void mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  registerWebContents(mainWindow.webContents);
  void mainWindow.loadURL(currentTarget).catch(() => showErrorPage());
}

function handleDeepLink(raw: string): void {
  const path = parseDeepLink(raw);
  // Invalid or external deep links are ignored without logging the target.
  if (!path) {
    console.warn('[desktop] ignored deep link with unexpected shape');
    return;
  }
  focusOrCreate(path);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const link = argv.find((argument) => parseDeepLink(argument) !== null);
    if (link) handleDeepLink(link);
    else liveWindow()?.focus();
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  ipcMain.handle(CHANNELS.getInfo, () => ({
    version: app.getVersion(),
    platform: process.platform,
  }));
  ipcMain.handle(CHANNELS.retryLoad, () => {
    const target = liveWindow();
    if (!target) return;
    void target.loadURL(currentTarget).catch(() => showErrorPage());
  });
  ipcMain.handle(CHANNELS.openDownloadsFolder, () =>
    shell.openPath(downloadsDirectory),
  );
  ipcMain.handle(CHANNELS.getPreferences, () => readPreferences());
  ipcMain.handle(CHANNELS.setPreferences, (_event, raw: unknown) => {
    const next = validateDesktopPreferences(raw);
    if (!next) throw new Error('Rejected desktop preferences payload');
    writeFileSync(preferencesFile, JSON.stringify(next));
  });

  void app.whenReady().then(() => {
    downloadsDirectory =
      process.env.LABOS_THREEJS_DESKTOP_DOWNLOADS_DIR ??
      join(app.getPath('downloads'), DOWNLOAD_DIRNAME);
    mkdirSync(downloadsDirectory, { recursive: true });
    preferencesFile = join(app.getPath('userData'), PREFERENCES_FILENAME);
    appSession = session.fromPartition(SESSION_PARTITION);
    appSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    appSession.setPermissionCheckHandler(() => false);
    registerDownloads();
    try {
      app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
    } catch {
      // Protocol registration is best-effort on developer machines; the
      // second-instance path keeps deep links working regardless.
    }
    createWindow('/');
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow('/');
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
