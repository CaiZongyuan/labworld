// Public FileService capability transport for real-process crash supplements.
// No production JSON route or seeded Lab business is introduced.
import { run, version } from '../../apps/server/src/runtime.ts';
import { coreApp } from '../../apps/server/src/app.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { FileService } from '../../packages/server/src/core/files/use-cases.ts';
import { fileRoutes } from '../../packages/server/src/core/files/routes.ts';
import { fileScheduler } from '../../packages/server/src/core/files/scheduler.ts';
import { requireAccess } from '../../packages/server/src/core/api-keys/authentication.ts';
import { PublicFailure } from '../../packages/server/src/platform/http/failure.ts';
import type { UploadInput } from '../../packages/server/src/core/files/domain.ts';
type Request = {
  id: string;
  command:
    | 'start'
    | 'complete'
    | 'crash_complete'
    | 'load'
    | 'download'
    | 'cleanup'
    | 'rescan';
  headers: Record<string, string>;
  fileId?: string;
  input?: UploadInput;
};
const config = configuration();
await run(async (context) => {
  const files = new FileService(
    context,
    config.files,
    config.auth,
    config.fileOrigin,
    config.directory,
  );
  await files.initialize();
  const app = coreApp(context, version, config.auth, undefined, config.rate);
  fileRoutes(app, files);
  const scheduler = process.env.OWNED_FILE_SCHEDULER_MS
    ? fileScheduler(
        context,
        files,
        () => {},
        Number(process.env.OWNED_FILE_SCHEDULER_MS),
      )
    : undefined;
  process.on('message', async (raw: Request) => {
    try {
      const result = await context.db.operation(
        {
          id: raw.id,
          kind:
            raw.command === 'cleanup' || raw.command === 'rescan'
              ? 'background'
              : 'request',
        },
        async () => {
          if (raw.command === 'cleanup') return files.cleanup(raw.id);
          if (raw.command === 'rescan') return files.rescan(raw.id);
          const actor = await requireAccess(
            context,
            config.auth,
            new Headers(raw.headers),
            raw.id,
            'lab:full',
            true,
          );
          if (raw.command === 'start')
            return context.db.transaction(
              { id: raw.id, kind: 'request' },
              (tx) => files.start(tx, actor, raw.input!),
            );
          if (raw.command === 'download')
            return context.db.transaction(
              { id: raw.id, kind: 'request' },
              (tx) => files.download(tx, actor, raw.fileId!),
            );
          if (raw.command === 'load')
            return context.db.read({ id: raw.id, kind: 'request' }, (tx) =>
              files.load(tx, raw.fileId!),
            );
          return files.complete(
            actor,
            raw.fileId!,
            raw.id,
            async (tx, file) => {
              await files.pin(tx, file.id, {
                ownerType: 'owned-process-proof',
                ownerId: file.id,
              });
              if (raw.command === 'crash_complete')
                process.kill(process.pid, 'SIGKILL');
              return file;
            },
          );
        },
      );
      process.send?.({ id: raw.id, result });
    } catch (error) {
      process.send?.({
        id: raw.id,
        error: {
          status: error instanceof PublicFailure ? error.status : 500,
          code: error instanceof PublicFailure ? error.code : 'internal.error',
        },
      });
    }
  });
  return {
    app,
    stop: async () => {
      await scheduler?.stop();
      if (process.connected) process.disconnect();
    },
  };
});
