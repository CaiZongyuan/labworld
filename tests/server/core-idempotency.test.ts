import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../../packages/server/src/platform/db/index.ts';
import { register } from '../../packages/server/src/core/identity/use-cases.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { coreApp } from '../../apps/server/src/app.ts';
import { defaultRateOptions } from '../../packages/server/src/core/rate-limit/domain.ts';
import { accessIn } from '../../packages/server/src/core/api-keys/authentication.ts';
import { databaseAudit } from '../../packages/server/src/core/audit/use-cases.ts';
import { PublicFailure } from '../../packages/server/src/platform/http/failure.ts';
import { sql } from '../../packages/server/src/platform/db/index.ts';
import {
  claim,
  complete,
  fingerprint,
  IdempotencyConflict,
  InvalidIdempotencyKey,
} from '../../packages/server/src/core/idempotency/use-cases.ts';
test('same-session idempotency replays normalized payload and rejects changed parameters without committing a second result', async () => {
  const db = new Database();
  try {
    await db.initialize();
    const ctx = { db, clock: { now: () => new Date().toISOString() } };
    const identity = await register(
      ctx,
      configuration().auth,
      { email: 'idempotent@example.test', password: 'a-long-test-password' },
      'register',
    );
    const first = {
      actorId: identity.session.user.id,
      scope: 'owned-core-capability',
      key: 'first-operation',
      fingerprint: fingerprint({ name: 'sample', properties: { a: 1, b: 2 } }),
    };
    await db.transaction({ id: 'first', kind: 'request' }, async (tx) => {
      assert.equal(await claim(tx, first), undefined);
      await complete(tx, first, { result_id: 'observable-receipt' });
    });
    const reordered = {
      ...first,
      fingerprint: fingerprint({ properties: { b: 2, a: 1 }, name: 'sample' }),
    };
    const replay = await db.transaction(
      { id: 'retry', kind: 'request' },
      (tx) => claim(tx, reordered),
    );
    assert.deepEqual(replay, { result_id: 'observable-receipt' });
    await assert.rejects(
      db.transaction({ id: 'changed', kind: 'request' }, (tx) =>
        claim(tx, {
          ...first,
          fingerprint: fingerprint({ name: 'different' }),
        }),
      ),
      IdempotencyConflict,
    );
    assert.deepEqual(
      await db.transaction({ id: 'readback', kind: 'request' }, (tx) =>
        claim(tx, first),
      ),
      { result_id: 'observable-receipt' },
    );
    await assert.rejects(
      db.transaction({ id: 'invalid-key', kind: 'request' }, (tx) =>
        claim(tx, { ...first, key: 'contains space' }),
      ),
      InvalidIdempotencyKey,
    );
    for (const [index, value] of [null, false, 0, ''].entries()) {
      const attempt = { ...first, key: `falsy-${index}` };
      await db.transaction(
        { id: `falsy-first-${index}`, kind: 'request' },
        async (tx) => {
          assert.equal(await claim(tx, attempt), undefined);
          await complete(tx, attempt, value);
        },
      );
      assert.equal(
        await db.transaction(
          { id: `falsy-replay-${index}`, kind: 'request' },
          (tx) => claim(tx, attempt),
        ),
        value,
      );
    }
  } finally {
    await db.close();
  }
});

test('necessary transactional capability authorizes before replay and rolls claim audit response back together on a real audit failure', async () => {
  const db = new Database();
  const policy = configuration().auth;
  const context = { db, clock: { now: () => new Date().toISOString() } };
  try {
    await db.initialize();
    const app = coreApp(context, 'test', policy, () => {}, {
      ...defaultRateOptions,
      enabled: false,
    });
    const response = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: policy.origin },
      body: JSON.stringify({
        email: 'atomic@example.test',
        password: 'a-long-test-password',
      }),
    });
    assert.equal(response.status, 201);
    const session = await response.json();
    const headers = new Headers({
      cookie: response.headers.get('set-cookie')!.split(';')[0],
      origin: policy.origin,
      'x-csrf-token': session.csrf_token,
    });
    const attempt = {
      actorId: session.user.id,
      scope: 'core-audit-capability-proof',
      key: 'atomic-result',
      fingerprint: fingerprint({ value: 'first' }),
    };
    const perform = (value: string, result: unknown = { value }) =>
      db.transaction(
        { id: 'capability-' + value, kind: 'request' },
        async (tx) => {
          const actor = await accessIn(
            tx,
            context,
            policy,
            headers,
            'lab:full',
            true,
          );
          const current = {
            ...attempt,
            actorId: actor.user.id,
            fingerprint: fingerprint({ value }),
          };
          const replay = await claim(tx, current);
          if (replay !== undefined) return replay;
          await databaseAudit.record(tx, {
            actorId: actor.user.id,
            actorType: 'user',
            action: 'audit.capability-proof',
            resourceType: 'audit.proof',
            resourceId: 'receipt',
            requestId: 'capability-' + value,
            correlationId: 'capability-' + value,
            metadata: {},
          });
          await complete(tx, current, result);
          return result;
        },
      );
    await db.script(
      { id: 'audit-fault', kind: 'startup' },
      `create function labos_threejs_core.reject_capability_audit() returns trigger language plpgsql as $$ begin if NEW.action='audit.capability-proof' then raise exception 'controlled audit failure'; end if; return NEW; end $$; create trigger reject_capability_audit before insert on labos_threejs_core.audit_events for each row execute function labos_threejs_core.reject_capability_audit();`,
    );
    await assert.rejects(perform('first'));
    const readAudit = async () => {
      const read = await app.request(
        '/api/v1/audit-events?action=audit.capability-proof',
        { headers },
      );
      assert.equal(read.status, 200);
      return (await read.json()).data;
    };
    assert.deepEqual(await readAudit(), []);
    await db.script(
      { id: 'audit-recover', kind: 'startup' },
      'drop trigger reject_capability_audit on labos_threejs_core.audit_events',
    );
    assert.equal(await perform('recovered', null), null);
    assert.equal(await perform('recovered'), null);
    await assert.rejects(perform('changed'), IdempotencyConflict);
    assert.equal((await readAudit()).length, 1);
    const signedOut = await app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers,
    });
    assert.equal(signedOut.status, 204);
    await signedOut.arrayBuffer();
    await assert.rejects(
      perform('recovered'),
      (error: unknown) =>
        error instanceof PublicFailure && error.status === 401,
    );
  } finally {
    await db.close();
  }
});

test('necessary retained idempotency storage proof keeps twenty-four hours and reclaims at most twenty-five expired records per claim', async () => {
  const db = new Database();
  try {
    await db.initialize();
    const context = { db, clock: { now: () => new Date().toISOString() } };
    const identity = await register(
      context,
      configuration().auth,
      {
        email: 'retention@example.test',
        password: 'isolated-retention-password',
      },
      'retention-register',
    );
    const actorId = identity.session.user.id;
    for (let index = 0; index < 30; index++) {
      const attempt = {
        actorId,
        scope: 'owned-retention-proof',
        key: `record-${index}`,
        fingerprint: fingerprint({ index }),
      };
      await db.transaction(
        { id: 'retention-create', kind: 'request' },
        async (tx) => {
          assert.equal(await claim(tx, attempt), undefined);
          if (index === 0) {
            const receipt = await tx.execute<{ seconds: string }>(
              sql`select extract(epoch from expires_at-now())::text as seconds from labos_threejs_core.idempotency_records where actor_id=${actorId}::uuid and scope='owned-retention-proof' and request_key=${attempt.key}`,
            );
            assert.equal(Number(receipt.rows[0].seconds), 86400);
          }
          await complete(tx, attempt, { index });
        },
      );
    }
    // Controlled expiry changes only records produced through the actual capability.
    await db.script(
      { id: 'retention-expiry-control', kind: 'startup' },
      "update labos_threejs_core.idempotency_records set expires_at=now()-interval '1 second' where scope='owned-retention-proof'",
    );
    const claimFresh = (key: string) =>
      db.transaction(
        { id: 'retention-reclaim', kind: 'request' },
        async (tx) => {
          const attempt = {
            actorId,
            scope: 'owned-retention-proof',
            key,
            fingerprint: fingerprint({ key }),
          };
          assert.equal(await claim(tx, attempt), undefined);
          await complete(tx, attempt, { key });
        },
      );
    const expiredCount = async () =>
      Number(
        (
          await db.readSQL<{ count: string }>(
            { id: 'retention-count', kind: 'request' },
            "select count(*)::text as count from labos_threejs_core.idempotency_records where scope='owned-retention-proof' and expires_at<=now()",
          )
        )[0].count,
      );
    assert.equal(await expiredCount(), 30);
    await claimFresh('fresh-one');
    assert.equal(await expiredCount(), 5);
    await claimFresh('fresh-two');
    assert.equal(await expiredCount(), 0);
    assert.deepEqual(
      await db.transaction(
        { id: 'retention-live-replay', kind: 'request' },
        (tx) =>
          claim(tx, {
            actorId,
            scope: 'owned-retention-proof',
            key: 'fresh-one',
            fingerprint: fingerprint({ key: 'fresh-one' }),
          }),
      ),
      { key: 'fresh-one' },
    );
  } finally {
    await db.close();
  }
});
