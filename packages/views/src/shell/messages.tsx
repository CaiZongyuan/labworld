import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import type { MemberRole } from '@labos-threejs/sdk';
import type { AssembledApp } from './app-contract';
import { usePreferences, type AppLocale } from './preferences';

// The message catalog assembles Core texts plus every example's namespace.
// Release checks (and the assembly point) require both locales to be
// complete; at runtime a key missing in the active locale falls back to
// English and finally to an understandable generic hint — a missing key
// never renders as a bare key and never throws (docs/ui/design.md §6 Q1).

const GENERIC_HINT: Record<AppLocale, string> = {
  zh: '这段界面文字暂不可用。',
  en: 'This interface text is unavailable.',
};

export type MessageParams = Record<string, string | number>;

// Role labels share the `roles.*` catalog namespace; total over the SDK
// role union, so a newly added role fails typecheck here instead of
// silently rendering the generic hint at runtime.
export const roleMessageKeys: Record<MemberRole, `roles.${MemberRole}`> = {
  owner: 'roles.owner',
  admin: 'roles.admin',
  member: 'roles.member',
};

function interpolate(text: string, params: MessageParams | undefined): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

type MessagesValue = {
  locale: AppLocale;
  resolve: (key: string, params?: MessageParams) => string;
};

const AppMessagesContext = createContext<MessagesValue>({
  locale: 'zh',
  resolve: (key) => key,
});

export function AppMessagesProvider({
  app,
  children,
}: {
  app: Pick<AssembledApp, 'messages'>;
  children: ReactNode;
}) {
  const { locale } = usePreferences();
  const value = useMemo<MessagesValue>(() => {
    const active = app.messages[locale] ?? {};
    const fallback = app.messages.en ?? {};
    return {
      locale,
      resolve: (key, params) => {
        const text = active[key] ?? fallback[key];
        return text === undefined
          ? GENERIC_HINT[locale]
          : interpolate(text, params);
      },
    };
  }, [app, locale]);

  // Keep the document's meta description in the active language when the
  // app declares one; apps without the key keep whatever they shipped.
  useEffect(() => {
    const description =
      app.messages[locale]['app.description'] ??
      app.messages.en['app.description'];
    if (!description) return;
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute('content', description);
  }, [app, locale]);

  return (
    <AppMessagesContext.Provider value={value}>
      {children}
    </AppMessagesContext.Provider>
  );
}

/**
 * Resolves a message key against the assembled catalog. Example pages pass
 * their example id as the namespace so keys stay in the example's own
 * vocabulary (assembly adds the prefix); Core shell code resolves
 * already-namespaced keys directly.
 */
export function useAppMessage(
  namespace?: string,
): (key: string, params?: MessageParams) => string {
  const { resolve } = useContext(AppMessagesContext);
  return (key, params) =>
    resolve(namespace ? `${namespace}.${key}` : key, params);
}
