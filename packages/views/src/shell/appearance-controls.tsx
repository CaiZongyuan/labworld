import { useAppMessage } from './messages';
import {
  usePreferences,
  type AppLocale,
  type ThemeChoice,
} from './preferences';

// Compact language and appearance controls usable before sign-in (auth
// pages) and inside the settings page. Both are real buttons with
// aria-pressed so keyboard and screen-reader behavior comes for free; the
// switching is pure state — no reload, no lost input.

// One segmented-toggle button shape for both groups: 44px touch target
// below lg, compact h-9 on desktop.
const toggleButtonClass = (selected: boolean) =>
  (selected
    ? 'bg-primary text-primary-foreground'
    : 'bg-background text-foreground') +
  ' h-11 px-3 text-sm transition-colors hover:bg-muted lg:h-9';

export function LanguageToggle() {
  const message = useAppMessage();
  const { locale, setLocale } = usePreferences();
  const options: { value: AppLocale; label: string }[] = [
    { value: 'zh', label: message('settings.language.zh') },
    { value: 'en', label: message('settings.language.en') },
  ];
  return (
    <div
      role="group"
      aria-label={message('settings.language')}
      className="inline-flex overflow-hidden rounded-md border border-border"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={locale === option.value}
          className={toggleButtonClass(locale === option.value)}
          onClick={() => setLocale(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Right-aligned toggle pair as used on the full-page identity flows; the
 * width follows the page's column (max-w-md on login/register, max-w-lg on
 * the password-reset pages).
 */
export function AuthPreferencesRow({
  className = 'w-full max-w-md',
}: {
  className?: string;
}) {
  return (
    <div className={'flex items-center justify-end gap-2 ' + className}>
      <LanguageToggle />
      <ThemeToggle />
    </div>
  );
}

export function ThemeToggle() {
  const message = useAppMessage();
  const { theme, setTheme } = usePreferences();
  const options: { value: ThemeChoice; label: string }[] = [
    { value: 'system', label: message('settings.theme.system') },
    { value: 'light', label: message('settings.theme.light') },
    { value: 'dark', label: message('settings.theme.dark') },
  ];
  return (
    <div
      role="group"
      aria-label={message('settings.theme')}
      className="inline-flex overflow-hidden rounded-md border border-border"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={theme === option.value}
          className={toggleButtonClass(theme === option.value)}
          onClick={() => setTheme(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
