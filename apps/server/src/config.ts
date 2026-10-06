import { resolve } from 'node:path';
export function configuration(env: NodeJS.ProcessEnv = process.env) {
  const bind = env.APP_BIND?.match(/^(.*):(\d+)$/);
  const hostname = env.LAB_WORD_HOST ?? bind?.[1] ?? '127.0.0.1';
  const port = Number(env.SERVER_PORT ?? bind?.[2] ?? 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error('SERVER_PORT must be an integer from 1 to 65535');
  if (!hostname || hostname.includes('/') || hostname.includes('\\'))
    throw new Error('LAB_WORD_HOST is invalid');
  return {
    hostname,
    port,
    directory: resolve(
      env.LAB_WORD_DATA_DIR ?? env.CONTRACT_DATA_DIRECTORY ?? 'data',
    ),
  };
}
