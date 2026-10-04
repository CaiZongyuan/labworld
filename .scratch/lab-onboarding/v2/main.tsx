// PROTOTYPE v2: a contextual tour of permanent workspace controls.
import { createRoot } from 'react-dom/client';
import { lazy, Suspense, useEffect, useState, type ComponentType } from 'react';
import { cn } from 'cn';
import {
  ArrowLeft,
  Box,
  CircleDot,
  CircleHelp,
  Crosshair,
  FileBox,
  FlaskConical,
  Grid2X2,
  LampDesk,
  Layers3,
  LayoutGrid,
  ListTree,
  LoaderCircle,
  Move3D,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  Square,
  Thermometer,
  Wifi,
  WifiOff,
  Bot,
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
import { Switch } from '@labos-threejs/ui/components/switch';
import {
  NativeSelect,
  NativeSelectOption,
} from '@labos-threejs/ui/components/native-select';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@labos-threejs/ui/components/dialog';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@labos-threejs/ui/components/alert';
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@labos-threejs/ui/components/empty';
import { AppShellLayout } from '../../../packages/views/src/shell/app-shell';
import { AppMessagesProvider } from '../../../packages/views/src/shell/messages';
import {
  PreferencesProvider,
  usePreferences,
} from '../../../packages/views/src/shell/preferences';
import { assembleApp } from '../../../packages/views/src/shell/app-contract';
import { ViewportBoundary } from '../../../packages/views/src/lab/viewport-boundary';
import benchImage from '../../../packages/views/src/lab/images/bench.png';
import labwareImage from '../../../packages/views/src/lab/images/labware.png';
import lightImage from '../../../packages/views/src/lab/images/light.png';
import sensorImage from '../../../packages/views/src/lab/images/sensor.png';
import centrifugeImage from '../../../packages/views/src/lab/images/centrifuge.png';
import robotImage from '../../../packages/views/src/lab/images/robot.png';
import {
  clearError,
  createLab,
  injectFailure,
  lightCommand,
  patchEntity,
  registerObject,
  reset,
  saveLayout,
  selectLab,
  snapshot,
  startDevices,
  stopDevice,
  useWorld,
  type Entity,
  type Entry,
  type Kind,
} from './world';
import {
  introSteps,
  reviewSteps,
  resetTour,
  setTour,
  tourSnapshot,
  useTour,
  VisualTour,
} from './tour';
import './preview.css';

const LabScene = lazy(() => import('./LabScene'));
type Translate = (zh: string, en: string) => string;
const kinds: Record<
  string,
  { icon: ComponentType; zh: string; en: string; image: string }
> = {
  bench: { icon: LayoutGrid, zh: '实验台', en: 'Bench', image: benchImage },
  labware: {
    icon: FlaskConical,
    zh: '烧杯',
    en: 'Beaker',
    image: labwareImage,
  },
  light: { icon: LampDesk, zh: '照明', en: 'Light', image: lightImage },
  sensor: {
    icon: Thermometer,
    zh: '温度传感器',
    en: 'Temperature sensor',
    image: sensorImage,
  },
  centrifuge: {
    icon: CircleDot,
    zh: '离心机',
    en: 'Centrifuge',
    image: centrifugeImage,
  },
  robot: { icon: Bot, zh: '机械臂', en: 'Robot', image: robotImage },
};
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
            { id: 'lab', labelKey: 'lab', path: '/lab' },
            { id: 'assets', labelKey: 'assets', path: '/assets' },
          ],
        },
      ],
      messages: {
        zh: { group: '实验室', lab: 'Lab', assets: '资产库' },
        en: { group: 'Laboratory', lab: 'Lab', assets: 'Asset Library' },
      },
      moduleIcons: {
        '/lab': { icon: Box, variant: 'teal' },
        '/assets': { icon: FileBox, variant: 'blue' },
      },
    },
  ],
});
function Tool({
  icon: Icon,
  label,
  active,
  onClick,
  disabled = false,
  target,
}: {
  icon: ComponentType;
  label: string;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
  target?: string;
}) {
  return (
    <Button
      data-tour={target}
      variant={active ? 'secondary' : 'ghost'}
      size="icon-sm"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon />
    </Button>
  );
}
function ObjectIcon({ kind }: { kind: Kind }) {
  const Icon = kinds[kind]?.icon ?? Box;
  return (
    <span className={cn('object-icon', `object-icon-${kind}`)}>
      <Icon />
    </span>
  );
}
function ActionError({ t }: { t: Translate }) {
  const world = useWorld((value) => value);
  if (!world.error) return null;
  return (
    <Alert variant="destructive" className="form-error">
      <AlertTitle>{t('操作未完成', 'Action incomplete')}</AlertTitle>
      <AlertDescription>
        {t(
          '输入与草稿已保留，可以重试。',
          'Your input and draft are preserved. Try again.',
        )}
      </AlertDescription>
    </Alert>
  );
}
function CreateDialog({
  open,
  onClose,
  onCreated,
  t,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  t: Translate;
}) {
  const world = useWorld((value) => value);
  const tour = useTour();
  const [name, setName] = useState(
    t('我的第一个实验室', 'My first laboratory'),
  );
  const [template, setTemplate] = useState<Entry>('guided');
  return (
    <Dialog
      open={open}
      modal={tour.status !== 'active'}
      onOpenChange={(next) => {
        if (!next && !world.pending) onClose();
      }}
    >
      <DialogContent className="scene-dialog">
        <DialogTitle>{t('创建实验室', 'Create laboratory')}</DialogTitle>
        <DialogDescription className="sr-only">
          {t('实验室名称与初始场景', 'Laboratory name and starting scene')}
        </DialogDescription>
        <form
          data-tour="create-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const before = snapshot().activeId;
            await createLab(name, template);
            if (!snapshot().error && snapshot().activeId !== before)
              onCreated();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="lab-name">
                {t('实验室名称', 'Laboratory name')}
              </FieldLabel>
              <Input
                id="lab-name"
                required
                maxLength={120}
                value={name}
                disabled={world.pending}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="initial-scene">
                {t('初始场景', 'Starting scene')}
              </FieldLabel>
              <NativeSelect
                id="initial-scene"
                value={template}
                disabled={world.pending}
                onChange={(event) => setTemplate(event.target.value as Entry)}
              >
                <NativeSelectOption value="guided">
                  {t('基础实验台 · 3 个对象', 'Bench scene · 3 objects')}
                </NativeSelectOption>
                <NativeSelectOption value="sample">
                  {t('完整示例 · 8 个对象', 'Complete sample · 8 objects')}
                </NativeSelectOption>
                <NativeSelectOption value="blank">
                  {t('空白网格', 'Empty grid')}
                </NativeSelectOption>
              </NativeSelect>
            </Field>
          </FieldGroup>
          <div className="dialog-scene-summary">
            <Badge variant="outline">
              {t('模拟实验室', 'Simulated laboratory')}
            </Badge>
            <span>
              {template === 'blank' ? '0' : template === 'sample' ? '8' : '3'}{' '}
              {t('个对象', 'objects')}
            </span>
          </div>
          <ActionError t={t} />
          <div className="dialog-actions">
            <Button
              type="button"
              variant="outline"
              disabled={world.pending}
              onClick={onClose}
            >
              {t('取消', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!name.trim() || world.pending}>
              {world.pending ? (
                <LoaderCircle className="spin" data-icon="inline-start" />
              ) : (
                <Plus data-icon="inline-start" />
              )}
              {t(
                world.error === 'create' ? '重试创建' : '创建',
                world.error === 'create' ? 'Retry creation' : 'Create',
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
function RegisterDialog({
  open,
  initialKind,
  onClose,
  onRegistered,
  t,
}: {
  open: boolean;
  initialKind: Kind;
  onClose: () => void;
  onRegistered: (id: string) => void;
  t: Translate;
}) {
  const world = useWorld((value) => value);
  const tour = useTour();
  const [kind, setKind] = useState<Kind>('light');
  const [name, setName] = useState(t('照明 01', 'Light 01'));
  useEffect(() => {
    setKind(initialKind);
    setName(`${t(kinds[initialKind].zh, kinds[initialKind].en)} 01`);
  }, [initialKind]);
  const guidedLight =
    tour.status === 'active' && !tour.review && tour.index === 3;
  return (
    <Dialog
      open={open}
      modal={tour.status !== 'active'}
      onOpenChange={(next) => {
        if (!next && !world.pending) onClose();
      }}
    >
      <DialogContent className="scene-dialog">
        <DialogTitle>{t('登记对象', 'Register object')}</DialogTitle>
        <DialogDescription className="sr-only">
          {t(
            '对象定义、外观与独立名称',
            'Object definition, appearance and independent name',
          )}
        </DialogDescription>
        <form
          data-tour="register-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const id = await registerObject(kind, name);
            if (id) onRegistered(id);
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="definition">
                {t('定义版本', 'Definition version')}
              </FieldLabel>
              <NativeSelect
                id="definition"
                value={kind}
                disabled={world.pending}
                onChange={(event) => {
                  const value = event.target.value as Kind;
                  setKind(value);
                  setName(`${t(kinds[value].zh, kinds[value].en)} 01`);
                }}
              >
                {Object.entries(kinds).map(([value, asset]) => (
                  <NativeSelectOption key={value} value={value}>
                    {t(asset.zh, asset.en)} · 1.0
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="entity-name">
                {t('对象名称', 'Object name')}
              </FieldLabel>
              <Input
                id="entity-name"
                required
                maxLength={120}
                value={name}
                disabled={world.pending}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
          </FieldGroup>
          <div className="registration-appearance">
            <img
              src={kinds[kind].image}
              alt={t(kinds[kind].zh, kinds[kind].en)}
            />
            <div>
              <strong>{t('内置外观', 'Built-in appearance')}</strong>
              <Badge variant="outline">
                {t('模拟对象', 'Simulated object')}
              </Badge>
            </div>
          </div>
          <ActionError t={t} />
          <div className="dialog-actions">
            <Button
              type="button"
              variant="outline"
              disabled={world.pending}
              onClick={onClose}
            >
              {t('取消', 'Cancel')}
            </Button>
            <Button
              type="submit"
              disabled={
                !name.trim() ||
                world.pending ||
                (guidedLight && kind !== 'light')
              }
            >
              {world.pending ? (
                <LoaderCircle className="spin" data-icon="inline-start" />
              ) : (
                <Plus data-icon="inline-start" />
              )}
              {t(
                world.error === 'create' ? '重试登记' : '登记',
                world.error === 'create' ? 'Retry registration' : 'Register',
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
function NumericInput({
  id,
  value,
  step,
  onChange,
}: {
  id: string;
  value: number;
  step: string;
  onChange: (value: number) => void;
}) {
  // Preserve incomplete numeric text while the user types a sign or decimal.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <Input
      id={id}
      type="number"
      step={step}
      value={draft}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        if (next.trim() !== '' && Number.isFinite(Number(next)))
          onChange(Number(next));
      }}
      onBlur={() => {
        if (draft.trim() === '' || !Number.isFinite(Number(draft)))
          setDraft(String(value));
      }}
    />
  );
}
function PlacementFields({ entity, t }: { entity: Entity; t: Translate }) {
  return (
    <FieldGroup>
      <div className="position-fields">
        {['X', 'Y', 'Z'].map((axis, index) => (
          <Field key={`${entity.id}-${axis}`}>
            <FieldLabel htmlFor={`placement-${axis}`}>{axis} (m)</FieldLabel>
            <NumericInput
              id={`placement-${axis}`}
              step="0.05"
              value={entity.position[index]}
              onChange={(value) => {
                const position = [...entity.position] as Entity['position'];
                position[index] = value;
                patchEntity(entity.id, { position });
              }}
            />
          </Field>
        ))}
      </div>
      <Field>
        <FieldLabel htmlFor="rotation">{t('旋转', 'Rotation')} (°)</FieldLabel>
        <NumericInput
          id="rotation"
          step="15"
          value={entity.rotation}
          onChange={(value) => patchEntity(entity.id, { rotation: value })}
        />
      </Field>
    </FieldGroup>
  );
}
function Inspector({
  selected,
  editing,
  onStarted,
  onReported,
  t,
}: {
  selected?: Entity;
  editing: boolean;
  onStarted: () => void;
  onReported: () => void;
  t: Translate;
}) {
  const world = useWorld((value) => value);
  const [brightness, setBrightness] = useState(65);
  if (!selected)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Box />
          </EmptyMedia>
          <EmptyTitle>{t('未选择对象', 'No object selected')}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  const device = world.devices[selected.id];
  const runtime = selected.kind === 'light' || selected.kind === 'sensor';
  const location = world.lab?.entities.find(
    (item) => item.id === selected.location,
  );
  async function start() {
    if (!selected) return;
    await startDevices(selected.id);
    if (snapshot().devices[selected.id]?.program) onStarted();
  }
  async function command(on: boolean, value: number) {
    if (!selected) return;
    await lightCommand(selected.id, value, on);
    if (!snapshot().error && snapshot().devices[selected.id]?.on) onReported();
  }
  return (
    <div className="task-content">
      <div className="inspector-title">
        <ObjectIcon kind={selected.kind} />
        <h2>{t(selected.name, selected.en)}</h2>
      </div>
      <Badge variant="outline">
        {runtime
          ? t('模拟设备', 'Simulated device')
          : t('静态对象', 'Static object')}
      </Badge>
      {editing ? (
        <section className="inspector-section" data-tour="placement">
          <h3>{t('三维摆放', 'Placement')}</h3>
          <PlacementFields entity={selected} t={t} />
        </section>
      ) : null}
      {runtime && !editing ? (
        <section className="inspector-section" data-tour="program-section">
          <div className="runtime-header">
            <h3>{t('设备程序', 'Device program')}</h3>
            <Badge variant={device?.program ? 'success' : 'secondary'}>
              {device?.program
                ? t('运行中', 'Running')
                : t('已停止', 'Stopped')}
            </Badge>
            {device?.program ? (
              <Tool
                icon={Square}
                label={t('停止程序', 'Stop program')}
                onClick={() => stopDevice(selected.id)}
                disabled={world.scenario === 'offline'}
              />
            ) : null}
          </div>
          {!device?.program ? (
            <Button
              data-tour="program"
              variant="outline"
              className="full-command"
              disabled={world.pending || world.scenario === 'offline'}
              onClick={() => void start()}
            >
              <Play data-icon="inline-start" />
              {t('启动程序', 'Start program')}
            </Button>
          ) : null}
          <ActionError t={t} />
          {selected.kind === 'light' ? (
            <>
              <div className="device-control" data-tour="light-controls">
                <header>
                  <LampDesk />
                  <strong>{t('电源', 'Power')}</strong>
                  <Switch
                    aria-label={t('照明电源', 'Light power')}
                    checked={!!device?.on}
                    disabled={
                      !device?.program ||
                      world.pending ||
                      world.scenario === 'offline'
                    }
                    onCheckedChange={(on) =>
                      void command(on, device?.brightness ?? 80)
                    }
                  />
                </header>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="brightness">
                      {t('亮度', 'Brightness')}
                      <span>{brightness}%</span>
                    </FieldLabel>
                    <input
                      id="brightness"
                      type="range"
                      min="0"
                      max="100"
                      step="5"
                      value={brightness}
                      disabled={
                        !device?.program ||
                        world.pending ||
                        world.scenario === 'offline'
                      }
                      onChange={(event) =>
                        setBrightness(Number(event.target.value))
                      }
                    />
                  </Field>
                </FieldGroup>
                <Button
                  variant="outline"
                  className="full-command"
                  disabled={
                    !device?.program ||
                    world.pending ||
                    world.scenario === 'offline'
                  }
                  onClick={() => void command(true, brightness)}
                >
                  <LampDesk data-icon="inline-start" />
                  {t('应用亮度', 'Apply brightness')}
                </Button>
              </div>
              <div className="device-reading" data-tour="light-reading">
                <h3>{t('当前观测', 'Current observation')}</h3>
                <div className="reported-state">
                  <span className={cn('report-dot', device?.on && 'on')} />
                  <strong>
                    {device?.observedAt
                      ? `${device.on ? t('开启', 'On') : t('关闭', 'Off')} · ${device.brightness}%`
                      : t('未知', 'Unknown')}
                  </strong>
                </div>
                <div className="observation-label">
                  <Badge variant="secondary">
                    {t('模拟来源', 'Simulated source')}
                  </Badge>
                  <time>
                    {device?.observedAt
                      ? new Date(device.observedAt).toLocaleTimeString()
                      : '—'}
                  </time>
                </div>
              </div>
            </>
          ) : (
            <div className="sensor-control">
              <div className="sensor-value">
                {device?.observedAt ? device.temperature.toFixed(1) : '—'}
                <span>°C</span>
              </div>
              <Badge variant="secondary">
                {t('模拟来源', 'Simulated source')}
              </Badge>
            </div>
          )}
        </section>
      ) : null}
      <section className="inspector-section">
        <h3>{t('登记位置', 'Registered location')}</h3>
        <span>
          {location ? t(location.name, location.en) : t('实验室', 'Laboratory')}
        </span>
        <Badge variant="secondary">{t('人工登记', 'Manual')}</Badge>
      </section>
      <details className="advanced-info">
        <summary>{t('身份与定义', 'Identity & definition')}</summary>
        <dl>
          <dt>Entity</dt>
          <dd>
            <code>{selected.id}</code>
          </dd>
          <dt>{t('定义版本', 'Definition version')}</dt>
          <dd>{selected.kind} · 1.0</dd>
        </dl>
      </details>
    </div>
  );
}
function AssetLibrary({
  t,
  onRegister,
}: {
  t: Translate;
  onRegister: (kind: Kind) => void;
}) {
  const world = useWorld((value) => value);
  return (
    <section className="asset-library">
      <header>
        <span className="section-kicker">Lab Word</span>
        <h1>{t('内置资产', 'Built-in assets')}</h1>
      </header>
      <div className="asset-grid">
        {Object.entries(kinds).map(([kind, asset]) => (
          <article key={kind}>
            <div className="asset-visual">
              <img src={asset.image} alt={t(asset.zh, asset.en)} />
            </div>
            <h2>{t(asset.zh, asset.en)}</h2>
            <Badge variant="outline">1.0</Badge>
            <Button
              variant="outline"
              disabled={
                !world.lab || world.pending || world.scenario === 'offline'
              }
              onClick={() => onRegister(kind as Kind)}
            >
              <Plus data-icon="inline-start" />
              {t('登记对象', 'Register object')}
            </Button>
          </article>
        ))}
      </div>
    </section>
  );
}
function Preview() {
  const world = useWorld((value) => value);
  const tour = useTour();
  const { locale, resolvedTheme } = usePreferences();
  const t: Translate = (zh, en) => (locale === 'zh' ? zh : en);
  const [path, setPath] = useState('/lab');
  const [selectedId, setSelectedId] = useState(tour.entityId);
  const [mode, setMode] = useState(
    !tour.review && tour.index >= 6 && tour.index <= 8 ? 'edit' : 'view',
  );
  const [dialog, setDialog] = useState<'lab' | 'register' | null>(
    tour.status === 'active' && !tour.review
      ? tour.index === 1
        ? 'lab'
        : tour.index === 3
          ? 'register'
          : null
      : null,
  );
  const [grid, setGrid] = useState(true);
  const [focus, setFocus] = useState(0);
  const [cameraReset, setCameraReset] = useState(0);
  const [top, setTop] = useState(false);
  const [search, setSearch] = useState('');
  const [scenarioName, setScenarioName] = useState('first');
  const [registerKind, setRegisterKind] = useState<Kind>('light');
  const selected = world.lab?.entities.find((item) => item.id === selectedId);
  const guideSteps = tour.review ? reviewSteps : introSteps;
  const canNext =
    tour.review ||
    tour.index !== 6 ||
    (!!world.lab?.guide?.adjusted && world.layout.dirty);
  function advance(index: number) {
    const current = tourSnapshot();
    if (
      current.status === 'active' &&
      !current.review &&
      current.index === index
    )
      setTour({ index: index + 1 });
  }
  function pause() {
    if (tourSnapshot().status === 'active') setTour({ status: 'paused' });
  }
  function closeDialog() {
    setDialog(null);
    clearError();
    if (
      tourSnapshot().status === 'active' &&
      !tourSnapshot().review &&
      [1, 3].includes(tourSnapshot().index)
    )
      pause();
  }
  function select(id: string) {
    setSelectedId(id);
    if (id === tourSnapshot().entityId) advance(4);
  }
  async function save() {
    await saveLayout();
    if (!snapshot().error && !snapshot().layout.dirty) advance(7);
  }
  function finishOrNext() {
    const current = tourSnapshot();
    if (!current.review && introSteps[current.index]?.action) return;
    if (current.index === guideSteps.length - 1) {
      setTour({ status: 'completed' });
      setPath('/lab');
      setMode('view');
      return;
    }
    if (!canNext) return;
    setTour({ index: current.index + 1 });
  }
  function openAssets() {
    setPath('/assets');
    advance(12);
  }
  function help() {
    const current = tourSnapshot();
    clearError();
    setPath('/lab');
    if (current.status === 'completed') {
      setTour({ status: 'active', review: true, index: 0 });
      return;
    }
    let index = current.index;
    const currentWorld = snapshot();
    if (!currentWorld.lab) index = 0;
    else if (!current.review && index < 2) index = 2;
    const light =
      currentWorld.lab?.entities.find((item) => item.id === current.entityId) ??
      currentWorld.lab?.entities.find((item) => item.kind === 'light');
    if (!current.review && index >= 4 && !light) index = 2;
    if (!current.review && index === 7 && !currentWorld.layout.dirty) index = 8;
    if (
      !current.review &&
      index === 9 &&
      light &&
      currentWorld.devices[light.id]?.program
    )
      index = 10;
    if (
      !current.review &&
      index >= 10 &&
      index < 12 &&
      light &&
      !currentWorld.devices[light.id]?.program
    )
      index = 9;
    setSelectedId(light?.id ?? '');
    setMode(!current.review && index >= 6 && index <= 8 ? 'edit' : 'view');
    setDialog(
      !current.review && index === 1
        ? 'lab'
        : !current.review && index === 3
          ? 'register'
          : null,
    );
    setTour({
      status: 'active',
      index,
      entityId: light?.id ?? current.entityId,
    });
  }
  useEffect(() => {
    if (tour.status !== 'active' || !tour.review) return;
    setPath('/lab');
    setDialog(null);
    const key = reviewSteps[tour.index]?.target;
    const light = world.lab?.entities.find((item) => item.kind === 'light');
    if (light) setSelectedId(light.id);
    setMode(['edit-mode', 'placement', 'save'].includes(key) ? 'edit' : 'view');
  }, [tour.review, tour.index, tour.status, world.activeId]);
  useEffect(() => {
    const current = tourSnapshot();
    if (
      current.status === 'active' &&
      !current.review &&
      current.index >= 10 &&
      current.index < 12 &&
      selected &&
      !world.devices[selected.id]?.program
    )
      setTour({ index: 9 });
  }, [world.activeId]);
  async function scenario(value: string) {
    setDialog(null);
    setPath('/lab');
    setScenarioName(value);
    pause();
    reset();
    if (value === 'first' || value === 'create-failure') {
      if (value === 'create-failure') injectFailure('create-failure');
      resetTour();
      return;
    }
    await createLab(t('我的第一个实验室', 'My first laboratory'), 'guided');
    const id = await registerObject('light', t('照明 01', 'Light 01'));
    setSelectedId(id ?? '');
    if (id) patchEntity(id, { position: [-3, 0, 0.85] });
    setMode('edit');
    setTour({
      status: 'active',
      review: false,
      index: value === 'save-failure' ? 7 : 6,
      labId: snapshot().activeId,
      entityId: id ?? '',
    });
    if (value === 'save-failure') injectFailure('save-failure');
    if (value === 'runtime-failure') {
      await saveLayout();
      setMode('view');
      setTour({ index: 9 });
      injectFailure('runtime-failure');
    }
    if (value === 'complete') {
      await saveLayout();
      if (id) {
        await startDevices(id);
        await lightCommand(id, 65);
      }
      setMode('view');
      setTour({ status: 'completed' });
    }
  }
  return (
    <>
      <div className="product-shell">
        <AppShellLayout
          navigation={app.navigation}
          moduleIcons={app.moduleIcons}
          role="member"
          user={{
            id: 'onboarding-v2-preview-member',
            display_name: t('体验成员', 'Preview member'),
            email: 'preview@example.test',
          }}
          currentPath={path}
          onOpen={(next) =>
            next === '/assets' ? openAssets() : setPath('/lab')
          }
        >
          <div className="onboarding-workspace">
            <header className="world-heading">
              <div className="world-title">
                <Layers3 />
                <h1>
                  {path === '/assets'
                    ? t('资产库', 'Asset Library')
                    : (world.lab?.name ?? 'Lab')}
                </h1>
                {world.lab && path === '/lab' ? (
                  <Badge variant="outline">v{world.lab.revision}</Badge>
                ) : null}
              </div>
              <div className="heading-actions">
                {world.labs.length && path === '/lab' ? (
                  <NativeSelect
                    aria-label={t('打开实验室', 'Open laboratory')}
                    value={world.activeId}
                    disabled={world.pending}
                    onChange={(event) => {
                      selectLab(event.target.value);
                      setSelectedId('');
                      if (tour.status === 'active') pause();
                    }}
                  >
                    {world.labs.map((lab) => (
                      <NativeSelectOption key={lab.id} value={lab.id}>
                        {lab.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                ) : null}
                <Tool
                  icon={FileBox}
                  target="assets"
                  label={t('打开资产库', 'Open asset library')}
                  onClick={openAssets}
                />
                <Tool
                  icon={Plus}
                  target="create-lab"
                  label={t('创建实验室', 'Create laboratory')}
                  disabled={world.pending}
                  onClick={() => {
                    setPath('/lab');
                    clearError();
                    setDialog('lab');
                    advance(0);
                  }}
                />
                <Button
                  data-tour="register"
                  size="sm"
                  disabled={
                    !world.lab || world.pending || world.scenario === 'offline'
                  }
                  onClick={() => {
                    setPath('/lab');
                    clearError();
                    setRegisterKind('light');
                    setDialog('register');
                    advance(2);
                  }}
                >
                  <Plus data-icon="inline-start" />
                  {t('登记对象', 'Register object')}
                </Button>
                <Tool
                  icon={CircleHelp}
                  target="help"
                  label={t(
                    tour.status === 'paused'
                      ? '继续引导'
                      : tour.status === 'completed'
                        ? '重新查看引导'
                        : '新手引导',
                    tour.status === 'paused'
                      ? 'Resume tour'
                      : tour.status === 'completed'
                        ? 'Review tour'
                        : 'First-use tour',
                  )}
                  onClick={help}
                />
              </div>
            </header>
            {path === '/assets' ? (
              <AssetLibrary
                t={t}
                onRegister={(kind) => {
                  setRegisterKind(kind);
                  setPath('/lab');
                  setDialog('register');
                }}
              />
            ) : (
              <>
                <div className="workspace-toolbar">
                  <Tabs
                    value={mode}
                    onValueChange={(value) => {
                      setMode(value);
                      if (value === 'edit') advance(5);
                      else advance(8);
                    }}
                  >
                    <TabsList aria-label={t('工作模式', 'Workspace mode')}>
                      <TabsTrigger data-tour="runtime-mode" value="view">
                        <Play data-icon="inline-start" />
                        {t('运行查看', 'View & run')}
                      </TabsTrigger>
                      <TabsTrigger
                        data-tour="edit-mode"
                        value="edit"
                        disabled={!world.lab}
                      >
                        <Move3D data-icon="inline-start" />
                        {t('编辑布局', 'Edit layout')}
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                  <span className="layout-status" role="status">
                    {world.lab
                      ? world.lab.dirty
                        ? t('未保存', 'Unsaved')
                        : t('已保存', 'Saved')
                      : t('尚未创建实验室', 'No laboratory yet')}
                  </span>
                  {tour.status === 'paused' ? (
                    <Button size="sm" variant="ghost" onClick={help}>
                      {t('继续引导', 'Resume tour')}
                    </Button>
                  ) : tour.status === 'completed' ? (
                    <Badge variant="secondary">
                      {t('引导已完成', 'Tour completed')}
                    </Badge>
                  ) : null}
                  <div className="toolbar-end">
                    {world.lab ? (
                      <span className="connection">
                        {world.scenario === 'offline' ? <WifiOff /> : <Wifi />}
                        {t(
                          world.scenario === 'offline' ? '连接中断' : '已连接',
                          world.scenario === 'offline'
                            ? 'Disconnected'
                            : 'Connected',
                        )}
                      </span>
                    ) : null}
                    <Tool
                      icon={Save}
                      target="save"
                      label={t('保存布局', 'Save layout')}
                      disabled={
                        !world.lab?.dirty ||
                        world.pending ||
                        world.scenario === 'offline'
                      }
                      onClick={() => void save()}
                    />
                  </div>
                </div>
                {world.error && !dialog ? (
                  <div className="workspace-error">
                    <ActionError t={t} />
                    <Button variant="ghost" size="sm" onClick={clearError}>
                      {t('关闭提示', 'Dismiss')}
                    </Button>
                  </div>
                ) : null}
                <div className="workbody">
                  <aside
                    className="directory"
                    data-tour="directory"
                    aria-label={t('对象目录', 'Entity directory')}
                  >
                    <header className="directory-header">
                      <ListTree />
                      <strong>{t('对象目录', 'Entities')}</strong>
                      <span>{world.layout.entities.length}</span>
                    </header>
                    {world.lab?.entities.length ? (
                      <div className="directory-search">
                        <Search />
                        <Input
                          aria-label={t('搜索对象', 'Search entities')}
                          value={search}
                          onChange={(event) => setSearch(event.target.value)}
                        />
                      </div>
                    ) : null}
                    <div className="entity-list">
                      {world.layout.entities
                        .filter((entity) =>
                          `${entity.name} ${entity.en}`
                            .toLowerCase()
                            .includes(search.toLowerCase()),
                        )
                        .map((entity) => (
                          <button
                            key={entity.id}
                            data-tour={
                              entity.id === tour.entityId
                                ? 'light-row'
                                : undefined
                            }
                            className={cn(
                              'entity-row',
                              selectedId === entity.id && 'selected',
                            )}
                            aria-label={t(entity.name, entity.en)}
                            aria-pressed={selectedId === entity.id}
                            onClick={() => select(entity.id)}
                          >
                            <ObjectIcon kind={entity.kind} />
                            <span>
                              <strong>{t(entity.name, entity.en)}</strong>
                              <small>
                                {t(
                                  kinds[entity.kind]?.zh ?? '对象',
                                  kinds[entity.kind]?.en ?? 'Entity',
                                )}
                              </small>
                            </span>
                            <i
                              className={cn(
                                'entity-dot',
                                world.devices[entity.id]?.program && 'running',
                              )}
                            />
                          </button>
                        ))}
                    </div>
                    {!world.layout.entities.length ? (
                      <div className="directory-empty">
                        <Box />
                        <span>{t('尚无对象', 'No objects yet')}</span>
                      </div>
                    ) : null}
                  </aside>
                  <div className="scene-region">
                    <div className="scene-caption">
                      <span className="scene-indicator" />
                      <span>{t('实验室空间', 'Laboratory space')}</span>
                      <small>9 × 6 m</small>
                    </div>
                    <div className="scene-tools">
                      <Tool
                        icon={Crosshair}
                        label={t('聚焦对象', 'Focus object')}
                        disabled={!selected}
                        onClick={() => setFocus(focus + 1)}
                      />
                      <Tool
                        icon={RotateCcw}
                        label={t('重置视角', 'Reset camera')}
                        onClick={() => setCameraReset(cameraReset + 1)}
                      />
                      <Tool
                        icon={Grid2X2}
                        label={t('显示网格', 'Toggle grid')}
                        active={grid}
                        onClick={() => setGrid(!grid)}
                      />
                      <Tool
                        icon={Layers3}
                        label={t('俯视图', 'Top view')}
                        active={top}
                        onClick={() => setTop(!top)}
                      />
                    </div>
                    <ViewportBoundary
                      resetKey={`${world.activeId}-${cameraReset}`}
                      fallback={
                        <div className="scene-loading">
                          <Alert variant="destructive">
                            <AlertTitle>
                              {t('三维场景暂不可用', '3D scene unavailable')}
                            </AlertTitle>
                            <AlertDescription>
                              {t(
                                '场景数据已保留。',
                                'Scene data is preserved.',
                              )}
                            </AlertDescription>
                            <Button
                              variant="outline"
                              onClick={() => setCameraReset(cameraReset + 1)}
                            >
                              {t('重试加载', 'Retry loading')}
                            </Button>
                          </Alert>
                        </div>
                      }
                    >
                      <Suspense
                        fallback={
                          <div className="scene-loading">
                            <LoaderCircle className="spin" />
                            {t('正在加载场景', 'Loading scene')}
                          </div>
                        }
                      >
                        <LabScene
                          selectedId={selectedId}
                          onSelect={select}
                          mode={mode}
                          dark={resolvedTheme === 'dark'}
                          locale={locale}
                          focus={focus}
                          reset={cameraReset}
                          top={top}
                          grid={grid}
                        />
                      </Suspense>
                    </ViewportBoundary>
                    <div className="scene-footer">
                      <Badge variant="outline">
                        {t('模拟实验室', 'Simulated laboratory')}
                      </Badge>
                      <span>
                        {world.layout.entities.length} {t('个对象', 'objects')}
                      </span>
                      {selected ? (
                        <strong>{t(selected.name, selected.en)}</strong>
                      ) : null}
                    </div>
                  </div>
                  <aside
                    className="inspector"
                    aria-label={t('对象信息', 'Object inspector')}
                  >
                    <header className="inspector-header">
                      <Box />
                      <strong>{t('对象信息', 'Object information')}</strong>
                    </header>
                    <Inspector
                      key={selectedId}
                      selected={selected}
                      editing={mode === 'edit'}
                      onStarted={() => advance(9)}
                      onReported={() => advance(10)}
                      t={t}
                    />
                  </aside>
                </div>
                <section
                  className="event-strip"
                  data-tour="history"
                  aria-label={t('操作记录', 'Activity')}
                >
                  <header>
                    <ListTree />
                    <strong>{t('操作记录', 'Activity')}</strong>
                    <span>{world.lab?.events.length ?? 0}</span>
                  </header>
                  <div>
                    {world.lab?.events.slice(0, 3).map((event) => (
                      <p key={event.id}>
                        <time>{new Date(event.at).toLocaleTimeString()}</time>
                        <span>{t(event.zh, event.en)}</span>
                        <small>{t('模拟来源', 'Simulated')}</small>
                      </p>
                    )) ?? (
                      <p>
                        <span>{t('尚无记录', 'No activity yet')}</span>
                      </p>
                    )}
                  </div>
                </section>
              </>
            )}
          </div>
          <CreateDialog
            open={dialog === 'lab'}
            onClose={closeDialog}
            onCreated={() => {
              setDialog(null);
              setSelectedId('');
              setTour({ labId: snapshot().activeId });
              advance(1);
            }}
            t={t}
          />
          <RegisterDialog
            open={dialog === 'register'}
            initialKind={registerKind}
            onClose={closeDialog}
            onRegistered={(id) => {
              setDialog(null);
              setMode('view');
              if (
                tourSnapshot().status === 'active' &&
                !tourSnapshot().review &&
                tourSnapshot().index === 3
              ) {
                setSelectedId('');
                setTour({ entityId: id });
                advance(3);
              } else setSelectedId(id);
            }}
            t={t}
          />
        </AppShellLayout>
      </div>
      <div className="preview-controls" aria-label="Preview controls">
        <Badge variant="outline">PREVIEW</Badge>
        <strong>{t('视觉引导 v2', 'Visual tour v2')}</strong>
        <NativeSelect
          aria-label={t('预览场景', 'Preview scenario')}
          value={scenarioName}
          disabled={world.pending}
          onChange={(event) => void scenario(event.target.value)}
        >
          {[
            ['first', '首次进入', 'First visit'],
            ['midway', '布局修改', 'Layout editing'],
            ['complete', '已完成', 'Completed'],
            ['create-failure', '创建失败', 'Create failure'],
            ['save-failure', '保存失败', 'Save failure'],
            ['runtime-failure', '启动失败', 'Start failure'],
          ].map(([value, zh, en]) => (
            <NativeSelectOption key={value} value={value}>
              {t(zh, en)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <span className="preview-state">
          tour={tour.index + 1}/{guideSteps.length} · {tour.status} · objects=
          {world.layout.entities.length}
        </span>
        <span className="preview-disclaimer">
          {t(
            '真实控件操作 · 设备与 API 模拟',
            'Real controls · simulated devices & API',
          )}
        </span>
        <Tool
          icon={RotateCcw}
          label={t('重置本预览', 'Reset this preview')}
          disabled={world.pending}
          onClick={() => void scenario('first')}
        />
      </div>
      <VisualTour
        locale={locale}
        canNext={canNext}
        onNext={finishOrNext}
        onPause={pause}
      />
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <PreferencesProvider>
    <AppMessagesProvider app={app}>
      <Preview />
    </AppMessagesProvider>
  </PreferencesProvider>,
);
