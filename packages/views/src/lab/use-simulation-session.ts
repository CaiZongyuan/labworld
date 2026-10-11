import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createLabSceneInstallation,
  listLabSceneInstallations,
  listLabSimulationSessions,
  startLabSimulationSession,
  pauseLabSimulationSession,
  resumeLabSimulationSession,
  resetLabSimulationSession,
  stopLabSimulationSession,
  subscribeSimulationSessions,
  subscribeSessionMotion,
  MotionBuffer,
  MotionConnectionError,
  type ApiClient,
  type SimulationSession,
  type SimulationSessionPage,
} from '@labos-threejs/sdk';
import { errorCodeOf } from '@labos-threejs/core';
import type { ViewerMotionState } from './use-motion';

export function useSimulationSession({
  apiClient,
  userId,
  labId,
  csrfToken,
  onInstalled,
}: {
  apiClient: ApiClient;
  userId: string;
  labId: string | null;
  csrfToken: string;
  onInstalled: () => void;
}) {
  const client = useQueryClient();
  const key = useMemo(
    () => ['lab', 'simulation', apiClient.getConfig().baseUrl, userId, labId],
    [apiClient, userId, labId],
  );
  const options = {
    client: apiClient,
    path: { lab_id: labId ?? '' },
    headers: { 'x-csrf-token': csrfToken },
    throwOnError: true as const,
  };
  const sessions = useQuery({
    queryKey: key,
    enabled: !!labId,
    retry: false,
    queryFn: async ({ signal }) =>
      (await listLabSimulationSessions({ ...options, signal })).data,
  });
  const installations = useQuery({
    queryKey: [...key, 'installations'],
    enabled: !!labId,
    retry: false,
    queryFn: async ({ signal }) =>
      (await listLabSceneInstallations({ ...options, signal })).data.data,
  });
  const scope = `${apiClient.getConfig().baseUrl}:${userId}:${labId}`;
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{
    scope: string;
    error: unknown;
  } | null>(null);
  const actionOwner = useRef<AbortController | null>(null);
  const installed = useRef(onInstalled);
  installed.current = onInstalled;
  const [retry, setRetry] = useState(0);
  const [eventState, setEventState] = useState<
    'connecting' | 'live' | 'offline' | 'denied'
  >('connecting');
  const apply = useCallback(
    (next: SimulationSession) => {
      void client.cancelQueries({ queryKey: key, exact: true });
      client.setQueryData<SimulationSessionPage>(key, (previous) => {
        if (!previous) return previous;
        const old = previous.data.find((item) => item.id === next.id);
        if (old && old.revision > next.revision) return previous;
        return {
          ...previous,
          data: [next, ...previous.data.filter((item) => item.id !== next.id)],
          active_session_id: !next.ended_at
            ? next.id
            : previous.active_session_id === next.id
              ? null
              : previous.active_session_id,
        };
      });
    },
    [client, key],
  );
  useEffect(() => {
    setPending(false);
    return () => {
      actionOwner.current?.abort();
      actionOwner.current = null;
    };
  }, [scope]);
  useEffect(() => {
    if (!labId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function connect() {
      setEventState('connecting');
      // A reconnect refreshes authority even if no transition occurs afterwards.
      void client.invalidateQueries({ queryKey: key, exact: true });
      try {
        await subscribeSimulationSessions({
          client: apiClient,
          labId: labId!,
          signal: controller.signal,
          onReady() {
            if (!controller.signal.aborted) setEventState('live');
          },
          onSession(event) {
            if (controller.signal.aborted) return;
            setEventState('live');
            if (client.getQueryData(key)) apply(event.session);
            else void client.invalidateQueries({ queryKey: key, exact: true });
            if (event.session.successor_session_id)
              void client.invalidateQueries({ queryKey: key, exact: true });
          },
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (
          ['auth.unauthorized', 'api_keys.scope_forbidden'].includes(
            errorCodeOf(error) ?? '',
          )
        ) {
          setEventState('denied');
          return;
        }
      }
      if (controller.signal.aborted) return;
      setEventState('offline');
      timer = setTimeout(() => void connect(), 1000);
    }
    void connect();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [apiClient, client, key, labId, retry, apply]);
  const session =
    sessions.data?.data.find(
      (item) => item.id === sessions.data.active_session_id,
    ) ??
    sessions.data?.data
      .slice()
      .sort((a, b) => b.started_at.localeCompare(a.started_at))[0] ??
    null;
  const buffer = useMemo(
    () => new MotionBuffer(),
    [apiClient, userId, labId, csrfToken],
  );
  const [rate, setRate] = useState<15 | 30>(30);
  const [motionRetry, setMotionRetry] = useState(0);
  const [motionState, setMotionState] =
    useState<ViewerMotionState>('disconnected');
  const [motionError, setMotionError] = useState<unknown>(null);
  const [observing, setObserving] = useState(true);
  const observeId =
    session && (!session.ended_at || session.status === 'interrupted')
      ? session.id
      : null;
  const sceneHash = session?.snapshot.installation.scene_hash;
  const lease = session?.lease_id ?? null;
  const epoch = session?.epoch ?? null;
  const terminal = session?.ended_at ? session.status : null;
  useEffect(() => {
    if (terminal === 'interrupted' && observing && labId) {
      buffer.freeze();
      buffer.setSourceState('interrupted');
      setMotionState('interrupted');
      setMotionError(null);
      return;
    }
    buffer.clear();
    setMotionError(null);
    if (!observing || !observeId || !labId || !sceneHash) {
      setMotionState('disconnected');
      return;
    }
    if (lease === null || epoch === null) {
      setMotionState('waiting');
      return;
    }
    const controller = new AbortController();
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const delays = [250, 500, 1000, 2000, 4000, 4000];
    let failures = 0;
    async function connect() {
      if (controller.signal.aborted) return;
      setMotionState('connecting');
      try {
        await subscribeSessionMotion({
          client: apiClient,
          labId: labId!,
          sessionId: observeId!,
          sceneHash: sceneHash!,
          rateHz: rate,
          headers: { 'x-csrf-token': csrfToken },
          signal: controller.signal,
          onWelcome(welcome) {
            if (controller.signal.aborted) return;
            buffer.configure(welcome);
            setMotionError(null);
            buffer.setSourceState('waiting');
            setMotionState('waiting');
          },
          onSnapshot(snapshot, receivedAt) {
            if (controller.signal.aborted) return;
            if (!buffer.push(snapshot, receivedAt))
              throw new Error('Untrusted Session snapshot');
            failures = 0;
          },
          onStatus(status) {
            if (controller.signal.aborted) return;
            if (status.type !== 'motion.status') return;
            buffer.setSourceState(status.state);
            setMotionState(status.state);
          },
        });
      } catch (error: unknown) {
        if (controller.signal.aborted) return;
        buffer.disconnect();
        setMotionError(error);
        const reason =
          error instanceof MotionConnectionError
            ? error.reason
            : errorCodeOf(error);
        const denied = [
          'auth.unauthorized',
          'auth.csrf',
          'api_keys.scope_forbidden',
          'lab.session_closed',
          'lab.session_not_found',
          'lab.publisher_unauthorized',
          'session_closed',
          'unauthorized',
          'mapping_mismatch',
          'epoch_mismatch',
          'wrong_session',
          'metadata_regression',
          'sequence_regression',
        ].includes(reason ?? '');
        if (denied || failures >= delays.length) {
          setMotionState('error');
          return;
        }
        setMotionState('stale');
        reconnectTimer = setTimeout(() => void connect(), delays[failures++]);
      }
    }
    void connect();
    const timer = setInterval(
      () =>
        setMotionState((previous) =>
          ['waiting', 'live', 'stale', 'paused'].includes(previous)
            ? buffer.freshness(performance.now())
            : previous,
        ),
      250,
    );
    return () => {
      controller.abort();
      clearTimeout(reconnectTimer);
      clearInterval(timer);
      buffer.freeze();
    };
  }, [
    apiClient,
    labId,
    csrfToken,
    observeId,
    sceneHash,
    buffer,
    rate,
    motionRetry,
    observing,
    terminal,
    lease,
    epoch,
  ]);
  async function write(
    action: 'install' | 'start' | 'pause' | 'resume' | 'reset' | 'stop',
    id?: string,
  ) {
    if (!labId || pending) return;
    const controller = new AbortController();
    actionOwner.current?.abort();
    actionOwner.current = controller;
    setPending(true);
    setFailure(null);
    try {
      const request = { ...options, signal: controller.signal };
      if (action === 'install') {
        await createLabSceneInstallation({
          ...request,
          body: { representation_id: id! },
        });
        if (controller.signal.aborted) return;
        await client.invalidateQueries({ queryKey: [...key, 'installations'] });
        installed.current();
      } else {
        const next =
          action === 'start'
            ? (
                await startLabSimulationSession({
                  ...request,
                  body: { installation_id: id! },
                })
              ).data
            : session
              ? (
                  await {
                    pause: pauseLabSimulationSession,
                    resume: resumeLabSimulationSession,
                    reset: resetLabSimulationSession,
                    stop: stopLabSimulationSession,
                  }[action]({
                    ...request,
                    path: { lab_id: labId, session_id: session.id },
                    body: { expected_revision: session.revision },
                  })
                ).data
              : null;
        if (controller.signal.aborted) return;
        if (next) {
          apply(next);
          setObserving(true);
        }
        void client.invalidateQueries({ queryKey: key, exact: true });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setFailure({ scope, error });
        void client.invalidateQueries({ queryKey: key, exact: true });
      }
    } finally {
      if (!controller.signal.aborted && actionOwner.current === controller)
        setPending(false);
    }
  }
  return {
    sessions,
    installations,
    session,
    pending,
    error:
      failure?.scope === scope
        ? failure.error
        : (sessions.error ?? installations.error),
    eventState,
    buffer,
    motionState,
    motionError,
    rate,
    setRate,
    write,
    observing,
    setObserving,
    retry() {
      setFailure(null);
      setRetry((value) => value + 1);
      setMotionRetry((value) => value + 1);
      void sessions.refetch();
      void installations.refetch();
    },
  };
}
