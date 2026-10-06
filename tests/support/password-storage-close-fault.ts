// Test-only external driver wrapper; production CLI and business SQL are unchanged.
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(
  new URL('../../packages/server/package.json', import.meta.url),
);
process.env.OWNED_CLOSE_DRIVER_URL = pathToFileURL(
  require.resolve('@electric-sql/pglite'),
).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@electric-sql/pglite')
      return {
        url: new URL('./password-close-driver.ts', import.meta.url).href,
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
await import('../../apps/server/src/reset-password.ts');
