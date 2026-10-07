# Synchronize the World and Recover Connections

The current server uses Node 24 and TypeScript. Desktop web is the default scope. Run commands from the repository root on Linux or Windows without Docker. See [Node devices](../guides/server-devices.en.md), [synchronization](../guides/server-sync.en.md), and [operational records](../guides/server-traceability.en.md).

Goal: observe one backend device from two browsers and an Agent, keep the last observation while disconnected, and verify that revoking a credential ends its existing subscription.

## Starting Version and Changes

Use the current checkout containing this chapter's Node implementation. Complete [Node device programs](../guides/server-devices.en.md) first. You need a persistent world and device programs. Run commands from the repository root. Browser operations write development data.

Implementation: [transactional world versions](../../packages/server/migrations/0000_baseline.sql), [public SSE API](../../packages/server/src/lab/world/subscriptions.ts), [SDK subscriptions and version application](../../packages/sdk/src/lab-world.ts), [page subscriptions](../../packages/views/src/lab/world-subscription.ts), and [Lab ownership](../../packages/server/src/lab/ownership.json). Node uses the shared retained schema.

## Two Browsers Observe One Device

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:5173/lab> as an ordinary Member. Reuse the Lab and `Light A` from [backend lighting control](backend-lights.md), start its program, and turn it on. In a second browser, sign in to the same organization and open the same Lab and Entity. Both show **Live**. The Inspector and lampshade use the same device observation. The footer's `W` number is the world version; the title's `v` number remains the independent layout version.

Change brightness in browser A. B updates without a refresh. Put B Offline through its developer tools. It shows **Disconnected** while keeping the last observation and scene; the backend program continues. Change brightness again in A. Restore B Online: it reconnects automatically and restores the latest snapshot. **Reconnect** also opens a new subscription. Layout drafts stay separate: observations neither enter the draft nor overwrite unsaved placement.

## Agent Subscription and Revocation

Create a valid `lab:full` API key in Settings and obtain the Lab UUID from the Inspector. In a separate terminal:

```bash
export LAB_API_BASE=http://127.0.0.1:3000
export LAB_ID=<lab-uuid>
read -rs LAB_API_KEY
export LAB_API_KEY
node examples/lab/observe-world.mjs --reconnect
```

The script prints a `snapshot`, version, Entity/Run identities, and last reported values. Change brightness in the browser: it prints an `update`, deliberately closes once, then obtains the latest `snapshot`. Browser and Agent have the same facts at the same world version. Animation requires no network messages for individual render frames.

Keep the terminal running and revoke that key in Settings. The existing stream prints `access_ended` and exits. Running it again returns HTTP 401. Member logout, session expiry, and inactive membership also end existing access. Ctrl+C cancels the request and releases the stream.

Complete requests and cancellation:

<<< ../../examples/lab/observe-world.mjs

## Public Protocol and Limits

`GET /api/v1/lab/labs/{lab_id}/world/subscribe` accepts a session Cookie or `Authorization: Bearer …` and returns `text/event-stream`. The first `snapshot` contains a complete `LabWorld`. An `update` contains `version`, `base_version`, an optional `lab`, and `changes` for independently identified `entities`, `nodes`, `assets`, and `relationships`. A `patch` contains changed top-level properties; `null` removes the item. New items contain every property. Observations update their Entity rather than sending render frames.

World versions are deployment-wide, transactionally ordered decimal strings. Compare them with `BigInt` within the same Lab and query scope. They cover Entities, Runs, observations, structure and referenced assets. They remain separate from `layout_version`. One device's `sequence` cannot version the whole world. The same version expresses the same persistent facts. Intermediate states may coalesce into the latest state. They do not form a complete historical event stream. Query implemented [run history](run-history.en.md) for records within retention.

The SDK's `subscribeLabWorld({client,labId,signal,headers,onWorld,onEvent})` has a separate stream lifetime. Ordinary `createApiClient` HTTP requests keep their five-second timeout; subscriptions detect a connection with no messages for ten seconds. `onWorld` runs only after a complete snapshot or valid update. Duplicate and old versions are ignored. A mismatched `base_version` throws `WorldSyncError`; reopen the subscription to restore a snapshot. The page reconnects automatically or manually, and cancels the old stream on navigation, Lab changes, or identity changes.

World and single-Entity reads return `X-Lab-Runtime: ready | unavailable`; subscriptions send `runtime_status.available`. These describe the separate immediate execution service. `capabilities.executable`/`reason` describe persistent Binding and Run constraints. An operation requires both capability permission and a ready service. The Inspector combines them and shows when the runtime is not ready. Service changes do not silently rewrite device facts at the same version. Action routes still return `503 lab.runtime_unavailable` while unavailable.

Event JSON is limited to 1 MiB and the server queues at most eight events. The client also bounds unfinished frames. Overflow discards pending events, sends a priority `resync` with `slow_client`, and closes. Oversized updates use `payload_limit`; unavailable sources use `source_unavailable`. Reopening restores a snapshot without unlimited buffering. An initial snapshot exceeding the limit returns `413 lab.snapshot_too_large`; reduce the Lab's object/configuration size and retry. Credentials are checked on each polling cycle, which targets 250ms, and before queued-frame delivery. Database delays can extend the polling interval; source/check timeouts close the stream, and invalid access ends it.

## Verification and Next Stage

```bash
pnpm test:contract:server
pnpm test:frontend apps/web/src/lab-sync.test.tsx packages/sdk/src/lab-world.test.ts
node --experimental-strip-types scripts/e2e-server.mjs tests/e2e/lab-node-assets-world.spec.ts
```

HTTP contracts use the real Hono Router and an isolated embedded PGlite database to check versions, revocation and reconnect. Controlled runtime supplements check handoff and bounded Body queues. Page tests replace only HTTP with MSW. The listed Node browser entrypoint checks Asset, World, layout conflicts and WebGL; the complete device journey with two browsers and an Agent will be validated during the later client migration. [The next chapter](continuous-temperature.en.md) reads continuous temperatures and expiry. The [historical Foundation journey](complete-foundation.en.md) preserves its old revision, drafts and network recovery reference; it does not select this chapter's starting revision.
