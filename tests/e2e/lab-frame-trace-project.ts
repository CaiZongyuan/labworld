import { isMainThread, parentPort, workerData } from 'node:worker_threads';
const taskNames = new Set([
  'RunTask',
  'ThreadControllerImpl::RunTask',
  'FunctionCall',
  'FireAnimationFrame',
  'EvaluateScript',
  'Layout',
  'UpdateLayoutTree',
  'Paint',
]);
type CpuNode = {
  id: number;
  parent?: number;
  callFrame: { url: string; lineNumber: number; columnNumber: number };
};
type Event = {
  name?: string;
  ph?: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  id?: string | number;
  args?: {
    name?: string;
    sync_id?: string;
    data?: {
      frames?: { frame: string; processId: number }[];
      frame?: string;
      processId?: number;
      cpuProfile?: { nodes?: CpuNode[]; samples?: number[] };
      timeDeltas?: number[];
    };
  };
};
export type Complete = { stream?: string; dataLossOccurred?: boolean };

export type TraceOwner = {
  clockBeforeMs?: number;
  clockAfterMs?: number;
  marks: { name: string; nodeMs: number }[];
  targetFrame?: string;
  otherFrames: (string | undefined)[];
  otherPageCount: number;
  repoRoot?: string;
};
function sourceCoordinate(node: CpuNode, repoRoot?: string) {
  try {
    const path = decodeURIComponent(new URL(node.callFrame.url).pathname);
    const root = repoRoot?.replaceAll('\\', '/').replace(/\/$/, '');
    const ownedPrefix = root ? `/@fs${root}/` : undefined;
    const source =
      ownedPrefix && path.startsWith(ownedPrefix)
        ? `/${path.slice(ownedPrefix.length)}`
        : root && path.startsWith(`${root}/`)
          ? `/${path.slice(root.length + 1)}`
          : path.startsWith('/src/')
            ? `/apps/web${path}`
            : path;
    if (
      !/^\/(?:apps|packages|node_modules)\/.+\.(?:js|mjs|ts|tsx)$/.test(source)
    )
      return null;
    const { lineNumber: line, columnNumber: column } = node.callFrame;
    if (!Number.isInteger(line) || !Number.isInteger(column)) return null;
    return { source, line, column };
  } catch {
    return null;
  }
}

export function projectTrace(
  events: Event[],
  terminal: Complete,
  bytes: number,
  owner: TraceOwner,
) {
  const clock = events.find(
    (event) =>
      event.name === 'clock_sync' &&
      event.args?.sync_id === 'owned-frame-trace',
  );
  const bracket =
    owner.clockBeforeMs !== undefined && owner.clockAfterMs !== undefined
      ? owner.clockAfterMs - owner.clockBeforeMs
      : null;
  const offsetUs =
    clock && bracket !== null
      ? clock.ts - ((owner.clockBeforeMs! + owner.clockAfterMs!) / 2) * 1000
      : null;
  const marks = owner.marks.map((mark) => ({
    ...mark,
    traceUs: offsetUs === null ? null : mark.nodeMs * 1000 + offsetUs,
  }));
  const assertion = marks
    .filter((mark) => mark.name === 'assertion-end')
    .at(-1)?.traceUs;
  const captureEnd = marks
    .filter((mark) => mark.name === 'ack-capture-end')
    .at(-1)?.traceUs;
  const frames = new Map<string, number>();
  const histories = new Map<string, Set<number>>();
  const mapFrame = (frame: string, pid: number) => {
    frames.set(frame, pid);
    const history = histories.get(frame) ?? new Set<number>();
    history.add(pid);
    histories.set(frame, history);
  };
  for (const event of events) {
    const data = event.args?.data;
    if (event.name === 'TracingStartedInBrowser')
      for (const frame of data?.frames ?? [])
        mapFrame(frame.frame, frame.processId);
    if (
      event.name === 'FrameCommittedInBrowser' &&
      data?.frame &&
      Number.isInteger(data.processId)
    )
      mapFrame(data.frame, data.processId!);
  }
  const pid = owner.targetFrame ? frames.get(owner.targetFrame) : undefined;
  const others = owner.otherFrames.map((frame) =>
    frame ? frames.get(frame) : undefined,
  );
  const targetThreads = events.filter(
    (event) =>
      event.ph === 'M' &&
      event.name === 'thread_name' &&
      event.args?.name === 'CrRendererMain' &&
      event.pid === pid,
  );
  const known =
    offsetUs !== null &&
    assertion !== null &&
    assertion !== undefined &&
    pid !== undefined &&
    !!owner.targetFrame &&
    histories.get(owner.targetFrame)?.size === 1 &&
    owner.otherFrames.every(
      (frame) => !!frame && histories.get(frame)?.size === 1,
    ) &&
    others.every((other) => other !== undefined && other !== pid) &&
    targetThreads.length === 1;
  const target = known ? targetThreads[0] : undefined;
  const mapping = {
    status: known ? 'mapped-target' : 'unknown',
    targetRootCaptured: !!owner.targetFrame,
    otherRootsCaptured: owner.otherFrames.filter(Boolean).length,
    expectedOtherRoots: owner.otherPageCount,
    distinctFromOtherPages: known,
    targetRootSeenInTrace: pid !== undefined,
    otherRootsSeenInTrace: others.filter((other) => other !== undefined).length,
    sharedWithOtherPage: pid !== undefined && others.includes(pid),
    rendererThreadCandidates: targetThreads.length,
    stableProcessHistory:
      !!owner.targetFrame &&
      histories.get(owner.targetFrame)?.size === 1 &&
      owner.otherFrames.every(
        (frame) => !!frame && histories.get(frame)?.size === 1,
      ),
    rendererPid: target?.pid ?? null,
    rendererTid: target?.tid ?? null,
  };
  const tasks = target
    ? events
        .filter(
          (event) =>
            event.pid === target.pid &&
            event.tid === target.tid &&
            event.ph === 'X' &&
            taskNames.has(event.name ?? '') &&
            Number.isFinite(event.dur),
        )
        .map((event) => ({
          name: event.name,
          startUs: event.ts,
          durationUs: event.dur!,
        }))
    : [];
  const profiles = new Map<
    string,
    { nodes: Map<number, CpuNode>; samples: number[]; deltas: number[] }
  >();
  let profileChunks = 0;
  for (const event of events) {
    if (
      !target ||
      event.pid !== target.pid ||
      event.tid !== target.tid ||
      event.name !== 'ProfileChunk'
    )
      continue;
    profileChunks++;
    const key = String(event.id ?? '');
    const profile: {
      nodes: Map<number, CpuNode>;
      samples: number[];
      deltas: number[];
    } = profiles.get(key) ?? {
      nodes: new Map(),
      samples: [],
      deltas: [],
    };
    for (const node of event.args?.data?.cpuProfile?.nodes ?? [])
      profile.nodes.set(node.id, node);
    profile.samples.push(...(event.args?.data?.cpuProfile?.samples ?? []));
    profile.deltas.push(...(event.args?.data?.timeDeltas ?? []));
    profiles.set(key, profile);
  }
  const sources = new Map<
    string,
    {
      source: string;
      line: number;
      column: number;
      samples: number;
      sampledUs: number;
    }
  >();
  let samples = 0,
    unmappedSamples = 0;
  for (const profile of profiles.values())
    for (let index = 0; index < profile.samples.length; index++) {
      samples++;
      let node = profile.nodes.get(profile.samples[index]);
      let coordinate: ReturnType<typeof sourceCoordinate> = null;
      for (let depth = 0; node && depth < 64; depth++) {
        coordinate = sourceCoordinate(node, owner.repoRoot);
        if (coordinate) break;
        node =
          node.parent === undefined
            ? undefined
            : profile.nodes.get(node.parent);
      }
      if (!coordinate) {
        unmappedSamples++;
        continue;
      }
      const key = `${coordinate.source}:${coordinate.line}:${coordinate.column}`;
      const source = sources.get(key) ?? {
        ...coordinate,
        samples: 0,
        sampledUs: 0,
      };
      source.samples++;
      source.sampledUs += profile.deltas[index] ?? 0;
      sources.set(key, source);
    }
  return {
    status: 'complete',
    bytes,
    eventCount: events.length,
    droppedEvents:
      typeof terminal.dataLossOccurred === 'boolean'
        ? terminal.dataLossOccurred
        : 'unknown',
    clock: {
      mapped: offsetUs !== null,
      calibrationBracketMs: bracket,
      midpointUncertaintyMs: bracket === null ? null : bracket / 2,
      offsetUs,
    },
    marks,
    mapping,
    taskCounts: Object.fromEntries(
      [...taskNames].map((name) => [
        name,
        tasks.filter((task) => task.name === name).length,
      ]),
    ),
    longestTasks: [...tasks]
      .sort((a, b) => b.durationUs - a.durationUs)
      .slice(0, 30),
    tasksOverlappingAssertion:
      assertion === null || assertion === undefined
        ? null
        : tasks
            .filter(
              (task) =>
                task.startUs <= assertion &&
                task.startUs + task.durationUs >= assertion,
            )
            .sort((a, b) => b.durationUs - a.durationUs)
            .slice(0, 15),
    tasksOverlappingCaptureWindow:
      assertion === null ||
      assertion === undefined ||
      captureEnd === null ||
      captureEnd === undefined
        ? null
        : tasks
            .filter(
              (task) =>
                task.startUs <= captureEnd &&
                task.startUs + task.durationUs >= assertion,
            )
            .sort((a, b) => b.durationUs - a.durationUs)
            .slice(0, 15),
    cpu: {
      profileChunks,
      samples,
      unmappedSamples,
      scope: known
        ? 'mapped target over trace interval; samples have no individual time correlation'
        : 'unknown target; no samples attributed',
      sources: [...sources.values()]
        .sort((a, b) => b.samples - a.samples)
        .slice(0, 30),
    },
  };
}

if (!isMainThread) {
  try {
    const { text, terminal, bytes, owner } = workerData as {
      text: string;
      terminal: Complete;
      bytes: number;
      owner: TraceOwner;
    };
    const events = (JSON.parse(text) as { traceEvents: Event[] }).traceEvents;
    parentPort!.postMessage(
      Array.isArray(events)
        ? projectTrace(events, terminal, bytes, owner)
        : { status: 'invalid-events' },
    );
  } catch {
    parentPort!.postMessage({ status: 'projection-incomplete' });
  }
}
