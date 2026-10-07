# Run Centrifuge Tasks And Recover After Restart

The current server uses Node 24 and TypeScript. Desktop web is the default scope. Run commands from the repository root on Linux or Windows without Docker. See [Node devices](../guides/server-devices.en.md), [synchronization](../guides/server-sync.en.md), and [operational records](../guides/server-traceability.en.md).

Goal: complete one centrifuge task and cancel another. Query their separate identities. Keep the results after browsers close and the backend restarts.

## Starting Version

Use the common version specified in the [complete journey](complete-foundation.en.md). Complete [continuous temperature](continuous-temperature.en.md) first. You need backend Runs and property observations.

Run commands from the repository root. The operations write persistent development data. Members need an active session. Agents need an active `lab:full` API key.

Source: [task HTTP contract](../../packages/server/src/lab/devices/routes.ts), [backend program](../../packages/server/src/lab/devices/domain.ts), [migration](../../packages/server/migrations/0000_foundation.sql), and [task panel](../../packages/views/src/lab/centrifuge-panel.tsx).

## Complete One Task

1. Install dependencies.

   ```bash
   pnpm install --frozen-lockfile
   ```

2. Start development.

   ```bash
   pnpm dev
   ```

3. Open <http://127.0.0.1:5173/lab>.
4. Create or open a Lab.
5. Select **Register object**.
6. Select `centrifuge@1.0`.
7. Enter `Centrifuge A` in the name field.
8. Select **Register**.
9. Select **Start program**.

   The API creates a Device Program Run. Its first observation shows idle. Starting the program does not start a centrifuge task.

10. Set **Target speed (rpm)** to `6000`.
11. Set **Target temperature (degC)** to `22`.
12. Set **Task duration (s)** to `6`.
13. Select **Start centrifuge**.

    The API accepts a Command and reserves a DeviceTask. The task parameters remain fixed. The Inspector shows Command, Run, Task and result identities.

14. Wait for **Completed**.

    Preparing brings the speed and temperature within tolerance. The task then counts six seconds. Deceleration follows. The result becomes completed at zero RPM. The device returns to idle. The program remains running.

Target values are task inputs. Observation values are reported measurements. The backend samples at `1 Hz`. Its speed tolerance is `50 rpm`. Its temperature tolerance is `0.5 degC`. Acceleration and deceleration use `3000 rpm/s`. Temperature changes by up to `2 degC/s`. These are demonstration program rules, not physical equipment accuracy guarantees.

The allowed target speed is `500` through `15000 rpm`. Temperature is `-10` through `40 degC`. Duration is `6` through `3600 s`. Run configuration freezes `initial_temperature`; its default is `22 degC`. Later configuration changes do not change that Run or an active task.

## Cancel The Other Task

1. Register `Centrifuge B` with the same definition.
2. Select **Start program**.
3. Set **Task duration (s)** to `60`.
4. Select **Start centrifuge**.
5. Select **Stop centrifuge** while the task is active.

   The task decelerates. Its result becomes cancelled at zero RPM. The program remains running. Centrifuge A keeps its own configuration, task and observations.

**Stop centrifuge** cancels the active DeviceTask. **Stop program** ends the Device Program Run. The API rejects program stop while a task is active. Program stop is available when no task is active.

The built-in representation names `centrifuge-rotor` and rotates around its local Y axis. The browser calculates its rotation from reported `speed` in RPM. Each instance owns its rotor and changing material. Imported GLB appearances have no rotor mapping. They remain static, even when the Entity runs a task.

## Query With An Agent

Prerequisites: an active `lab:full` key from settings and the Lab identity from the Inspector. The key input remains hidden.

1. Set the API address.

   ```bash
   export LAB_API_BASE=http://127.0.0.1:3000
   ```

2. Set the Lab identity.

   ```bash
   export LAB_ID='<lab-uuid>'
   ```

3. Read the key.

   ```bash
   read -rs LAB_API_KEY
   ```

4. Export the key.

   ```bash
   export LAB_API_KEY
   ```

5. Run the example.

   ```bash
   node examples/lab/run-centrifuges.mjs
   ```

   The example completes one task and cancels another. It queries each Command, Run, Task and result. It checks an identical retry and a busy rejection.

Complete requests and checks:

<<< ../../examples/lab/run-centrifuges.mjs

| Query suffix after `/api/v1/lab/labs/{lab_id}/entities/{entity_id}` | Meaning                                           |
| ------------------------------------------------------------------- | ------------------------------------------------- |
| `/commands/{command_id}`                                            | Acceptance and execution of the requested action  |
| `/runs/{run_id}`                                                    | Program configuration and lifecycle               |
| `/tasks/{task_id}`                                                  | Fixed task parameters, counted time and lifecycle |
| `/results/{result_id}`                                              | Independent task outcome and end reason           |

A succeeded Start Command means the program started the task. It does not mean the task completed. A result stays pending during deceleration. A task can end as completed, cancelled, failed, unknown or interrupted. Bad reports produce failed. Uncertain reports produce unknown. Neither outcome can later become completed.

## Close Browsers And Restart The Backend

1. Start a new task with duration `60 s`.
2. Close all browser windows.
3. Wait for the task to finish.
4. Open the same Lab again.

   The result remains queryable. The backend advances tasks without a browser.

5. Start another task with duration `3600 s`.
6. Record its Entity, Command, Run, Task and result identities.
7. Stop the development stack while the task is active.

Press Ctrl+C in the terminal running `pnpm dev`.

8. Start development again.

   ```bash
   pnpm dev
   ```

9. If an existing page shows **Connection interrupted**, select **Reconnect**.
10. Open the same Lab.

The old Run, unfinished task and result show interrupted. Parameters and last observations remain. The backend does not resume the task.

11. Select **Start program**.

    The API creates a new Run. Its first observation shows idle. The old task result remains interrupted. Reports from the old Run cannot overwrite the new Run.

12. Select **Start centrifuge** to request a new task explicitly.
13. Query older records with their recorded identities and the query suffixes above.

    Restart does not change completed or cancelled results. Records remain available within their configured retention period.

## Check A Failure And Recover

1. Send another Start with a new `Idempotency-Key` while a task is active.

   The API returns HTTP `409` with `lab.device_busy`. It keeps the original task and parameters.

2. Select **Stop centrifuge**.
3. Wait for idle.
4. Send a new Start.

   The API accepts a new task with new identities.

For a lost response:

1. Retry the same parameters with the same key.

   The API returns the same Command and Task. Different parameters with that key return `409 idempotency.conflict`. A failed or unknown Command never triggers an automatic retry with a new key.

2. Query the task result before deciding what to do next.

For an interrupted program or a failed task:

1. If the program shows interrupted, select **Start program**.
2. If a task shows fault or uncertain, read its end reason.
3. Wait for idle.
4. Select **Start centrifuge** to request a new task.

## Next Stage

Continue with [run history and retention](run-history.en.md) to query task and temperature records and check cleanup. Expired ended Task, Result and Command identities return 404 after cleanup. Then use [Entity lifecycle](entity-lifecycle.en.md) to archive an Entity or replace its appearance independently.
