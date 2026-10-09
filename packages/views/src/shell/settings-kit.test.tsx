/** Settings kit 布局原语：anchor、宽度档位、范围徽章与 plain 卡片。 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  SETTINGS_ANCHOR_ATTR,
  SettingsCard,
  SettingsRow,
  SettingsScopeBadge,
  SettingsSection,
  SettingsTab,
} from './settings-kit';

describe('SettingsTab', () => {
  it('renders the page heading with its description and action slot', () => {
    const markup = renderToStaticMarkup(
      <SettingsTab
        title="Settings"
        description="Preferences on this device."
        actions={<button type="button">Reset</button>}
      >
        <p>body</p>
      </SettingsTab>,
    );
    expect(markup).toContain('<h1');
    expect(markup).toContain('Settings');
    expect(markup).toContain('Preferences on this device.');
    expect(markup).toContain('<button');
    expect(markup).toContain('body');
  });
});

describe('SettingsSection', () => {
  it('marks the anchor for deep links and names the section', () => {
    const markup = renderToStaticMarkup(
      <SettingsSection title="Appearance" anchor="appearance">
        <p>rows</p>
      </SettingsSection>,
    );
    expect(markup).toContain(`${SETTINGS_ANCHOR_ATTR}="appearance"`);
    expect(markup).toContain('aria-labelledby');
    expect(markup).toContain('<h3');
    expect(markup).toContain('Appearance');
  });

  it('attaches the scope badge next to the title', () => {
    const markup = renderToStaticMarkup(
      <SettingsSection
        title="Appearance"
        scope="device"
        scopeLabel="This device"
      >
        <p>rows</p>
      </SettingsSection>,
    );
    expect(markup).toContain('data-slot="settings-scope"');
    expect(markup).toContain('This device');
  });

  it('renders without a heading when only rows are given', () => {
    const markup = renderToStaticMarkup(
      <SettingsSection anchor="bare">
        <p>rows</p>
      </SettingsSection>,
    );
    expect(markup).not.toContain('<h3');
    expect(markup).toContain('rows');
  });
});

describe('SettingsScopeBadge', () => {
  it('distinguishes device from account scope with icon and text', () => {
    const device = renderToStaticMarkup(
      <SettingsScopeBadge scope="device" label="This device" />,
    );
    const account = renderToStaticMarkup(
      <SettingsScopeBadge scope="account" label="Account" />,
    );
    expect(device).toContain('data-slot="settings-scope"');
    expect(device).toContain('This device');
    expect(account).toContain('Account');
    expect(device).not.toEqual(account);
  });
});

describe('SettingsRow', () => {
  it('pairs a label and description with its control', () => {
    const markup = renderToStaticMarkup(
      <SettingsRow label="Theme" description="Applies instantly.">
        <input type="radio" />
      </SettingsRow>,
    );
    expect(markup).toContain('Theme');
    expect(markup).toContain('Applies instantly.');
    expect(markup).toContain('<input');
  });

  it.each([
    ['text', 'sm:w-96'],
    ['select-wide', 'sm:w-72'],
    ['select', 'sm:w-48'],
    ['code', 'sm:w-40'],
  ] as const)('applies the %s width tier', (size, expected) => {
    const markup = renderToStaticMarkup(
      <SettingsRow label="Field" size={size}>
        <input />
      </SettingsRow>,
    );
    expect(markup).toContain(expected);
  });

  it('leaves the control column unconstrained without a tier', () => {
    const markup = renderToStaticMarkup(
      <SettingsRow label="Buttons">
        <button type="button">Save</button>
      </SettingsRow>,
    );
    expect(markup).not.toContain('sm:w-96');
  });
});

describe('SettingsCard', () => {
  it('renders the plain card variant with divided rows', () => {
    const markup = renderToStaticMarkup(
      <SettingsCard>
        <SettingsRow label="One">
          <input />
        </SettingsRow>
        <SettingsRow label="Two">
          <input />
        </SettingsRow>
      </SettingsCard>,
    );
    expect(markup).toContain('data-slot="card"');
    expect(markup).toContain('data-variant="plain"');
    expect(markup).toContain('divide-y');
    expect(markup).toContain('One');
    expect(markup).toContain('Two');
  });
});
