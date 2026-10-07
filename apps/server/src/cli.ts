import { parseArgs } from 'node:util';
import { backup, restore } from './operations.ts';
import { configuration } from './config.ts';
import { Database } from '../../../packages/server/src/platform/db/index.ts';
import { DirectoryLease } from '../../../packages/server/src/platform/db/lease.ts';
import { PublicFailure } from '../../../packages/server/src/platform/http/failure.ts';
import { resetPasswordOperation } from './password-operation.ts';
import { run } from './runtime.ts';
let operation: string | undefined;
try {
  const { values, positionals } = parseArgs({
    options: {
      output: { type: 'string' },
      archive: { type: 'string' },
      email: { type: 'string' },
    },
    allowPositionals: true,
  });
  operation = positionals[0] ?? 'serve';
  const config = configuration();
  if (positionals.length > 1)
    throw new Error('Use serve, migrate, backup, restore or reset-password');
  if (
    operation === 'serve' &&
    !values.output &&
    !values.archive &&
    !values.email
  )
    await run();
  else if (
    operation === 'migrate' &&
    !values.output &&
    !values.archive &&
    !values.email
  ) {
    const lease = await DirectoryLease.acquire(config.directory),
      db = new Database(lease);
    lease.onLost(() => db.loseLease());
    try {
      await db.initialize();
      const facts = await db.archiveFacts();
      console.log(
        JSON.stringify({
          status: 'migrated',
          schemaVersion: facts.schemaVersion,
        }),
      );
    } finally {
      try {
        await db.close();
      } finally {
        await lease.release();
      }
    }
  } else if (
    operation === 'backup' &&
    values.output &&
    !values.archive &&
    !values.email
  )
    console.log(JSON.stringify(await backup(config.directory, values.output)));
  else if (
    operation === 'restore' &&
    values.archive &&
    !values.output &&
    !values.email
  )
    console.log(
      JSON.stringify(await restore(config.directory, values.archive)),
    );
  else if (
    operation === 'reset-password' &&
    values.email &&
    !values.output &&
    !values.archive
  )
    console.log(
      JSON.stringify(await resetPasswordOperation(['--email', values.email])),
    );
  else
    throw new Error(
      'Use serve, migrate, backup --output, restore --archive or reset-password --email',
    );
} catch (error) {
  const password = operation === 'reset-password';
  console.error(
    JSON.stringify({
      error: {
        code:
          error instanceof PublicFailure
            ? error.code
            : password
              ? 'auth.unavailable'
              : 'operations.failed',
        message:
          error instanceof PublicFailure
            ? error.message
            : password
              ? 'Password reset is unavailable'
              : error instanceof Error
                ? error.message
                : 'Operation failed',
      },
    }),
  );
  process.exitCode = 1;
}
