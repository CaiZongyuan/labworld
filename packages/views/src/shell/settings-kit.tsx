import { useId, type ReactNode } from 'react';
import { Laptop, UserRound } from 'lucide-react';
import { Card, CardContent, CardDescription } from '@labos-threejs/ui/components/card';

// The settings layout kit (docs/ui/design.md §3, after the multica
// reference): a page-level tab wrapper, anchored sections, label/control
// rows with shared width tiers, and a plain card that groups rows with
// hairline dividers. Presentational only — callers resolve bilingual
// messages and own their state, so the kit stays out of the assembly
// contract.

/** Where a setting takes effect; the badge says so nobody has to guess. */
export type SettingsScope = 'account' | 'device';

/** Anchor attribute search results and legacy `?section=` links scroll to. */
export const SETTINGS_ANCHOR_ATTR = 'data-settings-anchor';

export function SettingsScopeBadge({
  scope,
  label,
}: {
  scope: SettingsScope;
  label: string;
}) {
  const Icon = scope === 'account' ? UserRound : Laptop;
  return (
    <span
      data-slot="settings-scope"
      className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-muted px-2 text-xs font-medium text-muted-foreground"
    >
      <Icon aria-hidden="true" className="size-3" />
      <span>{label}</span>
    </span>
  );
}

export function SettingsTab({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Page-level actions, aligned with the title. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-8">
      <header className="flex min-w-0 items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">{title}</h1>
          {description ? (
            <CardDescription className="mt-2">{description}</CardDescription>
          ) : null}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}

export function SettingsSection({
  title,
  description,
  scope,
  scopeLabel,
  action,
  anchor,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  scope?: SettingsScope;
  /** Bilingual label for the scope badge; required when scope is set. */
  scopeLabel?: string;
  action?: ReactNode;
  /** Target for deep links (`?section=<anchor>`). */
  anchor?: string;
  /** A section may be header-only (e.g. title, hint and a section action). */
  children?: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      className="scroll-mt-6 flex flex-col gap-3"
      aria-labelledby={title ? headingId : undefined}
      data-settings-anchor={anchor}
    >
      {title || description || action ? (
        <div className="flex min-w-0 items-end justify-between gap-4">
          <div className="min-w-0">
            {title ? (
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <h3 id={headingId} className="text-sm font-semibold">
                  {title}
                </h3>
                {scope && scopeLabel ? (
                  <SettingsScopeBadge scope={scope} label={scopeLabel} />
                ) : null}
              </div>
            ) : null}
            {description ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function SettingsCard({ children }: { children: ReactNode }) {
  return (
    <Card variant="plain">
      <CardContent className="divide-y divide-border">{children}</CardContent>
    </Card>
  );
}

/**
 * Width tiers for the control column. Within a card, every text-entry
 * control shares the `text` tier so their edges align; a row may only
 * drop to a smaller tier when the field is deliberately short — the
 * difference must read as intentional. Pick a tier instead of adding
 * per-row ad-hoc widths.
 */
const SETTINGS_CONTROL_WIDTHS = {
  /** Text inputs and textareas — the standard control column. */
  text: 'sm:w-96',
  /** Selects with long option labels. */
  'select-wide': 'sm:w-72',
  /** Compact enum selects (theme, language). */
  select: 'sm:w-48',
  /** Short fixed-format codes. */
  code: 'sm:w-40',
} as const;

export type SettingsControlSize = keyof typeof SETTINGS_CONTROL_WIDTHS;

export function SettingsRow({
  label,
  description,
  children,
  size,
}: {
  label: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Control column width tier; omit for content-hugging controls. */
  size?: SettingsControlSize;
}) {
  return (
    <div
      className={
        'flex min-h-16 gap-4 py-4 sm:justify-between sm:gap-8 ' +
        (size
          ? 'flex-col sm:flex-row'
          : 'flex-row items-center justify-between')
      }
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        {description ? (
          <div className="mt-0.5 text-sm leading-5 text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
      <div
        className={
          'shrink-0 sm:max-w-[56%] ' +
          (size ? `w-full ${SETTINGS_CONTROL_WIDTHS[size]}` : 'w-auto')
        }
      >
        {children}
      </div>
    </div>
  );
}
