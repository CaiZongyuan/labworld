// Test-only actual filesystem partial-write/kill boundary; production has no flag.
import { registerHooks } from 'node:module';
const facade = new URL('./signing-key-fault-fs.ts', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === 'node:fs/promises' &&
      context.parentURL?.endsWith('/core/files/use-cases.ts')
    )
      return { url: facade, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { FileService } =
  await import('../../packages/server/src/core/files/use-cases.ts');
const { Database } =
  await import('../../packages/server/src/platform/db/index.ts');
const { DirectoryLease } =
  await import('../../packages/server/src/platform/db/lease.ts');
const { configuration } = await import('../../apps/server/src/config.ts');
const config = configuration();
const lease = await DirectoryLease.acquire(config.directory);
try {
  await new FileService(
    { db: new Database(), clock: { now: () => new Date().toISOString() } },
    config.files,
    config.auth,
    config.fileOrigin,
    config.directory,
  ).initialize();
} catch {
  process.send?.({ stage: 'owned-write-failed' });
  process.exitCode = 1;
} finally {
  await lease.release();
  if (process.connected) process.disconnect();
}
