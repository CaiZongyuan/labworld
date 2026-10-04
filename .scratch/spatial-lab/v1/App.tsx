import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Activity,
  ArrowLeft,
  Bell,
  Bot,
  Box,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  Crosshair,
  FlaskConical,
  Grid2X2,
  History,
  LampDesk,
  Layers3,
  ListTree,
  LoaderCircle,
  MapPin,
  Maximize2,
  Minus,
  Moon,
  Move,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  Settings2,
  Square,
  Sun,
  Thermometer,
  Undo2,
  Wifi,
  WifiOff,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@labos-threejs/ui/components/button';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Input } from '@labos-threejs/ui/components/input';
import { Switch } from '@labos-threejs/ui/components/switch';
import { Tabs, TabsList, TabsTrigger } from '@labos-threejs/ui/components/tabs';
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@labos-threejs/ui/components/toggle-group';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@labos-threejs/ui/components/field';
import { Progress } from '@labos-threejs/ui/components/progress';
import { Alert, AlertDescription } from '@labos-threejs/ui/components/alert';
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@labos-threejs/ui/components/empty';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@labos-threejs/ui/components/dialog';
import {
  active,
  phaseLabels,
  seed,
  start,
  stop,
  tick,
  record,
  type Device,
  type Kind,
  type Position,
  type World,
} from './simulator';
import type { CameraAction } from './LabScene';
import centrifugeImage from '../../../packages/views/src/lab/images/centrifuge.png';
import sensorImage from '../../../packages/views/src/lab/images/sensor.png';
import lightImage from '../../../packages/views/src/lab/images/light.png';
import robotImage from '../../../packages/views/src/lab/images/robot.png';
import labwareImage from '../../../packages/views/src/lab/images/labware.png';

const LabScene = lazy(() => import('./LabScene'));
const icons: { [key in Kind]: LucideIcon } = {
  centrifuge: CircleDot,
  sensor: Thermometer,
  light: LampDesk,
  robot: Bot,
  labware: FlaskConical,
};
const catalog: {
  kind: Kind;
  name: string;
  image: string;
  description: string;
}[] = [
  {
    kind: 'centrifuge',
    name: '冷冻离心机',
    image: centrifugeImage,
    description: '转速 · 温控 · 持续任务',
  },
  {
    kind: 'sensor',
    name: '环境温度传感器',
    image: sensorImage,
    description: '温度 · 连续观测',
  },
  {
    kind: 'light',
    name: '工作照明',
    image: lightImage,
    description: '开关 · 亮度调节',
  },
  {
    kind: 'robot',
    name: '协作机械臂',
    image: robotImage,
    description: '静态表示 · 能力描述',
  },
  {
    kind: 'labware',
    name: '烧杯 · 250 mL',
    image: labwareImage,
    description: '器皿 · 登记位置',
  },
];
type Scenario =
  | 'normal'
  | 'offline'
  | 'empty'
  | 'loading'
  | 'failure'
  | 'conflict'
  | 'readonly';
function Tool({
  icon: Icon,
  label,
  active: checked,
  onClick,
  disabled = false,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <span className="tool-wrap">
      <Button
        variant={checked ? 'secondary' : 'ghost'}
        size="icon"
        aria-label={label}
        aria-pressed={checked}
        disabled={disabled}
        onClick={onClick}
      >
        <Icon />
      </Button>
      <span role="tooltip" className="tool-tip">
        {label}
      </span>
    </span>
  );
}
function Status({
  device,
  online = true,
}: {
  device: Device;
  online?: boolean;
}) {
  if (!online) return <Badge variant="warning">数据过期</Badge>;
  if (device.kind === 'robot') return <Badge variant="secondary">未接入</Badge>;
  if (device.kind === 'labware')
    return <Badge variant="outline">静态对象</Badge>;
  if (device.task?.phase === 'failed')
    return <Badge variant="destructive">任务异常</Badge>;
  if (active(device))
    return (
      <Badge
        variant={device.task?.phase === 'decelerating' ? 'warning' : 'info'}
      >
        {phaseLabels[device.task!.phase]}
      </Badge>
    );
  return (
    <Badge variant="success">
      {device.kind === 'sensor'
        ? '采样中'
        : device.kind === 'light'
          ? device.on
            ? '已开启'
            : '已关闭'
          : '空闲'}
    </Badge>
  );
}
function Metric({
  title,
  value,
  unit,
  hint,
}: {
  title: string;
  value: string;
  unit: string;
  hint?: string;
}) {
  return (
    <div className="reading">
      <span>{title}</span>
      <div>
        <strong>{value}</strong>
        <small>{unit}</small>
      </div>
      {hint && <small>{hint}</small>}
    </div>
  );
}
function RecordList({
  world,
  selected = '',
}: {
  world: World;
  selected?: string;
}) {
  const events = world.events.filter(
    (event) => !selected || event.device === selected,
  );
  return events.length ? (
    <ol className="record-list">
      {events.map((event) => (
        <li key={event.id}>
          <span className="event-dot" />
          <div>
            <strong>{event.title}</strong>
            <small>
              {world.devices.find((d) => d.id === event.device)?.name} ·{' '}
              {event.actor}
            </small>
          </div>
          <time>
            {new Date(event.at).toLocaleTimeString('zh-CN', {
              hour12: false,
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
        </li>
      ))}
    </ol>
  ) : (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <History />
        </EmptyMedia>
        <EmptyTitle>暂无操作记录</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}
function TaskStages({ device }: { device: Device }) {
  const task = device.task;
  const phase = task?.phase;
  const index =
    phase === 'preparing'
      ? 0
      : phase === 'running'
        ? 1
        : phase === 'decelerating'
          ? 2
          : task
            ? 3
            : -1;
  const labels = [
    '准备',
    '运行',
    '减速',
    phase === 'cancelled' ? '已取消' : phase === 'failed' ? '异常' : '完成',
  ];
  return (
    <ol className="task-stages" aria-label="任务阶段">
      {labels.map((label, i) => (
        <li
          key={i}
          className={cn(
            i <= index && 'reached',
            i === index && 'current',
            i === 3 && phase === 'cancelled' && 'cancelled',
          )}
        >
          <span>
            {i < index || (i === 3 && phase === 'completed') ? (
              <Check />
            ) : (
              i + 1
            )}
          </span>
          <small>{label}</small>
        </li>
      ))}
    </ol>
  );
}
function Inspector({
  device,
  world,
  online,
  locked,
  editing,
  dirty,
  onClose,
  onFocus,
  onStart,
  onStop,
  onUpdate,
  onMove,
}: {
  device: Device;
  world: World;
  online: boolean;
  locked: boolean;
  editing: boolean;
  dirty: boolean;
  onClose: () => void;
  onFocus: () => void;
  onStart: (rpm: number, temp: number, seconds: number) => void;
  onStop: () => void;
  onUpdate: (patch: Partial<Device>, title: string) => void;
  onMove: (position: Position) => void;
}) {
  const [tab, setTab] = useState('operate');
  const [rpm, setRpm] = useState('6000');
  const [temp, setTemp] = useState('4');
  const [minutes, setMinutes] = useState('1');
  const Icon = icons[device.kind];
  const task = device.task;
  const busy = active(device);
  const disabled = locked || busy || editing;
  return (
    <aside className="device-inspector" aria-label="设备操作面板">
      <header className="inspector-header">
        <span className={cn('equipment-icon', device.kind)}>
          <Icon />
        </span>
        <div>
          <small>{device.id.toUpperCase()} · 模拟对象</small>
          <h2>{device.name}</h2>
        </div>
        <Tool icon={X} label="关闭设备面板" onClick={onClose} />
      </header>
      <div className="device-location">
        <MapPin />
        <span>{device.location}</span>
        <Status device={device} online={online} />
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList variant="line" className="inspector-tabs">
          <TabsTrigger value="operate">操作</TabsTrigger>
          <TabsTrigger value="records">记录</TabsTrigger>
          <TabsTrigger value="details">详情</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="inspector-scroll">
        {tab === 'records' ? (
          <RecordList world={world} selected={device.id} />
        ) : tab === 'details' ? (
          <>
            <h3>对象与来源</h3>
            <dl className="details-list">
              <dt>对象身份</dt>
              <dd>{device.id}</dd>
              <dt>资产定义</dt>
              <dd>{device.kind} · v1.0</dd>
              <dt>状态来源</dt>
              <dd>虚拟设备程序</dd>
              <dt>登记位置</dt>
              <dd>{device.location} · 人工登记</dd>
              <dt>数据质量</dt>
              <dd>{online ? '良好 · 当前观测' : '最后观测 · 已过期'}</dd>
              <dt>当前任务</dt>
              <dd>{task?.id ?? '无'}</dd>
              <dt>最近结果</dt>
              <dd>
                {task && !busy ? phaseLabels[task.phase] : '尚无结束结果'}
              </dd>
            </dl>
            <h3>三维摆放</h3>
            <dl className="details-list">
              <dt>X / Y / Z</dt>
              <dd>
                {device.position.map((value) => value.toFixed(2)).join(' / ')} m
              </dd>
              <dt>布局状态</dt>
              <dd>{dirty ? '未保存' : '已保存'}</dd>
            </dl>
          </>
        ) : (
          <>
            {!online && (
              <Alert variant="default">
                <WifiOff />
                <AlertDescription>
                  连接中断。显示最后一次观测，设备操作暂不可用。
                </AlertDescription>
              </Alert>
            )}
            {locked && online && (
              <Alert>
                <AlertDescription>
                  当前身份为只读，设备操作不可用。
                </AlertDescription>
              </Alert>
            )}
            {editing ? (
              <>
                <h3>三维摆放</h3>
                <FieldGroup className="placement-fields">
                  {device.position.map((value, index) => (
                    <Field key={index}>
                      <FieldLabel htmlFor={`axis-${index}`}>
                        {['X', 'Y', 'Z'][index]} · m
                      </FieldLabel>
                      <Input
                        id={`axis-${index}`}
                        type="number"
                        step="0.1"
                        value={Number(value.toFixed(2))}
                        onChange={(event) => {
                          const position = [...device.position] as Position;
                          position[index] = Number(event.target.value);
                          onMove(position);
                        }}
                      />
                    </Field>
                  ))}
                </FieldGroup>
                <div className="placement-location">
                  <MapPin />
                  <span>登记位置：{device.location}</span>
                </div>
              </>
            ) : device.kind === 'centrifuge' ? (
              <>
                <section className="live-readings" aria-label="实际观测">
                  <Metric
                    title="实际转速"
                    value={Math.round(device.rpm).toLocaleString('en-US')}
                    unit="rpm"
                    hint={`目标 ${task && busy ? task.targetRpm.toLocaleString('en-US') : '—'}`}
                  />
                  <Metric
                    title="实际温度"
                    value={device.temperature.toFixed(1)}
                    unit="°C"
                    hint={`目标 ${task && busy ? `${task.targetTemp}°C` : '—'}`}
                  />
                </section>
                <div className="reading-source">
                  <span className={cn('status-dot', !online && 'warning')} />
                  {online ? '当前观测' : '数据过期'}
                  <span>虚拟设备程序</span>
                </div>
                {task && (
                  <section className="inspector-task">
                    <div className="section-heading">
                      <h3>当前任务</h3>
                      <Badge
                        variant={
                          task.phase === 'failed'
                            ? 'destructive'
                            : busy
                              ? 'info'
                              : 'secondary'
                        }
                      >
                        {phaseLabels[task.phase]}
                      </Badge>
                    </div>
                    <TaskStages device={device} />
                    <div className="task-time">
                      <span>计时进度</span>
                      <strong>
                        {Math.floor(task.elapsed)} / {task.duration} s
                      </strong>
                    </div>
                    <Progress
                      value={(task.elapsed / task.duration) * 100}
                      aria-label="计时进度"
                    />
                    {task.phase === 'cancelled' && (
                      <p className="task-outcome">任务已取消 · 设备已空闲</p>
                    )}
                    {task.phase === 'completed' && (
                      <p className="task-outcome success">
                        <CheckCircle2 />
                        任务已完成 · 设备已空闲
                      </p>
                    )}
                    {task.phase === 'failed' && (
                      <Alert variant="destructive">
                        <AlertDescription>
                          设备程序中断，本次任务未完成。
                        </AlertDescription>
                      </Alert>
                    )}
                  </section>
                )}
                <form
                  className="task-form"
                  id={`task-form-${device.id}`}
                  onSubmit={(event) => {
                    event.preventDefault();
                    onStart(Number(rpm), Number(temp), Number(minutes) * 60);
                  }}
                >
                  <div className="section-heading">
                    <h3>{busy ? '任务参数' : '设置任务'}</h3>
                    <span>冷冻离心</span>
                  </div>
                  <FieldGroup className="parameter-fields">
                    <Field data-disabled={disabled}>
                      <FieldLabel htmlFor="target-rpm">
                        目标转速 · rpm
                      </FieldLabel>
                      <Input
                        id="target-rpm"
                        type="number"
                        min={500}
                        max={15000}
                        step={100}
                        value={rpm}
                        required
                        disabled={disabled}
                        onChange={(event) => setRpm(event.target.value)}
                      />
                    </Field>
                    <Field data-disabled={disabled}>
                      <FieldLabel htmlFor="target-temp">
                        目标温度 · °C
                      </FieldLabel>
                      <Input
                        id="target-temp"
                        type="number"
                        min={-10}
                        max={40}
                        step={0.5}
                        value={temp}
                        required
                        disabled={disabled}
                        onChange={(event) => setTemp(event.target.value)}
                      />
                    </Field>
                    <Field data-disabled={disabled}>
                      <FieldLabel htmlFor="duration">持续时间 · min</FieldLabel>
                      <Input
                        id="duration"
                        type="number"
                        min={0.1}
                        max={60}
                        step={0.1}
                        value={minutes}
                        required
                        disabled={disabled}
                        onChange={(event) => setMinutes(event.target.value)}
                      />
                    </Field>
                  </FieldGroup>
                  <div className="device-actions">
                    <Button type="submit" size="lg" disabled={disabled}>
                      <Play data-icon="inline-start" />
                      {task && !busy ? '再次启动' : '启动任务'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="lg"
                      disabled={
                        locked || !busy || task?.phase === 'decelerating'
                      }
                      onClick={onStop}
                    >
                      <Square data-icon="inline-start" />
                      停止
                    </Button>
                  </div>
                </form>
              </>
            ) : device.kind === 'sensor' ? (
              <>
                <section className="live-readings single">
                  <Metric
                    title="环境温度"
                    value={device.temperature.toFixed(1)}
                    unit="°C"
                  />
                </section>
                <div className="reading-source">
                  <span className={cn('status-dot', !online && 'warning')} />
                  {online ? '当前观测' : '数据过期'}
                  <span>虚拟设备程序</span>
                </div>
                <h3>近 1 分钟</h3>
                <div className="temperature-chart" aria-label="模拟温度变化">
                  {Array.from({ length: 32 }, (_, i) => (
                    <span
                      key={i}
                      style={{
                        height: `${50 + Math.sin((world.clock - 60 + i * 2) / 28) * 25}%`,
                      }}
                    />
                  ))}
                </div>
                <div className="chart-axis">
                  <span>−60 s</span>
                  <span>现在</span>
                </div>
                <dl className="details-list">
                  <dt>采样周期</dt>
                  <dd>1 s</dd>
                  <dt>状态来源</dt>
                  <dd>虚拟设备程序</dd>
                  <dt>数据质量</dt>
                  <dd>{online ? '良好' : '已过期'}</dd>
                </dl>
              </>
            ) : device.kind === 'light' ? (
              <>
                <section className="light-power">
                  <div>
                    <h3>工作照明</h3>
                    <small>{device.on ? '已开启' : '已关闭'}</small>
                  </div>
                  <Switch
                    aria-label="工作照明开关"
                    checked={device.on}
                    disabled={locked}
                    onCheckedChange={(on) =>
                      onUpdate({ on }, on ? '照明已开启' : '照明已关闭')
                    }
                  />
                </section>
                <Metric
                  title="实际亮度"
                  value={device.on ? String(device.brightness) : '0'}
                  unit="%"
                />
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="brightness">目标亮度</FieldLabel>
                    <input
                      id="brightness"
                      type="range"
                      min={0}
                      max={100}
                      value={device.brightness}
                      disabled={locked}
                      onChange={(event) =>
                        onUpdate(
                          { brightness: Number(event.target.value) },
                          '亮度已调整',
                        )
                      }
                    />
                  </Field>
                </FieldGroup>
                <div className="reading-source">
                  <span className="status-dot" />
                  当前观测<span>虚拟设备程序</span>
                </div>
              </>
            ) : device.kind === 'robot' ? (
              <>
                <div className="robot-state">
                  <Bot />
                  <h3>协作机械臂</h3>
                  <Badge variant="secondary">未接入运行端</Badge>
                </div>
                <dl className="details-list">
                  <dt>对象类型</dt>
                  <dd>虚拟对象 · 静态表示</dd>
                  <dt>已声明能力</dt>
                  <dd>移动 · 抓取 · 放置</dd>
                  <dt>执行状态</dt>
                  <dd>尚未实现</dd>
                </dl>
                <Button variant="outline" disabled className="full-width">
                  <Play data-icon="inline-start" />
                  执行任务
                </Button>
              </>
            ) : (
              <>
                <section className="live-readings single">
                  <Metric title="标称容量" value="250" unit="mL" />
                </section>
                <dl className="details-list">
                  <dt>登记位置</dt>
                  <dd>{device.location}</dd>
                  <dt>登记来源</dt>
                  <dd>人工登记</dd>
                  <dt>状态</dt>
                  <dd>静态对象</dd>
                </dl>
              </>
            )}
          </>
        )}
      </div>
      <footer
        className={cn(
          'inspector-footer',
          device.kind === 'centrifuge' &&
            !editing &&
            tab === 'operate' &&
            'has-mobile-actions',
        )}
      >
        {device.kind === 'centrifuge' && !editing && tab === 'operate' && (
          <div className="mobile-device-actions">
            <Button
              type="submit"
              form={`task-form-${device.id}`}
              disabled={disabled}
            >
              <Play data-icon="inline-start" />
              {task && !busy ? '再次启动' : '启动任务'}
            </Button>
            <Button
              variant="outline"
              disabled={locked || !busy || task?.phase === 'decelerating'}
              onClick={onStop}
            >
              <Square data-icon="inline-start" />
              停止
            </Button>
          </div>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="inspector-locate"
          onClick={onFocus}
        >
          <Crosshair data-icon="inline-start" />
          定位设备
        </Button>
        <small className="inspector-identifier">
          {device.id.toUpperCase()}
        </small>
      </footer>
    </aside>
  );
}

export default function App() {
  const [world, setWorld] = useState<World>(seed);
  const [scenario, setScenario] = useState<Scenario>('normal');
  const [frozen, setFrozen] = useState<World | null>(null);
  const [speed, setSpeed] = useState(10);
  const [selected, setSelected] = useState('');
  const [directory, setDirectory] = useState(false);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('all');
  const [dark, setDark] = useState(false);
  const [railExpanded, setRailExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [grid, setGrid] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [history, setHistory] = useState(false);
  const [page, setPage] = useState('lab');
  const [addKind, setAddKind] = useState<Kind | null>(null);
  const [addName, setAddName] = useState('');
  const [settings, setSettings] = useState(false);
  const [action, setAction] = useState<CameraAction>({ key: 0, kind: 'reset' });
  const [cameraView, setCameraView] = useState('iso');
  const saved = useRef(
    seed().devices.map(({ id, position }) => ({ id, position })),
  );
  const online = scenario !== 'offline';
  const locked = !online || scenario === 'readonly' || scenario === 'loading';
  const visible =
    scenario === 'empty'
      ? { ...world, devices: [] }
      : !online && frozen
        ? frozen
        : world;
  const device = visible.devices.find((item) => item.id === selected);
  const runningDevices = visible.devices.filter(active);
  const currentTask = device?.task
    ? device
    : (runningDevices[0] ?? visible.devices.find((item) => item.task));
  const filtered = visible.devices.filter(
    (item) =>
      item.name.includes(search) &&
      (kind === 'all' ||
        (kind === 'active' && active(item)) ||
        kind === item.kind),
  );
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    return () => document.documentElement.classList.remove('dark');
  }, [dark]);
  useEffect(() => {
    const timer = window.setInterval(
      () => setWorld((current) => tick(current, speed * 0.2)),
      200,
    );
    return () => window.clearInterval(timer);
  }, [speed]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDirectory(false);
        setHistory(false);
        setSelected('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const select = useCallback((id: string) => {
    setSelected(id);
    setHistory(false);
    if (window.innerWidth < 900) setDirectory(false);
  }, []);
  const camera = useCallback(
    (kind: CameraAction['kind'], position?: Position) =>
      setAction((current) => ({ key: current.key + 1, kind, position })),
    [],
  );
  const move = useCallback((id: string, position: Position) => {
    setWorld((current) => ({
      ...current,
      devices: current.devices.map((item) =>
        item.id === id ? { ...item, position } : item,
      ),
    }));
    setDirty(true);
  }, []);
  function changeScenario(value: Scenario) {
    if (value === 'offline') setFrozen(world);
    setScenario(value);
    setConflict(value === 'conflict');
    if (value === 'conflict') {
      setEditing(true);
      setSelected('cf-01');
      setDirty(true);
    }
    if (value === 'readonly') setEditing(false);
    if (value === 'empty') {
      setSelected('');
      setDirectory(false);
    }
    if (value === 'failure') {
      setSelected('cf-01');
      setWorld((current) =>
        record(
          {
            ...current,
            devices: current.devices.map((item) =>
              item.id === 'cf-01'
                ? {
                    ...item,
                    rpm: 0,
                    task: {
                      phase: 'failed',
                      targetRpm: 6000,
                      targetTemp: 4,
                      duration: 60,
                      elapsed: 19,
                      cancelling: false,
                      id: 'task-interrupted',
                    },
                  }
                : item,
            ),
          },
          'cf-01',
          '设备程序中断，任务未完成',
          '设备程序',
        ),
      );
    }
  }
  function reset() {
    setWorld(seed());
    setScenario('normal');
    setSelected('');
    setFrozen(null);
    setEditing(false);
    setDirty(false);
    setConflict(false);
    setDirectory(false);
    setHistory(false);
    setPage('lab');
    setSearch('');
    setKind('all');
    saved.current = seed().devices.map(({ id, position }) => ({
      id,
      position,
    }));
    camera('reset');
    setCameraView('iso');
  }
  function restore() {
    setWorld((current) => ({
      ...current,
      devices: current.devices.map((item) => ({
        ...item,
        position:
          saved.current.find((entry) => entry.id === item.id)?.position ??
          item.position,
      })),
    }));
    setDirty(false);
    setConflict(false);
    if (scenario === 'conflict') setScenario('normal');
  }
  function save() {
    if (conflict || locked) return;
    saved.current = world.devices.map(({ id, position }) => ({ id, position }));
    setDirty(false);
    setWorld((current) => record(current, selected, '三维布局已保存'));
  }
  function openAdd(kind: Kind) {
    setAddKind(kind);
    setAddName(catalog.find((item) => item.kind === kind)!.name);
  }
  function add() {
    if (!addKind || !addName.trim()) return;
    const id = `${addKind}-${Date.now()}`;
    const newDevice: Device = {
      id,
      name: addName.trim(),
      kind: addKind,
      location: '未登记',
      position: [0, 0, 2.2],
      rpm: 0,
      temperature: 22.4,
      brightness: 80,
      on: true,
    };
    setWorld((current) =>
      record(
        {
          ...current,
          devices:
            scenario === 'empty'
              ? [newDevice]
              : [...current.devices, newDevice],
        },
        id,
        '实验室对象已登记',
      ),
    );
    setScenario('normal');
    setAddKind(null);
    setPage('lab');
    setSelected(id);
  }
  const assetDialog: ReactNode = (
    <Dialog
      open={!!addKind}
      onOpenChange={(open) => {
        if (!open) setAddKind(null);
      }}
    >
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <header className="dialog-header">
            <DialogTitle>登记实验室对象</DialogTitle>
            <DialogDescription>
              {catalog.find((item) => item.kind === addKind)?.name} · v1.0 ·
              模拟对象
            </DialogDescription>
          </header>
          <FieldGroup className="dialog-fields">
            <Field>
              <FieldLabel htmlFor="entity-name">对象名称</FieldLabel>
              <Input
                id="entity-name"
                autoFocus
                required
                maxLength={48}
                value={addName}
                onChange={(event) => setAddName(event.target.value)}
              />
            </Field>
          </FieldGroup>
          <footer className="dialog-footer">
            <Button
              variant="outline"
              type="button"
              onClick={() => setAddKind(null)}
            >
              取消
            </Button>
            <Button type="submit">
              <Plus data-icon="inline-start" />
              登记对象
            </Button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
  return (
    <div className={cn('spatial-preview', dark && 'dark')}>
      <div className="application">
        <header className="app-header">
          <div className="brand">
            <span>
              <Boxes />
            </span>
            <strong>Lab Word</strong>
          </div>
          <div className="header-context">
            <span>实验室</span>
            <ChevronRight />
            <strong>{page === 'lab' ? '细胞制备实验室' : '资产库'}</strong>
          </div>
          <div className="header-search">
            <Search />
            <Input
              type="search"
              aria-label="搜索实验室对象"
              placeholder="搜索设备、器皿…"
              value={search}
              onFocus={() => {
                setPage('lab');
                setDirectory(true);
              }}
              onChange={(event) => {
                setSearch(event.target.value);
                setDirectory(true);
              }}
            />
          </div>
          <div className="header-right">
            <span
              className={cn('connection-status', !online && 'offline')}
              role="status"
            >
              {online ? <span className="status-dot" /> : <WifiOff />}
              {online ? '实时同步' : '连接中断'}
            </span>
            <Tool
              icon={Bell}
              label="通知与事件"
              active={history}
              onClick={() => {
                setPage('lab');
                setHistory(!history);
              }}
            />
            <Tool
              icon={dark ? Sun : Moon}
              label={dark ? '切换亮色' : '切换暗色'}
              onClick={() => setDark(!dark)}
            />
          </div>
        </header>
        <div className="app-body">
          <nav
            className={cn('nav-rail', railExpanded && 'expanded')}
            aria-label="主导航"
          >
            <Tool
              icon={railExpanded ? PanelLeftClose : PanelLeftOpen}
              label={railExpanded ? '收起主导航' : '展开主导航'}
              onClick={() => setRailExpanded(!railExpanded)}
            />
            <div className="rail-links">
              <Button
                variant={page === 'lab' ? 'secondary' : 'ghost'}
                className="rail-link"
                aria-label="实验室"
                onClick={() => setPage('lab')}
              >
                <Layers3 />
                <span>实验室</span>
              </Button>
              <Button
                variant={page === 'assets' ? 'secondary' : 'ghost'}
                className="rail-link"
                aria-label="资产库"
                onClick={() => setPage('assets')}
              >
                <Boxes />
                <span>资产库</span>
              </Button>
            </div>
            <div className="rail-footer">
              <Button
                variant="ghost"
                className="user-entry"
                aria-label="陈予的设置"
                onClick={() => setSettings(true)}
              >
                <span className="user-avatar">予</span>
                <span>
                  陈予<small>成员</small>
                </span>
              </Button>
            </div>
          </nav>
          <main
            className={cn(
              'lab-workspace',
              device && 'has-selection',
              directory && 'directory-open',
              page === 'assets' && 'asset-page',
            )}
          >
            {page === 'assets' ? (
              <section className="asset-library">
                <header>
                  <div>
                    <span className="eyebrow">ASSET LIBRARY</span>
                    <h1>资产库</h1>
                  </div>
                  <Button variant="outline" onClick={() => setPage('lab')}>
                    <ArrowLeft data-icon="inline-start" />
                    返回实验室
                  </Button>
                </header>
                <div className="asset-count">
                  内置资产 <span>{catalog.length}</span>
                </div>
                <div className="asset-grid">
                  {catalog.map((asset) => (
                    <article key={asset.kind} className="asset-item">
                      <img src={asset.image} alt={asset.name} />
                      <div>
                        <span className="eyebrow">
                          {asset.kind.toUpperCase()} · V1.0
                        </span>
                        <h2>{asset.name}</h2>
                        <p>{asset.description}</p>
                      </div>
                      <Button
                        variant="outline"
                        disabled={locked}
                        onClick={() => openAdd(asset.kind)}
                      >
                        <Plus data-icon="inline-start" />
                        加入实验室
                      </Button>
                    </article>
                  ))}
                </div>
              </section>
            ) : (
              <>
                <div className="scene-host">
                  <Suspense
                    fallback={
                      <div className="scene-loading">
                        <LoaderCircle className="spin" />
                        加载实验室
                      </div>
                    }
                  >
                    <LabScene
                      devices={visible.devices}
                      selected={selected}
                      onSelect={select}
                      onFocus={(position) => camera('focus', position)}
                      onMove={move}
                      dark={dark}
                      editing={editing && !locked}
                      grid={grid}
                      action={action}
                    />
                  </Suspense>
                </div>
                <section className="scene-heading">
                  <div className="lab-location">
                    <span className="location-marker">B2</span>
                    <span>07 / 细胞制备区</span>
                    <ChevronDown />
                  </div>
                  <h1>细胞制备实验室</h1>
                  <div className="overview-metrics">
                    <div>
                      <Box />
                      <strong>{visible.devices.length}</strong>
                      <span>对象</span>
                    </div>
                    <div>
                      <Activity />
                      <strong>{runningDevices.length}</strong>
                      <span>运行中</span>
                    </div>
                    <div>
                      <Thermometer />
                      <strong>
                        {visible.devices
                          .find((item) => item.kind === 'sensor')
                          ?.temperature.toFixed(1) ?? '—'}
                        <small>°C</small>
                      </strong>
                      <span>室温</span>
                    </div>
                  </div>
                </section>
                <div className="workspace-modes">
                  <ToggleGroup
                    multiple={false}
                    value={[editing ? 'edit' : 'run']}
                    onValueChange={(values) => {
                      if (values[0] && !(locked && values[0] === 'edit'))
                        setEditing(values[0] === 'edit');
                    }}
                    aria-label="工作模式"
                    size="sm"
                  >
                    <ToggleGroupItem value="run">
                      <Play data-icon="inline-start" />
                      运行
                    </ToggleGroupItem>
                    <ToggleGroupItem value="edit" disabled={locked}>
                      <Pencil data-icon="inline-start" />
                      编辑
                    </ToggleGroupItem>
                  </ToggleGroup>
                  <span className="mode-status">
                    {editing ? (dirty ? '未保存' : '已保存') : '运行查看'}
                  </span>
                </div>
                <div className="scene-commands">
                  <Tool
                    icon={ListTree}
                    label="对象目录"
                    active={directory}
                    onClick={() => setDirectory(!directory)}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={locked}
                    onClick={() => openAdd('centrifuge')}
                  >
                    <Plus data-icon="inline-start" />
                    <span>登记对象</span>
                  </Button>
                </div>
                {!online && (
                  <div className="connection-alert">
                    <Alert>
                      <WifiOff />
                      <AlertDescription>
                        连接中断 · 显示最后观测
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => changeScenario('normal')}
                        >
                          重新连接
                        </Button>
                      </AlertDescription>
                    </Alert>
                  </div>
                )}
                {scenario === 'loading' && (
                  <div className="workspace-loading" role="status">
                    <LoaderCircle className="spin" />
                    <span>正在加载实验室</span>
                  </div>
                )}
                {scenario === 'empty' && (
                  <div className="workspace-empty">
                    <Empty>
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <Boxes />
                        </EmptyMedia>
                        <EmptyTitle>实验室尚无对象</EmptyTitle>
                      </EmptyHeader>
                      <Button onClick={() => openAdd('centrifuge')}>
                        <Plus data-icon="inline-start" />
                        登记第一个对象
                      </Button>
                    </Empty>
                  </div>
                )}
                {directory && (
                  <aside className="object-directory" aria-label="对象目录">
                    <header>
                      <div>
                        <ListTree />
                        <h2>对象目录</h2>
                        <span>{visible.devices.length}</span>
                      </div>
                      <Tool
                        icon={X}
                        label="关闭对象目录"
                        onClick={() => setDirectory(false)}
                      />
                    </header>
                    <div className="directory-search">
                      <Search />
                      <Input
                        type="search"
                        aria-label="筛选对象"
                        placeholder="搜索对象…"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                      />
                    </div>
                    <select
                      className="directory-filter"
                      aria-label="对象类别"
                      value={kind}
                      onChange={(event) => setKind(event.target.value)}
                    >
                      <option value="all">全部对象</option>
                      <option value="active">运行中</option>
                      {catalog.map((item) => (
                        <option key={item.kind} value={item.kind}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                    <div className="directory-list">
                      {filtered.map((item) => {
                        const Icon = icons[item.kind];
                        return (
                          <button
                            key={item.id}
                            className={cn(
                              'directory-item',
                              item.id === selected && 'selected',
                            )}
                            onClick={() => select(item.id)}
                            aria-label={`目录选择 ${item.name}`}
                          >
                            <span className={cn('equipment-icon', item.kind)}>
                              <Icon />
                            </span>
                            <span>
                              <strong>{item.name}</strong>
                              <small>{item.location}</small>
                            </span>
                            <span
                              className={cn(
                                'directory-status',
                                active(item) && 'running',
                                item.kind === 'robot' && 'unbound',
                              )}
                            />
                          </button>
                        );
                      })}
                      {!filtered.length && (
                        <Empty>
                          <EmptyHeader>
                            <EmptyTitle>没有匹配的对象</EmptyTitle>
                          </EmptyHeader>
                        </Empty>
                      )}
                    </div>
                    <footer>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setPage('assets')}
                      >
                        <Boxes data-icon="inline-start" />
                        从资产库添加
                        <ChevronRight data-icon="inline-end" />
                      </Button>
                    </footer>
                  </aside>
                )}
                {device && (
                  <Inspector
                    key={device.id}
                    device={device}
                    world={visible}
                    online={online}
                    locked={locked}
                    editing={editing}
                    dirty={dirty}
                    onClose={() => setSelected('')}
                    onFocus={() => camera('focus', device.position)}
                    onStart={(rpm, temp, seconds) => {
                      if (!locked)
                        setWorld((current) =>
                          start(current, device.id, rpm, temp, seconds),
                        );
                    }}
                    onStop={() => {
                      if (!locked)
                        setWorld((current) => stop(current, device.id));
                    }}
                    onUpdate={(patch, title) => {
                      if (!locked)
                        setWorld((current) =>
                          record(
                            {
                              ...current,
                              devices: current.devices.map((item) =>
                                item.id === device.id
                                  ? { ...item, ...patch }
                                  : item,
                              ),
                            },
                            device.id,
                            title,
                          ),
                        );
                    }}
                    onMove={(position) => move(device.id, position)}
                  />
                )}
                <div className="camera-toolbar">
                  <ToggleGroup
                    multiple={false}
                    value={[cameraView]}
                    onValueChange={(values) => {
                      if (values[0]) {
                        setCameraView(values[0]);
                        camera(values[0] === 'top' ? 'top' : 'reset');
                      }
                    }}
                    size="sm"
                    aria-label="相机视图"
                  >
                    <ToggleGroupItem
                      value="iso"
                      aria-label="透视视图"
                      title="透视视图"
                    >
                      <Box />
                    </ToggleGroupItem>
                    <ToggleGroupItem
                      value="top"
                      aria-label="俯视视图"
                      title="俯视视图"
                    >
                      <Grid2X2 />
                    </ToggleGroupItem>
                  </ToggleGroup>
                  <span className="toolbar-divider" />
                  <Tool
                    icon={Plus}
                    label="放大场景"
                    onClick={() => camera('in')}
                  />
                  <Tool
                    icon={Minus}
                    label="缩小场景"
                    onClick={() => camera('out')}
                  />
                  <Tool
                    icon={RotateCcw}
                    label="恢复全景"
                    onClick={() => {
                      camera('reset');
                      setCameraView('iso');
                    }}
                  />
                  <Tool
                    icon={Maximize2}
                    label="全屏"
                    onClick={() => {
                      if (document.fullscreenElement)
                        void document.exitFullscreen();
                      else void document.documentElement.requestFullscreen();
                    }}
                  />
                </div>
                {editing && (
                  <div className="layout-toolbar">
                    <span>
                      <Move />
                      三维布局
                    </span>
                    <Tool
                      icon={Grid2X2}
                      label="显示布局网格"
                      active={grid}
                      onClick={() => setGrid(!grid)}
                    />
                    <Tool
                      icon={Undo2}
                      label="放弃布局修改"
                      disabled={!dirty}
                      onClick={restore}
                    />
                    <Button
                      size="sm"
                      disabled={!dirty || conflict || locked}
                      onClick={save}
                    >
                      <Save data-icon="inline-start" />
                      保存
                    </Button>
                  </div>
                )}
                {editing && conflict && (
                  <div className="layout-conflict">
                    <Alert>
                      <AlertDescription>
                        布局版本已更新，当前草稿尚未保存。
                      </AlertDescription>
                      <div>
                        <Button
                          size="sm"
                          onClick={() => {
                            setConflict(false);
                            setScenario('normal');
                          }}
                        >
                          保留草稿重试
                        </Button>
                        <Button variant="outline" size="sm" onClick={restore}>
                          放弃草稿
                        </Button>
                      </div>
                    </Alert>
                  </div>
                )}
                <section className="task-dock" aria-label="任务概览">
                  <div className="dock-task-title">
                    <span className="dock-icon">
                      {currentTask ? <CircleDot /> : <Activity />}
                    </span>
                    <div>
                      <small>{currentTask ? '当前任务' : '实验室状态'}</small>
                      <strong>
                        {currentTask?.name ??
                          (runningDevices.length
                            ? `${runningDevices.length} 台设备运行中`
                            : '设备就绪')}
                      </strong>
                    </div>
                  </div>
                  {currentTask ? (
                    <>
                      <TaskStages device={currentTask} />
                      <div className="dock-task-time">
                        <strong>
                          {currentTask.task!.phase === 'completed'
                            ? '完成'
                            : currentTask.task!.phase === 'cancelled'
                              ? '已取消'
                              : currentTask.task!.phase === 'failed'
                                ? '异常'
                                : currentTask.task!.phase === 'preparing'
                                  ? '准备中'
                                  : `${Math.ceil(currentTask.task!.duration - currentTask.task!.elapsed)} s`}
                        </strong>
                        <span>
                          {active(currentTask) ? '本次任务' : '任务结果'}
                        </span>
                      </div>
                    </>
                  ) : (
                    <div className="dock-idle">
                      <span className="status-dot" />
                      {online ? '观测持续更新' : '等待重新连接'}
                      <span>
                        模拟对象{' '}
                        {
                          visible.devices.filter((item) =>
                            ['centrifuge', 'sensor', 'light'].includes(
                              item.kind,
                            ),
                          ).length
                        }
                      </span>
                    </div>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="history-button"
                    onClick={() => setHistory(!history)}
                  >
                    <History data-icon="inline-start" />
                    <span>运行记录</span>
                    <Badge variant="secondary">{visible.events.length}</Badge>
                  </Button>
                </section>
                {history && (
                  <section className="history-drawer" aria-label="运行记录">
                    <header>
                      <div>
                        <History />
                        <h2>运行记录</h2>
                        <span>{visible.events.length}</span>
                      </div>
                      <Tool
                        icon={X}
                        label="关闭运行记录"
                        onClick={() => setHistory(false)}
                      />
                    </header>
                    <RecordList world={visible} />
                  </section>
                )}
              </>
            )}
          </main>
        </div>
      </div>
      <footer className="preview-controls" aria-label="预览工具">
        <span>
          <span className="preview-version">V1</span>
          <strong>交互预览</strong>
          <span className="preview-simulated">模拟数据</span>
        </span>
        <div>
          <label>
            场景
            <select
              aria-label="预览场景"
              value={scenario}
              onChange={(event) =>
                changeScenario(event.target.value as Scenario)
              }
            >
              <option value="normal">正常</option>
              <option value="offline">连接中断</option>
              <option value="empty">空场景</option>
              <option value="loading">加载中</option>
              <option value="failure">设备异常</option>
              <option value="conflict">保存冲突</option>
              <option value="readonly">只读身份</option>
            </select>
          </label>
          <label>
            时间
            <select
              aria-label="模拟时间速度"
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value))}
            >
              <option value={1}>1×</option>
              <option value={10}>10×</option>
              <option value={30}>30×</option>
            </select>
          </label>
          <Button variant="ghost" size="xs" onClick={reset}>
            <RotateCcw data-icon="inline-start" />
            重置
          </Button>
        </div>
      </footer>
      {assetDialog}
      <Dialog open={settings} onOpenChange={setSettings}>
        <DialogContent>
          <header className="dialog-header">
            <DialogTitle>陈予的设置</DialogTitle>
            <DialogDescription>实验室成员</DialogDescription>
          </header>
          <FieldGroup className="dialog-fields">
            <Field orientation="horizontal">
              <FieldLabel htmlFor="dark-theme">
                <Moon />
                暗色外观
              </FieldLabel>
              <Switch
                id="dark-theme"
                checked={dark}
                onCheckedChange={setDark}
              />
            </Field>
          </FieldGroup>
          <footer className="dialog-footer">
            <Button onClick={() => setSettings(false)}>完成</Button>
          </footer>
        </DialogContent>
      </Dialog>
    </div>
  );
}
