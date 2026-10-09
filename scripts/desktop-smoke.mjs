import { randomUUID } from 'node:crypto';
import { withDesktopStack, runDesktopTests } from './desktop-stack.mjs';

/**
 * Electron shell smoke: boots the real stack (PostgreSQL, RustFS, Redis,
 * Mailpit, API, Web) and drives the packaged shell against it. This is the
 * GUI smoke behind `just desktop-smoke`; the default `just check` only runs
 * type, build and IPC contract checks for the shell.
 */

const smokeEmail = 'desktop-smoke@example.test';
const smokePassword = 'desktop-smoke-password';
const documentTitle = '桌面壳冒烟文档';
const documentMarker = `桌面壳预览标记 ${Date.now()}`;

async function registerSmokeUser(apiUrl, webOrigin) {
  const response = await fetch(`${apiUrl}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: webOrigin },
    body: JSON.stringify({ email: smokeEmail, password: smokePassword }),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 201)
    throw new Error(`Could not register the smoke user: ${response.status}`);
  const cookie = response.headers.getSetCookie()[0]?.split(';')[0];
  const { csrf_token: csrfToken } = await response.json();
  if (!cookie || !csrfToken)
    throw new Error('Register did not return a session cookie and CSRF token');
  return { cookie, csrfToken };
}

async function createSmokeDocument(apiUrl, webOrigin, session) {
  const response = await fetch(`${apiUrl}/api/v1/knowledge/documents`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: webOrigin,
      cookie: session.cookie,
      'x-csrf-token': session.csrfToken,
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify({
      title: documentTitle,
      markdown: `# ${documentTitle}\n\n${documentMarker}\n`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 201)
    throw new Error(`Could not create the smoke document: ${response.status}`);
}

await withDesktopStack(
  {
    cachePrefix: 'desktop-smoke',
    seed: async ({ env, webOrigin }) => {
      const session = await registerSmokeUser(env.E2E_API_URL, webOrigin);
      await createSmokeDocument(env.E2E_API_URL, webOrigin, session);
    },
  },
  async ({ env, downloadsDir }) => {
    const specEnv = {
      ...env,
      DESKTOP_SMOKE_EMAIL: smokeEmail,
      DESKTOP_SMOKE_PASSWORD: smokePassword,
      DESKTOP_SMOKE_DOCUMENT_TITLE: documentTitle,
      DESKTOP_SMOKE_DOCUMENT_MARKER: documentMarker,
      LABOS_THREEJS_DESKTOP_DOWNLOADS_DIR: downloadsDir,
    };
    runDesktopTests(specEnv, 'tests/desktop/playwright.config.ts');
  },
);
console.log('desktop shell smoke passed');
