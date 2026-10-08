# Complete Digital Laboratory Journey

Goal: build one Lab with a Member and an Agent. Import appearances, place objects, run devices, query results and archive an Entity.

## Starting Version

Use the Foundation V1 checkout containing this chapter and migrations `0018` through `0028`. The preceding integration baseline is `c6c3063`. Keep this checkout for every chapter. All capabilities below are implemented with persistent server data and backend virtual programs.

Run commands from the repository root in Bash. You need curl, Node, pnpm, Rust and Docker. See [Quick start](../getting-started/quickstart.en.md). Use disposable development data. The following operations create persistent assets, Entities and records. They are not an isolated preview.

Members need an active session. Session writes require CSRF. Agents need an active `lab:full` API key. Both callers have full Lab access and follow the same business rules.

1. Install the locked dependencies.

   ```bash
   pnpm install --frozen-lockfile
   ```

2. Start the development stack.

   ```bash
   pnpm dev
   ```

3. Open <http://127.0.0.1:5173/lab>.
4. Sign in as a Member.
5. Create an empty Lab named `Complete Foundation Lab`.

   The object directory is empty. Lab data now persists on the server.

6. Open **Settings → API keys**.
7. Create a key with the `lab:full` scope.

   Keep `pnpm dev` running in the development terminal. Stopping it drains Node and Web and preserves the selected data directory.

8. Open a second Bash terminal in the repository root.
9. Set the API address printed by your development stack.

   ```bash
   export LAB_API_BASE=http://127.0.0.1:3000
   ```

10. Read the API key without displaying it.

    ```bash
    read -rs LAB_API_KEY
    ```

11. Export the key.

    ```bash
    export LAB_API_KEY
    ```

12. Query the Lab list.

    ```bash
    curl --fail --silent --show-error \
      --header "Authorization: Bearer $LAB_API_KEY" \
      "$LAB_API_BASE/api/v1/lab/labs?limit=100"
    ```

    Find `Complete Foundation Lab` in `data`. Its `id` is the Lab UUID. If `has_more=true`, continue with `next_cursor`.

13. Set that UUID as `LAB_ID`.

    ```bash
    export LAB_ID='<lab-uuid>'
    ```

Use this second terminal and the same `LAB_ID` for the remaining commands. Replace placeholder UUIDs with response values.

## Build And Operate One World

The scripts are the complete requests from the preceding chapters. Their assertions check the public HTTP results.

1. Import the repository's Draco fixture as an Agent.

   ```bash
   node examples/lab/import-asset.mjs tests/fixtures/lab/cube-draco.glb
   ```

   Record the returned `id` and `representation_id`. The downloaded bytes match the uploaded SHA-256.

2. Open **Asset library** in the Member's browser.
3. Import `tests/fixtures/lab/cube-basis.glb`.
4. Publish the asset.

   The library contains both imports and the built-in categories. Use the repository fixtures for this exercise. Supply accurate source and license metadata for your own files.

5. Open the same Lab.
6. Register `Member model` from **Custom model · 1.0**, using the Basis asset appearance.
7. Register a static Environment from **Laboratory space · 1.0**.
8. Register independent descriptive Robots as an Agent.

   ```bash
   node examples/lab/register-world.mjs
   ```

   `Robot A` and `Robot B` have different Entity identities. Their declared actions return `422 lab.capability_not_implemented`.

9. Add the bench, Labware and explicit relationships.

   ```bash
   node examples/lab/edit-layout.mjs
   ```

   The script reuses `LAB_ID`. It checks manual provenance, conflicts, independent copies, multiple nodes and remove/restore.

10. Run two independent lights.

    ```bash
    node examples/lab/control-lights.mjs
    ```

    The script checks observations, same-key retries, changed-parameter rejection and retained readings after Stop.

11. Run two independent temperature sources.

    ```bash
    node examples/lab/observe-temperature.mjs
    ```

    Each reading has `degC`, timestamps, source and freshness. One stopped source expires while the other continues. Explicit startup creates a new Run.

12. Run two centrifuge Tasks.

    ```bash
    node examples/lab/run-centrifuges.mjs
    ```

    One Task completes after preparation, six seconds at target and deceleration. The other becomes cancelled after Stop and deceleration. Both devices return to idle. Record the first `entity_id`.

13. Read a world snapshot through the subscription.

    ```bash
    node examples/lab/observe-world.mjs --once
    ```

    The output identifies a persistent world version. Service readiness remains separate from that version.

14. Set the completed centrifuge Entity UUID.

    ```bash
    export LAB_ENTITY_ID='<first-centrifuge-entity-uuid>'
    ```

15. Query its retained records.

    ```bash
    node examples/lab/query-history.mjs
    ```

    The completed Task contains its result. Observations, Commands and events have their own timestamps. A `gap` identifies unavailable earlier history.

## Recover A Draft And A Device

Use the selected centrifuge and an independent browser signed in to the same deployment. Its Task has ended, but its program still runs.

1. Open the same Lab in the second browser.
2. Select the centrifuge in the first browser.
3. Select **Edit layout**.
4. Set **X (m)** to `2.25`.
5. Disconnect the first browser's network.

   **Disconnected** appears. The last world and the `2.25` draft remain visible.

6. Restore its network.

   **Live** returns. The draft still contains `2.25`.

7. Save the layout.

   Both browsers and the API now show the saved Placement. Registered relationships keep their meaning and provenance.

8. Remove the device's Scene Node.
9. Save the layout.

   The Entity and retained Run, Task and result remain queryable.

10. Select **Unplaced objects only**.
11. Select the device.
12. Add another representation of the same object.
13. Save the layout.

    A new node represents the original Entity. Device and record identities remain unchanged.

Unsaved drafts survive connection recovery and Lab switching in the current page. They do not survive leaving or refreshing that page. Save before refresh. For `409 lab.layout_conflict`, use **Reload and keep draft**, then **Retry save**. See [layout recovery](edit-layout.en.md).

## Archive And Keep The Result

An active Run or unfinished Task blocks archive and definition changes. A Stop command does not end a centrifuge Task until deceleration finishes.

1. Select **Stop program** on the completed centrifuge.
2. Set the imported Draco representation UUID.

   ```bash
   export LAB_REPRESENTATION_ID='<draco-representation-uuid>'
   ```

3. Set its Asset UUID.

   ```bash
   export LAB_ASSET_ID='<draco-asset-uuid>'
   ```

4. Run the lifecycle requests.

   ```bash
   node examples/lab/manage-entity.mjs
   ```

   The script checks running rejection, appearance replacement, explicit definition selection, archive and reference protection. The Entity keeps its completed Task and result. Old Runs retain their original definition and source.

5. Open **Archived objects** in either browser.
6. Select the archived Entity.
7. Query its Task or history through the same public paths.

   New program startup returns `409 lab.entity_archived`. The viewport hides archived nodes. Their saved data and asset references remain. An arbitrary GLB does not acquire a rotor mapping.

## Reproduce The Reference Load

These checks create disposable services on free ports. They do not use development data. Each command removes its resources when it ends. Existing limits remain enabled.

The two browser commands each create PostgreSQL, Redis, object-storage and mail services. Their separate stacks keep preceding requests outside the reference load's per-IP rate-limit window.

1. Run the complete journey.

   ```bash
   node --experimental-strip-types scripts/e2e-server.mjs tests/e2e/lab-foundation.spec.ts
   ```

2. Run the reference load.

   ```bash
   E2E_LAB_REFERENCE_LOAD=1 node --experimental-strip-types scripts/e2e-server.mjs tests/e2e/lab-reference-load.spec.ts
   ```

3. Run the deterministic Lab HTTP budgets.

   ```bash
   node scripts/test-backend.mjs --test perf_lab --test lab_sync --test lab_history
   ```

The reference scene contains 100 Entities and 100 placed, unarchived nodes. Twenty temperature programs target one report per second. Two Chromium browsers load the same Lab. Seventy-seven model nodes share two independent uploaded assets: Draco geometry and a Basis texture fixture.

The report records each device's actual report count, model and embedded texture bytes, browser, hardware, storage, snapshots, SSE payloads and render samples. Application evidence stays in `.scratch/foundation-v1/application/`. Document browser output uses a separate directory.

| Contract                                                       | Bound                                    |
| -------------------------------------------------------------- | ---------------------------------------- |
| World snapshot SQL statements, including Member authentication | 10, independent of 1 or 100 Entities     |
| SSE event                                                      | 1 MiB                                    |
| Pending SSE events                                             | 8; overflow emits resync and closes      |
| Lab, asset and history page                                    | At most 100 items                        |
| History response                                               | 256 KiB                                  |
| History time range                                             | At most 31 days                          |
| Entities and Scene Nodes per Lab                               | At most 1000 each                        |
| Layout body                                                    | 512 KiB; at most 1000 relationships      |
| Initial / asynchronous JavaScript gzip                         | 400 / 500 KiB, checked by `just perf-ci` |

The world snapshot includes the complete bounded Lab; it has no Entity cursor. Lists and history use their documented cursors. `scripts/perf/baselines.json` records deterministic budgets. The slow-client Router check verifies backlog behavior independently of browser timing.

FPS, HTTP latency and memory samples describe this browser and hardware only. They are not cross-machine thresholds or proof of a memory leak. The fixtures are small. These results do not predict behavior for large scanned models or large textures.

## Continue To Physical Equipment

Foundation V1 delivers persistent worlds, built-in virtual programs, shared Member/Agent APIs, recovery, history and lifecycle operations. The accepted preview supplies the visual baseline; production has no time multiplier or scenario toolbar.

Physical protocol integration, robot motion, user code, autonomous experiment planning and scientific simulation remain future scope. Register physical equipment as a separate Entity. Keep simulated and physical observations and records separate. A future adapter must preserve source identity, per-property time/quality, command idempotency and interrupted-Run recovery. See [product scope](../architecture/lab-word.en.md) and [ADR 0007](../adr/0007-separate-simulated-and-physical-entity-identities.md).
