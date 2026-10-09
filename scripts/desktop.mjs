import { developmentEnv, run } from './lib/process.mjs';

// Launch the Electron shell against a running dev web entry (`just dev`).
// The shell loads the same-origin entry, so it follows the web port from the
// development environment unless LABOS_THREEJS_DESKTOP_ORIGIN says otherwise.
const env = developmentEnv();
if (!process.env.LABOS_THREEJS_DESKTOP_ORIGIN) {
  env.LABOS_THREEJS_DESKTOP_ORIGIN = `http://127.0.0.1:${env.WEB_PORT ?? 5173}`;
}
run('pnpm', ['--filter', '@labos-threejs/desktop', 'start'], env);
