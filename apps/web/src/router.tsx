import { useEffect, useState } from 'react';
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
import type { ApiClient, StatusFilter } from '@labos-threejs/sdk';
import {
  AppMessagesProvider,
  AppShellLayout,
  PreferencesProvider,
  sessionQuery,
  useFlowLocaleSetter,
  useAppMessage,
  usePageTitle,
  SettingsView,
  ForgotPasswordView,
  ResetPasswordView,
  AuditView,
  auditFilterFields,
  NotificationsView,
  LoginView,
  RegisterView,
  HomeView,
  MembersView,
  JobsView,
  JobView,
  filterableStatuses,
  type AppLocale,
  type AssembledApp,
  type NavigateTarget,
} from '@labos-threejs/views';
import { assembledApp, exampleEntries } from './app-examples';
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
// below, example pages come from the explicit assembly point. Preferences
// (language + appearance) wrap the message catalog so every page — auth
// included — renders in the resolved language and theme.

function RootLayout() {
  return (
    <PreferencesProvider>
      {/* Desktop-only adapter: mirrors the appearance enums to the shell
          for its local error page; absent in plain browsers. */}
      <DesktopPreferencesMirror />
      <AppMessagesProvider app={assembledApp}>
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

// Shell navigation keeps the URL's query conditions (job status, audit
// filters) alive across detours such as the settings page — switching the
// language or theme must not clear a legitimate query. Retention applies
// only to the routes that own search-param state and the preferences page
// hosting that detour; every other destination drops the keys, and the
// owning routes re-validate on arrival and strip foreign keys.
const queryRetainingPaths = new Set(['/jobs', '/audit', '/settings']);
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
        navigation={signedIn ? assembledApp.navigation : undefined}
        moduleIcons={signedIn ? assembledApp.moduleIcons : undefined}
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
          void navigate({ to: assembledApp.defaultEntry });
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
          void navigate({ to: assembledApp.defaultEntry });
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
        scenes: assembledApp.scenes,
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

// The status filter is a URL search param: a language/theme switch or a
// settings detour cannot clear a legitimate query, and filtered views
// stay shareable. The accepted values are the view's own filterable
// statuses — one source of truth for the validator and the select.
// Absent param defaults to `failed` (the administrator's working set);
// `all` lists every status.
const DEFAULT_JOB_STATUS = 'failed' as const;
type JobsSearch = { status?: StatusFilter | 'all' };
function validateJobsSearch(search: Record<string, unknown>): JobsSearch {
  const status = search.status;
  if (status === 'all') return { status: 'all' };
  if (
    typeof status === 'string' &&
    filterableStatuses.includes(status as StatusFilter)
  )
    return { status: status as StatusFilter };
  return {};
}
const jobsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/jobs',
  validateSearch: validateJobsSearch,
  component: function JobsPage() {
    const { apiClient } = rootRoute.useRouteContext();
    const navigate = useNavigate();
    const { status } = jobsRoute.useSearch();
    return (
      <JobsView
        apiClient={apiClient}
        onOpenJob={(jobId) => {
          void navigate({ to: '/jobs/$jobId', params: { jobId } });
        }}
        status={status ?? DEFAULT_JOB_STATUS}
        onStatusChange={(next) => {
          void navigate({
            to: '/jobs',
            search: next === DEFAULT_JOB_STATUS ? {} : { status: next },
          });
        }}
      />
    );
  },
});

const jobRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/jobs/$jobId',
  component: function JobPage() {
    const { apiClient } = rootRoute.useRouteContext();
    const { jobId } = jobRoute.useParams();
    const navigate = useNavigate();
    return (
      <JobView
        apiClient={apiClient}
        jobId={jobId}
        onOpen={shellPathPort(navigate)}
      />
    );
  },
});

const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/forgot-password',
  component: function ForgotPasswordPage() {
    const { apiClient } = rootRoute.useRouteContext();
    const navigate = useNavigate();
    return (
      <ForgotPasswordView
        apiClient={apiClient}
        onLogin={() => {
          void navigate({ to: '/login' });
        }}
      />
    );
  },
});

// The reset link's fragment carries the secret token plus a non-sensitive
// language hint; both are read once and the fragment is cleared. The hint
// steers only this reset flow's language (docs/ui/design.md §6 Q8).
function resetLink(hash: string): {
  token: string | undefined;
  hint: AppLocale | undefined;
} {
  if (hash.length > 256) return { token: undefined, hint: undefined };
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const token = params.get('token');
  const lang = params.get('lang');
  return {
    token: token && /^[0-9a-f]{64}$/i.test(token) ? token : undefined,
    hint: lang === 'zh' || lang === 'en' ? lang : undefined,
  };
}

const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reset-password',
  component: function ResetPasswordPage() {
    const { apiClient } = rootRoute.useRouteContext();
    const navigate = useNavigate();
    const hash = useLocation({ select: (location) => location.hash });
    const [link, setLink] = useState(() => ({
      observedHash: hash,
      ...resetLink(hash),
      revision: 0,
    }));
    // A new email link may navigate within this mounted route. Capture it before
    // replacing the fragment; a fresh View drops prior form/success/request state.
    if (hash !== link.observedHash) {
      const parsed = resetLink(hash);
      setLink({
        observedHash: hash,
        token: hash ? parsed.token : link.token,
        hint: hash ? parsed.hint : link.hint,
        revision: hash ? link.revision + 1 : link.revision,
      });
    }
    useEffect(() => {
      if (hash)
        void navigate({ to: '/reset-password', hash: '', replace: true });
    }, [hash, navigate]);
    // The mail's language renders this flow (and only it) in that
    // language; each fresh link re-applies its hint, and leaving the
    // route hands the document back to the saved preference.
    const setFlowLocale = useFlowLocaleSetter();
    useEffect(() => {
      setFlowLocale(link.hint);
      return () => setFlowLocale(undefined);
    }, [link.revision, link.hint, setFlowLocale]);
    return (
      <ResetPasswordView
        apiClient={apiClient}
        key={link.revision}
        token={link.token}
        onConsumed={() =>
          setLink((current) => ({ ...current, token: undefined }))
        }
        onLogin={() => {
          void navigate({ to: '/login' });
        }}
        onRequest={() => {
          void navigate({ to: '/forgot-password' });
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

// Audit filter conditions are URL search params for the same reason as
// the job status filter: they survive language/theme switches, back
// navigation and bookmarks.
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

const notificationsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/notifications',
  component: function NotificationsPage() {
    const { apiClient } = rootRoute.useRouteContext();
    const navigate = useNavigate();
    return (
      <NotificationsView
        apiClient={apiClient}
        resolveTarget={
          assembledApp.resolveNotificationTarget
            ? (target) =>
                assembledApp.resolveNotificationTarget?.(target, {
                  navigate: navigatePort(navigate),
                })
            : undefined
        }
        describeNotification={assembledApp.describeNotification}
        onBack={() => {
          void navigate({ to: '/' });
        }}
      />
    );
  },
});

// Example pages: one adapter turns assembled descriptors into real routes;
// `provide` lets an example wrap its own pages with example-owned ports.
const provideByExample = new Map(
  exampleEntries.map((entry) => [entry.id, entry.provide]),
);

// Example pages render under the same shell layout route (docs/ui/design.md
// §4.1): the adapter — not the example — owns the router ports, and the
// example's `provide` wrapper wraps page content only. Example views never
// mount the shell themselves.
function adapterRoute(route: AssembledApp['routes'][number]) {
  return createRoute({
    getParentRoute: () => shellRoute,
    path: route.path,
    component: function ExamplePage() {
      const params = useParams({ strict: false }) as Record<string, string>;
      const navigate = useNavigate();
      const { apiClient } = rootRoute.useRouteContext();
      const page = route.component({
        params,
        apiClient,
        navigate: navigatePort(navigate),
      });
      return provideByExample.get(route.exampleId)?.(page) ?? page;
    },
  });
}

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([
    ...assembledApp.routes.map(adapterRoute),
    apiKeysRoute,
    auditRoute,
    notificationsRoute,
    membersRoute,
    jobsRoute,
    jobRoute,
    settingsRoute,
    designSystemRoute,
    homeRoute,
    statusRoute,
  ]),
  forgotPasswordRoute,
  resetPasswordRoute,
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
