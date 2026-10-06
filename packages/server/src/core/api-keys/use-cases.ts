import { and, desc, eq, lt } from 'drizzle-orm';
import type { FoundationContext } from '../../platform/context.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { secret, secretHash } from '../../platform/crypto.ts';
import { utcInstant } from '../../platform/db/instant.ts';
import type { AuthPolicy } from '../identity/domain.ts';
import { sessionIn, sessionValue } from '../identity/use-cases.ts';
import { databaseAudit } from '../audit/use-cases.ts';
import { apiKeys } from './schema.ts';
import {
  normalizeKey,
  secretPrefix,
  type CreateKey,
  type KeyScope,
} from './domain.ts';
const unavailable = () =>
  new PublicFailure(
    503,
    'api_keys.unavailable',
    'API keys are temporarily unavailable',
  );
const invalidPage = () =>
  new PublicFailure(
    400,
    'api_keys.invalid_page',
    'Use a valid key list cursor and page size',
  );
export function keyInfo(row: typeof apiKeys.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    created_at: utcInstant(row.createdAt),
    expires_at: utcInstant(row.expiresAt),
    revoked_at: row.revokedAt ? utcInstant(row.revokedAt) : null,
    last_used_at: row.lastUsedAt ? utcInstant(row.lastUsedAt) : null,
  };
}
export async function createKey(
  context: FoundationContext,
  policy: AuthPolicy,
  headers: Headers,
  requestId: string,
  input: CreateKey,
  supported: readonly KeyScope[],
) {
  const value = sessionValue(policy, headers, true);
  const random = secret();
  const token = secretPrefix + random;
  const hash = secretHash(token);
  try {
    const key = await context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        const actor = (await sessionIn(tx, policy, value)).user;
        const normalized = normalizeKey(input, supported);
        if (!normalized)
          throw new PublicFailure(
            400,
            'api_keys.invalid_input',
            'Choose a name, supported scopes and an expiry of 1 to 365 days',
          );
        const [created] = await tx
          .insert(apiKeys)
          .values({
            userId: actor.id,
            name: normalized.name,
            prefix: secretPrefix + random.slice(0, 8),
            secretHash: hash,
            scopes: normalized.scopes,
            expiresAt: new Date(
              Date.parse(context.clock.now()) + normalized.days * 86400000,
            ).toISOString(),
          })
          .returning();
        await databaseAudit.record(tx, {
          actorId: actor.id,
          actorType: 'user',
          action: 'api_keys.create',
          resourceType: 'api_keys.key',
          resourceId: created.id,
          requestId,
          correlationId: requestId,
          metadata: {},
        });
        return keyInfo(created);
      },
    );
    return { key, secret: token };
  } catch (error) {
    if (error instanceof PublicFailure) throw error;
    throw unavailable();
  }
}
export async function listKeys(
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
            const bytes = Buffer.from(query.cursor, 'base64url');
            if (bytes.toString('base64url') !== query.cursor)
              throw invalidPage();
            const parsed = JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(bytes),
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
          .from(apiKeys)
          .where(
            and(
              eq(apiKeys.userId, actor.id),
              cursor ? lt(apiKeys.id, cursor) : undefined,
            ),
          )
          .orderBy(desc(apiKeys.id))
          .limit(limit + 1);
        const has_more = rows.length > limit;
        rows.length = Math.min(rows.length, limit);
        return {
          data: rows.map(keyInfo),
          has_more,
          next_cursor: has_more
            ? Buffer.from(JSON.stringify([actor.id, rows.at(-1)!.id])).toString(
                'base64url',
              )
            : null,
        };
      },
    );
  } catch (error) {
    if (error instanceof PublicFailure) throw error;
    throw unavailable();
  }
}
export async function keyScopes(
  context: FoundationContext,
  policy: AuthPolicy,
  headers: Headers,
  requestId: string,
  supported: readonly KeyScope[],
) {
  const value = sessionValue(policy, headers);
  await context.db.read({ id: requestId, kind: 'request' }, (tx) =>
    sessionIn(tx, policy, value),
  );
  return { data: [...supported] };
}
export async function revokeKey(
  context: FoundationContext,
  policy: AuthPolicy,
  headers: Headers,
  requestId: string,
  id: string,
) {
  const value = sessionValue(policy, headers, true);
  try {
    await context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        const actor = (await sessionIn(tx, policy, value)).user;
        if (
          !/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(
            id,
          )
        )
          throw new PublicFailure(
            404,
            'api_keys.not_found',
            'API key not found',
          );
        const [current] = await tx
          .select()
          .from(apiKeys)
          .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, actor.id)));
        if (!current)
          throw new PublicFailure(
            404,
            'api_keys.not_found',
            'API key not found',
          );
        if (!current.revokedAt) {
          await tx
            .update(apiKeys)
            .set({ revokedAt: context.clock.now() })
            .where(eq(apiKeys.id, current.id));
          await databaseAudit.record(tx, {
            actorId: actor.id,
            actorType: 'user',
            action: 'api_keys.revoke',
            resourceType: 'api_keys.key',
            resourceId: current.id,
            requestId,
            correlationId: requestId,
            metadata: {},
          });
        }
      },
    );
  } catch (error) {
    if (error instanceof PublicFailure) throw error;
    throw unavailable();
  }
}
