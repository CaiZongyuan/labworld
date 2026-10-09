import { withTestServices } from './lib/test-services.mjs';
import { withTestMailpit } from './lib/mailpit.mjs';
import { run } from './lib/process.mjs';

await withTestServices(async ({ env }) => {
  // Fault-injection mail stays separate from the normal delivery service.
  await withTestMailpit(async ({ env: chaosEnv }) => {
    run(
      'cargo',
      ['test', '--locked', '--workspace', ...process.argv.slice(2)],
      {
        ...process.env,
        ...env,
        MAIL_CHAOS_SMTP_PORT: chaosEnv.MAIL_SMTP_PORT,
        MAIL_CHAOS_HTTP_URL: chaosEnv.MAILPIT_HTTP_URL,
        CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '4',
      },
    );
  });
});
