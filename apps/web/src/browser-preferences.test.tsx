import { PreferencesProvider, usePreferences } from '@labos-threejs/views';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';
import { DesktopPreferencesMirror } from './desktop-preferences';
function BrowserChoice() {
  const { theme, setTheme } = usePreferences();
  return (
    <>
      <button onClick={() => setTheme('dark')}>to dark</button>
      <output aria-label="chosen theme">{theme}</output>
    </>
  );
}
test('changes browser appearance without a shell bridge', async () => {
  const holder = window as typeof window & { labosThreejsDesktop?: unknown };
  delete holder.labosThreejsDesktop;
  const view = render(
    <PreferencesProvider>
      <DesktopPreferencesMirror />
      <BrowserChoice />
    </PreferencesProvider>,
  );
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'to dark' }));
  expect(screen.getByLabelText('chosen theme')).toHaveTextContent('dark');
  expect(holder.labosThreejsDesktop).toBeUndefined();
  view.unmount();
});
