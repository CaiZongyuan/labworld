import type { ApiClient } from '@labos-threejs/sdk';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ModuleIconVariant } from '@labos-threejs/ui/components/module-icon';

export type NavigateTarget = {
  path: string;
  params?: Record<string, string | undefined>;
  search?: Record<string, unknown>;
  replace?: boolean;
  ignoreBlocker?: boolean;
};
export type NavigatePort = (target: NavigateTarget) => void;
export type AppPageProps = {
  params: Record<string, string>;
  search?: Record<string, unknown>;
  navigate: NavigatePort;
  apiClient: ApiClient;
};
export type AppPage = {
  path: string;
  component: (props: AppPageProps) => ReactNode;
};
export type ModuleIconEntry = {
  icon: LucideIcon;
  variant: ModuleIconVariant;
};
export type AppScene = {
  id: string;
  moduleId: string;
  titleKey: string;
  descriptionKey?: string;
  render?: () => ReactNode;
};
/** The Lab application supplies resolved data to the shared shell and router. */
export type AppDefinition = {
  routes: AppPage[];
  navigation: {
    id: string;
    labelKey: string;
    items: { id: string; labelKey: string; path: string }[];
  }[];
  messages: { zh: Record<string, string>; en: Record<string, string> };
  defaultEntry: string;
  scenes: AppScene[];
  moduleIcons: Record<string, ModuleIconEntry>;
};
