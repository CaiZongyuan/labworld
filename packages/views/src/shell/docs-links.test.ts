import { describe, expect, test } from 'vitest';
import { docsChapterUrl, docsHomeUrl } from './docs-links';

// Deep links resolve against the docs site base (which may carry a
// deployment sub-path): zh stays on the historical paths, en mirrors under
// /en/ — and a chapter URL never lands on the site root landing.

describe('docsHomeUrl', () => {
  test('maps each locale to its docs home', () => {
    expect(docsHomeUrl('https://docs.test', 'zh')).toBe(
      'https://docs.test/docs/',
    );
    expect(docsHomeUrl('https://docs.test', 'en')).toBe(
      'https://docs.test/en/docs/',
    );
  });

  test('adds the trailing slash a bare base needs for sub-path joins', () => {
    expect(docsHomeUrl('https://docs.test', 'zh')).toBe(
      'https://docs.test/docs/',
    );
    expect(docsHomeUrl('https://host/docs-site', 'zh')).toBe(
      'https://host/docs-site/docs/',
    );
  });
});

describe('docsChapterUrl', () => {
  test('drops the .md suffix and prefixes the en mirror', () => {
    expect(
      docsChapterUrl(
        'https://docs.test',
        'zh',
        'tutorials/appearance-language.md',
      ),
    ).toBe('https://docs.test/tutorials/appearance-language');
    expect(
      docsChapterUrl(
        'https://docs.test',
        'en',
        'tutorials/appearance-language.md',
      ),
    ).toBe('https://docs.test/en/tutorials/appearance-language');
  });

  test('respects a deployment sub-path in the base', () => {
    expect(
      docsChapterUrl('https://host/docs-site', 'en', 'tutorials/08-members'),
    ).toBe('https://host/docs-site/en/tutorials/08-members');
  });
});
