import { useCallback, useEffect, useRef, useState } from 'react';
import { retryAfterSeconds } from '@labos-threejs/core';
import { useAppMessage } from '../shell/messages';

export function RateLimitHint({
  error,
  inline = false,
}: {
  error: unknown;
  inline?: boolean;
}) {
  const message = useAppMessage();
  const seconds = retryAfterSeconds(error);
  const Tag = inline ? 'span' : 'p';
  return seconds ? (
    <Tag>{message('common.rateLimitHint', { seconds })}</Tag>
  ) : null;
}

/** Start only from a completed request; neither this timer nor Query retries submit again. */
export function useRetryDelay() {
  const [remaining, setRemaining] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const mounted = useRef(true);
  const stop = useCallback(() => {
    if (timer.current !== undefined) clearInterval(timer.current);
    timer.current = undefined;
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop();
    };
  }, [stop]);
  const start = useCallback(
    (error: unknown) => {
      if (!mounted.current) return;
      stop();
      const seconds = retryAfterSeconds(error) ?? 0;
      setRemaining(seconds);
      if (!seconds) return;
      const deadline = Date.now() + seconds * 1000;
      timer.current = setInterval(() => {
        const next = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        if (mounted.current) setRemaining(next);
        if (next === 0) stop();
      }, 250);
    },
    [stop],
  );
  return { remaining, start };
}
