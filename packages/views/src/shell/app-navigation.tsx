import { ModuleIcon } from '@labos-threejs/ui/components/module-icon';
import type { AppDefinition } from './app-contract';
import { useAppMessage } from './messages';

// One sidebar link shape everywhere (shell and assembled groups alike).
// Compact h-9 on desktop; the drawer keeps the 44px touch target. Links
// carry their module icon (registry lookups are optional data — an entry
// without one still renders) before the label.
export const sidebarLinkClass =
  'app-nav-link flex h-11 items-center gap-2.5 rounded-md px-3 text-sm text-muted-foreground hover:bg-accent lg:h-9 ';

export function navigationActive(
  currentPath: string | undefined,
  path: string,
) {
  return (
    currentPath === path ||
    (path !== '/' && currentPath?.startsWith(path + '/') === true)
  );
}

// Renders the assembled business navigation groups. The shell never
// inspects which example a group came from — groups carry their own
// resolved labels, and the assembler already dropped empty ones. The
// landmark (`nav`) belongs to the shell layout around this renderer.

export function BusinessNavigation({
  navigation,
  moduleIcons,
  onOpen,
  currentPath,
}: {
  navigation: AppDefinition['navigation'];
  moduleIcons?: AppDefinition['moduleIcons'];
  onOpen: (path: string) => void;
  currentPath?: string;
}) {
  const message = useAppMessage();
  return (
    <div className="flex flex-col gap-4">
      {navigation.map((group) => (
        <div key={group.id} className="flex flex-col gap-1">
          <h3 className="app-nav-group-label px-3 text-xs font-medium text-muted-foreground">
            {message(group.labelKey)}
          </h3>
          {group.items.map((item) => {
            const icon = moduleIcons?.[item.path];
            return (
              <a
                key={item.id}
                href={item.path}
                className={sidebarLinkClass.trim()}
                aria-current={
                  navigationActive(currentPath, item.path) ? 'page' : undefined
                }
                aria-label={message(item.labelKey)}
                title={message(item.labelKey)}
                onClick={(event) => {
                  if (
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  event.preventDefault();
                  onOpen(item.path);
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
                <span className="app-nav-label">{message(item.labelKey)}</span>
              </a>
            );
          })}
        </div>
      ))}
    </div>
  );
}
