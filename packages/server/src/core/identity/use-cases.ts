import { eq } from 'drizzle-orm';
import { sql, type DbSession } from '../../platform/db/index.ts';
import type { FoundationContext } from '../../platform/context.ts';
import {
  hashPassword,
  secret,
  secretHash,
  csrfToken,
} from '../../platform/crypto.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { databaseAudit } from '../audit/use-cases.ts';
import { organizations, memberships } from '../organization/schema.ts';
import { users, credentials, sessions } from './schema.ts';
import {
  registration,
  type Registration,
  type AuthPolicy,
  type CurrentSession,
  type CurrentUser,
  type MemberRole,
} from './domain.ts';

export const unavailable = () =>
  new PublicFailure(
    503,
    'auth.unavailable',
    'Authentication is temporarily unavailable',
  );
export const unauthorized = () =>
  new PublicFailure(401, 'auth.unauthorized', 'Sign in to continue');
export function trustedOrigin(policy: AuthPolicy, origin: string | null) {
  if (origin !== policy.origin)
    throw new PublicFailure(
      403,
      'auth.origin',
      'Request origin is not trusted',
    );
}
export function cookieSecret(policy: AuthPolicy, cookie: string | null) {
  const name = policy.secureCookie
    ? '__Host-labos_threejs_session'
    : 'labos_threejs_session';
  const value = cookie
    ?.split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key === name)?.[1];
  return value && /^[a-fA-F0-9]{64}$/.test(value) ? value : undefined;
}
export async function issueSession(
  context: FoundationContext,
  policy: AuthPolicy,
  user: CurrentUser,
  verifiedHash: string,
  requestId: string,
) {
  const value = secret();
  const role = await context.db.transaction(
    { id: requestId, kind: 'request' },
    async (tx) => {
      const rows = await tx.execute<{
        role: MemberRole;
        password_hash: string;
      }>(
        sql`select m.role,c.password_hash from labos_threejs_core.memberships m join labos_threejs_core.credentials c on c.user_id=m.user_id where m.user_id=${user.id}::uuid and m.active`,
      );
      const current = rows.rows[0];
      if (!current || current.password_hash !== verifiedHash)
        throw unauthorized();
      await tx
        .insert(sessions)
        .values({
          userId: user.id,
          secretHash: secretHash(value),
          expiresAt: new Date(
            Date.parse(context.clock.now()) + policy.absoluteSecs * 1000,
          ).toISOString(),
        });
      return current.role;
    },
  );
  return {
    cookie: `${policy.secureCookie ? '__Host-' : ''}labos_threejs_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${policy.absoluteSecs}${policy.secureCookie ? '; Secure' : ''}`,
    session: {
      user: { ...user, role },
      csrf_token: csrfToken(value),
    } satisfies CurrentSession,
  };
}
export async function register(
  context: FoundationContext,
  policy: AuthPolicy,
  input: Registration,
  requestId: string,
) {
  const normalized = registration(input);
  if (!normalized)
    throw new PublicFailure(
      400,
      'auth.invalid_input',
      'Use a valid email, a 12–128 character password and a name up to 80 characters',
    );
  let passwordHash: string;
  try {
    passwordHash = await hashPassword(input.password);
  } catch {
    throw unavailable();
  }
  let user: CurrentUser;
  try {
    user = await context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        const [created] = await tx.insert(users).values(normalized).returning();
        await tx
          .insert(credentials)
          .values({ userId: created.id, passwordHash });
        const [organization] = await tx
          .insert(organizations)
          .values({ id: 1, name: 'My Organization' })
          .onConflictDoUpdate({ target: organizations.id, set: { id: 1 } })
          .returning();
        const role: MemberRole = organization.ownerInitialized
          ? 'member'
          : 'owner';
        await tx
          .insert(memberships)
          .values({ userId: created.id, organizationId: 1, role });
        await tx
          .update(organizations)
          .set({ ownerInitialized: true })
          .where(eq(organizations.id, 1));
        await databaseAudit.record(tx, {
          actorId: created.id,
          actorType: 'user',
          action: 'identity.register',
          resourceType: 'identity.user',
          resourceId: created.id,
          requestId,
          correlationId: requestId,
          metadata: {},
        });
        return {
          id: created.id,
          email: created.email,
          display_name: created.displayName,
          role,
        };
      },
    );
  } catch (error) {
    const cause =
      (error as { cause?: { code?: string; constraint?: string } }).cause ??
      (error as { code?: string; constraint?: string });
    if (
      cause.code === '23505' &&
      cause.constraint?.includes('normalized_email')
    )
      throw new PublicFailure(
        409,
        'auth.email_exists',
        'An account already uses this email',
      );
    throw unavailable();
  }
  try {
    return await issueSession(context, policy, user, passwordHash, requestId);
  } catch {
    throw new PublicFailure(
      503,
      'auth.session_unavailable',
      'Account created; sign in later without registering again',
    );
  }
}
export async function sessionIn(
  tx: DbSession,
  policy: AuthPolicy,
  value: string,
): Promise<CurrentSession> {
  const result = await tx.execute<CurrentUser>(
    sql`with active_session as (update labos_threejs_core.sessions set last_seen_at=now() where secret_hash=${secretHash(value)} and not revoked and expires_at>now() and last_seen_at>now()-make_interval(secs=>${policy.idleSecs}) returning user_id) select u.id::text,u.email,u.display_name,m.role from active_session s join labos_threejs_core.users u on u.id=s.user_id join labos_threejs_core.memberships m on m.user_id=u.id and m.active`,
  );
  if (!result.rows[0]) throw unauthorized();
  return { user: result.rows[0], csrf_token: csrfToken(value) };
}
export async function currentSession(
  context: FoundationContext,
  policy: AuthPolicy,
  headers: Headers,
  requestId: string,
) {
  const value = cookieSecret(policy, headers.get('cookie'));
  if (headers.has('authorization') || !value) throw unauthorized();
  try {
    return await context.db.read({ id: requestId, kind: 'request' }, (tx) =>
      sessionIn(tx, policy, value),
    );
  } catch (error) {
    if (error instanceof PublicFailure) throw error;
    throw unavailable();
  }
}
