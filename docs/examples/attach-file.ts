import type { FoundationContext } from '../../packages/server/src/platform/context.ts';
import type { DbSession } from '../../packages/server/src/platform/db/index.ts';
import type { AuthPolicy } from '../../packages/server/src/core/identity/domain.ts';
import { requireAccess } from '../../packages/server/src/core/api-keys/authentication.ts';
import type { FileInfo } from '../../packages/server/src/core/files/domain.ts';
import type {
  FileService,
  FileReference,
  VerifiedFile,
} from '../../packages/server/src/core/files/use-cases.ts';

// Call from a trusted Application handler after its signed PUT has completed.
// The Application owns business authorization, validation and publication.
export async function attachFile<T>(
  context: FoundationContext,
  service: FileService,
  auth: AuthPolicy,
  headers: Headers,
  requestId: string,
  uploadId: string,
  reference: FileReference,
  validate: (candidate: VerifiedFile) => Promise<void>,
  publish: (tx: DbSession, file: FileInfo, transitioned: boolean) => Promise<T>,
): Promise<T> {
  const actor = await requireAccess(
    context,
    auth,
    headers,
    requestId,
    'lab:full',
    true,
  );
  return service.complete(
    actor,
    uploadId,
    requestId,
    async (tx, file, transitioned) => {
      const result = await publish(tx, file, transitioned);
      await service.pin(tx, file.id, reference);
      return result;
    },
    validate,
  );
}
