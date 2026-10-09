import {
  ActivityIcon,
  BellIcon,
  HouseIcon,
  HistoryIcon,
  KeyRoundIcon,
  RefreshCwIcon,
  SettingsIcon,
  ShapesIcon,
  UsersIcon,
} from 'lucide-react';
import type { ModuleIconEntry } from './app-contract';

// The shell-owned half of the module registry (docs/ui/design.md §6 Q9):
// every sidebar-visible Core page maps to one fixed category color,
// declared explicitly here rather than derived from an algorithm. Example
// modules register their own paths through ExampleContribution.moduleIcons
// and the assembler merges the two halves — a removed example therefore
// removes its color with it. Auth pages render without the sidebar and
// stay out of the registry.

export const coreModuleIcons: Record<string, ModuleIconEntry> = {
  '/': { icon: HouseIcon, variant: 'blue' },
  '/notifications': { icon: BellIcon, variant: 'amber' },
  '/members': { icon: UsersIcon, variant: 'violet' },
  '/jobs': { icon: RefreshCwIcon, variant: 'cyan' },
  '/audit': { icon: HistoryIcon, variant: 'purple' },
  '/api-keys': { icon: KeyRoundIcon, variant: 'green' },
  '/design-system': { icon: ShapesIcon, variant: 'pink' },
  '/system': { icon: ActivityIcon, variant: 'orange' },
  '/settings': { icon: SettingsIcon, variant: 'teal' },
};
