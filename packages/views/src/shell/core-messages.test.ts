import { describe, expect, test } from 'vitest';
import { coreMessages } from './core-messages';

// Release check for Core's own catalog: every key exists in both locales
// and no entry is empty (docs/ui/design.md §6 Q1 — 中英文消息完整).
// Example catalogs get the same guarantee from assembleApp validation.

describe('coreMessages', () => {
  test('zh and en declare exactly the same keys', () => {
    expect(Object.keys(coreMessages.zh).sort()).toEqual(
      Object.keys(coreMessages.en).sort(),
    );
  });

  test('no entry is empty and no value leaks a raw key', () => {
    for (const [locale, catalog] of Object.entries(coreMessages))
      for (const [key, text] of Object.entries(catalog)) {
        expect(text.trim(), `${locale}/${key}`).not.toBe('');
        expect(text.includes(key), `${locale}/${key}`).toBe(false);
      }
  });

  test('interpolation placeholders agree across locales', () => {
    const placeholder = (text: string) =>
      [...text.matchAll(/\{(\w+)\}/g)]
        .map((m) => m[1])
        .sort()
        .join(',');
    for (const key of Object.keys(coreMessages.zh))
      expect(placeholder(coreMessages.en[key]), key).toBe(
        placeholder(coreMessages.zh[key]),
      );
  });
});
