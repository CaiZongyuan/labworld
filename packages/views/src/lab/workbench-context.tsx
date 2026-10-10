import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  getLabWorld,
  listLabs,
  type ApiClient,
  type CurrentSession,
  type LabRecord,
} from '@labos-threejs/sdk';
import { errorCodeOf } from '@labos-threejs/core';
import { sessionKey } from '../identity/session';
import type { NavigatePort } from '../shell/app-contract';
import type {
  CommandAttempt,
  EntityCommandAttempts,
  DeviceInput,
  SourceAttempt,
} from './device-panel';
import type { LayoutDraft } from './layout-editor';
import { useWorldSubscription } from './world-subscription';

export type WorkbenchView = 'space' | 'records' | 'overview' | 'devices';

type LayoutStatus = 'idle' | 'saved' | 'conflict';
export type WorkbenchProps = {
  apiClient: ApiClient;
  identity: CurrentSession;
  search: Record<string, unknown>;
  navigate: NavigatePort;
};

function useWorkbenchController({
  apiClient,
  identity,
  search,
  navigate,
}: WorkbenchProps) {
  const client = useQueryClient();
  const key = useMemo(
    () => ['lab', 'world', apiClient.getConfig().baseUrl, identity.user.id],
    [apiClient, identity.user.id],
  );
  const labs = useInfiniteQuery({
    queryKey: [...key, 'labs'],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ signal, pageParam }) =>
      (
        await listLabs({
          client: apiClient,
          query: { cursor: pageParam, limit: 50 },
          signal,
          throwOnError: true,
        })
      ).data,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    retry: false,
  });
  const labList = labs.data?.pages.flatMap((page) => page.data) ?? [];
  const invalidLink = ['lab', 'entity'].some(
    (field) =>
      search[field] !== undefined &&
      (typeof search[field] !== 'string' || !String(search[field]).trim()),
  );
  const viewUnavailable =
    search.view !== undefined &&
    (typeof search.view !== 'string' ||
      !['space', 'records', 'overview', 'devices'].includes(search.view));
  const view: WorkbenchView =
    !viewUnavailable && typeof search.view === 'string'
      ? (search.view as WorkbenchView)
      : 'space';
  const labId = invalidLink
    ? ''
    : typeof search.lab === 'string'
      ? search.lab
      : (labList[0]?.id ?? '');
  const entityId = typeof search.entity === 'string' ? search.entity : '';
  const world = useQuery({
    queryKey: [...key, labId],
    enabled: !!labId,
    queryFn: async ({ signal }) => {
      const next = (
        await getLabWorld({
          client: apiClient,
          path: { lab_id: labId },
          signal,
          throwOnError: true,
        })
      ).data;
      const previous = client.getQueryData<typeof next>([...key, labId]);
      return previous?.version &&
        next.version &&
        BigInt(previous.version) > BigInt(next.version)
        ? previous
        : next;
    },
    retry: false,
  });
  const connection = useWorldSubscription(
    apiClient,
    identity.user.id,
    errorCodeOf(world.error) === 'lab.world_not_found' ? '' : labId,
  );
  const currentLab = useRef<string | null>(labId);
  useEffect(() => {
    currentLab.current = labId;
    return () => {
      currentLab.current = null;
    };
  }, [labId]);
  const isCurrentLab = (origin: string) => currentLab.current === origin;
  const [multipleSelection, setMultipleSelection] = useState<{
    labId: string;
    entityId: string;
    ids: string[];
  } | null>(null);
  const selection =
    multipleSelection?.labId === labId &&
    multipleSelection.entityId === entityId
      ? multipleSelection.ids
      : entityId
        ? [entityId]
        : [];
  function location(nextLab: string, nextEntity?: string) {
    navigate({
      path: '/lab',
      search: {
        lab: nextLab || undefined,
        entity: nextEntity || undefined,
        view: search.view === undefined ? undefined : view,
      },
    });
  }
  function setView(next: WorkbenchView) {
    navigate({
      path: '/lab',
      search: {
        lab: labId || undefined,
        entity: entityId || undefined,
        view: next,
      },
    });
  }
  function setActiveLab(next: string) {
    if (isCurrentLab(labId)) location(next);
  }
  function openSpace() {
    navigate({
      path: '/lab',
      replace: true,
      search: {
        lab:
          typeof search.lab === 'string' && search.lab.trim()
            ? search.lab
            : undefined,
        entity:
          typeof search.entity === 'string' && search.entity.trim()
            ? search.entity
            : undefined,
      },
    });
  }
  function setSelection(change: SetStateAction<string[]>) {
    if (!isCurrentLab(labId)) return;
    setRecordChoice(null);
    const ids = typeof change === 'function' ? change(selection) : change;
    const nextEntity = ids.at(-1) ?? '';
    setMultipleSelection({ labId, entityId: nextEntity, ids });
    location(labId, nextEntity);
  }
  const [node, setNode] = useState<{ labId: string; id: string | null } | null>(
    null,
  );
  const nodeSelection = node?.labId === labId ? node.id : null;
  function setNodeSelection(id: string | null) {
    if (isCurrentLab(labId)) setNode({ labId, id });
  }
  const [recordChoice, setRecordChoice] = useState<{
    labId: string;
    record: LabRecord;
  } | null>(null);
  const selectedRecord =
    recordChoice?.labId === labId && recordChoice.record.entity_id === entityId
      ? recordChoice.record
      : null;
  function clearRecord() {
    setRecordChoice(null);
  }
  function openRecord(record: LabRecord) {
    if (!isCurrentLab(labId)) return;
    setMultipleSelection({
      labId,
      entityId: record.entity_id,
      ids: [record.entity_id],
    });
    setNode({ labId, id: null });
    setRecordChoice({ labId, record });
    navigate({
      path: '/lab',
      search: { lab: labId, entity: record.entity_id, view: 'space' },
    });
  }
  const [drafts, setDrafts] = useState<Record<string, LayoutDraft>>({});
  const [statuses, setStatuses] = useState<Record<string, LayoutStatus>>({});
  const layoutStatus = statuses[labId] ?? 'idle';
  function setLayoutStatus(change: SetStateAction<LayoutStatus>) {
    setStatuses((previous) => ({
      ...previous,
      [labId]:
        typeof change === 'function'
          ? change(previous[labId] ?? 'idle')
          : change,
    }));
  }
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const layoutPending = pending[labId] ?? false;
  function setLayoutPending(value: boolean) {
    setPending((previous) => ({ ...previous, [labId]: value }));
  }
  const [allAttempts, setAllAttempts] = useState<
    Record<string, Record<string, EntityCommandAttempts>>
  >({});
  const deviceScope = JSON.stringify([
    apiClient.getConfig().baseUrl,
    identity.user.id,
    labId,
  ]);
  const attempts = allAttempts[deviceScope] ?? {};
  function setCommandAttempt(entityId: string, attempt: CommandAttempt) {
    setAllAttempts((previous) => {
      const scope = previous[deviceScope] ?? {};
      const entity = scope[entityId] ?? {};
      const prior = entity[attempt.input.capability];
      if (attempt.phase !== 'submitting' && prior?.key !== attempt.key)
        return previous;
      return {
        ...previous,
        [deviceScope]: {
          ...scope,
          [entityId]: { ...entity, [attempt.input.capability]: attempt },
        },
      };
    });
  }
  const [allInputs, setAllInputs] = useState<
    Record<string, Record<string, DeviceInput>>
  >({});
  const deviceInputs = allInputs[deviceScope] ?? {};
  function setDeviceInput(entityId: string, input: DeviceInput) {
    setAllInputs((previous) => ({
      ...previous,
      [deviceScope]: { ...previous[deviceScope], [entityId]: input },
    }));
  }
  const [allSourceAttempts, setAllSourceAttempts] = useState<
    Record<string, Record<string, SourceAttempt>>
  >({});
  const sourceAttempts = allSourceAttempts[deviceScope] ?? {};
  function setSourceAttempt(entityId: string, attempt: SourceAttempt) {
    setAllSourceAttempts((previous) => {
      if (
        attempt.phase !== 'submitting' &&
        previous[deviceScope]?.[entityId]?.key !== attempt.key
      )
        return previous;
      return {
        ...previous,
        [deviceScope]: { ...previous[deviceScope], [entityId]: attempt },
      };
    });
  }
  async function mutation(operation: () => Promise<unknown>) {
    try {
      if (world.data && connection.status !== 'live')
        throw new Error('Lab connection is unavailable');
      await operation();
      await Promise.all([
        client.invalidateQueries({ queryKey: [...key, labId], exact: true }),
        client.invalidateQueries({ queryKey: [...key, 'labs'] }),
      ]);
    } catch (cause) {
      if (['auth.unauthorized', 'auth.csrf'].includes(errorCodeOf(cause) ?? ''))
        await client.invalidateQueries({ queryKey: sessionKey(apiClient) });
      throw cause;
    }
  }
  return {
    apiClient,
    identity,
    key,
    labs,
    labList,
    labId,
    world,
    connection,
    trendRevision: `${world.data?.version ?? '0'}:${connection.generation ?? 0}`,
    selection,
    setSelection,
    nodeSelection,
    setNodeSelection,
    drafts,
    setDrafts,
    layoutStatus,
    setLayoutStatus,
    layoutPending,
    setLayoutPending,
    attempts,
    setCommandAttempt,
    deviceInputs,
    setDeviceInput,
    sourceAttempts,
    setSourceAttempt,
    setActiveLab,
    mutation,
    invalidLink,
    viewUnavailable,
    view,
    setView,
    selectedRecord,
    openRecord,
    clearRecord,
    openSpace,
  };
}

const WorkbenchContext = createContext<ReturnType<
  typeof useWorkbenchController
> | null>(null);

export function WorkbenchProvider({
  children,
  ...props
}: WorkbenchProps & { children: ReactNode }) {
  const value = useWorkbenchController(props);
  return (
    <WorkbenchContext.Provider value={value}>
      {children}
    </WorkbenchContext.Provider>
  );
}

export function useLabWorkbench() {
  const value = useContext(WorkbenchContext);
  if (!value) throw new Error('Lab work views require WorkbenchProvider');
  return value;
}
