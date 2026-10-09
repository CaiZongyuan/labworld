import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  defaultGraphic,
  parseGraphic,
  type GraphicChoice,
  type GraphicKind,
} from './graphic-choice';

const CHANGE_EVENT = 'labos-threejs-graphic-preference-change';
const sessionChoices = new Map<string, string>();

function read(key: string | undefined): string {
  if (!key) return '';
  const session = sessionChoices.get(key);
  if (session !== undefined) return session;
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

export function useGraphicPreference(
  userId: string | undefined,
  entity: string,
  kind: GraphicKind,
): [GraphicChoice, (choice: GraphicChoice) => void] {
  const key = userId
    ? `labos-threejs.graphic.v1:${encodeURIComponent(userId)}:${encodeURIComponent(entity)}`
    : undefined;
  const subscribe = useCallback(
    (notify: () => void) => {
      const changed = (event: Event) => {
        if (event instanceof StorageEvent) {
          if (event.key !== null && event.key !== key) return;
          if (key) sessionChoices.delete(key);
        }
        notify();
      };
      window.addEventListener(CHANGE_EVENT, changed);
      window.addEventListener('storage', changed);
      return () => {
        window.removeEventListener(CHANGE_EVENT, changed);
        window.removeEventListener('storage', changed);
      };
    },
    [key],
  );
  const raw = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => '',
  );
  const seed =
    kind === 'user' ? `user:${userId ?? 'anonymous'}` : `collection:${entity}`;
  const choice = useMemo(() => {
    try {
      if (raw && raw.length <= 2048) {
        const parsed = parseGraphic(JSON.parse(raw), kind);
        if (parsed) return parsed;
      }
    } catch {
      /* Invalid stored preferences fall back to the stable identity. */
    }
    return defaultGraphic(kind, seed);
  }, [raw, kind, seed]);
  const setChoice = useCallback(
    (next: GraphicChoice) => {
      if (!key) return;
      const valid = parseGraphic(next, kind);
      if (!valid) return;
      const serialized = JSON.stringify(valid);
      try {
        window.localStorage.setItem(key, serialized);
        sessionChoices.delete(key);
      } catch {
        sessionChoices.set(key, serialized);
      }
      window.dispatchEvent(new Event(CHANGE_EVENT));
    },
    [key, kind],
  );
  return [choice, setChoice];
}
