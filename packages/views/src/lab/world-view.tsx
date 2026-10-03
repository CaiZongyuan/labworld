import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import { cn } from 'cn';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Activity,
  Box,
  Crosshair,
  Grid2X2,
  Layers3,
  ListTree,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Save,
  Play,
  Undo2,
  Minus,
  Copy,
  Move,
  RotateCw,
  Scaling,
} from 'lucide-react';
import {
  createLab,
  configureLabEntity,
  createLabSceneNode,
  getLabWorld,
  listLabs,
  listAssetDefinitions,
  registerLabEntity,
  saveLabLayout,
  copyLabEntity,
  type ApiClient,
  type CurrentSession,
  type LabEntity,
  type Placement,
} from '@labos-threejs/sdk';
import { Button } from '@labos-threejs/ui/components/button';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Input } from '@labos-threejs/ui/components/input';
import { Tabs, TabsList, TabsTrigger } from '@labos-threejs/ui/components/tabs';
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@labos-threejs/ui/components/toggle-group';
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@labos-threejs/ui/components/empty';
import { Alert, AlertDescription } from '@labos-threejs/ui/components/alert';
import {
  NativeSelect,
  NativeSelectOption,
} from '@labos-threejs/ui/components/native-select';
import { usePreferences } from '../shell/preferences';
import { useAppMessage } from '../shell/messages';
import { ErrorAlert } from '../shell/error-alert';
import { errorCodeOf } from '@labos-threejs/core';
import { sessionKey } from '../identity/session';
import { useCatalog, type ModelAsset } from './catalog';
import { PerformancePanel, Tool } from './view-controls';
import { ViewportBoundary } from './viewport-boundary';
import type { RenderMetrics } from './viewport-state';
import WorldDialog, {
  type WorldDialogMode,
  type WorldSubmission,
} from './world-dialog';
import DevicePanel, { type CommandAttempt } from './device-panel';
import RelationshipPanel from './relationship-panel';
import {
  layoutDraft,
  rebaseLayout,
  PlacementEditor,
  type LayoutDraft,
} from './layout-editor';
import './lab.css';
import './world.css';

const WorldViewport = lazy(() => import('./world-viewport'));

export default function WorldView({
  apiClient,
  identity,
}: {
  apiClient: ApiClient;
  identity: CurrentSession;
}) {
  const message = useAppMessage('lab');
  const { locale, resolvedTheme } = usePreferences();
  const client = useQueryClient();
  const key = ['lab', 'world', apiClient.getConfig().baseUrl, identity.user.id];
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
  const definitions = useQuery({
    queryKey: [...key, 'definitions'],
    queryFn: async ({ signal }) =>
      (
        await listAssetDefinitions({
          client: apiClient,
          signal,
          throwOnError: true,
        })
      ).data.data,
    retry: false,
  });
  const catalog = useCatalog(apiClient, identity);
  const [activeLab, setActiveLab] = useState('');
  const labId = activeLab || labList[0]?.id || '';
  const world = useQuery({
    queryKey: [...key, labId],
    enabled: !!labId,
    queryFn: async ({ signal }) =>
      (
        await getLabWorld({
          client: apiClient,
          path: { lab_id: labId },
          signal,
          throwOnError: true,
        })
      ).data,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.entities.some(
        (entity) => entity.program_run?.status === 'running',
      )
        ? 1000
        : false,
  });
  const [attempts, setAttempts] = useState<Record<string, CommandAttempt>>({});
  const [selection, setSelection] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [unplacedOnly, setUnplacedOnly] = useState(false);
  const [dialog, setDialog] = useState<WorldDialogMode | null>(null);
  const [grid, setGrid] = useState(true);
  const [fit, setFit] = useState(0);
  const [renderVersion, setRenderVersion] = useState(0);
  const [renderBusy, setRenderBusy] = useState(false);
  const [performance, setPerformance] = useState(false);
  const [metrics, setMetrics] = useState<RenderMetrics | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [nodePending, setNodePending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [transformMode, setTransformMode] = useState<
    'translate' | 'rotate' | 'scale'
  >('translate');
  const [drafts, setDrafts] = useState<Record<string, LayoutDraft>>({});
  const [layoutStatus, setLayoutStatus] = useState<
    'idle' | 'saved' | 'conflict'
  >('idle');
  const [layoutPending, setLayoutPending] = useState(false);
  const [nodeSelection, setNodeSelection] = useState<string | null>(null);
  const draft = drafts[labId];
  const nodes = useMemo(
    () => draft?.nodes ?? world.data?.nodes ?? [],
    [draft?.nodes, world.data?.nodes],
  );
  const placedIds = useMemo(
    () => new Set(nodes.map((node) => node.entity_id)),
    [nodes],
  );
  const entities = world.data?.entities ?? [];
  const modelAssets = useMemo(
    () =>
      world.data?.assets.map((asset): ModelAsset => ({
        id: asset.id,
        name: asset.name,
        fileName: asset.representation.file_name,
        bytes: asset.representation.size,
        source: 'remote',
        asset,
        apiClient,
      })) ?? [],
    [world.data?.assets, apiClient],
  );
  const selected = entities.find((entity) => entity.id === selection.at(-1));
  const activeNode =
    nodes.find(
      (node) => node.id === nodeSelection && node.entity_id === selected?.id,
    ) ?? nodes.find((node) => node.entity_id === selected?.id);
  const visible = entities.filter(
    (entity) =>
      (!kind || entity.kind === kind) &&
      (!unplacedOnly || !placedIds.has(entity.id)) &&
      entity.name.toLowerCase().includes(search.toLowerCase()),
  );
  const select = useCallback(
    (id: string | null, additive: boolean, nodeId?: string) => {
      setNodeSelection(nodeId ?? null);
      if (id === null) {
        setSelection([]);
        return;
      }
      setSelection((previous) =>
        additive
          ? previous.includes(id)
            ? previous.filter((entry) => entry !== id)
            : [...previous, id]
          : [id],
      );
    },
    [],
  );
  function changeDraft(change: (current: LayoutDraft) => LayoutDraft) {
    if (!world.data || layoutPending) return;
    const snapshot = world.data;
    setDrafts((previous) => ({
      ...previous,
      [labId]: change(previous[labId] ?? layoutDraft(snapshot)),
    }));
    setLayoutStatus((previous) =>
      previous === 'conflict' ? 'conflict' : 'idle',
    );
  }
  function changePlacement(id: string, placement: Placement) {
    changeDraft((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === id ? { ...node, placement } : node,
      ),
    }));
  }
  async function saveLayout() {
    if (!draft || layoutPending) return;
    setLayoutPending(true);
    setError(null);
    try {
      await mutation(() =>
        saveLabLayout({
          client: apiClient,
          headers: { 'x-csrf-token': identity.csrf_token },
          path: { lab_id: labId },
          body: {
            expected_version: draft.version,
            nodes: draft.nodes.map(
              ({ id, entity_id, representation_id, placement }) => ({
                id,
                entity_id,
                representation_id,
                placement,
              }),
            ),
            relationships: draft.relationships,
          },
          throwOnError: true,
        }),
      );
      setDrafts((previous) => {
        const next = { ...previous };
        delete next[labId];
        return next;
      });
      setLayoutStatus('saved');
    } catch (cause) {
      if (errorCodeOf(cause) === 'lab.layout_conflict')
        setLayoutStatus('conflict');
      else setError(cause);
    } finally {
      setLayoutPending(false);
    }
  }
  async function reloadLayout(keep: boolean) {
    setLayoutPending(true);
    setError(null);
    try {
      const latest = await world.refetch();
      if (latest.error) throw latest.error;
      if (latest.data) {
        const snapshot = latest.data;
        setDrafts((previous) => {
          const next = { ...previous };
          if (keep && previous[labId])
            next[labId] = rebaseLayout(previous[labId], snapshot);
          else delete next[labId];
          return next;
        });
        if (!keep) setLayoutStatus('idle');
      }
    } catch (cause) {
      setError(cause);
    } finally {
      setLayoutPending(false);
    }
  }
  async function mutation(operation: () => Promise<unknown>) {
    try {
      await operation();
      await client.invalidateQueries({ queryKey: key });
    } catch (cause) {
      if (['auth.unauthorized', 'auth.csrf'].includes(errorCodeOf(cause) ?? ''))
        await client.invalidateQueries({ queryKey: sessionKey(apiClient) });
      throw cause;
    }
  }
  async function submit(submission: WorldSubmission) {
    const headers = { 'x-csrf-token': identity.csrf_token };
    await mutation(async () => {
      if (submission.kind === 'lab') {
        const { data } = await createLab({
          client: apiClient,
          headers,
          body: submission.input,
          throwOnError: true,
        });
        setActiveLab(data.id);
        setSelection([]);
      } else if (submission.kind === 'register') {
        const { data } = await registerLabEntity({
          client: apiClient,
          headers,
          path: { lab_id: labId },
          body: submission.input,
          throwOnError: true,
        });
        setSelection([data.id]);
      } else {
        await configureLabEntity({
          client: apiClient,
          headers,
          path: { lab_id: labId, entity_id: submission.entityId },
          body: submission.input,
          throwOnError: true,
        });
      }
    });
  }
  async function addRepresentation(entity: LabEntity) {
    if (editing) {
      const node = {
        id: crypto.randomUUID(),
        lab_id: labId,
        entity_id: entity.id,
        representation_id:
          activeNode?.representation_id ?? entity.representation_id,
        placement: {
          position: activeNode
            ? activeNode.placement.position.map((value, index) =>
                index === 0 ? value + 0.8 : value,
              )
            : [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      };
      changeDraft((current) => ({
        ...current,
        nodes: [...current.nodes, node],
      }));
      setNodeSelection(node.id);
      return;
    }
    setNodePending(true);
    setError(null);
    const offset = (world.data?.nodes.length ?? 0) * 1.5;
    try {
      await mutation(() =>
        createLabSceneNode({
          client: apiClient,
          headers: { 'x-csrf-token': identity.csrf_token },
          path: { lab_id: labId },
          body: {
            entity_id: entity.id,
            representation_id: entity.representation_id,
            placement: {
              position: [offset, 0, 0],
              rotation: [0, 0, 0],
              scale: [1, 1, 1],
            },
          },
          throwOnError: true,
        }),
      );
    } catch (cause) {
      setError(cause);
    } finally {
      setNodePending(false);
    }
  }
  async function copyEntity(entity: LabEntity) {
    if (!world.data || draft || nodePending) return;
    const snapshot = world.data;
    setNodePending(true);
    setError(null);
    try {
      await mutation(async () => {
        const { data } = await copyLabEntity({
          client: apiClient,
          headers: { 'x-csrf-token': identity.csrf_token },
          path: { lab_id: labId, entity_id: entity.id },
          body: {
            expected_version: snapshot.lab.layout_version,
            name: message('layout.copyName', {
              name: Array.from(entity.name).slice(0, 110).join(''),
            }),
            placement: {
              position: activeNode
                ? activeNode.placement.position.map((value, index) =>
                    index === 0 ? value + 0.8 : value,
                  )
                : [0, 0, 0],
              rotation: activeNode?.placement.rotation ?? [0, 0, 0],
              scale: activeNode?.placement.scale ?? [1, 1, 1],
            },
          },
          throwOnError: true,
        });
        setSelection([data.id]);
        setNodeSelection(null);
      });
    } catch (cause) {
      setError(cause);
    } finally {
      setNodePending(false);
    }
  }
  const failure =
    error ||
    labs.error ||
    definitions.error ||
    catalog.query.error ||
    world.error;
  const busy = labs.isPending || (!!labId && world.isPending) || renderBusy;
  return (
    <section className="lab-page world-page" aria-busy={busy}>
      <header className="lab-toolbar">
        <div className="lab-heading">
          <Box />
          <h1>{world.data?.lab.name ?? 'Lab'}</h1>
          {labId ? (
            <Badge variant="outline">
              v{world.data?.lab.layout_version ?? 0}
            </Badge>
          ) : null}
        </div>
        <div className="lab-toolbar-actions">
          {labList.length ? (
            <NativeSelect
              aria-label={message('world.openLab')}
              value={labId}
              onChange={(event) => {
                setActiveLab(event.target.value);
                setSelection([]);
                setLayoutStatus('idle');
              }}
            >
              {labList.map((lab) => (
                <NativeSelectOption key={lab.id} value={lab.id}>
                  {lab.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ) : null}
          {labs.hasNextPage ? (
            <Button
              variant="outline"
              size="sm"
              disabled={labs.isFetchingNextPage}
              onClick={() => void labs.fetchNextPage()}
            >
              {message('assets.loadMore')}
            </Button>
          ) : null}
          <Tool
            icon={Plus}
            label={message('world.createLab')}
            onClick={() => setDialog('lab')}
          />
          <Button
            size="sm"
            onClick={() => setDialog('register')}
            disabled={
              !world.data ||
              !!draft ||
              !definitions.data ||
              catalog.query.isPending ||
              catalog.query.isError
            }
          >
            <Plus data-icon="inline-start" />
            {message('world.register')}
          </Button>
          <Tool
            icon={RefreshCw}
            label={message('assets.retry')}
            onClick={() => {
              setError(null);
              setRenderVersion((value) => value + 1);
              void client.invalidateQueries({ queryKey: key });
              void catalog.query.refetch();
            }}
          />
        </div>
      </header>
      <div className="world-layout-toolbar">
        <Tabs
          value={editing ? 'layout' : 'runtime'}
          onValueChange={(value) => setEditing(value === 'layout')}
        >
          <TabsList aria-label={message('layout.mode')}>
            <TabsTrigger value="runtime">
              <Play data-icon="inline-start" />
              {message('layout.runtime')}
            </TabsTrigger>
            <TabsTrigger value="layout">
              <Pencil data-icon="inline-start" />
              {message('layout.edit')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <span role="status" aria-label={message('layout.status')}>
          {message(
            draft
              ? 'layout.unsaved'
              : layoutStatus === 'saved'
                ? 'layout.saved'
                : 'layout.clean',
          )}
        </span>
        {editing ? (
          <div className="world-layout-actions">
            <Tool
              icon={Save}
              label={message(
                layoutStatus === 'conflict'
                  ? 'layout.retrySave'
                  : 'layout.save',
              )}
              disabled={!draft || layoutPending}
              onClick={() => void saveLayout()}
            />
            <Tool
              icon={Undo2}
              label={message('layout.discard')}
              disabled={!draft || layoutPending}
              onClick={() => void reloadLayout(false)}
            />
          </div>
        ) : null}
      </div>
      {layoutStatus === 'conflict' && draft ? (
        <Alert className="world-layout-conflict">
          <AlertDescription>{message('layout.conflict')}</AlertDescription>
          <Button
            variant="outline"
            size="sm"
            disabled={layoutPending}
            onClick={() => void reloadLayout(true)}
          >
            <RefreshCw data-icon="inline-start" />
            {message('layout.reloadKeep')}
          </Button>
        </Alert>
      ) : null}
      {failure ? (
        <div className="lab-error">
          <ErrorAlert error={failure} title={message('assets.error')} />
        </div>
      ) : null}
      <div className="world-body">
        <aside
          className="world-directory"
          aria-label={message('world.directory')}
        >
          <header>
            <ListTree />
            <h2>{message('world.directory')}</h2>
            <span>{entities.length}</span>
          </header>
          <div className="world-filters">
            <div className="world-search">
              <Search />
              <Input
                type="search"
                aria-label={message('world.search')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <NativeSelect
              aria-label={message('world.kind')}
              value={kind}
              onChange={(event) => setKind(event.target.value)}
            >
              <NativeSelectOption value="">
                {message('assets.all')}
              </NativeSelectOption>
              {[
                'instrument',
                'iot',
                'sensor',
                'robot',
                'labware',
                'furniture',
                'location',
                'model',
              ].map((value) => (
                <NativeSelectOption key={value} value={value}>
                  {message(`assets.category.${value}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <label className="world-unplaced-filter">
            <input
              type="checkbox"
              checked={unplacedOnly}
              onChange={(event) => setUnplacedOnly(event.target.checked)}
            />
            {message('layout.unplacedOnly')}
          </label>
          <div className="world-object-list">
            {visible.map((entity) => (
              <div
                key={entity.id}
                className={cn(
                  'world-object',
                  selection.includes(entity.id) && 'selected',
                )}
              >
                <input
                  type="checkbox"
                  aria-label={message('world.toggleNamed', {
                    name: entity.name,
                  })}
                  checked={selection.includes(entity.id)}
                  onChange={() => select(entity.id, true)}
                />
                <Button
                  variant="ghost"
                  className="h-auto whitespace-normal"
                  aria-label={message('world.selectNamed', {
                    name: entity.name,
                  })}
                  aria-pressed={selection.includes(entity.id)}
                  onClick={(event) => select(entity.id, event.shiftKey)}
                >
                  <Box data-icon="inline-start" />
                  <span>
                    <strong>{entity.name}</strong>
                    <small>
                      {entity.definition_id} · {entity.definition_version}
                      {!placedIds.has(entity.id)
                        ? ` · ${message('layout.unplaced')}`
                        : ''}
                    </small>
                  </span>
                  <i />
                </Button>
              </div>
            ))}
          </div>
          {!busy && !visible.length ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>
                  {message(
                    entities.length ? 'assets.noResults' : 'world.emptyObjects',
                  )}
                </EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : null}
        </aside>
        <div className="lab-viewport world-viewport">
          {world.data ? (
            typeof WebGL2RenderingContext !== 'undefined' ? (
              <ViewportBoundary
                resetKey={`${labId}-${renderVersion}`}
                fallback={
                  <Alert className="world-render-error">
                    <AlertDescription>
                      {message('import.failed')}
                    </AlertDescription>
                  </Alert>
                }
              >
                <Suspense
                  fallback={
                    <div className="lab-loading" role="status">
                      {message('viewer.loading')}
                    </div>
                  }
                >
                  <WorldViewport
                    key={`${labId}-${renderVersion}`}
                    world={draft ? { ...world.data, nodes } : world.data}
                    assets={modelAssets}
                    selected={selection}
                    onSelect={select}
                    activeNodeId={activeNode?.id}
                    transformMode={
                      editing && !layoutPending ? transformMode : null
                    }
                    onPlacement={changePlacement}
                    dark={resolvedTheme === 'dark'}
                    grid={grid}
                    fit={fit}
                    label={message('viewer.viewport')}
                    onMetrics={setMetrics}
                    onBusy={setRenderBusy}
                  />
                </Suspense>
              </ViewportBoundary>
            ) : (
              <Alert className="world-render-error">
                <AlertDescription>
                  {message('viewer.unavailable')}
                </AlertDescription>
              </Alert>
            )
          ) : (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Box />
                </EmptyMedia>
                <EmptyTitle>
                  {message(busy ? 'viewer.loading' : 'world.noLab')}
                </EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
          <div className="world-canvas-tools">
            <Tool
              icon={Crosshair}
              label={message('viewer.focus')}
              onClick={() => setFit((value) => value + 1)}
            />
            <Tool
              icon={Grid2X2}
              label={message('viewer.grid')}
              active={grid}
              onClick={() => setGrid(!grid)}
            />
            <Tool
              icon={Activity}
              label={message('viewer.performance')}
              active={performance}
              onClick={() => setPerformance(!performance)}
            />
          </div>
          {editing ? (
            <ToggleGroup
              className="world-transform-tools"
              multiple={false}
              value={[transformMode]}
              onValueChange={(value) => {
                if (value[0])
                  setTransformMode(value[0] as typeof transformMode);
              }}
              aria-label={message('layout.transform')}
            >
              <ToggleGroupItem
                value="translate"
                aria-label={message('layout.translate')}
                title={message('layout.translate')}
              >
                <Move />
              </ToggleGroupItem>
              <ToggleGroupItem
                value="rotate"
                aria-label={message('layout.rotation')}
                title={message('layout.rotation')}
              >
                <RotateCw />
              </ToggleGroupItem>
              <ToggleGroupItem
                value="scale"
                aria-label={message('layout.scale')}
                title={message('layout.scale')}
              >
                <Scaling />
              </ToggleGroupItem>
            </ToggleGroup>
          ) : null}
          {performance ? <PerformancePanel metrics={metrics} /> : null}
        </div>
        <aside
          className="lab-inspector world-inspector"
          aria-label={message('world.inspector')}
        >
          <header className="lab-inspector-heading">
            <Layers3 />
            <h2>{message('world.inspector')}</h2>
            <span>{selection.length}</span>
          </header>
          {selected ? (
            <>
              <section className="lab-inspector-section">
                <div className="lab-section-heading">
                  <h3>{selected.name}</h3>
                  <Tool
                    icon={Pencil}
                    label={message('world.configure')}
                    onClick={() => setDialog(selected)}
                  />
                </div>
                <dl className="world-properties">
                  <dt>Entity</dt>
                  <dd>{selected.id}</dd>
                  <dt>Lab</dt>
                  <dd>{selected.lab_id}</dd>
                  <dt>{message('world.definitionVersion')}</dt>
                  <dd>
                    {selected.definition_id} · {selected.definition_version}
                  </dd>
                  <dt>{message('world.reality')}</dt>
                  <dd>{message(`world.${selected.reality}`)}</dd>
                  <dt>{message('world.label')}</dt>
                  <dd>
                    {typeof selected.configuration?.label === 'string'
                      ? selected.configuration.label
                      : '-'}
                  </dd>
                  <dt>{message('world.binding')}</dt>
                  <dd>
                    {selected.binding?.program_id ?? message('world.noBinding')}
                  </dd>
                  <dt>{message('world.observation')}</dt>
                  <dd>
                    {selected.observation
                      ? message(
                          `device.freshness.${selected.observation.freshness}`,
                        )
                      : message('world.unknown')}
                  </dd>
                </dl>
              </section>
              <DevicePanel
                key={selected.id}
                entity={selected}
                apiClient={apiClient}
                identity={identity}
                attempt={attempts[selected.id]}
                onAttempt={(attempt) =>
                  setAttempts((previous) => ({
                    ...previous,
                    [selected.id]: attempt,
                  }))
                }
                onRefresh={world.refetch}
              />
              {world.data ? (
                <RelationshipPanel
                  key={`relationships-${selected.id}`}
                  world={world.data}
                  entity={selected}
                  relationships={
                    draft?.relationships ??
                    layoutDraft(world.data).relationships
                  }
                  editing={editing}
                  disabled={layoutPending}
                  onChange={(relationships) =>
                    changeDraft((current) => ({ ...current, relationships }))
                  }
                />
              ) : null}
              <section className="lab-inspector-section">
                <h3>{message('world.nodes')}</h3>
                {nodes
                  .filter((node) => node.entity_id === selected.id)
                  .map((node) => (
                    <div className="world-node" key={node.id}>
                      <code>{node.id}</code>
                      {editing ? (
                        <div className="world-node-actions">
                          <Tool
                            icon={Pencil}
                            label={message('layout.selectNode')}
                            active={node.id === activeNode?.id}
                            disabled={layoutPending}
                            onClick={() => setNodeSelection(node.id)}
                          />
                          <Tool
                            icon={Minus}
                            label={message('layout.removeNode')}
                            disabled={layoutPending}
                            onClick={() =>
                              changeDraft((current) => ({
                                ...current,
                                nodes: current.nodes.filter(
                                  (entry) => entry.id !== node.id,
                                ),
                              }))
                            }
                          />
                        </div>
                      ) : null}
                      <span>{node.placement.position.join(', ')} m</span>
                      <small>
                        {node.representation_id ??
                          message('world.builtinAppearance')}
                      </small>
                    </div>
                  ))}
                {editing && activeNode ? (
                  <PlacementEditor
                    node={activeNode}
                    disabled={layoutPending}
                    onChange={(placement) =>
                      changePlacement(activeNode.id, placement)
                    }
                  />
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    nodePending || layoutPending || (!editing && !!draft)
                  }
                  onClick={() => void addRepresentation(selected)}
                >
                  <Plus data-icon="inline-start" />
                  {message('world.addRepresentation')}
                </Button>
                {editing ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="world-copy"
                    disabled={!!draft || nodePending || layoutPending}
                    onClick={() => void copyEntity(selected)}
                  >
                    <Copy data-icon="inline-start" />
                    {message('layout.copy')}
                  </Button>
                ) : null}
              </section>
              <section className="lab-inspector-section">
                <h3>{message('assets.capabilities')}</h3>
                {selected.capabilities.length ? (
                  selected.capabilities.map((capability) => (
                    <div className="world-capability" key={capability.id}>
                      <code>{capability.id}</code>
                      <small>v{capability.version}</small>
                      <Badge variant="outline">
                        {message(
                          capability.binding_implemented
                            ? 'assets.implemented'
                            : 'assets.declared',
                        )}
                      </Badge>
                      <dl>
                        <dt>{message('world.supported')}</dt>
                        <dd>
                          {message(
                            capability.definition_supported
                              ? 'world.yes'
                              : 'world.no',
                          )}
                        </dd>
                        <dt>{message('world.bindingImplemented')}</dt>
                        <dd>
                          {message(
                            capability.binding_implemented
                              ? 'world.yes'
                              : 'world.no',
                          )}
                        </dd>
                        <dt>{message('world.executable')}</dt>
                        <dd>
                          {message(
                            capability.executable ? 'world.yes' : 'world.no',
                          )}
                        </dd>
                      </dl>
                      {!capability.executable &&
                      capability.reason === 'binding_not_implemented' ? (
                        <small>{message('world.noBinding')}</small>
                      ) : null}
                      {capability.reason === 'program_not_running' ? (
                        <small>{message('device.not_started')}</small>
                      ) : null}
                      {capability.reason === 'runtime_unavailable' ? (
                        <small>{message('device.runtimeUnavailable')}</small>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <p>{message('assets.none')}</p>
                )}
              </section>
              <section className="lab-inspector-section">
                <h3>{message('assets.specifications')}</h3>
                <dl className="world-properties">
                  {Object.entries(selected.definition.specifications ?? {}).map(
                    ([name, value]) => (
                      <div key={name}>
                        <dt>{name}</dt>
                        <dd>
                          {typeof value === 'object'
                            ? JSON.stringify(value)
                            : String(value)}
                        </dd>
                      </div>
                    ),
                  )}
                </dl>
                <small>
                  {locale === 'en'
                    ? selected.definition.name_en
                    : selected.definition.name}
                </small>
              </section>
            </>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{message('viewer.unselected')}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
        </aside>
      </div>
      <footer className="lab-status">
        <span>
          <i />
          {entities.length} {message('world.objects')} / {nodes.length}{' '}
          {message('world.nodes')}
        </span>
        <span>{selected?.name ?? message('viewer.unselected')}</span>
        <span>{message(draft ? 'layout.unsaved' : 'assets.saved')}</span>
      </footer>
      {dialog ? (
        <WorldDialog
          key={typeof dialog === 'object' ? dialog.id : dialog}
          mode={dialog}
          definitions={definitions.data ?? []}
          assets={catalog.assets.flatMap((asset) =>
            asset.source === 'remote' ? [asset.asset] : [],
          )}
          onClose={() => setDialog(null)}
          onSubmit={submit}
          hasMoreAssets={!!catalog.query.hasNextPage}
          loadingAssets={catalog.query.isFetchingNextPage}
          onMoreAssets={() => void catalog.query.fetchNextPage()}
        />
      ) : null}
    </section>
  );
}
