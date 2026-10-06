import { reconcileDevelopmentResources } from '../tests/support/server-resources.ts';
if (process.argv.length !== 3)
  throw new Error(
    'Usage: node --experimental-strip-types scripts/server-dev-recover.ts <development-owned-resources.json>',
  );
console.log(
  JSON.stringify(await reconcileDevelopmentResources(process.argv[2]), null, 2),
);
