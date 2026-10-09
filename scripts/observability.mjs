import { developmentEnv } from './lib/process.mjs';
import {
  observabilityEnv,
  observabilityCompose,
  observabilityServices,
  startObservability,
} from './lib/observability.mjs';
const env = observabilityEnv(developmentEnv());
if (process.argv[2] === 'up') await startObservability(env);
else if (process.argv[2] === 'down')
  observabilityCompose(['stop', ...observabilityServices], env);
else if (process.argv[2] === 'validate')
  observabilityCompose(
    [
      'run',
      '--rm',
      '--no-deps',
      'collector',
      'validate',
      '--config=/etc/otel/config.yaml',
    ],
    env,
  );
else throw new Error('Use observability.mjs up, down, or validate');
