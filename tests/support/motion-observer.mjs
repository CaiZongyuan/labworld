import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';

const entry = process.argv[1] ?? '';
const controlledClockEntry = /\/tests\/support\/secure-expiry-server\.ts$/.test(
  entry,
);
if (
  (/\/apps\/server\/src\/main\.(js|ts)$/.test(entry) || controlledClockEntry) &&
  process.env.MOTION_E2E_OBSERVER_DIR
) {
  const root = resolve(
    dirname(entry),
    controlledClockEntry ? '../..' : '../../..',
  );
  const extension = entry.endsWith('.js') ? 'js' : 'ts';
  const require = createRequire(join(root, 'apps/server/package.json'));
  const { WebSocket, WebSocketServer } = require('ws');
  const { MotionGateway } = await import(
    pathToFileURL(
      join(root, `packages/server/src/lab/motion/gateway.${extension}`),
    )
  );
  const { Database } = await import(
    pathToFileURL(
      join(root, `packages/server/src/platform/db/index.${extension}`),
    )
  );
  const directory = process.env.MOTION_E2E_OBSERVER_DIR;
  mkdirSync(directory, { recursive: true });
  const target = join(directory, `${process.pid}.json`);
  const scope = new AsyncLocalStorage();
  const sockets = new Map();
  const gateways = new Set();
  // Retain only the first 16 actual owners through final flush, including releases.
  const recordingOwners = [];
  const recordingGateways = new Set();
  let recordingOwnersObserved = 0;
  let recordingOwnersOmitted = 0;
  if (process.env.RECORDING_FIRST_FAULT_DIAGNOSTIC === 'true') {
    const [{ RecordingService }, { RecordingWebSockets }] = await Promise.all([
      import(
        pathToFileURL(
          join(root, `packages/server/src/lab/recordings/service.${extension}`),
        )
      ),
      import(
        pathToFileURL(join(root, `apps/server/src/recording-ws.${extension}`))
      ),
    ]);
    const createOwner = RecordingService.prototype.createOwner;
    RecordingService.prototype.createOwner = function (...args) {
      const owner = createOwner.apply(this, args);
      if (recordingOwnersObserved < 16) {
        recordingOwners.push({ ownerNumber: ++recordingOwnersObserved, owner });
      } else recordingOwnersOmitted++;
      return owner;
    };
    const connection = RecordingWebSockets.prototype.connection;
    RecordingWebSockets.prototype.connection = function (...args) {
      if (recordingGateways.size < 4) recordingGateways.add(this);
      return connection.apply(this, args);
    };
  }
  const stats = {
    pid: process.pid,
    boundary:
      'read-only actual production ws/gateway observer; no target-side blocking or value substitution',
    sockets: [],
    frames: 0,
    directPoseDbCalls: 0,
    pendingMaxBytes: 0,
    pendingMaxSlots: 0,
    publishMsMax: 0,
    observerMs: 0,
    socketCount: 0,
    stoppedGateways: 0,
  };
  const originalUpgrade = WebSocketServer.prototype.handleUpgrade;
  WebSocketServer.prototype.handleUpgrade = function (
    request,
    socket,
    head,
    callback,
  ) {
    return originalUpgrade.call(this, request, socket, head, (ws, ...args) => {
      const row = {
        id: ++stats.socketCount,
        role: request.url?.split('/').at(-1),
        scopeId: request.url?.match(
          /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/,
        )?.[0],
        encrypted: request.socket.encrypted === true,
        admitted: false,
        remoteAddress: request.socket.remoteAddress,
        remotePort: request.socket.remotePort,
        localAddress: request.socket.localAddress,
        localPort: request.socket.localPort,
        maxBufferBytes: 0,
        softCrossedAt: null,
        closeRequestedAt: null,
        closedAt: null,
        bufferReads: 0,
        sends: 0,
        sentBytes: 0,
        open: true,
        closeReason: null,
      };
      sockets.set(ws, row);
      stats.sockets.push(row);
      ws.once('close', () => {
        row.open = false;
        row.closedAt = performance.now();
        sockets.delete(ws);
      });
      return callback(ws, ...args);
    });
  };
  const descriptor = Object.getOwnPropertyDescriptor(
    WebSocket.prototype,
    'bufferedAmount',
  );
  Object.defineProperty(WebSocket.prototype, 'bufferedAmount', {
    ...descriptor,
    get() {
      const started = performance.now();
      const value = descriptor.get.call(this);
      const row = sockets.get(this);
      if (row) {
        row.bufferReads++;
        row.maxBufferBytes = Math.max(row.maxBufferBytes, value);
        if (value > 65536 && row.softCrossedAt === null)
          row.softCrossedAt = performance.now();
      }
      stats.observerMs += performance.now() - started;
      return value;
    },
  });
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data, ...args) {
    const row = sockets.get(this);
    if (row) {
      if (typeof data === 'string') {
        try {
          if (
            ['motion.welcome', 'recording.ready'].includes(
              JSON.parse(data).type,
            )
          )
            row.admitted = true;
        } catch {
          // Non-JSON traffic is not an authenticated WELCOME.
        }
      }
      row.sends++;
      row.sentBytes +=
        typeof data === 'string'
          ? Buffer.byteLength(data)
          : (data.byteLength ?? data.length);
    }
    return send.call(this, data, ...args);
  };
  const close = WebSocket.prototype.close;
  WebSocket.prototype.close = function (code, reason, ...args) {
    const row = sockets.get(this);
    if (row) {
      if (row.closeRequestedAt === null)
        row.closeRequestedAt = performance.now();
      row.closeReason =
        typeof reason === 'string' ? reason : String(reason ?? '');
    }
    return close.call(this, code, reason, ...args);
  };
  const joinGateway = MotionGateway.prototype.join;
  MotionGateway.prototype.join = function (...args) {
    gateways.add(this);
    return joinGateway.apply(this, args);
  };
  const publish = MotionGateway.prototype.publish;
  MotionGateway.prototype.publish = function (...args) {
    const started = performance.now();
    try {
      return scope.run('motion-frame', () => publish.apply(this, args));
    } finally {
      stats.frames++;
      stats.publishMsMax = Math.max(
        stats.publishMsMax,
        performance.now() - started,
      );
    }
  };
  const flush = MotionGateway.prototype.flushViewer;
  MotionGateway.prototype.flushViewer = function (session, viewer, ...args) {
    const started = performance.now();
    if (viewer.pending) {
      stats.pendingMaxSlots = Math.max(stats.pendingMaxSlots, 1);
      stats.pendingMaxBytes = Math.max(
        stats.pendingMaxBytes,
        viewer.pending.byteLength,
      );
    }
    stats.observerMs += performance.now() - started;
    return flush.call(this, session, viewer, ...args);
  };
  for (const name of [
    'read',
    'readSQL',
    'transaction',
    'operation',
    'script',
    'batch',
  ]) {
    const original = Database.prototype[name];
    if (typeof original !== 'function') continue;
    Database.prototype[name] = function (...args) {
      if (scope.getStore() === 'motion-frame') stats.directPoseDbCalls++;
      return original.apply(this, args);
    };
  }
  const stop = MotionGateway.prototype.stop;
  MotionGateway.prototype.stop = function (...args) {
    const result = stop.apply(this, args);
    gateways.delete(this);
    stats.stoppedGateways++;
    stats.gatewaySessionsAfterStop = this.sessions.size;
    stats.gatewayTimerAfterStop = this.timer === undefined ? 0 : 1;
    return result;
  };
  function save() {
    const sample = {
      ...stats,
      liveSockets: sockets.size,
      liveGateways: gateways.size,
      recordingOwnersObserved,
      recordingOwnersOmitted,
      recordingFirstFaults: recordingOwners
        .flatMap(({ ownerNumber, owner }) =>
          owner.diagnosticFirstFault
            ? [{ ownerNumber, ...owner.diagnosticFirstFault }]
            : [],
        )
        .slice(0, 16),
      recordingCapacity: [...recordingGateways].flatMap((gateway, index) =>
        gateway.diagnosticConnections.map((connection, connectionIndex) => ({
          gatewayNumber: index + 1,
          connectionNumber: connectionIndex + 1,
          admittedMessages: connection.admittedMessages,
          recentMessages: connection.recentMessages,
          firstCapacity: connection.firstCapacity ?? null,
        })),
      ),
      recordingCapacityConnectionsOmitted: [...recordingGateways].reduce(
        (sum, gateway) => sum + gateway.diagnosticConnectionsOmitted,
        0,
      ),
      rssBytes: process.memoryUsage().rss,
      at: new Date().toISOString(),
    };
    writeFileSync(target + '.next', JSON.stringify(sample) + '\n', {
      mode: 0o600,
    });
    renameSync(target + '.next', target);
  }
  const timer = setInterval(save, 1000);
  timer.unref();
  process.once('exit', () => {
    clearInterval(timer);
    save();
  });
  save();
}
