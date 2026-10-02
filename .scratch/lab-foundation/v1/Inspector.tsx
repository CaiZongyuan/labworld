import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  Archive,
  ArrowUpRight,
  Clock3,
  Copy,
  FileBox,
  MapPin,
  Move3D,
  Play,
  Power,
  RotateCcw,
  Square,
  Trash2,
  Unplug,
  X,
} from 'lucide-react';
import { Button } from '@labos-threejs/ui/components/button';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Input } from '@labos-threejs/ui/components/input';
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from '@labos-threejs/ui/components/field';
import {
  NativeSelect,
  NativeSelectOption,
} from '@labos-threejs/ui/components/native-select';
import { Switch } from '@labos-threejs/ui/components/switch';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@labos-threejs/ui/components/tabs';
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
  EmptyDescription,
} from '@labos-threejs/ui/components/empty';
import {
  archive,
  command,
  patchEntity,
  program,
  registerLocation,
  removeNode,
  running,
  useWorld,
  type Entity,
} from './world';
import {
  duration,
  EntityIcon,
  Property,
  Status,
  time,
  Tool,
  type Translate,
} from './ui';

function Sparkline({
  value,
  t,
  label,
  maximum,
}: {
  value: number;
  t: Translate;
  label: string;
  maximum: number;
}) {
  const points = useRef<number[]>(Array.from({ length: 36 }, () => value));
  useEffect(() => {
    points.current = [...points.current.slice(1), value];
  }, [value]);
  const coords = points.current
    .map(
      (n, i) => `${i * 8},${55 - Math.max(0, Math.min(1, n / maximum)) * 42}`,
    )
    .join(' ');
  return (
    <div className="spark-chart">
      <div>
        <span>{label}</span>
        <span>{t('最近 30 次观测', 'Last 30 observations')}</span>
      </div>
      <svg viewBox="0 0 280 66" preserveAspectRatio="none" aria-label={label}>
        <path
          d="M0 12H280M0 34H280M0 55H280"
          stroke="var(--border)"
          strokeWidth=".8"
        />
        <polygon
          points={`0,60 ${coords} 280,60`}
          fill="var(--info)"
          opacity=".055"
        />
        <polyline
          points={coords}
          fill="none"
          stroke="var(--info)"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
      <div>
        <span>−30</span>
        <span>{t('现在', 'Now')}</span>
      </div>
    </div>
  );
}
export default function Inspector({
  entity: e,
  locale,
  t,
  onClose,
  onFocus,
  onMode,
  onConfirm,
  notify,
}: {
  entity?: Entity;
  locale: string;
  t: Translate;
  onClose: () => void;
  onFocus: () => void;
  onMode: () => void;
  onConfirm: (title: string, text: string, action: () => void) => void;
  notify: (message: string, error?: boolean) => void;
}) {
  const d = useWorld((s) => (e ? s.devices[e.id] : undefined));
  const entities = useWorld((s) => s.layout.entities);
  const assets = useWorld((s) => s.assets);
  const meta = useWorld((s) => s.meta);
  const allEvents = useWorld((s) => s.events);
  const tasks = useWorld((s) => s.tasks);
  const [tab, setTab] = useState('overview');
  const [parameters, setParameters] = useState({
    rpm: '12000',
    temperature: '4',
    minutes: '10',
  });
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [location, setLocation] = useState('lab');
  useEffect(() => {
    setTab('overview');
    setError('');
    setLocation(e?.location ?? 'lab');
    setParameters({ rpm: '12000', temperature: '4', minutes: '10' });
  }, [e?.id]);
  useEffect(() => {
    setLocation(e?.location ?? 'lab');
  }, [e?.location]);
  if (!e)
    return (
      <aside className="inspector">
        <div className="panel-heading">
          <span>{t('实体详情', 'Entity inspector')}</span>
          <FileBox />
        </div>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Move3D />
            </EmptyMedia>
            <EmptyTitle>
              {t('选择实验室中的对象', 'Select an object')}
            </EmptyTitle>
            <EmptyDescription>
              {t(
                '点击三维场景或对象目录，查看身份、状态和可用操作。',
                'Select an object in the scene or directory to inspect its identity, state and actions.',
              )}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </aside>
    );
  const asset = assets.find((a) => a.id === e.assetId);
  const active = !!d && running(d.phase);
  const simulated = ['centrifuge', 'light', 'sensor'].includes(e.kind);
  const latestTask = tasks.find((task) => task.entityId === e.id);
  const canAct = meta.connection && meta.authenticated && !e.archived;
  const act = async (action: 'start' | 'stop' | 'light', input?: any) => {
    setError('');
    setPending(action);
    try {
      await command(
        e.id,
        action,
        input ?? {
          rpm: Number(parameters.rpm),
          temperature: Number(parameters.temperature),
          minutes: Number(parameters.minutes),
        },
      );
    } catch (reason) {
      setError(String((reason as Error).message));
    } finally {
      setPending('');
    }
  };
  const handle = (fn: () => void) => {
    try {
      fn();
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
    }
  };
  const records = allEvents.filter((event) => event.entityId === e.id);
  const name = locale === 'zh' ? e.name : e.en;
  const statusName = latestTask?.state;
  const translatedTask = (status: string) =>
    ({
      completed: t('已完成', 'Completed'),
      cancelled: t('已取消', 'Cancelled'),
      interrupted: t('已中断', 'Interrupted'),
      failed: t('失败', 'Failed'),
      preparing: t('准备中', 'Preparing'),
      running: t('运行中', 'Running'),
      decelerating: t('减速中', 'Decelerating'),
    })[status];
  return (
    <aside className="inspector" aria-label={t('实体详情', 'Entity inspector')}>
      <div className="panel-heading">
        <span>{t('实体详情', 'Entity inspector')}</span>
        <Tool
          icon={X}
          label={t('关闭详情', 'Close inspector')}
          onClick={onClose}
        />
      </div>
      <div className="entity-heading">
        <EntityIcon kind={e.kind} large />
        <div>
          <h2>{name}</h2>
          <button
            className="copy-id"
            onClick={() => {
              navigator.clipboard
                ?.writeText(e.id)
                .then(() => notify(t('已复制对象 ID', 'Entity ID copied')));
            }}
          >
            {e.id}
            <Copy />
          </button>
        </div>
        <Tool
          icon={ArrowUpRight}
          label={t('聚焦此对象', 'Focus object')}
          onClick={onFocus}
        />
      </div>
      <div className="entity-badges">
        <Badge variant="outline">
          {simulated
            ? t('虚拟设备', 'Virtual device')
            : e.kind === 'robot'
              ? t('能力描述', 'Descriptive')
              : t('静态对象', 'Static object')}
        </Badge>
        <Status
          observation={d}
          kind={e.kind}
          archived={e.archived}
          online={meta.connection && meta.authenticated}
          t={t}
        />
      </div>
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as string)}
        className="inspector-tabs"
      >
        <TabsList variant="line" className="w-full">
          <TabsTrigger value="overview">{t('概览', 'Overview')}</TabsTrigger>
          <TabsTrigger value="properties">
            {t('属性', 'Properties')}
          </TabsTrigger>
          <TabsTrigger value="records">{t('记录', 'Records')}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="inspector-scroll">
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>{t('操作未完成', 'Action not completed')}</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {simulated &&
          (!d?.program || ['interrupted', 'failed'].includes(d.phase)) ? (
            <section className="inspector-section recovery-section">
              <Unplug />
              <strong>
                {t('设备程序需要启动', 'Start the device program')}
              </strong>
              <p>
                {t(
                  '最后观测已保留，当前值不代表设备仍在线。',
                  'Last observations are retained and may be stale.',
                )}
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={!canAct}
                onClick={() => handle(() => program(e.id, true))}
              >
                <RotateCcw data-icon="inline-start" />
                {t('启动设备程序', 'Start program')}
              </Button>
            </section>
          ) : null}
          {e.kind === 'centrifuge' && d ? (
            <>
              <section className="inspector-section">
                <div className="section-heading">
                  <h3>{t('设备观测', 'Observations')}</h3>
                  <span
                    className={
                      meta.connection ? 'live-caption' : 'stale-caption'
                    }
                  >
                    <i />
                    {meta.connection && d.program
                      ? t('实时', 'Live')
                      : t('最后观测', 'Last observed')}
                  </span>
                </div>
                <div className="readings">
                  <div>
                    <span>{t('转速', 'Speed')}</span>
                    <strong>
                      {Math.round(d.rpm).toLocaleString()}
                      <small>rpm</small>
                    </strong>
                  </div>
                  <div>
                    <span>{t('温度', 'Temperature')}</span>
                    <strong>
                      {d.temperature.toFixed(1)}
                      <small>°C</small>
                    </strong>
                  </div>
                </div>
                <Sparkline
                  value={d.rpm}
                  maximum={15000}
                  label={t('转速趋势', 'Speed trend')}
                  t={t}
                />
                <div className="freshness">
                  <Clock3 />
                  <span>
                    {t('虚拟来源', 'Simulated')} · {time(d.observedAt, locale)}
                  </span>
                </div>
              </section>
              <section className="inspector-section">
                <div className="section-heading">
                  <h3>
                    {active
                      ? t('当前任务', 'Active task')
                      : t('离心任务', 'Centrifuge run')}
                  </h3>
                  <Badge variant="outline">centrifuge.run</Badge>
                </div>
                {active ? (
                  <div className="active-run">
                    <div>
                      <span>
                        {d.phase === 'preparing'
                          ? t('达标后开始计时', 'Timer starts at target')
                          : t('剩余时间', 'Time remaining')}
                      </span>
                      <strong>{duration(d.remaining)}</strong>
                    </div>
                    <div className="run-progress">
                      <i
                        style={{
                          width: `${latestTask ? Math.max(3, 100 - (d.remaining / latestTask.duration) * 100) : 3}%`,
                        }}
                      />
                    </div>
                    <small>
                      {latestTask?.id} · {latestTask?.actor} ·{' '}
                      {latestTask?.rpm.toLocaleString()} rpm /{' '}
                      {latestTask?.temperature} °C
                    </small>
                  </div>
                ) : latestTask &&
                  ['completed', 'cancelled', 'interrupted', 'failed'].includes(
                    latestTask.state,
                  ) ? (
                  <div className="last-result">
                    <Badge
                      variant={
                        latestTask.state === 'completed'
                          ? 'success'
                          : 'secondary'
                      }
                    >
                      {translatedTask(latestTask.state)}
                    </Badge>
                    <span>{latestTask.id}</span>
                    <span>
                      {t('设备', 'Device')}{' '}
                      {d.phase === 'idle' ? 'idle' : d.phase}
                    </span>
                  </div>
                ) : (
                  <p className="section-note">
                    {t(
                      '设置目标参数，由设备程序逐步达到目标。',
                      'Set target values. The device approaches them gradually.',
                    )}
                  </p>
                )}
                <FieldGroup className="parameter-fields">
                  <Field>
                    <FieldLabel htmlFor="target-rpm">
                      {t('转速', 'Speed')}
                      <span>rpm</span>
                    </FieldLabel>
                    <Input
                      id="target-rpm"
                      type="number"
                      min="500"
                      max="15000"
                      step="500"
                      value={parameters.rpm}
                      disabled={active}
                      onChange={(event) =>
                        setParameters({
                          ...parameters,
                          rpm: event.target.value,
                        })
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="target-temp">
                      {t('温度', 'Temp')}
                      <span>°C</span>
                    </FieldLabel>
                    <Input
                      id="target-temp"
                      type="number"
                      min="-10"
                      max="40"
                      value={parameters.temperature}
                      disabled={active}
                      onChange={(event) =>
                        setParameters({
                          ...parameters,
                          temperature: event.target.value,
                        })
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="target-time">
                      {t('时长', 'Time')}
                      <span>min</span>
                    </FieldLabel>
                    <Input
                      id="target-time"
                      type="number"
                      min=".1"
                      max="60"
                      step=".1"
                      value={parameters.minutes}
                      disabled={active}
                      onChange={(event) =>
                        setParameters({
                          ...parameters,
                          minutes: event.target.value,
                        })
                      }
                    />
                  </Field>
                </FieldGroup>
                <div className="run-buttons">
                  <Button
                    disabled={!canAct || active || !d.program || !!pending}
                    onClick={() => void act('start')}
                  >
                    <Play data-icon="inline-start" />
                    {pending === 'start'
                      ? t('提交中…', 'Submitting…')
                      : t('开始任务', 'Start run')}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={
                      !canAct ||
                      !active ||
                      d.phase === 'decelerating' ||
                      !!pending
                    }
                    onClick={() => void act('stop')}
                  >
                    <Square data-icon="inline-start" />
                    {t('停止', 'Stop')}
                  </Button>
                </div>
                <p className="subtle-note">
                  {t(
                    '转速与温度达标后计时，加减速不计入时长。',
                    'The timer excludes preparation and deceleration.',
                  )}
                </p>
              </section>
            </>
          ) : null}
          {e.kind === 'light' && d ? (
            <section className="inspector-section">
              <div className="section-heading">
                <h3>{t('照明控制', 'Lighting controls')}</h3>
                <Badge variant="outline">light</Badge>
              </div>
              <div className="light-control">
                <span>
                  <strong>{t('电源', 'Power')}</strong>
                  <small>
                    {t(
                      '由设备观测确认开关状态',
                      'Confirmed by device observation',
                    )}
                  </small>
                </span>
                <Switch
                  aria-label={t('照明电源', 'Light power')}
                  checked={d.on}
                  disabled={!canAct || !d.program || !!pending}
                  onCheckedChange={(on) => void act('light', { on })}
                />
              </div>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="brightness">
                    {t('亮度', 'Brightness')}
                    <span>{d.brightness}%</span>
                  </FieldLabel>
                  <input
                    id="brightness"
                    type="range"
                    min="5"
                    max="100"
                    step="5"
                    value={d.brightness}
                    disabled={!d.on || !canAct || !d.program}
                    onChange={(event) =>
                      void act('light', {
                        brightness: Number(event.target.value),
                      })
                    }
                  />
                </Field>
              </FieldGroup>
              <div className="freshness">
                <Clock3 />
                {t('虚拟来源', 'Simulated')} · {time(d.observedAt, locale)}
              </div>
            </section>
          ) : null}
          {e.kind === 'sensor' && d ? (
            <section className="inspector-section">
              <div className="section-heading">
                <h3>{t('环境温度', 'Ambient temperature')}</h3>
                <Badge variant="outline">
                  {t('只读属性', 'Read-only property')}
                </Badge>
              </div>
              <div className="sensor-reading">
                {d.temperature.toFixed(1)}
                <span>°C</span>
              </div>
              <Sparkline
                value={d.temperature}
                maximum={30}
                label={t('连续采样 · 1 Hz', 'Continuous sampling · 1 Hz')}
                t={t}
              />
              <div className="freshness">
                <Clock3 />
                {t('虚拟来源', 'Simulated')} · {time(d.observedAt, locale)}
              </div>
            </section>
          ) : null}
          {e.kind === 'robot' ? (
            <section className="inspector-section">
              <div className="section-heading">
                <h3>{t('已声明能力', 'Declared capabilities')}</h3>
                <Badge variant="secondary">
                  {t('未实现', 'Not implemented')}
                </Badge>
              </div>
              {['robot.move', 'robot.pick', 'robot.place'].map((cap) => (
                <div className="capability-row" key={cap}>
                  <code>{cap}</code>
                  <span>{t('不可执行', 'Unavailable')}</span>
                </div>
              ))}
              <p className="section-note">
                {t(
                  '这个对象用于验证机器人描述。尚未连接执行程序，不报告虚构的在线状态。',
                  'This object demonstrates robot descriptions. No execution program is connected.',
                )}
              </p>
            </section>
          ) : null}
          {!simulated && e.kind !== 'robot' ? (
            <section className="inspector-section">
              <div className="section-heading">
                <h3>{t('对象信息', 'Object details')}</h3>
              </div>
              <p className="section-note">
                {t(
                  '静态对象拥有独立身份与位置关系，无需运行设备程序。',
                  'Static objects have their own identity and location without a device program.',
                )}
              </p>
              {e.kind === 'bench' ? (
                <div className="contained-objects">
                  {entities
                    .filter((entity) => entity.location === e.id)
                    .map((entity) => (
                      <div key={entity.id}>
                        <EntityIcon kind={entity.kind} />
                        <span>{locale === 'zh' ? entity.name : entity.en}</span>
                        <Badge variant="outline">
                          {t('人工登记', 'Manual')}
                        </Badge>
                      </div>
                    ))}
                </div>
              ) : null}
            </section>
          ) : null}
          <section className="inspector-section">
            <div className="section-heading">
              <h3>{t('登记位置', 'Registered location')}</h3>
              <MapPin />
            </div>
            <div className="location-summary">
              <span>
                {e.location === 'lab'
                  ? t('实验室地面', 'Laboratory floor')
                  : ((locale === 'zh'
                      ? entities.find((n) => n.id === e.location)?.name
                      : entities.find((n) => n.id === e.location)?.en) ??
                    e.location)}
              </span>
              <Badge variant="outline">{t('人工登记', 'Manual')}</Badge>
            </div>
            <p className="subtle-note">
              {t(
                '拖动三维对象不会改变登记关系。',
                'Moving the representation does not change this relationship.',
              )}
            </p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setTab('properties')}
            >
              {t('编辑位置与属性', 'Edit location and properties')}
              <ArrowUpRight data-icon="inline-end" />
            </Button>
          </section>
        </TabsContent>
        <TabsContent value="properties" className="inspector-scroll">
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>{t('操作未完成', 'Action not completed')}</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <section className="inspector-section">
            <h3>{t('身份与资产', 'Identity and asset')}</h3>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="entity-name">
                  {t('名称', 'Name')}
                </FieldLabel>
                <Input
                  id="entity-name"
                  value={e.name}
                  disabled={!canAct}
                  onChange={(event) =>
                    handle(() =>
                      patchEntity(e.id, {
                        name: event.target.value,
                        en: event.target.value,
                      }),
                    )
                  }
                />
              </Field>
            </FieldGroup>
            <dl>
              <Property label="Entity ID">
                <code>{e.id}</code>
              </Property>
              <Property label={t('资产定义', 'Asset definition')}>
                {locale === 'zh' ? asset?.name : asset?.en}
              </Property>
              <Property label={t('定义版本', 'Definition version')}>
                v{asset?.version}
              </Property>
              <Property label="Binding">
                {simulated ? 'Simulator' : '—'}
              </Property>
            </dl>
          </section>
          <section className="inspector-section">
            <div className="section-heading">
              <h3>{t('登记位置', 'Registered location')}</h3>
              <Badge variant="outline">{t('人工登记', 'Manual')}</Badge>
            </div>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="registered-location">
                  {t('所在位置', 'Located in')}
                </FieldLabel>
                <NativeSelect
                  id="registered-location"
                  value={location}
                  onChange={(event) => setLocation(event.target.value)}
                  className="w-full"
                  disabled={!canAct}
                >
                  <NativeSelectOption value="lab">
                    {t('实验室地面', 'Laboratory floor')}
                  </NativeSelectOption>
                  {entities
                    .filter(
                      (n) => n.kind === 'bench' && n.id !== e.id && !n.archived,
                    )
                    .map((n) => (
                      <NativeSelectOption value={n.id} key={n.id}>
                        {locale === 'zh' ? n.name : n.en}
                      </NativeSelectOption>
                    ))}
                </NativeSelect>
                <FieldDescription>
                  {t(
                    '明确登记关系，三维摆放单独调整。',
                    'Register the relationship; adjust the visual placement separately.',
                  )}
                </FieldDescription>
              </Field>
            </FieldGroup>
            <Button
              size="sm"
              variant="outline"
              disabled={!canAct || location === e.location}
              onClick={() =>
                handle(() => {
                  registerLocation(e.id, location);
                  notify(t('登记位置已更新', 'Registered location updated'));
                })
              }
            >
              {t('更新登记位置', 'Update registered location')}
            </Button>
          </section>
          <section className="inspector-section">
            <div className="section-heading">
              <h3>{t('三维摆放', 'Placement')}</h3>
              <Badge variant="outline">m</Badge>
            </div>
            <FieldGroup className="parameter-fields">
              {['X', 'Y', 'Z'].map((axis, i) => (
                <Field key={axis}>
                  <FieldLabel htmlFor={`position-${axis}`}>{axis}</FieldLabel>
                  <Input
                    id={`position-${axis}`}
                    type="number"
                    step=".1"
                    value={e.position[i]}
                    disabled={!canAct}
                    onChange={(event) =>
                      handle(() => {
                        const position = [...e.position] as [
                          number,
                          number,
                          number,
                        ];
                        position[i] = Number(event.target.value);
                        patchEntity(e.id, { position });
                      })
                    }
                  />
                </Field>
              ))}
            </FieldGroup>
            <Button size="sm" variant="ghost" onClick={onMode}>
              <Move3D data-icon="inline-start" />
              {t('在场景中拖动', 'Move in scene')}
            </Button>
          </section>
          {simulated ? (
            <section className="inspector-section">
              <div className="section-heading">
                <h3>{t('设备程序', 'Device program')}</h3>
                <Badge variant={d?.program ? 'success' : 'secondary'}>
                  {d?.program ? t('运行中', 'Running') : t('已停止', 'Stopped')}
                </Badge>
              </div>
              <p className="section-note">
                {active
                  ? t(
                      '先停止当前任务，再停止程序或归档设备。',
                      'Stop the active task before stopping the program or archiving.',
                    )
                  : t(
                      '程序运行独立于场景中的可视表示。',
                      'The program runs independently of its scene representation.',
                    )}
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={!canAct || active}
                onClick={() => handle(() => program(e.id, !d?.program))}
              >
                <Power data-icon="inline-start" />
                {d?.program
                  ? t('停止设备程序', 'Stop program')
                  : t('启动设备程序', 'Start program')}
              </Button>
            </section>
          ) : null}
          <section className="inspector-section lifecycle-actions">
            <h3>{t('对象生命周期', 'Object lifecycle')}</h3>
            {e.visible ? (
              <Button
                variant="outline"
                size="sm"
                disabled={!canAct}
                onClick={() =>
                  onConfirm(
                    t('移出场景', 'Remove from scene'),
                    t(
                      '只移除三维表示，设备身份、程序和记录继续保留。',
                      'Only the visual representation is removed. Identity, program and records remain.',
                    ),
                    () => {
                      removeNode(e.id);
                      notify(
                        t(
                          '已移出场景，设备仍在目录中',
                          'Removed from scene; entity remains in the directory',
                        ),
                      );
                    },
                  )
                }
              >
                <Trash2 data-icon="inline-start" />
                {t('移出场景', 'Remove from scene')}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={!canAct}
                onClick={() =>
                  handle(() => patchEntity(e.id, { visible: true }))
                }
              >
                <FileBox data-icon="inline-start" />
                {t('放回场景', 'Place in scene')}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={!canAct || !!d?.program || active}
              onClick={() =>
                onConfirm(
                  t('归档对象', 'Archive entity'),
                  t(
                    '归档后不再接受新动作，身份与保留期内的记录可查。',
                    'Archived objects accept no new actions. Identity and retained records remain available.',
                  ),
                  () => {
                    archive(e.id);
                    notify(t('对象已归档', 'Entity archived'));
                  },
                )
              }
            >
              <Archive data-icon="inline-start" />
              {t('归档对象', 'Archive entity')}
            </Button>
          </section>
        </TabsContent>
        <TabsContent value="records" className="inspector-scroll">
          <section className="inspector-section">
            <div className="section-heading">
              <h3>{t('最近任务', 'Recent tasks')}</h3>
              <Badge variant="outline">30 d</Badge>
            </div>
            {tasks.filter((task) => task.entityId === e.id).length ? (
              tasks
                .filter((task) => task.entityId === e.id)
                .map((task) => (
                  <div className="task-entry" key={task.id}>
                    <div>
                      <code>{task.id}</code>
                      <Badge
                        variant={
                          task.state === 'completed' ? 'success' : 'secondary'
                        }
                      >
                        {translatedTask(task.state)}
                      </Badge>
                    </div>
                    <p>
                      {task.rpm.toLocaleString()} rpm · {task.temperature} °C ·{' '}
                      {task.duration / 60} min
                    </p>
                    <small>
                      {time(task.startedAt, locale)} · {task.actor}
                    </small>
                  </div>
                ))
            ) : (
              <p className="section-note">
                {t('还没有任务记录。', 'No tasks yet.')}
              </p>
            )}
          </section>
          <section className="inspector-section">
            <div className="section-heading">
              <h3>{t('事件记录', 'Event history')}</h3>
            </div>
            {records.length ? (
              records.map((record) => (
                <div className="inspector-event" key={record.id}>
                  <i className={record.tone} />
                  <div>
                    <p>{locale === 'zh' ? record.title : record.en}</p>
                    <small>
                      {time(record.at, locale)} · {record.actor}
                    </small>
                  </div>
                </div>
              ))
            ) : (
              <p className="section-note">
                {t('对象事件会显示在这里。', 'Object events will appear here.')}
              </p>
            )}
            <p className="subtle-note">
              {t(
                '原始观测保留 24 小时；已结束任务与事件保留 30 天。',
                'Raw observations: 24 hours. Completed tasks and events: 30 days.',
              )}
            </p>
          </section>
        </TabsContent>
      </Tabs>
    </aside>
  );
}
