import { registerHooks } from 'node:module';
const facade = new URL('./lab-native-trap-codecs.ts', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.endsWith('/platform/codecs.ts') &&
      context.parentURL?.endsWith('/lab/assets/validation.ts')
    )
      return { url: facade, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
let release!: () => void,
  blocked = true,
  unsafeCalls = 0;
const admitted = new Promise<void>((resolve) => {
  release = resolve;
});
process.once('owned-codec-pair-admitted', release);
const wasm = WebAssembly as unknown as {
  instantiate: (
    source: BufferSource | WebAssembly.Module,
    imports?: WebAssembly.Imports,
  ) => Promise<{ instance: WebAssembly.Instance; module: WebAssembly.Module }>;
};
const actual = wasm.instantiate.bind(WebAssembly);
wasm.instantiate = async (source, imports) => {
  const result = await actual(source, imports);
  if (!result?.instance?.exports?.validate_glb_structure) return result;
  await admitted;
  const api = { ...result.instance.exports };
  let trapped = false;
  for (const [name, entry] of Object.entries(api))
    if (typeof entry === 'function')
      api[name] = (...args: unknown[]) => {
        if (trapped) unsafeCalls++;
        if (name === 'validate_glb_structure' && blocked) {
          trapped = true;
          throw new WebAssembly.RuntimeError('Owned tiny native trap');
        }
        return entry(...args);
      };
  return {
    ...result,
    instance: { exports: api } as unknown as WebAssembly.Instance,
  };
};
process.on('message', (message) => {
  if (message === 'native-status')
    process.send?.({ stage: 'native-status', unsafeCalls });
  if (message === 'restore-native') {
    blocked = false;
    process.send?.({ stage: 'native-restored' });
  }
});
process.once('SIGTERM', () => {
  if (process.connected) process.disconnect();
});
await import('../../apps/server/src/main.ts');
