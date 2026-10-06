import { asc, gt, eq, and, inArray, sql } from 'drizzle-orm';
import type { FoundationContext } from '../../platform/context.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import type { AuthPolicy, MemberRole } from '../identity/domain.ts';
import { profiles, sessionIn, sessionValue } from '../identity/use-cases.ts';
import { memberships } from './schema.ts';
import { canManage, changeAllowed } from './domain.ts';
import { sessions } from '../identity/schema.ts';
import { databaseAudit } from '../audit/use-cases.ts';
const invalidPage = () =>
  new PublicFailure(
    400,
    'organization.invalid_page',
    'Use a valid member list cursor and page size',
  );
export async function listMembers(
  context: FoundationContext,
  policy: AuthPolicy,
  headers: Headers,
  requestId: string,
  query: { limit?: number; cursor?: string },
) {
  const value = sessionValue(policy, headers);
  try {
    return await context.db.read(
      { id: requestId, kind: 'request' },
      async (tx) => {
        const actor = (await sessionIn(tx, policy, value)).user;
        if (actor.role === 'member')
          throw new PublicFailure(
            403,
            'organization.forbidden',
            'Your role cannot manage this member',
          );
        const limit = query.limit ?? 50;
        if (limit < 1 || limit > 100) throw invalidPage();
        let cursor: string | undefined;
        if (query.cursor !== undefined) {
          try {
            if (
              query.cursor.length > 512 ||
              !/^[A-Za-z0-9_-]+$/.test(query.cursor)
            )
              throw invalidPage();
            const decoded = Buffer.from(query.cursor, 'base64url');
            if (decoded.toString('base64url') !== query.cursor)
              throw invalidPage();
            const parsed = JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(decoded),
            );
            if (
              !Array.isArray(parsed) ||
              parsed.length !== 2 ||
              parsed[0] !== actor.id ||
              typeof parsed[1] !== 'string' ||
              !/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(
                parsed[1],
              )
            )
              throw invalidPage();
            cursor = parsed[1].toLowerCase();
          } catch {
            throw invalidPage();
          }
        }
        const rows = await tx
          .select()
          .from(memberships)
          .where(cursor ? gt(memberships.userId, cursor) : undefined)
          .orderBy(asc(memberships.userId))
          .limit(limit + 1);
        const has_more = rows.length > limit;
        rows.length = Math.min(rows.length, limit);
        const people = await profiles(
          tx,
          rows.map((row) => row.userId),
        );
        const data = rows.map((row) => {
          const person = people.find((person) => person.id === row.userId);
          if (!person) throw new Error('Member profile is unavailable');
          return {
            user_id: row.userId,
            email: person.email,
            display_name: person.display_name,
            role: row.role as MemberRole,
            active: row.active,
            version: row.version,
            can_edit: canManage(actor.role, row.role as MemberRole),
          };
        });
        return {
          data,
          has_more,
          next_cursor: has_more
            ? Buffer.from(
                JSON.stringify([actor.id, rows.at(-1)!.userId]),
              ).toString('base64url')
            : null,
          assignable_roles:
            actor.role === 'owner'
              ? (['owner', 'admin', 'member'] as MemberRole[])
              : (['admin', 'member'] as MemberRole[]),
        };
      },
    );
  } catch (error) {
    if (error instanceof PublicFailure) throw error;
    throw new PublicFailure(
      503,
      'organization.unavailable',
      'Memberships are temporarily unavailable',
    );
  }
}
export async function updateMember(
  context: FoundationContext,
  policy: AuthPolicy,
  headers: Headers,
  requestId: string,
  target: string,
  input: { role: MemberRole; active: boolean; version: number },
) {
  const value = sessionValue(policy, headers, true);
  try {
    return await context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        const actor = (await sessionIn(tx, policy, value)).user;
        if (!Number.isSafeInteger(input.version) || input.version < 1)
          throw new PublicFailure(
            400,
            'organization.invalid_version',
            'Use a positive membership version',
          );
        if (
          !/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(
            target,
          )
        )
          throw new PublicFailure(
            404,
            'organization.member_not_found',
            'Member not found',
          );
        const rows = await tx
          .select()
          .from(memberships)
          .where(inArray(memberships.userId, [actor.id, target]));
        const current = rows.find((row) => row.userId === target.toLowerCase());
        const acting = rows.find(
          (row) => row.userId === actor.id && row.active,
        );
        if (!acting)
          throw new PublicFailure(
            403,
            'organization.forbidden',
            'This member change is not permitted',
          );
        if (!current)
          throw new PublicFailure(
            404,
            'organization.member_not_found',
            'Member not found',
          );
        if (
          !canManage(acting.role as MemberRole, current.role as MemberRole) ||
          !canManage(acting.role as MemberRole, input.role)
        )
          throw new PublicFailure(
            403,
            'organization.forbidden',
            'This member change is not permitted',
          );
        if (current.version !== input.version)
          throw new PublicFailure(
            409,
            'organization.version_conflict',
            'Member changed; refresh before retrying',
          );
        const count = await tx
          .select({ value: sql<number>`count(*)::integer` })
          .from(memberships)
          .where(
            and(eq(memberships.active, true), eq(memberships.role, 'owner')),
          );
        if (
          changeAllowed(
            acting.role as MemberRole,
            { role: current.role as MemberRole, active: current.active },
            input,
            count[0].value,
          ) === 'last_owner'
        )
          throw new PublicFailure(
            422,
            'organization.last_owner',
            'Keep at least one active Owner',
          );
        const [changed] = await tx
          .update(memberships)
          .set({
            role: input.role,
            active: input.active,
            version: sql`${memberships.version}+1`,
          })
          .where(eq(memberships.userId, current.userId))
          .returning();
        if (!input.active)
          await tx
            .update(sessions)
            .set({ revoked: true })
            .where(eq(sessions.userId, current.userId));
        await databaseAudit.record(tx, {
          actorId: actor.id,
          actorType: 'user',
          action: 'organization.member.update',
          resourceType: 'organization.member',
          resourceId: current.userId,
          requestId,
          correlationId: requestId,
          metadata: {},
        });
        const [person] = await profiles(tx, [current.userId]);
        return {
          user_id: changed.userId,
          email: person.email,
          display_name: person.display_name,
          role: changed.role as MemberRole,
          active: changed.active,
          version: changed.version,
          can_edit: canManage(
            acting.role as MemberRole,
            changed.role as MemberRole,
          ),
        };
      },
    );
  } catch (error) {
    if (error instanceof PublicFailure) throw error;
    throw new PublicFailure(
      503,
      'organization.unavailable',
      'Member administration is temporarily unavailable',
    );
  }
}
