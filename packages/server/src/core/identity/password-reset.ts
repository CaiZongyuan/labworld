import type { FoundationContext } from '../../platform/context.ts';
import { unavailable } from './use-cases.ts';
import { eq } from 'drizzle-orm';
import { trimmed, utf8Size, validEmail } from './email.ts';
import { hashPassword } from '../../platform/crypto.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { users, credentials, sessions } from './schema.ts';
import { databaseAudit } from '../audit/use-cases.ts';
export async function resetPassword(
  context: FoundationContext,
  email: string,
  password: string,
  requestId: string,
): Promise<{ user_id: string }> {
  const normalized = trimmed(email).toLowerCase();
  if (
    !validEmail(normalized) ||
    utf8Size(normalized) > 254 ||
    [...password].length < 12 ||
    [...password].length > 128
  )
    throw new PublicFailure(
      400,
      'auth.invalid_input',
      'Use a valid email and a 12–128 character password',
    );
  try {
    const passwordHash = await hashPassword(password);
    return await context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        const [user] = await tx
          .select()
          .from(users)
          .where(eq(users.normalizedEmail, normalized));
        if (!user)
          throw new PublicFailure(
            404,
            'auth.user_not_found',
            'Account not found',
          );
        const changed = await tx
          .update(credentials)
          .set({ passwordHash })
          .where(eq(credentials.userId, user.id))
          .returning({ id: credentials.userId });
        if (changed.length !== 1) throw unavailable();
        await tx
          .update(sessions)
          .set({ revoked: true })
          .where(eq(sessions.userId, user.id));
        await databaseAudit.record(tx, {
          actorType: 'system',
          action: 'identity.password_reset',
          resourceType: 'identity.user',
          resourceId: user.id,
          requestId,
          correlationId: requestId,
          metadata: { subject_user_id: user.id },
        });
        return { user_id: user.id };
      },
    );
  } catch (error) {
    if (error instanceof PublicFailure) throw error;
    throw unavailable();
  }
}
