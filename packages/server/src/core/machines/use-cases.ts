import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql, type DbSession } from '../../platform/db/index.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { utcInstant } from '../../platform/db/instant.ts';
import { canonicalUuid } from '../../platform/uuid.ts';
import { accessIn } from '../api-keys/authentication.ts';
import { databaseAudit } from '../audit/use-cases.ts';
import type { FoundationContext } from '../../platform/context.ts';
import type { AuthPolicy } from '../identity/domain.ts';
export type MachineIdentity = {
  id: string;
  name: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
};
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const denied = () =>
  new PublicFailure(
    403,
    'identity.machine_unauthorized',
    'Machine admission failed',
  );
/** Called in the caller's finite transaction; credentials remain independent of Users. */
export async function provisionMachineIn(
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
export async function authenticateMachineIn(
  tx: DbSession,
  id: string,
  headers: Headers,
  now: string,
) {
  const canonical = canonicalUuid(id),
    credential = headers
      .get('authorization')
      ?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!canonical || !credential) throw denied();
  const result = await tx.execute<MachineIdentity>(
    sql`select id::text,name,created_at,expires_at,revoked_at from labos_threejs_core.machines where id=${canonical}::uuid and credential_hash=${hash(credential)} and revoked_at is null and expires_at>${now}::timestamptz`,
  );
  if (!result.rows[0]) throw denied();
  return result.rows[0];
}
export class MachineService {
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
