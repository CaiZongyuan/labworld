import { registerHooks } from 'node:module';
const facade = new URL('./lab-codec-fault-fs.ts', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === 'node:fs/promises' &&
      context.parentURL?.endsWith('/platform/codecs.ts')
    )
      return { url: facade, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
await import('../../apps/server/src/main.ts');
