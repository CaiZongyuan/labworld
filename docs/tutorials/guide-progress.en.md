# Save private guide progress

This chapter saves the current user's Lab learning state. Continue with the existing Lab API, identity and SDK. You can start without a Lab. An existing shared Lab does not mark a new member as complete.

## Run the generated SDK example

Install dependencies and start the Node service from the repository root:

```sh
pnpm install
pnpm dev
```

Startup applies the new migration to an existing Node data directory. The service listens on `127.0.0.1:3000` by default. Create an active `lab:full` credential in the ordinary API key page. Set the environment variables:

```sh
export LAB_API_BASE=http://127.0.0.1:3000
export LAB_API_KEY='<your active lab:full credential>'
node examples/lab/guide-progress.mjs
```

The example uses generated `getLabGuideProgress` and `saveLabGuideProgress`. It reads the current user, saves a pause and submits the stale revision once. The output includes `lab.guide_progress_conflict`. A subsequent public read returns the committed record. It writes learning state only. It does not create a Lab, register objects, save layout or operate devices.

If the guide is complete, the example returns `completed_position_review` without writing. Position review preserves the original completion record.

<<< ../../examples/lab/guide-progress.mjs

## State, version and identity

Use `GET` and `PUT /api/v1/lab/guides/{guide_id}/{guide_version}/progress`. The current guide is `lab-onboarding`, version `1.0`. A missing record returns `not_started`, revision `0`, and null step, attempt, context and update time. GET does not create progress.

| State                   | Write content                                                    |
| ----------------------- | ---------------------------------------------------------------- |
| `not_started`           | Null step, guide_attempt_id and context                          |
| `in_progress`, `paused` | Stable step and UUID guide_attempt_id; step cannot be `complete` |
| `completed`             | Step `complete` and a UUID guide_attempt_id                      |

The milestones are `create_lab`, `register_light`, `select_entity`, `edit_placement`, `save_layout`, `return_run`, `start_program`, `light_action`, `verify_observation`, `asset_library` and `complete`. Names, translated text and tour-library positions are not identities.

The authenticated Member or Agent supplies ownership. PUT accepts no owner, update time or committed business receipt. Valid credentials for one user access one record. Another member has independent progress, even in the same Lab.

## Attach real context

Before creating a Lab, use null context or a creation-attempt pointer without a target Lab. After ordinary creation and registration, attach UUIDs returned by the public interfaces:

```json
{
  "expected_revision": 1,
  "status": "paused",
  "step": "edit_placement",
  "guide_attempt_id": "<guide attempt UUID>",
  "context": {
    "lab_id": "<real Lab UUID>",
    "entity_id": "<real Entity UUID>",
    "node_id": "<real Scene Node UUID>",
    "business_attempt": {
      "operation": "register_entity",
      "target_lab_id": "<same Lab UUID>",
      "request_key": "<original business attempt key>"
    }
  }
}
```

New references must belong to that Lab. The Node must match the supplied Entity. Shared objects are valid; you need not have created them. Renaming keeps the UUID. Previously validated references can remain paused after archive or Node removal. Reads never replace them with similarly named objects. Use World and object interfaces to check current availability.

`business_attempt` is client intent. `create_lab` has no target Lab. `register_entity` targets the context Lab. An unsubmitted key is legal. The pointer proves no business commit, authorizes no replay and saves no layout draft. Business receipt recovery has a separate responsibility.

## Recover after conflicts and refusals

PUT requires the current `expected_revision`. A committed save increments it once. Concurrent writes with one revision produce one success and one 409. Repeating a stale request remains a conflict, not a business replay.

After 409, GET the current record and keep the local input. Make an explicit choice before retrying with its new revision. Authentication, CSRF, reference, version and storage refusals preserve prior progress. Audit and progress failure roll back together. Public reads and writes can continue after recovery.

Session writes retain Origin and CSRF checks. Agents need active `lab:full` credentials. Expiry, revocation, logout and inactive membership refuse access. Invalid Bearer credentials never fall back to a Cookie. Sign in again to recover that user's record; shared Lab state does not determine personal progress.

Old versions remain readable with their original step and context. Their compatibility is `unsupported`. An unstarted current version with an old record returns `restart_required` and `previous_progress`. Start the current version explicitly. Old records are never converted or replayed. The example reads this choice by default; set `LAB_GUIDE_START_CURRENT=true` after confirmation.

## Limits and source

Progress changes no World, layout version, Run, Command, Task or result. Learning status proves no device success. Use formal results and valid Observation from the current source.

Requests allow 8 KiB; context allows 4 KiB. Reads allow 6 SQL statements and 12 KiB responses. Saves allow 8 statements and 6 KiB responses. Revisions are safe JSON integers; overflow is rejected. Existing World, SSE, history and bundle limits remain intact.

The [DTO](../../packages/server/src/lab/progress/dto.ts), [service](../../packages/server/src/lab/progress/use-cases.ts) and [domain limits](../../packages/server/src/lab/progress/domain.ts) own the contract. [Public HTTP checks](../../tests/server/lab-guide-progress.test.ts) cover Members, Agents, conflicts, refusals, versions and rollback. The [0001 migration](../../packages/server/migrations/0001_guide_progress.sql) preserves original baseline bytes and history. A valid older archive is verified against its original manifest before an isolated staging upgrade.
