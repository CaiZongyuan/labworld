const actual = await import('node:fs/promises');
export const mkdir = actual.mkdir,
  readFile = actual.readFile,
  link = actual.link,
  rm = actual.rm;
export async function open(...args: Parameters<typeof actual.open>) {
  const handle = await actual.open(...args);
  if (String(args[0]).includes('file-signing-key')) {
    handle.writeFile = async (value) => {
      await handle.write(Buffer.from(value as Uint8Array).subarray(0, 7));
      process.send?.({ stage: 'partial-key-written' });
      if (process.env.OWNED_SIGNING_KEY_FAULT === 'kill')
        await new Promise<void>(() => {});
      await actual.readFile(String(args[0]) + '.owned-missing-fault');
    };
  }
  return handle;
}
