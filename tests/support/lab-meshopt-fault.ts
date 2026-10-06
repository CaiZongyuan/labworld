import { registerHooks } from 'node:module';
let blocked = true;
process.on('message', (message) => {
  if (message === 'restore-codec') {
    blocked = false;
    process.send?.({ stage: 'codec-restored' });
  }
});
process.once('SIGTERM', () => {
  if (process.connected) process.disconnect();
});
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      blocked &&
      specifier.endsWith('/meshopt_decoder.cjs') &&
      context.parentURL?.endsWith('/platform/codecs.ts')
    )
      throw Object.assign(new Error('Owned missing Meshopt module'), {
        code: 'MODULE_NOT_FOUND',
      });
    return nextResolve(specifier, context);
  },
});
await import('../../apps/server/src/main.ts');
