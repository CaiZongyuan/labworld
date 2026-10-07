# Query Records Across A Lab

The current server uses Node 24 and TypeScript. Desktop web is the default scope. Run commands from the repository root on Linux or Windows without Docker. See [Node devices](../guides/server-devices.en.md), [synchronization](../guides/server-sync.en.md), and [operational records](../guides/server-traceability.en.md).

Goal: read Command, Task, Event and device program Run records through the generated SDK. Filter records and continue with a stable cursor.

## Starting State

Use a source version that contains [records.rs](../../packages/server/src/lab/records/use-cases.ts). Complete [centrifuge tasks](centrifuge-tasks.en.md) or [backend lighting](backend-lights.en.md) first. The Lab needs real Runs, Commands and events. A centrifuge action also creates a Task.

Run commands from the repository root. Run `pnpm install --frozen-lockfile`, then `pnpm dev`. Members need an active session. Agents need an active `lab:full` key. These queries do not change World or clean records.

Sources: [mixed records](../../packages/server/src/lab/records/list.sql), [category coverage](../../packages/server/src/lab/records/coverage.sql), and [deployment retention](../../packages/server/src/lab/history/use-cases.ts). Node Zod/OpenAPI supplies the migrated contract. The official SDK source switch follows.

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

Later workbench views can reuse this query. This chapter verifies HTTP and SDK behavior directly. It does not require a future records page.
