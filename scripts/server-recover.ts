import { recoverServerResources } from '../tests/support/server-resources.ts';
if (process.argv.length !== 3)
  throw new Error(
    'Usage: node --experimental-strip-types scripts/server-recover.ts <owned-resources.json>',
  );
console.log(
  JSON.stringify(await recoverServerResources(process.argv[2]), null, 2),
);
