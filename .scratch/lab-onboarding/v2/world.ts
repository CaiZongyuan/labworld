// PROTOTYPE: isolated browser storage and simulated devices; no product API.
import { useSyncExternalStore } from 'react';
import type { Object3D } from 'three';

export type Kind =
  | 'bench'
  | 'labware'
  | 'light'
  | 'sensor'
  | 'centrifuge'
  | 'robot'
  | 'environment'
  | 'model';
export type Asset = {
  id: string;
  kind: Kind;
  scene?: Object3D;
  bounds?: number[];
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
  width?: number;
};
export type Observation = {
  program: boolean;
  on: boolean;
  brightness: number;
  temperature: number;
  rpm: number;
  observedAt: number;
  samples: number;
};
export type LabEvent = { id: string; at: number; zh: string; en: string };
type Guide = {
  paused: boolean;
  adjusted: boolean;
  completed: boolean;
  bench?: string;
  kit: string[];
  brightnessChanged: boolean;
};
type Lab = {
  id: string;
  name: string;
  entities: Entity[];
  devices: Record<string, Observation>;
  events: LabEvent[];
  room: boolean;
  dirty: boolean;
  revision: number;
  guide?: Guide;
};
export type Entry = 'guided' | 'sample' | 'blank';
type State = {
  labs: Lab[];
  activeId: string;
  entry: Entry | null;
  scenario: string;
  error: string;
  pending: boolean;
};
const KEY = 'PROTOTYPE-lab-onboarding-v2';
const emptyLayout = {
  name: '',
  entities: [] as Entity[],
  dirty: false,
  revision: 0,
  room: false,
};
const assets: Asset[] = [
  'bench',
  'labware',
  'light',
  'sensor',
  'centrifuge',
  'robot',
].map((kind) => ({ id: kind, kind: kind as Kind }));
const listeners = new Set<() => void>();
const fresh = (): State => ({
  labs: [],
  activeId: '',
  entry: null,
  scenario: 'normal',
  error: '',
  pending: false,
});
function load(): State {
  try {
    const data = JSON.parse(
      localStorage.getItem(KEY) ?? 'null',
    ) as State | null;
    if (!data || !Array.isArray(data.labs)) return fresh();
    for (const lab of data.labs) {
      for (const observation of Object.values(lab.devices))
        observation.program = false;
    }
    return { ...data, scenario: 'normal', error: '', pending: false };
  } catch {
    return fresh();
  }
}
let state = load();
function project() {
  const lab = state.labs.find((entry) => entry.id === state.activeId);
  return {
    ...state,
    lab,
    layout: lab ? { ...lab, entities: lab.entities } : emptyLayout,
    devices: lab?.devices ?? {},
    assets,
  };
}
let view = project();
export const snapshot = () => view;
export function useWorld<T>(select: (world: typeof view) => T): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => select(view),
  );
}
export const model = (id: string) => view.devices[id];
function publish(persist = true) {
  if (persist) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      state = { ...state, error: 'storage' };
    }
  }
  view = project();
  listeners.forEach((listener) => listener());
}
function update(change: (lab: Lab) => Lab) {
  state = {
    ...state,
    labs: state.labs.map((lab) =>
      lab.id === state.activeId ? change(lab) : lab,
    ),
  };
  publish();
}
function event(lab: Lab, zh: string, en: string): LabEvent[] {
  return [
    { id: crypto.randomUUID(), at: Date.now(), zh, en },
    ...lab.events,
  ].slice(0, 20);
}
function entity(
  kind: Kind,
  name: string,
  en: string,
  position: Entity['position'],
  width?: number,
): Entity {
  return {
    id: crypto.randomUUID(),
    kind,
    assetId: kind,
    name,
    en,
    position,
    rotation: 0,
    location: 'lab',
    visible: true,
    archived: false,
    width,
  };
}
function observation(): Observation {
  return {
    program: false,
    on: false,
    brightness: 80,
    temperature: 22.4,
    rpm: 0,
    observedAt: 0,
    samples: 0,
  };
}
function sampleEntities() {
  const benchA = entity('bench', '实验台 A', 'Bench A', [-1.45, 0, -1], 3.9);
  const benchB = entity('bench', '实验台 B', 'Bench B', [2.1, 0, 1.2], 3.25);
  const objects = [
    benchA,
    benchB,
    entity('centrifuge', '离心机 01', 'Centrifuge 01', [-2.4, 0.96, -1]),
    entity('centrifuge', '离心机 02', 'Centrifuge 02', [-0.85, 0.96, -1]),
    entity(
      'sensor',
      '温度传感器 01',
      'Temperature sensor 01',
      [0.22, 0.96, -1],
    ),
    entity('light', '照明 01', 'Light 01', [-3.8, 0, 1.7]),
    entity('robot', '机械臂 01', 'Robot 01', [1.6, 0.96, 1.2]),
    entity('labware', '烧杯 01', 'Beaker 01', [3.03, 0.96, 1.3]),
  ];
  for (const item of objects.slice(2, 5)) item.location = benchA.id;
  for (const item of objects.slice(6)) item.location = benchB.id;
  return objects;
}
export function chooseEntry(entry: Entry | null) {
  state = { ...state, entry, error: '' };
  publish();
}
export function selectLab(id: string) {
  state = { ...state, activeId: id, entry: null, error: '' };
  publish();
}
async function operation(
  kind: 'create' | 'save' | 'runtime',
  action: () => void,
) {
  if (state.pending) return;
  const activeId = state.activeId;
  state = { ...state, pending: true, error: '' };
  publish(false);
  await new Promise((resolve) => setTimeout(resolve, 450));
  if (activeId !== state.activeId) {
    state = { ...state, pending: false };
    publish(false);
    return;
  }
  const failure =
    state.scenario === 'offline'
      ? 'offline'
      : state.scenario === `${kind}-failure`
        ? kind
        : '';
  if (failure) {
    state = {
      ...state,
      pending: false,
      error: failure,
      scenario: failure === 'offline' ? 'offline' : 'normal',
    };
    publish(false);
    return;
  }
  state = { ...state, pending: false };
  action();
}
export async function createLab(name: string, entry: Entry) {
  if (!name.trim()) return;
  await operation('create', () => {
    const bench = entity('bench', '实验台 A', 'Bench A', [-0.8, 0, -0.65], 3.9);
    const beaker = entity(
      'labware',
      '烧杯 01',
      'Beaker 01',
      [-1.65, 0.96, -0.65],
    );
    const sensor = entity(
      'sensor',
      '温度传感器 01',
      'Temperature sensor 01',
      [0.4, 0.96, -0.65],
    );
    beaker.location = bench.id;
    sensor.location = bench.id;
    const entities =
      entry === 'sample'
        ? sampleEntities()
        : entry === 'guided'
          ? [bench, beaker, sensor]
          : [];
    const lab: Lab = {
      id: crypto.randomUUID(),
      name: name.trim(),
      room: entry !== 'blank',
      entities,
      devices: Object.fromEntries(
        entities.map((item) => [item.id, observation()]),
      ),
      events: [],
      dirty: false,
      revision: 1,
      guide:
        entry === 'guided'
          ? {
              paused: false,
              adjusted: false,
              completed: false,
              kit: [],
              brightnessChanged: false,
            }
          : undefined,
    };
    lab.events = event(lab, '实验室已创建', 'Laboratory created');
    state = {
      ...state,
      labs: [...state.labs, lab],
      activeId: lab.id,
      entry: null,
    };
    publish();
  });
}
export function currentStep(): number {
  const lab = view.lab;
  if (!lab) return 0;
  const guide = lab.guide;
  if (!guide || guide.completed) return 5;
  if (!lab.entities.some((item) => item.id === guide.bench)) return 1;
  if (
    guide.kit.length !== 3 ||
    !guide.kit.every((id) => lab.entities.some((item) => item.id === id))
  )
    return 2;
  if (!guide.adjusted || lab.dirty) return 3;
  return 4;
}
export function placeBench() {
  if (!view.lab?.guide || view.lab.guide.bench || state.scenario === 'offline')
    return;
  const bench = entity('bench', '实验台 A', 'Bench A', [-0.8, 0, -0.65], 3.9);
  update((lab) => ({
    ...lab,
    entities: [...lab.entities, bench],
    dirty: true,
    guide: { ...lab.guide!, bench: bench.id },
    events: event(lab, '实验台已加入场景', 'Bench placed'),
  }));
  return bench.id;
}
export function placeKit() {
  if (
    !view.lab?.guide ||
    view.lab.guide.kit.length ||
    state.scenario === 'offline'
  )
    return;
  const kit = [
    entity('labware', '烧杯 01', 'Beaker 01', [-1.65, 0.96, -0.65]),
    entity(
      'sensor',
      '温度传感器 01',
      'Temperature sensor 01',
      [0.4, 0.96, -0.65],
    ),
    entity('light', '照明 01', 'Light 01', [-3.15, 0, 0.85]),
  ];
  kit[0].location = view.lab.guide.bench!;
  kit[1].location = view.lab.guide.bench!;
  update((lab) => ({
    ...lab,
    entities: [...lab.entities, ...kit],
    devices: {
      ...lab.devices,
      ...Object.fromEntries(kit.map((item) => [item.id, observation()])),
    },
    dirty: true,
    guide: { ...lab.guide!, kit: kit.map((item) => item.id) },
    events: event(
      lab,
      '烧杯、照明与传感器已加入场景',
      'Beaker, light and sensor placed',
    ),
  }));
  return kit[0].id;
}
export function patchEntity(id: string, changes: Partial<Entity>) {
  if (state.scenario === 'offline') return;
  const previous = view.lab?.entities.find((item) => item.id === id);
  if (
    !previous ||
    Object.entries(changes).every(
      ([key, value]) =>
        JSON.stringify(previous[key as keyof Entity]) === JSON.stringify(value),
    )
  )
    return;
  update((lab) => ({
    ...lab,
    entities: lab.entities.map((item) =>
      item.id === id ? { ...item, ...changes } : item,
    ),
    dirty: true,
    guide: lab.guide
      ? {
          ...lab.guide,
          adjusted:
            lab.guide.adjusted ||
            !!changes.position ||
            changes.rotation !== undefined,
        }
      : undefined,
  }));
}
export async function saveLayout() {
  await operation('save', () =>
    update((lab) => ({
      ...lab,
      dirty: false,
      revision: lab.revision + 1,
      events: event(lab, '布局已保存', 'Layout saved'),
    })),
  );
}
export function pauseGuide(paused: boolean) {
  update((lab) => ({
    ...lab,
    guide: lab.guide ? { ...lab.guide, paused } : undefined,
  }));
}
export async function startDevices(entityId?: string) {
  await operation('runtime', () =>
    update((lab) => ({
      ...lab,
      devices: Object.fromEntries(
        Object.entries(lab.devices).map(([id, device]) => {
          const kind = lab.entities.find((item) => item.id === id)?.kind;
          return [
            id,
            (!entityId || entityId === id) &&
            (kind === 'light' || kind === 'sensor')
              ? { ...device, program: true, on: false }
              : device,
          ];
        }),
      ),
      events: event(
        lab,
        '模拟设备程序已启动',
        'Simulated device programs started',
      ),
    })),
  );
}
export async function lightCommand(id: string, brightness: number, on = true) {
  await operation('runtime', () =>
    update((lab) => ({
      ...lab,
      devices: {
        ...lab.devices,
        [id]: { ...lab.devices[id], on, brightness, observedAt: Date.now() },
      },
      guide: lab.guide
        ? {
            ...lab.guide,
            brightnessChanged: lab.guide.brightnessChanged || brightness !== 80,
          }
        : undefined,
      events: event(
        lab,
        on ? `照明观测：开启 · ${brightness}%` : '照明观测：关闭',
        on
          ? `Light observation: on · ${brightness}%`
          : 'Light observation: off',
      ),
    })),
  );
}
export function stopDevice(id: string) {
  update((lab) => ({
    ...lab,
    devices: { ...lab.devices, [id]: { ...lab.devices[id], program: false } },
    events: event(lab, '设备程序已停止', 'Device program stopped'),
  }));
}
export function addObject(kind: Kind, name?: string) {
  if (!view.lab || state.scenario === 'offline') return;
  const names: Record<string, [string, string]> = {
    bench: ['实验台', 'Bench'],
    labware: ['烧杯', 'Beaker'],
    light: ['照明', 'Light'],
    sensor: ['温度传感器', 'Temperature sensor'],
    centrifuge: ['离心机', 'Centrifuge'],
    robot: ['机械臂', 'Robot'],
  };
  const n = view.lab.entities.filter((item) => item.kind === kind).length + 1;
  const item = entity(
    kind,
    name?.trim() || `${names[kind][0]} ${n}`,
    name?.trim() || `${names[kind][1]} ${n}`,
    kind === 'bench'
      ? [-0.8, 0, -0.65]
      : kind === 'light'
        ? [-3.15, 0, 0.85]
        : kind === 'labware'
          ? [-1.65, 0.96, -0.65]
          : kind === 'sensor'
            ? [0.4, 0.96, -0.65]
            : [0, 0, 1.6],
    kind === 'bench' ? 3.25 : undefined,
  );
  update((lab) => ({
    ...lab,
    entities: [...lab.entities, item],
    devices: { ...lab.devices, [item.id]: observation() },
    dirty: true,
    events: event(lab, '对象已加入场景', 'Entity placed'),
  }));
  return item.id;
}
export async function registerObject(kind: Kind, name: string) {
  let id: string | undefined;
  await operation('create', () => {
    id = addObject(kind, name);
  });
  return id;
}
export function clearError() {
  state = { ...state, error: '' };
  publish(false);
}
export function injectFailure(scenario: string) {
  state = { ...state, scenario, error: '' };
  publish();
}
export function reset() {
  state = fresh();
  publish();
}
export async function setScenario(name: string, labName = '我的第一个实验室') {
  if (name === 'normal') {
    state = { ...state, scenario: name, error: '' };
    publish();
    return;
  }
  reset();
  chooseEntry('guided');
  if (name !== 'first' && name !== 'create-failure') {
    await createLab(labName, 'guided');
    placeBench();
    placeKit();
    const bench = view.lab?.guide?.bench;
    if (bench) patchEntity(bench, { position: [-0.6, 0, -0.65] });
    if (name === 'complete') {
      await saveLayout();
      await startDevices();
      const light = view.lab?.entities.find((item) => item.kind === 'light');
      if (light) await lightCommand(light.id, 65);
      tick();
    }
  }
  state = {
    ...state,
    scenario: ['first', 'midway', 'complete'].includes(name) ? 'normal' : name,
    error: '',
  };
  publish();
}
function tick() {
  if (state.scenario === 'offline') return;
  if (
    !state.labs.some((lab) =>
      Object.values(lab.devices).some((device) => device.program),
    )
  )
    return;
  state = {
    ...state,
    labs: state.labs.map((lab) => {
      const devices = Object.fromEntries(
        Object.entries(lab.devices).map(([id, device]) => {
          const item = lab.entities.find((item) => item.id === id);
          return [
            id,
            device.program && item?.kind === 'sensor'
              ? {
                  ...device,
                  temperature: 22.4 + Math.sin(Date.now() / 9000) * 0.4,
                  observedAt: Date.now(),
                  samples: device.samples + 1,
                }
              : device,
          ];
        }),
      );
      const light = lab.entities.find((item) => item.kind === 'light');
      const sensor = lab.entities.find((item) => item.kind === 'sensor');
      const complete =
        lab.guide &&
        !lab.guide.completed &&
        lab.guide.adjusted &&
        !lab.dirty &&
        lab.guide.brightnessChanged &&
        light &&
        devices[light.id]?.program &&
        devices[light.id].on &&
        sensor &&
        devices[sensor.id]?.samples > 0;
      return {
        ...lab,
        devices,
        guide: complete ? { ...lab.guide!, completed: true } : lab.guide,
        events: complete
          ? event(lab, '首次搭建已完成', 'First laboratory completed')
          : lab.events,
      };
    }),
  };
  publish();
}
const timer = setInterval(tick, 1000);
if (import.meta.hot) import.meta.hot.dispose(() => clearInterval(timer));
