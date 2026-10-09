# Save Personal Lab Guide Progress

Goal: read and save personal guide progress with a real Member session and the same user's Agent credential. Check recovery and an unchanged shared World.

## Starting Version And Changes

Use the shared version in the [complete journey](complete-foundation.md). First read [persistent Labs and objects](persistent-world.md) to distinguish User, Entity and Scene Node identities. This chapter also works without a Lab. Run commands from the repository root.

The implementation includes [progress HTTP](../../crates/app/src/modules/lab/progress.rs), the [migration](../../migrations/0029_lab_guide_progress.sql), the [generated SDK](../../packages/sdk/src/generated/sdk.gen.ts) and [Lab ownership](../../crates/app/src/modules/lab/module.json). The Lab page does not yet use a visual guide. This chapter uses the production HTTP/SDK interface.

```bash
pnpm install --frozen-lockfile
just dev
```

Create an active `lab:full` API key as a normal Member. Reading does not create a progress record. An explicit write changes your personal progress in the development database. It does not create a Lab, object or device operation.

## Read Your Record

```bash
export LAB_API_BASE=http://127.0.0.1:3000
read -rs LAB_API_KEY
export LAB_API_KEY
node examples/lab/guide-progress.mjs
```

The example calls `GET /api/v1/lab/guides/lab-onboarding/1.0/progress` through the generated SDK. A missing record has `status=not_started` and `revision=0`. Its step, guide attempt, Lab/Entity/Node references and update time are null. Reading inserts no record. Another Member's completion does not affect your first-use state.

The response contains `current_guide_version`, `compatibility`, `progress` and `previous_progress`. Records belong to the authenticated user, guide id and version. Two Members can reference the same shared object while saving separate progress. A user's session and active Agent credential access the same record.

## Save And Recover Explicitly

```bash
LAB_GUIDE_WRITE=1 node examples/lab/guide-progress.mjs
```

The first write saves `paused/create_lab`, a UUID guide attempt and a context without a Lab. Its `business_attempt` contains a client `create_lab` key. No creation request has used this key. Saving progress creates no business object. For an existing record, the example retains its attempt, step and context. Completed progress stays `completed/complete`.

Complete example:

<<< ../../examples/lab/guide-progress.mjs

`PUT` uses the same path. Its body contains `expected_revision`, `status`, `step`, `guide_attempt_id` and `context`. Use revision 0 for a missing record. Each successful save returns a new revision. When concurrent requests use the same revision, one succeeds and the other returns `409 lab.guide_progress_conflict`.

| Status                  | Valid Input                                                |
| ----------------------- | ---------------------------------------------------------- |
| `not_started`           | Null step and guide attempt; all context fields are null   |
| `in_progress`, `paused` | UUID guide attempt and a stable step other than `complete` |
| `completed`             | UUID guide attempt and step `complete`                     |

Stable steps are `create_lab`, `register_light`, `select_entity`, `edit_placement`, `save_layout`, `return_run`, `start_program`, `light_action`, `verify_observation`, `asset_library` and `complete`. Driver.js positions, translations and object names are not persisted identities.

`context` contains nullable `lab_id`, `entity_id`, `node_id` and `business_attempt` fields. New or changed object references must belong to the stated Lab. When both Entity and Node are supplied, the Node must reference that Entity. The current user need not create the object. Renaming preserves its identity. GET retains original references after archiving or node removal. The unchanged context can still be paused. Read the public World to check actual availability.

A business attempt contains `operation=create_lab|register_entity`, nullable `target_lab_id` and `request_key`. Lab creation has no target Lab. Entity registration targets the context Lab. Keys contain 1–128 visible ASCII characters. This pointer expresses client intent and does not prove a commit. It creates or modifies no business receipt. Credentials determine the owner. Owner, receipt or committed context fields in the request return 400.

Session calls use `LAB_SESSION_COOKIE` and `LAB_SESSION_CSRF`. Writes include the normal Origin and CSRF token. Set `LAB_WEB_ORIGIN` to another configured frontend Origin when needed. Keep cookies, API keys and CSRF tokens out of source, screenshots and logs.

## Errors And Version Recovery

The example checks 400 for a forged committed context and 409 for a stale revision. It then reads the successful record again. After a lost response or failed save, GET the current record before choosing an explicit retry with its revision. Progress never proves that creation, layout saving, program startup or a command must be repeated.

An unknown guide returns `404 lab.guide_not_found`. An unsupported version rejects PUT with `400 lab.guide_version_unsupported`. GET can still return that version's original status, step and identities with `compatibility=unsupported`. It does not convert old steps.

If the current version has not started but another version has a record, GET returns `restart_required`. `previous_progress` is the most recently updated record from another version. Ask the user to inspect the old record or start the current version. Do not replay automatically. An explicit start uses a new guide attempt and the current version's revision. The old record remains readable at its original version path.

Missing CSRF, invalid Bearer tokens, expired or revoked credentials, logout and inactive membership reject access under existing authentication rules. Invalid Bearer credentials never fall back to a valid Cookie. After authentication recovery, read the same personal record. Persistence or audit failure returns 503. The old record, World, layout version and Run/Task/Command remain unchanged.

## Validate And Continue

```bash
node scripts/test-backend.mjs --test lab_progress
pnpm contracts:check
pnpm boundaries:check
pnpm docs:check
```

Router checks use isolated PostgreSQL. They cover two real Members, the same user's Agent, conflicts, old versions, unavailable targets, authentication rejection and audit failure rollback. The SDK check runs this example against a real Axum listener for GET/PUT, rejection and recovery. Progress does not advance the shared World clock, emit SSE world changes or save layout drafts. Continue through ordinary [layout editing](edit-layout.md) and [backend lighting](backend-lights.md) controls. Restoring progress does not execute those operations.
