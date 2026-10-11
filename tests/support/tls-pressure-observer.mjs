import { execFile } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  renameSync,
  appendFileSync,
  statSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';

const numberFact = (value) =>
  typeof value === 'number' && Number.isFinite(value)
    ? { available: true, value }
    : { available: false, reason: 'unsupported field' };
function identity(pid) {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8')
      .split(') ')[1]
      .split(' ')[19];
  } catch {
    return undefined;
  }
}

/** Diagnostic-only counters and owned ss reader; never mutates a transport. */
export class TlsPressureObserver {
  constructor(directory, sockets, health) {
    this.directory = directory;
    this.health = health;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.sockets = sockets;
    this.counts = new Map();
    this.samples = 0;
    this.sendObserverMs = 0;
    this.sampleElapsedMs = 0;
    this.timer = setInterval(() => {
      this.health.observe(() => this.sample());
    }, 1000);
    this.timer.unref();
  }
  sent(row, data) {
    let counts = this.counts.get(row.id);
    if (!counts) {
      if (this.counts.size >= 128) return;
      counts = {
        binarySends: 0,
        binaryBytes: 0,
        controlSends: 0,
        controlBytes: 0,
        firstBinaryAt: null,
        lastBinaryAt: null,
        firstSequence: null,
        lastSequence: null,
      };
      this.counts.set(row.id, counts);
    }
    const started = performance.now();
    if (typeof data === 'string') {
      counts.controlSends++;
      counts.controlBytes += Buffer.byteLength(data);
    } else {
      const bytes = Buffer.isBuffer(data)
        ? data
        : ArrayBuffer.isView(data)
          ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : null;
      if (bytes) {
        counts.binarySends++;
        counts.binaryBytes += bytes.length;
        counts.firstBinaryAt ??= performance.now();
        counts.lastBinaryAt = performance.now();
        if (
          bytes.length >= 24 &&
          bytes.subarray(0, 4).toString('ascii') === 'LWM1'
        ) {
          const sequence = bytes.readBigUInt64LE(16).toString();
          counts.firstSequence ??= sequence;
          counts.lastSequence = sequence;
        }
      }
    }
    this.sendObserverMs += performance.now() - started;
  }
  save(name, row) {
    try {
      const path = join(this.directory, name);
      const data =
        JSON.stringify({ ...row, diagnosticHealth: this.health.status() }) +
        '\n';
      if (Buffer.byteLength(data) > 16384)
        throw new Error('Owned diagnostic tuple exceeded bound');
      writeFileSync(path + '.next', data, { mode: 0o600 });
      renameSync(path + '.next', path);
      if (name === 'server.json') this.health.published();
      return true;
    } catch {
      this.health.invalidate();
      return false;
    }
  }
  sample() {
    if (
      this.health.isSealed() ||
      this.child ||
      this.samples >= 181 ||
      this.stopped
    )
      return;
    let window;
    try {
      window = JSON.parse(
        readFileSync(join(this.directory, 'window.json'), 'utf8'),
      );
    } catch {
      return;
    }
    if (
      !Number.isInteger(window.clientPort) ||
      !Number.isInteger(window.serverPort) ||
      window.clientPort < 1 ||
      window.clientPort > 65535 ||
      window.serverPort < 1 ||
      window.serverPort > 65535
    )
      return;
    this.started ??= performance.now();
    if (performance.now() - this.started > 180000) return;
    const matched = [...this.sockets].find(
      ([, row]) =>
        row.role === 'viewer' &&
        row.scopeId === window.sessionId &&
        row.remotePort === window.clientPort &&
        row.localPort === window.serverPort,
    );
    if (!matched) return;
    const [ws, row] = matched;
    this.lastTarget = matched;
    const started = performance.now();
    const socket = ws._socket;
    const value = {
      sample: ++this.samples,
      pid: process.pid,
      clock: 'Node performance.now; subtract only this clock',
      nodeMonoNs: process.hrtime.bigint().toString(),
      wallMs: Date.now(),
      nodeAt: started,
      windowFirstObservedAt: this.started,
      priorSendObserverMs: this.sendObserverMs,
      priorSampleElapsedMs: this.sampleElapsedMs,
      localPort: row.localPort,
      remotePort: row.remotePort,
      encrypted: row.encrypted,
      wsBufferedAmount: numberFact(ws.bufferedAmount),
      tlsWritableLength: numberFact(socket?.writableLength),
      tlsWritableHighWaterMark: numberFact(socket?.writableHighWaterMark),
      tlsHandleWriteQueueSize: numberFact(socket?._handle?.writeQueueSize),
      parentWritableLength: numberFact(socket?._parent?.writableLength),
      parentHandleWriteQueueSize: numberFact(
        socket?._parent?._handle?.writeQueueSize,
      ),
      socketFd: numberFact(socket?._handle?.fd),
      viewers: [...this.sockets.values()]
        .filter((r) => r.role === 'viewer' && r.scopeId === row.scopeId)
        .slice(0, 8)
        .map((r) => ({
          id: r.id,
          remotePort: r.remotePort,
          open: r.open,
          counts: this.counts.get(r.id) ?? {
            available: false,
            reason: 'no observed sends',
          },
        })),
    };
    if (
      !this.save('ss-owner.json', {
        owner: 'passive TLS pressure observer',
        creatorPid: process.pid,
        creatorToken: identity(process.pid),
        state: 'launching',
        argv: [
          'ss',
          '-tinmH',
          'src',
          `127.0.0.1:${row.localPort}`,
          'dst',
          `127.0.0.1:${row.remotePort}`,
        ],
      })
    )
      return;
    this.childToken = undefined;
    const child = execFile(
      'ss',
      [
        '-tinmH',
        'src',
        `127.0.0.1:${row.localPort}`,
        'dst',
        `127.0.0.1:${row.remotePort}`,
      ],
      { timeout: 400, maxBuffer: 8192 },
      (error, stdout) => {
        this.child = undefined;
        this.health.observe(() => {
          value.ss = error
            ? { available: false, reason: error.code ?? 'command failed' }
            : {
                available: true,
                boundary:
                  'matched real kernel socket; includes Send-Q/Recv-Q/skmem/TCP MSS/window facts',
                text: stdout,
              };
          value.sampleCompletedAt = performance.now();
          this.sampleElapsedMs += value.sampleCompletedAt - started;
          this.save('server.json', value);
          const journal = join(this.directory, 'server.jsonl');
          const data = JSON.stringify(value) + '\n';
          let bytes = 0;
          try {
            bytes = statSync(journal).size;
          } catch {
            /* first sample */
          }
          try {
            if (bytes + Buffer.byteLength(data) <= 4 * 1024 * 1024)
              appendFileSync(journal, data, { mode: 0o600 });
          } catch {
            this.health.invalidate();
          }
          this.save('ss-owner.json', {
            owner: 'passive TLS pressure observer',
            creatorPid: process.pid,
            creatorToken: identity(process.pid),
            state: 'stopped',
            lastPid: child.pid,
            lastToken: this.childToken,
          });
        });
      },
    );
    this.child = child;
    child.once('spawn', () => {
      this.health.observe(() => {
        this.childToken = identity(child.pid);
        this.save('ss-owner.json', {
          owner: 'passive TLS pressure observer',
          creatorPid: process.pid,
          creatorToken: identity(process.pid),
          state: 'owned',
          pid: child.pid,
          token: this.childToken,
        });
      });
    });
  }
  seal(request) {
    clearInterval(this.timer);
    return this.health.seal(request, (publicationGeneration) => {
      const window = JSON.parse(
        readFileSync(join(this.directory, 'window.json'), 'utf8'),
      );
      const matched =
        [...this.sockets].find(
          ([, row]) =>
            row.remotePort === window.clientPort &&
            row.localPort === window.serverPort,
        ) ?? this.lastTarget;
      if (!matched) throw new Error('No current owned observation');
      const [ws, row] = matched;
      const snapshot = {
        captureId: `${process.pid}:${request.request_id}:${publicationGeneration}`,
        wallMs: Date.now(),
        nodeMonoNs: process.hrtime.bigint().toString(),
        clock: 'Node hrtime/performance; own clock only',
        localPort: row.localPort,
        remotePort: row.remotePort,
        open: row.open,
        wsBufferedAmount: numberFact(ws.bufferedAmount),
        tlsWritableLength: numberFact(ws._socket?.writableLength),
        counts: { ...this.counts.get(row.id) },
        ss: {
          available: false,
          reason:
            'kernel state supplied by last separately timestamped ss tuple',
        },
      };
      if (!this.save('sealed-server.json', snapshot)) this.health.invalidate();
      return snapshot;
    });
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    const child = this.child;
    if (
      child?.pid &&
      this.childToken &&
      identity(child.pid) === this.childToken
    )
      child.kill('SIGTERM');
  }
}
