import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createMotionFixture,
  getMotionFixture,
  MotionBuffer,
  subscribeMotion,
  type ApiClient,
  type SyntheticMotionFixture,
} from '@labos-threejs/sdk';

export type ViewerMotionState =
  | 'disconnected'
  | 'connecting'
  | 'waiting'
  | 'live'
  | 'stale'
  | 'interrupted'
  | 'closed'
  | 'error';

export function useMotion({
  apiClient,
  labId,
  csrfToken,
  onFixtureCreated,
}: {
  apiClient: ApiClient;
  labId: string | null;
  csrfToken: string;
  onFixtureCreated: () => void;
}) {
  const buffer = useMemo(
    () => new MotionBuffer(),
    [apiClient, labId, csrfToken],
  );
  const owner = useRef<AbortController | null>(null);
  const [state, setState] = useState<ViewerMotionState>('disconnected');
  const [fixture, setFixture] = useState<SyntheticMotionFixture | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [rate, setRate] = useState<15 | 30>(30);
  useEffect(() => {
    setState('disconnected');
    setFixture(null);
    setError(null);
    return () => {
      owner.current?.abort();
      owner.current = null;
      buffer.clear();
    };
  }, [buffer]);

  function leave() {
    owner.current?.abort();
    owner.current = null;
    buffer.clear();
    setState('disconnected');
    setError(null);
  }

  async function join(preferredRate: 15 | 30, representationId?: string) {
    if (!labId) return;
    owner.current?.abort();
    const abort = new AbortController();
    owner.current = abort;
    buffer.clear();
    setState('connecting');
    setError(null);
    try {
      const options = {
        client: apiClient,
        labId,
        signal: abort.signal,
        headers: { 'x-csrf-token': csrfToken },
      };
      const next = representationId
        ? await createMotionFixture({ ...options, representationId })
        : await getMotionFixture(options);
      if (abort.signal.aborted) return;
      setFixture(next);
      if (representationId) onFixtureCreated();
      setRate(preferredRate);
      await subscribeMotion({
        ...options,
        sessionId: next.session_id,
        sceneHash: next.scene_hash,
        rateHz: preferredRate,
        onWelcome: (welcome) => {
          buffer.configure(welcome);
          buffer.setSourceState('waiting');
          setRate(welcome.rate_hz);
          setState('waiting');
        },
        onSnapshot: (snapshot, received) => {
          if (!buffer.push(snapshot, received))
            throw new Error('Untrusted motion snapshot');
        },
        onStatus: (status) => {
          if (status.type !== 'motion.status') return;
          setRate(status.rate_hz);
          buffer.setSourceState(status.state);
          setState(buffer.freshness(performance.now()));
        },
      });
    } catch (cause) {
      if (!abort.signal.aborted && owner.current === abort) {
        buffer.freeze();
        setError(cause);
        setState('error');
      }
    }
  }

  const receiving = ['waiting', 'live', 'stale'].includes(state);
  useEffect(() => {
    if (!receiving) return;
    const timer = setInterval(() => {
      if (!owner.current || owner.current.signal.aborted) return;
      const freshness = buffer.freshness(performance.now());
      setState((previous) =>
        ['waiting', 'live', 'stale'].includes(previous) ? freshness : previous,
      );
    }, 250);
    return () => clearInterval(timer);
  }, [buffer, receiving]);
  return { buffer, state, fixture, error, rate, join, leave };
}
