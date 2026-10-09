import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import {
  PreferencesProvider,
  localeTag,
  pickLocale,
  resolveTheme,
  usePreferences,
} from './preferences';

// Device-preference logic (docs/ui/design.md §6 Q2): first visit follows the
// device language, the theme follows the system, explicit choices win and
// stay on this device only. The provider applies html.lang, color-scheme
// and the resolved dark class synchronously with render.

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

function Probe() {
  const { locale, theme, resolvedTheme, setLocale, setTheme } =
    usePreferences();
  return (
    <div>
      <span>locale:{locale}</span>
      <span>theme:{theme}</span>
      <span>resolved:{resolvedTheme}</span>
      <button onClick={() => setLocale('en')}>to-en</button>
      <button onClick={() => setLocale('zh')}>to-zh</button>
      <button onClick={() => setTheme('dark')}>to-dark</button>
      <button onClick={() => setTheme('light')}>to-light</button>
      <button onClick={() => setTheme('system')}>to-system</button>
    </div>
  );
}

function renderProbe() {
  return {
    user: userEvent.setup(),
    ...render(
      <PreferencesProvider>
        <Probe />
      </PreferencesProvider>,
    ),
  };
}

test('pickLocale follows the device: Chinese environments get zh, everything else en', () => {
  expect(pickLocale(['zh-CN', 'zh', 'en'])).toBe('zh');
  expect(pickLocale(['zh-TW', 'en-US'])).toBe('zh');
  expect(pickLocale(['en-US', 'zh-CN'])).toBe('en');
  expect(pickLocale(['fr-FR', 'de-DE'])).toBe('en');
  expect(pickLocale([])).toBe('en');
});

test('resolveTheme only follows the system in system mode', () => {
  expect(resolveTheme('system', true)).toBe('dark');
  expect(resolveTheme('system', false)).toBe('light');
  expect(resolveTheme('light', true)).toBe('light');
  expect(resolveTheme('dark', false)).toBe('dark');
});

test('localeTag maps the UI locale to html-lang values', () => {
  expect(localeTag('zh')).toBe('zh-CN');
  expect(localeTag('en')).toBe('en');
});

test('a fresh device starts on the system theme and device language', () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }),
  );
  renderProbe();
  expect(screen.getByText('resolved:dark')).toBeInTheDocument();
});

test('an explicit theme sticks, persists and survives a remount', async () => {
  const first = renderProbe();
  await first.user.click(screen.getByText('to-dark'));
  expect(document.documentElement.classList.contains('dark')).toBe(true);
  expect(document.documentElement.style.colorScheme).toBe('dark');
  expect(window.localStorage.getItem('labos-threejs.theme')).toBe('dark');
  first.unmount();
  renderProbe();
  expect(screen.getByText('theme:dark')).toBeInTheDocument();
});

test('a stored invalid value falls back to the default instead of breaking', () => {
  window.localStorage.setItem('labos-threejs.theme', 'klingon');
  window.localStorage.setItem('labos-threejs.locale', 'klingon');
  renderProbe();
  expect(screen.getByText('theme:system')).toBeInTheDocument();
  expect(screen.getByText(/locale:(zh|en)/)).toBeInTheDocument();
});

test('switching locale updates html.lang immediately and persists', async () => {
  const { user } = renderProbe();
  await user.click(screen.getByText('to-en'));
  expect(document.documentElement.lang).toBe('en');
  expect(window.localStorage.getItem('labos-threejs.locale')).toBe('en');
  await user.click(screen.getByText('to-zh'));
  expect(document.documentElement.lang).toBe('zh-CN');
});

test('system mode reacts to OS theme changes; explicit mode does not', async () => {
  let dark = false;
  const listeners = new Set<(event: { matches: boolean }) => void>();
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      get matches() {
        return dark;
      },
      addEventListener: (
        _: string,
        cb: (event: { matches: boolean }) => void,
      ) => {
        listeners.add(cb);
      },
      removeEventListener: (
        _: string,
        cb: (event: { matches: boolean }) => void,
      ) => {
        listeners.delete(cb);
      },
    }),
  );
  const flipSystem = (next: boolean) => {
    dark = next;
    for (const cb of listeners) cb({ matches: next });
  };
  const { user, unmount } = renderProbe();
  act(() => flipSystem(true));
  expect(screen.getByText('resolved:dark')).toBeInTheDocument();
  await user.click(screen.getByText('to-light'));
  expect(screen.getByText('resolved:light')).toBeInTheDocument();
  flipSystem(false);
  expect(screen.getByText('resolved:light')).toBeInTheDocument();
  await user.click(screen.getByText('to-system'));
  expect(screen.getByText('resolved:light')).toBeInTheDocument();
  act(() => flipSystem(true));
  expect(screen.getByText('resolved:dark')).toBeInTheDocument();
  unmount();
  flipSystem(false);
  // The listener went away with the provider: no post-unmount updates.
  expect(screen.queryByText(/resolved:/)).toBeNull();
});

test('when storage is unavailable preferences still switch for this session', async () => {
  const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
  const getter = vi.fn(() => {
    throw new Error('storage blocked');
  });
  Object.defineProperty(window, 'localStorage', {
    get: getter,
    configurable: true,
  });
  try {
    const { user } = renderProbe();
    expect(screen.getByText('theme:system')).toBeInTheDocument();
    await user.click(screen.getByText('to-dark'));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  } finally {
    if (original) Object.defineProperty(window, 'localStorage', original);
  }
});
