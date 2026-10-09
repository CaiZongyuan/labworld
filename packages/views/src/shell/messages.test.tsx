import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';
import { AppMessagesProvider, useAppMessage } from './messages';
import { PreferencesProvider, usePreferences } from './preferences';

function LocaleFlip() {
  const { locale, setLocale } = usePreferences();
  return (
    <button onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}>
      flip
    </button>
  );
}

function Text({ namespace, k }: { namespace?: string; k: string }) {
  return <>{useAppMessage(namespace)(k)}</>;
}

const app = {
  messages: {
    zh: { 'notes.page.title': '便签示例页' },
    en: { 'notes.page.title': 'Notes example page' },
  },
};

test('resolves a namespaced example key in the active locale', () => {
  // The device language in the test browser is en; pin zh for this check.
  window.localStorage.setItem('labos-threejs.locale', 'zh');
  render(
    <PreferencesProvider>
      <AppMessagesProvider app={app}>
        <Text namespace="notes" k="page.title" />
      </AppMessagesProvider>
    </PreferencesProvider>,
  );
  expect(screen.getByText('便签示例页')).toBeInTheDocument();
});

test('switching the preference locale re-resolves the same key without a remount', async () => {
  window.localStorage.setItem('labos-threejs.locale', 'zh');
  const user = userEvent.setup();
  render(
    <PreferencesProvider>
      <AppMessagesProvider app={app}>
        <Text namespace="notes" k="page.title" />
        <LocaleFlip />
      </AppMessagesProvider>
    </PreferencesProvider>,
  );
  expect(screen.getByText('便签示例页')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'flip' }));
  expect(screen.getByText('Notes example page')).toBeInTheDocument();
});

test('a key missing in the active locale falls back to English', () => {
  const partial = {
    messages: {
      zh: {},
      en: { 'notes.page.title': 'Notes example page' },
    },
  };
  render(
    <PreferencesProvider>
      <AppMessagesProvider app={partial}>
        <Text namespace="notes" k="page.title" />
      </AppMessagesProvider>
    </PreferencesProvider>,
  );
  expect(screen.getByText('Notes example page')).toBeInTheDocument();
});

test('a key missing everywhere shows an understandable hint, never a bare key', () => {
  render(
    <PreferencesProvider>
      <AppMessagesProvider app={{ messages: { zh: {}, en: {} } }}>
        <Text namespace="notes" k="page.title" />
      </AppMessagesProvider>
    </PreferencesProvider>,
  );
  expect(screen.queryByText('notes.page.title')).toBeNull();
  expect(screen.getByText(/.+/).textContent?.length).toBeGreaterThan(0);
  // The generic hint is a sentence, not a key: it carries no dots from the
  // missing namespace path.
  expect(screen.getByText(/.+/).textContent).not.toMatch(/notes\.page/);
});
