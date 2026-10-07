# Synchronize One World with Node

Goal: let two browsers and an Agent read the same device facts. Complete [device programs](server-devices.en.md) first. Run `pnpm dev` and prepare two active Member sessions. Run commands from the repository root. Subscriptions do not clean history.

## Observe Another Window's Operation

1. Open the same Lab in two independent browsers.
2. Select a light Entity in the first page and turn its power on.
3. Select the same Entity in the second page.

The second page reads the same Observation, Binding and Run from the server. It does not generate authoritative device state in the browser.

Use the same `lab:full` key with an Agent:

```bash
export LAB_API_BASE=http://127.0.0.1:3000
export LAB_ID='<existing-lab-uuid>'
read -rs LAB_API_KEY
export LAB_API_KEY
node examples/lab/observe-world.mjs
```

<<< ../../examples/lab/observe-world.mjs

`GET /api/v1/lab/labs/{lab}/world/subscribe` sends snapshot first, then `runtime_status`. Each update names the previous `base_version`. Reconnect starts with a fresh snapshot. The client reads a new world when versions are not continuous.

## End Access for an Old Credential

Log out the subscribed session or revoke its Agent key. The old connection sends `access_ended` and closes. Another login for the same user cannot revive it. Subscribe with a new active credential to receive the current snapshot.

The server checks the original credential every 250ms and again before each queued delivery. Checks do not refresh session idle time. Invalid identity, membership or scope discards queued business events.

Events allow 1 MiB each and eight pending events. An oversized initial snapshot returns 413. Later overflow or a slow consumer receives resync and closes. Terminal events take priority over queued content. Reconnect recovers without retaining the old queue.

[Shared World projection](../../packages/server/src/lab/world/use-cases.ts), [subscription producers and Body delivery](../../packages/server/src/lab/world/subscriptions.ts), and [original credential checks](../../packages/server/src/core/api-keys/authentication.ts) own these facts. Startup creates the production loop. Each database operation has a finite measurement scope.

Continue with [Node operational records](server-traceability.en.md).
