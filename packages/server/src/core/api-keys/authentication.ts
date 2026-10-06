import { eq } from 'drizzle-orm';
import type { FoundationContext } from '../../platform/context.ts';
import { sql, type DbSession } from '../../platform/db/index.ts';
import { secretHash } from '../../platform/crypto.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import type { AuthPolicy, CurrentUser } from '../identity/domain.ts';
import {
  sessionCredentialIn,
  sessionValue,
  revalidateSessionIn,
} from '../identity/use-cases.ts';
import { apiKeys } from './schema.ts';
import { secretPrefix } from './domain.ts';
export type AccessActor = {
  user: CurrentUser;
  isApiKey: boolean;
  credentialId: string;
};
// Rechecks are performed by the caller inside its final publication transaction.
export async function revalidateIn(
  tx: DbSession,
  context: FoundationContext,
  policy: AuthPolicy,
  actor: AccessActor,
  requiredScope: string,
): Promise<AccessActor> {
  const current = actor.isApiKey
    ? await keyCredentialIn(
        tx,
        context,
        sql`k.id=${actor.credentialId}::uuid`,
        requiredScope,
      )
    : {
        user: await revalidateSessionIn(tx, policy, actor.credentialId),
        credentialId: actor.credentialId,
      };
  if (current.user.id !== actor.user.id) throw unauthorized();
  return { ...current, isApiKey: actor.isApiKey };
}
const unauthorized = () =>
  new PublicFailure(401, 'auth.unauthorized', 'Provide an active credential');
async function keyCredentialIn(
  tx: DbSession,
  context: FoundationContext,
  predicate: ReturnType<typeof sql>,
  requiredScope: string,
) {
  const result = await tx.execute<
    CurrentUser & { credential_id: string; scopes: string[] }
  >(
    sql`select u.id::text,u.email,u.display_name,m.role,k.id::text as credential_id,k.scopes from labos_threejs_core.api_keys k join labos_threejs_core.users u on u.id=k.user_id join labos_threejs_core.memberships m on m.user_id=u.id and m.active where ${predicate} and k.revoked_at is null and k.expires_at>${context.clock.now()}::timestamptz`,
  );
  const row = result.rows[0];
  if (!row) throw unauthorized();
  if (!row.scopes.includes(requiredScope))
    throw new PublicFailure(
      403,
      'api_keys.scope_forbidden',
      'API key does not permit this operation',
    );
  return {
    user: {
      id: row.id,
      email: row.email,
      display_name: row.display_name,
      role: row.role,
    },
    credentialId: row.credential_id,
  };
}
export function bearer(headers: Headers) {
  const match = headers
    .get('authorization')
    ?.match(
      /^\s*[Bb][Ee][Aa][Rr][Ee][Rr][\t ]+(labos_threejs_key_[0-9a-fA-F]{64})\s*$/,
    );
  return match?.[1];
}
export async function accessIn(
  tx: DbSession,
  context: FoundationContext,
  policy: AuthPolicy,
  headers: Headers,
  requiredScope: string,
  mutation = false,
): Promise<AccessActor> {
  if (!headers.has('authorization'))
    return {
      ...(await sessionCredentialIn(
        tx,
        policy,
        sessionValue(policy, headers, mutation),
      )),
      isApiKey: false,
    };
  const token = bearer(headers);
  if (!token || !token.startsWith(secretPrefix)) throw unauthorized();
  const actor = await keyCredentialIn(
    tx,
    context,
    sql`k.secret_hash=${secretHash(token)}`,
    requiredScope,
  );
  await tx
    .update(apiKeys)
    .set({ lastUsedAt: context.clock.now() })
    .where(eq(apiKeys.id, actor.credentialId));
  return { ...actor, isApiKey: true };
}
export async function requireAccess(
  context: FoundationContext,
  policy: AuthPolicy,
  headers: Headers,
  requestId: string,
  requiredScope: string,
  mutation = false,
) {
  try {
    return await context.db.transaction(
      { id: requestId, kind: 'request' },
      (tx) => accessIn(tx, context, policy, headers, requiredScope, mutation),
    );
  } catch (error) {
    if (error instanceof PublicFailure) throw error;
    throw new PublicFailure(
      503,
      'auth.unavailable',
      'Authentication is temporarily unavailable',
    );
  }
}
