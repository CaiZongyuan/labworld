# Synchronize the World and Recover Connections

Goal: observe one backend device from two browsers and an Agent, keep the last observation while disconnected, and verify that revoking a credential ends its existing subscription.

## Starting Version and Changes

Start at `240294a`, after [editing layouts and registering locations](edit-layout.md). Persistent worlds, independent device programs, and layout drafts already exist. This chapter implements [Issue #8](https://github.com/CaiZongyuan/labworld/issues/8). Use a checkout containing this chapter and run commands from the repository root. Browser operations write to the development database.

Implementation: [transactional world versions](../../migrations/0023_lab_world_version.sql), [public SSE API](../../crates/app/src/modules/lab/sync.rs), [SDK subscriptions and version application](../../packages/sdk/src/lab-world.ts), [page subscriptions](../../packages/views/src/lab/world-subscription.ts), and [Lab ownership](../../crates/app/src/modules/lab/module.json). Existing migration checksums remain intact.

## Two Browsers Observe One Device

```bash
pnpm install --frozen-lockfile
just dev
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

World versions are deployment-wide, transactionally ordered decimal strings. Compare them with `BigInt` only within the same Lab and query scope. They cover different Entities, Runs, observations, structure, and referenced assets. They remain separate from `layout_version`; one device's `sequence` cannot version the whole world. The same version expresses the same persistent facts. Intermediate states may coalesce into the latest state: this is not a historical event stream. Later work adds history.

The SDK's `subscribeLabWorld({client,labId,signal,headers,onWorld,onEvent})` has a separate stream lifetime. Ordinary `createApiClient` HTTP requests keep their five-second timeout; subscriptions detect a connection with no messages for ten seconds. `onWorld` runs only after a complete snapshot or valid update. Duplicate and old versions are ignored. A mismatched `base_version` throws `WorldSyncError`; reopen the subscription to restore a snapshot. The page reconnects automatically or manually, and cancels the old stream on navigation, Lab changes, or identity changes.

World and single-Entity reads return `X-Lab-Runtime: ready | unavailable`; subscriptions send `runtime_status.available`. These describe the separate immediate execution service. `capabilities.executable`/`reason` describe persistent Binding and Run constraints. An operation requires both capability permission and a ready service. The Inspector combines them and shows when the runtime is not ready. Service changes do not silently rewrite device facts at the same version. Action routes still return `503 lab.runtime_unavailable` while unavailable.

Event JSON is limited to 1 MiB and the server queues at most eight events. The client also bounds unfinished frames. Overflow discards pending events, sends a priority `resync` with `slow_client`, and closes. Oversized updates use `payload_limit`; unavailable sources use `source_unavailable`. Reopening restores a snapshot without unlimited buffering. An initial snapshot exceeding the limit returns `413 lab.snapshot_too_large`; reduce the Lab's object/configuration size and retry. Credentials are checked on each polling cycle, which targets 250ms, and before queued-frame delivery. Database delays can extend the polling interval; source/check timeouts close the stream, and invalid access ends it.

## Verification and Next Stage

```bash
node scripts/test-backend.mjs --test lab_sync --test lab_assets
pnpm test:frontend apps/web/src/lab-sync.test.tsx packages/sdk/src/lab-world.test.ts
node scripts/e2e.mjs tests/e2e/lab-sync.spec.ts
```

Real Router tests with isolated PostgreSQL cover handoff, versions, revocation, and bounded queues. Page tests replace only HTTP through MSW. The critical journey uses two real browsers, an Agent, backend programs, and WebGL. [The next chapter](continuous-temperature.en.md) uses these property contracts to read continuous temperatures and expiry. [Issue #11](https://github.com/CaiZongyuan/labworld/issues/11) verifies the full combination of drafts and network recovery.
