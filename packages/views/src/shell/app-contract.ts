import type { Notification, NotificationTarget } from '@labos-threejs/sdk';
import type { ApiClient } from '@labos-threejs/sdk';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ModuleIconVariant } from '@labos-threejs/ui/components/module-icon';
import { coreMessages } from './core-messages';
import { coreModuleIcons } from './module-registry';

// The composition contract between the universal shell and the removable
// example applications (docs/ui/design.md §4.1, ADR 0003):
//
// - Each example contributes pages, business navigation, bilingual
//   messages, an optional default entry, optional notification-target
//   parsing and optional demo scenes under one stable id.
// - The shell (this module) validates the assembled result — duplicate
//   ids, route conflicts, Core reserved routes and unresolved messages
//   fail loudly instead of letting the last registration win.
// - Pages receive ports (params, navigate, apiClient) instead of importing
//   a concrete router; the actual Router stays in the app adapter layer.

/** Paths the Core product owns; examples may never contribute them. */
export const CORE_RESERVED_ROUTES: readonly string[] = [
  '/',
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/members',
  '/jobs',
  '/jobs/$jobId',
  '/api-keys',
  '/audit',
  '/notifications',
  '/system',
  // Reserved for the settings framework the shell introduces.
  '/settings',
  // The design-system showroom is Core-owned too.
  '/design-system',
];

export type NavigateTarget = {
  path: string;
  params?: Record<string, string | undefined>;
  search?: Record<string, unknown>;
  replace?: boolean;
  ignoreBlocker?: boolean;
};

export type NavigatePort = (target: NavigateTarget) => void;

export type AppPageProps<RouteParams extends Record<string, string>> = {
  params: RouteParams;
  search?: Record<string, unknown>;
  navigate: NavigatePort;
  apiClient: ApiClient;
};

export type AppPage<
  RouteParams extends Record<string, string> = Record<string, string>,
> = {
  path: string;
  component: (props: AppPageProps<RouteParams>) => ReactNode;
};

/** One navigation group of one example; empty groups are dropped. */
export type AppNavigationGroup = {
  id: string;
  /** Message key resolved inside the example's namespace. */
  labelKey: string;
  items: { id: string; labelKey: string; path: string }[];
};

/** Optional demo-scene declaration (rendering ships with the design-system page). */
export type AppScene = {
  id: string;
  titleKey: string;
  descriptionKey?: string;
  /**
   * Optional interactive body mounted under the scene card on the
   * design-system page. Scenes run on demo data and local state only
   * (docs/ui/design.md §6 Q9); the closure is created inside the example,
   * which keeps example-owned components out of the shell.
   */
  render?: () => ReactNode;
};

/** Small-area module identity for one navigation path (docs/ui/design.md §6 Q9). */
export type ModuleIconEntry = {
  icon: LucideIcon;
  variant: ModuleIconVariant;
};

/** Localized display info for one notification, resolved by its example. */
export type NotificationDisplay = {
  titleKey: string;
};

export type ExampleContribution = {
  id: string;
  routes: AppPage[];
  navigation: AppNavigationGroup[];
  messages: { zh: Record<string, string>; en: Record<string, string> };
  /** A contributed route used as the post-login entry when selected. */
  defaultEntry?: string;
  resolveNotificationTarget?: (
    target: NotificationTarget,
    ports: { navigate: NavigatePort },
  ) => (() => void) | undefined;
  /**
   * Localized display for notices of this example's business, resolved at
   * render time from structured data (target type and outcome) so history
   * records follow the interface language without rewriting them. Returns
   * the fully-namespaced title key; `undefined` keeps the Core fallback
   * (original server subject plus the outcome word).
   */
  describeNotification?: (
    notice: Notification,
  ) => NotificationDisplay | undefined;
  scenes?: AppScene[];
  /**
   * Module icons for this example's own route paths. Keys must be routes
   * the example contributes — an icon never outlives its example, and
   * Core-owned paths stay with the shell's core registry.
   */
  moduleIcons?: Record<string, ModuleIconEntry>;
  /** Wraps this example's pages, e.g. to provide example-owned ports. */
  provide?: (page: ReactNode) => ReactNode;
};

export type AssembledNavigationGroup = {
  id: string;
  /** Namespaced message key into AssembledApp.messages. */
  labelKey: string;
  items: { id: string; labelKey: string; path: string }[];
};

export type AssembledApp = {
  examples: string[];
  routes: (AppPage & { exampleId: string })[];
  navigation: AssembledNavigationGroup[];
  /** Locale -> namespaced message key -> text. */
  messages: { zh: Record<string, string>; en: Record<string, string> };
  /** Where login/registration sends the user; Core home is '/'. */
  defaultEntry: string;
  resolveNotificationTarget?:
    | ((
        target: NotificationTarget,
        ports: { navigate: NavigatePort },
      ) => (() => void) | undefined)
    | undefined;
  describeNotification?:
    ((notice: Notification) => NotificationDisplay | undefined) | undefined;
  scenes: AssembledScene[];
  /** Core registry entries merged with every assembled example's icons. */
  moduleIcons: Record<string, ModuleIconEntry>;
};

/** One assembled scene; its keys are namespaced and resolve in messages. */
export type AssembledScene = {
  exampleId: string;
  /** Unchanged from the contribution; unique per example. */
  id: string;
  /** Namespaced message key into AssembledApp.messages. */
  titleKey: string;
  descriptionKey?: string;
  /** Carried from the contribution; renders under the scene card. */
  render?: () => ReactNode;
};

function normalizePath(path: string): string {
  if (!path.startsWith('/'))
    throw new Error(`Route paths must be absolute: ${path}`);
  return path.replace(/\/+$/, '') || '/';
}

function validatedExample(
  example: ExampleContribution,
  seenIds: Set<string>,
  seenRoutes: Map<string, string>,
) {
  if (!example.id || /[^a-z0-9-]/.test(example.id))
    throw new Error(`Example ids must be kebab-case, got: ${example.id}`);
  if (seenIds.has(example.id))
    throw new Error(`duplicate example id: ${example.id}`);
  seenIds.add(example.id);

  for (const route of example.routes) {
    const path = normalizePath(route.path);
    if ((CORE_RESERVED_ROUTES as readonly string[]).includes(path))
      throw new Error(
        `example ${example.id} contributes the Core reserved route ${path}`,
      );
    const owner = seenRoutes.get(path);
    if (owner)
      throw new Error(
        `route ${path} is already contributed by ${owner}; example ${example.id} must pick another path`,
      );
    seenRoutes.set(path, example.id);
  }

  for (const locale of ['zh', 'en'] as const)
    if (example.messages[locale] === undefined)
      throw new Error(`example ${example.id} has no ${locale} messages`);

  const messageKey = (key: string) => `${example.id}.${key}`;

  // The declared catalog is the example's whole bilingual message set, not
  // just the labels navigation happens to use: every key needs both
  // locales, and navigation/scene keys must be declared.
  for (const key of Object.keys(example.messages.zh))
    if (!example.messages.en[key])
      throw new Error(
        `message ${messageKey(key)} has no en text in example ${example.id}`,
      );
  for (const key of Object.keys(example.messages.en))
    if (!example.messages.zh[key])
      throw new Error(
        `message ${messageKey(key)} has no zh text in example ${example.id}`,
      );

  // Navigation labels must resolve in both locales and only point at
  // routes the example itself contributes; empty groups disappear. Keys
  // may be reused across roles (a group and its first item may share one
  // label), so collection dedups instead of rejecting reuse.
  const navigation: AssembledNavigationGroup[] = [];
  const messageKeys = new Set<string>();
  for (const group of example.navigation) {
    if (group.items.length === 0) continue;
    messageKeys.add(group.labelKey);
    for (const item of group.items) {
      messageKeys.add(item.labelKey);
      if (!seenRoutes.has(normalizePath(item.path)))
        throw new Error(
          `navigation item ${group.id}/${item.id} points at ${item.path}, which example ${example.id} does not contribute`,
        );
    }
    navigation.push({
      id: `${example.id}:${group.id}`,
      labelKey: messageKey(group.labelKey),
      items: group.items.map((item) => ({
        id: `${example.id}:${item.id}`,
        labelKey: messageKey(item.labelKey),
        path: normalizePath(item.path),
      })),
    });
  }

  const scenes: AssembledScene[] = [];
  for (const scene of example.scenes ?? []) {
    messageKeys.add(scene.titleKey);
    if (scene.descriptionKey) messageKeys.add(scene.descriptionKey);
    // Namespace the scene's message keys here, as navigation labels above:
    // the namespacing rule lives in this one place and consumers resolve
    // keys directly against AssembledApp.messages.
    scenes.push({
      exampleId: example.id,
      id: scene.id,
      titleKey: messageKey(scene.titleKey),
      ...(scene.descriptionKey
        ? { descriptionKey: messageKey(scene.descriptionKey) }
        : {}),
      ...(scene.render ? { render: scene.render } : {}),
    });
  }

  for (const key of messageKeys)
    if (!(key in example.messages.zh))
      throw new Error(
        `message ${messageKey(key)} is not declared in example ${example.id}`,
      );
  const messages: Record<'zh' | 'en', Record<string, string>> = {
    zh: {},
    en: {},
  };
  for (const locale of ['zh', 'en'] as const)
    for (const key of Object.keys(example.messages[locale]))
      messages[locale][messageKey(key)] = example.messages[locale][key];

  if (example.defaultEntry !== undefined) {
    const entry = normalizePath(example.defaultEntry);
    if (!example.routes.some((route) => normalizePath(route.path) === entry))
      throw new Error(
        `example ${example.id} declares default entry ${entry} outside its own routes`,
      );
  }

  // Module icons follow the same ownership rule as navigation: an icon
  // may only dress a route the example itself contributes, so a removed
  // example takes its module color with it.
  for (const key of Object.keys(example.moduleIcons ?? {})) {
    const normalized = normalizePath(key);
    if (
      !example.routes.some((route) => normalizePath(route.path) === normalized)
    )
      throw new Error(
        `module icon ${normalized} names a path example ${example.id} does not contribute`,
      );
  }

  return { example, navigation, scenes, messages };
}

export function assembleApp({
  examples,
  defaultEntry,
}: {
  examples: ExampleContribution[];
  defaultEntry?: string;
}): AssembledApp {
  const seenIds = new Set<string>();
  const seenRoutes = new Map<string, string>();
  const assembled = examples.map((example) =>
    validatedExample(example, seenIds, seenRoutes),
  );

  const navigation = assembled.flatMap((entry) => entry.navigation);

  // Message ownership: Core's catalog registers first, each example's
  // namespaced keys join after. A fully-namespaced key may be registered
  // exactly once — an example taking over a Core or earlier-example key
  // fails the assembly instead of silently winning (docs/ui/design.md §6).
  const messages = { zh: {}, en: {} } as AssembledApp['messages'];
  const messageOwners = new Map<string, string>();
  for (const locale of ['zh', 'en'] as const)
    for (const [key, text] of Object.entries(coreMessages[locale])) {
      messages[locale][key] = text;
      messageOwners.set(key, 'core');
    }
  for (const entry of assembled)
    for (const locale of ['zh', 'en'] as const)
      for (const [key, text] of Object.entries(entry.messages[locale])) {
        // An example re-registers its own key for the second locale of the
        // bilingual pair; a different owner is a takeover and fails.
        const owner = messageOwners.get(key);
        if (owner && owner !== entry.example.id)
          throw new Error(
            `message ${key} is already owned by ${owner}; example ${entry.example.id} must pick another key`,
          );
        messages[locale][key] = text;
        messageOwners.set(key, entry.example.id);
      }

  // The assembly point may pin the default entry explicitly; otherwise the
  // first assembled example that declares one wins, and an app whose
  // examples declare none keeps the universal home.
  const selectedDefault =
    defaultEntry ??
    assembled.find((entry) => entry.example.defaultEntry !== undefined)?.example
      .defaultEntry;
  let entry = '/';
  if (selectedDefault !== undefined) {
    const normalized = normalizePath(selectedDefault);
    if ((CORE_RESERVED_ROUTES as readonly string[]).includes(normalized))
      throw new Error(
        `default entry ${normalized} is a Core reserved route; pick a business entry`,
      );
    if (!seenRoutes.has(normalized))
      throw new Error(
        `default entry ${normalized} is not a contributed route; assembly must select one of: ${[...seenRoutes.keys()].join(', ')}`,
      );
    entry = normalized;
  }

  const resolvers = assembled
    .map((entry) => entry.example.resolveNotificationTarget)
    .filter((resolver) => resolver !== undefined);
  const describers = assembled
    .map((entry) => entry.example.describeNotification)
    .filter((describe) => describe !== undefined);

  // Core registers its module colors first; examples extend the map with
  // their own (already ownership-validated) paths. Contributed routes
  // never collide with Core's, so no example can shadow a core color.
  const moduleIcons: AssembledApp['moduleIcons'] = { ...coreModuleIcons };
  for (const entry of assembled)
    for (const [path, iconEntry] of Object.entries(
      entry.example.moduleIcons ?? {},
    ))
      moduleIcons[normalizePath(path)] = iconEntry;

  return {
    examples: assembled.map((entry) => entry.example.id),
    routes: assembled.flatMap((entry) =>
      entry.example.routes.map((route) => ({
        ...route,
        exampleId: entry.example.id,
      })),
    ),
    navigation,
    messages,
    defaultEntry: entry,
    moduleIcons,
    resolveNotificationTarget:
      resolvers.length === 0
        ? undefined
        : (target, ports) => {
            for (const resolver of resolvers) {
              const open = resolver(target, ports);
              if (open) return open;
            }
            return undefined;
          },
    describeNotification:
      describers.length === 0
        ? undefined
        : (notice) => {
            for (const describe of describers) {
              const display = describe(notice);
              if (display) return display;
            }
            return undefined;
          },
    scenes: assembled.flatMap((entry) => entry.scenes),
  };
}
