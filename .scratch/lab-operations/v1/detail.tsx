import { useState } from 'react';
import {
  ArrowUpRight,
  CircleAlert,
  MapPin,
  Play,
  RefreshCw,
  Square,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@labos-threejs/ui/components/dialog';
import { Button } from '@labos-threejs/ui/components/button';
import { Badge } from '@labos-threejs/ui/components/badge';
import {
  Alert,
  AlertTitle,
  AlertDescription,
} from '@labos-threejs/ui/components/alert';
import { Input } from '@labos-threejs/ui/components/input';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@labos-threejs/ui/components/field';
import { Switch } from '@labos-threejs/ui/components/switch';
import Trend from './chart';
import { DeviceStatus, Segments, Thumbnail, Tool } from './ui';
import {
  age,
  attention,
  clock,
  kindNames,
  reading,
  runNames,
  taskActive,
  taskNames,
} from './model';
import type { Device, Entry } from './model';

export type Operation =
  | 'start-program'
  | 'stop-program'
  | 'restart-program'
  | 'light'
  | 'start-task'
  | 'stop-task';
export type CommandState = {
  deviceId: string;
  label: string;
  operation: Operation;
  phase: 'accepted' | 'succeeded' | 'failed';
} | null;

export default function Detail({
  device,
  entries,
  dark,
  offline,
  command,
  onClose,
  onOperate,
  onSpace,
}: {
  device: Device;
  entries: Entry[];
  dark: boolean;
  offline: boolean;
  command: CommandState;
  onClose: () => void;
  onOperate: (
    deviceId: string,
    action: Operation,
    parameters?: Record<string, number | boolean>,
  ) => void;
  onSpace: () => void;
}) {
  const [tab, setTab] = useState('state');
  const [hours, setHours] = useState('1');
  const [brightness, setBrightness] = useState(device.brightness ?? 80);
  const [rpm, setRpm] = useState(6000);
  const [temperature, setTemperature] = useState(4);
  const [duration, setDuration] = useState(20);
  const [confirm, setConfirm] = useState(false);
  const metric = reading(device),
    issue = attention(device);
  const pending = command?.phase === 'accepted';
  const disabled = offline || pending;
  const localEntries = entries.filter((entry) => entry.deviceId === device.id);

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent className="device-dialog">
          <div className="detail-top">
            <span>设备详情</span>
            <Tool icon={X} label="关闭设备详情" onClick={onClose} />
          </div>
          <div className="detail-identity">
            <Thumbnail device={device} large />
            <div>
              <small className="device-code">
                {device.id} · {kindNames[device.kind]}
              </small>
              <DialogTitle>{device.name}</DialogTitle>
              <DialogDescription>
                <MapPin />
                {device.location}
              </DialogDescription>
            </div>
          </div>
          <div className="detail-tags">
            <DeviceStatus device={device} />
            <Badge variant="outline">
              {device.reality === 'simulated' ? '模拟来源' : '真实对象'}
            </Badge>
            <Button variant="ghost" size="sm" onClick={onSpace}>
              <MapPin data-icon="inline-start" />
              空间位置
              <ArrowUpRight data-icon="inline-end" />
            </Button>
          </div>
          <Segments
            value={tab}
            onChange={setTab}
            label="设备详情视图"
            items={[
              { value: 'state', label: '当前状态' },
              { value: 'history', label: '运行记录' },
              { value: 'info', label: '对象信息' },
            ]}
          />
          {offline ? (
            <Alert>
              <CircleAlert />
              <AlertTitle>连接中断</AlertTitle>
              <AlertDescription>保留最后快照 · 当前操作不可用</AlertDescription>
            </Alert>
          ) : null}
          {tab === 'state' ? (
            <>
              {issue ? (
                <Alert
                  variant={issue.tone === 'danger' ? 'destructive' : 'default'}
                >
                  <CircleAlert />
                  <AlertTitle>{issue.title}</AlertTitle>
                  <AlertDescription>
                    {issue.detail} · 最后观测 {age(device.updated)}
                  </AlertDescription>
                </Alert>
              ) : null}
              <div className="detail-readings">
                <div>
                  <small>
                    {device.fresh === 'current'
                      ? metric.name
                      : device.fresh === 'unknown'
                        ? '暂无观测'
                        : '最后报告值'}
                  </small>
                  <strong>
                    {metric.value}
                    <span>{metric.unit}</span>
                  </strong>
                  <small
                    className={
                      device.fresh === 'current'
                        ? 'text-success'
                        : 'text-warning'
                    }
                  >
                    {device.fresh === 'current'
                      ? '当前观测'
                      : device.fresh === 'unknown'
                        ? '尚无状态来源'
                        : '历史值 · 已过期'}
                  </small>
                </div>
                {device.kind === 'centrifuge' ? (
                  <div>
                    <small>实际温度</small>
                    <strong>
                      {device.temperature?.toFixed(1) ?? '—'}
                      <span>°C</span>
                    </strong>
                    <small>
                      目标 {device.task?.temperature ?? temperature}°C
                    </small>
                  </div>
                ) : (
                  <div>
                    <small>最后更新时间</small>
                    <strong className="time-reading">
                      {device.updated ? clock(device.updated).slice(0, 5) : '—'}
                    </strong>
                    <small>{age(device.updated)}</small>
                  </div>
                )}
              </div>
              {device.kind !== 'light' && device.value !== null ? (
                <section className="detail-section">
                  <div className="section-title">
                    <h3>
                      {device.kind === 'sensor' ? '温度趋势' : '转速趋势'}
                    </h3>
                    <Segments
                      value={hours}
                      onChange={setHours}
                      label="设备趋势时间范围"
                      items={[
                        { value: '1', label: '1 小时' },
                        { value: '6', label: '6 小时' },
                        { value: '24', label: '24 小时' },
                      ]}
                    />
                  </div>
                  <Trend device={device} hours={Number(hours)} dark={dark} />
                  <div className="chart-foot">
                    <span className="chart-key">
                      <i />
                      模拟观测
                    </span>
                    <span>{device.kind === 'sensor' ? '°C' : 'rpm'}</span>
                  </div>
                </section>
              ) : null}
              {device.task ? (
                <section className="detail-section">
                  <div className="section-title">
                    <h3>{taskActive(device) ? '当前任务' : '最近任务'}</h3>
                    <Badge
                      variant={
                        device.task.status === 'interrupted'
                          ? 'warning'
                          : 'secondary'
                      }
                    >
                      {taskNames[device.task.status]}
                    </Badge>
                  </div>
                  <div className="task-parameters">
                    <span>
                      目标{' '}
                      <strong>{device.task.target.toLocaleString()} rpm</strong>
                    </span>
                    <span>
                      温度 <strong>{device.task.temperature}°C</strong>
                    </span>
                    <span>
                      时长 <strong>{device.task.duration} s</strong>
                    </span>
                  </div>
                  <div className="task-progress">
                    <span
                      style={{
                        width: `${(device.task.elapsed / device.task.duration) * 100}%`,
                      }}
                    />
                  </div>
                  <div className="progress-caption">
                    <span>
                      有效计时 {device.task.elapsed} / {device.task.duration} s
                    </span>
                    <span>
                      {device.task.status === 'completed'
                        ? '结果：已完成'
                        : device.task.status === 'interrupted'
                          ? '结果：中断'
                          : device.task.status === 'cancelled'
                            ? '结果：已取消'
                            : taskNames[device.task.status]}
                    </span>
                  </div>
                  <small className="record-id">{device.task.id}</small>
                </section>
              ) : null}
              {device.run !== 'unbound' ? (
                <section className="detail-section">
                  <div className="section-title">
                    <h3>设备程序</h3>
                    <span className="muted">{runNames[device.run]}</span>
                  </div>
                  <div className="program-actions">
                    {device.run === 'running' ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={disabled || taskActive(device)}
                          onClick={() => onOperate(device.id, 'stop-program')}
                        >
                          <Square data-icon="inline-start" />
                          停止程序
                        </Button>
                        {device.fresh === 'stale' ? (
                          <Button
                            size="sm"
                            disabled={disabled}
                            onClick={() =>
                              onOperate(device.id, 'restart-program')
                            }
                          >
                            <RefreshCw data-icon="inline-start" />
                            重新启动程序
                          </Button>
                        ) : null}
                      </>
                    ) : (
                      <Button
                        size="sm"
                        disabled={disabled}
                        onClick={() => onOperate(device.id, 'start-program')}
                      >
                        <Play data-icon="inline-start" />
                        启动新程序
                      </Button>
                    )}
                  </div>
                </section>
              ) : (
                <Alert>
                  <AlertTitle>尚未接入状态来源</AlertTitle>
                  <AlertDescription>
                    已登记真实对象 · 暂无观测与可执行操作
                  </AlertDescription>
                </Alert>
              )}
              {device.kind === 'light' && device.run === 'running' ? (
                <section className="detail-section">
                  <div className="section-title">
                    <h3>照明控制</h3>
                  </div>
                  <FieldGroup>
                    <Field orientation="horizontal">
                      <FieldLabel htmlFor="light-power">电源</FieldLabel>
                      <Switch
                        id="light-power"
                        checked={!!device.on}
                        disabled={disabled}
                        onCheckedChange={(checked) =>
                          onOperate(device.id, 'light', {
                            on: checked,
                            brightness: device.brightness ?? 80,
                          })
                        }
                      />
                    </Field>
                    <Field>
                      <div className="range-heading">
                        <FieldLabel htmlFor="brightness">目标亮度</FieldLabel>
                        <output>{brightness}%</output>
                      </div>
                      <input
                        id="brightness"
                        type="range"
                        min="0"
                        max="100"
                        value={brightness}
                        disabled={disabled}
                        onChange={(event) =>
                          setBrightness(Number(event.target.value))
                        }
                      />
                    </Field>
                  </FieldGroup>
                  <Button
                    size="sm"
                    disabled={disabled}
                    onClick={() =>
                      onOperate(device.id, 'light', {
                        on: !!device.on,
                        brightness,
                      })
                    }
                  >
                    应用亮度
                  </Button>
                </section>
              ) : null}
              {device.kind === 'centrifuge' && device.run === 'running' ? (
                <section className="detail-section">
                  <div className="section-title">
                    <h3>{taskActive(device) ? '任务操作' : '新离心任务'}</h3>
                  </div>
                  {taskActive(device) ? (
                    <Button
                      variant="outline"
                      disabled={
                        disabled || device.task?.status === 'decelerating'
                      }
                      onClick={() => setConfirm(true)}
                    >
                      <Square data-icon="inline-start" />
                      停止任务
                    </Button>
                  ) : (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        onOperate(device.id, 'start-task', {
                          rpm,
                          temperature,
                          duration,
                        });
                      }}
                    >
                      <FieldGroup className="task-form">
                        <Field>
                          <FieldLabel htmlFor="target-rpm">
                            转速 (rpm)
                          </FieldLabel>
                          <Input
                            id="target-rpm"
                            type="number"
                            min={500}
                            max={15000}
                            step={1}
                            value={rpm}
                            onChange={(event) =>
                              setRpm(Number(event.target.value))
                            }
                            required
                            disabled={disabled}
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="target-temperature">
                            温度 (°C)
                          </FieldLabel>
                          <Input
                            id="target-temperature"
                            type="number"
                            min={-10}
                            max={40}
                            step={0.1}
                            value={temperature}
                            onChange={(event) =>
                              setTemperature(Number(event.target.value))
                            }
                            required
                            disabled={disabled}
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="target-duration">
                            时长 (s)
                          </FieldLabel>
                          <Input
                            id="target-duration"
                            type="number"
                            min={6}
                            max={3600}
                            step={1}
                            value={duration}
                            onChange={(event) =>
                              setDuration(Number(event.target.value))
                            }
                            required
                            disabled={disabled}
                          />
                        </Field>
                      </FieldGroup>
                      <Button type="submit" disabled={disabled}>
                        <Play data-icon="inline-start" />
                        启动任务
                      </Button>
                    </form>
                  )}
                </section>
              ) : null}
              {command?.deviceId === device.id ? (
                <Alert
                  variant={
                    command.phase === 'failed' ? 'destructive' : 'default'
                  }
                >
                  <AlertTitle>
                    {command.phase === 'accepted'
                      ? '命令已接受 · 等待设备确认'
                      : command.phase === 'succeeded'
                        ? command.operation === 'stop-program'
                          ? '程序已停止 · 保留最后观测'
                          : '执行成功 · 已收到新观测'
                        : '命令执行失败'}
                  </AlertTitle>
                  <AlertDescription>
                    {command.label}
                    {command.phase === 'failed'
                      ? ' · 设备未确认执行，观测保持原值'
                      : ''}
                  </AlertDescription>
                </Alert>
              ) : null}
            </>
          ) : tab === 'history' ? (
            <section className="detail-section">
              <h3>最近运行记录</h3>
              <ol className="detail-history">
                {localEntries.map((entry) => (
                  <li key={entry.id}>
                    <i
                      className={`dot ${entry.outcome === 'warning' ? 'amber' : entry.outcome === 'failed' ? 'red' : 'teal'}`}
                    />
                    <div>
                      <strong>{entry.title}</strong>
                      <p>{entry.detail}</p>
                      <small>
                        {clock(entry.time)} · {entry.actor}
                      </small>
                    </div>
                  </li>
                ))}
              </ol>
              {!localEntries.length ? (
                <p className="muted">暂无运行记录</p>
              ) : null}
            </section>
          ) : (
            <section className="detail-section">
              <dl className="information-list">
                <dt>对象编号</dt>
                <dd>{device.id}</dd>
                <dt>对象类别</dt>
                <dd>{kindNames[device.kind]}</dd>
                <dt>身份来源</dt>
                <dd>
                  {device.reality === 'simulated' ? '模拟对象' : '真实对象'}
                </dd>
                <dt>登记位置</dt>
                <dd>{device.location} · 人工登记</dd>
                <dt>定义版本</dt>
                <dd>{device.kind}.v1 · 1.0</dd>
                <dt>状态来源</dt>
                <dd>
                  {device.reality === 'simulated'
                    ? '内置虚拟设备程序'
                    : '未绑定'}
                </dd>
                <dt>最后观测</dt>
                <dd>
                  {device.updated
                    ? new Date(device.updated).toLocaleString('zh-CN')
                    : '尚无数据'}
                </dd>
                <dt>数据质量</dt>
                <dd>
                  {device.fresh === 'unknown' ? '未知' : '来源报告：良好'}
                </dd>
                <dt>观测时效</dt>
                <dd>
                  {device.fresh === 'current'
                    ? '当前'
                    : device.fresh === 'stale'
                      ? '已过期'
                      : '未知'}
                </dd>
              </dl>
            </section>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogTitle>停止当前离心任务？</DialogTitle>
          <DialogDescription className="confirmation-copy">
            {device.name}将进入减速阶段。转速降至零后，任务结果记为“已取消”。
          </DialogDescription>
          <div className="confirmation-actions">
            <Button variant="outline" onClick={() => setConfirm(false)}>
              继续运行
            </Button>
            <Button
              disabled={disabled}
              onClick={() => {
                setConfirm(false);
                onOperate(device.id, 'stop-task');
              }}
            >
              <Square data-icon="inline-start" />
              停止任务
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
