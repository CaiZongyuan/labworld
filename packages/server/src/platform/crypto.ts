import {
  argon2,
  randomBytes,
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

const prefix = '$argon2id$v=19$m=19456,t=2,p=1$';
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    argon2(
      'argon2id',
      {
        message: password,
        nonce: salt,
        memory: 19456,
        passes: 2,
        parallelism: 1,
        tagLength: 32,
      },
      (error, value) => (error ? reject(error) : resolve(value)),
    ),
  );
}
// Password work is asynchronous and bounded; callers do it before entering DB transactions.
let passwordWork = 0;
async function passwordSlot<T>(work: () => Promise<T>) {
  if (passwordWork >= 4)
    throw new Error('Password work capacity is unavailable');
  passwordWork++;
  try {
    return await work();
  } finally {
    passwordWork--;
  }
}
export function hashPassword(password: string) {
  return passwordSlot(async () => {
    const salt = randomBytes(16);
    return `${prefix}${salt.toString('base64').replace(/=+$/, '')}$${(await derive(password, salt)).toString('base64').replace(/=+$/, '')}`;
  });
}
export function secret() {
  return randomBytes(32).toString('hex');
}
export function secretHash(value: string) {
  return createHash('sha256').update(value).digest();
}
export function csrfToken(value: string) {
  return createHmac('sha256', value)
    .update('labos-threejs-session-csrf-v1')
    .digest('hex');
}
export function verifyCsrf(value: string, token: string) {
  return (
    /^[0-9a-fA-F]{64}$/.test(token) &&
    timingSafeEqual(
      Buffer.from(csrfToken(value), 'hex'),
      Buffer.from(token, 'hex'),
    )
  );
}
