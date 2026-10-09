import type { ReactNode } from 'react';
import {
  NativeSelect,
  NativeSelectOption,
} from '@labos-threejs/ui/components/native-select';
import { useAppMessage } from './messages';

export type SettingsEntry = { id: string; label: string };

export function SettingsLayout({
  entries,
  selected,
  onSelect,
  children,
}: {
  entries: SettingsEntry[];
  selected: string;
  onSelect: (id: string) => void;
  children: ReactNode;
}) {
  const message = useAppMessage();
  return (
    <div className="settings-frame">
      <aside className="settings-sidebar">
        <h2>{message('settings.title')}</h2>
        <nav aria-label={message('settings.directory')}>
          {entries.map((entry) => (
            <a
              key={entry.id}
              href={`/settings?section=${entry.id}`}
              aria-current={selected === entry.id ? 'page' : undefined}
              onClick={(event) => {
                if (
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                onSelect(entry.id);
              }}
            >
              {entry.label}
            </a>
          ))}
        </nav>
        <label className="settings-mobile-directory">
          {message('settings.directory')}
          <NativeSelect
            value={selected}
            onChange={(event) => onSelect(event.target.value)}
          >
            {entries.map((entry) => (
              <NativeSelectOption key={entry.id} value={entry.id}>
                {entry.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      </aside>
      <div className="settings-workspace">{children}</div>
    </div>
  );
}
