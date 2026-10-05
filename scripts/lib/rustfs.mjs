import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './process.mjs';

export async function withTestRustfs(action, resource) {
  const name = `labos-threejs-storage-test-${process.pid}-${randomUUID().slice(0, 8)}`;
  const compose = JSON.parse(
    execFileSync('docker', ['compose', 'config', '--format', 'json'], {
      cwd: root,
      encoding: 'utf8',
    }),
  );
  const labels = resource?.plan(name, 'storage') ?? [];
  let started = false;
  try {
    execFileSync(
      'docker',
      [
        'run',
        ...labels,
        '--rm',
        '-d',
        '--name',
        name,
        '-e',
        'RUSTFS_ACCESS_KEY=test-access',
        '-e',
        'RUSTFS_SECRET_KEY=test-only-storage-secret',
        '-e',
        'RUSTFS_CONSOLE_ENABLE=false',
        '-e',
        'RUSTFS_REGION=us-east-1',
        '-e',
        'RUST_LOG=warn',
        '-p',
        '127.0.0.1::9000',
        compose.services.rustfs.image,
        'rustfs',
        '/data',
      ],
      { stdio: 'pipe' },
    );
    started = true;
    resource?.started(name);
    const port = execFileSync('docker', ['port', name, '9000/tcp'], {
      encoding: 'utf8',
    })
      .trim()
      .split(':')
      .at(-1);
    const endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        ready = (
          await fetch(`${endpoint}/health/ready`, {
            signal: AbortSignal.timeout(2000),
          })
        ).ok;
      } catch {
        /* container is starting */
      }
      if (ready) break;
      await delay(250);
    }
    if (!ready) throw new Error('Isolated RustFS did not become ready');
    await action({
      name,
      env: {
        S3_ENDPOINT: endpoint,
        S3_PUBLIC_ENDPOINT: endpoint,
        S3_REGION: 'us-east-1',
        S3_ACCESS_KEY: 'test-access',
        S3_SECRET_KEY: 'test-only-storage-secret',
        S3_BUCKET: `test-${randomUUID()}`,
      },
    });
  } finally {
    if (started) {
      if (resource) resource.remove(name);
      else
        execFileSync('docker', ['rm', '-f', '-v', name], {
          stdio: 'ignore',
          timeout: 10_000,
        });
    }
  }
}
