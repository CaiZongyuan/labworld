import { renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';
import { PreferencesProvider } from './preferences';
import { useAppFormat } from './format';

// The locale formatters pin the tag the current preference resolves to;
// exact rendered shapes stay the platform's Intl job. Device detection is
// covered by the preferences suite — here each case states its choice.

test('formats follow the active locale (zh)', () => {
  window.localStorage.setItem('labos-threejs.locale', 'zh');
  const { result } = renderHook(() => useAppFormat(), {
    wrapper: PreferencesProvider,
  });
  expect(result.current.locale).toBe('zh');
  expect(result.current.formatNumber(1234.5)).toBe('1,234.5');
  expect(result.current.formatDateTime('2026-09-28T00:30:00Z')).toMatch(/2026/);
});

test('formats follow the active locale (en)', () => {
  window.localStorage.setItem('labos-threejs.locale', 'en');
  const { result } = renderHook(() => useAppFormat(), {
    wrapper: PreferencesProvider,
  });
  expect(result.current.locale).toBe('en');
  expect(result.current.formatNumber(1234.5)).toBe('1,234.5');
  expect(result.current.formatDateTime('2026-09-28T00:30:00Z')).toMatch(/2026/);
});
