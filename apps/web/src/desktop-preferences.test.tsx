import { PreferencesProvider, usePreferences } from '@labos-threejs/views';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { DesktopPreferencesMirror } from './desktop-preferences';

// The desktop shell's local error page cannot read this origin's
// localStorage, so the app mirrors the two appearance enums to the narrow
// shell bridge on every change (docs/tutorials/20-electron-shell.md §2).
// In a plain browser there is no bridge and the mirror is a no-op.

type ShellPreferences = { locale: string; theme: string };

function setBridge(
  bridge: {
    setPreferences: (next: ShellPreferences) => Promise<void>;
  } | null,
) {
  const holder = window as typeof window & { labosThreejsDesktop?: unknown };
  if (bridge) holder.labosThreejsDesktop = bridge;
  else delete holder.labosThreejsDesktop;
}

afterEach(() => setBridge(null));

function ChangeButtons() {
  const { setLocale, setTheme } = usePreferences();
  return (
    <>
      <button onClick={() => setLocale('en')}>to English</button>
      <button onClick={() => setTheme('dark')}>to dark</button>
    </>
  );
}

function mountMirror() {
  return render(
    <PreferencesProvider>
      <DesktopPreferencesMirror />
      <ChangeButtons />
    </PreferencesProvider>,
  );
}

test('mirrors the current choice and later changes to the shell', async () => {
  const setPreferences = vi.fn<(next: ShellPreferences) => Promise<void>>(() =>
    Promise.resolve(),
  );
  setBridge({ setPreferences });
  const view = mountMirror();
  const user = userEvent.setup();
  // The mounted choice reaches the shell once...
  await vi.waitFor(() =>
    expect(setPreferences).toHaveBeenCalledWith({
      locale: 'zh',
      theme: 'system',
    }),
  );
  // ...and every later change is mirrored with both enums.
  await user.click(screen.getByRole('button', { name: 'to English' }));
  await user.click(screen.getByRole('button', { name: 'to dark' }));
  await vi.waitFor(() =>
    expect(setPreferences).toHaveBeenLastCalledWith({
      locale: 'en',
      theme: 'dark',
    }),
  );
  view.unmount();
});

test('stays a no-op outside the desktop shell', async () => {
  setBridge(null);
  const view = mountMirror();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'to dark' }));
  // Without the bridge there is nothing to mirror into; the click above
  // passing without an error is the assertion.
  expect(
    (window as typeof window & { labosThreejsDesktop?: unknown })
      .labosThreejsDesktop,
  ).toBeUndefined();
  view.unmount();
});

test('keeps the app working when the shell rejects the mirror', async () => {
  const setPreferences = vi.fn<(next: ShellPreferences) => Promise<void>>(() =>
    Promise.reject(new Error('rejected by shell')),
  );
  setBridge({ setPreferences });
  mountMirror();
  // The rejection is swallowed by the mirror: an unhandled rejection
  // would fail this run.
  await vi.waitFor(() => expect(setPreferences).toHaveBeenCalled());
});
