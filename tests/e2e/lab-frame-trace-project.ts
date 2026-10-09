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
  children?: number[];
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
    frame?: string;
    beginData?: { frame?: string };
    data?: {
      frames?: { frame: string; processId: number }[];
      frame?: string;
      frameId?: string;
      page?: string;
      processId?: number;
      beginData?: { frame?: string };
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
  activeDocuments?: {
    status: 'ack' | 'unavailable';
    frames: ({
      frame: string;
      loaderId?: string;
      path: string;
      nodeMs: number;
    } | null)[];
  };
  repoRoot?: string;
};
const structuralNames = new Set([
  ...taskNames,
  'thread_name',
  'process_name',
  'clock_sync',
  'Profile',
  'ProfileChunk',
  'TracingStartedInBrowser',
  'TracingStartedInPage',
  'FrameCommittedInBrowser',
  'FrameDeletedInBrowser',
  'CommitLoad',
  'FrameStartedLoading',
  'MarkDOMContent',
  'MarkLoad',
  'BeginMainThreadFrame',
  'DrawFrame',
  'PaintImage',
  'DecodeImage',
  'RasterTask',
  'TimerFire',
  'UpdateCounters',
  'ScheduleStyleRecalculation',
]);
function frameToken(value: unknown) {
  return typeof value === 'string' && /^[0-9a-f-]{16,80}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}
function taggedFrames(event: Event) {
  const data = event.args?.data;
  return [
    data?.frame,
    data?.frameId,
    data?.page,
    data?.beginData?.frame,
    event.args?.frame,
    event.args?.beginData?.frame,
  ]
    .map(frameToken)
    .filter((frame): frame is string => !!frame);
}
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
  const assertionStart =
    marks.filter((mark) => mark.name === 'assertion-start').at(-1)?.traceUs ??
    marks.filter((mark) => mark.name === 'start-response').at(-1)?.traceUs;
  const captureEnd = marks
    .filter((mark) => mark.name === 'ack-capture-end')
    .at(-1)?.traceUs;
  const rendererThreads = new Map<number, Set<number>>();
  for (const event of events)
    if (
      event.ph === 'M' &&
      event.name === 'thread_name' &&
      event.args?.name === 'CrRendererMain'
    ) {
      const threads = rendererThreads.get(event.pid) ?? new Set<number>();
      threads.add(event.tid);
      rendererThreads.set(event.pid, threads);
    }
  const histories = new Map<string, { pid: number; ts: number }[]>();
  const mapFrame = (value: unknown, pid: number, ts: number) => {
    const frame = frameToken(value);
    if (!frame || !Number.isInteger(pid) || pid <= 0) return;
    const history = histories.get(frame) ?? [];
    if (history.at(-1)?.pid !== pid) history.push({ pid, ts });
    histories.set(frame, history);
  };
  const names = new Map<string, number>();
  const frameShapes: Record<string, unknown>[] = [];
  const shapeKeys = new Set<string>();
  let otherNames = 0;
  for (const event of events) {
    const data = event.args?.data;
    if (structuralNames.has(event.name ?? ''))
      names.set(event.name!, (names.get(event.name!) ?? 0) + 1);
    else otherNames++;
    const tags = taggedFrames(event);
    const fields = [
      'frame',
      'frameId',
      'page',
      'frames',
      'processId',
      'beginData',
    ].filter((key) => data && key in data);
    const shape = `${event.name}:${event.ph}:${event.pid}:${fields.join(',')}:${!!event.args?.beginData}`;
    if (
      frameShapes.length < 60 &&
      !shapeKeys.has(shape) &&
      (tags.length || data?.frames?.length)
    ) {
      shapeKeys.add(shape);
      frameShapes.push({
        name: structuralNames.has(event.name ?? '') ? event.name : '<REDACTED>',
        pid: event.pid,
        tid: event.tid,
        ph: ['M', 'X', 'B', 'E', 'I', 'P', 'C', 'b', 'e', 'n'].includes(
          event.ph ?? '',
        )
          ? event.ph
          : '<REDACTED>',
        fields,
        topLevelBeginData: !!event.args?.beginData,
        frames: tags.slice(0, 4),
        processId: Number.isInteger(data?.processId) ? data!.processId : null,
      });
    }
    if (event.name === 'TracingStartedInBrowser')
      for (const frame of data?.frames ?? [])
        mapFrame(frame.frame, frame.processId, event.ts);
    if (
      event.name === 'FrameCommittedInBrowser' &&
      data?.frame &&
      Number.isInteger(data.processId)
    )
      mapFrame(data.frame, data.processId!, event.ts);
    if (rendererThreads.has(event.pid))
      for (const frame of tags) mapFrame(frame, event.pid, event.ts);
  }
  for (const history of histories.values()) history.sort((a, b) => a.ts - b.ts);
  const root = frameToken(owner.targetFrame);
  const atWindow = (frame: string | undefined) => {
    if (!frame) return undefined;
    const history = histories.get(frame) ?? [];
    const before = history.filter(
      (entry) => assertionStart == null || entry.ts <= assertionStart,
    );
    return (
      before.at(-1)?.pid ??
      history.find((entry) => assertion != null && entry.ts <= assertion)?.pid
    );
  };
  const pid = atWindow(root);
  const others = owner.otherFrames.map((frame) => atWindow(frameToken(frame)));
  const targetThreads =
    pid === undefined ? [] : [...(rendererThreads.get(pid) ?? [])];
  const stable =
    !!root &&
    !histories
      .get(root)
      ?.some(
        (entry) =>
          assertionStart != null &&
          assertion != null &&
          entry.ts >= assertionStart &&
          entry.ts <= assertion &&
          entry.pid !== pid,
      );
  const known =
    offsetUs !== null &&
    assertion !== null &&
    assertion !== undefined &&
    pid !== undefined &&
    !!root &&
    stable &&
    owner.activeDocuments?.status === 'ack' &&
    owner.activeDocuments.frames[0]?.path === '/lab' &&
    targetThreads.length === 1;
  const target = known ? { pid: pid!, tid: targetThreads[0] } : undefined;
  const sharingKnown =
    others.length === owner.otherPageCount &&
    others.every((other) => other !== undefined);
  const shared =
    pid !== undefined &&
    owner.otherFrames.some((frame) =>
      histories
        .get(frameToken(frame) ?? '')
        ?.some((entry) => entry.pid === pid),
    );
  const mapping = {
    status: known ? 'mapped-target-frame' : 'unknown',
    targetRootCaptured: !!owner.targetFrame,
    otherRootsCaptured: owner.otherFrames.filter(Boolean).length,
    expectedOtherRoots: owner.otherPageCount,
    distinctFromOtherPages: null,
    targetRootSeenInTrace: pid !== undefined,
    otherRootsSeenInTrace: others.filter((other) => other !== undefined).length,
    sharedWithOtherPage: shared,
    peerPidsKnownAtAssertionStart: sharingKnown,
    rendererThreadCandidates: targetThreads.length,
    stableDuringAssertion: stable,
    rendererPid: target?.pid ?? null,
    rendererTid: target?.tid ?? null,
  };
  const processTasks = target
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
          targetFrameTagged: taggedFrames(event).includes(root!),
        }))
    : [];
  const tasks = processTasks.filter(
    (task) =>
      task.targetFrameTagged &&
      assertionStart != null &&
      assertion != null &&
      task.startUs <= assertion &&
      task.startUs + task.durationUs >= assertionStart,
  );
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
    for (const node of profile.nodes.values())
      for (const child of node.children ?? []) {
        const descendant = profile.nodes.get(child);
        if (descendant) descendant.parent = node.id;
      }
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
    activeDocuments: owner.activeDocuments ?? null,
    census: {
      names: Object.fromEntries(names),
      otherNames,
      frameShapes,
      rendererThreads: [...rendererThreads].map(([process, threads]) => ({
        pid: process,
        tids: [...threads],
      })),
      frameHistories: [...histories]
        .slice(0, 40)
        .map(([frame, entries]) => ({ frame, entries: entries.slice(-8) })),
    },
    taskScope:
      assertionStart == null
        ? 'assertion interval missing; no target task counts'
        : 'target-frame-tagged work overlapping the verified assertion interval',
    assertionWindow: {
      startUs: assertionStart ?? null,
      endUs: assertion ?? null,
    },
    tasksDuringAssertion:
      assertionStart == null || assertion == null ? null : tasks.slice(0, 30),
    processWork: {
      scope:
        'renderer-process work over the full trace; mixed-page or unverified, not observer-only',
      tasks: processTasks.length,
      longest: [...processTasks]
        .sort((a, b) => b.durationUs - a.durationUs)
        .slice(0, 15),
    },
    taskCounts:
      target && assertionStart != null
        ? Object.fromEntries(
            [...taskNames].map((name) => [
              name,
              tasks.filter((task) => task.name === name).length,
            ]),
          )
        : null,
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
      profileChunks: target ? profileChunks : null,
      samples: target ? samples : null,
      unmappedSamples: target ? unmappedSamples : null,
      scope: known
        ? 'renderer-process samples over the full trace; mixed-page or unverified, not observer-only'
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
