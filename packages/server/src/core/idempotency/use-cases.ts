import { sql, type DbSession } from '../../platform/db/index.ts';
import { secretHash } from '../../platform/crypto.ts';
export type Attempt = {
  actorId: string;
  scope: string;
  key: string;
  fingerprint: Buffer;
};
export class IdempotencyConflict extends Error {}
export class InvalidIdempotencyKey extends Error {}
export function fingerprint(value: unknown) {
  const encoded = JSON.stringify(value, (_, part) =>
    part !== null && typeof part === 'object' && !Array.isArray(part)
      ? Object.fromEntries(
          Object.keys(part)
            .sort()
            .map((key) => [key, part[key]]),
        )
      : part,
  );
  if (encoded === undefined) throw new Error('Idempotency payload is not JSON');
  return secretHash(encoded);
}
// Caller owns authorization and the transaction containing business, audit and response.
export async function claim(
  tx: DbSession,
  attempt: Attempt,
): Promise<unknown | undefined> {
  if (!/^[\x21-\x7e]{1,128}$/.test(attempt.key))
    throw new InvalidIdempotencyKey(
      'Use an ASCII idempotency key of 1–128 bytes',
    );
  await tx.execute(
    sql`delete from labos_threejs_core.idempotency_records where (actor_id,scope,request_key) in (select actor_id,scope,request_key from labos_threejs_core.idempotency_records where expires_at<=now() order by expires_at limit 25)`,
  );
  const result = await tx.execute<{
    fingerprint: Buffer;
    response: unknown;
    completed: boolean;
  }>(
    sql`insert into labos_threejs_core.idempotency_records as old(actor_id,scope,request_key,fingerprint) values(${attempt.actorId}::uuid,${attempt.scope},${attempt.key},${attempt.fingerprint}) on conflict(actor_id,scope,request_key) do update set fingerprint=case when old.expires_at<=now() then excluded.fingerprint else old.fingerprint end,response=case when old.expires_at<=now() then null else old.response end,expires_at=case when old.expires_at<=now() then excluded.expires_at else old.expires_at end returning fingerprint,response,response is not null as completed`,
  );
  const stored = result.rows[0];
  if (!Buffer.from(stored.fingerprint).equals(attempt.fingerprint))
    throw new IdempotencyConflict(
      'The idempotency key was used with different parameters',
    );
  return stored.completed ? stored.response : undefined;
}
export async function complete(
  tx: DbSession,
  attempt: Attempt,
  response: unknown,
) {
  const encoded = JSON.stringify(response);
  if (encoded === undefined)
    throw new Error('Idempotency response is not JSON');
  const result = await tx.execute(
    sql`update labos_threejs_core.idempotency_records set response=${encoded}::jsonb where actor_id=${attempt.actorId}::uuid and scope=${attempt.scope} and request_key=${attempt.key} returning request_key`,
  );
  if (result.rows.length !== 1)
    throw new Error('Idempotency attempt is unavailable');
}
