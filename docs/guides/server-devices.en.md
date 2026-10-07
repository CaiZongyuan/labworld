# Run Device Programs with Node

Goal: run two independent lights, then observe sensors and centrifuge Tasks. Complete [Node World](server-world.en.md) first. Prepare a Member session and an active `lab:full` Agent key. Use the pinned Node 24 and pnpm on Linux or Windows. Run commands from the repository root. These operations write development data.

## Get a Real Device Report

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:5173/lab>. Register two simulated `light · 1.0` Entities with brightness 70 and 20. Start A's program, then turn its power on. Inspector first shows a pending Command. It then shows the actual device report. Changing A does not change B.

Run the same business with an Agent:

```bash
export LAB_API_BASE=http://127.0.0.1:3000
read -rs LAB_API_KEY
export LAB_API_KEY
node examples/lab/control-lights.mjs
node examples/lab/observe-temperature.mjs
node examples/lab/run-centrifuges.mjs
```

<<< ../../examples/lab/control-lights.mjs

The first script checks independent Runs, actual properties, same-key retries and changed-parameter 409. The second checks two independent 1Hz sensors. The third waits for preparation, timed running, deceleration and Task results. Each script creates its own Lab. Set `LAB_ID` to use an existing Lab.

## Read the Result Before Recovery

`POST .../program/start` first returns 201. Repeated startup returns the same Run and 200. `POST .../actions` returns a 202 Command. Keep its ID and query `GET .../commands/{id}`. Acceptance does not create an Observation. The background program reports actual values after execution. `false` and `0` are valid values.

A Run fixes its startup configuration. A centrifuge Task fixes its own parameters. Timing starts within ±50 RPM and ±0.5°C. Stop Task requests deceleration and cancellation while the Run continues. Stop Run returns 409 while a Task is unfinished.

After an uncertain response, retry the original key and parameters. Changed parameters return 409. After the full Command expires, its key returns `410 lab.command_expired` without execution. Read the result before using a new key for new work.

Closing a browser does not stop a program. After server restart, old Runs and unfinished Tasks are interrupted. Uncertain Commands become unknown. Last values and completed results remain. Start a new Run explicitly. A last value cannot establish a trustworthy current value.

[Device use cases](../../packages/server/src/lab/devices/use-cases.ts), [production runtime and trusted ingress](../../packages/server/src/lab/devices/runtime.ts), and [pure rules](../../packages/server/src/lab/devices/domain.ts) own these facts. Trusted ingress has no Member/Agent HTTP injection route.

Continue with [Node World synchronization](server-sync.en.md). See [generated API](site:reference/api.md) for fields and errors.
