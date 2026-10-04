// PROTOTYPE: in-memory observations and tasks; no application API is called.
export type Kind = 'centrifuge' | 'sensor' | 'light' | 'robot' | 'labware';
export type Phase =
  | 'idle'
  | 'preparing'
  | 'running'
  | 'decelerating'
  | 'completed'
  | 'cancelled'
  | 'failed';
export type Position = [number, number, number];
export type Device = {
  id: string;
  name: string;
  kind: Kind;
  position: Position;
  location: string;
  rpm: number;
  temperature: number;
  brightness: number;
  on: boolean;
  task?: {
    phase: Phase;
    targetRpm: number;
    targetTemp: number;
    duration: number;
    elapsed: number;
    cancelling: boolean;
    id: string;
  };
};
export type Record = {
  id: number;
  at: number;
  device: string;
  title: string;
  actor: string;
};
export type World = { devices: Device[]; events: Record[]; clock: number };
export const active = (device?: Device) =>
  !!device?.task &&
  ['preparing', 'running', 'decelerating'].includes(device.task.phase);
export const phaseLabels: { [key in Phase]: string } = {
  idle: '空闲',
  preparing: '准备中',
  running: '运行中',
  decelerating: '减速中',
  completed: '已完成',
  cancelled: '已取消',
  failed: '任务异常',
};
export function seed(): World {
  const device = (
    id: string,
    name: string,
    kind: Kind,
    position: Position,
    location: string,
  ): Device => ({
    id,
    name,
    kind,
    position,
    location,
    rpm: 0,
    temperature: 22.4,
    brightness: 78,
    on: true,
  });
  return {
    devices: [
      device(
        'cf-01',
        '冷冻离心机 01',
        'centrifuge',
        [-2.3, 1.03, -1.3],
        '制备台 A',
      ),
      device(
        'cf-02',
        '冷冻离心机 02',
        'centrifuge',
        [-0.6, 1.03, -1.3],
        '制备台 A',
      ),
      device(
        'sensor-01',
        '环境温度传感器',
        'sensor',
        [2.8, 1.03, 1.25],
        '检测台 B',
      ),
      device('light-01', '工作照明', 'light', [0.95, 1.03, 1.2], '检测台 B'),
      device('robot-01', '协作机械臂', 'robot', [-3.1, 0, 1.7], '自动化区'),
      device(
        'labware-01',
        '烧杯 · 250 mL',
        'labware',
        [1.95, 1.03, 1.3],
        '检测台 B',
      ),
    ],
    events: [
      {
        id: 1,
        at: Date.now(),
        device: 'sensor-01',
        title: '温度观测已更新',
        actor: '设备程序',
      },
    ],
    clock: 0,
  };
}
export function record(
  world: World,
  device: string,
  title: string,
  actor = '陈予 · 成员',
): World {
  return {
    ...world,
    events: [
      {
        id: (world.events[0]?.id ?? 0) + 1,
        at: Date.now(),
        device,
        title,
        actor,
      },
      ...world.events,
    ].slice(0, 40),
  };
}
export function tick(world: World, dt: number): World {
  const completed: { device: string; title: string }[] = [];
  const clock = world.clock + dt;
  const devices = world.devices.map((source) => {
    const device = { ...source };
    if (device.kind === 'sensor')
      device.temperature = 22.4 + Math.sin(clock / 28) * 0.35;
    if (!device.task || !active(device)) return device;
    device.task = { ...device.task };
    const task = device.task;
    if (task.phase === 'preparing') {
      device.rpm = Math.min(task.targetRpm, device.rpm + dt * 1000);
      const difference = task.targetTemp - device.temperature;
      device.temperature +=
        Math.sign(difference) * Math.min(Math.abs(difference), dt * 2.5);
      if (
        device.rpm === task.targetRpm &&
        Math.abs(device.temperature - task.targetTemp) < 0.05
      )
        task.phase = 'running';
    } else if (task.phase === 'running') {
      task.elapsed = Math.min(task.duration, task.elapsed + dt);
      if (task.elapsed >= task.duration) task.phase = 'decelerating';
    } else if (task.phase === 'decelerating') {
      device.rpm = Math.max(0, device.rpm - dt * 1500);
      if (device.rpm === 0) {
        task.phase = task.cancelling ? 'cancelled' : 'completed';
        completed.push({
          device: device.id,
          title: task.cancelling
            ? '任务已取消，设备已停止'
            : '离心任务完成，设备已空闲',
        });
      }
    }
    return device;
  });
  let next = { ...world, devices, clock };
  completed.forEach(({ device, title }) => {
    next = record(next, device, title, '设备程序');
  });
  return next;
}
export function start(
  world: World,
  id: string,
  rpm: number,
  temperature: number,
  duration: number,
): World {
  const device = world.devices.find((item) => item.id === id);
  if (!device || active(device)) return world;
  const next = {
    ...world,
    devices: world.devices.map((item) =>
      item.id === id
        ? {
            ...item,
            task: {
              phase: 'preparing' as const,
              targetRpm: rpm,
              targetTemp: temperature,
              duration,
              elapsed: 0,
              cancelling: false,
              id: `task-${Date.now()}`,
            },
          }
        : item,
    ),
  };
  return record(next, id, '启动命令已接收，设备准备中');
}
export function stop(world: World, id: string): World {
  if (!active(world.devices.find((item) => item.id === id))) return world;
  return record(
    {
      ...world,
      devices: world.devices.map((item) =>
        item.id === id && item.task
          ? {
              ...item,
              task: { ...item.task, phase: 'decelerating', cancelling: true },
            }
          : item,
      ),
    },
    id,
    '停止命令已接收，设备减速中',
  );
}
