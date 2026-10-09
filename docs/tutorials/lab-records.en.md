# Query Records Across A Lab

The current server uses Node 24 and TypeScript. Desktop web is the default scope. Run commands from the repository root on Linux or Windows without Docker. See [Node devices](../guides/server-devices.en.md), [synchronization](../guides/server-sync.en.md), and [operational records](../guides/server-traceability.en.md).

Goal: read Command, Task, Event and device program Run records in the workbench. Open an original record and export the current page. The generated SDK provides the same bounded query.

## Starting State

Use a source version with the [records query](../../packages/server/src/lab/records/use-cases.ts) and [records view](../../packages/views/src/lab/records-panel.tsx). Complete [centrifuge tasks](centrifuge-tasks.en.md) or [backend lighting](backend-lights.en.md) first. The Lab needs real Runs, Commands and events. A centrifuge action also creates a Task.

Run commands from the repository root. Run `pnpm install --frozen-lockfile`, then `pnpm dev`. Members need an active session. Agents need an active `lab:full` key. These queries do not change World or clean records.

Sources: [mixed records](../../packages/server/src/lab/records/list.sql), [category coverage](../../packages/server/src/lab/records/coverage.sql), and [deployment retention](../../packages/server/src/lab/history/use-cases.ts). Node Zod/OpenAPI generates the official SDK.

## Read And Download In The Workbench

1. Open `http://127.0.0.1:5173/lab`. Sign in as a Member.
2. Select the previous chapter's Lab in “Open Lab”. “3D space” is the default view.
3. Select “Lab records”. The page reads mixed records from the past 24 hours, with at most 20 items per page.
4. Select a device and “Record category”. Enter start and end times, then select “Query records”. Inputs use local time. The query upper bound keeps the server's original ISO value.
5. Select “Earlier Lab records”. The next page replaces the current page and keeps the same upper bound. “Refresh Lab records” starts a new first-page query.
6. Select “View original record”. Check Entity, Run, Binding, Command, Task, Result and actor provenance. Missing facts show “Unknown”. Known retention gaps appear separately.
7. For a completed Task, select “Open original Entity”. The Inspector shows the result saved with that record. Later device results cannot replace it.
8. Select “Records” in the Inspector, then “Observations”. The device's raw Observation history remains available.
9. Return to “Lab records”. Select “Export current page CSV”. The download contains only the loaded page, with at most 100 items. Filters remain unchanged.

The CSV uses UTF-8 and preserves original ISO timestamps. Quotes, commas and line breaks use CSV escaping. Possible spreadsheet formulas receive a leading apostrophe. Downloading sends no history request and does not write World. See [current-page download](../../packages/views/src/lab/records-csv.ts).

Set the end time before the start time. “Query records” becomes unavailable, and the loaded page stays visible. Restore a valid range and query again. A failed network query keeps the last loaded page and identifies its actual scope. Select “Retry records query” to repeat the failed request. CSV is unavailable until a new filter succeeds.

Select “Open run history” in 3D space to expand the same Lab records. On a narrow screen, closing history restores the selected Entity and trigger focus. Closing the full records view focuses “3D space”. Switching views preserves the selected Entity and unsaved layout draft.

[Recent activity](../../packages/views/src/lab/recent-activity.tsx) provides at most five first-page items for a future overview consumer. It has no pagination or history export. Refresh starts a new query. The current default entry remains 3D space.

## Read Two Pages

1. Get the Lab UUID from the Inspector.
2. Create a `lab:full` key in settings.
3. Set the API address and Lab identity.

   ```bash
   export LAB_API_BASE=http://127.0.0.1:3000
   export LAB_ID='<lab-uuid>'
   ```

4. Read and export the key.

   ```bash
   read -rs LAB_API_KEY
   export LAB_API_KEY
   ```

5. Run the example.

   ```bash
   node examples/lab/query-records.mjs
   ```

   `pages` contains at most two pages. Each page defaults to 20 items. The last page keeps `next_cursor` when more records remain. This is not a complete history export.

Complete SDK calls and checks:

<<< ../../examples/lab/query-records.mjs

The script uses the application's generated SDK. It checks order, bytes and identities. It sends an invalid `limit=101`, then repeats a valid query. The invalid query returns 400. The recovery query returns 200.

Members can use `LAB_SESSION_COOKIE` instead. Use the current `labos_threejs_session=...` Cookie value. HTTPS deployments use `__Host-labos_threejs_session=...`. Both credentials read the same facts. Neither credential determines a historical actor.

## Filter And Continue

Set `LAB_ENTITY_ID='<entity-uuid>'` to read one device. Omit it to read all objects, including retained records for archived Entities.

Set `LAB_RECORD_TYPE` to `command`, `task`, `event` or `run`. Omit it to mix all four categories. Raw Observations remain available through [device history](run-history.en.md).

Use `LAB_RECORDS_FROM` and `LAB_RECORDS_TO` for RFC 3339 timestamps. The range includes `from` and excludes `to`. Its duration must exceed zero and cannot exceed 31 days.

```bash
export LAB_RECORDS_FROM=2026-10-04T00:00:00Z
export LAB_RECORDS_TO=2026-10-05T00:00:00Z
export LAB_RECORDS_LIMIT=2
node examples/lab/query-records.mjs
```

`GET /api/v1/lab/labs/{lab_id}/records` accepts the same parameters. `limit` defaults to 20 and accepts 1 through 100. Continue with the same range, Entity, category and `next_cursor`. Remove the cursor when you change filters.

The first page fixes `query_upper_bound=min(to, queried_at)`. Later pages keep this bound. Start a new query without a cursor to refresh. Records sort by descending `recorded_at`, category name and UUID. Equal timestamps retain a stable order.

| Field or category                          | Meaning                                                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Command / Task `recorded_at`               | Original creation time. A Task retains its identity, parameters, result and `command_id`.          |
| Event `recorded_at`                        | Original receive time. `data` retains occurrence time when recorded.                               |
| Run `recorded_at`                          | Immutable `started_at`. The response separately returns real `ended_at` and `state`.               |
| `actor_id` / `actor_source` / `actor_role` | Proven initiator identity, request source and role. Missing facts remain null or `unknown`.        |
| `source` / `binding_id` / `run_id`         | The original Run's Binding and simulated or physical source. Current Bindings do not replace them. |
| `archived_at`                              | Entity archive time. Archiving does not remove retained records.                                   |

Commands use persistent `actor_source`. Tasks obtain their initiator from the related Command. After Command cleanup, a Task keeps `command_id` and reports an unknown initiator.

A Run's `started_by` identifies only its initiator. It cannot prove a Member/Agent request source or a stop operator. Old program stop events may contain only the initiator. This query reports an unknown stop operator for those events. State changes do not move the Run's record time or create a Stop Command.

## Read Retention And Recover

`retention` reports the deployment's actual policy. Defaults retain raw Observations for 24 hours and ended Commands/Tasks plus Events for 30 days. Run `coverage.retention_seconds` is null. This query adds no Run cleanup rule.

`coverage` reports capture, complete capture, cleanup and retained record bounds for each requested category. Oldest and newest record times refer to the requested range. `gaps` marks known incomplete `capture`, `partial_capture` and `retention` intervals.

`available_since` marks a potentially complete boundary. Unfinished Commands/Tasks and recently ended records can start before this boundary. `preserves_unfinished` identifies this exception. An empty page cannot prove that earlier activity never occurred. A query cannot restore cleaned facts.

Each page permits at most 100 items and 256 KiB. Large records reduce the page size. A cursor retains the remaining items. A single oversized record returns `413 lab.records_too_large`. Narrow the range or category, then start another query.

Unknown parameters, invalid ranges, categories and bad cursors return 400. Unknown or foreign Entities return 404. Invalid, expired or revoked credentials return 401. Keys without `lab:full` return 403. Correct the input or credentials, then start without a cursor. Rejected reads do not change World, records or device Tasks.

Continue with [device history](run-history.en.md) to inspect raw Observations and the deployment's retention policy.
