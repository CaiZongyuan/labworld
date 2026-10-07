# Read Continuous Temperature And Source Freshness

The current server uses Node 24 and TypeScript. Desktop web is the default scope. Run commands from the repository root on Linux or Windows without Docker. See [Node devices](../guides/server-devices.en.md), [synchronization](../guides/server-sync.en.md), and [operational records](../guides/server-traceability.en.md).

Goal: read two backend temperature sources. Stop one source and observe expiry without losing its last value. Restart it and check the new Run and timestamps.

## Starting Version

Use the common version specified in the [complete journey](complete-foundation.en.md). Complete [reliable synchronization and recovery](reliable-sync.en.md) first. You need the persistent world and SSE subscription.

Run commands from the repository root. These operations write to the development database. Members need an active session. Agents need an active `lab:full` API key.

Source: [backend programs and observation ingress](../../packages/server/src/lab/devices/runtime.ts), [property contract](../../packages/server/src/lab/devices/use-cases.ts), [new migration](../../packages/server/migrations/0000_foundation.sql), and [observation panel](../../packages/views/src/lab/observation-reading.tsx). Node uses the shared retained schema.

## Read Two Sources

1. Install dependencies.

   ```bash
   pnpm install --frozen-lockfile
   ```

2. Start development.

   ```bash
   pnpm dev
   ```

   The API starts built-in device programs. The Worker continues to process existing background tasks.

3. Open <http://127.0.0.1:5173/lab>.

4. Create or open a Lab.

5. Select **Register object**.

6. Select `sensor@1.0`.

7. Enter `Sensor A` in the name field.

8. Select **Register**.

   The new Entity has an independent identity. The Inspector shows **Unknown · No observation**.

9. Select **Start program**.

   The backend samples once per second. The Inspector and 3D reading show temperature, unit and freshness.

10. Repeat steps 5–9 for `Sensor B`.

The objects have different Bindings, Runs and sources. Sampling continues after all browsers close.

11. Select `Sensor A`.

12. Select **Stop program**.

    The last value remains. Five seconds after the last reception, the page shows **Observation expired · Last value retained**.

13. Select **Start program**.

    The new observation uses a new Run. Reception time changes. The source still reports quality. `Sensor B` continues its own Run.

## Check The Same Facts With An Agent

Create a `lab:full` key in settings first. Get `<lab-uuid>` from the Inspector. The terminal does not display the key input.

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
   node examples/lab/observe-temperature.mjs
   ```

   The example creates two independent sensors. It stops the first source and waits for expiry. It checks continued sampling on the second source. It then restarts the first.

Complete requests and result checks:

<<< ../../examples/lab/observe-temperature.mjs

The example sets a simulated baseline through `configuration.baseline_temperature`. The default is `22 degC`. The range is `-50` through `100 degC`. Each Run freezes its configuration. Configuration is not an actual measurement.

## Read The Property Contract

`GET /api/v1/lab/labs/{lab_id}/entities/{entity_id}` and World queries return the same observations. `observation.values.temperature` keeps the last value. `observation.properties.temperature` provides complete property provenance.

| Field                                        | Meaning                                            |
| -------------------------------------------- | -------------------------------------------------- |
| `value`, `unit`                              | Temperature value and `degC` unit                  |
| `binding_id`, `run_id`, `source`, `sequence` | Source Binding, Run, identity and report order     |
| `observed_at`                                | Source observation time; `null` when absent        |
| `received_at`                                | Independent API reception time                     |
| `updated_at`                                 | Time of the last accepted report for this property |
| `expires_at`                                 | Report deadline five seconds after reception       |
| `quality`                                    | Source-reported `good`, `uncertain` or `bad`       |
| `freshness`                                  | `current`, `source_time_unknown` or `stale`        |

The API does not substitute reception time for an absent source time. Freshness applies to each property. The deadline describes recent report reception. Check `observed_at` too when you assess actual measurement age. Hover over the 3D reading to see source, source time, reception time and quality.

A heartbeat only updates Run report order. It does not change measurement reception time or deadline. Duplicate or smaller sequence numbers within a Run do not refresh measurements. Older property source times are rejected. An absent source time preserves the last known time watermark for that property. Partial reports retain omitted properties. Retired Bindings, stopped Runs and older backend generations cannot overwrite a new Run.

The API persists expiry and advances `world.version`. Query time cannot change freshness within the same version. SSE delivers the new version. Layout versions and layout drafts remain independent.

`ObservationSink` is trusted ingress for backend device programs. Members and Agents have no equivalent HTTP write route. The built-in sensor always reports source time. Public ingress and page tests verify unknown source times.

## Check Rejection And Recovery

The example adds `observation` to an Entity PATCH request and expects HTTP 400. The API rejects a direct measurement overwrite. The last value remains. Members have the same restriction. Remove that field, then use program start or stop to continue.

```bash
pnpm test:contract:server
pnpm test:frontend apps/web/src/lab-sensors.test.tsx
node --experimental-strip-types scripts/e2e-server.mjs tests/e2e/lab-node-assets-world.spec.ts
```

These checks cover the real Router, isolated database, controlled clock, page operations and real WebGL. Continue with [centrifuge tasks and restart recovery](centrifuge-tasks.en.md). That chapter provides fixed task parameters, cancellation after deceleration and explicit recovery after restart.
