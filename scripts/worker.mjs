import { developmentEnv, run } from './lib/process.mjs';
run(
  'cargo',
  ['run', '--locked', '-p', 'labos-threejs-worker'],
  developmentEnv(),
);
