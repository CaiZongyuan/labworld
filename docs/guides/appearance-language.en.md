# Appearance And Language

Goal: switch Lab Word language and appearance and verify device preferences persist. Start the application with [quick start](../getting-started/quickstart.md)first.

## Operation And Result

1. Use the topbar language action to choose Simplified Chinese or English. Interface text and page title should update together.
2. Choose system, light or dark appearance. System mode follows operating-system changes.
3. Open settings from the account entry at the lower left to change the same preferences.
4. Refresh and confirm explicit choices persist. Narrow screens expose the relevant entries through navigation.

Preferences stay on this device and do not change permissions or business data. Browsers do not synchronize automatically. Disabled storage or cleared site data restores device defaults.

## Development And Validation

[Preferences](../../packages/views/src/shell/preferences.tsx)owns state/storage and [Settings](../../packages/views/src/shell/settings-view.tsx)provides controls. [core-messages.ts](../../packages/views/src/shell/core-messages.ts)owns translations; shared tokens come from `packages/ui/src/styles.css`.

Run from the repository root:

```bash
pnpm exec vitest run apps/web/src/settings.test.tsx apps/web/src/desktop-preferences.test.tsx
```

Component checks observe choices and persistence. Verify the Electron bridge and real system appearance in their respective journeys. The documentation site has its own controls and preserves the current chapter across languages.
