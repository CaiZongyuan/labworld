import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  useNavigate,
  useParams,
  useLocation,
  type RouterHistory,
} from '@tanstack/react-router';
import type { ApiClient } from '@labos-threejs/sdk';
import {
  AppMessagesProvider,
  AppShellLayout,
  PreferencesProvider,
  sessionQuery,
  useAppMessage,
  usePageTitle,
  SettingsView,
  AuditView,
  auditFilterFields,
  LoginView,
  RegisterView,
  HomeView,
  MembersView,
  type AppDefinition,
  type NavigateTarget,
} from '@labos-threejs/views';
import { app } from './app';
import { DesktopPreferencesMirror } from './desktop-preferences';

// The design-system page and its icon catalog load on demand
// (docs/ui/design.md §6 Q9): the subpath import keeps the design-system
// view — and everything it alone uses — out of the initial bundle, within
// the existing perf budgets.

type AppContext = { apiClient: ApiClient; docsUrl: string };
const rootRoute = createRootRouteWithContext<AppContext>()({
  component: RootLayout,
  notFoundComponent: RouteNotFoundPage,
});

// The universal shell renders the assembled result; the actual Router
// wiring (TanStack) lives only in this adapter. Core pages are registered
// below, Lab pages come from the explicit application entry. Preferences
// (language + appearance) wrap the message catalog so every page — auth
// included — renders in the resolved language and theme.

function RootLayout() {
  return (
    <PreferencesProvider>
      {/* Desktop-only adapter: mirrors the appearance enums to the shell
          for its local error page; absent in plain browsers. */}
      <DesktopPreferencesMirror />
      <AppMessagesProvider app={app}>
        <Outlet />
      </AppMessagesProvider>
    </PreferencesProvider>
  );
}

// Unknown paths render the shell's unavailable page instead of silently
// rewriting the address: the URL may be an old bookmark of a removed
// example, and the page keeps a visible way home without a loop.
function RouteNotFoundPage() {
  const message = useAppMessage();
  usePageTitle('unavailable.title');
  const navigate = useNavigate();
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-xl font-semibold">{message('unavailable.title')}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {message('unavailable.description')}
      </p>
      <button
        type="button"
        className="mt-4 text-sm underline"
        onClick={() => {
          void navigate({ to: '/' });
        }}
      >
        {message('unavailable.backHome')}
      </button>
    </main>
  );
}

// Example routes register at runtime, so TanStack's typed `to` unions can
// never list them; typed navigation stays impossible for them and both
// ports below go through the untyped options instead.
function navigateOptions(target: NavigateTarget) {
  return {
    to: target.path,
    params: target.params as never,
    search: target.search as never,
    replace: target.replace,
    ignoreBlocker: target.ignoreBlocker,
  };
}

function navigatePort(
  navigate: ReturnType<typeof useNavigate>,
): (target: NavigateTarget) => void {
  return (target) => {
    void navigate(navigateOptions(target));
  };
}

// Shell navigation keeps the URL's query conditions (audit filters) alive across detours such as the settings page — switching the
// language or theme must not clear a legitimate query. Retention applies
// only to the routes that own search-param state and the preferences page
// hosting that detour; every other destination drops the keys, and the
// owning routes re-validate on arrival and strip foreign keys.
const queryRetainingPaths = new Set(['/audit', '/settings']);
function shellPathPort(
  navigate: ReturnType<typeof useNavigate>,
): (path: string) => void {
  return (path) => {
    void navigate({
      to: path,
      ...(path === '/settings'
        ? {
            search: (previous: Record<string, unknown>) => ({
              ...previous,
              section: undefined,
            }),
          }
        : queryRetainingPaths.has(path)
          ? { search: true as const }
          : {}),
    });
  };
}

// Programmatic navigation to runtime-registered routes (tests, adapters).
export function navigateExample(
  router: ReturnType<typeof createAppRouter>,
  target: NavigateTarget,
): Promise<void> {
  return router.navigate(navigateOptions(target));
}

// The shell mounts exactly once, on this pathless layout route
// (docs/ui/design.md §4.2): every shell-bearing path renders under it and
// page components render content only. It resolves the session for the
// permission-gated navigation — assembled business groups appear for
// signed-in users on every shell route, never signed out — and shows the
// loading indicator while that session resolves. The actual Router types
// stay in this adapter; the shared shell consumes ports.
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_shell',
  component: function ShellLayout() {
    const { apiClient } = rootRoute.useRouteContext();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const session = useQuery(sessionQuery(apiClient, queryClient));
    const signedIn = session.data?.user !== undefined;
    const currentPath = useLocation({
      select: (location) => location.pathname,
    });
    return (
      <AppShellLayout
        navigation={signedIn ? app.navigation : undefined}
        moduleIcons={signedIn ? app.moduleIcons : undefined}
        role={session.data?.user.role}
        user={session.data?.user}
        currentPath={currentPath}
        onOpen={shellPathPort(navigate)}
        loadingIndicator={
          session.isPending ? (
            <div
              aria-hidden="true"
              className="h-0.5 w-full animate-pulse bg-primary"
            />
          ) : undefined
        }
      >
        <Outlet />
      </AppShellLayout>
    );
  },
});

const statusRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/system',
  component: function StatusPage() {
    return <AppSettingsPage section="system" />;
  },
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: function LoginPage() {
    const { apiClient } = rootRoute.useRouteContext();
    const navigate = useNavigate();
    return (
      <LoginView
        apiClient={apiClient}
        onLoggedIn={() => {
          void navigate({ to: app.defaultEntry });
        }}
      />
    );
  },
});

const registrationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/register',
  component: function RegistrationPage() {
    const { apiClient } = rootRoute.useRouteContext();
    const navigate = useNavigate();
    return (
      <RegisterView
        apiClient={apiClient}
        onRegistered={() => {
          void navigate({ to: app.defaultEntry });
        }}
      />
    );
  },
});

const homeRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/',
  component: function HomePage() {
    const { apiClient } = rootRoute.useRouteContext();
    return <HomeView apiClient={apiClient} />;
  },
});

// The settings page's `section` query names an anchored section for deep
// links (docs/ui/design.md §5). Any value is accepted — an unknown or
// signed-out anchor simply scrolls nowhere — and the shell's navigation
// retention keeps it alive across language/theme switches.
type SettingsSearch = { section?: string };
function validateSettingsSearch(
  search: Record<string, unknown>,
): SettingsSearch {
  return typeof search.section === 'string' && search.section
    ? { section: search.section }
    : {};
}
const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/settings',
  validateSearch: validateSettingsSearch,
  component: function SettingsPage() {
    const { section } = settingsRoute.useSearch();
    return <AppSettingsPage section={section} />;
  },
});

function AppSettingsPage({ section }: { section?: string }) {
  const { apiClient, docsUrl } = rootRoute.useRouteContext();
  const navigate = useNavigate();
  return (
    <SettingsView
      docsUrl={docsUrl}
      apiClient={apiClient}
      onOpen={shellPathPort(navigate)}
      section={section}
      onSectionChange={(next) => {
        void navigate({
          to: '/settings',
          search: (previous: Record<string, unknown>) => ({
            ...previous,
            section: next,
          }),
        });
      }}
      showroom={{
        scenes: app.scenes,
        copyText: (text) => navigator.clipboard.writeText(text),
      }}
    />
  );
}

const designSystemRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/design-system',
  component: function DesignSystemPage() {
    return <AppSettingsPage section="design-system" />;
  },
});

const membersRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/members',
  component: function MembersPage() {
    const { apiClient } = rootRoute.useRouteContext();
    const navigate = useNavigate();
    return (
      <MembersView
        apiClient={apiClient}
        onLogin={() => {
          void navigate({ to: '/login' });
        }}
      />
    );
  },
});

const apiKeysRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/api-keys',
  component: function ApiKeysPage() {
    return <AppSettingsPage section="api-keys" />;
  },
});

// Audit filters survive language/theme switches, back navigation and bookmarks.
type AuditSearch = {
  action?: string;
  resource_id?: string;
  resource_type?: string;
  actor_id?: string;
  request_id?: string;
  correlation_id?: string;
  job_id?: string;
};
// The accepted keys are the view's own filter fields, so the URL state
// and the form cannot drift apart.
function validateAuditSearch(search: Record<string, unknown>): AuditSearch {
  const next: AuditSearch = {};
  for (const key of auditFilterFields) {
    const value = search[key];
    if (typeof value === 'string' && value.trim()) next[key] = value;
  }
  return next;
}
const auditRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/audit',
  validateSearch: validateAuditSearch,
  component: function AuditPage() {
    const { apiClient } = rootRoute.useRouteContext();
    const navigate = useNavigate();
    const search = auditRoute.useSearch();
    return (
      <AuditView
        apiClient={apiClient}
        filters={search}
        onApplyFilters={(filters) => {
          void navigate({ to: '/audit', search: filters });
        }}
      />
    );
  },
});

// Lab supplies its pages directly; the Web adapter owns router ports.
function adapterRoute(route: AppDefinition['routes'][number]) {
  return createRoute({
    getParentRoute: () => shellRoute,
    path: route.path,
    component: function ExamplePage() {
      const params = useParams({ strict: false }) as Record<string, string>;
      const search = useLocation({ select: (location) => location.search });
      const navigate = useNavigate();
      const { apiClient } = rootRoute.useRouteContext();
      const page = route.component({
        params,
        search,
        apiClient,
        navigate: navigatePort(navigate),
      });
      return page;
    },
  });
}

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([
    ...app.routes.map(adapterRoute),
    apiKeysRoute,
    auditRoute,
    membersRoute,
    settingsRoute,
    designSystemRoute,
    homeRoute,
    statusRoute,
  ]),
  loginRoute,
  registrationRoute,
]);

export function createAppRouter(context: AppContext, history?: RouterHistory) {
  return createRouter({ routeTree, context, history });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
