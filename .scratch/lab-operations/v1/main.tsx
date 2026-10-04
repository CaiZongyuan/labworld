import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Box,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  CloudCheck,
  FlaskConical,
  History,
  Layers3,
  LayoutDashboard,
  LibraryBig,
  ListFilter,
  MapPin,
  Moon,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  ShieldX,
  Sun,
  WifiOff,
  X,
} from 'lucide-react';
import { Button } from '@labos-threejs/ui/components/button';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Input } from '@labos-threejs/ui/components/input';
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
  AlertTitle,
  AlertDescription,
} from '@labos-threejs/ui/components/alert';
import { Skeleton } from '@labos-threejs/ui/components/skeleton';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyMedia,
} from '@labos-threejs/ui/components/empty';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@labos-threejs/ui/components/field';
import { DeviceStatus, images, Segments, Thumbnail, Tool } from './ui';
import Detail, { type CommandState, type Operation } from './detail';
import Trend from './chart';
import {
  age,
  attention,
  clock,
  kindNames,
  reading,
  seedDevices,
  seedEntries,
  taskActive,
  taskNames,
  tickDevices,
  type Device,
  type Entry,
} from './model';
import './style.css';

const Space = lazy(() => import('./space'));
const pages = [
  { id: 'overview', label: '运行总览', icon: LayoutDashboard },
  { id: 'devices', label: '设备', icon: Box },
  { id: 'space', label: '空间', icon: Layers3 },
  { id: 'records', label: '运行记录', icon: History },
];
const operations: Record<Operation, string> = {
  'start-program': '启动新设备程序',
  'stop-program': '停止设备程序',
  'restart-program': '重新启动设备程序',
  light: '更新照明状态',
  'start-task': '启动离心任务',
  'stop-task': '停止离心任务',
};

function App() {
  const initialPage =
    new URLSearchParams(location.search).get('view') ?? 'overview';
  const [view, setView] = useState(
    pages.some((page) => page.id === initialPage) ? initialPage : 'overview',
  );
  const [devices, setDevices] = useState(seedDevices);
  const [entries, setEntries] = useState(seedEntries);
  const [selected, setSelected] = useState<string | null>(null);
  const [scenario, setScenario] = useState('normal');
  const [lab, setLab] = useState('research');
  const [filter, setFilter] = useState('all');
  const [zone, setZone] = useState('all');
  const [search, setSearch] = useState('');
  const [dark, setDark] = useState(false);
  const [toast, setToast] = useState('');
  const [command, setCommand] = useState<CommandState>(null);
  const [recordType, setRecordType] = useState('all');
  const [recordDevice, setRecordDevice] = useState('all');
  const [recordRange, setRecordRange] = useState('today');
  const [hours, setHours] = useState('1');
  const [sensor, setSensor] = useState('TS-01');
  const [utility, setUtility] = useState<'assets' | 'settings' | null>(null);
  const [labName, setLabName] = useState('研发实验室');
  const [now, setNow] = useState(Date.now());
  const [lastSync, setLastSync] = useState(Date.now());
  const generation = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const previousTasks = useRef<Record<string, string>>({
    'CF-01': 'running',
    'CF-02': 'interrupted',
  });
  const offline = scenario === 'offline',
    denied = scenario === 'denied',
    loading = scenario === 'loading';
  const empty = scenario === 'empty' || lab === 'empty';
  const available = !offline && !denied && !loading;
  const currentDevices = empty ? [] : devices;
  const selectedDevice = currentDevices.find(
    (device) => device.id === selected,
  );
  const issues = currentDevices.filter((device) => attention(device));
  const tasks = currentDevices.filter(taskActive);
  const freshCount = currentDevices.filter(
    (device) => device.run === 'running' && device.fresh === 'current',
  ).length;
  const visible = currentDevices.filter(
    (device) =>
      (filter === 'all' ||
        (filter === 'attention' && attention(device)) ||
        (filter === 'running' && device.run === 'running') ||
        (filter === 'tasks' && taskActive(device))) &&
      (zone === 'all' || device.location === zone) &&
      `${device.name} ${device.id} ${kindNames[device.kind]}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const visibleEntries = empty
    ? []
    : entries.filter(
        (entry) =>
          (recordType === 'all' || entry.type === recordType) &&
          (recordDevice === 'all' || entry.deviceId === recordDevice) &&
          (recordRange === 'today' || now - entry.time <= 15 * 60000),
      );

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);
  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set('view', view);
    history.replaceState(null, '', url);
  }, [view]);
  useEffect(() => {
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (available && !empty) {
        setDevices((previous) => tickDevices(previous, time));
        setLastSync(time);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [available, empty]);
  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
    },
    [],
  );
  useEffect(() => {
    for (const device of devices) {
      const status = device.task?.status;
      if (
        status &&
        status !== previousTasks.current[device.id] &&
        ['completed', 'cancelled'].includes(status)
      ) {
        setEntries((previous) =>
          [
            {
              id: crypto.randomUUID(),
              deviceId: device.id,
              time: Date.now(),
              type: 'task',
              title: status === 'completed' ? '离心任务完成' : '离心任务已取消',
              detail: `${device.task!.id} · 实际转速降至 0 rpm`,
              actor: '设备程序',
              outcome: 'success',
            } satisfies Entry,
            ...previous,
          ].slice(0, 50),
        );
      }
      if (status) previousTasks.current[device.id] = status;
    }
  }, [devices]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  function go(page: string) {
    setView(page);
    setSearch('');
    setFilter('all');
    setZone('all');
  }
  function reset() {
    generation.current += 1;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setDevices(seedDevices());
    setEntries(seedEntries());
    setSelected(null);
    setCommand(null);
    setScenario('normal');
    setLab('research');
    setFilter('all');
    setSearch('');
    setZone('all');
    previousTasks.current = { 'CF-01': 'running', 'CF-02': 'interrupted' };
    setToast('预览场景已重置');
  }
  function operate(
    deviceId: string,
    action: Operation,
    parameters: Record<string, number | boolean> = {},
  ) {
    if (!available || command?.phase === 'accepted') return;
    const id = crypto.randomUUID(),
      token = generation.current,
      time = Date.now();
    setCommand({
      deviceId,
      label: operations[action],
      operation: action,
      phase: 'accepted',
    });
    setEntries((previous) =>
      [
        {
          id,
          deviceId,
          time,
          type: action.includes('task')
            ? 'task'
            : action.includes('program')
              ? 'program'
              : 'command',
          title: operations[action],
          detail: '命令已接受 · 等待设备确认',
          actor: '林研究员',
          outcome: 'pending',
        } satisfies Entry,
        ...previous,
      ].slice(0, 50),
    );
    const fail = scenario === 'failed';
    const timer = setTimeout(() => {
      if (token !== generation.current) return;
      if (fail) {
        setCommand({
          deviceId,
          label: operations[action],
          operation: action,
          phase: 'failed',
        });
        setEntries((previous) =>
          previous.map((entry) =>
            entry.id === id
              ? {
                  ...entry,
                  outcome: 'failed',
                  detail: '设备程序拒绝执行 · 实际观测未变化',
                }
              : entry,
          ),
        );
        return;
      }
      setDevices((previous) =>
        previous.map((device) => {
          if (device.id !== deviceId) return device;
          if (action === 'stop-program')
            return { ...device, run: 'stopped', fresh: 'stale' };
          if (action === 'start-program' || action === 'restart-program')
            return {
              ...device,
              run: 'running',
              fresh: 'current',
              updated: Date.now(),
              value:
                device.kind === 'sensor'
                  ? 23.5
                  : device.kind === 'centrifuge'
                    ? 0
                    : device.on
                      ? (device.brightness ?? 80)
                      : 0,
              temperature:
                device.kind === 'centrifuge' ? 23 : device.temperature,
            };
          if (action === 'light')
            return {
              ...device,
              on: Boolean(parameters.on),
              brightness: Number(parameters.brightness),
              value: parameters.on ? Number(parameters.brightness) : 0,
              updated: Date.now(),
            };
          if (action === 'start-task')
            return {
              ...device,
              updated: Date.now(),
              task: {
                id: `TASK-${Math.floor(Math.random() * 9000) + 2000}`,
                status: 'preparing',
                target: Number(parameters.rpm),
                temperature: Number(parameters.temperature),
                duration: Number(parameters.duration),
                elapsed: 0,
              },
            };
          if (action === 'stop-task' && device.task)
            return {
              ...device,
              task: { ...device.task, status: 'decelerating', cancel: true },
              updated: Date.now(),
            };
          return device;
        }),
      );
      setCommand({
        deviceId,
        label: operations[action],
        operation: action,
        phase: 'succeeded',
      });
      setEntries((previous) =>
        previous.map((entry) =>
          entry.id === id
            ? {
                ...entry,
                outcome: 'success',
                detail:
                  action === 'stop-task'
                    ? '已进入减速阶段 · 等待任务取消结果'
                    : action === 'start-task'
                      ? `准备中 · ${parameters.rpm} rpm · ${parameters.temperature}°C · ${parameters.duration} s`
                      : action === 'stop-program'
                        ? '程序已停止 · 保留最后观测'
                        : '设备已确认执行 · 已收到新观测',
              }
            : entry,
        ),
      );
    }, 1100);
    timers.current.push(timer);
  }
  function exportRecords() {
    const rows = [
      ['时间', '设备', '记录', '详情', '操作者'],
      ...visibleEntries.map((entry) => [
        new Date(entry.time).toISOString(),
        entry.deviceId,
        entry.title,
        entry.detail,
        entry.actor,
      ]),
    ];
    const csv =
      '\uFEFF' +
      rows
        .map((row) =>
          row.map((value) => `"${value.replaceAll('"', '""')}"`).join(','),
        )
        .join('\r\n');
    const url = URL.createObjectURL(
      new Blob([csv], { type: 'text/csv;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'lab-operations-preview-records.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setToast('已导出当前筛选的模拟记录');
  }

  function deviceTable() {
    return (
      <>
        <div className="device-filters">
          <Segments
            value={filter === 'tasks' ? 'tasks' : filter}
            onChange={setFilter}
            label="设备状态筛选"
            items={[
              { value: 'all', label: '全部设备' },
              { value: 'running', label: '运行中' },
              {
                value: 'attention',
                label: (
                  <>
                    待关注 <span className="tab-count">{issues.length}</span>
                  </>
                ),
              },
              ...(filter === 'tasks'
                ? [{ value: 'tasks', label: '任务中' }]
                : []),
            ]}
          />
          <div className="table-search">
            <Search />
            <Input
              aria-label="搜索设备"
              placeholder="搜索设备或编号"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <NativeSelect
            aria-label="筛选区域"
            value={zone}
            onChange={(event) => setZone(event.target.value)}
          >
            <NativeSelectOption value="all">全部区域</NativeSelectOption>
            <NativeSelectOption value="准备区">准备区</NativeSelectOption>
            <NativeSelectOption value="仪器区">仪器区</NativeSelectOption>
          </NativeSelect>
        </div>
        <div className="device-table-wrap">
          <table className="device-table">
            <thead>
              <tr>
                <th>设备</th>
                <th>运行状态</th>
                <th>关键读数</th>
                <th className="zone-column">登记位置</th>
                <th className="update-column">最近更新</th>
                <th aria-label="查看设备" />
              </tr>
            </thead>
            <tbody>
              {visible.map((device) => {
                const metric = reading(device);
                return (
                  <tr key={device.id} onClick={() => setSelected(device.id)}>
                    <td>
                      <div className="table-device">
                        <Thumbnail device={device} />
                        <div>
                          <button
                            className="device-name"
                            onClick={() => setSelected(device.id)}
                            aria-label={`查看${device.name}`}
                          >
                            {device.name}
                          </button>
                          <small>
                            {device.id}
                            <span
                              className={`source-inline ${device.reality === 'physical' ? 'physical' : ''}`}
                            >
                              {device.reality === 'simulated'
                                ? '模拟'
                                : '真实对象'}
                            </span>
                          </small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <DeviceStatus device={device} />
                    </td>
                    <td>
                      <span
                        className={`metric-reading ${device.fresh !== 'current' ? 'old-reading' : ''}`}
                      >
                        {metric.value}
                        <small>{metric.unit}</small>
                      </span>
                      <span className="reading-context">
                        {device.fresh === 'unknown'
                          ? '尚无观测'
                          : device.fresh !== 'current'
                            ? '最后报告值'
                            : device.task && taskActive(device)
                              ? `目标 ${device.task.target.toLocaleString()} rpm`
                              : device.kind === 'light'
                                ? device.on
                                  ? '电源已开'
                                  : '电源已关'
                                : '当前观测'}
                      </span>
                    </td>
                    <td className="zone-column">{device.location}</td>
                    <td className="update-column">
                      <span
                        className={
                          device.run === 'running' && device.fresh === 'stale'
                            ? 'text-warning'
                            : 'muted'
                        }
                      >
                        {age(device.updated, now)}
                      </span>
                    </td>
                    <td>
                      <ChevronRight />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!visible.length ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Search />
              </EmptyMedia>
              <EmptyTitle>没有符合条件的设备</EmptyTitle>
            </EmptyHeader>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSearch('');
                setFilter('all');
                setZone('all');
              }}
            >
              清除筛选
            </Button>
          </Empty>
        ) : null}
        <div className="table-foot">
          <span>
            {visible.length} / {currentDevices.length} 台设备
          </span>
          <span>
            <i className="dot teal" />
            {offline ? '最后快照' : '实时观测'} · 模拟{' '}
            {currentDevices.filter((d) => d.reality === 'simulated').length} /
            真实对象{' '}
            {currentDevices.filter((d) => d.reality === 'physical').length}
          </span>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="preview-toolbar" aria-label="预览场景工具">
        <div>
          <FlaskConical />
          <strong>交互预览</strong>
          <span>v1</span>
          <span className="preview-data-label">模拟数据</span>
        </div>
        <div>
          <NativeSelect
            aria-label="预览场景"
            value={scenario}
            onChange={(event) => {
              setScenario(event.target.value);
              if (['empty', 'denied', 'loading'].includes(event.target.value))
                setSelected(null);
            }}
          >
            <NativeSelectOption value="normal">正常场景</NativeSelectOption>
            <NativeSelectOption value="offline">连接中断</NativeSelectOption>
            <NativeSelectOption value="empty">空实验室</NativeSelectOption>
            <NativeSelectOption value="loading">加载中</NativeSelectOption>
            <NativeSelectOption value="denied">身份失效</NativeSelectOption>
            <NativeSelectOption value="failed">操作失败</NativeSelectOption>
          </NativeSelect>
          <Tool icon={RotateCcw} label="重置预览" onClick={reset} />
        </div>
      </div>
      <div className="app-shell">
        <aside className="app-sidebar">
          <a
            className="brand"
            href="/prototype/lab-operations"
            onClick={(event) => {
              event.preventDefault();
              go('overview');
            }}
          >
            <span>
              <Layers3 />
            </span>
            Lab Word
          </a>
          <div className="sidebar-lab">
            <span className="lab-avatar">
              <FlaskConical />
            </span>
            <div>
              <strong>{lab === 'empty' ? '空实验室' : labName}</strong>
              <small>实验室工作台</small>
            </div>
          </div>
          <span className="nav-label">实验室</span>
          <nav aria-label="实验室导航">
            {pages.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={view === id ? 'active' : ''}
                aria-current={view === id ? 'page' : undefined}
                onClick={() => go(id)}
              >
                <Icon />
                <span>{label}</span>
                {id === 'devices' ? (
                  <small>{currentDevices.length}</small>
                ) : id === 'overview' && issues.length ? (
                  <i className="nav-indicator" />
                ) : null}
              </button>
            ))}
          </nav>
          <div className="sidebar-divider" />
          <button
            className="sidebar-utility"
            onClick={() => setUtility('assets')}
          >
            <LibraryBig />
            <span>资产库</span>
            <ArrowUpRight />
          </button>
          <div className="sidebar-bottom">
            <div className="sidebar-sync">
              <span className={`dot ${offline || denied ? 'amber' : 'teal'}`} />
              <span>
                {offline ? '连接中断' : denied ? '身份已失效' : '世界实时同步'}
              </span>
            </div>
            <button
              className="sidebar-utility"
              onClick={() => setUtility('settings')}
            >
              <Settings2 />
              <span>实验室设置</span>
            </button>
            <div className="sidebar-user">
              <span className="user-avatar">林</span>
              <div>
                <strong>林研究员</strong>
                <small>Member</small>
              </div>
              <Tool
                icon={dark ? Sun : Moon}
                label={dark ? '切换浅色主题' : '切换深色主题'}
                onClick={() => setDark(!dark)}
              />
            </div>
          </div>
        </aside>
        <div className="app-main">
          <header className="shell-header">
            <div className="breadcrumb">
              <span>实验室</span>
              <ChevronRight />
              <strong>{lab === 'empty' ? '空实验室' : labName}</strong>
            </div>
            <div>
              <span className="shell-date">
                {new Date(now).toLocaleDateString('zh-CN', {
                  month: 'long',
                  day: 'numeric',
                  weekday: 'long',
                })}
              </span>
              <Tool
                icon={Bell}
                label="查看待关注设备"
                onClick={() => {
                  go('devices');
                  setFilter('attention');
                }}
              />
              <Tool
                icon={dark ? Sun : Moon}
                label={dark ? '切换浅色主题' : '切换深色主题'}
                onClick={() => setDark(!dark)}
              />
            </div>
          </header>
          <nav className="mobile-navigation" aria-label="移动端视图">
            {pages.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={view === id ? 'active' : ''}
                onClick={() => go(id)}
                aria-current={view === id ? 'page' : undefined}
              >
                <Icon />
                <span>{label}</span>
              </button>
            ))}
          </nav>
          <main className="workspace">
            <div className="page-heading">
              <div>
                <div className="page-eyebrow">
                  <i className="eyebrow-line" />
                  {lab === 'empty' ? '空实验室' : labName}
                </div>
                <h1>{pages.find((page) => page.id === view)?.label}</h1>
              </div>
              <div className="heading-actions">
                <Badge variant={offline || denied ? 'warning' : 'success'}>
                  {offline ? <WifiOff /> : <CloudCheck />}
                  {offline
                    ? '连接中断'
                    : denied
                      ? '身份失效'
                      : loading
                        ? '正在同步'
                        : '实时同步'}
                </Badge>
                <NativeSelect
                  aria-label="切换实验室"
                  value={lab}
                  onChange={(event) => {
                    setLab(event.target.value);
                    setSelected(null);
                  }}
                >
                  <NativeSelectOption value="research">
                    研发实验室
                  </NativeSelectOption>
                  <NativeSelectOption value="empty">
                    空实验室
                  </NativeSelectOption>
                </NativeSelect>
                <Tool
                  icon={RefreshCw}
                  label="刷新世界快照"
                  disabled={offline || denied}
                  onClick={() => {
                    setLastSync(Date.now());
                    if (loading) setScenario('normal');
                    setToast('世界快照已刷新');
                  }}
                />
              </div>
            </div>
            {offline ? (
              <Alert className="connection-alert">
                <WifiOff />
                <AlertTitle>连接中断 · 保留最后世界快照</AlertTitle>
                <AlertDescription>
                  设备读数与任务进度暂未更新。最后同步 {clock(lastSync)}
                </AlertDescription>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setScenario('normal');
                    setLastSync(Date.now());
                    setToast('已恢复同步');
                  }}
                >
                  <RefreshCw data-icon="inline-start" />
                  重新连接
                </Button>
              </Alert>
            ) : null}
            {denied ? (
              <div className="page-state">
                <ShieldX />
                <h2>当前身份已失效</h2>
                <p>无法继续访问实验室数据</p>
                <Button
                  onClick={() => {
                    setScenario('normal');
                    setToast('预览身份已恢复');
                  }}
                >
                  重新登录
                </Button>
              </div>
            ) : loading ? (
              <div className="loading-state" aria-label="实验室加载中">
                <div className="loading-metrics">
                  {[1, 2, 3, 4].map((id) => (
                    <Skeleton key={id} className="h-24" />
                  ))}
                </div>
                {[1, 2, 3, 4, 5].map((id) => (
                  <Skeleton key={id} className="h-16" />
                ))}
              </div>
            ) : empty ? (
              <div className="page-state empty-lab">
                <FlaskConical />
                <h2>实验室里还没有设备</h2>
                <p>0 个对象 · 暂无观测与任务</p>
                <Button
                  onClick={() => {
                    setScenario('normal');
                    setLab('research');
                  }}
                >
                  打开研发实验室
                  <ArrowRight data-icon="inline-end" />
                </Button>
              </div>
            ) : (
              <>
                {view !== 'records' && view !== 'space' ? (
                  <div className="metrics-band">
                    <button
                      onClick={() => {
                        go('devices');
                      }}
                    >
                      <div>
                        <Box />
                        <span>已登记设备</span>
                        <ArrowUpRight />
                      </div>
                      <strong>
                        {currentDevices.length}
                        <small>台</small>
                      </strong>
                      <span>
                        含{' '}
                        {
                          currentDevices.filter((d) => d.run === 'unbound')
                            .length
                        }{' '}
                        台尚未接入
                      </span>
                    </button>
                    <button
                      onClick={() => {
                        go('devices');
                        setFilter('tasks');
                      }}
                    >
                      <div>
                        <Play />
                        <span>进行中任务</span>
                        <ArrowUpRight />
                      </div>
                      <strong>
                        {tasks.length}
                        <small>项</small>
                      </strong>
                      <span>
                        {tasks.length
                          ? tasks.map((device) => device.name).join('、')
                          : '当前无进行中任务'}
                      </span>
                    </button>
                    <button
                      onClick={() => {
                        go('devices');
                        setFilter('running');
                      }}
                    >
                      <div>
                        <Activity />
                        <span>当前有效观测</span>
                        <ArrowUpRight />
                      </div>
                      <strong className="text-teal">
                        {freshCount}
                        <small>台</small>
                      </strong>
                      <span>来自正在运行的状态来源</span>
                    </button>
                    <button
                      onClick={() => {
                        go('devices');
                        setFilter('attention');
                      }}
                    >
                      <div>
                        <CircleAlert />
                        <span>待关注设备</span>
                        <ArrowUpRight />
                      </div>
                      <strong className={issues.length ? 'text-warning' : ''}>
                        {issues.length}
                        <small>台</small>
                      </strong>
                      <span>
                        {issues.length
                          ? '观测过期 / 程序中断'
                          : '当前无待关注情况'}
                      </span>
                    </button>
                  </div>
                ) : null}
                {view === 'overview' ? (
                  <>
                    <div className="overview-primary">
                      <section className="devices-section">
                        <div className="section-title">
                          <h2>设备运行</h2>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => go('devices')}
                          >
                            全部设备
                            <ArrowUpRight data-icon="inline-end" />
                          </Button>
                        </div>
                        {deviceTable()}
                      </section>
                      <aside className="attention-section">
                        <div className="section-title">
                          <h2>需要关注</h2>
                          <span className="count-label">{issues.length}</span>
                        </div>
                        {issues.length ? (
                          <div className="attention-list">
                            {issues.map((device) => {
                              const issue = attention(device)!;
                              return (
                                <button
                                  className={`attention-item ${issue.tone}`}
                                  key={device.id}
                                  onClick={() => setSelected(device.id)}
                                >
                                  <div>
                                    <CircleAlert />
                                    <strong>{issue.title}</strong>
                                    <ChevronRight />
                                  </div>
                                  <p>{device.name}</p>
                                  <small>{issue.detail}</small>
                                  <span>
                                    {age(device.updated, now)} · 模拟来源
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="all-clear">
                            <Check />
                            <strong>当前无待关注情况</strong>
                          </div>
                        )}
                        <div className="attention-note">
                          <div>
                            <span className="dot neutral" />
                            <strong>尚未接入</strong>
                            <span>
                              {
                                currentDevices.filter(
                                  (d) => d.run === 'unbound',
                                ).length
                              }{' '}
                              台
                            </span>
                          </div>
                          <button onClick={() => setSelected('TS-03')}>
                            环境探头 C<ChevronRight />
                          </button>
                        </div>
                        <div className="sync-caption">
                          <CloudCheck />
                          <span>
                            世界快照同步于 {clock(lastSync)}
                            <small>
                              {offline ? '连接中断' : '界面连接正常'}
                            </small>
                          </span>
                        </div>
                      </aside>
                    </div>
                    <div className="overview-secondary">
                      <section className="environment-section">
                        <div className="section-title">
                          <h2>环境温度</h2>
                          <Segments
                            value={hours}
                            onChange={setHours}
                            label="环境趋势时间范围"
                            items={[
                              { value: '1', label: '1 小时' },
                              { value: '6', label: '6 小时' },
                              { value: '24', label: '24 小时' },
                            ]}
                          />
                        </div>
                        <div className="chart-device-heading">
                          <NativeSelect
                            aria-label="趋势传感器"
                            value={sensor}
                            onChange={(event) => setSensor(event.target.value)}
                          >
                            <NativeSelectOption value="TS-01">
                              准备区 · 温度传感器 A
                            </NativeSelectOption>
                            <NativeSelectOption value="TS-02">
                              仪器区 · 温度传感器 B
                            </NativeSelectOption>
                          </NativeSelect>
                          <strong>
                            {
                              reading(devices.find((d) => d.id === sensor)!)
                                .value
                            }
                            <small>°C</small>
                          </strong>
                        </div>
                        <Trend
                          device={devices.find((d) => d.id === sensor)!}
                          hours={Number(hours)}
                          dark={dark}
                        />
                        <div className="chart-foot">
                          <span className="chart-key">
                            <i />
                            模拟观测
                          </span>
                          <button onClick={() => setSelected(sensor)}>
                            设备详情
                            <ArrowUpRight />
                          </button>
                        </div>
                      </section>
                      <section className="task-section">
                        <div className="section-title">
                          <h2>设备任务</h2>
                          <span className="muted">{tasks.length} 项进行中</span>
                        </div>
                        {devices
                          .filter((device) => device.task)
                          .map((device) => (
                            <button
                              key={device.id}
                              className="task-item"
                              onClick={() => setSelected(device.id)}
                            >
                              <div className="task-item-heading">
                                <span className="task-symbol">
                                  <Activity />
                                </span>
                                <div>
                                  <strong>{device.name}</strong>
                                  <small>{device.task!.id}</small>
                                </div>
                                <Badge
                                  variant={
                                    device.task!.status === 'interrupted'
                                      ? 'warning'
                                      : taskActive(device)
                                        ? 'info'
                                        : 'success'
                                  }
                                >
                                  {taskNames[device.task!.status]}
                                </Badge>
                              </div>
                              <div className="task-item-metrics">
                                <span>
                                  {device.task!.target.toLocaleString()} rpm
                                </span>
                                <span>{device.task!.temperature}°C</span>
                                <span>{device.task!.duration} s</span>
                              </div>
                              <div
                                className={`task-progress ${device.task!.status === 'interrupted' ? 'interrupted' : ''}`}
                              >
                                <span
                                  style={{
                                    width: `${(device.task!.elapsed / device.task!.duration) * 100}%`,
                                  }}
                                />
                              </div>
                              <div className="progress-caption">
                                <span>
                                  {device.task!.status === 'interrupted'
                                    ? '有效计时已中断'
                                    : `有效计时 ${device.task!.elapsed} / ${device.task!.duration} s`}
                                </span>
                                <ChevronRight />
                              </div>
                            </button>
                          ))}
                      </section>
                    </div>
                    <section className="recent-section">
                      <div className="section-title">
                        <h2>最近活动</h2>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => go('records')}
                        >
                          运行记录
                          <ArrowUpRight data-icon="inline-end" />
                        </Button>
                      </div>
                      <div className="recent-activity">
                        {entries.slice(0, 3).map((entry) => (
                          <button
                            key={entry.id}
                            onClick={() => setSelected(entry.deviceId)}
                          >
                            <span
                              className={`activity-symbol ${entry.outcome}`}
                            >
                              <History />
                            </span>
                            <div>
                              <strong>{entry.title}</strong>
                              <small>
                                {
                                  devices.find((d) => d.id === entry.deviceId)
                                    ?.name
                                }{' '}
                                · {entry.actor}
                              </small>
                            </div>
                            <time>{clock(entry.time)}</time>
                          </button>
                        ))}
                      </div>
                    </section>
                  </>
                ) : view === 'devices' ? (
                  <section className="devices-section full-device-section">
                    <div className="section-title">
                      <h2>设备目录</h2>
                      <span className="muted">
                        {currentDevices.length} 台 ·{' '}
                        {
                          currentDevices.filter(
                            (d) => d.reality === 'simulated',
                          ).length
                        }{' '}
                        台模拟设备
                      </span>
                    </div>
                    {deviceTable()}
                  </section>
                ) : view === 'space' ? (
                  <Suspense fallback={<Skeleton className="h-96" />}>
                    <Space
                      devices={currentDevices}
                      dark={dark}
                      onSelect={setSelected}
                    />
                  </Suspense>
                ) : (
                  <section className="records-section">
                    <div className="record-controls">
                      <Segments
                        value={recordType}
                        onChange={setRecordType}
                        label="运行记录类别"
                        items={[
                          { value: 'all', label: '全部记录' },
                          { value: 'task', label: '任务' },
                          { value: 'command', label: '命令' },
                          { value: 'program', label: '设备程序' },
                        ]}
                      />
                      <NativeSelect
                        aria-label="记录设备筛选"
                        value={recordDevice}
                        onChange={(event) =>
                          setRecordDevice(event.target.value)
                        }
                      >
                        <NativeSelectOption value="all">
                          全部设备
                        </NativeSelectOption>
                        {devices.map((d) => (
                          <NativeSelectOption key={d.id} value={d.id}>
                            {d.name}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                      <NativeSelect
                        aria-label="记录时间筛选"
                        value={recordRange}
                        onChange={(event) => setRecordRange(event.target.value)}
                      >
                        <NativeSelectOption value="today">
                          今天
                        </NativeSelectOption>
                        <NativeSelectOption value="15min">
                          最近 15 分钟
                        </NativeSelectOption>
                      </NativeSelect>
                      <Tool
                        icon={ArrowDownToLine}
                        label="导出当前记录"
                        disabled={!visibleEntries.length}
                        onClick={exportRecords}
                      />
                    </div>
                    <div className="record-retention">
                      <Clock3 />
                      观测保留 24 小时 · 已结束记录保留 30 天
                      <span>模拟来源</span>
                    </div>
                    <div className="record-table-wrap">
                      <table className="record-table">
                        <thead>
                          <tr>
                            <th>时间</th>
                            <th>记录</th>
                            <th>设备</th>
                            <th>操作者</th>
                            <th>结果</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleEntries.map((entry) => (
                            <tr key={entry.id}>
                              <td>
                                <time>{clock(entry.time)}</time>
                              </td>
                              <td>
                                <strong>{entry.title}</strong>
                                <small>{entry.detail}</small>
                              </td>
                              <td>
                                <button
                                  onClick={() => setSelected(entry.deviceId)}
                                >
                                  {
                                    devices.find((d) => d.id === entry.deviceId)
                                      ?.name
                                  }
                                </button>
                              </td>
                              <td>{entry.actor}</td>
                              <td>
                                <Badge
                                  variant={
                                    entry.outcome === 'warning'
                                      ? 'warning'
                                      : entry.outcome === 'failed'
                                        ? 'destructive'
                                        : entry.outcome === 'pending'
                                          ? 'info'
                                          : 'success'
                                  }
                                >
                                  {entry.outcome === 'warning'
                                    ? '需关注'
                                    : entry.outcome === 'failed'
                                      ? '执行失败'
                                      : entry.outcome === 'pending'
                                        ? '已接受'
                                        : '已记录'}
                                </Badge>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {!visibleEntries.length ? (
                      <Empty>
                        <EmptyHeader>
                          <EmptyTitle>当前范围内暂无记录</EmptyTitle>
                        </EmptyHeader>
                      </Empty>
                    ) : null}
                    <div className="table-foot">
                      <span>{visibleEntries.length} 条记录</span>
                      <span>数据来自独立预览场景</span>
                    </div>
                  </section>
                )}
              </>
            )}
            <footer className="workspace-footer">
              <span>Lab Word</span>
              <span>
                <i className="dot neutral" />
                {empty ? '0' : currentDevices.length} 台设备 ·{' '}
                {lab === 'empty' ? '空实验室' : labName}
              </span>
              <span>最后同步 {clock(lastSync)}</span>
            </footer>
          </main>
        </div>
      </div>
      {selectedDevice ? (
        <Detail
          key={selectedDevice.id}
          device={selectedDevice}
          entries={entries}
          dark={dark}
          offline={!available}
          command={command}
          onOperate={operate}
          onClose={() => setSelected(null)}
          onSpace={() => {
            setSelected(null);
            go('space');
          }}
        />
      ) : null}
      <Dialog
        open={!!utility}
        onOpenChange={(open) => {
          if (!open) setUtility(null);
        }}
      >
        <DialogContent>
          <div className="utility-heading">
            <DialogTitle>
              {utility === 'assets' ? '内置资产' : '实验室设置'}
            </DialogTitle>
            <Tool icon={X} label="关闭" onClick={() => setUtility(null)} />
          </div>
          <DialogDescription>
            {utility === 'assets'
              ? '当前实验室使用的设备定义与模型表示'
              : labName}
          </DialogDescription>
          {utility === 'assets' ? (
            <div className="asset-list">
              {(['centrifuge', 'sensor', 'light'] as const).map((kind) => (
                <div key={kind}>
                  <img src={images[kind]} alt={`${kindNames[kind]}模型`} />
                  <div>
                    <strong>{kindNames[kind]}</strong>
                    <small>定义 1.0 · 内置虚拟程序</small>
                  </div>
                  <Badge variant="outline">模拟</Badge>
                </div>
              ))}
            </div>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setUtility(null);
                setToast('预览中的实验室名称已更新');
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="lab-name">实验室名称</FieldLabel>
                  <Input
                    id="lab-name"
                    value={labName}
                    maxLength={30}
                    required
                    onChange={(event) => setLabName(event.target.value)}
                  />
                </Field>
              </FieldGroup>
              <Button type="submit">保存</Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
      {toast ? (
        <div className="toast" role="status">
          <Check />
          <span>{toast}</span>
          <button aria-label="关闭提示" onClick={() => setToast('')}>
            <X />
          </button>
        </div>
      ) : null}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
