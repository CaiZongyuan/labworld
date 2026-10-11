import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { configuration } from '../../apps/server/src/config.ts';
import { coreApp } from '../../apps/server/src/app.ts';
import { run, serve } from '../../apps/server/src/runtime.ts';
import {
  Database,
  migrationsDirectory,
} from '../../packages/server/src/platform/db/index.ts';
import { DirectoryLease } from '../../packages/server/src/platform/db/lease.ts';
import { FileService } from '../../packages/server/src/core/files/use-cases.ts';
import { fileRoutes } from '../../packages/server/src/core/files/routes.ts';
import { MachineService } from '../../packages/server/src/core/machines/use-cases.ts';
import { machineRoutes } from '../../packages/server/src/core/machines/routes.ts';
import { assetRoutes } from '../../packages/server/src/lab/assets/routes.ts';
import { registerAssetFileOwnership } from '../../packages/server/src/lab/assets/composition.ts';
import { WorldService } from '../../packages/server/src/lab/world/use-cases.ts';
import { worldRoutes } from '../../packages/server/src/lab/world/routes.ts';
import { SimulationSessions } from '../../packages/server/src/lab/sessions/service.ts';
import { sessionRoutes } from '../../packages/server/src/lab/sessions/routes.ts';
import { defaultRecordingOptions } from '../../packages/server/src/lab/recordings/service.ts';

// These dependencies belong to the Server package. Resolve from that real
// package scope so this independent test entry also works with strict pnpm links.
const serverDependencies = createRequire(
  new URL('../../packages/server/package.json', import.meta.url),
);
const { PGlite } = serverDependencies(
  '@electric-sql/pglite',
) as typeof import('@electric-sql/pglite');
const { drizzle } = serverDependencies(
  'drizzle-orm/pglite',
) as typeof import('drizzle-orm/pglite');
const { migrate } = serverDependencies(
  'drizzle-orm/pglite/migrator',
) as typeof import('drizzle-orm/pglite/migrator');
const appDependencies = createRequire(
  new URL('../../apps/server/package.json', import.meta.url),
);
const { getConnInfo } = appDependencies(
  '@hono/node-server/conninfo',
) as typeof import('@hono/node-server/conninfo');

// Reproducible schema-v3 fixture, not an old-build executable. The public
// noncapture Session branches use the pre-Recording reservation, snapshot and
// custody rules from c80e63c8; store.ts differs there only by a type annotation.
// No Recording rows are seeded and no migration history is rewritten.
const prior = [
  {
    idx: 0,
    when: 1791273889002,
    tag: '0000_baseline',
    hash: '1385b5d42f0f497877192ba56d953fc1864948a165946061ff15adaad3c92e53',
  },
  {
    idx: 1,
    when: 1791436317560,
    tag: '0001_guide_progress',
    hash: '928c1425e0f1cbd82cd7224c66cc5d196a9d59d1497691c04186d1401f5d6034',
  },
  {
    idx: 2,
    when: 1791665433443,
    tag: '0002_authoritative_session',
    hash: '598fc65ec18fc2054c56c73c00c85b202c7082443df80f3cb3bb404735e70495',
  },
];

async function oldSchema(directory: string) {
  const migrationCopy = join(directory, 'schema-v3-migrations');
  await mkdir(join(migrationCopy, 'meta'), { recursive: true });
  const journal = JSON.parse(
    await readFile(join(migrationsDirectory, 'meta/_journal.json'), 'utf8'),
  ) as {
    version: string;
    dialect: string;
    entries: { idx: number; tag: string; when: number }[];
  };
  const entries = journal.entries.slice(0, 3);
  assert.deepEqual(
    entries.map(({ idx, tag, when }) => ({ idx, tag, when })),
    prior.map(({ idx, tag, when }) => ({ idx, tag, when })),
  );
  for (const entry of prior) {
    const bytes = await readFile(join(migrationsDirectory, entry.tag + '.sql'));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.hash);
    await writeFile(join(migrationCopy, entry.tag + '.sql'), bytes);
  }
  await writeFile(
    join(migrationCopy, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries }),
  );
  // Database.initialize performs this build's four-entry readiness check.
  // Apply the exact genuine prefix with the same Drizzle migrator, then use
  // Database.openExisting to run real services against that prior schema.
  const client = new PGlite({
    dataDir: join(directory, 'pgdata'),
    relaxedDurability: false,
  });
  try {
    await client.waitReady;
    assert.equal(
      (
        await client.query<{ table: string | null }>(
          "select to_regclass('drizzle.__drizzle_migrations')::text as table",
        )
      ).rows[0].table,
      null,
      'Old fixture requires an empty owned database',
    );
    await migrate(drizzle(client), { migrationsFolder: migrationCopy });
  } finally {
    await client.close();
  }
}

async function preRecordingServer() {
  const config = configuration();
  const log = (entry: Record<string, unknown>) =>
    console.log(JSON.stringify(entry));
  const lease = await DirectoryLease.acquire(config.directory);
  const db = new Database(lease, (measurement) =>
    log({ event: 'database.operation', ...measurement }),
  );
  let server: ReturnType<typeof serve> | undefined;
  let sessions: SimulationSessions | undefined;
  let preparing: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let cancelled = false;
  const admitted = new Set<Promise<Response>>();
  function close() {
    cancelled = true;
    if (closing) return closing;
    closing = (async () => {
      await preparing?.catch(() => {});
      sessions?.quiesce();
      if (server) {
        server.closeIdleConnections?.();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      await Promise.allSettled([...admitted]);
      try {
        await sessions?.stop();
      } finally {
        try {
          await db.close();
        } finally {
          await lease.release();
        }
      }
    })();
    return closing;
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void close().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    });
  lease.onLost(() => {
    db.loseLease();
    void close().catch(() => {
      process.exitCode = 1;
    });
  });
  preparing = (async () => {
    await oldSchema(config.directory);
    await db.openExisting();
    const facts = await db.archiveFacts();
    assert.equal(facts.schemaVersion, 3);
    assert.deepEqual(
      facts.history.map(({ hash, created_at }) => ({
        hash,
        when: Number(created_at),
      })),
      prior.map(({ hash, when }) => ({ hash, when })),
    );
    assert.deepEqual(
      await db.readSQL(
        { id: 'legacy:absence', kind: 'startup' },
        "select to_regclass('lab.recordings')::text as recordings,to_regclass('lab.recording_resources')::text as recording_resources",
      ),
      [{ recordings: null, recording_resources: null }],
    );
    const context = { db, clock: { now: () => new Date().toISOString() } };
    const app = coreApp(
      context,
      'schema-v3-fixture',
      config.auth,
      log,
      config.rate,
    );
    const files = new FileService(
      context,
      config.files,
      config.auth,
      config.fileOrigin,
      config.directory,
    );
    await files.initialize();
    fileRoutes(app, files);
    registerAssetFileOwnership(files);
    assetRoutes(app, files);
    const world = new WorldService(context, config.auth);
    worldRoutes(app, world);
    sessions = new SimulationSessions(
      world,
      {
        enabled: true,
        graceMillis: config.motionGraceMillis,
        ackMillis: config.motionAckMillis,
      },
      log,
    );
    // Deliberately no RecordingService and no synthetic child. HTTP supplies an
    // independent Machine, then explicit Stop honestly ends an unstarted source.
    await sessions.initialize();
    sessionRoutes(app, sessions, (c) => getConnInfo(c).remote.address);
    machineRoutes(app, new MachineService(context, config.auth, 'lab:full'));
    log({
      event: 'recording.legacy.fixture',
      schema_version: facts.schemaVersion,
      migrations: facts.history,
      provenance: 'c80e63c8 pre-Recording public Session branches',
      recording_tables_absent: true,
      source_children: [],
    });
    if (cancelled) return;
    server = serve({
      hostname: config.hostname,
      port: config.port,
      fetch: async (request, ...args) => {
        const handling = Promise.resolve(app.fetch(request, ...args));
        admitted.add(handling);
        try {
          return await handling;
        } finally {
          admitted.delete(handling);
        }
      },
    });
  })();
  try {
    await preparing;
    preparing = undefined;
  } catch (error) {
    preparing = undefined;
    await close();
    throw error;
  }
}

const mode = process.env.RECORDING_LEGACY_MODE;
assert(
  ['old', 'current', 'quota', 'check'].includes(mode ?? ''),
  'Explicit fixture mode required',
);
if (mode === 'check') {
  for (const imported of [PGlite, drizzle, migrate, serve, getConnInfo])
    assert.equal(typeof imported, 'function');
  console.log(
    JSON.stringify({
      event: 'recording.legacy.import-check',
      imports: [
        serverDependencies.resolve('@electric-sql/pglite'),
        serverDependencies.resolve('drizzle-orm/pglite'),
        serverDependencies.resolve('drizzle-orm/pglite/migrator'),
        appDependencies.resolve('@hono/node-server/conninfo'),
      ],
      runtimeStarted: false,
    }),
  );
} else if (mode === 'old') await preRecordingServer();
else {
  if (mode === 'quota') defaultRecordingOptions.maxTotalBytes = 1;
  // Every upgrade/recovery/admission under test uses the production composition.
  await run();
}
