# Use Platform Core

This guide is for developers who call or extend Lab Word Server. The Node service implements identity, sessions, memberships, API keys, audit, idempotency, limits and file capabilities. See [Node assets](server-assets.en.md) and [Node World](server-world.en.md) for persistent assets, World writes and layouts. Device programs remain in migration.

## Register and read a session

Start `pnpm dev` as described in [service foundation](server-foundation.md). You need Node 24 and pnpm. This path requires no Docker. Run this JavaScript in the browser console at `http://127.0.0.1:5173`. It writes persistent data to `data/`. Use an email from your test data. The sample password is for local testing.

```js
const registered = await fetch('/api/v1/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'core-reader@example.test',
    password: 'local-example-password-2026',
  }),
});
console.log(registered.status); // 201; an existing email returns 409
const sessionResponse = await fetch('/api/v1/auth/session');
let session = await sessionResponse.json();
console.log(session.user.role); // The first registration in a fresh directory is owner
```

Later registrations create Members. A duplicate email returns 409 and keeps the original password. Use `POST /api/v1/auth/login` with `email` and `password`, then read the session. Passwords require 12–128 Unicode characters.

The service stores password hashes and hashes of session secrets. The browser stores an HttpOnly session Cookie. HTTPS origins use Secure Cookies. `GET /auth/session` returns the user and `csrf_token`. Writes require the same Cookie, trusted `Origin` and `x-csrf-token`. Hidden buttons do not replace server authorization.

Check refusal and recovery. First, send logout without CSRF.

```js
console.log((await fetch('/api/v1/auth/logout', { method: 'POST' })).status); // 403
console.log((await fetch('/api/v1/auth/session')).status); // 200; session remains active
console.log(
  (
    await fetch('/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'x-csrf-token': session.csrf_token },
    })
  ).status,
); // 204
console.log((await fetch('/api/v1/auth/session')).status); // 401
```

Log in again to recover. Sessions have both absolute and idle deadlines. See defaults in the [configuration reference](site:reference/config.md). Logout revokes this session. It does not revoke every session for the user.

## Manage organization members

Owners and Admins use a session to call `GET /api/v1/organization/members?limit=50`. Read the next page with `next_cursor`. Do not decode cursors or reuse them across accounts. Members receive 403.

| Actor  | Current and target roles they can manage |
| ------ | ---------------------------------------- |
| Owner  | Owner, Admin, Member                     |
| Admin  | Admin, Member                            |
| Member | No member management permission          |

Update with `PUT /api/v1/organization/members/{user_id}`. A sample body is `{"role":"member","active":true,"version":1}`. Get `version` from the latest readback. Browser writes require Origin and CSRF.

An old version returns 409. Refresh the member, then decide whether to retry. Removing the last active Owner returns 422 and preserves state. Deactivation revokes the member's sessions. API keys also fail because their creator is inactive. After reactivation, the user must log in again. Unrevoked, unexpired keys can pass the creator check again. Member changes, session revocation and audit commit in one transaction.

## Create and revoke an Agent credential

Log in again and read a fresh session. Any active Member can create their own key. Use the same browser console. Store the fresh response in `session`.

```js
session = await (
  await fetch('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'core-reader@example.test',
      password: 'local-example-password-2026',
    }),
  })
).json();
const created = await (
  await fetch('/api/v1/api-keys', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': session.csrf_token,
    },
    body: JSON.stringify({
      name: 'Local Agent',
      scopes: ['profile:read', 'lab:full'],
      expires_in_days: 1,
    }),
  })
).json();
const agentHeaders = { authorization: `Bearer ${created.secret}` };
console.log((await fetch('/api/v1/profile', { headers: agentHeaders })).status); // 200
console.log(
  (
    await fetch(`/api/v1/api-keys/${created.key.id}`, {
      method: 'DELETE',
      headers: { 'x-csrf-token': session.csrf_token },
    })
  ).status,
); // 204
console.log((await fetch('/api/v1/profile', { headers: agentHeaders })).status); // 401
```

Only the creation response returns `secret`. Lists return metadata. Keep secrets, Cookies and complete signed URLs out of logs. `profile:read` permits reading the creator's profile. `lab:full` is the scope for full Lab capability. Lab routes are still pending migration. Read supported scopes at `GET /api/v1/api-keys/scopes`.

Agents cannot use keys to manage members, keys or audit. An explicit invalid Bearer returns 401, even alongside a valid session Cookie. Missing scopes return 403. Revocation, expiry or an inactive creator invalidate the credential. Operations with separate file I/O recheck the same credential in the final transaction. A fresh session or key does not reactivate an old credential.

## Read audit and request budgets

Owners and Admins use a session to read `GET /api/v1/audit-events?limit=50`. Filters support `actor_id`, `action`, `resource_type` and `resource_id`. Cursors bind the actor and filters. Audit keeps the original actor and request correlation. Metadata excludes passwords, key secrets and session values.

`GET /api/v1/system/rate-limits` exposes process metrics to Owners and Admins. Limits use the TCP peer and ignore forwarded headers. Defaults are a 60-second window and at most 4096 local buckets. Exhausted quotas return 429 and `Retry-After`. Wait for the returned seconds, then retry. The current limiter has no Redis consumer.

The business calls the [idempotency capability](../../packages/server/src/core/idempotency/use-cases.ts) inside an existing `DbSession`. Authorize before replay. Claim, business writes, audit and the saved result use one transaction. Results remain for 24 hours. Each claim reclaims at most 25 expired records. The handler maps changed parameters with the same key to 409. Later Lab handlers must connect this capability to actual business routes.

## Stop the server and reset a password

This operation changes persistent data. Stop the Server that uses the same directory first. Directory ownership rejects a second holder. Keep the directory. Do not delete the database to bypass ownership.

Run these Bash commands from the repository root. Input stays hidden. The command receives the password through stdin, outside its arguments.

```bash
read -r -s -p 'New password: ' core_password
printf '\n'
printf '%s\n' "$core_password" | pnpm reset-password --email core-reader@example.test
unset core_password
```

The default directory is `data/`. For another directory, set the same `LAB_WORD_DATA_DIR` before the command. Success prints `status: reset` and the user identity. It does not print the password. The command atomically changes the password, revokes old sessions and records `identity.password_reset`. Audit uses `actor_type: system`, `actor_id: null` and `metadata.subject_user_id` for the affected user.

Run `pnpm dev` again and log in with the new password. Old sessions and the old password return 401. Invalid input, a missing user, database failure or audit failure produce a nonzero exit. Fix the reported problem, then retry. Do not automatically replace unknown database or key files.

## Source and verification ownership

| Capability                                            | Current Node source owner                                                                                                                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composition, settings, lifecycle and password command | [apps/server](../../apps/server/src/main.ts), [config](../../apps/server/src/config.ts), [runtime](../../apps/server/src/runtime.ts), [reset-password](../../apps/server/src/reset-password.ts)       |
| Identity and sessions                                 | [Core Identity](../../packages/server/src/core/identity/use-cases.ts)                                                                                                                                 |
| Member roles and CAS                                  | [Core Organization](../../packages/server/src/core/organization/use-cases.ts)                                                                                                                         |
| API keys and exact credential rechecks                | [Core API Keys](../../packages/server/src/core/api-keys/authentication.ts)                                                                                                                            |
| Audit, idempotency and limits                         | [Audit](../../packages/server/src/core/audit/use-cases.ts), [Idempotency](../../packages/server/src/core/idempotency/use-cases.ts), [Rate Limit](../../packages/server/src/core/rate-limit/domain.ts) |
| DB queue, migrations and file I/O                     | [Platform DB](../../packages/server/src/platform/db/index.ts), [BlobStore](../../packages/server/src/platform/blob-store.ts)                                                                          |

Core does not import Lab. Application composition registers scopes and real consumers. Current JSON contracts come from Zod/OpenAPI. The official complete SDK retains the frozen contract. Migration candidates generate separately. See fields, errors, statuses and limits in the [generated reference](site:reference/api.md).

Run focused validation from the repository root:

```bash
node --test --experimental-strip-types tests/server/core-identity.test.ts tests/server/core-members.test.ts tests/server/core-keys.test.ts tests/server/core-password-command.test.ts
pnpm contracts:baseline:check
```

These checks observe refusal, readback and recovery through HTTP or the password command. See transaction, concurrency and phase ownership in the [assertion map](../testing/vnext-core-assertions.md). Continue with the [file guide](server-files.md) to publish files and business references in one transaction.
