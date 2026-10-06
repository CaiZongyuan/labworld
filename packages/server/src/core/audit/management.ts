import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { FoundationContext } from '../../platform/context.ts';
import type { AuthPolicy } from '../identity/domain.ts';
import { sessionIn, sessionValue } from '../identity/use-cases.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { secretHash } from '../../platform/crypto.ts';
import { utcInstant } from '../../platform/db/instant.ts';
import { utf8Size } from '../identity/email.ts';
import { auditEvents } from './schema.ts';
export type AuditQuery = {
  limit?: number;
  cursor?: string;
  resource_id?: string;
  action?: string;
  request_id?: string;
  resource_type?: string;
  actor_id?: string;
  correlation_id?: string;
  job_id?: string;
};
const invalid = () =>
  new PublicFailure(
    400,
    'audit.invalid_page',
    'Use valid audit filters and cursor',
  );
export async function listAudit(
  context: FoundationContext,
  policy: AuthPolicy,
  headers: Headers,
  requestId: string,
  query: AuditQuery,
) {
  const value = sessionValue(policy, headers);
  const uuid =
    /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;
  const filters = [
    query.resource_id,
    query.action,
    query.request_id,
    query.resource_type,
    query.actor_id?.toLowerCase(),
    query.correlation_id,
    query.job_id?.toLowerCase(),
  ];
  const scope = secretHash(
    JSON.stringify(filters.map((value) => value ?? null)),
  ).toString('hex');
  try {
    return await context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        const actor = (await sessionIn(tx, policy, value)).user;
        if (actor.role === 'member')
          throw new PublicFailure(
            403,
            'audit.forbidden',
            'Only an active Owner or Admin can read audit events',
          );
        const limit = query.limit ?? 50;
        if (
          limit < 1 ||
          limit > 100 ||
          filters.some(
            (value) =>
              value !== undefined &&
              (!value || utf8Size(value) > 200 || value.includes('\0')),
          ) ||
          (query.actor_id && !uuid.test(query.actor_id)) ||
          (query.job_id && !uuid.test(query.job_id))
        )
          throw invalid();
        let cursor: string | undefined;
        if (query.cursor !== undefined) {
          try {
            if (
              query.cursor.length > 512 ||
              !/^[A-Za-z0-9_-]+$/.test(query.cursor)
            )
              throw invalid();
            const bytes = Buffer.from(query.cursor, 'base64url');
            if (bytes.toString('base64url') !== query.cursor) throw invalid();
            const parsed = JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(bytes),
            );
            if (
              !Array.isArray(parsed) ||
              parsed.length !== 3 ||
              parsed[0] !== actor.id ||
              parsed[1] !== scope ||
              typeof parsed[2] !== 'string' ||
              !uuid.test(parsed[2])
            )
              throw invalid();
            cursor = parsed[2].toLowerCase();
          } catch {
            throw invalid();
          }
        }
        const rows = await tx
          .select()
          .from(auditEvents)
          .where(
            and(
              query.resource_id
                ? eq(auditEvents.resourceId, query.resource_id)
                : undefined,
              query.action ? eq(auditEvents.action, query.action) : undefined,
              query.request_id
                ? eq(auditEvents.requestId, query.request_id)
                : undefined,
              query.resource_type
                ? eq(auditEvents.resourceType, query.resource_type)
                : undefined,
              query.actor_id
                ? eq(auditEvents.actorId, query.actor_id)
                : undefined,
              query.correlation_id
                ? eq(auditEvents.correlationId, query.correlation_id)
                : undefined,
              query.job_id ? sql`false` : undefined,
              cursor ? lt(auditEvents.id, cursor) : undefined,
            ),
          )
          .orderBy(desc(auditEvents.id))
          .limit(limit + 1);
        const has_more = rows.length > limit;
        rows.length = Math.min(rows.length, limit);
        return {
          data: rows.map((row) => ({
            id: row.id,
            actor_id: row.actorId,
            actor_type: row.actorType,
            action: row.action,
            resource_type: row.resourceType,
            resource_id: row.resourceId,
            request_id: row.requestId,
            trace_id: row.traceId,
            correlation_id: row.correlationId,
            job_id: null,
            metadata: row.metadata as { subject_user_id?: string },
            created_at: utcInstant(row.createdAt),
          })),
          has_more,
          next_cursor: has_more
            ? Buffer.from(
                JSON.stringify([actor.id, scope, rows.at(-1)!.id]),
              ).toString('base64url')
            : null,
        };
      },
    );
  } catch (error) {
    if (error instanceof PublicFailure) throw error;
    throw new PublicFailure(
      503,
      'audit.unavailable',
      'Audit events are temporarily unavailable',
    );
  }
}
