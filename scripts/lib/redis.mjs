import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './process.mjs';

export async function withTestRedis(action) {
  const name = `labos-threejs-cache-test-${process.pid}-${randomUUID().slice(0, 8)}`;
  const compose = JSON.parse(
    execFileSync('docker', ['compose', 'config', '--format', 'json'], {
      cwd: root,
      encoding: 'utf8',
    }),
  );
  let started = false;
  try {
    execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '-d',
        '--name',
        name,
        '-p',
        '127.0.0.1::6379',
        compose.services.redis.image,
        'redis-server',
        '--save',
        '',
        '--appendonly',
        'no',
        '--maxmemory',
        '64mb',
        '--maxmemory-policy',
        'noeviction',
      ],
      { stdio: 'pipe' },
    );
    started = true;
    const deadline = Date.now() + 30_000;
    while (
      spawnSync('docker', ['exec', name, 'redis-cli', '-e', 'PING'], {
        stdio: 'ignore',
        timeout: 2000,
      }).status !== 0
    ) {
      if (Date.now() >= deadline)
        throw new Error('Isolated Redis did not become ready');
      await delay(100);
    }
    const port = execFileSync('docker', ['port', name, '6379/tcp'], {
      encoding: 'utf8',
    })
      .trim()
      .split(':')
      .at(-1);
    await action({ name, env: { REDIS_URL: `redis://127.0.0.1:${port}/` } });
  } finally {
    if (started)
      execFileSync('docker', ['rm', '-f', '-v', name], {
        stdio: 'ignore',
        timeout: 10_000,
      });
  }
}
