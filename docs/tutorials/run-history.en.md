# Query Run History And Clean Expired Records

The current server uses Node 24 and TypeScript. Desktop web is the default scope. Run commands from the repository root on Linux or Windows without Docker. See [Node devices](../guides/server-devices.en.md), [synchronization](../guides/server-sync.en.md), and [operational records](../guides/server-traceability.en.md).

Goal: query a centrifuge task and its temperature reports. Change retention in an isolated development deployment. Check the records after cleanup.

## Starting Version

Use the current checkout containing this chapter's Node implementation, shared schema and device loop. Complete [centrifuge tasks](centrifuge-tasks.en.md) first. You need separate Command, Run, Task and result identities.

Run commands from the repository root. Start the services with `pnpm dev`. Members need an active session. Agents need an active `lab:full` key. Cleanup deletes persistent history in the selected Lab. Use disposable development data for short retention periods.

Source: [history HTTP](../../packages/server/src/lab/history/use-cases.ts), [retention](../../packages/server/src/lab/history/use-cases.ts), [migration](../../packages/server/migrations/0000_baseline.sql), and [history panel](../../packages/views/src/lab/history-panel.tsx).

## Query A Task And Temperature

1. Complete one centrifuge task from the previous chapter.
2. Select its Entity in Lab.
3. Select **Records** in the Entity Inspector.
4. Open **Tasks** in its **Run history** panel.

   The task shows fixed parameters, status and its separate result identity.

5. Open **Record details**.

   The panel shows the Task and Run identities. The result contains its status and end reason.

6. Open **Observations**.

   Temperature reports show `degC`. Each raw report contains only properties that the source reported at that time.

7. Set **From** to the task's preparation time.
8. Set **To** to a time after the task ended.
9. Select **Query history**.

   Inputs use local time. The browser sends UTC timestamps. Source time and received time appear separately in the details.

10. If **Earlier records** appears, select it.

The panel adds the next page. A later-page error keeps the records already loaded.

11. Open **Events**.

    Events record program, command and task status changes. They retain the related identity and actor when available.

## Query With An Agent

Create an active `lab:full` key in settings. Get the Lab and Entity UUIDs from the Inspector. Replace the placeholders below.

1. Set the API address.

   ```bash
   export LAB_API_BASE=http://127.0.0.1:3000
   ```

2. Set the Lab identity.

   ```bash
   export LAB_ID='<lab-uuid>'
   ```

3. Set the Entity identity.

   ```bash
   export LAB_ENTITY_ID='<entity-uuid>'
   ```

4. Read the key.

   ```bash
   read -rs LAB_API_KEY
   ```

5. Export the key.

   ```bash
   export LAB_API_KEY
   ```

6. Run the query example.

   ```bash
   node examples/lab/query-history.mjs
   ```

   The example reads the same task, observation, command and event records as the browser. It follows each cursor.

Complete requests and checks:

<<< ../../examples/lab/query-history.mjs

`GET /api/v1/lab/labs/{lab_id}/entities/{entity_id}/history` requires `record_type`, `from` and `to`. Record types are `observation`, `command`, `task` and `event`.

| Limit or field           | Meaning                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `from`, `to`             | RFC 3339 timestamps. The range includes `from` and excludes `to`.                                     |
| Range                    | More than zero and at most 31 days per request.                                                       |
| `limit`                  | Default 20. Allowed values are 1 through 100.                                                         |
| Response                 | At most 256 KiB. A page can contain fewer items than `limit`.                                         |
| `next_cursor`            | Continue with the same Entity, type and range. A null cursor ends the query.                          |
| Order                    | Newest first. Observations and events use received time. Commands and tasks use creation time.        |
| `observed_at`            | Source time for observations; occurrence time for events. Unknown source time remains null.           |
| `received_at`            | Reception time for observations and events; creation time for commands and tasks.                     |
| `available_since`, `gap` | Earlier history can be incomplete or removed. An empty page does not prove that no activity occurred. |

Raw observations start with this migration. Earlier measurements cannot be reconstructed from the last value. Program Runs remain queryable as source identities.

## Change Retention And Clean

Defaults retain raw observations for `86400 s` (24 hours). They retain ended commands, ended tasks and device events for `2592000 s` (30 days). Observation and event retention uses received time. Task retention starts at `ended_at`. Command retention starts at its final `updated_at`.

Both deployment values accept `1` through `31536000 s`. Invalid values prevent API startup. A configuration change takes effect after restart. Increasing retention cannot restore deleted records.

Use a disposable development stack. The following configuration removes raw observations after five seconds and ended records after one minute.

Restart interrupts existing Runs and active tasks. Start a new Run explicitly when you need another task.

1. Stop development.

Press Ctrl+C in the terminal running `pnpm dev`.

2. Set observation retention.

   ```bash
   export LAB_OBSERVATION_RETENTION_SECS=5
   ```

3. Set record retention.

   ```bash
   export LAB_RECORD_RETENTION_SECS=60
   ```

4. Start development.

   ```bash
   pnpm dev
   ```

5. Complete a short task.
6. Wait more than 60 seconds.
7. Start a task with duration `3600 s`.
8. Run explicit cleanup.

   ```bash
   node examples/lab/query-history.mjs --cleanup
   ```

   The API also runs cleanup every 60 seconds. Each call deletes at most 10,000 rows per record type. The example repeats when `more=true`.

9. Query the completed Task by its original identity.

   The API returns 404 after cleanup. Its Result and Command also expire. This includes the latest ended task.

10. Query the current Entity.

    Identity, configuration, last property values and the active task remain. Each property keeps its actual source time, receive time and freshness.

11. Query a range before the retention boundary.

    `gap=true` identifies incomplete history. Cleanup can clear `task` and `task_result` from the current world. It advances `world.version` for that change. Layout versions remain independent.

12. Stop the active task before restoring longer retention.

The API retains the Start Command needed by an active task until that task ends. An ended Command can expire before its Task. The Task keeps the original Command identity; that Command query then returns 404. Expired ended tasks have no permanent summaries.

Cleanup keeps a compact request key, normalized request fingerprint and original Command identity. It also covers Commands from before the receipt migration. History retention does not remove these receipts. A same-key retry returns `410 lab.command_expired` after the full Command expires. It never executes again. Changed parameters still return `409 idempotency.conflict`. This metadata contains no parameters, result or task history.

After `410`, check the current Entity before requesting new work. Use a new key only for an explicitly requested new operation.

## Check A Failure And Recover

1. Set a query range longer than 31 days.

   The page disables the query. Direct HTTP requests return `400 lab.invalid_input`.

2. Set a valid range.
3. Select **Query history**.

For a connection error, select **Retry history query**. An expired or revoked key requires a new active credential. Session cleanup requires CSRF. A rejected cleanup does not change history.

## Next Stage

Continue with [Entity lifecycle](entity-lifecycle.en.md) to archive a stopped device or replace its appearance independently. The [historical Foundation journey](complete-foundation.en.md) preserves its old revision and load reference; it does not select this chapter's starting revision. The complete Node client journey will be validated during the later client migration.
