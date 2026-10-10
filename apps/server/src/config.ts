import { defaultRetention } from '../../../packages/server/src/lab/history/domain.ts';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRateOptions } from '../../../packages/server/src/core/rate-limit/domain.ts';
import { defaultFilePolicy } from '../../../packages/server/src/core/files/domain.ts';
const rateFields = [
  ['RATE_LIMIT_WINDOW_SECS', 'windowSecs', 1, 3600],
  ['RATE_LIMIT_MAX_LOCAL_ENTRIES', 'capacity', 1, 100000],
  ['RATE_LIMIT_REGISTRATION', 'registration', 1, 1000000],
  ['RATE_LIMIT_REGISTRATION_FALLBACK', 'registrationFallback', 1, 1000000],
  ['RATE_LIMIT_AUTHENTICATION', 'authentication', 1, 1000000],
  ['RATE_LIMIT_AUTHENTICATION_FALLBACK', 'authenticationFallback', 1, 1000000],
  ['RATE_LIMIT_RESOURCE', 'resource', 1, 1000000],
  ['RATE_LIMIT_RESOURCE_FALLBACK', 'resourceFallback', 1, 1000000],
] as const;
const fileFields = [
  ['FILE_MAX_BYTES', 'maxBytes', 104857600],
  ['UPLOAD_SESSION_SECS', 'uploadSecs', 3600],
  ['DOWNLOAD_URL_SECS', 'downloadSecs', 300],
] as const;
export function configuration(env: NodeJS.ProcessEnv = process.env) {
  const bind = env.APP_BIND?.match(/^(.*):(\d+)$/);
  const hostname = env.LAB_WORD_HOST ?? bind?.[1] ?? '127.0.0.1';
  const motionFixture = env.LAB_WORD_MOTION_FIXTURE === 'true';
  if (
    env.LAB_WORD_MOTION_FIXTURE !== undefined &&
    !['true', 'false'].includes(env.LAB_WORD_MOTION_FIXTURE)
  )
    throw new Error('LAB_WORD_MOTION_FIXTURE must be true or false');
  if (motionFixture && !['127.0.0.1', '::1', 'localhost'].includes(hostname))
    throw new Error('Motion fixture requires a loopback LAB_WORD_HOST');
  const syntheticSession = env.LAB_WORD_SYNTHETIC_SESSION === 'true';
  if (
    env.LAB_WORD_SYNTHETIC_SESSION !== undefined &&
    !['true', 'false'].includes(env.LAB_WORD_SYNTHETIC_SESSION)
  )
    throw new Error('LAB_WORD_SYNTHETIC_SESSION must be true or false');
  if (syntheticSession && !['127.0.0.1', '::1', 'localhost'].includes(hostname))
    throw new Error(
      'Development synthetic Sessions require a loopback LAB_WORD_HOST',
    );
  const motionGraceMillis = Number(env.LAB_WORD_MOTION_GRACE_MS ?? 5000);
  const motionAckMillis = Number(env.LAB_WORD_MOTION_ACK_MS ?? 3000);
  for (const [name, value] of [
    ['LAB_WORD_MOTION_GRACE_MS', motionGraceMillis],
    ['LAB_WORD_MOTION_ACK_MS', motionAckMillis],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 1000 || value > 60000)
      throw new Error(name + ' must be an integer from 1000 to 60000');
  const syntheticPython = env.LAB_WORD_SYNTHETIC_PYTHON ?? 'python3';
  const syntheticPublisher = env.LAB_WORD_SYNTHETIC_PUBLISHER
    ? resolve(env.LAB_WORD_SYNTHETIC_PUBLISHER)
    : fileURLToPath(
        new URL(
          '../../../tools/synthetic-motion/publisher.py',
          import.meta.url,
        ),
      );
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
  for (const [name, key, min, max] of rateFields) {
    const value = Number(env[name] ?? rate[key]);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`${name} is invalid`);
    rate[key] = value;
  }
  for (const policy of ['registration', 'authentication', 'resource'] as const)
    if (rate[`${policy}Fallback`] > rate[policy])
      throw new Error(`${policy} overflow capacity exceeds its primary limit`);
  const files = { ...defaultFilePolicy };
  for (const [name, key, max] of fileFields) {
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
  const retention = { ...defaultRetention };
  for (const [name, key] of [
    ['LAB_OBSERVATION_RETENTION_SECS', 'observation_seconds'],
    ['LAB_RECORD_RETENTION_SECS', 'record_seconds'],
  ] as const) {
    const value = Number(env[name] ?? retention[key]);
    if (!Number.isSafeInteger(value) || value < 1 || value > 31536000)
      throw new Error(name + ' is invalid');
    retention[key] = value;
  }
  return {
    webDirectory: env.LAB_WORD_WEB_DIR
      ? resolve(env.LAB_WORD_WEB_DIR)
      : undefined,
    retention,
    motionFixture,
    syntheticSession,
    syntheticPython,
    syntheticPublisher,
    motionGraceMillis,
    motionAckMillis,
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

// Documentation projects defaults from the same parser used by the running server.
export function configurationFields() {
  const value = configuration({});
  const field = (
    name: string,
    defaultValue: string | number | boolean,
    description: string,
    descriptionZh: string,
  ) => ({
    name,
    default: String(defaultValue),
    secret: false,
    description,
    descriptionZh,
  });
  return [
    field(
      'LAB_WORD_SYNTHETIC_SESSION',
      value.syntheticSession,
      'Enable owned development synthetic Sessions; requires loopback and an optional configured Python source.',
      '启用开发合成会话；需要 loopback 和配置的可选 Python 来源。',
    ),
    field(
      'LAB_WORD_SYNTHETIC_PYTHON',
      value.syntheticPython,
      'Python executable used only for an explicit development synthetic Start.',
      '仅在显式 Start 开发合成会话时使用的 Python 可执行文件。',
    ),
    field(
      'LAB_WORD_SYNTHETIC_PUBLISHER',
      '',
      'Optional absolute publisher.py path; default is the bundled development source.',
      '可选 publisher.py 绝对路径；默认使用随服务提供的开发来源。',
    ),
    field(
      'LAB_WORD_MOTION_GRACE_MS',
      value.motionGraceMillis,
      'Publisher heartbeat/source progress grace in milliseconds, 1000–60000.',
      'Publisher 心跳和来源进度宽限毫秒数，1000–60000。',
    ),
    field(
      'LAB_WORD_MOTION_ACK_MS',
      value.motionAckMillis,
      'Correlated source lifecycle ACK deadline in milliseconds, 1000–60000.',
      '来源生命周期确认期限毫秒数，1000–60000。',
    ),
    field(
      'LAB_WORD_MOTION_FIXTURE',
      value.motionFixture,
      'Enable the authenticated synthetic motion fixture; requires a loopback bind.',
      '启用经过认证的合成运动测试 fixture；必须监听 loopback。',
    ),
    field(
      'LAB_WORD_WEB_DIR',
      value.webDirectory ?? '',
      'Built Web directory for production same-origin hosting; empty disables static hosting.',
      '生产同源托管的 Web 构建目录；空值关闭静态托管。',
    ),
    field(
      'LAB_WORD_HOST',
      value.hostname,
      'Bind hostname. APP_BIND is the compatibility fallback.',
      '监听主机；兼容回退为 APP_BIND。',
    ),
    field(
      'SERVER_PORT',
      value.port,
      'Listen port, integer 1–65535.',
      '监听端口，整数 1–65535。',
    ),
    field(
      'APP_ORIGIN',
      value.auth.origin,
      'Trusted Web origin; HTTPS or loopback HTTP.',
      '可信 Web origin；HTTPS 或回环 HTTP。',
    ),
    field(
      'SESSION_ABSOLUTE_SECS',
      value.auth.absoluteSecs,
      'Absolute session seconds, 60–2592000.',
      '会话绝对有效期秒数，60–2592000。',
    ),
    field(
      'SESSION_IDLE_SECS',
      value.auth.idleSecs,
      'Idle session seconds, 60 through absolute lifetime.',
      '会话空闲有效期秒数，60 至绝对有效期。',
    ),
    field(
      'RATE_LIMIT_ENABLED',
      value.rate.enabled,
      'Enable local limits; true or false.',
      '启用进程内限流，true 或 false。',
    ),
    ...rateFields.map(([name, key, min, max]) =>
      field(
        name,
        value.rate[key],
        `Integer ${min}–${max}; quotas use TCP peer and fallback cannot exceed primary.`,
        `整数 ${min}–${max}；额度按 TCP peer，溢出额度不能超过主额度。`,
      ),
    ),
    ...fileFields.map(([name, key, max]) =>
      field(
        name,
        value.files[key],
        `Integer 1–${max}; ${key === 'maxBytes' ? 'streamed byte limit' : 'capability lifetime in seconds'}.`,
        `整数 1–${max}；${key === 'maxBytes' ? '流式字节上限' : 'capability 有效期秒数'}。`,
      ),
    ),
    field(
      'FILE_PUBLIC_ORIGIN',
      value.fileOrigin,
      'Byte URL origin; defaults to trusted Web origin. HTTPS or loopback HTTP.',
      '字节 URL 的 origin；默认使用可信 Web origin，HTTPS 或回环 HTTP。',
    ),
    ...(
      [
        ['LAB_OBSERVATION_RETENTION_SECS', 'observation_seconds'],
        ['LAB_RECORD_RETENTION_SECS', 'record_seconds'],
      ] as const
    ).map(([name, key]) =>
      field(
        name,
        value.retention[key],
        key === 'observation_seconds'
          ? 'Raw observation retention seconds (1–31536000). Current properties remain.'
          : 'Ended record retention seconds (1–31536000). Active Tasks remain.',
        key === 'observation_seconds'
          ? '原始观测保留秒数（1–31536000）；保留当前属性。'
          : '结束记录保留秒数（1–31536000）；保留在途 Task。',
      ),
    ),
    field(
      'LAB_WORD_DATA_DIR',
      relative(process.cwd(), value.directory),
      'Owned persistent DB, blobs and secrets directory. CONTRACT_DATA_DIRECTORY is the test fallback.',
      '拥有的持久数据库、字节与密钥目录；测试回退为 CONTRACT_DATA_DIRECTORY。',
    ),
  ];
}
