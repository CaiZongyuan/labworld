import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, win32 } from 'node:path';

const python = process.platform === 'win32' ? 'python' : 'python3';
const version = spawnSync(python, ['--version'], { encoding: 'utf8' });
const pythonVersion =
  /^Python (\d+\.\d+\.\d+)\s*$/.exec(
    version.stdout || version.stderr || '',
  )?.[1] ?? null;
const search =
  process.platform === 'win32'
    ? spawnSync('where.exe', ['python'], { encoding: 'utf8' })
    : spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' });
const paths =
  search.status === 0
    ? search.stdout.trim().split(/\r?\n/).filter(Boolean)
    : [];
const resolved = paths[0] ?? '';
const executable =
  process.platform === 'win32' ? win32.basename(resolved) : basename(resolved);
const locationKind = /[\\/]hostedtoolcache[\\/]/i.test(resolved)
  ? 'hosted-toolcache'
  : /[\\/]WindowsApps[\\/]/i.test(resolved)
    ? 'windows-app-alias'
    : /[\\/]chocolatey[\\/]bin[\\/]/i.test(resolved)
      ? 'chocolatey-shim'
      : process.platform !== 'win32' && resolved.startsWith('/usr/bin/')
        ? 'system-bin'
        : resolved
          ? 'other'
          : 'unresolved';
const pnpm =
  process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/c', 'pnpm --version'], { encoding: 'utf8' })
    : spawnSync('sh', ['-c', 'pnpm --version'], { encoding: 'utf8' });
const pnpmVersion =
  pnpm.status === 0 && /^\d+\.\d+\.\d+$/.test(pnpm.stdout.trim())
    ? pnpm.stdout.trim()
    : null;
const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const receipt = {
  purpose:
    'Windows source-client diagnostic environment; local collection is not Windows validation',
  at: new Date().toISOString(),
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  expectedNode: (await readFile('.node-version', 'utf8')).trim(),
  pnpm: pnpmVersion,
  python: {
    command: python,
    available: version.status === 0,
    version: pythonVersion,
    exitCode: version.status,
    pathProjection: {
      candidates: paths.length,
      executable: /^python(?:3(?:\.\d+)?)?(?:\.exe)?$/i.test(executable)
        ? executable
        : executable
          ? 'other'
          : null,
      locationKind,
    },
  },
  commit: /^[a-f0-9]{40}$/.test(revision) ? revision : null,
  workflowEvent:
    process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
      ? 'workflow_dispatch'
      : null,
  expectedRunner: 'windows-2025',
  originalDurationSeconds: 2,
  originalOnlineDeadlineMs: 7000,
};
await mkdir('.scratch/source-client-windows', { recursive: true });
await writeFile(
  '.scratch/source-client-windows/environment.json',
  JSON.stringify(receipt, null, 2) + '\n',
);
console.log(JSON.stringify(receipt));
