// Fixture-only Machine provisioning/revocation from
// c80e63c8c063e44ca80c85970b518c35fb448c8e:
// packages/server/src/core/machines/use-cases.ts. Imports are relocated; unused
// publisher authentication is omitted. Keep the historical SQL frozen: adding
// current registry columns would fabricate schema-v3 provenance. Production
// upgrade/recovery always uses the current Server composition.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  sql,
  type DbSession,
} from '../../packages/server/src/platform/db/index.ts';
import { PublicFailure } from '../../packages/server/src/platform/http/failure.ts';
import { utcInstant } from '../../packages/server/src/platform/db/instant.ts';
import { canonicalUuid } from '../../packages/server/src/platform/uuid.ts';
import { accessIn } from '../../packages/server/src/core/api-keys/authentication.ts';
import { databaseAudit } from '../../packages/server/src/core/audit/use-cases.ts';
import type { FoundationContext } from '../../packages/server/src/platform/context.ts';
import type { AuthPolicy } from '../../packages/server/src/core/identity/domain.ts';
type MachineIdentity = {
  id: string;
  name: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
};
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
/** Called in the caller's finite transaction; credentials remain independent of Users. */
async function provisionMachineIn(
  tx: DbSession,
  creator: string,
  name: string,
  now: string,
) {
  if (!name.trim() || name.trim().length > 120)
    throw new PublicFailure(
      400,
      'identity.invalid_input',
      'Use a machine name of 1–120 characters',
    );
  const id = randomUUID(),
    credential = randomBytes(32).toString('base64url');
  const rows = await tx.execute<MachineIdentity>(
    sql`insert into labos_threejs_core.machines(id,name,credential_hash,created_by,created_at,expires_at) values(${id}::uuid,${name.trim()},${hash(credential)},${creator}::uuid,${now}::timestamptz,${now}::timestamptz+interval '30 days') returning id::text,name,created_at,expires_at,revoked_at`,
  );
  const machine = rows.rows[0];
  return {
    machine: {
      ...machine,
      created_at: utcInstant(machine.created_at),
      expires_at: utcInstant(machine.expires_at),
    },
    credential,
  };
}
export class SchemaV3Machines {
  readonly context: FoundationContext;
  readonly policy: AuthPolicy;
  readonly operationScope: string;
  readonly onRevoked: (id: string) => Promise<void>;
  constructor(
    context: FoundationContext,
    policy: AuthPolicy,
    operationScope: string,
    onRevoked: (id: string) => Promise<void> = async () => {},
  ) {
    this.context = context;
    this.policy = policy;
    this.operationScope = operationScope;
    this.onRevoked = onRevoked;
  }
  async provision(headers: Headers, requestId: string, name: string) {
    return this.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        const actor = await accessIn(
          tx,
          this.context,
          this.policy,
          headers,
          this.operationScope,
          true,
        );
        const result = await provisionMachineIn(
          tx,
          actor.user.id,
          name,
          this.context.clock.now(),
        );
        await databaseAudit.record(tx, {
          actorId: actor.user.id,
          actorType: actor.isApiKey ? 'agent' : 'user',
          action: 'identity.machine.provision',
          resourceType: 'identity.machine',
          resourceId: result.machine.id,
          requestId,
          correlationId: requestId,
          metadata: {},
        });
        return result;
      },
    );
  }
  async revoke(headers: Headers, requestId: string, id: string) {
    const canonical = canonicalUuid(id);
    if (!canonical)
      throw new PublicFailure(
        400,
        'identity.invalid_input',
        'Use an existing machine',
      );
    await this.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        const actor = await accessIn(
          tx,
          this.context,
          this.policy,
          headers,
          this.operationScope,
          true,
        );
        const result = await tx.execute(
          sql`update labos_threejs_core.machines set revoked_at=coalesce(revoked_at,${this.context.clock.now()}::timestamptz) where id=${canonical}::uuid returning id`,
        );
        if (!result.rows.length)
          throw new PublicFailure(
            404,
            'identity.machine_not_found',
            'Machine not found',
          );
        await databaseAudit.record(tx, {
          actorId: actor.user.id,
          actorType: actor.isApiKey ? 'agent' : 'user',
          action: 'identity.machine.revoke',
          resourceType: 'identity.machine',
          resourceId: canonical,
          requestId,
          correlationId: requestId,
          metadata: {},
        });
      },
    );
    await this.onRevoked(canonical);
  }
}
