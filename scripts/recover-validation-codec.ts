import { resolve } from 'node:path';
import { recoverCodec } from './lib/validation-codec-resources.ts';
if (process.platform !== 'linux')
  throw new Error('Optional codec build recovery currently supports Linux');
const ledger = await recoverCodec(resolve(process.argv[2] ?? ''));
console.log(
  JSON.stringify({
    event: 'm3a.codec-recovered',
    runId: ledger.runId,
    state: ledger.state,
    remainingConsumers: 0,
  }),
);
