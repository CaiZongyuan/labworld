import { resolve } from 'node:path';
import { defaultRateOptions } from '../../../packages/server/src/core/rate-limit/domain.ts';
import { defaultFilePolicy } from '../../../packages/server/src/core/files/domain.ts';
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
  const rate = { ...defaultRateOptions };
  if (env.RATE_LIMIT_ENABLED !== undefined) {
    if (!['true', 'false'].includes(env.RATE_LIMIT_ENABLED))
      throw new Error('RATE_LIMIT_ENABLED must be true or false');
    rate.enabled = env.RATE_LIMIT_ENABLED === 'true';
  }
  const settings = [
    ['RATE_LIMIT_WINDOW_SECS', 'windowSecs', 1, 3600],
    ['RATE_LIMIT_MAX_LOCAL_ENTRIES', 'capacity', 1, 100000],
    ['RATE_LIMIT_REGISTRATION', 'registration', 1, 1000000],
    ['RATE_LIMIT_REGISTRATION_FALLBACK', 'registrationFallback', 1, 1000000],
    ['RATE_LIMIT_AUTHENTICATION', 'authentication', 1, 1000000],
    [
      'RATE_LIMIT_AUTHENTICATION_FALLBACK',
      'authenticationFallback',
      1,
      1000000,
    ],
    ['RATE_LIMIT_RESOURCE', 'resource', 1, 1000000],
    ['RATE_LIMIT_RESOURCE_FALLBACK', 'resourceFallback', 1, 1000000],
  ] as const;
  for (const [name, key, min, max] of settings) {
    const value = Number(env[name] ?? rate[key]);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`${name} is invalid`);
    rate[key] = value;
  }
  for (const policy of ['registration', 'authentication', 'resource'] as const)
    if (rate[`${policy}Fallback`] > rate[policy])
      throw new Error(`${policy} overflow capacity exceeds its primary limit`);
  const files = { ...defaultFilePolicy };
  for (const [name, key, max] of [
    ['FILE_MAX_BYTES', 'maxBytes', 104857600],
    ['UPLOAD_SESSION_SECS', 'uploadSecs', 3600],
    ['DOWNLOAD_URL_SECS', 'downloadSecs', 300],
  ] as const) {
    const value = Number(env[name] ?? files[key]);
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new Error(`${name} is invalid`);
    files[key] = value;
  }
  const fileOrigin = new URL(env.FILE_PUBLIC_ORIGIN ?? origin.origin);
  if (
    !(
      fileOrigin.protocol === 'https:' ||
      (fileOrigin.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(fileOrigin.hostname))
    ) ||
    fileOrigin.pathname !== '/' ||
    fileOrigin.search ||
    fileOrigin.hash ||
    fileOrigin.username ||
    fileOrigin.password
  )
    throw new Error(
      'FILE_PUBLIC_ORIGIN must be an HTTPS origin or loopback HTTP origin',
    );
  return {
    hostname,
    port,
    rate,
    files,
    fileOrigin: fileOrigin.origin,
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
