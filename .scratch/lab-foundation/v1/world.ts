// PROTOTYPE: browser-owned virtual world. No application API or physical device is connected.
import { useSyncExternalStore } from 'react';
import { Box3, Vector3, type Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export type Kind =
  | 'centrifuge'
  | 'light'
  | 'sensor'
  | 'robot'
  | 'bench'
  | 'labware'
  | 'environment'
  | 'model';
export type Phase =
  'idle' | 'preparing' | 'running' | 'decelerating' | 'interrupted' | 'failed';
export type Asset = {
  id: string;
  kind: Kind;
  name: string;
  en: string;
  category: string;
  categoryEn: string;
  description: string;
  descriptionEn: string;
  version: string;
  size?: number;
  fileName?: string;
  scene?: Object3D;
  bounds?: number[];
  buffer?: ArrayBuffer;
};
export type Entity = {
  id: string;
  kind: Kind;
  assetId: string;
  name: string;
  en: string;
  position: [number, number, number];
  rotation: number;
  location: string;
  visible: boolean;
  archived: boolean;
};
export type Observation = {
  phase: Phase;
  rpm: number;
  temperature: number;
  on: boolean;
  brightness: number;
  observedAt: number;
  program: boolean;
  taskId?: string;
  remaining: number;
  targetRpm: number;
  targetTemp: number;
};
export type Task = {
  id: string;
  entityId: string;
  actor: string;
  state:
    | 'preparing'
    | 'running'
    | 'decelerating'
    | 'completed'
    | 'cancelled'
    | 'interrupted'
    | 'failed';
  rpm: number;
  temperature: number;
  duration: number;
  remaining: number;
  startedAt: number;
  endedAt?: number;
  cancelling?: boolean;
};
export type Event = {
  id: number;
  at: number;
  entityId: string;
  title: string;
  en: string;
  actor: string;
  tone: string;
};
type Layout = {
  name: string;
  entities: Entity[];
  dirty: boolean;
  revision: number;
  savedAt?: number;
};
type Meta = {
  connection: boolean;
  authenticated: boolean;
  loading: boolean;
  saving: boolean;
  conflict: boolean;
  speed: number;
  ready: boolean;
};
type World = {
  layout: Layout;
  assets: Asset[];
  devices: Record<string, Observation>;
  tasks: Task[];
  events: Event[];
  meta: Meta;
};
const listeners = new Set<() => void>();
const now = () => Date.now();
export const running = (phase: Phase) =>
  ['preparing', 'running', 'decelerating'].includes(phase);
const seededAssets: Asset[] = [
  {
    id: 'centrifuge',
    kind: 'centrifuge',
    name: '冷冻离心机',
    en: 'Refrigerated centrifuge',
    category: '仪器',
    categoryEn: 'Instrument',
    description: '温控渐变 · 持续任务 · 转子反馈',
    descriptionEn: 'Temperature control · Timed runs · Rotor feedback',
    version: '1.0',
  },
  {
    id: 'light',
    kind: 'light',
    name: '智能照明',
    en: 'Smart light',
    category: 'IoT',
    categoryEn: 'IoT',
    description: '即时开关 · 亮度调节',
    descriptionEn: 'Instant control · Dimmable light',
    version: '1.0',
  },
  {
    id: 'sensor',
    kind: 'sensor',
    name: '环境温度传感器',
    en: 'Temperature sensor',
    category: '传感器',
    categoryEn: 'Sensor',
    description: '连续采样 · 温度 · 数据新鲜度',
    descriptionEn: 'Continuous readings · Temperature · Freshness',
    version: '1.0',
  },
  {
    id: 'robot',
    kind: 'robot',
    name: '协作机械臂',
    en: 'Collaborative robot',
    category: '机器人',
    categoryEn: 'Robot',
    description: '能力描述 · 静态表示',
    descriptionEn: 'Declared capabilities · Static representation',
    version: '1.0',
  },
  {
    id: 'labware',
    kind: 'labware',
    name: '玻璃烧杯 · 250 mL',
    en: 'Glass beaker · 250 mL',
    category: '器皿',
    categoryEn: 'Labware',
    description: '独立身份 · 人工登记位置',
    descriptionEn: 'Independent identity · Registered location',
    version: '1.0',
  },
  {
    id: 'bench',
    kind: 'bench',
    name: '模块化实验台',
    en: 'Modular lab bench',
    category: '基础设施',
    categoryEn: 'Infrastructure',
    description: '工作面 · 对象容纳关系',
    descriptionEn: 'Work surface · Object relationships',
    version: '1.0',
  },
  {
    id: 'environment',
    kind: 'environment',
    name: '开放实验室',
    en: 'Open laboratory',
    category: '环境',
    categoryEn: 'Environment',
    description: '9 × 6 m · 基础实验空间',
    descriptionEn: '9 × 6 m · Laboratory environment',
    version: '1.0',
  },
];
const seedEntities = (): Entity[] => [
  {
    id: 'bench-01',
    kind: 'bench',
    assetId: 'bench',
    name: '实验台 A',
    en: 'Bench A',
    position: [-1.45, 0, -1.0],
    rotation: 0,
    location: 'lab',
    visible: true,
    archived: false,
  },
  {
    id: 'bench-02',
    kind: 'bench',
    assetId: 'bench',
    name: '实验台 B',
    en: 'Bench B',
    position: [2.1, 0, 1.2],
    rotation: 0,
    location: 'lab',
    visible: true,
    archived: false,
  },
  {
    id: 'centrifuge-01',
    kind: 'centrifuge',
    assetId: 'centrifuge',
    name: '离心机 01',
    en: 'Centrifuge 01',
    position: [-2.4, 0.96, -1.0],
    rotation: 0,
    location: 'bench-01',
    visible: true,
    archived: false,
  },
  {
    id: 'centrifuge-02',
    kind: 'centrifuge',
    assetId: 'centrifuge',
    name: '离心机 02',
    en: 'Centrifuge 02',
    position: [-0.85, 0.96, -1.0],
    rotation: 0,
    location: 'bench-01',
    visible: true,
    archived: false,
  },
  {
    id: 'sensor-01',
    kind: 'sensor',
    assetId: 'sensor',
    name: '温度传感器 01',
    en: 'Temperature sensor 01',
    position: [0.22, 0.96, -1.0],
    rotation: 0,
    location: 'bench-01',
    visible: true,
    archived: false,
  },
  {
    id: 'light-01',
    kind: 'light',
    assetId: 'light',
    name: '照明 01',
    en: 'Light 01',
    position: [-3.8, 0, 1.7],
    rotation: 0,
    location: 'lab',
    visible: true,
    archived: false,
  },
  {
    id: 'robot-01',
    kind: 'robot',
    assetId: 'robot',
    name: '机械臂 01',
    en: 'Robot 01',
    position: [1.6, 0.96, 1.2],
    rotation: 0,
    location: 'bench-02',
    visible: true,
    archived: false,
  },
  {
    id: 'labware-01',
    kind: 'labware',
    assetId: 'labware',
    name: '烧杯 01',
    en: 'Beaker 01',
    position: [3.03, 0.96, 1.3],
    rotation: 0,
    location: 'bench-02',
    visible: true,
    archived: false,
  },
];
const device = (e: Entity): Observation => ({
  phase: 'idle',
  rpm: 0,
  temperature: e.kind === 'sensor' ? 22.4 : 22,
  on: true,
  brightness: 80,
  observedAt: now(),
  program: ['light', 'sensor', 'centrifuge'].includes(e.kind),
  remaining: 0,
  targetRpm: 12000,
  targetTemp: 4,
});
function initial(): World {
  const entities = seedEntities();
  return {
    layout: { name: '数字实验室 01', entities, dirty: false, revision: 1 },
    assets: [...seededAssets],
    devices: Object.fromEntries(entities.map((e) => [e.id, device(e)])),
    tasks: [],
    events: [
      {
        id: 1,
        at: now(),
        entityId: 'lab',
        title: '实验室已打开，4 个虚拟设备程序正在运行',
        en: 'Laboratory opened · 4 virtual device programs running',
        actor: 'System',
        tone: 'neutral',
      },
    ],
    meta: {
      connection: true,
      authenticated: true,
      loading: false,
      saving: false,
      conflict: false,
      speed: 30,
      ready: false,
    },
  };
}
let state = initial();
let engine = structuredClone(state.devices);
let disconnectedView: Pick<World, 'tasks' | 'events'> | null = null;
let nextId = 1;
let saved: any = null;
const emit = () => listeners.forEach((fn) => fn());
function publish(next: Partial<World>) {
  state = { ...state, ...next };
  emit();
}
export function useWorld<T>(select: (s: World) => T): T {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => select(snapshot()),
  );
}
export const snapshot = (): World =>
  disconnectedView && (!state.meta.connection || !state.meta.authenticated)
    ? { ...state, ...disconnectedView }
    : state;
export const model = (id: string) => state.devices[id];
function event(
  entityId: string,
  title: string,
  en: string,
  actor = 'System',
  tone = 'neutral',
) {
  state = {
    ...state,
    events: [
      { id: ++nextId, at: now(), entityId, title, en, actor, tone },
      ...state.events,
    ].slice(0, 100),
  };
}
function editable() {
  if (!state.meta.authenticated)
    throw new Error('身份已失效，请先恢复身份 / Session expired');
  if (!state.meta.connection)
    throw new Error('连接已中断，请恢复连接后操作 / Connection unavailable');
}
function layout(entities: Entity[]) {
  publish({ layout: { ...state.layout, entities, dirty: true } });
}
export function patchEntity(id: string, changes: Partial<Entity>) {
  editable();
  layout(
    state.layout.entities.map((e) => (e.id === id ? { ...e, ...changes } : e)),
  );
}
export function registerLocation(id: string, location: string, actor = 'User') {
  editable();
  patchEntity(id, { location });
  event(
    id,
    '更新了登记位置 · 人工登记',
    'Registered location updated · Manual',
    actor,
  );
  emit();
}
export function addEntity(
  assetId: string,
  name?: string,
  actor = 'User',
): string {
  editable();
  const asset = state.assets.find((a) => a.id === assetId)!;
  if (!asset) throw new Error('资产不存在 / Asset unavailable');
  const n =
    state.layout.entities.filter((e) => e.kind === asset.kind).length + 1;
  const id = `${asset.kind}-${String(n).padStart(2, '0')}-${++nextId}`;
  const e: Entity = {
    id,
    kind: asset.kind,
    assetId,
    name: name || `${asset.name} ${String(n).padStart(2, '0')}`,
    en: `${asset.en} ${String(n).padStart(2, '0')}`,
    position: [0, 0, 2],
    rotation: 0,
    location: 'lab',
    visible: true,
    archived: false,
  };
  engine[id] = device(e);
  state = { ...state, devices: { ...state.devices, [id]: { ...engine[id] } } };
  event(
    id,
    '对象已注册并加入场景',
    'Entity registered and placed',
    actor,
    'success',
  );
  layout([...state.layout.entities, e]);
  return id;
}
export function duplicate(id: string) {
  const original = state.layout.entities.find((e) => e.id === id)!;
  const newId = addEntity(original.assetId);
  patchEntity(newId, {
    position: [
      original.position[0] + 0.8,
      original.position[1],
      original.position[2] + 0.65,
    ],
    location: original.location,
  });
  return newId;
}
export function removeNode(id: string) {
  patchEntity(id, { visible: false });
  event(
    id,
    '已移出场景，设备身份与程序保留',
    'Scene representation removed; entity preserved',
    'User',
  );
  emit();
}
export function archive(id: string) {
  editable();
  const d = engine[id];
  if (d?.program || running(d?.phase))
    throw new Error(
      '请先结束任务并停止设备程序 / Stop the task and device program first',
    );
  patchEntity(id, { archived: true, visible: false });
  event(
    id,
    '对象已归档，身份和记录保留',
    'Entity archived; identity and records retained',
    'User',
  );
  emit();
}
export function renameLab(name: string) {
  editable();
  publish({ layout: { ...state.layout, name, dirty: true } });
}
export function createLab(name: string) {
  editable();
  engine = {};
  publish({
    layout: { name, entities: [], dirty: true, revision: 1 },
    devices: {},
    tasks: [],
    events: [],
  });
}
export function program(id: string, start: boolean, actor = 'User') {
  editable();
  if (!engine[id]) return;
  if (!start && running(engine[id].phase))
    throw new Error('请先停止当前任务 / Stop the active task first');
  engine[id] = {
    ...engine[id],
    program: start,
    phase: 'idle',
    rpm: 0,
    remaining: 0,
    observedAt: start ? now() : engine[id].observedAt,
  };
  event(
    id,
    start ? '设备程序已启动' : '设备程序已停止',
    start ? 'Device program started' : 'Device program stopped',
    actor,
  );
  publish({ devices: { ...state.devices, [id]: { ...engine[id] } } });
}
export async function command(
  id: string,
  action: 'start' | 'stop' | 'light',
  parameters: any = {},
  actor = 'User',
) {
  editable();
  const e = state.layout.entities.find((e) => e.id === id);
  if (!e || e.archived)
    throw new Error('对象不存在或已归档 / Entity unavailable or archived');
  if ((action === 'start' || action === 'stop') && e.kind !== 'centrifuge')
    throw new Error(
      '该对象未实现离心任务能力 / This entity does not implement centrifuge actions',
    );
  if (action === 'light' && e.kind !== 'light')
    throw new Error(
      '该对象未实现照明能力 / This entity does not implement light actions',
    );
  const d = engine[id];
  if (!d?.program)
    throw new Error('请先启动设备程序 / Start the device program first');
  if (action === 'start') {
    if (running(d.phase))
      throw new Error('设备忙碌，当前任务尚未结束 / Device is busy');
    if (!(
      parameters.rpm >= 500 &&
      parameters.rpm <= 15000 &&
      parameters.temperature >= -10 &&
      parameters.temperature <= 40 &&
      parameters.minutes > 0 &&
      parameters.minutes <= 60
    ))
      throw new Error(
        '转速 500–15000 rpm，温度 −10–40 °C，时长 0–60 分钟 / Parameters out of range',
      );
    const taskId = `run-${String(++nextId).padStart(3, '0')}`;
    const task: Task = {
      id: taskId,
      entityId: id,
      actor,
      state: 'preparing',
      rpm: parameters.rpm,
      temperature: parameters.temperature,
      duration: parameters.minutes * 60,
      remaining: parameters.minutes * 60,
      startedAt: now(),
    };
    engine[id] = {
      ...d,
      phase: 'preparing',
      taskId,
      targetRpm: task.rpm,
      targetTemp: task.temperature,
      remaining: task.duration,
    };
    state = { ...state, tasks: [task, ...state.tasks] };
    event(
      id,
      `启动命令已接受 · ${taskId}`,
      `Start accepted · ${taskId}`,
      actor,
      'success',
    );
  } else if (action === 'stop') {
    if (!running(d.phase))
      throw new Error('当前没有运行中的任务 / No active task');
    engine[id] = { ...d, phase: 'decelerating' };
    state = {
      ...state,
      tasks: state.tasks.map((t) =>
        t.id === d.taskId
          ? { ...t, state: 'decelerating', cancelling: true }
          : t,
      ),
    };
    event(
      id,
      '停止命令已接受，正在减速',
      'Stop accepted · Decelerating',
      actor,
      'warning',
    );
  } else {
    const next = {
      ...d,
      on: parameters.on ?? d.on,
      brightness: parameters.brightness ?? d.brightness,
    };
    engine[id] = next;
    event(
      id,
      next.on ? `照明已开启 · ${next.brightness}%` : '照明已关闭',
      next.on ? `Light on · ${next.brightness}%` : 'Light off',
      actor,
      'success',
    );
  }
  emit();
  await new Promise((resolve) => setTimeout(resolve, 350));
  if (state.meta.connection && state.meta.authenticated && engine[id])
    publish({
      devices: { ...state.devices, [id]: { ...engine[id], observedAt: now() } },
    });
  return {
    command_id: `cmd-${nextId}`,
    entity_id: id,
    action,
    accepted: true,
    actor,
    task_id: engine[id]?.taskId ?? null,
  };
}
function tick() {
  const step = state.meta.speed;
  let tasks = state.tasks;
  for (const e of state.layout.entities) {
    const current = engine[e.id];
    if (!current?.program || e.archived) continue;
    const d = { ...current, observedAt: now() };
    if (e.kind === 'sensor')
      d.temperature = 22.4 + Math.sin(Date.now() / 19000) * 0.22;
    if (e.kind === 'centrifuge' && d.phase === 'preparing') {
      d.rpm = Math.min(d.targetRpm, d.rpm + 180 * step);
      const difference = d.targetTemp - d.temperature;
      d.temperature +=
        Math.sign(difference) * Math.min(Math.abs(difference), step * 0.14);
      if (
        d.rpm === d.targetRpm &&
        Math.abs(d.temperature - d.targetTemp) < 0.2
      ) {
        d.phase = 'running';
        tasks = tasks.map((t) =>
          t.id === d.taskId ? { ...t, state: 'running' } : t,
        );
        event(
          e.id,
          '转速与温度达标，开始计时',
          'Targets reached · Timer started',
          'Device',
          'success',
        );
      }
    } else if (e.kind === 'centrifuge' && d.phase === 'running') {
      d.remaining = Math.max(0, d.remaining - step);
      if (d.remaining === 0) {
        d.phase = 'decelerating';
        event(
          e.id,
          '计时结束，正在减速',
          'Timer complete · Decelerating',
          'Device',
        );
      }
      tasks = tasks.map((t) =>
        t.id === d.taskId
          ? { ...t, remaining: d.remaining, state: d.phase as Task['state'] }
          : t,
      );
    } else if (e.kind === 'centrifuge' && d.phase === 'decelerating') {
      d.rpm = Math.max(0, d.rpm - 230 * step);
      if (d.rpm === 0) {
        const task = tasks.find((t) => t.id === d.taskId);
        const outcome = task?.cancelling ? 'cancelled' : 'completed';
        tasks = tasks.map((t) =>
          t.id === d.taskId ? { ...t, state: outcome, endedAt: now() } : t,
        );
        event(
          e.id,
          outcome === 'cancelled'
            ? '任务已取消，设备回到空闲'
            : '任务已完成，设备回到空闲',
          outcome === 'cancelled'
            ? 'Task cancelled · Device idle'
            : 'Task completed · Device idle',
          'Device',
          outcome === 'completed' ? 'success' : 'warning',
        );
        d.phase = 'idle';
        d.taskId = undefined;
      }
    }
    engine[e.id] = d;
  }
  state = { ...state, tasks };
  if (state.meta.connection && state.meta.authenticated)
    state = {
      ...state,
      devices: Object.fromEntries(
        Object.entries(engine).map(([id, d]) => [id, { ...d }]),
      ),
    };
  emit();
}
const timer = setInterval(tick, 1000);
if (import.meta.hot) import.meta.hot.dispose(() => clearInterval(timer));
export function setSpeed(speed: number) {
  publish({ meta: { ...state.meta, speed } });
}
export function scenario(name: string) {
  const meta = {
    ...state.meta,
    connection: name !== 'offline',
    authenticated: name !== 'expired',
    loading: name === 'loading',
    conflict: name === 'conflict',
  };
  if ((!meta.connection || !meta.authenticated) && !disconnectedView)
    disconnectedView = { events: state.events, tasks: state.tasks };
  if (meta.connection && meta.authenticated) disconnectedView = null;
  if (name === 'empty') {
    createLab('新实验室');
  }
  if (name === 'restart' || name === 'failure') {
    for (const [id, d] of Object.entries(engine))
      engine[id] = {
        ...d,
        program: false,
        phase: name === 'failure' ? 'failed' : 'interrupted',
        rpm: 0,
      };
    state = {
      ...state,
      tasks: state.tasks.map((t) =>
        ['completed', 'cancelled', 'failed', 'interrupted'].includes(t.state)
          ? t
          : {
              ...t,
              state: name === 'failure' ? 'failed' : 'interrupted',
              endedAt: now(),
            },
      ),
      devices: { ...engine },
    };
    event(
      'lab',
      name === 'failure'
        ? '虚拟程序发生异常，记录已保留'
        : '运行端已重启，请显式启动设备程序',
      name === 'failure'
        ? 'Virtual runtime failed · Records retained'
        : 'Runtime restarted · Restart programs explicitly',
      'System',
      'warning',
    );
  }
  if (name === 'normal')
    event(
      'lab',
      '连接已恢复，世界快照已同步',
      'Connection restored · World snapshot synchronized',
      'System',
      'success',
    );
  publish({ meta, devices: meta.connection ? { ...engine } : state.devices });
}
const db = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('PROTOTYPE-lab-foundation-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('world');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
async function persistence(write?: any) {
  const database = await db();
  try {
    return await new Promise<any>((resolve, reject) => {
      const transaction = database.transaction(
        'world',
        write ? 'readwrite' : 'readonly',
      );
      const store = transaction.objectStore('world');
      const request = write ? store.put(write, 'saved') : store.get('saved');
      let value: any;
      request.onsuccess = () => {
        value = request.result;
      };
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}
export async function save(retry = false) {
  editable();
  publish({ meta: { ...state.meta, saving: true } });
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (state.meta.conflict && !retry) {
    publish({ meta: { ...state.meta, saving: false } });
    throw new Error(
      '另一位参与者已保存新版本，当前草稿已保留 / Another version was saved; your draft is preserved',
    );
  }
  const nextLayout = {
    ...state.layout,
    revision: state.layout.revision + 1,
    dirty: false,
    savedAt: now(),
  };
  const data = {
    layout: nextLayout,
    assets: state.assets.map(({ scene, ...asset }) => asset),
  };
  try {
    await persistence(data);
    saved = data;
    event(
      'lab',
      `布局已保存 · v${nextLayout.revision}`,
      `Layout saved · v${nextLayout.revision}`,
      'User',
      'success',
    );
    publish({
      layout: nextLayout,
      meta: { ...state.meta, saving: false, conflict: false },
    });
  } catch {
    publish({ meta: { ...state.meta, saving: false } });
    throw new Error(
      '当前浏览器无法保存，草稿仍保留 / Browser storage unavailable; draft preserved',
    );
  }
}
async function parseModel(buffer: ArrayBuffer) {
  if (
    buffer.byteLength < 20 ||
    new DataView(buffer).getUint32(0, true) !== 0x46546c67
  )
    throw new Error('请选择有效的 GLB 模型 / Choose a valid GLB model');
  const view = new DataView(buffer);
  const jsonSize = view.getUint32(12, true);
  const json = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 20, jsonSize)),
  );
  if (
    [...(json.buffers ?? []), ...(json.images ?? [])].some(
      (item) => item.uri && !item.uri.startsWith('data:'),
    )
  )
    throw new Error('请使用资源完整内嵌的 GLB / Use a self-contained GLB');
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  const bounds = new Box3().setFromObject(gltf.scene);
  if (bounds.isEmpty())
    throw new Error('模型没有可显示的几何体 / The model has no geometry');
  const center = bounds.getCenter(new Vector3());
  gltf.scene.position.set(-center.x, -bounds.min.y, -center.z);
  return { scene: gltf.scene, bounds: bounds.getSize(new Vector3()).toArray() };
}
export async function importAsset(file: File) {
  editable();
  if (!file.name.toLowerCase().endsWith('.glb'))
    throw new Error('请选择 .glb 文件 / Choose a .glb file');
  const buffer = await file.arrayBuffer();
  const parsed = await parseModel(buffer);
  const asset: Asset = {
    id: `import-${crypto.randomUUID()}`,
    kind: 'model',
    name: file.name.replace(/\.glb$/i, ''),
    en: file.name.replace(/\.glb$/i, ''),
    category: '三维资产',
    categoryEn: '3D asset',
    description: '本地导入 · 原始尺度',
    descriptionEn: 'Local import · Original scale',
    version: '1.0',
    fileName: file.name,
    size: file.size,
    buffer,
    ...parsed,
  };
  publish({
    assets: [...state.assets, asset],
    layout: { ...state.layout, dirty: true },
  });
  return asset;
}
export function deleteAsset(id: string) {
  editable();
  if (state.layout.entities.some((e) => e.assetId === id))
    throw new Error(
      '资产仍被对象引用，请先解除引用 / This asset is still referenced',
    );
  if (seededAssets.some((a) => a.id === id))
    throw new Error('内置资产保留用于预览 / Built-in preview asset');
  publish({
    assets: state.assets.filter((a) => a.id !== id),
    layout: { ...state.layout, dirty: true },
  });
}
export async function reopen() {
  editable();
  if (!saved) saved = await persistence();
  if (!saved) throw new Error('请先保存实验室 / Save the laboratory first');
  await restore(saved);
}
async function restore(data: any) {
  const assets = await Promise.all(
    data.assets.map(async (a: Asset) =>
      a.buffer ? { ...a, ...(await parseModel(a.buffer)) } : a,
    ),
  );
  const entities = data.layout.entities;
  engine = Object.fromEntries(entities.map((e: Entity) => [e.id, device(e)]));
  publish({
    layout: { ...data.layout, dirty: false },
    assets,
    devices: { ...engine },
    tasks: [],
    events: [
      {
        id: ++nextId,
        at: now(),
        entityId: 'lab',
        title: '已打开本机保存的实验室',
        en: 'Opened the locally saved laboratory',
        actor: 'System',
        tone: 'success',
      },
    ],
  });
}
export function reset() {
  disconnectedView = null;
  state = initial();
  engine = structuredClone(state.devices);
  state.meta.ready = true;
  emit();
}
export async function initialize() {
  try {
    saved = await persistence();
    if (saved) await restore(saved);
  } catch {}
  publish({ meta: { ...state.meta, ready: true } });
}
export function worldResult(id?: string) {
  const entities = state.layout.entities.filter(
    (e) => !e.archived && (!id || e.id === id),
  );
  return {
    lab: state.layout.name,
    revision: state.layout.revision,
    entities: entities.map((e) => ({
      id: e.id,
      name: e.name,
      kind: e.kind,
      registered_location: e.location,
      placement: e.position,
      binding: engine[e.id]?.program ? 'simulator' : null,
      state: ['centrifuge', 'sensor', 'light'].includes(e.kind)
        ? state.devices[e.id]
        : null,
      source: ['centrifuge', 'sensor', 'light'].includes(e.kind)
        ? 'simulator'
        : 'manual',
    })),
  };
}
(window as any).__FOUNDATION_PREVIEW__ = { snapshot, worldResult };
