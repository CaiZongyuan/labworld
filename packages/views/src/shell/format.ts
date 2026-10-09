import { useMemo } from 'react';
import { localeTag, usePreferences } from './preferences';

// Dates and numbers render with the current language's Intl formats; the
// timezone stays the device's own (docs/ui/design.md §6 Q1).

export function useAppFormat() {
  const { locale } = usePreferences();
  return useMemo(() => {
    const tag = localeTag(locale);
    return {
      locale,
      formatDateTime: (value: string | number | Date) =>
        new Intl.DateTimeFormat(tag, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(value)),
      formatNumber: (value: number) => new Intl.NumberFormat(tag).format(value),
    };
  }, [locale]);
}
