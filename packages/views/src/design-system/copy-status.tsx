import { useState, type ReactNode } from 'react';
import { useAppMessage } from '../shell/messages';

// Copy affordances shared by the design-system sections (docs/ui/design.md §6
// Q9): every copy reports through a text status region — never through
// color alone — and failures stay visible instead of failing silently.

export function useCopyStatus(copyText: (text: string) => Promise<void>): {
  copy: (text: string, label?: string) => Promise<void>;
  status: ReactNode;
} {
  const message = useAppMessage();
  const [status, setStatus] = useState<ReactNode>(null);
  const copy = async (text: string, label?: string) => {
    try {
      await copyText(text);
      setStatus(message('design.copiedValue', { value: label ?? text }));
    } catch {
      setStatus(message('design.copyFailed'));
    }
  };
  const node =
    status !== null ? (
      <p role="status" className="text-sm text-muted-foreground">
        {status}
      </p>
    ) : null;
  return { copy, status: node };
}
