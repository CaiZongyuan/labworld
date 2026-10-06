const actual = await import('node:fs/promises');
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
export async function readFile(...args: Parameters<typeof actual.readFile>) {
  if (blocked && String(args[0]).endsWith('/validation.wasm')) {
    process.send?.({ stage: 'codec-read-refused' });
    return actual.readFile(
      new URL('./owned-missing-codec-fixture', import.meta.url),
    );
  }
  return actual.readFile(...args);
}
