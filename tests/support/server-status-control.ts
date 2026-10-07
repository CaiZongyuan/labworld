/** Necessary platform-close supplement for public readiness failure/restart. */
import { Database } from '../../packages/server/src/platform/db/index.ts';
import { run } from '../../apps/server/src/runtime.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
const initialize = Database.prototype.initialize;
let closeStore: (() => Promise<void>) | undefined;
let inspectStore: (() => Promise<Record<string, unknown>>) | undefined;
async function directoryBytes(directory: string): Promise<number> {
  let size = 0;
  for (const name of await readdir(directory)) {
    const path = join(directory, name),
      info = await lstat(path);
    if (info.isSymbolicLink())
      throw new Error('Unexpected link in owned Node storage');
    size += info.isDirectory() ? await directoryBytes(path) : info.size;
  }
  return size;
}
Database.prototype.initialize = async function (...args) {
  await initialize.apply(this, args);
  closeStore = () => this.close();
  inspectStore = async () => {
    // Read-only platform measurement supplement; correctness stays at HTTP.
    const [facts] = await this.readSQL<Record<string, unknown>>(
      { id: 'internal.browser-storage', kind: 'background' },
      "select pg_database_size(current_database()) as database_bytes,(select sum(pg_total_relation_size(c.oid)) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='lab' and c.relkind='r') as lab_table_bytes,(select count(*) from lab.observation_history) as observation_rows,(select count(*) from lab.entities) as entity_rows,(select count(*) from lab.scene_nodes) as node_rows",
    );
    return {
      ...Object.fromEntries(
        Object.entries(facts).map(([key, value]) => [key, Number(value)]),
      ),
      nodefs_database_bytes: await directoryBytes(
        join(configuration().directory, 'pgdata'),
      ),
      rss_bytes: process.memoryUsage().rss,
      boundary:
        'platform SQL snapshot, followed by NodeFS size scan and service-process RSS',
    };
  };
};
process.on('message', (action) => {
  if (action === 'inspect-store') {
    void inspectStore!().then(
      (facts) => process.send?.({ event: 'store.facts', facts }),
      () => process.send?.({ event: 'store.inspect_failed' }),
    );
    return;
  }
  if (action !== 'close-store') return;
  void closeStore!().then(
    () => process.send?.({ event: 'store.closed' }),
    () => process.send?.({ event: 'store.close_failed' }),
  );
});
process.once('SIGTERM', () => {
  if (process.connected) process.disconnect();
});
try {
  await run();
} finally {
  Database.prototype.initialize = initialize;
}
