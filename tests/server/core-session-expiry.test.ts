import { test } from 'node:test';
import { ServerProcess } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';

test(
  'real HTTP idle expiry and actively refreshed absolute expiry reject protected sessions at the configured minimum lifetime',
  { timeout: 120000 },
  async () => {
    const idle = await new ServerProcess().create();
    const absolute = await new ServerProcess().create();
    idle.env = {
      APP_ORIGIN: idle.url,
      SESSION_IDLE_SECS: '60',
      SESSION_ABSOLUTE_SECS: '120',
    };
    absolute.env = {
      APP_ORIGIN: absolute.url,
      SESSION_IDLE_SECS: '60',
      SESSION_ABSOLUTE_SECS: '60',
    };
    try {
      await idle.start();
      await absolute.start();
      const inactive = new CoreHttp(idle.url),
        active = new CoreHttp(absolute.url);
      await inactive.register('idle@example.test');
      await active.register('absolute@example.test');
      const started = performance.now();
      for (let step = 1; step <= 5; step++) {
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.max(0, started + step * 10000 - performance.now()),
          ),
        );
        await active.json('GET', '/api/v1/auth/session');
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, started + 61000 - performance.now())),
      );
      await inactive.error(
        'GET',
        '/api/v1/auth/session',
        undefined,
        401,
        'auth.unauthorized',
      );
      await active.error(
        'GET',
        '/api/v1/auth/session',
        undefined,
        401,
        'auth.unauthorized',
      );
      await inactive.login('idle@example.test');
      await inactive.json('GET', '/api/v1/auth/session');
    } finally {
      await absolute.cleanup();
      await idle.cleanup();
    }
  },
);
