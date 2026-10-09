import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

// Language and appearance preferences (docs/ui/design.md §6 Q2): the first
// visit follows the device, explicit choices win and stay on this device
// only. The provider applies html.lang, color-scheme and the resolved dark
// class on every change, and only `system` mode keeps following the OS. An
// index.html inline script applies the same resolution before first paint;
// everything here is idempotent so the handover is invisible.

export type AppLocale = 'zh' | 'en';
export type ThemeChoice = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const LOCALE_STORAGE_KEY = 'labos-threejs.locale';
export const THEME_STORAGE_KEY = 'labos-threejs.theme';

export function localeTag(locale: AppLocale): string {
  return locale === 'zh' ? 'zh-CN' : 'en';
}

// The device's language list is honored in order: the first Chinese or
// English entry decides; anything else falls back to en.
export function pickLocale(candidates: readonly string[]): AppLocale {
  for (const tag of candidates) {
    if (/^zh/i.test(tag)) return 'zh';
    if (/^en/i.test(tag)) return 'en';
  }
  return 'en';
}

export function resolveTheme(
  choice: ThemeChoice,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (choice === 'system') return systemPrefersDark ? 'dark' : 'light';
  return choice;
}

function readStoredChoice<T extends string>(
  key: string,
  valid: readonly T[],
): T | undefined {
  try {
    const value = window.localStorage.getItem(key);
    return valid.includes(value as T) ? (value as T) : undefined;
  } catch {
    // Storage unavailable (blocked or private mode): fall back to defaults.
    return undefined;
  }
}

function writeStoredChoice(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The choice still holds for this session even when it cannot persist.
  }
}

const systemPrefersDarkNow = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches;

export type PreferencesValue = {
  locale: AppLocale;
  theme: ThemeChoice;
  resolvedTheme: ResolvedTheme;
  setLocale: (locale: AppLocale) => void;
  setTheme: (theme: ThemeChoice) => void;
};

const PreferencesContext = createContext<PreferencesValue | null>(null);

// A reset-email link carries its own language hint (docs/ui/design.md
// §6 Q8). While a flow locale is set, the whole preference surface —
// rendered text, html.lang, formatting — resolves to it, but the saved
// choice stays untouched; the first language the user picks themselves
// ends the override through the normal setLocale rules.
const FlowLocaleSetterContext = createContext<
  ((locale: AppLocale | undefined) => void) | null
>(null);

function applyPreferences(locale: AppLocale, resolved: ResolvedTheme) {
  const root = document.documentElement;
  root.lang = localeTag(locale);
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>(
    () =>
      readStoredChoice(LOCALE_STORAGE_KEY, ['zh', 'en']) ??
      pickLocale(window.navigator.languages ?? [window.navigator.language]),
  );
  const [theme, setThemeState] = useState<ThemeChoice>(
    () =>
      readStoredChoice(THEME_STORAGE_KEY, ['system', 'light', 'dark']) ??
      'system',
  );
  const [systemPrefersDark, setSystemPrefersDark] =
    useState(systemPrefersDarkNow);
  // The flow override (the reset link's language hint) resolves here so
  // the applyPreferences effect below stays the single writer of
  // html.lang; a child effect would lose the mount-order race against it.
  const [flowLocale, setFlowLocale] = useState<AppLocale>();

  // Only system mode follows OS changes — and the subscription exists
  // exactly while the provider is mounted, never after.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) =>
      setSystemPrefersDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const resolvedTheme = resolveTheme(theme, systemPrefersDark);
  const effectiveLocale = flowLocale ?? locale;

  useEffect(() => {
    applyPreferences(effectiveLocale, resolvedTheme);
  }, [effectiveLocale, resolvedTheme]);

  const setLocale = useCallback((next: AppLocale) => {
    // An explicit pick ends any flow override and persists as usual.
    setFlowLocale(undefined);
    setLocaleState(next);
    writeStoredChoice(LOCALE_STORAGE_KEY, next);
  }, []);
  const setTheme = useCallback((next: ThemeChoice) => {
    setThemeState(next);
    writeStoredChoice(THEME_STORAGE_KEY, next);
  }, []);

  const value = useMemo(
    () => ({
      locale: effectiveLocale,
      theme,
      resolvedTheme,
      setLocale,
      setTheme,
    }),
    [effectiveLocale, theme, resolvedTheme, setLocale, setTheme],
  );
  return (
    <FlowLocaleSetterContext.Provider value={setFlowLocale}>
      <PreferencesContext.Provider value={value}>
        {children}
      </PreferencesContext.Provider>
    </FlowLocaleSetterContext.Provider>
  );
}

export function usePreferences(): PreferencesValue {
  const value = useContext(PreferencesContext);
  if (!value)
    throw new Error('usePreferences used outside PreferencesProvider');
  return value;
}

/**
 * Route-scoped override for a flow that arrived with its own language
 * (the reset link's hint). Set it on mount with the link's language and
 * clear it on unmount; every consumer of usePreferences above follows
 * until the user picks a language themselves.
 */
export function useFlowLocaleSetter() {
  const setFlowLocale = useContext(FlowLocaleSetterContext);
  if (!setFlowLocale)
    throw new Error('useFlowLocaleSetter used outside PreferencesProvider');
  return setFlowLocale;
}
