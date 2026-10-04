export type Device = {
  id: string;
  name: string;
  kind: 'centrifuge' | 'sensor' | 'light';
  location: string;
  reality: 'simulated' | 'physical';
  run: 'running' | 'stopped' | 'interrupted' | 'unbound';
  fresh: 'current' | 'stale' | 'unknown';
  updated: number;
  value: number | null;
  temperature?: number;
  on?: boolean;
  brightness?: number;
  task?: {
    status:
      | 'preparing'
      | 'running'
      | 'decelerating'
      | 'completed'
      | 'cancelled'
      | 'interrupted';
    target: number;
    temperature: number;
    duration: number;
    elapsed: number;
    cancel?: boolean;
    id: string;
  };
};

export type Entry = {
  id: string;
  deviceId: string;
  time: number;
  type: 'task' | 'command' | 'program';
  title: string;
  detail: string;
  actor: string;
  outcome: 'success' | 'warning' | 'pending' | 'failed';
};

export const kindNames = {
  centrifuge: '离心机',
  sensor: '温度传感器',
  light: '照明',
};
export const runNames = {
  running: '程序运行中',
  stopped: '程序已停止',
  interrupted: '程序已中断',
  unbound: '尚未接入',
};
export const taskNames = {
  preparing: '准备中',
  running: '计时运行',
  decelerating: '减速中',
  completed: '已完成',
  cancelled: '已取消',
  interrupted: '已中断',
};

export function seedDevices(now = Date.now()): Device[] {
  return [
    {
      id: 'CF-01',
      name: '离心机 A',
      kind: 'centrifuge',
      location: '仪器区',
      reality: 'simulated',
      run: 'running',
      fresh: 'current',
      updated: now,
      value: 6000,
      temperature: 4.2,
      task: {
        id: 'TASK-1042',
        status: 'running',
        target: 6000,
        temperature: 4,
        duration: 90,
        elapsed: 32,
      },
    },
    {
      id: 'CF-02',
      name: '离心机 B',
      kind: 'centrifuge',
      location: '仪器区',
      reality: 'simulated',
      run: 'interrupted',
      fresh: 'stale',
      updated: now - 180000,
      value: 3200,
      temperature: 7.6,
      task: {
        id: 'TASK-1041',
        status: 'interrupted',
        target: 6000,
        temperature: 4,
        duration: 120,
        elapsed: 18,
      },
    },
    {
      id: 'TS-01',
      name: '温度传感器 A',
      kind: 'sensor',
      location: '准备区',
      reality: 'simulated',
      run: 'running',
      fresh: 'current',
      updated: now,
      value: 23.6,
    },
    {
      id: 'TS-02',
      name: '温度传感器 B',
      kind: 'sensor',
      location: '仪器区',
      reality: 'simulated',
      run: 'running',
      fresh: 'stale',
      updated: now - 480000,
      value: 22.8,
    },
    {
      id: 'LT-01',
      name: '工作照明 A',
      kind: 'light',
      location: '准备区',
      reality: 'simulated',
      run: 'running',
      fresh: 'current',
      updated: now,
      value: 80,
      on: true,
      brightness: 80,
    },
    {
      id: 'LT-02',
      name: '工作照明 B',
      kind: 'light',
      location: '仪器区',
      reality: 'simulated',
      run: 'stopped',
      fresh: 'stale',
      updated: now - 720000,
      value: 0,
      on: false,
      brightness: 60,
    },
    {
      id: 'TS-03',
      name: '环境探头 C',
      kind: 'sensor',
      location: '准备区',
      reality: 'physical',
      run: 'unbound',
      fresh: 'unknown',
      updated: 0,
      value: null,
    },
  ];
}

export function seedEntries(now = Date.now()): Entry[] {
  return [
    {
      id: 'EV-2106',
      deviceId: 'CF-01',
      time: now - 42000,
      type: 'task',
      title: '离心任务开始计时',
      detail: '6000 rpm · 4°C · 90 s',
      actor: '林研究员',
      outcome: 'success',
    },
    {
      id: 'EV-2105',
      deviceId: 'CF-02',
      time: now - 180000,
      type: 'task',
      title: '离心任务中断',
      detail: '设备程序中断 · 结果未完成',
      actor: '设备程序',
      outcome: 'warning',
    },
    {
      id: 'EV-2104',
      deviceId: 'LT-01',
      time: now - 360000,
      type: 'command',
      title: '照明亮度已更新',
      detail: '实际亮度 80%',
      actor: 'Agent · Lab Assistant',
      outcome: 'success',
    },
    {
      id: 'EV-2103',
      deviceId: 'TS-02',
      time: now - 480000,
      type: 'program',
      title: '最后一次温度观测',
      detail: '22.8°C · 后续观测已过期',
      actor: '设备程序',
      outcome: 'warning',
    },
    {
      id: 'EV-2102',
      deviceId: 'LT-02',
      time: now - 720000,
      type: 'program',
      title: '照明程序已停止',
      detail: '保留最后观测 · 人工停止',
      actor: '林研究员',
      outcome: 'success',
    },
    {
      id: 'EV-2101',
      deviceId: 'CF-02',
      time: now - 950000,
      type: 'task',
      title: '上一轮离心任务完成',
      detail: '4000 rpm · 8°C · 60 s',
      actor: 'Agent · Lab Assistant',
      outcome: 'success',
    },
  ];
}

export function taskActive(device: Device) {
  return (
    !!device.task &&
    ['preparing', 'running', 'decelerating'].includes(device.task.status)
  );
}

export function attention(device: Device) {
  if (device.run === 'interrupted')
    return {
      title: '任务与程序中断',
      detail: '上一轮任务结果未完成',
      tone: 'danger' as const,
    };
  if (device.fresh === 'stale' && device.run === 'running')
    return {
      title: '观测已过期',
      detail: '程序运行中，读数未持续更新',
      tone: 'warning' as const,
    };
  return null;
}

export function reading(device: Device) {
  if (device.value === null) return { value: '—', unit: '', name: '暂无观测' };
  if (device.kind === 'centrifuge')
    return {
      value: Math.round(device.value).toLocaleString('en-US'),
      unit: 'rpm',
      name: '实际转速',
    };
  if (device.kind === 'sensor')
    return { value: device.value.toFixed(1), unit: '°C', name: '实际温度' };
  return {
    value: device.on ? String(device.brightness) : '0',
    unit: '%',
    name: '实际亮度',
  };
}

export function age(updated: number, now = Date.now()) {
  if (!updated) return '尚无数据';
  const seconds = Math.max(0, Math.floor((now - updated) / 1000));
  return seconds < 3
    ? '刚刚'
    : seconds < 60
      ? `${seconds} 秒前`
      : `${Math.floor(seconds / 60)} 分钟前`;
}

export function clock(time: number) {
  return new Date(time).toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

// Only the preview simulator advances state; it never calls the World API.
export function tickDevices(devices: Device[], now: number): Device[] {
  return devices.map((device) => {
    if (device.run !== 'running' || device.fresh !== 'current') return device;
    if (device.kind === 'sensor')
      return {
        ...device,
        value: Math.round((23.5 + Math.sin(now / 9000) * 0.25) * 10) / 10,
        updated: now,
      };
    if (device.kind !== 'centrifuge' || !taskActive(device))
      return { ...device, updated: now };
    const task = { ...device.task! };
    let value = device.value ?? 0;
    let temperature = device.temperature ?? 23;
    if (task.status === 'preparing') {
      value = Math.min(task.target, value + 1200);
      temperature = Math.max(task.temperature, temperature - 2);
      if (
        value === task.target &&
        Math.abs(temperature - task.temperature) <= 0.5
      )
        task.status = 'running';
    } else if (task.status === 'running') {
      task.elapsed = Math.min(task.duration, task.elapsed + 1);
      if (task.elapsed >= task.duration) task.status = 'decelerating';
    } else if (task.status === 'decelerating') {
      value = Math.max(0, value - 1800);
      if (value === 0) task.status = task.cancel ? 'cancelled' : 'completed';
    }
    return { ...device, task, value, temperature, updated: now };
  });
}
