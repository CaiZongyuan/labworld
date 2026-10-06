import { and, eq } from 'drizzle-orm';
import type { DbSession } from '../../platform/db/index.ts';
import type { MemberRole } from '../identity/domain.ts';
import { memberships } from './schema.ts';
export async function activeRoleIn(tx: DbSession, userId: string) {
  const [row] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.active, true)));
  return row?.role as MemberRole | undefined;
}
