import { lazy, Suspense, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@labos-threejs/sdk';
import {
  SettingsCard,
  SettingsRow,
  SettingsScopeBadge,
  SettingsSection,
  SettingsTab,
} from './settings-kit';
import { choiceRowClass } from './rows';
import { docsChapterUrl, docsHomeUrl } from './docs-links';
import { roleMessageKeys, useAppMessage } from './messages';
import {
  usePreferences,
  type AppLocale,
  type ThemeChoice,
} from './preferences';
import { usePageTitle } from './page-title';
import { sessionQuery } from '../identity/session';
import type { AssembledApp } from './app-contract';
import { SettingsLayout } from './settings-layout';
import { ApiKeysView } from '../api-keys/api-keys-view';
import { StatusView } from '../system/status-view';
import { EntityGraphic } from './entity-graphic';
import { GraphicPicker } from './graphic-picker';
import { useGraphicPreference } from './graphic-preferences';
import { ErrorAlert } from './error-alert';

// The showroom stays an async chunk here exactly as on its own route:
// the dynamic import resolves to the same module, so both entries share
// one lazy boundary and the initial bundle never sees it.
const DesignSystemView = lazy(
  () => import('../design-system/design-system-view'),
);

function ChoiceGroup<T extends string>({
  name,
  legend,
  hint,
  options,
  value,
  onChange,
}: {
  name: string;
  legend: string;
  hint?: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-semibold">{legend}</legend>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      <div className="flex flex-col gap-1">
        {options.map((option) => (
          <label key={option.value} className={choiceRowClass}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="accent-[var(--primary)]"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function SettingsView({
  docsUrl,
  apiClient,
  onOpen,
  section,
  onSectionChange,
  showroom,
}: {
  docsUrl: string;
  apiClient: ApiClient;
  /** Router port for opening paths without a full page load. */
  onOpen?: (path: string) => void;
  /** Selected settings pane, including legacy deep links. */
  section?: string;
  onSectionChange?: (section: string) => void;
  /** Ports for the embedded showroom; missing scenes or copy hide it. */
  showroom?: {
    scenes?: AssembledApp['scenes'];
    copyText?: (text: string) => Promise<void>;
  };
}) {
  const message = useAppMessage();
  const { locale, setLocale, theme, setTheme } = usePreferences();
  const [localSection, setLocalSection] = useState('appearance');
  const queryClient = useQueryClient();
  const session = useQuery(sessionQuery(apiClient, queryClient));
  const user = session.data?.user;
  const signedIn = user !== undefined;
  const [avatar, setAvatar] = useGraphicPreference(user?.id, 'user', 'user');
  const entries = [
    { id: 'appearance', label: message('settings.appearance') },
    { id: 'account', label: message('settings.account'), authenticated: true },
    { id: 'api-keys', label: message('settings.apiKeys'), authenticated: true },
    {
      id: 'design-system',
      label: message('settings.designSystem'),
      authenticated: true,
    },
    { id: 'system', label: message('shell.nav.status') },
    { id: 'help', label: message('settings.help') },
  ];
  const selected =
    entries.find((entry) => entry.id === (section ?? localSection)) ??
    entries[0];
  usePageTitle(
    selected.id === 'api-keys'
      ? 'apiKeys.title'
      : selected.id === 'system'
        ? 'status.title'
        : selected.id === 'design-system'
          ? 'design.title'
          : 'settings.title',
  );
  const languageOptions: { value: AppLocale; label: string }[] = [
    { value: 'zh', label: message('settings.language.zh') },
    { value: 'en', label: message('settings.language.en') },
  ];
  const themeOptions: { value: ThemeChoice; label: string }[] = [
    { value: 'system', label: message('settings.theme.system') },
    { value: 'light', label: message('settings.theme.light') },
    { value: 'dark', label: message('settings.theme.dark') },
  ];

  const openPath =
    (path: string) => (event: { preventDefault: () => void }) => {
      if (onOpen) {
        event.preventDefault();
        onOpen(path);
      }
    };

  return (
    <SettingsLayout
      entries={entries.filter((entry) => !entry.authenticated || signedIn)}
      selected={selected.id}
      onSelect={(next) => {
        if (onSectionChange) onSectionChange(next);
        else setLocalSection(next);
      }}
    >
      <SettingsTab title={selected.label}>
        {selected.authenticated && !signedIn && selected.id !== 'api-keys' ? (
          session.isPending ? (
            <p role="status">{message('common.loadingSession')}</p>
          ) : session.isError ? (
            <ErrorAlert
              error={session.error}
              title={message('common.sessionUnavailable')}
            />
          ) : (
            <p>
              {message('common.signedOut')}{' '}
              <a href="/login" className="underline">
                {message('login.submit')}
              </a>
            </p>
          )
        ) : null}
        {selected.id === 'appearance' ? (
          <>
            <SettingsSection
              scope="device"
              scopeLabel={message('settings.scope.device')}
              description={message('settings.appearanceHint')}
              anchor="appearance"
            >
              <SettingsCard>
                <div className="py-4">
                  <ChoiceGroup
                    name="language"
                    legend={message('settings.language')}
                    hint={message('settings.languageHint')}
                    options={languageOptions}
                    value={locale}
                    onChange={setLocale}
                  />
                </div>
                <div className="py-4">
                  <ChoiceGroup
                    name="theme"
                    legend={message('settings.theme')}
                    hint={message('settings.themeHint')}
                    options={themeOptions}
                    value={theme}
                    onChange={setTheme}
                  />
                </div>
              </SettingsCard>
              <a
                href={docsChapterUrl(
                  docsUrl,
                  locale,
                  'tutorials/appearance-language.md',
                )}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-block text-sm text-link hover:underline"
              >
                {message('settings.tutorial')}
              </a>
            </SettingsSection>
          </>
        ) : null}

        {selected.id === 'account' && signedIn && user ? (
          <SettingsSection
            scope="account"
            scopeLabel={message('settings.scope.account')}
            description={message('settings.accountHint')}
            anchor="account"
          >
            <div className="profile-identity">
              <EntityGraphic
                choice={avatar}
                name={user.display_name || user.email}
                size="large"
                portrait
              />
              <div>
                <strong>{user.display_name || user.email}</strong>
                <SettingsScopeBadge
                  scope="device"
                  label={message('settings.scope.device')}
                />
              </div>
              <GraphicPicker
                kind="user"
                choice={avatar}
                name={user.display_name || user.email}
                seed={`user:${user.id}`}
                label={message('graphic.changeAvatar')}
                onChange={setAvatar}
              />
            </div>
            <SettingsCard>
              <SettingsRow label={message('settings.accountEmail')}>
                <span className="text-sm">{user.email}</span>
              </SettingsRow>
              <SettingsRow label={message('settings.accountDisplayName')}>
                <span className="text-sm">{user.display_name || '—'}</span>
              </SettingsRow>
              <SettingsRow label={message('settings.accountRole')}>
                <span className="text-sm">
                  {message(roleMessageKeys[user.role])}
                </span>
              </SettingsRow>
            </SettingsCard>
          </SettingsSection>
        ) : null}

        {selected.id === 'api-keys' ? (
          <SettingsSection
            scope="account"
            scopeLabel={message('settings.scope.account')}
            anchor="api-keys"
          >
            <ApiKeysView
              embedded
              apiClient={apiClient}
              copySecret={
                showroom?.copyText ??
                (async () => {
                  throw new Error('Clipboard unavailable');
                })
              }
            />
          </SettingsSection>
        ) : null}

        {selected.id === 'design-system' &&
        signedIn &&
        showroom?.scenes &&
        showroom.copyText ? (
          <SettingsSection anchor="design-system">
            <Suspense
              fallback={
                <p role="status" className="text-sm text-muted-foreground">
                  {message('design.pageLoading')}
                </p>
              }
            >
              <DesignSystemView
                embedded
                docsUrl={docsUrl}
                scenes={showroom.scenes}
                copyText={showroom.copyText}
              />
            </Suspense>
            <a
              href={docsChapterUrl(
                docsUrl,
                locale,
                'tutorials/design-system.md',
              )}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-link hover:underline"
            >
              {message('design.tutorial')}
            </a>
          </SettingsSection>
        ) : null}

        {selected.id === 'system' ? (
          <SettingsSection anchor="system">
            <StatusView embedded apiClient={apiClient} docsUrl={docsUrl} />
          </SettingsSection>
        ) : null}
        {selected.id === 'help' ? (
          <SettingsSection anchor="help">
            <SettingsCard>
              <SettingsRow label={message('settings.helpDocsLabel')}>
                <a
                  href={docsHomeUrl(docsUrl, locale)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-link hover:underline"
                >
                  {message('shell.nav.tutorials')}
                </a>
              </SettingsRow>
              <SettingsRow label={message('settings.helpStatusLabel')}>
                <a
                  href="/system"
                  className="text-sm text-link hover:underline"
                  onClick={openPath('/system')}
                >
                  {message('shell.nav.status')}
                </a>
              </SettingsRow>
            </SettingsCard>
          </SettingsSection>
        ) : null}
      </SettingsTab>
    </SettingsLayout>
  );
}
