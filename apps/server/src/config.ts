import { resolve } from 'node:path';
export function configuration(env: NodeJS.ProcessEnv = process.env) {
  const bind = env.APP_BIND?.match(/^(.*):(\d+)$/);
  const hostname = env.LAB_WORD_HOST ?? bind?.[1] ?? '127.0.0.1';
  const port = Number(env.SERVER_PORT ?? bind?.[2] ?? 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error('SERVER_PORT must be an integer from 1 to 65535');
  if (!hostname || hostname.includes('/') || hostname.includes('\\'))
    throw new Error('LAB_WORD_HOST is invalid');
  const origin = new URL(env.APP_ORIGIN ?? 'http://127.0.0.1:5173');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (
    !(origin.protocol === 'https:' || (origin.protocol === 'http:' && local)) ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  )
    throw new Error(
      'APP_ORIGIN must be an HTTPS origin or loopback HTTP origin',
    );
  const absoluteSecs = Number(env.SESSION_ABSOLUTE_SECS ?? 604800);
  const idleSecs = Number(env.SESSION_IDLE_SECS ?? 86400);
  if (
    !Number.isSafeInteger(absoluteSecs) ||
    absoluteSecs < 60 ||
    absoluteSecs > 2592000
  )
    throw new Error(
      'SESSION_ABSOLUTE_SECS must be an integer from 60 to 2592000',
    );
  if (
    !Number.isSafeInteger(idleSecs) ||
    idleSecs < 60 ||
    idleSecs > absoluteSecs
  )
    throw new Error(
      'SESSION_IDLE_SECS must be an integer from 60 to the absolute lifetime',
    );
  return {
    hostname,
    port,
    auth: {
      origin: origin.origin,
      absoluteSecs,
      idleSecs,
      secureCookie: origin.protocol === 'https:',
    },
    directory: resolve(
      env.LAB_WORD_DATA_DIR ?? env.CONTRACT_DATA_DIRECTORY ?? 'data',
    ),
  };
}
