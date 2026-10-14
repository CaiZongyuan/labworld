import type { ChildProcess } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ProcessIdentity } from './server-resources.ts';

const states = new Set([
  'offline',
  'configuration_failed',
  'connected',
  'authorization_failed',
  'connection_conflict',
  'stopped',
]);
const phases = new Set(['initializing', 'ready']);
const reasons = new Set([
  'invalid_configuration',
  'access_denied',
  'connection_rejected',
  'connection_unavailable',
]);
const signals = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT']);

/** Diagnostic branch only: retain closed status values, never raw child output. */
export class SourceClientDiagnostic {
  private evidence: string;
  private started = performance.now();
  private identityAt = 0;
  private pending = '';
  private facts: Record<string, unknown> = {
    scope: 'Original Windows normal Python source case; observation only',
    statuses: [],
    stdoutBytes: 0,
    stderrBytes: 0,
    discardedLines: 0,
    observations: [],
    writesFailed: 0,
    elapsedReference:
      'Node observation after fixture creation; not Python emission time',
    httpScope:
      'Normalized Source route in this isolated single-Source case; not exact UUID attribution',
  };
  constructor(evidence: string) {
    this.evidence = evidence;
  }
  private time() {
    return {
      at: new Date().toISOString(),
      elapsedMs: performance.now() - this.started,
    };
  }
  async files(config: string) {
    const metadata = async (path: string) => {
      try {
        const file = await stat(path);
        return { exists: true, isFile: file.isFile(), bytes: file.size };
      } catch {
        return { exists: false, isFile: false, bytes: null };
      }
    };
    const [script, configuration] = await Promise.all([
      metadata('tools/source-client/presence.py'),
      metadata(config),
    ]);
    this.facts.files = { script, configuration };
  }
  launching() {
    this.facts.launchRequested = this.time();
  }
  launched(child: ChildProcess) {
    child.once('spawn', () => {
      this.facts.spawned = { ...this.time(), pid: child.pid };
    });
    child.once('exit', (code, signal) => {
      this.facts.exited = {
        ...this.time(),
        code,
        signal: signal === null || signals.has(signal) ? signal : 'other',
      };
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      this.facts.launchError = {
        ...this.time(),
        code: ['ENOENT', 'EACCES', 'EINVAL'].includes(error.code ?? '')
          ? error.code
          : 'other',
      };
    });
  }
  output(bytes: Buffer, channel: 'stdout' | 'stderr') {
    this.facts[channel + 'Bytes'] =
      Number(this.facts[channel + 'Bytes']) + bytes.byteLength;
    if (channel === 'stderr') return;
    this.pending += String(bytes);
    const lines = this.pending.split('\n');
    this.pending = lines.pop()!;
    if (this.pending.length > 8192) {
      this.pending = '';
      this.facts.discardedLines = Number(this.facts.discardedLines) + 1;
    }
    for (const line of lines) {
      try {
        const value = JSON.parse(line);
        if (
          !states.has(value?.state) ||
          !phases.has(value?.phase) ||
          !(value.reason === null || reasons.has(value.reason))
        )
          throw new Error('Unrecognized status');
        const statuses = this.facts.statuses as unknown[];
        if (statuses.length < 32)
          statuses.push({
            ...this.time(),
            state: value.state,
            phase: value.phase,
            reason: value.reason,
          });
      } catch {
        this.facts.discardedLines = Number(this.facts.discardedLines) + 1;
      }
    }
  }
  identityStarted() {
    const time = this.time();
    this.identityAt = time.elapsedMs;
    this.facts.identityStarted = time;
  }
  identityCompleted(identity: ProcessIdentity | undefined) {
    const time = this.time();
    this.facts.identityCompleted = {
      ...time,
      durationMs: time.elapsedMs - this.identityAt,
      present: !!identity,
      pid: identity?.pid ?? null,
      pythonExecutable: identity
        ? /^python(?:3(?:\.\d+)?)?(?:\.exe)?$/i.test(
            basename(identity.executable),
          )
        : null,
    };
  }
  observe(stage: string, child?: ChildProcess) {
    (this.facts.observations as unknown[]).push({
      ...this.time(),
      stage,
      exitCode: child?.exitCode ?? null,
      signalCode:
        !child?.signalCode || signals.has(child.signalCode)
          ? (child?.signalCode ?? null)
          : 'other',
    });
  }
  async save(
    verdict: 'failed' | 'passed',
    stage: string,
    child?: ChildProcess,
  ) {
    this.observe(stage, child);
    this.facts.verdict = verdict;
    try {
      await writeFile(
        join(this.evidence, 'source-client-diagnostic.json'),
        JSON.stringify(this.facts, null, 2) + '\n',
      );
    } catch {
      this.facts.writesFailed = Number(this.facts.writesFailed) + 1;
    }
  }
  async cleanup(verdict: 'failed' | 'passed', child?: ChildProcess) {
    const requests: Record<string, unknown>[] = [];
    try {
      for (const line of (
        await readFile(join(this.evidence, 'server.log'), 'utf8')
      ).split('\n')) {
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        if (value.event !== 'http.request' || typeof value.path !== 'string')
          continue;
        const route =
          /^\/api\/v1\/lab\/labs\/:id\/sources\/:id(\/(?:connections|heartbeat|disconnect))?$/.exec(
            value.path,
          );
        if (!route) continue;
        const suffix = route[1] ?? '';
        if (
          !['GET', 'POST'].includes(value.method) ||
          !Number.isInteger(value.status) ||
          !Number.isFinite(value.duration_ms)
        )
          continue;
        requests.push({
          kind: suffix === '' ? 'source-read' : suffix.slice(1),
          method: value.method,
          status: value.status,
          durationMs: value.duration_ms,
        });
      }
      this.facts.completedHttpRequests = requests;
    } catch {
      this.facts.httpProjectionUnavailable = true;
    }
    await this.save(verdict, 'after-cleanup', child);
  }
}
