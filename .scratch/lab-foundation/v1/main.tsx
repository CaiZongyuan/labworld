// PROTOTYPE v1. One coherent experience follows the accepted shell and Foundation V1 decisions.
import { createRoot } from 'react-dom/client';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Activity,
  Archive,
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpRight,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  Crosshair,
  Database,
  FileBox,
  FolderOpen,
  Grid2X2,
  Layers3,
  ListTree,
  LoaderCircle,
  MapPin,
  Maximize,
  MoreHorizontal,
  MousePointer2,
  Move3D,
  PanelLeftClose,
  PanelRightOpen,
  Play,
  Plus,
  Radio,
  RotateCcw,
  RotateCw,
  Save,
  Search,
  Settings2,
  Square,
  Terminal,
  Trash2,
  Upload,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { Button } from '@labos-threejs/ui/components/button';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Input } from '@labos-threejs/ui/components/input';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@labos-threejs/ui/components/field';
import { Tabs, TabsList, TabsTrigger } from '@labos-threejs/ui/components/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@labos-threejs/ui/components/dialog';
import {
  NativeSelect,
  NativeSelectOption,
} from '@labos-threejs/ui/components/native-select';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@labos-threejs/ui/components/alert';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
} from '@labos-threejs/ui/components/empty';
import { Skeleton } from '@labos-threejs/ui/components/skeleton';
import { AppShellLayout } from '../../../packages/views/src/shell/app-shell';
import { AppMessagesProvider } from '../../../packages/views/src/shell/messages';
import {
  PreferencesProvider,
  usePreferences,
} from '../../../packages/views/src/shell/preferences';
import { assembleApp } from '../../../packages/views/src/shell/app-contract';
import Inspector from './Inspector';
import {
  EntityIcon,
  Miniature,
  Status,
  Tool,
  duration,
  time,
  type Translate,
} from './ui';
import {
  addEntity,
  archive,
  command,
  createLab,
  deleteAsset,
  duplicate,
  importAsset,
  initialize,
  patchEntity,
  reopen,
  reset,
  save,
  scenario,
  setSpeed,
  snapshot,
  useWorld,
  worldResult,
  type Asset,
  type Entity,
} from './world';
import './preview.css';

const LabScene = lazy(() => import('./LabScene'));
const app = assembleApp({
  defaultEntry: '/lab',
  examples: [
    {
      id: 'lab',
      defaultEntry: '/lab',
      routes: [
        { path: '/lab', component: () => null },
        { path: '/assets', component: () => null },
      ],
      navigation: [
        {
          id: 'lab',
          labelKey: 'group',
          items: [
            { id: 'world', labelKey: 'world', path: '/lab' },
            { id: 'assets', labelKey: 'assets', path: '/assets' },
          ],
        },
      ],
      messages: {
        zh: { group: '实验室', world: 'Lab', assets: '资产库' },
        en: { group: 'Laboratory', world: 'Lab', assets: 'Asset Library' },
      },
      moduleIcons: {
        '/lab': { icon: Box, variant: 'teal' },
        '/assets': { icon: FileBox, variant: 'blue' },
      },
    },
  ],
});

function EntityRow({
  e,
  selected,
  select,
  t,
  locale,
}: {
  e: Entity;
  selected: boolean;
  select: () => void;
  t: Translate;
  locale: string;
}) {
  const d = useWorld((s) => s.devices[e.id]);
  const connected = useWorld((s) => s.meta.connection);
  return (
    <button
      className={`entity-row${selected ? ' selected' : ''}${e.archived ? ' archived' : ''}`}
      onClick={select}
      aria-pressed={selected}
    >
      <EntityIcon kind={e.kind} />
      <span>
        <strong>{locale === 'zh' ? e.name : e.en}</strong>
        <small>
          {e.archived
            ? t('已归档', 'Archived')
            : !e.visible
              ? t('未放入场景', 'Not placed')
              : e.id}
        </small>
      </span>
      <i
        className={`entity-dot ${!connected ? 'warning' : !d?.program ? 'muted' : d.phase === 'running' ? 'active' : 'success'}`}
      />
    </button>
  );
}
function ObjectTree({ selectedId, select, t, locale, onAdd }: any) {
  const entities = useWorld((s) => s.layout.entities);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('active');
  const shown = entities.filter(
    (e) =>
      (filter === 'all' ||
        (filter === 'archived' ? e.archived : !e.archived)) &&
      `${e.name} ${e.en} ${e.id}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <aside
      className="object-tree"
      aria-label={t('对象目录', 'Entity directory')}
    >
      <div className="panel-heading">
        <span>
          <ListTree />
          {t('对象目录', 'Entities')}
          <small>{entities.filter((e) => !e.archived).length}</small>
        </span>
        <Tool icon={Plus} label={t('添加对象', 'Add entity')} onClick={onAdd} />
      </div>
      <div className="tree-search">
        <Search />
        <Input
          aria-label={t('搜索对象', 'Search entities')}
          placeholder={t('搜索对象…', 'Search entities…')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <div className="tree-filter">
        <span>
          <ChevronDown />
          {t('实验室', 'Laboratory')}
        </span>
        <NativeSelect
          aria-label={t('对象范围', 'Entity filter')}
          size="sm"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        >
          <NativeSelectOption value="active">
            {t('活动对象', 'Active')}
          </NativeSelectOption>
          <NativeSelectOption value="all">
            {t('全部', 'All')}
          </NativeSelectOption>
          <NativeSelectOption value="archived">
            {t('已归档', 'Archived')}
          </NativeSelectOption>
        </NativeSelect>
      </div>
      <div className="tree-rows">
        {shown.length ? (
          <>
            {[
              'centrifuge',
              'sensor',
              'light',
              'robot',
              'labware',
              'bench',
              'environment',
              'model',
            ].map((kind) =>
              shown
                .filter((e) => e.kind === kind)
                .map((e) => (
                  <EntityRow
                    key={e.id}
                    e={e}
                    selected={e.id === selectedId}
                    select={() => select(e.id)}
                    locale={locale}
                    t={t}
                  />
                )),
            )}
          </>
        ) : (
          <p className="tree-no-results">
            {t('没有匹配的对象', 'No matching entities')}
          </p>
        )}
      </div>
      <div className="tree-footer">
        <div>
          <i />
          {t('同一个世界', 'One shared world')}
        </div>
        <span>
          {t('用户与 Agent 共享对象和状态', 'Shared by people and agents')}
        </span>
      </div>
    </aside>
  );
}
function ActivityPanel({ locale, t, onSelect }: any) {
  const events = useWorld((s) => s.events);
  const tasks = useWorld((s) => s.tasks);
  const [tab, setTab] = useState('events');
  return (
    <section className="activity-panel">
      <div className="activity-heading">
        <Tabs value={tab} onValueChange={(value) => setTab(value as string)}>
          <TabsList variant="line">
            <TabsTrigger value="events">
              <Activity />
              {t('事件', 'Events')}
              <small>{events.length}</small>
            </TabsTrigger>
            <TabsTrigger value="tasks">
              <Clock3 />
              {t('任务', 'Tasks')}
              <small>{tasks.length}</small>
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <span>
          {t('设备与操作记录', 'Device and action history')}
          <Badge variant="outline">30 d</Badge>
        </span>
      </div>
      <div className="activity-rows">
        {tab === 'events' ? (
          events.slice(0, 30).map((event) => (
            <button
              className="event-row"
              key={event.id}
              onClick={() =>
                event.entityId !== 'lab' && onSelect(event.entityId)
              }
            >
              <time>{time(event.at, locale)}</time>
              <i className={`event-dot ${event.tone}`} />
              <span>{locale === 'zh' ? event.title : event.en}</span>
              <code>{event.entityId}</code>
              <small>{event.actor}</small>
            </button>
          ))
        ) : tasks.length ? (
          tasks.map((task) => (
            <button
              className="event-row task-row"
              key={task.id}
              onClick={() => onSelect(task.entityId)}
            >
              <time>{time(task.startedAt, locale)}</time>
              <Badge
                variant={
                  task.state === 'completed'
                    ? 'success'
                    : task.state === 'running'
                      ? 'info'
                      : 'secondary'
                }
              >
                {task.state}
              </Badge>
              <span>
                {task.rpm.toLocaleString()} rpm · {task.temperature} °C ·{' '}
                {duration(task.remaining)}
              </span>
              <code>{task.entityId}</code>
              <small>{task.actor}</small>
            </button>
          ))
        ) : (
          <div className="no-tasks">
            <Clock3 />
            <span>
              {t(
                '从设备详情启动第一个任务，运行记录会出现在这里。',
                'Start a device task to see its progress and result here.',
              )}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
function AssetPicker({
  t,
  locale,
  onChoose,
  compact = false,
  notify,
}: {
  t: Translate;
  locale: string;
  onChoose: (asset: Asset) => void;
  compact?: boolean;
  notify: (message: string, error?: boolean) => void;
}) {
  const assets = useWorld((s) => s.assets);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [pending, setPending] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const all = assets.filter(
    (a) =>
      (category === 'all' || a.categoryEn === category) &&
      `${a.name} ${a.en} ${a.category}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const onFile = async (file?: File) => {
    if (!file) return;
    setPending(true);
    try {
      const asset = await importAsset(file);
      notify(t('外观已导入资产库', 'Model imported'));
      if (compact) onChoose(asset);
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setPending(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <div className={compact ? 'asset-picker compact' : 'asset-picker'}>
      <div className="catalog-search">
        <div>
          <Search />
          <Input
            placeholder={t(
              '搜索资产名称或类别…',
              'Search assets or categories…',
            )}
            aria-label={t('搜索资产', 'Search assets')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => input.current?.click()}
        >
          {pending ? (
            <LoaderCircle data-icon="inline-start" className="spin" />
          ) : (
            <Upload data-icon="inline-start" />
          )}
          {t('导入 GLB', 'Import GLB')}
        </Button>
        <input
          ref={input}
          type="file"
          accept=".glb"
          className="sr-only"
          aria-label={t('选择 GLB 文件', 'Choose GLB file')}
          onChange={(event) => void onFile(event.target.files?.[0])}
        />
      </div>
      <div className="asset-filter-row">
        <NativeSelect
          value={category}
          size="sm"
          aria-label={t('资产类别', 'Asset category')}
          onChange={(e) => setCategory(e.target.value)}
        >
          <NativeSelectOption value="all">
            {t('所有类别', 'All categories')}
          </NativeSelectOption>
          {Array.from(
            new Map(assets.map((a) => [a.categoryEn, a.category])).entries(),
          ).map(([en, zh]) => (
            <NativeSelectOption value={en} key={en}>
              {t(zh, en)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <span>
          {all.length}{' '}
          {t('个可复用定义与外观', 'reusable definitions and models')}
        </span>
      </div>
      <div className="asset-grid">
        {all.map((asset) => (
          <article className="asset-card" key={asset.id}>
            <div className="asset-card-visual">
              <Miniature kind={asset.kind} />
              <Badge variant="outline">
                {locale === 'zh' ? asset.category : asset.categoryEn}
              </Badge>
            </div>
            <div className="asset-card-copy">
              <h3>{locale === 'zh' ? asset.name : asset.en}</h3>
              <p>{locale === 'zh' ? asset.description : asset.descriptionEn}</p>
              <div>
                <code>
                  {asset.fileName ? '.glb' : `definition v${asset.version}`}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onChoose(asset)}
                >
                  <Plus data-icon="inline-start" />
                  {t('加入 Lab', 'Add to Lab')}
                </Button>
                {asset.fileName ? (
                  <Tool
                    icon={Trash2}
                    label={t('删除资产', 'Delete asset')}
                    onClick={() => {
                      try {
                        deleteAsset(asset.id);
                        notify(t('资产已删除', 'Asset removed'));
                      } catch (error) {
                        notify((error as Error).message, true);
                      }
                    }}
                  />
                ) : null}
              </div>
            </div>
          </article>
        ))}
      </div>
      {!all.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t('没有匹配的资产', 'No matching assets')}</EmptyTitle>
            <EmptyDescription>
              {t(
                '更换关键词或导入一个 GLB。',
                'Try another search or import a GLB.',
              )}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
    </div>
  );
}
function AgentClient({ open, onOpenChange, t, locale, select }: any) {
  const entities = useWorld((s) => s.layout.entities);
  const [id, setId] = useState('centrifuge-01');
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const read = () => {
    setResult(worldResult(id));
    if (id) select(id);
  };
  const call = async (action: 'start' | 'stop') => {
    setBusy(true);
    try {
      const response = await command(
        id,
        action,
        { rpm: 12000, temperature: 4, minutes: 10 },
        'Agent',
      );
      select(id);
      setResult(response);
    } catch (error) {
      setResult({ accepted: false, reason: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="agent-dialog">
        <div className="dialog-title-row">
          <DialogTitle>{t('Agent 客户端', 'Agent client')}</DialogTitle>
          <Tool
            icon={X}
            label={t('关闭', 'Close')}
            onClick={() => onOpenChange(false)}
          />
        </div>
        <DialogDescription>
          {t(
            '预览工具：请求在浏览器中的模拟世界执行，和用户界面共享同一对象。',
            'Preview tool: requests run in the simulated browser world, shared with the user interface.',
          )}
        </DialogDescription>
        <FieldGroup>
          <Field>
            <FieldLabel>{t('目标对象', 'Target entity')}</FieldLabel>
            <NativeSelect
              className="w-full"
              value={id}
              onChange={(e) => setId(e.target.value)}
            >
              <NativeSelectOption value="">
                {t('整个实验室', 'Whole laboratory')}
              </NativeSelectOption>
              {entities
                .filter((e) => !e.archived)
                .map((e) => (
                  <NativeSelectOption key={e.id} value={e.id}>
                    {locale === 'zh' ? e.name : e.en} · {e.id}
                  </NativeSelectOption>
                ))}
            </NativeSelect>
          </Field>
        </FieldGroup>
        <div className="agent-actions">
          <Button size="sm" variant="outline" onClick={read}>
            <Search data-icon="inline-start" />
            world.get
          </Button>
          <Button
            size="sm"
            disabled={!id || busy}
            onClick={() => void call('start')}
          >
            <Play data-icon="inline-start" />
            Start
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!id || busy}
            onClick={() => void call('stop')}
          >
            <Square data-icon="inline-start" />
            Stop
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              try {
                const created = addEntity(
                  'light',
                  t('Agent 创建的照明', 'Agent-created light'),
                  'Agent',
                );
                setId(created);
                select(created);
                setResult(worldResult(created));
              } catch (error) {
                setResult({ error: (error as Error).message });
              }
            }}
          >
            <Plus data-icon="inline-start" />
            {t('创建照明', 'Create light')}
          </Button>
        </div>
        <pre className="world-json" aria-label="World API response">
          {result
            ? JSON.stringify(result, null, 2)
            : t(
                '选择对象并发出查询或命令。\n操作记录会注明 Agent 来源。',
                'Select an entity and issue a query or command.\nAction records identify the Agent.',
              )}
        </pre>
      </DialogContent>
    </Dialog>
  );
}

function Preview() {
  const prefs = usePreferences();
  const locale = prefs.locale;
  const t: Translate = useCallback(
    (zh, en) => (locale === 'zh' ? zh : en),
    [locale],
  );
  const layout = useWorld((s) => s.layout);
  const meta = useWorld((s) => s.meta);
  const assets = useWorld((s) => s.assets);
  const [page, setPage] = useState(
    new URLSearchParams(location.search).get('page') === 'assets'
      ? '/assets'
      : '/lab',
  );
  const [selectedId, select] = useState('centrifuge-01');
  const [mode, setMode] = useState('view');
  const [focus, setFocus] = useState(0);
  const [viewReset, setViewReset] = useState(0);
  const [top, setTop] = useState(false);
  const [grid, setGrid] = useState(true);
  const [objects, setObjects] = useState(innerWidth > 1050);
  const [inspector, setInspector] = useState(true);
  const [historyVisible, setHistory] = useState(true);
  const [add, setAdd] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [newLab, setNewLab] = useState(false);
  const [labName, setLabName] = useState('');
  const [agent, setAgent] = useState(false);
  const [stateName, setStateName] = useState('normal');
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const toastTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    text: string;
    action: () => void;
  } | null>(null);
  const [saveError, setSaveError] = useState('');
  const selected = layout.entities.find((e) => e.id === selectedId);
  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error });
    if (toastTimeout.current) clearTimeout(toastTimeout.current);
    toastTimeout.current = setTimeout(
      () => setToast(null),
      error ? 9000 : 3500,
    );
  }, []);
  const handle = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      notify((error as Error).message, true);
    }
  };
  const selectEntity = useCallback((id: string) => {
    select(id);
    setInspector(true);
  }, []);
  const confirmation = (title: string, text: string, action: () => void) =>
    setConfirm({ title, text, action });
  const navigate = (next: string) => {
    if (['/lab', '/assets'].includes(next)) {
      setPage(next);
      const url = new URL(location.href);
      url.searchParams.set('page', next === '/assets' ? 'assets' : 'lab');
      history.replaceState(null, '', url);
    } else setPage(next);
  };
  const openAsset = (asset: Asset) => {
    setSelectedAsset(asset);
    setNewName(
      `${t(asset.name, asset.en)} ${String(layout.entities.filter((e) => e.kind === asset.kind).length + 1).padStart(2, '0')}`,
    );
  };
  const onSave = async (retry = false) => {
    setSaveError('');
    try {
      await save(retry);
      setStateName('normal');
      notify(
        t(
          '实验室已保存，可在本浏览器重新打开',
          'Laboratory saved in this browser',
        ),
      );
    } catch (error) {
      setSaveError((error as Error).message);
    }
  };
  const changeScenario = (name: string) => {
    setStateName(name);
    setSaveError('');
    if (name === 'empty' && !snapshot().meta.authenticated) scenario('normal');
    scenario(name);
    if (name === 'empty') select('');
    if (name === 'conflict')
      notify(
        t(
          '下次保存将模拟版本冲突',
          'The next save will simulate a version conflict',
        ),
      );
  };
  useEffect(() => {
    void initialize();
  }, []);
  useEffect(() => {
    const size = matchMedia('(max-width: 1050px)');
    const adjust = () => {
      if (size.matches) setObjects(false);
    };
    size.addEventListener('change', adjust);
    return () => size.removeEventListener('change', adjust);
  }, []);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement;
      if (
        element.closest(
          'input, textarea, select, [contenteditable="true"], [role="dialog"]',
        )
      )
        return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void onSave();
      }
      if (event.key.toLowerCase() === 'f') setFocus((n) => n + 1);
      if (event.key === 'Escape') select('');
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [layout.dirty, meta.conflict]);
  const stats = layout.entities.filter((e) => !e.archived);
  return (
    <>
      <div className="prototype-product">
        <AppShellLayout
          navigation={app.navigation}
          moduleIcons={app.moduleIcons}
          role="member"
          user={{
            id: 'foundation-preview-member',
            display_name: t('体验成员', 'Preview member'),
            email: 'preview@example.test',
          }}
          currentPath={page}
          onOpen={navigate}
        >
          {page === '/lab' ? (
            <div className="foundation-workspace">
              <header className="world-heading">
                <div className="world-title">
                  <div className="world-title-icon">
                    <Layers3 />
                  </div>
                  <div>
                    <h1>
                      {layout.name}
                      <Badge variant="outline">Lab 01</Badge>
                    </h1>
                    <p>
                      {t('实验室世界', 'Laboratory world')}
                      <span>/</span>
                      {t(
                        '空间、设备与实时状态',
                        'Space, devices and live state',
                      )}
                    </p>
                  </div>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('创建实验室', 'Create laboratory')}
                    title={t('创建实验室', 'Create laboratory')}
                    onClick={() => {
                      setLabName('');
                      setNewLab(true);
                    }}
                  >
                    <ChevronDown />
                  </Button>
                </div>
                <div className="world-actions">
                  <span
                    className={`save-indicator${layout.dirty ? ' dirty' : ''}`}
                  >
                    {layout.dirty ? <i /> : <Check />}
                    {layout.dirty
                      ? t('未保存更改', 'Unsaved changes')
                      : t('已保存', 'Saved')}
                  </span>
                  <Tool
                    icon={FolderOpen}
                    label={t('重新打开已保存 Lab', 'Reopen saved Lab')}
                    onClick={() =>
                      confirmation(
                        t('重新打开实验室', 'Reopen laboratory'),
                        t(
                          '载入本浏览器最近保存的布局，未保存的摆放将被替换。',
                          'Load the last layout saved in this browser. Unsaved placement edits will be replaced.',
                        ),
                        () => {
                          void reopen()
                            .then(() =>
                              notify(
                                t('已恢复保存的布局', 'Saved layout restored'),
                              ),
                            )
                            .catch((error) => notify(error.message, true));
                        },
                      )
                    }
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setAdd(true);
                      setSelectedAsset(null);
                    }}
                  >
                    <Plus data-icon="inline-start" />
                    {t('添加对象', 'Add entity')}
                  </Button>
                  <Button
                    size="sm"
                    disabled={
                      meta.saving || !meta.authenticated || !meta.connection
                    }
                    onClick={() => void onSave()}
                  >
                    {meta.saving ? (
                      <LoaderCircle data-icon="inline-start" className="spin" />
                    ) : (
                      <Save data-icon="inline-start" />
                    )}
                    {meta.saving
                      ? t('保存中', 'Saving')
                      : t('保存 Lab', 'Save Lab')}
                  </Button>
                </div>
              </header>
              <div className="world-toolbar">
                <Tabs
                  value={mode}
                  onValueChange={(value) => setMode(value as string)}
                >
                  <TabsList>
                    <TabsTrigger value="view">
                      <MousePointer2 />
                      {t('查看与运行', 'Inspect & run')}
                    </TabsTrigger>
                    <TabsTrigger value="edit">
                      <Move3D />
                      {t('编辑布局', 'Edit layout')}
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                <div className="world-stats">
                  <span>
                    <Box />
                    {stats.length} {t('个对象', 'entities')}
                  </span>
                  <span>
                    <Radio />
                    {
                      stats.filter((e) =>
                        ['centrifuge', 'sensor', 'light'].includes(e.kind),
                      ).length
                    }{' '}
                    {t('个虚拟设备', 'virtual devices')}
                  </span>
                </div>
                <div className="toolbar-toggles">
                  <Tool
                    icon={ListTree}
                    label={t('显示对象目录', 'Toggle directory')}
                    active={objects}
                    onClick={() => setObjects(!objects)}
                  />
                  <Tool
                    icon={Activity}
                    label={t('显示事件面板', 'Toggle events')}
                    active={historyVisible}
                    onClick={() => setHistory(!historyVisible)}
                  />
                  <Tool
                    icon={PanelRightOpen}
                    label={t('显示实体详情', 'Toggle inspector')}
                    active={inspector}
                    onClick={() => setInspector(!inspector)}
                  />
                </div>
              </div>
              {!meta.connection || !meta.authenticated || saveError ? (
                <div className="world-alert">
                  <Alert
                    variant={
                      saveError || !meta.authenticated
                        ? 'destructive'
                        : 'default'
                    }
                  >
                    <CircleAlert />
                    <AlertTitle>
                      {saveError
                        ? t(
                            '保存冲突 · 草稿已保留',
                            'Save conflict · Draft preserved',
                          )
                        : !meta.authenticated
                          ? t('身份已失效', 'Session expired')
                          : t('实时连接已中断', 'Live connection interrupted')}
                    </AlertTitle>
                    <AlertDescription>
                      {saveError ||
                        (!meta.authenticated
                          ? t(
                              '恢复身份后可继续编辑和操作。',
                              'Restore the session to continue editing and operating.',
                            )
                          : t(
                              '显示最后收到的观测。运行端继续模拟，重连后同步最新状态。',
                              'Showing last received observations. The simulated runtime continues. Reconnect to resynchronize.',
                            ))}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          if (saveError) void onSave(true);
                          else changeScenario('normal');
                        }}
                      >
                        {saveError
                          ? t('保留草稿重试', 'Retry with draft')
                          : !meta.authenticated
                            ? t('恢复身份', 'Restore session')
                            : t('重新连接', 'Reconnect')}
                      </Button>
                    </AlertDescription>
                  </Alert>
                </div>
              ) : null}
              <div
                className={`world-body${objects ? ' with-tree' : ''}${inspector ? ' with-inspector' : ''}`}
              >
                {objects ? (
                  <ObjectTree
                    selectedId={selectedId}
                    select={selectEntity}
                    t={t}
                    locale={locale}
                    onAdd={() => {
                      setAdd(true);
                      setSelectedAsset(null);
                    }}
                  />
                ) : null}
                <div className="world-center">
                  <div className="scene-surface">
                    <Suspense
                      fallback={
                        <div className="scene-loading">
                          <LoaderCircle className="spin" />
                          {t('正在构建实验室…', 'Building laboratory…')}
                        </div>
                      }
                    >
                      <LabScene
                        selectedId={selectedId}
                        onSelect={selectEntity}
                        mode={mode}
                        locale={locale}
                        dark={prefs.resolvedTheme === 'dark'}
                        focus={focus}
                        reset={viewReset}
                        top={top}
                        grid={grid}
                      />
                    </Suspense>
                    <div className="scene-caption">
                      <span>
                        <i className={!meta.connection ? 'warning' : ''} />
                        {meta.connection
                          ? t('世界已连接', 'World connected')
                          : t('连接中断', 'Disconnected')}
                      </span>
                      <small>
                        {t('虚拟实验室', 'Virtual laboratory')} · 9 × 6 m
                      </small>
                    </div>
                    <div className="scene-tools">
                      <Tool
                        icon={Crosshair}
                        label={t('聚焦所选对象', 'Focus selected object')}
                        disabled={!selected}
                        onClick={() => setFocus((n) => n + 1)}
                      />
                      <Tool
                        icon={RotateCcw}
                        label={t('重置视角', 'Reset camera')}
                        onClick={() => {
                          setTop(false);
                          setViewReset((n) => n + 1);
                        }}
                      />
                      <Tool
                        icon={Grid2X2}
                        label={t('俯视图', 'Top view')}
                        active={top}
                        onClick={() => {
                          if (top) setViewReset((n) => n + 1);
                          setTop(!top);
                        }}
                      />
                      <Tool
                        icon={Layers3}
                        label={t('切换地面网格', 'Toggle grid')}
                        active={grid}
                        onClick={() => setGrid(!grid)}
                      />
                    </div>
                    {mode === 'edit' ? (
                      <div className="edit-tip">
                        <Move3D />
                        <span>
                          {t('拖动对象调整摆放', 'Drag objects to place them')}
                        </span>
                        <small>
                          {t(
                            '登记位置保持独立',
                            'Registered location stays independent',
                          )}
                        </small>
                      </div>
                    ) : null}
                    {selected && mode === 'edit' ? (
                      <div className="selection-tools">
                        <span>
                          {locale === 'zh' ? selected.name : selected.en}
                        </span>
                        <Tool
                          icon={RotateCw}
                          label={t('旋转 15°', 'Rotate 15°')}
                          onClick={() =>
                            handle(() =>
                              patchEntity(selected.id, {
                                rotation: (selected.rotation + 15) % 360,
                              }),
                            )
                          }
                        />
                        <Tool
                          icon={Copy}
                          label={t(
                            '复制为独立实例',
                            'Duplicate as independent entity',
                          )}
                          onClick={() =>
                            handle(() => selectEntity(duplicate(selected.id)))
                          }
                        />
                      </div>
                    ) : null}
                    <div className="scene-help">
                      <MousePointer2 />
                      <span>
                        {t(
                          '拖动旋转 · 滚轮缩放 · 点击选择',
                          'Drag to orbit · Scroll to zoom · Click to select',
                        )}
                      </span>
                      <span className="keyboard-hint">
                        <kbd>F</kbd>
                        {t('聚焦', 'Focus')}
                      </span>
                    </div>
                    <div className="axis-key">
                      <span className="axis-y">Y</span>
                      <span className="axis-x">X</span>
                      <span className="axis-z">Z</span>
                    </div>
                    {!layout.entities.length && !meta.loading ? (
                      <div className="scene-empty">
                        <Empty>
                          <EmptyHeader>
                            <EmptyMedia variant="icon">
                              <Layers3 />
                            </EmptyMedia>
                            <EmptyTitle>
                              {t(
                                '从第一个对象开始',
                                'Start with your first object',
                              )}
                            </EmptyTitle>
                            <EmptyDescription>
                              {t(
                                '从资产库选择设备、工作台或器皿，搭建你的实验室。',
                                'Choose an instrument, bench or vessel from the library.',
                              )}
                            </EmptyDescription>
                          </EmptyHeader>
                          <Button
                            size="sm"
                            onClick={() => {
                              setAdd(true);
                              setSelectedAsset(null);
                            }}
                          >
                            <Plus data-icon="inline-start" />
                            {t('添加对象', 'Add entity')}
                          </Button>
                        </Empty>
                      </div>
                    ) : null}
                    {meta.loading || !meta.ready ? (
                      <div className="world-loading">
                        <LoaderCircle className="spin" />
                        <strong>
                          {t('正在同步世界快照', 'Synchronizing the world')}
                        </strong>
                        <span>
                          {t(
                            '读取对象、布局和最后观测…',
                            'Reading entities, layout and observations…',
                          )}
                        </span>
                        <Skeleton className="h-2 w-44" />
                      </div>
                    ) : null}
                  </div>
                  {historyVisible ? (
                    <ActivityPanel
                      locale={locale}
                      t={t}
                      onSelect={selectEntity}
                    />
                  ) : null}
                </div>
                {inspector ? (
                  <Inspector
                    entity={selected}
                    locale={locale}
                    t={t}
                    onClose={() => setInspector(false)}
                    onFocus={() => setFocus((n) => n + 1)}
                    onMode={() => setMode('edit')}
                    onConfirm={confirmation}
                    notify={notify}
                  />
                ) : null}
              </div>
              <footer className="world-status">
                <span>
                  <i />
                  {t('所有对象使用统一身份', 'One identity per entity')}
                </span>
                <span>
                  {selected?.id ?? t('未选择对象', 'No object selected')}
                </span>
                <span>
                  v{layout.revision} · {t('单位', 'Units')} m
                </span>
              </footer>
            </div>
          ) : page === '/assets' ? (
            <section className="catalog-page">
              <header>
                <div>
                  <span className="eyebrow">ASSET LIBRARY</span>
                  <h1>{t('资产库', 'Asset Library')}</h1>
                  <p>
                    {t(
                      '可复用的数字定义。放入实验室，成为独立对象。',
                      'Reusable digital definitions. Place them in a lab to create independent entities.',
                    )}
                  </p>
                </div>
                <Badge variant="outline">
                  {assets.length} {t('个资产', 'assets')}
                </Badge>
              </header>
              <AssetPicker
                t={t}
                locale={locale}
                onChoose={(asset) => {
                  setAdd(true);
                  openAsset(asset);
                }}
                notify={notify}
              />
            </section>
          ) : (
            <section className="auxiliary-page">
              <h1>
                {page === '/settings'
                  ? t('显示偏好', 'Display preferences')
                  : page === '/notifications'
                    ? t('暂无新通知', 'No new notifications')
                    : t('欢迎回到 Lab Word', 'Welcome to Lab Word')}
              </h1>
              <p>
                {t(
                  '从实验室开始，搭建并运行你的数字世界。',
                  'Build and run your digital world, starting in the laboratory.',
                )}
              </p>
              {page === '/settings' ? (
                <div className="preference-controls">
                  <Button
                    variant="outline"
                    onClick={() => prefs.setTheme('light')}
                  >
                    {t('亮色', 'Light')}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => prefs.setTheme('dark')}
                  >
                    {t('暗色', 'Dark')}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      prefs.setLocale(locale === 'zh' ? 'en' : 'zh')
                    }
                  >
                    中文 / English
                  </Button>
                </div>
              ) : null}
              <Button onClick={() => navigate('/lab')}>
                <ArrowLeft data-icon="inline-start" />
                {t('进入 Lab', 'Open Lab')}
              </Button>
            </section>
          )}
        </AppShellLayout>
      </div>
      <aside
        className="preview-controls"
        aria-label={t('预览工具', 'Preview tools')}
      >
        <div className="preview-version">
          <span>PREVIEW</span>
          <strong>Foundation v1</strong>
        </div>
        <NativeSelect
          size="sm"
          aria-label={t('预览场景', 'Preview scenario')}
          value={stateName}
          onChange={(event) => changeScenario(event.target.value)}
        >
          {[
            ['normal', '正常体验', 'Normal'],
            ['empty', '空实验室', 'Empty laboratory'],
            ['loading', '加载中', 'Loading'],
            ['offline', '连接中断', 'Disconnected'],
            ['conflict', '保存冲突', 'Save conflict'],
            ['expired', '身份失效', 'Session expired'],
            ['restart', '运行端重启', 'Runtime restart'],
            ['failure', '设备异常', 'Runtime failure'],
          ].map(([value, zh, en]) => (
            <NativeSelectOption value={value} key={value}>
              {t(zh, en)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <div className="preview-speed">
          <span>{t('时间', 'Time')}</span>
          <NativeSelect
            size="sm"
            aria-label={t('预览时间倍率', 'Preview time scale')}
            value={String(meta.speed)}
            onChange={(event) => setSpeed(Number(event.target.value))}
          >
            <NativeSelectOption value="1">1×</NativeSelectOption>
            <NativeSelectOption value="30">30×</NativeSelectOption>
            <NativeSelectOption value="120">120×</NativeSelectOption>
          </NativeSelect>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setAgent(true)}>
          <Terminal data-icon="inline-start" />
          {t('Agent 客户端', 'Agent client')}
        </Button>
        <span className="preview-disclaimer">
          {t(
            '设备与 API 均为模拟 · 保存仅在本机',
            'Simulated devices & API · Saved on this browser',
          )}
        </span>
        <Tool
          icon={RotateCcw}
          label={t('重置预览示例', 'Reset preview example')}
          onClick={() =>
            confirmation(
              t('重置预览', 'Reset preview'),
              t(
                '当前未保存的预览更改将被替换。本机已保存的布局仍保留。',
                'Replace unsaved preview changes. Your saved layout remains available.',
              ),
              () => {
                reset();
                setStateName('normal');
                selectEntity('centrifuge-01');
                setSaveError('');
                setMode('view');
                setViewReset((n) => n + 1);
              },
            )
          }
        />
      </aside>
      {toast ? (
        <div
          className={`preview-toast${toast.error ? ' error' : ''}`}
          role={toast.error ? 'alert' : 'status'}
        >
          {toast.error ? <CircleAlert /> : <Check />}
          <span>{toast.text}</span>
          <Tool
            icon={X}
            label={t('关闭提示', 'Dismiss message')}
            onClick={() => setToast(null)}
          />
        </div>
      ) : null}
      <Dialog
        open={add}
        onOpenChange={(open) => {
          setAdd(open);
          if (!open) setSelectedAsset(null);
        }}
      >
        <DialogContent className="asset-dialog">
          <div className="dialog-title-row">
            <DialogTitle>
              {selectedAsset
                ? t('注册实验室对象', 'Register a lab entity')
                : t('从资产库添加', 'Add from Asset Library')}
            </DialogTitle>
            <Tool
              icon={X}
              label={t('关闭', 'Close')}
              onClick={() => setAdd(false)}
            />
          </div>
          <DialogDescription>
            {selectedAsset
              ? t(
                  '同一个资产可以创建多个具有独立状态的对象。',
                  'One asset can create multiple independent entities.',
                )
              : t(
                  '选择可复用定义，为实验室加入一个独立对象。',
                  'Choose a reusable definition for a new independent entity.',
                )}
          </DialogDescription>
          {selectedAsset ? (
            <div className="register-entity">
              <div className="register-asset">
                <Miniature kind={selectedAsset.kind} />
                <div>
                  <h3>{t(selectedAsset.name, selectedAsset.en)}</h3>
                  <p>
                    {t(selectedAsset.description, selectedAsset.descriptionEn)}
                  </p>
                  <Badge variant="outline">v{selectedAsset.version}</Badge>
                </div>
              </div>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="new-entity-name">
                    {t('对象名称', 'Entity name')}
                  </FieldLabel>
                  <Input
                    id="new-entity-name"
                    value={newName}
                    onChange={(event) => setNewName(event.target.value)}
                    autoFocus
                  />
                </Field>
              </FieldGroup>
              <dl>
                <PropertyRow
                  label={t('加入实验室', 'Laboratory')}
                  value={layout.name}
                />
                <PropertyRow
                  label={t('初始登记位置', 'Initial location')}
                  value={t('实验室地面', 'Laboratory floor')}
                />
                <PropertyRow
                  label="Binding"
                  value={
                    ['centrifuge', 'light', 'sensor'].includes(
                      selectedAsset.kind,
                    )
                      ? 'Simulator'
                      : t('无需运行绑定', 'No runtime binding')
                  }
                />
              </dl>
              <div className="dialog-actions">
                <Button
                  variant="outline"
                  onClick={() => setSelectedAsset(null)}
                >
                  {t('重新选择', 'Choose another')}
                </Button>
                <Button
                  disabled={!newName.trim() || creating}
                  onClick={() => {
                    setCreating(true);
                    try {
                      const id = addEntity(selectedAsset.id, newName.trim());
                      selectEntity(id);
                      setAdd(false);
                      setSelectedAsset(null);
                      navigate('/lab');
                      setMode('edit');
                      notify(
                        t(
                          '对象已加入场景，可拖动调整摆放',
                          'Entity added. Drag it to adjust placement.',
                        ),
                      );
                    } catch (error) {
                      notify((error as Error).message, true);
                    } finally {
                      setCreating(false);
                    }
                  }}
                >
                  <Plus data-icon="inline-start" />
                  {t('注册并加入 Lab', 'Register and add to Lab')}
                </Button>
              </div>
            </div>
          ) : (
            <AssetPicker
              t={t}
              locale={locale}
              onChoose={openAsset}
              notify={notify}
              compact
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={newLab} onOpenChange={setNewLab}>
        <DialogContent>
          <div className="dialog-title-row">
            <DialogTitle>{t('创建实验室', 'Create laboratory')}</DialogTitle>
            <Tool
              icon={X}
              label={t('关闭', 'Close')}
              onClick={() => setNewLab(false)}
            />
          </div>
          <DialogDescription>
            {t(
              '从一个开放的空间开始。当前未保存的预览布局会被替换，已保存版本仍可重新打开。',
              'Start with an open space. Unsaved preview changes will be replaced; the saved layout can be reopened.',
            )}
          </DialogDescription>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="new-lab-name">
                {t('实验室名称', 'Laboratory name')}
              </FieldLabel>
              <Input
                id="new-lab-name"
                placeholder={t(
                  '例如：细胞研究实验室',
                  'e.g. Cell research laboratory',
                )}
                value={labName}
                onChange={(event) => setLabName(event.target.value)}
                autoFocus
              />
            </Field>
          </FieldGroup>
          <div className="dialog-actions">
            <Button variant="outline" onClick={() => setNewLab(false)}>
              {t('取消', 'Cancel')}
            </Button>
            <Button
              disabled={!labName.trim()}
              onClick={() =>
                handle(() => {
                  createLab(labName.trim());
                  select('');
                  setNewLab(false);
                  setMode('edit');
                })
              }
            >
              {t('创建 Lab', 'Create Lab')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!confirm}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <DialogContent>
          <DialogTitle>{confirm?.title}</DialogTitle>
          <DialogDescription>{confirm?.text}</DialogDescription>
          <div className="dialog-actions">
            <Button variant="outline" onClick={() => setConfirm(null)}>
              {t('取消', 'Cancel')}
            </Button>
            <Button
              onClick={() => {
                const action = confirm?.action;
                setConfirm(null);
                if (action) handle(action);
              }}
            >
              {t('确认', 'Confirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <AgentClient
        open={agent}
        onOpenChange={setAgent}
        t={t}
        locale={locale}
        select={selectEntity}
      />
    </>
  );
}
function PropertyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="property">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <PreferencesProvider>
    <AppMessagesProvider app={app}>
      <Preview />
    </AppMessagesProvider>
  </PreferencesProvider>,
);
