import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FoundationContext } from '../../platform/context.ts';
import type { DbSession } from '../../platform/db/index.ts';
import { secretHash } from '../../platform/crypto.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import type { AuthPolicy, CurrentUser } from '../identity/domain.ts';
import { sessionIn, sessionValue, profiles } from '../identity/use-cases.ts';
import { activeRoleIn } from '../organization/capabilities.ts';
import { apiKeys } from './schema.ts';
import { secretPrefix } from './domain.ts';
export type AccessActor = {
  user: CurrentUser;
  isApiKey: boolean;
  credentialId?: string;
};
const unauthorized = () =>
  new PublicFailure(401, 'auth.unauthorized', 'Provide an active credential');
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
      user: (
        await sessionIn(tx, policy, sessionValue(policy, headers, mutation))
      ).user,
      isApiKey: false,
    };
  const token = bearer(headers);
  if (!token || !token.startsWith(secretPrefix)) throw unauthorized();
  const [key] = await tx
    .select()
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.secretHash, secretHash(token)),
        isNull(apiKeys.revokedAt),
        gt(apiKeys.expiresAt, context.clock.now()),
      ),
    );
  if (!key) throw unauthorized();
  const role = await activeRoleIn(tx, key.userId);
  if (!role) throw unauthorized();
  if (!key.scopes.includes(requiredScope))
    throw new PublicFailure(
      403,
      'api_keys.scope_forbidden',
      'API key does not permit this operation',
    );
  await tx
    .update(apiKeys)
    .set({ lastUsedAt: context.clock.now() })
    .where(eq(apiKeys.id, key.id));
  const [profile] = await profiles(tx, [key.userId]);
  if (!profile) throw unauthorized();
  return { user: { ...profile, role }, isApiKey: true, credentialId: key.id };
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
