import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './process.mjs';
export async function withTestMailpit(action, resource) {
  const name = `labos-threejs-mail-test-${process.pid}-${randomUUID().slice(0, 8)}`;
  const compose = JSON.parse(
    execFileSync('docker', ['compose', 'config', '--format', 'json'], {
      cwd: root,
      encoding: 'utf8',
    }),
  );
  const labels = resource?.plan(name, 'mail') ?? [];
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
        'MP_ENABLE_CHAOS=true',
        '-p',
        '127.0.0.1::1025',
        '-p',
        '127.0.0.1::8025',
        compose.services.mailpit.image,
      ],
      { stdio: 'pipe' },
    );
    started = true;
    resource?.started(name);
    const deadline = Date.now() + 30_000;
    while (
      spawnSync('docker', ['exec', name, '/mailpit', 'readyz'], {
        stdio: 'ignore',
        timeout: 2000,
      }).status !== 0
    ) {
      if (Date.now() >= deadline)
        throw new Error('Isolated Mailpit did not become ready');
      await delay(100);
    }
    const port = (target) =>
      execFileSync('docker', ['port', name, `${target}/tcp`], {
        encoding: 'utf8',
      })
        .trim()
        .split(':')
        .at(-1);
    await action({
      name,
      env: {
        MAIL_SMTP_HOST: '127.0.0.1',
        MAIL_SMTP_PORT: port(1025),
        MAIL_SMTP_TLS: 'local',
        MAIL_SMTP_USERNAME: '',
        MAIL_SMTP_PASSWORD: '',
        MAIL_FROM: 'noreply@example.test',
        MAIL_TIMEOUT_SECS: '3',
        MAIL_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
        MAIL_ENCRYPTION_KEY_VERSION: '1',
        MAILPIT_HTTP_URL: `http://127.0.0.1:${port(8025)}`,
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
