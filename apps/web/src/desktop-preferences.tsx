import { usePreferences } from '@labos-threejs/views';
import { useEffect } from 'react';

/**
 * Platform adapter for the desktop shell (docs/ui/design.md §6): the
 * shell's local error page loads from a file:// origin and cannot read
 * this app's localStorage, so the current language and theme choice is
 * mirrored to the narrow shell bridge. In a plain browser there is no
 * bridge and this component does nothing. Only the two enums cross the
 * boundary — never session, credentials or business objects.
 */

type ShellBridge = {
  setPreferences(next: {
    locale: 'zh' | 'en';
    theme: 'system' | 'light' | 'dark';
  }): Promise<void>;
};

// Same bridge name as the shell's public contract (apps/desktop/src/
// ipc-contract.ts); the structural type keeps the app independent of the
// desktop package.
function shellBridge(): ShellBridge | null {
  const candidate = (globalThis as { labosThreejsDesktop?: unknown })
    .labosThreejsDesktop;
  if (
    candidate &&
    typeof candidate === 'object' &&
    typeof (candidate as ShellBridge).setPreferences === 'function'
  )
    return candidate as ShellBridge;
  return null;
}

export function DesktopPreferencesMirror() {
  const { locale, theme } = usePreferences();
  useEffect(() => {
    const bridge = shellBridge();
    if (!bridge) return;
    bridge.setPreferences({ locale, theme }).catch(() => {
      // Mirroring is best-effort; the app keeps working without it.
    });
  }, [locale, theme]);
  return null;
}
