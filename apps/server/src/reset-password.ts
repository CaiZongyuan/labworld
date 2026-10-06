import { randomUUID } from 'node:crypto';
import { Database } from '../../../packages/server/src/platform/db/index.ts';
import { DirectoryLease } from '../../../packages/server/src/platform/db/lease.ts';
import { resetPassword } from '../../../packages/server/src/core/identity/password-reset.ts';
import { PublicFailure } from '../../../packages/server/src/platform/http/failure.ts';
import { configuration } from './config.ts';
async function command() {
  const args = process.argv.slice(2);
  if (
    args.length !== 2 ||
    args[0] !== '--email' ||
    !args[1] ||
    process.stdin.isTTY
  )
    throw new PublicFailure(
      400,
      'auth.invalid_input',
      'Use --email and provide the new password on standard input',
    );
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > 514)
      throw new PublicFailure(
        400,
        'auth.invalid_input',
        'Password exceeds the allowed length',
      );
    chunks.push(bytes);
  }
  let password: string;
  try {
    password = new TextDecoder('utf-8', { fatal: true })
      .decode(Buffer.concat(chunks))
      .replace(/\r?\n$/, '');
  } catch {
    throw new PublicFailure(
      400,
      'auth.invalid_input',
      'Use a valid UTF-8 password',
    );
  }
  const config = configuration();
  const lease = await DirectoryLease.acquire(config.directory);
  const db = new Database(lease);
  lease.onLost(() => db.loseLease());
  try {
    await db.initialize();
    const result = await resetPassword(
      { db, clock: { now: () => new Date().toISOString() } },
      args[1],
      password,
      randomUUID(),
    );
    console.log(JSON.stringify({ status: 'reset', ...result }));
  } finally {
    await db.close();
    await lease.release();
  }
}
void command().catch((error) => {
  console.error(
    JSON.stringify({
      error: {
        code: error instanceof PublicFailure ? error.code : 'auth.unavailable',
        message:
          error instanceof PublicFailure
            ? error.message
            : 'Password reset is unavailable',
      },
    }),
  );
  process.exitCode = 1;
});
