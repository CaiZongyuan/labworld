import { describe, expect, it } from 'vitest';
import {
  CHANNELS,
  DEEP_LINK_SCHEME,
  DESKTOP_BRIDGE_NAME,
  isBrowserHandoffAllowed,
  normalizeDeepLinkPath,
  parseDeepLink,
  sanitizeDownloadFilename,
  validateDesktopPreferences,
  validateDownloadState,
  type DesktopBridge,
  type DesktopPreferences,
  type DownloadStateEvent,
} from './ipc-contract';

describe('desktop IPC contract', () => {
  it('keeps one stable bridge name and fixed channel set', () => {
    expect(DESKTOP_BRIDGE_NAME).toBe('labosThreejsDesktop');
    expect(Object.values(CHANNELS).sort()).toEqual([
      'desktop:download-state',
      'desktop:get-info',
      'desktop:get-preferences',
      'desktop:open-downloads-folder',
      'desktop:retry-load',
      'desktop:set-preferences',
    ]);
  });

  it('describes a bridge without secret material', () => {
    const bridge: DesktopBridge = {
      getInfo: () => Promise.resolve({ version: '0', platform: 'test' }),
      retryLoad: () => Promise.resolve(),
      openDownloadsFolder: () => Promise.resolve(),
      getPreferences: () => Promise.resolve(null),
      setPreferences: () => Promise.resolve(),
      onDownloadState: () => () => {},
    };
    expect(Object.keys(bridge).sort()).toEqual([
      'getInfo',
      'getPreferences',
      'onDownloadState',
      'openDownloadsFolder',
      'retryLoad',
      'setPreferences',
    ]);
  });
});

describe('normalizeDeepLinkPath', () => {
  it('accepts in-app absolute paths with queries', () => {
    expect(normalizeDeepLinkPath('/documents/abc')).toBe('/documents/abc');
    expect(normalizeDeepLinkPath('/reset-password?token=abc')).toBe(
      '/reset-password?token=abc',
    );
  });

  it('rejects external origins, protocol-relative paths and schemes', () => {
    expect(normalizeDeepLinkPath('https://evil.example/path')).toBeNull();
    expect(normalizeDeepLinkPath('//evil.example/path')).toBeNull();
    expect(normalizeDeepLinkPath('/\\evil.example')).toBeNull();
    expect(normalizeDeepLinkPath('javascript:alert(1)')).toBeNull();
    expect(normalizeDeepLinkPath('data:text/html,x')).toBeNull();
  });

  it('rejects malformed and oversized paths', () => {
    expect(normalizeDeepLinkPath('')).toBeNull();
    expect(normalizeDeepLinkPath('documents/abc')).toBeNull();
    expect(normalizeDeepLinkPath('/ escape space')).toBeNull();
    expect(normalizeDeepLinkPath(`/${'a'.repeat(2048)}`)).toBeNull();
  });
});

describe('parseDeepLink', () => {
  it('accepts the registered open protocol and extracts the in-app path', () => {
    expect(DEEP_LINK_SCHEME).toBe('labos-threejs');
    expect(parseDeepLink('labos-threejs://open/documents/abc')).toBe(
      '/documents/abc',
    );
    expect(parseDeepLink('labos-threejs://open/notifications?after=1')).toBe(
      '/notifications?after=1',
    );
  });

  it('rejects other hosts, protocols and external targets', () => {
    expect(parseDeepLink('labos-threejs://close/documents')).toBeNull();
    expect(parseDeepLink('https://open/documents')).toBeNull();
    expect(parseDeepLink('labos-threejs://open//evil.example')).toBeNull();
    expect(parseDeepLink('labos-threejs://open/\\evil.example')).toBeNull();
    expect(parseDeepLink('labos_threejs://open/documents')).toBeNull();
    expect(parseDeepLink('not a url')).toBeNull();
  });
});

describe('sanitizeDownloadFilename', () => {
  it('keeps ordinary file names', () => {
    expect(sanitizeDownloadFilename('文档 手册 v2.pdf')).toBe(
      '文档 手册 v2.pdf',
    );
  });

  it('strips path separators, traversal and control characters', () => {
    expect(sanitizeDownloadFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeDownloadFilename('..\\win\\path.txt')).toBe('path.txt');
    expect(sanitizeDownloadFilename('bad\nname\t.txt')).toBe('badname.txt');
    expect(sanitizeDownloadFilename('')).toBe('download');
    expect(sanitizeDownloadFilename('.')).toBe('download');
  });

  it('bounds the stored length', () => {
    const long = sanitizeDownloadFilename(`${'名'.repeat(300)}.txt`);
    expect(long.length).toBeLessThanOrEqual(128);
    expect(long.endsWith('.txt')).toBe(true);
  });
});

describe('isBrowserHandoffAllowed', () => {
  it('accepts http(s) targets only', () => {
    expect(isBrowserHandoffAllowed('https://portal.example/page')).toBe(true);
    expect(isBrowserHandoffAllowed('http://portal.example/')).toBe(true);
    expect(isBrowserHandoffAllowed('file:///etc/os-release')).toBe(false);
    expect(isBrowserHandoffAllowed('chrome://version')).toBe(false);
    expect(isBrowserHandoffAllowed('ftp://x.example/y')).toBe(false);
    expect(isBrowserHandoffAllowed('javascript:void 0')).toBe(false);
    expect(isBrowserHandoffAllowed('not a url')).toBe(false);
  });
});

describe('validateDesktopPreferences', () => {
  it('accepts exactly the language and theme enums', () => {
    const valid: DesktopPreferences = { locale: 'zh', theme: 'system' };
    expect(validateDesktopPreferences(valid)).toEqual(valid);
    expect(validateDesktopPreferences({ locale: 'en', theme: 'dark' })).toEqual(
      { locale: 'en', theme: 'dark' },
    );
    expect(
      validateDesktopPreferences({ locale: 'en', theme: 'light' }),
    ).toEqual({ locale: 'en', theme: 'light' });
    expect(
      validateDesktopPreferences({ locale: 'zh', theme: 'light' }),
    ).toEqual({ locale: 'zh', theme: 'light' });
  });

  it('rejects values outside the enums and malformed payloads', () => {
    expect(validateDesktopPreferences(null)).toBeNull();
    expect(validateDesktopPreferences('zh')).toBeNull();
    expect(
      validateDesktopPreferences({ locale: 'fr', theme: 'dark' }),
    ).toBeNull();
    expect(
      validateDesktopPreferences({ locale: 'zh', theme: 'blue' }),
    ).toBeNull();
    expect(validateDesktopPreferences({ locale: 'zh' })).toBeNull();
    expect(validateDesktopPreferences({ theme: 'dark' })).toBeNull();
    expect(
      validateDesktopPreferences({ locale: 'zh', theme: 'dark', extra: 1 }),
    ).toBeNull();
  });
});

describe('validateDownloadState', () => {
  const valid: DownloadStateEvent = {
    id: 'd1',
    filename: 'a.zip',
    phase: 'progress',
    receivedBytes: 10,
    totalBytes: 20,
  };

  it('accepts well-formed events', () => {
    expect(validateDownloadState(valid)).toEqual(valid);
    expect(
      validateDownloadState({ ...valid, phase: 'failed', totalBytes: null }),
    ).toEqual({ ...valid, phase: 'failed', totalBytes: null });
  });

  it('rejects malformed or oversized payloads', () => {
    expect(validateDownloadState(null)).toBeNull();
    expect(validateDownloadState({ ...valid, phase: 'other' })).toBeNull();
    expect(validateDownloadState({ ...valid, receivedBytes: -1 })).toBeNull();
    expect(
      validateDownloadState({ ...valid, receivedBytes: 21, totalBytes: 20 }),
    ).toBeNull();
    expect(validateDownloadState({ ...valid, id: 'x'.repeat(200) })).toBeNull();
    expect(
      validateDownloadState({ ...valid, filename: '../escape.zip' }),
    ).toBeNull();
  });
});
