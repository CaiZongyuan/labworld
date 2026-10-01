import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from 'react';
import { Languages, Layers3, Menu, Moon, Settings, Sun, X } from 'lucide-react';
import { Button } from '@labos-threejs/ui/components/button';
import { ModuleIcon } from '@labos-threejs/ui/components/module-icon';
import { EntityGraphic } from './entity-graphic';
import { useGraphicPreference } from './graphic-preferences';
import type { AssembledApp } from './app-contract';
import { coreModuleIcons } from './module-registry';
import { roleMessageKeys, useAppMessage } from './messages';
import {
  BusinessNavigation,
  navigationActive,
  sidebarLinkClass,
} from './app-navigation';
import { usePreferences } from './preferences';

const DEFAULT_WIDTH = 224;
const MIN_WIDTH = 200;
const MAX_WIDTH = 360;
const WIDTH_KEY = 'labos-threejs.sidebar-width';
const settingsPaths = new Set([
  '/settings',
  '/api-keys',
  '/design-system',
  '/system',
]);
const clampWidth = (value: number) =>
  Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value));
function savedWidth() {
  try {
    const value = Number(window.localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(value) && value >= MIN_WIDTH && value <= MAX_WIDTH
      ? value
      : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

// The shell layout (docs/ui/design.md §4): a left sidebar — assembled
// business groups, notifications, the permission-gated administration
// group, and one bottom account/settings entry — beside the main workspace. On
// narrow screens the sidebar folds into a drawer behind a toggling button
// (touch targets stay ≥44px); on wide screens it is a sticky column. The
// shell never knows which example a group came from — it renders the
// assembled result and consumes ports for opening paths.

export type ShellRole = 'owner' | 'admin' | 'member';

export function AppShellLayout({
  navigation,
  moduleIcons,
  role,
  user,
  currentPath,
  onOpen,
  topbarActions,
  loadingIndicator,
  extra,
  children,
}: {
  navigation?: AssembledApp['navigation'];
  /** Assembled module colors for the business links above. */
  moduleIcons?: AssembledApp['moduleIcons'];
  role?: ShellRole;
  user?: { id: string; display_name?: string | null; email: string };
  currentPath?: string;
  /** Router port for opening paths without a full page load. */
  onOpen?: (path: string) => void;
  /** Actions beside the app name, wherever the brand row renders
      (narrow topbar and sidebar header). */
  topbarActions?: ReactNode;
  /** Progress shown above the content while the host resolves data. */
  loadingIndicator?: ReactNode;
  /** Overlays and mounted-once singletons, rendered after the content
      inside the main landmark (docs/ui/design.md §4.2). */
  extra?: ReactNode;
  children: ReactNode;
}) {
  const message = useAppMessage();
  const preferences = usePreferences();
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(savedWidth);
  const width = useRef(sidebarWidth);
  const resize = useRef<{ x: number; width: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  const updateWidth = useCallback((next: number, persist = false) => {
    if (!Number.isFinite(next)) return;
    width.current = clampWidth(next);
    setSidebarWidth(width.current);
    if (persist) {
      try {
        window.localStorage.setItem(WIDTH_KEY, String(width.current));
      } catch {
        /* Session-only preference when storage is unavailable. */
      }
    }
  }, []);
  const finishResize = useCallback(() => {
    if (!resize.current) return;
    resize.current = null;
    setResizing(false);
    updateWidth(width.current, true);
  }, [updateWidth]);
  useEffect(() => {
    if (!resizing) return;
    window.addEventListener('blur', finishResize);
    return () => window.removeEventListener('blur', finishResize);
  }, [resizing, finishResize]);
  const close = () => setMenuOpen(false);
  const signedIn = role !== undefined;
  const canAdmin = role === 'owner' || role === 'admin';
  const [avatar] = useGraphicPreference(user?.id, 'user', 'user');

  // The drawer is a passive navigation surface: Escape dismisses it, and
  // the toggle button carries the state (full focus containment is not
  // required for a non-modal drawer).
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);

  // One icon lookup for every sidebar link: the shell's core registry
  // first, then the assembled example colors (which can never shadow a
  // core path — assembly refuses that).
  const icons = { ...coreModuleIcons, ...moduleIcons };
  const coreTitles: Record<string, string> = {
    '/': 'shell.nav.home',
    '/notifications': 'shell.nav.notifications',
    '/members': 'shell.nav.members',
    '/jobs': 'shell.nav.jobs',
    '/audit': 'shell.nav.audit',
    '/settings': 'shell.nav.settings',
    '/api-keys': 'shell.nav.apiKeys',
    '/design-system': 'shell.nav.designSystem',
    '/system': 'shell.nav.status',
  };
  const business = navigation
    ?.flatMap((group) => group.items)
    .filter((item) => navigationActive(currentPath, item.path))
    .sort((left, right) => right.path.length - left.path.length)[0];
  const pageLabel = business
    ? message(business.labelKey)
    : message(coreTitles[currentPath ?? ''] ?? 'app.name');
  const link = (path: string, label: string, extraClassName?: string) => {
    const icon = icons[path];
    return (
      <a
        href={path}
        className={sidebarLinkClass + (extraClassName ?? '')}
        aria-current={navigationActive(currentPath, path) ? 'page' : undefined}
        aria-label={label}
        title={label}
        onClick={(event) => {
          if (
            onOpen &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.shiftKey &&
            !event.altKey
          ) {
            event.preventDefault();
            onOpen(path);
          }
          close();
        }}
      >
        {icon ? (
          <ModuleIcon
            icon={icon.icon}
            variant={icon.variant}
            appearance="bare"
            size="sm"
          />
        ) : null}
        <span className="app-nav-label">{label}</span>
      </a>
    );
  };

  return (
    <div
      className="app-shell flex min-h-screen bg-background"
      data-resizing={resizing || undefined}
      style={{ '--app-sidebar-width': `${sidebarWidth}px` } as CSSProperties}
    >
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        {message('shell.nav.skipToContent')}
      </a>
      {menuOpen ? (
        <div
          className="fixed inset-0 z-30 bg-foreground/40 lg:hidden"
          aria-hidden="true"
          onClick={close}
        />
      ) : null}
      <aside
        id="app-sidebar"
        className={
          (menuOpen
            ? 'fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-border bg-sidebar'
            : 'hidden') +
          ' app-sidebar lg:sticky lg:top-0 lg:flex lg:h-screen lg:shrink-0 lg:flex-col lg:border-r lg:border-border lg:bg-muted'
        }
      >
        <div className="app-brand flex items-center gap-2 px-4 py-4">
          <span className="app-brand-mark">
            <Layers3 aria-hidden="true" />
          </span>
          <span className="flex-1 text-sm font-semibold">
            {message('app.name')}
          </span>
          {topbarActions ? (
            <div className="flex shrink-0 items-center gap-1">
              {topbarActions}
            </div>
          ) : null}
          <button
            type="button"
            aria-label={message('shell.nav.closeMenu')}
            className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted lg:hidden"
            onClick={close}
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </div>
        <nav
          aria-label={message('shell.nav.mainMenu')}
          className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 pb-4"
        >
          <div className="flex flex-col gap-1">
            {link('/', message('shell.nav.home'))}
            {signedIn
              ? link('/notifications', message('shell.nav.notifications'))
              : null}
          </div>
          {navigation && navigation.length > 0 ? (
            <BusinessNavigation
              navigation={navigation}
              moduleIcons={icons}
              currentPath={currentPath}
              onOpen={(path) => {
                if (onOpen) onOpen(path);
                close();
              }}
            />
          ) : null}
          {canAdmin ? (
            <div className="flex flex-col gap-1">
              <h3 className="app-nav-group-label px-3 text-xs font-medium text-muted-foreground">
                {message('shell.nav.management')}
              </h3>
              {link('/members', message('shell.nav.members'))}
              {link('/jobs', message('shell.nav.jobs'))}
              {link('/audit', message('shell.nav.audit'))}
            </div>
          ) : null}
        </nav>
        <a
          href="/settings"
          className="app-account"
          aria-label={message('shell.nav.settings')}
          aria-current={
            settingsPaths.has(currentPath ?? '') ? 'page' : undefined
          }
          title={message('shell.nav.settings')}
          onClick={(event) => {
            if (
              onOpen &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.shiftKey &&
              !event.altKey
            ) {
              event.preventDefault();
              onOpen('/settings');
            }
            close();
          }}
        >
          {user ? (
            <EntityGraphic
              choice={avatar}
              name={user.display_name || user.email}
              portrait
            />
          ) : (
            <Settings aria-hidden="true" />
          )}
          <span className="app-account-copy">
            <strong>
              {user
                ? user.display_name || user.email
                : message('shell.nav.settings')}
            </strong>
            {role ? <span>{message(roleMessageKeys[role])}</span> : null}
          </span>
          <Settings className="app-account-settings" aria-hidden="true" />
        </a>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={message('shell.nav.resize')}
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          className="app-sidebar-resize"
          onDoubleClick={() => updateWidth(DEFAULT_WIDTH, true)}
          onKeyDown={(event) => {
            const next =
              event.key === 'ArrowLeft'
                ? width.current - 8
                : event.key === 'ArrowRight'
                  ? width.current + 8
                  : event.key === 'Home'
                    ? MIN_WIDTH
                    : event.key === 'End'
                      ? MAX_WIDTH
                      : undefined;
            if (next !== undefined) {
              event.preventDefault();
              updateWidth(next, true);
            }
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.focus();
            resize.current = { x: event.clientX, width: width.current };
            event.currentTarget.setPointerCapture?.(event.pointerId);
            setResizing(true);
            event.preventDefault();
          }}
          onPointerMove={(event) => {
            if (resize.current)
              updateWidth(
                resize.current.width + event.clientX - resize.current.x,
              );
          }}
          onPointerUp={(event) => {
            finishResize();
            if (event.currentTarget.hasPointerCapture?.(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={finishResize}
          onLostPointerCapture={finishResize}
        />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="app-topbar flex items-center gap-2 border-b border-border px-2 py-1">
          <button
            type="button"
            aria-expanded={menuOpen}
            aria-controls="app-sidebar"
            aria-label={message('shell.nav.openMenu')}
            className="flex size-11 items-center justify-center rounded-md hover:bg-muted lg:hidden"
            onClick={() => setMenuOpen(true)}
          >
            <Menu aria-hidden="true" className="size-5" />
          </button>
          <span className="app-topbar-label text-sm font-medium">
            {pageLabel}
          </span>
          {topbarActions ? (
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {topbarActions}
            </div>
          ) : null}
          <div className="app-topbar-preferences ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={message(
                preferences.locale === 'zh'
                  ? 'settings.language.en'
                  : 'settings.language.zh',
              )}
              title={message(
                preferences.locale === 'zh'
                  ? 'settings.language.en'
                  : 'settings.language.zh',
              )}
              onClick={() =>
                preferences.setLocale(preferences.locale === 'zh' ? 'en' : 'zh')
              }
            >
              <Languages aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={message(
                preferences.resolvedTheme === 'dark'
                  ? 'settings.theme.light'
                  : 'settings.theme.dark',
              )}
              title={message(
                preferences.resolvedTheme === 'dark'
                  ? 'settings.theme.light'
                  : 'settings.theme.dark',
              )}
              onClick={() =>
                preferences.setTheme(
                  preferences.resolvedTheme === 'dark' ? 'light' : 'dark',
                )
              }
            >
              {preferences.resolvedTheme === 'dark' ? (
                <Sun aria-hidden="true" />
              ) : (
                <Moon aria-hidden="true" />
              )}
            </Button>
          </div>
        </header>
        <main id="main-content" className="min-w-0 flex-1">
          {loadingIndicator}
          {children}
          {extra}
        </main>
      </div>
    </div>
  );
}
