import { execFile } from 'node:child_process';
import { readFile, readlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// The host-side listeners of a local dev stack: API and Worker binds from
// the environment plus the strict-port Vite web server (see vite.config).
export function devPortTargets(env) {
  return [
    bindTarget('API', env.APP_BIND),
    bindTarget('Worker', env.WORKER_BIND),
    { name: 'Web', host: '127.0.0.1', port: Number(env.WEB_PORT ?? 5173) },
  ].filter(Boolean);
}

function bindTarget(name, bind) {
  const at = String(bind ?? '').lastIndexOf(':');
  if (at === -1) return null;
  return {
    name,
    host: bind.slice(0, at).replace(/^\[|\]$/g, ''),
    port: Number(bind.slice(at + 1)),
  };
}

// Resolve true when something accepts TCP connections on host:port.
export function isPortListening(host, port, timeoutMs = 1_000) {
  return new Promise((resolve) => {
    const socket = connect(port, host);
    const finish = (listening) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

// Dev targets currently held by a listener.
export async function busyDevPorts(env) {
  const busy = [];
  for (const target of devPortTargets(env)) {
    if (await isPortListening(target.host, target.port)) busy.push(target);
  }
  return busy;
}

// Map each given port to the PIDs listening on it. PIDs come from ss
// (Linux) or lsof (macOS); ports nobody listens on map to an empty set.
export async function listeningPids(ports) {
  const byPort = new Map(ports.map((port) => [Number(port), new Set()]));
  for (const { port, pid } of await listeners()) {
    byPort.get(port)?.add(pid);
  }
  return byPort;
}

async function listeners() {
  if (process.platform === 'darwin') {
    let stdout;
    try {
      ({ stdout } = await execFileAsync('lsof', [
        '-nP',
        '-iTCP',
        '-sTCP:LISTEN',
      ]));
    } catch (error) {
      if (error.code === 'ENOENT')
        throw new Error('`lsof` is required to find processes on ports.', {
          cause: error,
        });
      if (error.code === 1) return []; // lsof exits 1 when nothing matches
      throw error;
    }
    return stdout
      .trim()
      .split('\n')
      .slice(1)
      .filter(Boolean)
      .map((line) => {
        const fields = line.trim().split(/\s+/);
        return {
          port: Number(fields[8].split(':').pop()),
          pid: Number(fields[1]),
        };
      });
  }
  if (process.platform !== 'linux') {
    throw new Error(
      `Finding processes on ports is not supported on ${process.platform}.`,
    );
  }
  let stdout;
  try {
    ({ stdout } = await execFileAsync('ss', ['-tlnpH']));
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new Error(
        '`ss` (iproute2) is required to find processes on ports.',
        { cause: error },
      );
    throw error;
  }
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const port = Number(line.split(/\s+/)[3].split(':').pop());
      return [...line.matchAll(/pid=(\d+)/g)].map((match) => ({
        port,
        pid: Number(match[1]),
      }));
    });
}

// A port alone says nothing about ownership. Require both this worktree's
// cwd and the corresponding dev executable; unreadable processes stay alive.
export async function isWorktreeDevProcess(pid, target, root) {
  try {
    const { cwd, executable, vite } = await processDetails(pid);
    if (target.name === 'Web') {
      return (
        cwd === join(root, 'apps/web') &&
        ['node', 'nodejs'].includes(basename(executable)) &&
        vite
      );
    }
    const binary = {
      API: 'labos-threejs-api',
      Worker: 'labos-threejs-worker',
    }[target.name];
    return cwd === root && basename(executable) === binary;
  } catch {
    return false;
  }
}

async function processDetails(pid) {
  if (process.platform === 'linux') {
    const [cwd, executable, command] = await Promise.all([
      readlink(`/proc/${pid}/cwd`),
      readlink(`/proc/${pid}/exe`),
      readFile(`/proc/${pid}/cmdline`, 'utf8'),
    ]);
    return {
      cwd,
      executable: executable.replace(/ \(deleted\)$/, ''),
      vite: /\/(?:vite\/bin\/vite\.js|\.bin\/vite)$/.test(
        command.split('\0')[1] ?? '',
      ),
    };
  }
  if (process.platform === 'darwin') {
    const [directory, executable, command] = await Promise.all([
      execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']),
      execFileAsync('ps', ['-p', String(pid), '-o', 'comm=']),
      execFileAsync('ps', ['-ww', '-p', String(pid), '-o', 'args=']),
    ]);
    return {
      cwd: directory.stdout
        .split('\n')
        .find((line) => line.startsWith('n'))
        ?.slice(1),
      executable: executable.stdout.trim(),
      vite: /^(?:.*\/)?node(?:js)?\s+.+\/(?:vite\/bin\/vite\.js|\.bin\/vite)(?:\s|$)/.test(
        command.stdout.trim(),
      ),
    };
  }
  return {};
}

// Signal a process, tolerating one that already exited.
export function signalPid(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
