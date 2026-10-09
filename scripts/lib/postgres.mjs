import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './process.mjs';

export async function withTestPostgres(action) {
  const name = `labos-threejs-test-${process.pid}-${randomUUID().slice(0, 8)}`;
  const config = JSON.parse(
    execFileSync('docker', ['compose', 'config', '--format', 'json'], {
      cwd: root,
      encoding: 'utf8',
    }),
  );
  const image = config.services.postgres.image;
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
        '-e',
        'POSTGRES_PASSWORD=test-only-password',
        '-e',
        'POSTGRES_DB=labos_threejs_test',
        '-p',
        '127.0.0.1::5432',
        image,
        'postgres',
        '-c',
        'shared_preload_libraries=pg_stat_statements',
        '-c',
        'pg_stat_statements.track=top',
        '-c',
        'pg_stat_statements.track_utility=on',
        '-c',
        'pg_stat_statements.max=100000',
      ],
      { stdio: 'pipe' },
    );
    started = true;
    const deadline = Date.now() + 30_000;
    while (
      spawnSync(
        'docker',
        [
          'exec',
          name,
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-U',
          'postgres',
          '-d',
          'labos_threejs_test',
        ],
        { stdio: 'ignore', timeout: 5_000 },
      ).status !== 0
    ) {
      if (Date.now() >= deadline)
        throw new Error('Isolated PostgreSQL did not become ready');
      await delay(150);
    }
    execFileSync(
      'docker',
      [
        'exec',
        name,
        'psql',
        '-U',
        'postgres',
        '-d',
        'labos_threejs_test',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        'CREATE EXTENSION pg_stat_statements',
      ],
      { stdio: 'pipe', timeout: 10_000 },
    );
    const mapping = execFileSync('docker', ['port', name, '5432/tcp'], {
      encoding: 'utf8',
    }).trim();
    const port = mapping.split(':').at(-1);
    const url = `postgres://postgres:test-only-password@127.0.0.1:${port}/labos_threejs_test`;
    await action({ name, url });
  } finally {
    if (started)
      execFileSync('docker', ['rm', '-f', '-v', name], {
        stdio: 'ignore',
        timeout: 10_000,
      });
  }
}
