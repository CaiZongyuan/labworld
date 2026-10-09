import { withTestPostgres } from './postgres.mjs';
import { withTestRustfs } from './rustfs.mjs';
import { withTestRedis } from './redis.mjs';
import { withTestMailpit } from './mailpit.mjs';

// Each fixture owns readiness and cleanup. Nesting keeps every dependency
// alive for the callback and unwinds acquired services if startup or work fails.
export async function withTestServices(action) {
  await withTestPostgres(async ({ name: postgresName, url }) => {
    await withTestRustfs(async ({ name: storageName, env: storage }) => {
      await withTestRedis(async ({ env: redis }) => {
        await withTestMailpit(async ({ env: mail }) => {
          await action({
            postgresName,
            storageName,
            env: { ...storage, ...redis, ...mail, DATABASE_URL: url },
          });
        });
      });
    });
  });
}
