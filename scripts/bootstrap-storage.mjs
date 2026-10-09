import { developmentEnv, run } from './lib/process.mjs';

run(
  'cargo',
  ['run', '--locked', '-p', 'labos-threejs-api', '--bin', 'bootstrap-storage'],
  developmentEnv(),
);
